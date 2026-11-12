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
 * POLÍTICA DE ENVIO (atualizada com o operador):
 * - TODOS os números ativos e com conexão "open" participam do ENVIO,
 *   inclusive o principal; o peso define a fatia de cada aparelho;
 * - o **PRINCIPAL** continua sendo o preferido para as operações de SERVIÇO
 *   (adicionar contatos, permissões de grupo) — o número "de casa";
 * - se um número falha, o dispatch repete em outro; se nenhum estiver open,
 *   ainda sorteia um ativo (nada fica sem enviar);
 * - o rodízio é ponderado + anti-repetição para não concentrar volume.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { publicarEvento } from "../messaging/eventos.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fluxos de envio que compartilham o rodízio de números. */
export type FluxoEnvio = "piloto" | "monitor" | "disparo";

/** Permissões por número: em quais fluxos ele pode ser remetente. */
export interface PermissoesInstancia {
  piloto: boolean;
  monitor: boolean;
  disparo: boolean;
}

const PERMISSOES_PADRAO: PermissoesInstancia = { piloto: true, monitor: true, disparo: true };

/** Override manual por fluxo: nome da instância fixada (null/ausente = automático). */
export interface OverrideFluxo {
  piloto?: string | null;
  monitor?: string | null;
  disparo?: string | null;
}

const FLUXOS: FluxoEnvio[] = ["piloto", "monitor", "disparo"];

/** Normaliza o override vindo do JSON (só strings não vazias ou null). */
function normalizarOverride(raw: any): OverrideFluxo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o: OverrideFluxo = {};
  for (const f of FLUXOS) {
    const v = raw[f];
    if (typeof v === "string" && v.trim()) o[f] = v;
    else if (v === null) o[f] = null;
  }
  return Object.keys(o).length ? o : undefined;
}

export interface InstanciaWhats {
  instancia: string; // nome da instância na Evolution
  nome: string; // rótulo amigável ("Celular 2")
  ativo: boolean;
  peso: number; // 1..10
  enviadas: number;
  ultimaEm: string | null;
  criadaEm: string;
  /** principal = preferido para operações de serviço (também participa do envio) */
  principal?: boolean;
  /** em quais fluxos este número pode enviar (migração: todos true) */
  permissoes: PermissoesInstancia;
  /** pausa o número INTEIRO (todos os fluxos) sem desativá-lo */
  pausado: boolean;
  /** override manual: fixa este número em um fluxo (ausente = automático) */
  override?: OverrideFluxo;
}

/** Normaliza permissões vindas do JSON (campo ausente = permitido). */
function normalizarPermissoes(raw: any): PermissoesInstancia {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    piloto: r.piloto !== false,
    monitor: r.monitor !== false,
    disparo: r.disparo !== false,
  };
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
        permissoes: { ...PERMISSOES_PADRAO },
        pausado: false,
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
              // migração retrocompatível: sem os campos novos = tudo permitido
              permissoes: normalizarPermissoes(i.permissoes),
              pausado: i.pausado === true,
              ...(normalizarOverride(i.override) ? { override: normalizarOverride(i.override) } : {}),
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

/** Último estado publicado por instância (para emitir só na mudança). */
const estadoPublicado = new Map<string, string>();

/**
 * Publica o evento de conexão/desconexão **na mudança de estado** (o produtor
 * não conhece quem assina — o painel, a auditoria e o watchdog decidem o que
 * fazer). Um evento nunca pode derrubar a leitura de estado.
 */
function publicarEstado(instancia: string, estado: string): void {
  if (estadoPublicado.get(instancia) === estado) return;
  estadoPublicado.set(instancia, estado);
  try {
    if (estado === "open") {
      publicarEvento("instancia.conectada", { instancia, motivo: null });
    } else {
      publicarEvento("instancia.desconectada", { instancia, motivo: estado });
    }
  } catch {
    /* evento é acessório */
  }
}

/** Estado da conexão com cache curto (evita 1 request por envio). */
export async function estadoInstancia(instancia: string, forcar = false): Promise<string> {
  const c = estados.get(instancia);
  if (!forcar && c && Date.now() - c.em < TTL_ESTADO) return c.estado;
  try {
    const j = await evo(`/instance/connectionState/${encodeURIComponent(instancia)}`, {}, 15_000);
    const e = String(j?.instance?.state ?? "?");
    estados.set(instancia, { estado: e, em: Date.now() });
    publicarEstado(instancia, e);
    return e;
  } catch {
    estados.set(instancia, { estado: "erro", em: Date.now() });
    publicarEstado(instancia, "erro");
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

export async function proximaInstancia(fluxo?: FluxoEnvio, excluir: string[] = []): Promise<string> {
  const s = carregar();

  // OVERRIDE manual: se o fluxo tem um número fixado e ele está saudável, usa.
  // Se estiver inválido (pausado, desativado, sem permissão, desconectado ou
  // acabou de falhar), cai no automático com aviso — nunca trava o envio.
  if (fluxo) {
    const fixada = overrideDoFluxo(fluxo);
    if (fixada) {
      const item = s.itens.find((i) => i.instancia === fixada);
      const estado = item ? await estadoInstancia(fixada) : "?";
      const valido =
        !!item &&
        item.ativo &&
        !item.pausado &&
        item.permissoes[fluxo] === true &&
        estado === "open" &&
        !instanciaRuim(fixada) &&
        !excluir.includes(fixada);
      if (valido) {
        console.log(`[rotacao] override ${fixada} usado no fluxo ${fluxo}`);
        ultimaUsada = fixada;
        return fixada;
      }
      console.log(`[rotacao] override ${fixada} inválido para fluxo ${fluxo} — usando automático`);
    }
  }

  // pausado vale para TODOS os fluxos (inclusive chamadas sem fluxo)
  const ativos = s.itens.filter(
    (i) => i.ativo && !i.pausado && (!fluxo || i.permissoes[fluxo] === true)
  );
  if (ativos.length === 0) {
    if (fluxo) {
      throw new Error(
        `Nenhum número ativo e permitido para o fluxo "${fluxo}" — verifique permissões e pausa na aba Números`
      );
    }
    return padrao();
  }
  const comEstado = await Promise.all(
    ativos.map(async (i) => ({ i, e: await estadoInstancia(i.instancia) }))
  );
  const abertos = comEstado.filter((x) => x.e === "open").map((x) => x.i);
  // CRITÉRIO: Nenhuma instância com state "open" conhecida?
  // - Não confiar cegamente em "open" de instâncias possivelmente zumbis.
  // - Usar apenas instâncias que SABEM estar saudáveis.
  // - O retry em comRetry() marca como "ruim" e tenta outra instância.
  // - Isto evita enviar com instâncias offline, reduzindo falhas.
  const ativosSaudaveis = ativos.filter((i) => !instanciaRuim(i.instancia));

  // NÃO confiar cegamente em "open" de instâncias possivelmente zumbis.
  // Se a principal estiver falhando, priorizar outras saudáveis.
  const abertosSaudaveis = abertos.filter((i) => !instanciaRuim(i.instancia));

  let candidatos = abertosSaudaveis.length > 0
    ? abertosSaudaveis
    : (ativosSaudaveis.length > 0 ? ativosSaudaveis : ativos);

  // Falhou agora (ex.: upload "Connection Closed")? não sorteia de novo na
  // mesma entrega; se só sobrar ele, o fallback abaixo mantém o envio vivo.
  if (excluir.length > 0) {
    const restantes = candidatos.filter((i) => !excluir.includes(i.instancia));
    if (restantes.length > 0) candidatos = restantes;
  }

  // ENVIO DE MENSAGENS: todos os números abertos participam, inclusive o
  // principal. O peso de cada um define a fatia no rodízio. O principal só
  // tem prioridade nas operações de serviço (instanciaParaServico), não aqui.

  // Instâncias que falharam por conexão há pouco saem do sorteio (se sobrar
  // alguma). O connectionState delas pode dizer "open" mesmo mortas.
  const saudaveis = candidatos.filter((i) => !instanciaRuim(i.instancia));
  if (saudaveis.length > 0) candidatos = saudaveis;

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
 * Valida uma instância FIXADA por campanha (issue #45).
 *
 * Usada quando o operador escolhe o número que envia uma campanha da aba
 * Clientes: a fixada só vale se estiver realmente apta a enviar agora
 * (existe no cadastro, ativa, não pausada, com permissão do fluxo, conectada
 * e sem falha recente). Se qualquer uma dessas condições falhar, o chamador
 * cai no sorteio automático — o envio NUNCA trava por causa do número escolhido.
 */
export interface AvaliacaoInstancia {
  ok: boolean;
  /** motivo da invalidez (null quando válida) */
  motivo: string | null;
}

export async function avaliarInstanciaFixada(
  instancia: string,
  fluxo: FluxoEnvio,
  excluir: string[] = [],
): Promise<AvaliacaoInstancia> {
  const nome = String(instancia ?? "").trim();
  if (!nome) return { ok: false, motivo: "nenhum número escolhido" };
  const item = carregar().itens.find((i) => i.instancia === nome);
  if (!item) return { ok: false, motivo: "não está no cadastro" };
  if (!item.ativo) return { ok: false, motivo: "número desativado" };
  if (item.pausado) return { ok: false, motivo: "número pausado" };
  if (item.permissoes[fluxo] !== true) return { ok: false, motivo: `sem permissão ${fluxo}` };
  if (excluir.includes(nome)) return { ok: false, motivo: "já falhou nesta entrega" };
  if (instanciaRuim(nome)) return { ok: false, motivo: "falhou por conexão recentemente" };
  const estado = await estadoInstancia(nome);
  if (estado !== "open") return { ok: false, motivo: `estado ${estado}` };
  return { ok: true, motivo: null };
}

/**
 * Candidatas para OPERAÇÕES DE SERVIÇO (adicionar contatos, permissões de
 * grupo), em ordem de preferência: principal → demais ativas (peso maior
 * primeiro) → principal como último recurso.
 *
 * Não consultamos `connectionState` de propósito: ele MENTE. Em 01/11 a
 * instância `radar-47992521346-3ga` respondia `state:"open"` e devolvia
 * `Connection Closed` em toda operação real. Por isso a troca de instância é
 * feita por quem chama: se a chamada falhar por conexão, tenta a próxima
 * desta lista. O envio de mensagens continua no rodízio separado.
 */
export function instanciasParaServico(): string[] {
  const itens = carregar().itens.filter((i) => i.ativo);
  const p = instanciaPrincipal();
  const ordem: string[] = [];
  const add = (nome?: string | null) => {
    if (nome && !ordem.includes(nome)) ordem.push(nome);
  };

  if (p && p.ativo) add(p.instancia);
  for (const i of [...itens].sort((a, b) => (Number(b.peso) || 1) - (Number(a.peso) || 1))) {
    add(i.instancia);
  }
  // Nenhuma ativa: mantém o comportamento antigo (tenta a principal mesmo assim).
  if (!ordem.length && p) add(p.instancia);
  if (!ordem.length) add(padrao());

  // Instâncias que acabaram de falhar por conexão vão para o fim (sort estável),
  // para o lote seguinte não pagar de novo o timeout da instância zumbi.
  return [...ordem].sort((a, b) => Number(instanciaRuim(a)) - Number(instanciaRuim(b)));
}

const ruins = new Map<string, number>();

/** Marca a instância como "zumbi" por um tempo (default 5 min). */
export function marcarInstanciaRuim(instancia: string, ttlMs = 5 * 60_000): void {
  if (!instancia) return;
  ruins.set(instancia, Date.now() + Math.max(1000, ttlMs));
}

/** true se a instância falhou por conexão recentemente. */
export function instanciaRuim(instancia: string): boolean {
  const expira = ruins.get(instancia);
  if (!expira) return false;
  if (Date.now() > expira) {
    ruins.delete(instancia);
    return false;
  }
  return true;
}

/** Primeira candidata de serviço (compatibilidade). */
export async function instanciaParaServico(): Promise<string> {
  const lista = await instanciasParaServico();
  return lista[0] ?? padrao();
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
    permissoes: { ...PERMISSOES_PADRAO },
    pausado: false,
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

/** Liga/desliga em quais fluxos o número pode enviar. */
export function definirPermissoes(
  instancia: string,
  permissoes: Partial<PermissoesInstancia>
): void {
  const s = carregar();
  const i = s.itens.find((x) => x.instancia === instancia);
  if (!i) return;
  i.permissoes = {
    piloto: permissoes.piloto ?? i.permissoes.piloto,
    monitor: permissoes.monitor ?? i.permissoes.monitor,
    disparo: permissoes.disparo ?? i.permissoes.disparo,
  };
  salvar(s);
}

/** Pausa/continua o número inteiro (todos os fluxos) sem alterar `ativo`. */
export function definirPausado(instancia: string, pausado: boolean): void {
  const s = carregar();
  const i = s.itens.find((x) => x.instancia === instancia);
  if (!i) return;
  i.pausado = !!pausado;
  salvar(s);
}

/** Instância fixada manualmente para o fluxo (null = automático). */
export function overrideDoFluxo(fluxo: FluxoEnvio): string | null {
  for (const i of carregar().itens) {
    const v = i.override?.[fluxo];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Define/limpa o override de um fluxo.
 * - `valor` = nome da instância a fixar; `null`/vazio limpa (volta ao automático).
 * - `instancia` é a linha que carrega a configuração (na UI, a própria fixada).
 * Só existe um override por fluxo: limpa nos demais antes de gravar.
 */
export function definirOverride(instancia: string, fluxo: FluxoEnvio, valor: string | null): void {
  if (!FLUXOS.includes(fluxo)) throw new Error(`fluxo inválido: ${fluxo}`);
  const s = carregar();
  for (const i of s.itens) {
    if (i.override) {
      delete i.override[fluxo];
      if (!Object.keys(i.override).length) delete i.override;
    }
  }
  const nome = typeof valor === "string" ? valor.trim() : "";
  if (nome) {
    const alvo = s.itens.find((i) => i.instancia === instancia) ?? s.itens.find((i) => i.instancia === nome);
    if (!alvo) throw new Error(`instância ${instancia} não encontrada`);
    alvo.override = { ...(alvo.override ?? {}), [fluxo]: nome };
  }
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
