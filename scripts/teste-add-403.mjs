/**
 * TESTE CONTROLADO — 10 contatos que retornaram 403/add_request
 *
 * Objetivo: separar causa de falha (privacidade vs. ritmo vs. instância).
 * Ritmo: 1 tentativa por contato, 60s entre contatos (1/min).
 * Se a instância principal der erro de conexão, tenta a secundária 1x (registra).
 * Resultado em data/teste-add-403.json
 */
import { writeFileSync } from "node:fs";

const BASE = (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
const KEY = process.env.EVO_KEY ?? "";
const GRUPO = "120363412937047408@g.us";
const PAUSA_MS = 60_000;

const PRINCIPAL = "radar-47997136647-m28";
const SECUNDARIA = "radar-47992521346-3ga";

const NUMEROS = [
  "5517996238631",
  "556191711454",
  "555195319916",
  "559492467649",
  "558191495543",
  "558189970733",
  "558296931936",
  "557996635390",
  "5521990418498",
  "5511984661873",
];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function estado(inst) {
  try {
    const r = await fetch(`${BASE}/instance/connectionState/${inst}`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    return j?.instance?.state ?? "?";
  } catch {
    return "erro";
  }
}

async function participantes() {
  try {
    const r = await fetch(
      `${BASE}/group/findGroupInfos/${SECUNDARIA}?groupJid=${encodeURIComponent(GRUPO)}`,
      { headers: { apikey: KEY }, signal: AbortSignal.timeout(30000) },
    );
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j?.participants)
      ? j.participants.map((p) => String(p?.phoneNumber ?? "")).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/** Uma tentativa de add. Devolve tudo o que veio, sem interpretar. */
async function tentarAdd(inst, numero) {
  const inicio = Date.now();
  try {
    const r = await fetch(
      `${BASE}/group/updateParticipant/${inst}?groupJid=${encodeURIComponent(GRUPO)}`,
      {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", participants: [`+${numero}`] }),
        signal: AbortSignal.timeout(90000),
      },
    );
    const texto = await r.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {
      /* corpo não-JSON */
    }
    const item = Array.isArray(json?.updateParticipants) ? json.updateParticipants[0] : null;
    const statusParticipante = item?.status != null ? String(item.status) : null;
    const tagInterna = item?.content?.[0]?.tag ?? null;
    return {
      instancia: inst,
      http: r.status,
      statusParticipante,
      tagInterna,
      codigoConvite: item?.content?.[0]?.attrs?.code ?? null,
      erro: json?.error ?? item?.content?.error ?? null,
      mensagem: json?.response?.message ?? null,
      corpoBruto: texto.slice(0, 600),
      ms: Date.now() - inicio,
    };
  } catch (e) {
    return {
      instancia: inst,
      http: null,
      statusParticipante: null,
      tagInterna: null,
      codigoConvite: null,
      erro: String(e?.message ?? e),
      mensagem: null,
      corpoBruto: null,
      ms: Date.now() - inicio,
    };
  }
}

/** Classificação usada só no relatório final. */
function classificar(res) {
  const tags = [];
  if (res.statusParticipante === "409") return "ja_no_grupo";
  if (res.tagInterna === "add_request" || res.statusParticipante === "403") return "convite_pendente_403";
  if (res.statusParticipante === "408") return "timeout_408";
  if (res.http === 200 || res.http === 201) {
    if (!res.statusParticipante) return "sem_status_falso_positivo";
    return "entrou";
  }
  if (res.http === 400 && /Connection Closed/i.test(res.mensagem ?? res.corpoBruto ?? "")) return "instancia_fechada";
  if (res.http === 429) return "rate_limit";
  if (res.http >= 500) return "erro_servidor";
  return "outro";
}

const antes = new Set(await participantes());
console.log(`[teste] instância principal = ${PRINCIPAL} (${await estado(PRINCIPAL)})`);
console.log(`[teste] participantes antes = ${antes.size}`);
console.log(`[teste] ${NUMEROS.length} números, 1 tentativa cada, ${PAUSA_MS / 1000}s entre eles\n`);

const resultados = [];
for (let i = 0; i < NUMEROS.length; i++) {
  const numero = NUMEROS[i];
  const t0 = new Date().toISOString();

  let res = await tentarAdd(PRINCIPAL, numero);
  let usouFallback = false;
  let resFallback = null;

  // Erro de conexão da principal não é dado sobre o número: tenta a secundária 1x.
  if (classificar(res) === "instancia_fechada") {
    usouFallback = true;
    console.log(`[teste] ${numero}: principal fechada → aguardando 15s e tentando secundária`);
    await dormir(15000);
    resFallback = await tentarAdd(SECUNDARIA, numero);
  }

  const efetivo = resFallback ?? res;
  const linha = {
    n: i + 1,
    numero,
    em: t0,
    resultado: classificar(efetivo),
    usouFallback,
    tentativaPrincipal: res,
    tentativaSecundaria: resFallback,
  };
  resultados.push(linha);
  console.log(
    `[teste] ${i + 1}/${NUMEROS.length} ${numero} → ${linha.resultado}` +
      ` (http=${efetivo.http ?? "-"} status=${efetivo.statusParticipante ?? "-"} tag=${efetivo.tagInterna ?? "-"})` +
      (usouFallback ? " [fallback]" : ""),
  );

  if (i < NUMEROS.length - 1) {
    console.log(`[teste] aguardando ${PAUSA_MS / 1000}s...`);
    await dormir(PAUSA_MS);
  }
}

await dormir(5000);
const depois = new Set(await participantes());
const entraram = NUMEROS.filter((n) => depois.has(`${n}@s.whatsapp.net`) && !antes.has(`${n}@s.whatsapp.net`));

const resumo = {
  geradoEm: new Date().toISOString(),
  grupo: GRUPO,
  ritmo: "1 tentativa por contato, 60s entre contatos",
  instanciaPrincipal: PRINCIPAL,
  instanciaFallback: SECUNDARIA,
  participantesAntes: antes.size,
  participantesDepois: depois.size,
  entraram,
  contagem: resultados.reduce((acc, r) => {
    acc[r.resultado] = (acc[r.resultado] ?? 0) + 1;
    return acc;
  }, {}),
  resultados,
};

writeFileSync("data/teste-add-403.json", JSON.stringify(resumo, null, 2));
console.log("\n===== RESUMO =====");
console.log(JSON.stringify({ ...resumo, resultados: undefined }, null, 2));
console.log("\nArquivo: data/teste-add-403.json");
