/**
 * VERIFICAÇÃO DE CELULAR POR WHATSAPP (2FA de primeiro uso).
 *
 * Fluxo:
 *  1) no cadastro, o usuário informa o WhatsApp (DDD+número, com DDI);
 *  2) o sistema gera um código ALFANUMÉRICO de 10 posições e o envia por
 *     WhatsApp para o celular cadastrado;
 *  3) o código entra no primeiro login — só então a conta é ativada.
 *
 * Segurança:
 *  - o código NUNCA é gravado: só o SHA-256 (com sal do usuário) fica no disco;
 *  - expira em 10 minutos e trava após 5 tentativas erradas;
 *  - o celular é mascarado nas respostas e na auditoria.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanciaParaServico } from "../wa/rotacao.js";

const CODIGO_MIN = 10;
const CODIGO_MAX = 10;
/** Alfabeto sem 0/O e 1/I/I — evita erro de digitação no celular. */
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EXPIRA_MS = 10 * 60 * 1000;
const MAX_TENTATIVAS = 5;

/** Telefone válido: só dígitos, 10-15, com DDI (BR = 55). */
export function telefoneValido(tel: string): boolean {
  const d = String(tel ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15;
}

/** Normaliza para dígitos com DDI: 11 dígitos BR ganham "55". */
export function normalizarTelefone(tel: string): string {
  let d = String(tel ?? "").replace(/\D/g, "");
  if (d.length === 11) d = `55${d}`; // (11) 9xxxx-xxxx → 55 + DDD + número
  return d;
}

/** Máscara para exibição: 55•••1234 (nunca o número inteiro). */
export function mascarTelefone(tel: string): string {
  const d = normalizarTelefone(tel);
  if (d.length < 4) return "••••";
  return `${d.slice(0, 2)}•••${d.slice(-4)}`;
}

/** Código alfanumérico de 10 posições (criptográfico). */
export function gerarCodigo(): string {
  let s = "";
  for (let i = 0; i < CODIGO_MAX; i++) {
    s += ALFABETO[randomInt(0, ALFABETO.length)];
  }
  return s;
}

/** Hash do código: SHA-256(sal do usuário + código). */
export function hashCodigo(usuarioId: string, codigo: string): string {
  return createHash("sha256")
    .update(`${usuarioId}:${codigo.trim().toUpperCase()}`)
    .digest("hex");
}

/* ------------------------- persistência (auth-users.json) ------------------ */

function arquivoUsuarios(dataDir: string): string {
  return join(dataDir, "auth-users.json");
}

interface UsuRaw {
  usuarios?: unknown[];
}

function lerUsuarios(dataDir: string): Record<string, any>[] {
  try {
    const raw = JSON.parse(readFileSync(arquivoUsuarios(dataDir), "utf8")) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as UsuRaw)?.usuarios)
        ? (raw as UsuRaw).usuarios!
        : [];
    return arr.filter((u): u is Record<string, any> => !!u && typeof u === "object");
  } catch {
    return [];
  }
}

function salvarUsuarios(dataDir: string, usuarios: Record<string, any>[]): void {
  const tmp = `${arquivoUsuarios(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ usuarios }, null, 2), { mode: 0o600 });
  renameSync(tmp, arquivoUsuarios(dataDir));
}

/** Salva (ou troca) o telefone/verificação de um usuário. */
export function salvarVerificacao(
  dataDir: string,
  usuarioId: string,
  telefone: string,
  verificacao: Record<string, any> | null,
): void {
  const usuarios = lerUsuarios(dataDir);
  for (const u of usuarios) {
    if (u.id === usuarioId) {
      u.telefone = telefone;
      if (verificacao) u.verificacao = verificacao;
      else delete u.verificacao;
    }
  }
  salvarUsuarios(dataDir, usuarios);
}

/* ------------------------------- envio ------------------------------------ */

/**
 * Envia o código por WhatsApp (Evolution). Devolve {ok, erro}.
 * Nunca lança: quem chama decide o que fazer.
 */
export async function enviarCodigoWhatsApp(
  telefone: string,
  codigo: string,
  nomeUsuario: string,
): Promise<{ ok: boolean; erro?: string }> {
  const d = normalizarTelefone(telefone);
  if (!telefoneValido(d)) return { ok: false, erro: "telefone inválido" };
  const base = (process.env.EVO_URL ?? "").replace(/\/$/, "");
  const key = process.env.EVO_KEY ?? "";
  if (!base || !key) return { ok: false, erro: "Evolution não configurada (EVO_URL/EVO_KEY)" };
  // O principal pode ter sido renomeado no painel; EVO_INSTANCE é só o default de fábrica.
  const inst = await instanciaParaServico();

  const texto = [
    `🔐 *Alcance — verificação de celular*`,
    ``,
    `Olá${nomeUsuario ? `, ${nomeUsuario}` : ""}!`,
    `Seu código de acesso é:`,
    ``,
    `\`${codigo}\``,
    ``,
    `Ele vale por 10 minutos. Se não foi você, ignore esta mensagem.`,
  ].join("\n");

  try {
    const r = await fetch(`${base}/message/sendText/${inst}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ number: `${d}@s.whatsapp.net`, text: texto }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, erro: `Evolution ${r.status}${t ? `: ${t.slice(0, 120)}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String((e as Error)?.message ?? e) };
  }
}

/* ---------------------------- verificação --------------------------------- */

export type ResultadoCodigo =
  | { ok: true }
  | { ok: false; motivo: "invalido" | "expirado" | "tentativas" | "sem_codigo" };

/**
 * Valida o código informado. Compara em tempo constante.
 * Conta tentativa errada e trava depois de MAX_TENTATIVAS.
 */
export function validarCodigo(
  usuario: {
    id: string;
    telefone?: string;
    verificacao?: { hash: string; expiraEm: string; tentativas: number; verificadoEm?: string };
  },
  codigo: string,
  dataDir: string,
): ResultadoCodigo {
  const v = usuario.verificacao;
  if (!v) return { ok: false, motivo: "sem_codigo" };
  if (v.tentativas >= MAX_TENTATIVAS) return { ok: false, motivo: "tentativas" };
  if (new Date(v.expiraEm).getTime() < Date.now()) return { ok: false, motivo: "expirado" };

  const informado = hashCodigo(usuario.id, codigo ?? "");
  const a = Buffer.from(informado, "hex");
  const b = Buffer.from(v.hash, "hex");
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    v.tentativas += 1;
    salvarVerificacao(dataDir, usuario.id, usuario.telefone ?? "", v);
    return { ok: false, motivo: v.tentativas >= MAX_TENTATIVAS ? "tentativas" : "invalido" };
  }
  v.tentativas = 0;
  v.verificadoEm = new Date().toISOString();
  salvarVerificacao(dataDir, usuario.id, usuario.telefone ?? "", v);
  return { ok: true };
}

/** O usuário ainda precisa confirmar o celular? */
export function precisaCodigo(usuario: { telefone?: string; verificacao?: { verificadoEm?: string } }): boolean {
  if (!usuario.telefone) return false;
  if (!usuario.verificacao) return true;
  return !usuario.verificacao.verificadoEm;
}

/**
 * Códigos em memória (nunca em disco): permitem REENVIAR o mesmo código sem
 * invalidar o que o usuário já recebeu.
 */
const codigosEmMemoria = new Map<string, { codigo: string; expiraEm: number }>();

/**
 * Gera um código novo, grava o HASH e envia por WhatsApp.
 *
 * Sempre gera um código novo (o anterior é invalidado): o texto puro não é
 * gravado em lugar nenhum, então reenviar exige gerar outro — o que também
 * evita que um código interceptedado continue valendo.
 */
/**
 * O código já enviado (cadastro) ainda vale? Se sim, o login NÃO gera outro
 * — o usuário digita o que recebeu. Só quando está expirado/errado/travado é
 * que um novo é gerado e enviado.
 */
export function codigoAindaVale(usuario: { verificacao?: { hash: string; expiraEm: string; tentativas: number } }): boolean {
  const v = usuario.verificacao;
  if (!v) return false;
  if (v.tentativas >= MAX_TENTATIVAS) return false;
  return new Date(v.expiraEm).getTime() > Date.now();
}

export async function ensureCodigoVerificacao(
  usuario: {
    id: string;
    usuario: string;
    telefone?: string;
    verificacao?: { hash: string; expiraEm: string; tentativas: number; verificadoEm?: string };
  },
  dataDir: string,
  forcar = false,
): Promise<{ enviado: boolean; erro?: string; reenviado: boolean }> {
  const telefone = normalizarTelefone(usuario.telefone ?? "");
  if (!telefoneValido(telefone)) {
    return { enviado: false, erro: "telefone cadastrado é inválido", reenviado: false };
  }

  const emMemoria = codigosEmMemoria.get(usuario.id);
  const temTexto = !!emMemoria && emMemoria!.expiraEm > Date.now();

  // O código do cadastro continua válido e NÃO foi gerado por este processo:
  // não temos o texto puro para reenviar — e não precisamos: o usuário já
  // recebeu. Só o "reenviar" explícito gera um novo.
  if (!forcar && !temTexto && codigoAindaVale(usuario)) {
    return { enviado: false, reenviado: false };
  }

  const codigo = temTexto ? emMemoria!.codigo : gerarCodigo();
  const expiraEm = temTexto ? emMemoria!.expiraEm : Date.now() + EXPIRA_MS;

  // Reenviar NÃO zera o lockout: senão um atacante anularia as 5 tentativas
  // pedindo um código novo a cada rodada.
  salvarVerificacao(dataDir, usuario.id, telefone, {
    hash: hashCodigo(usuario.id, codigo),
    expiraEm: new Date(expiraEm).toISOString(),
    tentativas: usuario.verificacao?.tentativas ?? 0,
  });
  codigosEmMemoria.set(usuario.id, { codigo, expiraEm });

  const r = await enviarCodigoWhatsApp(telefone, codigo, usuario.usuario);
  return { enviado: r.ok, erro: r.erro, reenviado: temTexto };
}
