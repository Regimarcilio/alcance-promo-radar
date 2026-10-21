/**
 * Cliente Evolution (v2) para o MODO MONITOR (E6).
 * Lista os grupos da instância pareada, expõe o estado e permite trocar a conta
 * (logout) para reparear outro celular.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface GrupoWhats {
  jid: string;
  nome: string;
  tamanho: number | null;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// ALCANCE_DATA_DIR permite smoke/teste em diretório temporário sem tocar no estado real.
const dataDir = process.env.ALCANCE_DATA_DIR || join(root, "data");

function base(): string {
  return (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

function key(): string {
  return process.env.EVO_KEY ?? "";
}

function inst(): string {
  return process.env.EVO_INSTANCE ?? "radar-piloto";
}

async function evoGet<T = any>(path: string, timeoutMs = 60000): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    headers: { apikey: key() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Evolution ${res.status} em ${path}`);
  return (await res.json()) as T;
}

/** Estado da conexão: open | connecting | close. */
export async function estadoConexao(): Promise<string> {
  try {
    const j = await evoGet<any>(`/instance/connectionState/${inst()}`);
    return j?.instance?.state ?? "?";
  } catch {
    return "erro";
  }
}

/** Número/titular pareado (best-effort). */
export async function contaPareada(): Promise<{ jid: string | null; nome: string | null }> {
  try {
    const arr = await evoGet<any[]>(`/instance/fetchInstances?instanceName=${inst()}`);
    const i = Array.isArray(arr) ? arr[0] : null;
    return { jid: i?.ownerJid ?? null, nome: i?.profileName ?? null };
  } catch {
    return { jid: null, nome: null };
  }
}

/**
 * Lista os grupos da conta pareada (RF-030: origem dos grupos reais).
 * A Evolution demora ~15-30s nesse endpoint; cacheia por 10 min e aceita
 * `forcar=true` para refazer a busca.
 *
 * RESILIÊNCIA: o WhatsApp limita consultas de metadados (429 rate-overlimit).
 * Quando isso acontece a aba Monitor ficaria SEM lista de grupos. Por isso a
 * última lista boa é gravada em data/grupos-cache.json e serve de fallback:
 * a UI sempre mostra os grupos (marcando que veio do cache).
 */
let cacheGrupos: { em: number; dados: GrupoWhats[] } | null = null;
const TTL_GRUPOS_MS = 10 * 60 * 1000;

const CACHE_ARQ = join(dataDir, "grupos-cache.json");

/** Última lista de grupos salva em disco (para fallback quando a Evolution falha). */
export function gruposDoCache(): { grupos: GrupoWhats[]; em: string | null } {
  try {
    if (!existsSync(CACHE_ARQ)) return { grupos: [], em: null };
    const raw = JSON.parse(readFileSync(CACHE_ARQ, "utf8")) as { grupos?: GrupoWhats[]; em?: string };
    return { grupos: Array.isArray(raw.grupos) ? raw.grupos : [], em: raw.em ?? null };
  } catch {
    return { grupos: [], em: null };
  }
}

function salvarCacheGrupos(dados: GrupoWhats[]): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      CACHE_ARQ,
      JSON.stringify({ grupos: dados, em: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* cache é acessório: falhar aqui não pode derrubar a listagem */
  }
}

export async function listarGrupos(forcar = false): Promise<GrupoWhats[]> {
  if (!forcar && cacheGrupos && Date.now() - cacheGrupos.em < TTL_GRUPOS_MS) {
    return cacheGrupos.dados;
  }
  const arr = await evoGet<any[]>(`/group/fetchAllGroups/${inst()}?getParticipants=false`, 90000);
  if (!Array.isArray(arr)) throw new Error("resposta inesperada de fetchAllGroups");
  const dados = arr
    .map((g) => ({
      jid: String(g.id ?? ""),
      // `||` (e não `??`): grupo sem nome vem com subject "" — `??` manteria o vazio
      // e a opção apareceria sem rótulo na aba Monitor.
      nome: String(g.subject || g.id || "(sem nome)"),
      tamanho: typeof g.size === "number" ? g.size : null,
    }))
    .filter((g) => g.jid.endsWith("@g.us"))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  cacheGrupos = { em: Date.now(), dados };
  salvarCacheGrupos(dados);
  return dados;
}

/** Força reconexão do socket (destrava instância presa em "connecting"). */
export async function reiniciar(): Promise<void> {
  const res = await fetch(`${base()}/instance/restart/${inst()}`, {
    method: "POST",
    headers: { apikey: key(), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Evolution restart ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Desconecta a conta atual (logout) para permitir parear OUTRO celular.
 * NÃO apaga a instância — depois use /instance/connect para um QR novo.
 */
export async function desconectar(): Promise<void> {
  const res = await fetch(`${base()}/instance/logout/${inst()}`, {
    method: "DELETE",
    headers: { apikey: key() },
  });
  if (!res.ok) throw new Error(`Evolution logout ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Adiciona participantes a um grupo do WhatsApp (aba Clientes → "adicionar ao grupo").
 *
 * Evolution API v2: POST /group/updateParticipant/{instance}?groupJid=...
 * body: { action: "add", participants: ["+5511999999999", ...] }
 *
 * Observações do WhatsApp: só funciona se a conta pareada for ADMIN do grupo e
 * o grupo tiver o "link de convite" habilitado. Fora dessas condições a API
 * devolve erro — o chamador deve reportar sem quebrar a interface.
 */
export async function adicionarParticipantes(
  groupJid: string,
  numeros: string[],
): Promise<{ ok: boolean; erro?: string; adicionados: number }> {
  const jid = String(groupJid ?? "").trim();
  if (!jid.endsWith("@g.us")) return { ok: false, erro: "grupo inválido (esperado JID @g.us)", adicionados: 0 };
  // Só dígitos com código do país, prefixo "+" (formato exigido pela API).
  const participantes = [
    ...new Set(
      numeros
        .map((n) => String(n ?? "").replace(/\D/g, ""))
        .filter((n) => n.length >= 10)
        .map((n) => `+${n}`),
    ),
  ];
  if (!participantes.length) return { ok: false, erro: "nenhum número válido para adicionar", adicionados: 0 };

  try {
    const res = await fetch(
      `${base()}/group/updateParticipant/${inst()}?groupJid=${encodeURIComponent(jid)}`,
      {
        method: "POST",
        headers: { apikey: key(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", participants: participantes }),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      return { ok: false, erro: `Evolution ${res.status}${txt ? `: ${txt}` : ""}`, adicionados: 0 };
    }
    return { ok: true, adicionados: participantes.length };
  } catch (e) {
    return { ok: false, erro: String((e as Error)?.message ?? e), adicionados: 0 };
  }
}

/**
 * Permissões do grupo (quem pode falar/comentar).
 *
 * Evolution API v2: POST /group/updateSetting/{instance}?groupJid=...
 * body: { action }
 *   announcement     → só administradores enviam mensagens (participantes não comentam)
 *   not_announcement → todos voltam a enviar mensagens
 *   locked           → só administradores editam nome/avatar/descrição do grupo
 *   unlocked         → todos editam as informações do grupo
 *
 * Exige que a conta pareada seja ADMIN do grupo.
 */
export type AcaoGrupo = "announcement" | "not_announcement" | "locked" | "unlocked";

export interface PermissaoGrupo {
  /** true = só admins enviam mensagens (participantes não comentam) */
  announce: boolean;
  /** true = só admins editam as informações do grupo */
  restrict: boolean;
  tamanho: number | null;
  nome: string;
}

/** Estado atual das permissões do grupo. */
export async function buscarPermissaoGrupo(groupJid: string): Promise<PermissaoGrupo | null> {
  const jid = String(groupJid ?? "").trim();
  if (!jid.endsWith("@g.us")) return null;
  try {
    const res = await fetch(
      `${base()}/group/findGroupInfos/${inst()}?groupJid=${encodeURIComponent(jid)}`,
      { headers: { apikey: key() }, signal: AbortSignal.timeout(30000) },
    );
    if (!res.ok) return null;
    const g = (await res.json()) as {
      subject?: string;
      size?: number;
      announce?: boolean;
      restrict?: boolean;
    };
    return {
      announce: g.announce === true,
      restrict: g.restrict === true,
      tamanho: typeof g.size === "number" ? g.size : null,
      nome: String(g.subject ?? ""),
    };
  } catch {
    return null;
  }
}

/** Aplica uma permissão de grupo (announcement/locked). */
export async function definirPermissaoGrupo(
  groupJid: string,
  acao: AcaoGrupo,
): Promise<{ ok: boolean; erro?: string }> {
  const jid = String(groupJid ?? "").trim();
  if (!jid.endsWith("@g.us")) return { ok: false, erro: "grupo inválido (esperado JID @g.us)" };
  try {
    const res = await fetch(
      `${base()}/group/updateSetting/${inst()}?groupJid=${encodeURIComponent(jid)}`,
      {
        method: "POST",
        headers: { apikey: key(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: acao }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      return {
        ok: false,
        erro: `Evolution ${res.status}${txt ? `: ${txt}` : ""} (a conta precisa ser admin do grupo)`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String((e as Error)?.message ?? e) };
  }
}

/** Garante o webhook messages.upsert apontando para o manager. */
export async function configurarWebhook(url: string, webhookKey: string): Promise<void> {
  const res = await fetch(`${base()}/webhook/set/${inst()}`, {
    method: "POST",
    headers: { apikey: key(), "Content-Type": "application/json" },
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        webhookByEvents: false,
        webhookBase64: true,
        events: ["MESSAGES_UPSERT"],
        headers: webhookKey ? { "X-Webhook-Key": webhookKey } : {},
      },
    }),
  });
  if (!res.ok) throw new Error(`Evolution webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
