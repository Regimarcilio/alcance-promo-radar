/**
 * Memória de grupos NÃO monitorados que publicaram ofertas.
 *
 * O webhook recebe mensagens de todos os grupos da conta, mas o monitor só
 * processa origens configuradas. Para descobrir grupos novos sem inundar o
 * destino com grupos pessoais, registramos apenas mensagens com:
 * - pelo menos um link; e
 * - preço no texto (R$ ...).
 *
 * A sincronização diária usa essa lista para adicionar como origem somente
 * grupos que já provaram ser de oferta.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico } from "../store/json.js";
import { detectar } from "./parser.js";

export interface GrupoVisto {
  jid: string;
  ofertas: number;
  ultimaEm: string;
}

interface Store {
  grupos: Record<string, { ofertas: number; ultimaEm: string }>;
}

const MAX_VISTOS = 500;
const arquivo = () => join(dataDirAtual(), "grupos-vistos.json");

function carregar(): Store {
  try {
    if (!existsSync(arquivo())) return { grupos: {} };
    const raw = JSON.parse(readFileSync(arquivo(), "utf8")) as Partial<Store>;
    return { grupos: raw.grupos && typeof raw.grupos === "object" ? raw.grupos : {} };
  } catch {
    return { grupos: {} };
  }
}

function salvar(s: Store): void {
  gravarJsonAtomico(arquivo(), s);
}

/** Registra uma mensagem de grupo não monitorado se ela parecer oferta. */
export function registrarOfertaDeGrupo(jid: string, texto: string): boolean {
  if (!jid.endsWith("@g.us")) return false;
  const t = String(texto ?? "");
  if (!/R\$\s*\d/i.test(t)) return false;
  const links = detectar(t).links;
  if (links.length === 0) return false;

  const s = carregar();
  const atual = s.grupos[jid];
  s.grupos[jid] = { ofertas: (atual?.ofertas ?? 0) + 1, ultimaEm: new Date().toISOString() };

  // poda: mantém os 500 mais recentes
  const entradas = Object.entries(s.grupos);
  if (entradas.length > MAX_VISTOS) {
    entradas
      .sort((a, b) => String(b[1]?.ultimaEm ?? "").localeCompare(String(a[1]?.ultimaEm ?? "")))
      .slice(MAX_VISTOS)
      .forEach(([j]) => { if (s.grupos[j]) delete s.grupos[j]; });
  }
  salvar(s);
  return true;
}

/** Grupos com oferta nos últimos `dias`, mais recentes primeiro. */
export function listarGruposComOferta(dias = 7): GrupoVisto[] {
  const limite = Date.now() - Math.max(1, dias) * 24 * 60 * 60 * 1000;
  return Object.entries(carregar().grupos)
    .map(([jid, v]) => ({ jid, ofertas: Number(v?.ofertas) || 0, ultimaEm: String(v?.ultimaEm ?? "") }))
    .filter((g) => {
      const t = Date.parse(g.ultimaEm);
      return Number.isFinite(t) && t >= limite;
    })
    .sort((a, b) => b.ultimaEm.localeCompare(a.ultimaEm));
}
