/**
 * Multi-conta de afiliado (etiquetas): uma conta padrão + N contas,
 * com mapa categoria → conta. Segredos em data/contas.json (git-ignored,
 * nunca exposto pela API — só nome + tag mascarada).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Conta {
  nome: string;
  tag: string;
  cookie: string;
  criadaEm: string;
}

export interface Destino {
  conta: string; // nome da conta, ou "-" = padrão
  grupo: string; // JID do grupo, ou "" = GRUPO_TESTE do .env
  sub?: string; // subcategoria (folha ML), ou "" = categoria inteira
}

interface Store {
  padrao: string | null;
  contas: Conta[];
  mapa: Record<string, Destino | string>; // categoryId -> destino (string = formato antigo: só conta)
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "contas.json");

function envCreds(): { tag: string | null; cookie: string | null } {
  const tag = process.env.TAG_ML?.trim() || null;
  const cookie = process.env.COOKIE_ML?.trim() || null;
  return {
    tag: tag && tag !== "minhaetiqueta" ? tag : null,
    cookie: cookie && !cookie.startsWith("cole_o_cookie") ? cookie : null,
  };
}

function blank(): Store {
  return { padrao: null, contas: [], mapa: {} };
}

export function carregar(): Store {
  try {
    if (!existsSync(file)) return blank();
    const s = JSON.parse(readFileSync(file, "utf8")) as Store;
    if (!Array.isArray(s.contas)) return blank();
    return { padrao: s.padrao ?? null, contas: s.contas, mapa: s.mapa ?? {} };
  } catch {
    return blank();
  }
}

function salvar(s: Store): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

/** Migra TAG/COOKIE do .env como conta "principal" (1ª vez). */
function comMigracao(): Store {
  const s = carregar();
  if (s.contas.length === 0) {
    const { tag, cookie } = envCreds();
    if (tag && cookie) {
      s.contas.push({ nome: "principal", tag, cookie, criadaEm: new Date().toISOString() });
      s.padrao = "principal";
      salvar(s);
    }
  }
  return s;
}

export function listarContas(): { nome: string; tagMask: string; padrao: boolean }[] {
  const s = comMigracao();
  return s.contas.map((c) => ({
    nome: c.nome,
    tagMask: c.tag.length > 6 ? `${c.tag.slice(0, 4)}…${c.tag.slice(-4)}` : "…",
    padrao: c.nome === s.padrao,
  }));
}

export function salvarConta(nome: string, tag: string, cookie: string): void {
  nome = nome.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "") || "conta";
  if (!tag.trim() || cookie.trim().length < 100) throw new Error("TAG ou COOKIE inválidos.");
  const s = comMigracao();
  const i = s.contas.findIndex((c) => c.nome === nome);
  const conta: Conta = { nome, tag: tag.trim(), cookie: cookie.trim(), criadaEm: new Date().toISOString() };
  if (i >= 0) s.contas[i] = conta;
  else s.contas.push(conta);
  if (!s.padrao) s.padrao = nome;
  salvar(s);
}

export function definirPadrao(nome: string): void {
  const s = comMigracao();
  if (!s.contas.some((c) => c.nome === nome)) throw new Error(`Conta "${nome}" não existe.`);
  s.padrao = nome;
  salvar(s);
}

export function definirMapa(categoryId: string, nome: string, grupo = "", sub = ""): void {
  const s = comMigracao();
  if (nome === "-" && !grupo && !sub) {
    delete s.mapa[categoryId];
  } else {
    if (nome !== "-" && !s.contas.some((c) => c.nome === nome)) throw new Error(`Conta "${nome}" não existe.`);
    s.mapa[categoryId] = { conta: nome, grupo: grupo.trim(), sub: sub.trim() };
  }
  salvar(s);
}

function destinoDe(categoryId?: string): Destino | null {
  if (!categoryId) return null;
  const raw = comMigracao().mapa[categoryId];
  if (!raw) return null;
  if (typeof raw === "string") return { conta: raw, grupo: "" }; // formato antigo
  return raw;
}

export function lerMapa(): Record<string, Destino> {
  const s = comMigracao();
  const out: Record<string, Destino> = {};
  for (const [k, v] of Object.entries(s.mapa)) {
    out[k] = typeof v === "string" ? { conta: v, grupo: "" } : v;
  }
  return out;
}

/** Resolve o grupo de destino: override > mapa da categoria > GRUPO_TESTE do .env. */
export function grupoPara(categoryId?: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const dest = destinoDe(categoryId);
  if (dest?.grupo) return dest.grupo;
  return process.env.GRUPO_TESTE ?? "grupo-teste";
}
export function resolver(categoryId?: string, override?: string): { nome: string; tag: string; cookie: string } {
  const s = comMigracao();
  const dest = destinoDe(categoryId);
  let nome = override?.trim() || "";
  if (!nome && dest && dest.conta !== "-") nome = dest.conta;
  if (!nome) nome = s.padrao || "";
  const conta = s.contas.find((c) => c.nome === nome);
  if (conta) return { nome: conta.nome, tag: conta.tag, cookie: conta.cookie };
  const { tag, cookie } = envCreds();
  if (tag && cookie) return { nome: "env", tag, cookie };
  throw new Error("SEM_CONTA: cadastre uma conta (tela Contas) ou preencha TAG/COOKIE no .env.");
}
