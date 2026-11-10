/**
 * Watchdog de instâncias WhatsApp.
 *
 * Problema que resolve: quando o WhatsApp desvincula os aparelhos
 * (`device_removed` / 401), o worker de clientes continuava tentando enviar e
 * queimava centenas de itens em erro (`Connection Closed`). Este watchdog
 * observa o estado das instâncias ATIVAS e, se NENHUMA estiver `open`, PAUSA a
 * fila de clientes automaticamente (não retoma sozinho — retomada é manual,
 * para não voltar a queimar itens num número morto).
 *
 * Uso:
 *   node tools/watchdog-instancias.mjs            (loop, 30s)
 *   node tools/watchdog-instancias.mjs --once     (checa 1 vez e sai)
 *
 * Env: EVO_URL, EVO_KEY, MANAGER_PORT, MANAGER_KEY, ALCANCE_DATA_DIR
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EVO = (process.env.EVO_URL || "http://localhost:8082").replace(/\/$/, "");
const KEY = process.env.EVO_KEY || "";
const MANAGER = `http://127.0.0.1:${process.env.MANAGER_PORT || 8091}`;
const MKEY = process.env.MANAGER_KEY || "";
const DATA = process.env.ALCANCE_DATA_DIR || join(process.cwd(), "data");
const INTERVALO = Math.max(10_000, Number(process.env.WATCHDOG_S || 30) * 1000);
const ONCE = process.argv.includes("--once");

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

function instanciasAtivas() {
  try {
    const s = JSON.parse(readFileSync(join(DATA, "instancias.json"), "utf8"));
    return (s.itens || []).filter((i) => i.ativo).map((i) => i.instancia);
  } catch {
    return [];
  }
}

async function estado(inst) {
  try {
    const r = await fetch(`${EVO}/instance/connectionState/${encodeURIComponent(inst)}`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    return String(j?.instance?.state ?? "erro");
  } catch {
    return "erro";
  }
}

async function filaPausada() {
  try {
    const r = await fetch(`${MANAGER}/api/clientes`, { headers: { "X-Manager-Key": MKEY } });
    const j = await r.json();
    return j?.fila?.pausado === true;
  } catch {
    return null;
  }
}

async function pausar() {
  try {
    const r = await fetch(`${MANAGER}/api/clientes/fila/pausar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Manager-Key": MKEY },
      body: "{}",
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function checar() {
  const ativas = instanciasAtivas();
  if (!ativas.length) {
    log("nenhuma instância ATIVA em instancias.json — nada a checar");
    return;
  }
  const estados = await Promise.all(ativas.map(async (i) => `${i}=${await estado(i)}`));
  const abertas = estados.filter((e) => e.endsWith("=open")).length;
  log(`estados: ${estados.join(", ")} | abertas=${abertas}/${ativas.length}`);

  if (abertas > 0) return;

  const pausada = await filaPausada();
  if (pausada === true) {
    log("todas fechadas, mas a fila JÁ está pausada — ok");
    return;
  }
  if (pausada === null) {
    log("não consegui ler o estado da fila do manager — pulando");
    return;
  }
  const ok = await pausar();
  log(`🔴 TODAS as instâncias fechadas → fila de clientes ${ok ? "PAUSADA automaticamente" : "FALHA ao pausar"}`);
}

if (ONCE) {
  await checar();
} else {
  log(`watchdog iniciado (intervalo ${INTERVALO / 1000}s, data=${DATA})`);
  await checar();
  setInterval(() => void checar(), INTERVALO);
}
