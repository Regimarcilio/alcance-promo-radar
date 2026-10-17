/**
 * Cliente Evolution (v2) para o MODO MONITOR (E6).
 * Lista os grupos da instância pareada, expõe o estado e permite trocar a conta
 * (logout) para reparear outro celular.
 */
export interface GrupoWhats {
  jid: string;
  nome: string;
  tamanho: number | null;
}

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
 */
let cacheGrupos: { em: number; dados: GrupoWhats[] } | null = null;
const TTL_GRUPOS_MS = 10 * 60 * 1000;

export async function listarGrupos(forcar = false): Promise<GrupoWhats[]> {
  if (!forcar && cacheGrupos && Date.now() - cacheGrupos.em < TTL_GRUPOS_MS) {
    return cacheGrupos.dados;
  }
  const arr = await evoGet<any[]>(`/group/fetchAllGroups/${inst()}?getParticipants=false`, 90000);
  if (!Array.isArray(arr)) throw new Error("resposta inesperada de fetchAllGroups");
  const dados = arr
    .map((g) => ({
      jid: String(g.id ?? ""),
      nome: String(g.subject ?? g.id ?? ""),
      tamanho: typeof g.size === "number" ? g.size : null,
    }))
    .filter((g) => g.jid.endsWith("@g.us"))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  cacheGrupos = { em: Date.now(), dados };
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
        webhookBase64: false,
        events: ["MESSAGES_UPSERT"],
        headers: webhookKey ? { "X-Webhook-Key": webhookKey } : {},
      },
    }),
  });
  if (!res.ok) throw new Error(`Evolution webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
