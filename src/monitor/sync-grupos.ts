/**
 * Sincronização diária da lista de grupos ativos com as origens do monitor.
 *
 * A conta do WhatsApp entra/sai de grupos com frequência. Sem isso, um grupo
 * novo só passa a ser monitorado se o operador abrir o painel e adicioná-lo
 * manualmente — foi a causa de ofertas de 4 grupos ficarem de fora.
 *
 * A rotina:
 * 1. busca a lista real na Evolution (força, ignora cache);
 * 2. atualiza nomes das origens existentes;
 * 3. adiciona grupos novos como origens, usando o destino padrão;
 * 4. grava data/grupos-sync.json com o resultado (auditoria).
 *
 * Segurança: não remove origens; não adiciona o destino como origem; respeita
 * MAX_MONITOR_GRUPOS; pode ser desligada com MONITOR_AUTO_ORIGENS=0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico } from "../store/json.js";
import { logger } from "../observability/logger.js";
import { listarGrupos } from "./evolution.js";
import { sincronizarOrigens, type ResultadoSyncOrigens } from "./grupos.js";
import { listarGruposComOferta } from "./grupos-vistos.js";

export interface EstadoSyncGrupos {
  ultimaEm: string | null;
  ultimoResultado: ResultadoSyncOrigens | null;
  ultimoErro: string | null;
}

const arquivo = () => join(dataDirAtual(), "grupos-sync.json");

function ler(): EstadoSyncGrupos {
  try {
    if (!existsSync(arquivo())) return { ultimaEm: null, ultimoResultado: null, ultimoErro: null };
    const raw = JSON.parse(readFileSync(arquivo(), "utf8")) as Partial<EstadoSyncGrupos>;
    return {
      ultimaEm: typeof raw.ultimaEm === "string" ? raw.ultimaEm : null,
      ultimoResultado: raw.ultimoResultado ?? null,
      ultimoErro: typeof raw.ultimoErro === "string" ? raw.ultimoErro : null,
    };
  } catch {
    return { ultimaEm: null, ultimoResultado: null, ultimoErro: null };
  }
}

function salvar(e: EstadoSyncGrupos): void {
  gravarJsonAtomico(arquivo(), e);
}

export function estadoSyncGrupos(): EstadoSyncGrupos {
  return ler();
}

let rodando = false;

/** Executa agora (manual ou agendado). Nunca roda em paralelo. */
export async function sincronizarGruposAgora(motivo = "manual"): Promise<EstadoSyncGrupos & { ok: boolean }> {
  if (rodando) return { ...ler(), ok: false };
  rodando = true;
  try {
    const grupos = await listarGrupos(true);
    // Só entram grupos que já publicaram oferta (link + preço) nos últimos 7 dias.
    // O mapa existe para recuperar o nome vindo da Evolution.
    const vistos = listarGruposComOferta(7);
    const porJid = new Map(grupos.map((g) => [g.jid, g]));
    const ordenados = [
      ...vistos.map((v) => porJid.get(v.jid)).filter((g): g is NonNullable<typeof g> => !!g),
      ...grupos,
    ];
    const resultado = sincronizarOrigens(ordenados, { apenasJids: new Set(vistos.map((v) => v.jid)) });
    const estado: EstadoSyncGrupos = {
      ultimaEm: new Date().toISOString(),
      ultimoResultado: resultado,
      ultimoErro: null,
    };
    salvar(estado);
    logger.info(
      { motivo, total: resultado.total, adicionados: resultado.adicionados.length, atualizados: resultado.atualizados.length, destino: resultado.destinoPadrao },
      "sync de grupos concluído",
    );
    return { ...estado, ok: true };
  } catch (e: any) {
    const estado: EstadoSyncGrupos = {
      ...ler(),
      ultimaEm: new Date().toISOString(),
      ultimoErro: String(e?.message ?? e),
    };
    salvar(estado);
    logger.warn({ motivo, erro: estado.ultimoErro }, "sync de grupos falhou");
    return { ...estado, ok: false };
  } finally {
    rodando = false;
  }
}

function horaSync(): number {
  const h = Number(process.env.MONITOR_SYNC_GRUPOS_HORA ?? 6);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 6;
}

function proximaExecucao(hora: number): number {
  const agora = new Date();
  const prox = new Date(agora);
  prox.setHours(hora, 0, 0, 0);
  if (prox.getTime() <= agora.getTime()) prox.setDate(prox.getDate() + 1);
  return prox.getTime() - agora.getTime();
}

let timer: NodeJS.Timeout | null = null;

/**
 * Agenda a execução diária. Se a última execução tem mais de 20h (container
 * ficou parado, primeira instalação), roda uma vez após 30s para não esperar
 * até as 06:00.
 */
export function iniciarSyncGruposDiario(): void {
  if (process.env.MONITOR_SYNC_GRUPOS === "0") {
    logger.info("sync diário de grupos desligado (MONITOR_SYNC_GRUPOS=0)");
    return;
  }
  const st = ler();
  const ultima = st.ultimaEm ? Date.parse(st.ultimaEm) : 0;
  const vinteHoras = 20 * 60 * 60 * 1000;
  if (!ultima || Date.now() - ultima > vinteHoras) {
    setTimeout(() => void sincronizarGruposAgora("boot"), 30_000).unref();
  }

  const hora = horaSync();
  const agendar = () => {
    const delay = proximaExecucao(hora);
    timer = setTimeout(() => {
      void sincronizarGruposAgora("agendado");
      agendar();
    }, delay);
    timer.unref();
    logger.info({ hora, emMinutos: Math.round(delay / 60000) }, "sync diário de grupos agendado");
  };
  agendar();
}

export function pararSyncGruposDiario(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
