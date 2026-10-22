/**
 * Multi-número (anti-ban): cadastro de instâncias WhatsApp + escolha do
 * remetente por RODÍZIO ALEATÓRIO PONDERADO.
 *
 * Regras acordadas com o produto:
 * - no máximo 5 números;
 * - só entram os ATIVOS e com conexão "open" (os fechados são PULADOS);
 * - se nenhum estiver open, ainda sorteia um ativo (o retry do dispatch cobre);
 * - a conta do Mercado Livre NÃO muda: o celular é só o remetente;
 * - peso por número (1..10) para dar mais volume a um número mais "quente".
 *
 * POLÍTICA PRINCIPAL × SECUNDÁRIOS (acordo com o operador):
 * - o **PRINCIPAL** é usado nas operações de SERVIÇO (adicionar contatos ao
 *   grupo, permissões de grupo, permissões de grupo) — o número "de casa";
 * - os **SECUNDÁRIOS** assumem integralmente o **ENVIO DE MENSAGENS** para os
 *   grupos: se o principal cair, o envio continua sem parar;
 * - se TODOS os secundários estiverem fora, o envio volta para o principal
 *   (nada fica sem enviar);
 * - entre os secundários, o envio alterna (rodízio ponderado + anti-repetição).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstanciaWhats {
  instancia: string; // nome da instância na Evolution
  nome: string; // rótulo amigável ("Celular 2")
  ativo: boolean;
  peso: number; // 1..10
  enviadas: number;
  ultimaEm: string | null;
  criadaEm: string;
  /** principal = reservado às operações de serviço (adicionar contatos, permissões) */
  principal?: boolean;
}

interface Store {
  itens: InstanciaWhats[];
}

export const MAX_INSTANCIAS = 5;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// lazy: o diretório é resolvido a cada uso (permite trocar ALCANCE_DATA_DIR
// em tempo de execução — smoke/teste — sem recarregar o módulo).
function dataDir(): string {
  return process.env.ALCANCE_DATA_DIR || join(root, "data");
}
function file(): string {
  return join(dataDir(), "instancias.json");
}

let cache: Store | null = null;
let cacheDir = "";
const estados = new Map<string, { estado: string; em: number }>();
const TTL_ESTADO = 45_000;

function base(): string {
  return (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

function key(): string {
  return process.env.EVO_KEY ?? "";
}

function padrao(): string {
  return process.env.EVO_INSTANCE ?? "radar-piloto";
}

function vazio(): Store {
  return {
    itens: [
      {
        instancia: padrao(),
        nome: "Celular 1",
        ativo: true,
        peso: 1,
        enviadas: 0,
        ultimaEm: null,
        criadaEm: new Date().toISOString(),
      },
    ],
  };
}

function carregar(): Store {
  // o cache é invalidado se o diretório de dados mudar (teste/smoke)
  if (cache && cacheDir === dataDir()) return cache;
  try {
    if (existsSync(file())) {
      const raw: any = JSON.parse(readFileSync(file(), "utf8"));
      if (Array.isArray(raw?.itens)) {
        cache = {
          itens: raw.itens
            .filter((i: any) => i?.instancia)
            .map((i: any) => ({
              instancia: String(i.instancia),
              nome: String(i.nome ?? i.instancia),
              ativo: i.ativo !== false,
              peso: Math.min(10, Math.max(1, Number(i.peso) || 1)),
              enviadas: Number(i.enviadas) || 0,
              ultimaEm: i.ultimaEm ?? null,
              criadaEm: i.criadaEm ?? new Date().toISOString(),
              ...(i.principal ? { principal: true } : {}),
            })),
        };
        if (cache.itens.length > 0) {
          cacheDir = dataDir();
          return cache;
        }
      }
    }
  } catch {
    /* cai no padrão */
  }
  cache = vazio();
  cacheDir = dataDir();
  return cache;
}

function salvar(s: Store): void {
  cache = s;
  try {
    mkdirSync(dataDir(), { recursive: true });
    const destino = file();
    const tmp = `${destino}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, destino);
  } catch {
    /* mantém o cache em memória */
  }
}

async function evo(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: key(), ...(init.headers as any) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Evolution ${res.status} em ${path}: ${txt.slice(0, 200)}`);
  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

export function listarInstancias(): InstanciaWhats[] {
  return [...carregar().itens];
}

/**
 * Instância PRINCIPAL: a marcada com `principal: true`; se não houver marca,
 * a que corresponde ao EVO_INSTANCE (a principal de fábrica); senão a primeira.
 */
export function instanciaPrincipal(): InstanciaWhats | null {
  const itens = carregar().itens;
  if (!itens.length) return null;
  const marcada = itens.find((i) => i.principal);
  if (marcada) return marcada;
  const padrao = itens.find((i) => i.instancia === padraoInstancia());
  return padrao ?? itens[0];
}

function padraoInstancia(): string {
  return process.env.EVO_INSTANCE ?? "radar-piloto";
}

/** Marca/desmarca a instância principal (só uma por vez). */
export function definirPrincipal(instancia: string, principal: boolean): void {
  const s = carregar();
  for (const i of s.itens) {
    if (principal) i.principal = i.instancia === instancia;
    else if (i.instancia === instancia) delete i.principal;
  }
  salvar(s);
}

/** Estado da conexão com cache curto (evita 1 request por envio). */
export async function estadoInstancia(instancia: string, forcar = false): Promise<string> {
  const c = estados.get(instancia);
  if (!forcar && c && Date.now() - c.em < TTL_ESTADO) return c.estado;
  try {
    const j = await evo(`/instance/connectionState/${encodeURIComponent(instancia)}`, {}, 15_000);
    const e = String(j?.instance?.state ?? "?");
    estados.set(instancia, { estado: e, em: Date.now() });
    return e;
  } catch {
    estados.set(instancia, { estado: "erro", em: Date.now() });
    return "erro";
  }
}

/**
 * VARIAÇÃO: evita repetir o mesmo número do envio anterior (quando há
 * alternativa). Sorteio puro pode dar 2 envios seguidos do mesmo celular —
 * concentration de volume num aparelho só é o que mais derruba número.
 *
 * A anti-repetição é PROBABILÍSTICA (padrão 70%) para não anular o peso por
 * número: com pesos iguais a variação fica ~85%; com peso muito diferente
 * (ex.: 10 x 1), o número "quente" continua levando mais volume.
 */
let ultimaUsada: string | null = null;

/** Chance de não repetir o número do envio anterior (0 = nunca, 1 = sempre). */
function evitaRepeticao(): number {
  const v = Number(process.env.RODIZIO_EVITA_REPETICAO ?? 0.7);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
}

export function ultimaInstanciaUsada(): string | null {
  return ultimaUsada;
}

export async function proximaInstancia(): Promise<string> {
  const s = carregar();
  const ativos = s.itens.filter((i) => i.ativo);
  if (ativos.length === 0) return padrao();
  const comEstado = await Promise.all(
    ativos.map(async (i) => ({ i, e: await estadoInstancia(i.instancia) }))
  );
  const abertos = comEstado.filter((x) => x.e === "open").map((x) => x.i);
  let candidatos = abertos.length > 0 ? abertos : ativos;

  // ENVIO DE MENSAGENS: os SECUNDÁRIOS assumem integralmente. O principal só
  // volta se nenhum secundário estiver disponível (para nada parar).
  const principal = instanciaPrincipal();
  if (principal) {
    const secundarios = candidatos.filter((i) => i.instancia !== principal.instancia);
    if (secundarios.length > 0) candidatos = secundarios;
  }

  // anti-repetição: tira a última usada (com probabilidade) se houver outra
  if (candidatos.length > 1 && ultimaUsada && Math.random() < evitaRepeticao()) {
    const outras = candidatos.filter((i) => i.instancia !== ultimaUsada);
    if (outras.length > 0) candidatos = outras;
  }

  const total = candidatos.reduce((n, i) => n + i.peso, 0);
  let r = Math.random() * total;
  for (const i of candidatos) {
    r -= i.peso;
    if (r <= 0) {
      ultimaUsada = i.instancia;
      return i.instancia;
    }
  }
  const ultima = candidatos[candidatos.length - 1].instancia;
  ultimaUsada = ultima;
  return ultima;
}

/**
 * Instância para OPERAÇÕES DE SERVIÇO (adicionar contatos ao grupo, permissões
 * de grupo): sempre o principal, para não dispersar essas ações e para que os
 * secundários fiquem exclusivos com o envio de mensagens.
 */
export async function instanciaParaServico(): Promise<string> {
  const p = instanciaPrincipal();
  if (p) {
    const estado = await estadoInstancia(p.instancia);
    // Se o principal estiver fechado, ainda assim usamos ele (a operação de
    // serviço depende dele) — mas avisamos no log.
    if (estado !== "open") {
      console.log(
        `[rotacao] principal "${p.nome}" está ${estado} — operação de serviço pode falhar`,
      );
    }
    return p.instancia;
  }
  return padrao();
}

export function registrarEnvio(instancia: string): void {
  const s = carregar();
  const i = s.itens.find((x) => x.instancia === instancia);
  if (!i) return;
  i.enviadas += 1;
  i.ultimaEm = new Date().toISOString();
  salvar(s);
}

function nomeInstancia(nome: string): string {
  const slug = (nome ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return `radar-${slug || "celular"}-${Math.random().toString(36).slice(2, 5)}`;
}

async function configurarWebhook(instancia: string): Promise<void> {
  const url = process.env.WEBHOOK_URL?.trim() || "http://promo_radar_manager:8091/api/webhook/evolution";
  const whKey = process.env.WEBHOOK_KEY?.trim() || "";
  await evo(`/webhook/set/${encodeURIComponent(instancia)}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        webhookByEvents: false,
        webhookBase64: true,
        events: ["MESSAGES_UPSERT"],
        headers: whKey ? { "X-Webhook-Key": whKey } : {},
      },
    }),
  });
}

/** QR de pareamento (data URI) — null se a Evolution ainda não gerou. */
export async function qrInstancia(instancia: string): Promise<string | null> {
  const j = await evo(`/instance/connect/${encodeURIComponent(instancia)}`, {}, 60_000);
  const b64 = j?.base64 ?? j?.qrcode?.base64 ?? null;
  if (typeof b64 === "string" && b64) return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  return null;
}

/** Cria a instância na Evolution, configura o webhook e devolve o QR. */
export async function adicionarInstancia(nome: string): Promise<{ instancia: string; nome: string; qr: string | null }> {
  const s = carregar();
  if (s.itens.length >= MAX_INSTANCIAS) {
    throw new Error(`Limite de ${MAX_INSTANCIAS} números cadastrados — remova um antes.`);
  }
  const instancia = nomeInstancia(nome);
  await evo(`/instance/create`, {
    method: "POST",
    body: JSON.stringify({ instanceName: instancia, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
  });
  try {
    await configurarWebhook(instancia);
  } catch {
    /* não impede o pareamento */
  }
  let qr: string | null = null;
  try {
    qr = await qrInstancia(instancia);
  } catch {
    /* o QR pode levar alguns segundos */
  }
  const rotulo = (nome ?? "").trim() || `Celular ${s.itens.length + 1}`;
  s.itens.push({
    instancia,
    nome: rotulo,
    ativo: true,
    peso: 1,
    enviadas: 0,
    ultimaEm: null,
    criadaEm: new Date().toISOString(),
  });
  salvar(s);
  return { instancia, nome: rotulo, qr };
}

export function definirAtivo(instancia: string, ativo: boolean): void {
  const s = carregar();
  const i = s.itens.find((x) => x.instancia === instancia);
  if (!i) return;
  i.ativo = !!ativo;
  salvar(s);
}

export function definirPeso(instancia: string, peso: number): void {
  const s = carregar();
  const i = s.itens.find((x) => x.instancia === instancia);
  if (!i) return;
  i.peso = Math.min(10, Math.max(1, Number(peso) || 1));
  salvar(s);
}

export async function removerInstancia(instancia: string): Promise<void> {
  const s = carregar();
  if (s.itens.length <= 1) throw new Error("Não dá para remover o último número.");
  try {
    await evo(`/instance/delete/${encodeURIComponent(instancia)}`, { method: "DELETE" });
  } catch {
    /* remove do cadastro mesmo assim */
  }
  estados.delete(instancia);
  s.itens = s.itens.filter((x) => x.instancia !== instancia);
  salvar(s);
}
