import {
  createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual,
} from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* ============================================================================
 * Autenticação do painel Alcance — single process, arquivo local.
 * - Senha: scrypt (N=2^15, r=8, p=1) com formato versionado.
 * - Sessão: sid aleatório + HMAC; store em memória com TTL absoluto e idle.
 * - Cookie: HttpOnly; SameSite=Strict; Path=/ (Secure opcional via env).
 * - Rate-limit: 5 tentativas/min por IP, bloqueio de 60s.
 * - Auditoria: JSONL em data/auth-audit.log, sem senha/hash/cookie.
 * ========================================================================== */

export type Papel = "admin" | "operador";

/** Verificação do celular por WhatsApp (código de 10 posições). */
export type Verificacao = {
  /** SHA-256 do código + sal do usuário — o código NUNCA é gravado. */
  hash: string;
  /** ISO — o código expira (10 min por padrão). */
  expiraEm: string;
  /** tentativas erradas (trava após 5). */
  tentativas: number;
  /** ISO — quando o celular foi confirmado. */
  verificadoEm?: string;
};

export type Usuario = {
  id: string;
  usuario: string;
  hash: string;
  papel: Papel;
  desativado?: boolean;
  criadoEm: string;
  /** WhatsApp do usuário (só dígitos, com DDI). */
  telefone?: string;
  /** Estado da verificação do celular. */
  verificacao?: Verificacao;
};

type Sessao = {
  usuarioId: string;
  criadoEm: number;
  vistoEm: number;
  ipHash: string;
  ua: string;
};

type Limite = { n: number; inicio: number; bloqueadoAte: number };

const COOKIE = "alcance_sid";
const MAX_TENTATIVAS = 5;
const MAX_GLOBAL = 30;
const GLOBAL = "__global__";
const JANELA_MS = 60_000;
const BLOQUEIO_MS = 60_000;
const MAX_SESSOES_POR_USUARIO = 5;
const MAX_HASHES = 4;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_KEYLEN = 64;

let dataDir = "";
let cacheUsuarios: { mtimeMs: number; lista: Usuario[] } | null = null;
let dummyHash: Promise<string> | null = null;
const sessoes = new Map<string, Sessao>();
const limites = new Map<string, Limite>();

export function configurarAuth(dir: string): void {
  dataDir = dir;
  cacheUsuarios = null;
}

function arquivoUsuarios(): string {
  return join(dataDir, "auth-users.json");
}

function arquivoAuditoria(): string {
  return join(dataDir, "auth-audit.log");
}

function segredo(): string {
  const s = process.env.SESSION_SECRET?.trim() ?? "";
  if (s.length < 32) {
    throw new Error(
      "SESSION_SECRET ausente ou curto (<32 caracteres). Gere com: openssl rand -hex 32",
    );
  }
  return s;
}

export function validarConfigAuth(): void {
  segredo();
  const ativos = carregarUsuarios().filter((u) => !u.desativado);
  if (ativos.length === 0) {
    throw new Error(
      "Nenhum usuário ativo em data/auth-users.json. Rode: npm run auth:user -- admin",
    );
  }
}

export function carregarUsuarios(): Usuario[] {
  if (!dataDir) return [];
  try {
    const p = arquivoUsuarios();
    const mtimeMs = statSync(p).mtimeMs;
    if (cacheUsuarios && cacheUsuarios.mtimeMs === mtimeMs) return cacheUsuarios.lista;
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { usuarios?: unknown })?.usuarios)
        ? (raw as { usuarios: unknown[] }).usuarios
        : [];
    const lista = arr.filter((u): u is Usuario => {
      const x = u as Usuario;
      return !!x && typeof x.usuario === "string" && typeof x.hash === "string";
    });
    cacheUsuarios = { mtimeMs, lista };
    return lista;
  } catch {
    return [];
  }
}

/* ------------------------------ senha ----------------------------------- */

function scryptAsync(senha: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      senha,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export class HashOcupadoError extends Error {}

let hashesAtivos = 0;

async function comLimiteHash<T>(fn: () => Promise<T>): Promise<T> {
  if (hashesAtivos >= MAX_HASHES) throw new HashOcupadoError("hash ocupado");
  hashesAtivos += 1;
  try {
    return await fn();
  } finally {
    hashesAtivos -= 1;
  }
}

export async function hashSenha(senha: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(senha, salt);
  return [
    "scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString("base64"), key.toString("base64"),
  ].join("$");
}

export async function verificarSenha(senha: string, hash: string): Promise<boolean> {
  const partes = String(hash ?? "").split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const n = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const salt = Buffer.from(partes[4], "base64");
    const esperado = Buffer.from(partes[5], "base64");
    if (salt.length < 8 || esperado.length !== SCRYPT_KEYLEN) return false;
    const obtido = await scryptAsync(senha, salt);
    return timingSafeEqual(obtido, esperado);
  } catch {
    return false;
  }
}

/** Compara strings em tempo constante (hash SHA-256 fixa o tamanho). */
export function iguais(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function hashDummy(): Promise<string> {
  if (!dummyHash) dummyHash = hashSenha(randomBytes(18).toString("hex"));
  return dummyHash;
}

export async function autenticar(usuario: string, senha: string): Promise<Usuario | null> {
  const nome = usuario.trim().toLowerCase();
  const u = carregarUsuarios().find(
    (x) => x.usuario.toLowerCase() === nome && !x.desativado,
  );
  if (!u) {
    // Iguala o custo de CPU para não vazar existência de usuário.
    await comLimiteHash(async () => {
      const h = await hashDummy();
      return verificarSenha(senha, h);
    });
    return null;
  }
  const ok = await comLimiteHash(() => verificarSenha(senha, u.hash));
  return ok ? u : null;
}

/* ---------------------------- rate-limit -------------------------------- */

function checarChave(chave: string, max: number): { ok: boolean; retryAfter: number } {
  const agora = Date.now();
  const l = limites.get(chave);
  if (!l) return { ok: true, retryAfter: 0 };
  if (l.bloqueadoAte > agora) {
    return { ok: false, retryAfter: Math.ceil((l.bloqueadoAte - agora) / 1000) };
  }
  if (agora - l.inicio > JANELA_MS) {
    limites.delete(chave);
    return { ok: true, retryAfter: 0 };
  }
  if (l.n >= max) {
    l.bloqueadoAte = agora + BLOQUEIO_MS;
    return { ok: false, retryAfter: Math.ceil(BLOQUEIO_MS / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

export function checarLimite(ip: string): { ok: boolean; retryAfter: number } {
  const global = checarChave(GLOBAL, MAX_GLOBAL);
  if (!global.ok) return global;
  return checarChave(ip, MAX_TENTATIVAS);
}

function registrarChave(chave: string): void {
  const agora = Date.now();
  const l = limites.get(chave);
  if (!l || agora - l.inicio > JANELA_MS) {
    limites.set(chave, { n: 1, inicio: agora, bloqueadoAte: 0 });
    return;
  }
  l.n += 1;
}

export function registrarTentativa(ip: string): void {
  registrarChave(ip);
  registrarChave(GLOBAL);
}

const reenvios = new Map<string, number[]>();
const REENVIO_MAX = 3;
const REENVIO_JANELA_MS = 60 * 60_000;

/**
 * Rate-limit dedicado do reenvio de código: 3 por hora por IP.
 * Separado do login para um abuso de reenvio não bloquear o acesso normal.
 */
export function checarLimiteReenvio(ip: string): { ok: boolean; retryAfter: number } {
  const agora = Date.now();
  const arr = (reenvios.get(ip) ?? []).filter((t) => agora - t < REENVIO_JANELA_MS);
  if (arr.length >= REENVIO_MAX) {
    return { ok: false, retryAfter: Math.ceil((arr[0] + REENVIO_JANELA_MS - agora) / 1000) };
  }
  arr.push(agora);
  reenvios.set(ip, arr);
  return { ok: true, retryAfter: 0 };
}

export function limparLimite(ip: string): void {
  limites.delete(ip);
  // O bucket global também precisa ser liberado no sucesso; senão 30 falhas
  // (de qualquer origem) bloqueiam o login de todo mundo até a janela expirar.
  limites.delete(GLOBAL);
}

/* ------------------------------ sessão ---------------------------------- */

function chaveSid(sid: string): string {
  return createHash("sha256").update(sid, "utf8").digest("hex");
}

function assinar(sid: string): string {
  return createHmac("sha256", segredo()).update("sid:" + sid).digest("base64url");
}

function ttlAbsolutoMs(): number {
  const h = Number(process.env.AUTH_TTL_HORAS ?? 8);
  return (Number.isFinite(h) && h > 0 ? h : 8) * 3_600_000;
}

function ttlIdleMs(): number {
  const m = Number(process.env.AUTH_IDLE_MIN ?? 30);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60_000;
}

export function criarSessao(
  u: Usuario,
  ip: string,
  ua: string,
): { valor: string; maxAge: number } {
  const sid = randomBytes(32).toString("base64url");
  const agora = Date.now();
  const chave = chaveSid(sid);
  sessoes.set(chave, {
    usuarioId: u.id,
    criadoEm: agora,
    vistoEm: agora,
    // /24 (IPv4) e /48 (IPv6): tolera troca de IP na mesma rede móvel.
    ipHash: createHash("sha256").update(mascararIp(ip), "utf8").digest("hex").slice(0, 16),
    ua: String(ua ?? "").slice(0, 160),
  });
  limitarSessoes(u.id, chave);
  const maxAge = Math.floor(ttlAbsolutoMs() / 1000);
  return { valor: sid + "." + assinar(sid), maxAge };
}

function limitarSessoes(usuarioId: string, chaveNova: string): void {
  const doUsuario = [...sessoes.entries()]
    .filter(([, s]) => s.usuarioId === usuarioId && s !== sessoes.get(chaveNova))
    .sort((a, b) => a[1].vistoEm - b[1].vistoEm);
  const excedente = doUsuario.length - (MAX_SESSOES_POR_USUARIO - 1);
  for (let i = 0; i < excedente; i += 1) sessoes.delete(doUsuario[i][0]);
}

export type SessaoValida = { sid: string; usuario: Usuario };

export function validarSessao(valor: string | undefined, ip?: string, ua?: string): SessaoValida | null {
  if (!valor) return null;
  const ponto = valor.lastIndexOf(".");
  if (ponto <= 0) return null;
  const sid = valor.slice(0, ponto);
  const assinatura = valor.slice(ponto + 1);
  if (!sid || !assinatura) return null;
  if (!iguais(assinatura, assinar(sid))) return null;

  const chave = chaveSid(sid);
  const s = sessoes.get(chave);
  if (!s) return null;
  const agora = Date.now();
  if (agora - s.criadoEm > ttlAbsolutoMs() || agora - s.vistoEm > ttlIdleMs()) {
    sessoes.delete(chave);
    return null;
  }
  // Sessão amarrada à rede (/24) e ao user-agent: cookie roubado não é
  // reutilizável de outra máquina/navegador.
  if (typeof ip === "string" && ip) {
    const ipHash = createHash("sha256").update(mascararIp(ip), "utf8").digest("hex").slice(0, 16);
    if (ipHash !== s.ipHash) {
      sessoes.delete(chave);
      return null;
    }
  }
  if (typeof ua === "string" && ua && s.ua !== ua.slice(0, 160)) {
    sessoes.delete(chave);
    return null;
  }
  const u = carregarUsuarios().find((x) => x.id === s.usuarioId && !x.desativado);
  if (!u) {
    sessoes.delete(chave);
    return null;
  }
  s.vistoEm = agora;
  return { sid, usuario: u };
}

export function encerrarSessao(sid: string): void {
  sessoes.delete(chaveSid(sid));
}

export function encerrarSessoesDoUsuario(usuarioId: string): void {
  for (const [chave, s] of sessoes) {
    if (s.usuarioId === usuarioId) sessoes.delete(chave);
  }
}

/* ------------------------------ cookie ---------------------------------- */

export function lerCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const parte of header.split(";")) {
    const i = parte.indexOf("=");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (nome) out[nome] = valor;
  }
  return out;
}

function cookieSecure(): string {
  // Default seguro em produção; em dev/teste só com opt-in.
  const prod = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
  const ligado = process.env.AUTH_COOKIE_SECURE === "1" || (prod && process.env.AUTH_COOKIE_SECURE !== "0");
  return ligado ? "; Secure" : "";
}

export function cookieSessao(valor: string, maxAge: number): string {
  return `${COOKIE}=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cookieSecure()}`;
}

export function cookieExpirado(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure()}`;
}

export function sessaoDoRequest(req: any): SessaoValida | null {
  const cookies = lerCookies(req.headers?.cookie);
  return validarSessao(
    cookies[COOKIE],
    ipDoRequest(req),
    String(req.headers?.["user-agent"] ?? ""),
  );
}

/* ----------------------------- auditoria -------------------------------- */

export function mascararIp(ip: string): string {
  const s = String(ip ?? "");
  if (s.includes(".")) {
    const p = s.split(".");
    return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : s;
  }
  if (s.includes(":")) {
    return s.split(":").slice(0, 3).join(":") + "::/48";
  }
  return s || "-";
}

export function ipDoRequest(req: any): string {
  // Só confie em X-Forwarded-For quando houver um reverse proxy seu na frente.
  if (process.env.TRUST_PROXY === "1") {
    const xff = req?.headers?.["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      const primeiro = xff.split(",")[0].trim();
      if (primeiro) return primeiro.replace(/^::ffff:/, "");
    }
  }
  const bruto = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? "";
  return String(bruto).replace(/^::ffff:/, "");
}

export function auditar(
  evento: string,
  dados: { usuario?: string; ip?: string; ua?: string; detalhe?: string } = {},
): void {
  if (!dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const linha = JSON.stringify({
      em: new Date().toISOString(),
      evento,
      usuario: dados.usuario ?? null,
      ip: mascararIp(dados.ip ?? ""),
      ua: String(dados.ua ?? "").slice(0, 160) || null,
      detalhe: dados.detalhe ?? null,
    });
    appendFileSync(arquivoAuditoria(), linha + "\n", { mode: 0o600 });
  } catch {
    /* auditoria nunca derruba a request */
  }
}

/* ------------------------------ limpeza --------------------------------- */

let sweeper: NodeJS.Timeout | null = null;

export function iniciarLimpezaAuth(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const agora = Date.now();
    for (const [chave, s] of sessoes) {
      if (
        agora - s.criadoEm > ttlAbsolutoMs() ||
        agora - s.vistoEm > ttlIdleMs()
      ) {
        sessoes.delete(chave);
      }
    }
    for (const [ip, l] of limites) {
      if (agora - l.inicio > 10 * JANELA_MS && l.bloqueadoAte < agora) {
        limites.delete(ip);
      }
    }
  }, 5 * 60_000);
  sweeper.unref();
}

export const authInterno = { COOKIE, MAX_TENTATIVAS };
