import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hunt } from "../hunter/service.js";
import type { Filtros } from "../hunter/schema.js";
import { rankear } from "../scorer.js";
import { converterLink } from "../ml/provider.js";
import { grupoPara } from "../ml/contas.js";
import { gerarHeadline } from "../ai/gateway.js";
import { formatar } from "../wa/formatter.js";
import { jaEnviado, registrarEnvio, diaLocal } from "../store/dedup.js";
import { enviarParaGrupo } from "../wa/dispatch.js";
import catsJson from "../categorias.json" with { type: "json" };

const CATS = catsJson as { id: string; name: string }[];
const dataDir = process.env.ALCANCE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const filaFile = join(dataDir, "fila.json");
const KILL = join(dataDir, "AUTO_OFF");

export interface AutoOpts extends Filtros {
  corte: number;
  live: boolean; // false = dry-run
  conta?: string; // override de conta; vazio = mapa da categoria > padrão
  grupo?: string; // override de grupo; vazio = mapa da categoria > GRUPO_TESTE
}

const hora = () => Number(process.env.HORA_OVERRIDE ?? new Date().getHours());

export function dentroDaJanela(): boolean {
  const ini = Number(process.env.JANELA_INICIO ?? 8);
  const fim = Number(process.env.JANELA_FIM ?? 23);
  const h = hora();
  return h >= ini && h < fim;
}

export function enviosHoje(): number {
  const f = join(dataDir, "envios.json");
  if (!existsSync(f)) return 0;
  try {
    const arr: { data: string; dia?: string }[] = JSON.parse(readFileSync(f, "utf8"));
    const hoje = diaLocal();
    // dia gravado; entradas antigas (só ISO UTC) convertem para -03
    return arr.filter((e) => (e.dia ?? diaLocal(new Date(e.data))).slice(0, 10) === hoje).length;
  } catch {
    return 0;
  }
}

function lerFila(): any[] {
  if (!existsSync(filaFile)) return [];
  try {
    return JSON.parse(readFileSync(filaFile, "utf8"));
  } catch {
    return [];
  }
}

function salvarFila(fila: any[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filaFile, JSON.stringify(fila, null, 2));
}

/**
 * Uma passada do caçador (feita para cron a cada 2h):
 * hunt → rankear → dedup → enrich → copy → AUTO (envia) ou REVISÃO (enfilera).
 */
export async function runAuto(o: AutoOpts): Promise<string[]> {
  const log: string[] = [];
  const catName = CATS.find((c) => c.id === o.category)?.name ?? o.category;
  if (existsSync(KILL)) return [`KILL-SWITCH ativo (data/AUTO_OFF existe) — nada enviado. Remova o arquivo para retomar.`];
  if (!dentroDaJanela()) return [`Fora da janela ${process.env.JANELA_INICIO ?? 8}h–${process.env.JANELA_FIM ?? 23}h — nada enviado.`];
  // Sem limite diário (removido a pedido).

  const { url, candidatos, mock } = await hunt(o);
  log.push(`busca: ${url} ${mock ? "(MOCK)" : "(LIVE)"} • ${candidatos.length} candidatos`);
  const top = rankear(candidatos, o.corte, o.descontoMin).slice(0, o.limite);
  if (!top.length) return [...log, `Nenhuma oportunidade acima do corte ${o.corte}/desconto ${o.descontoMin}%.`];

  const modoAuto = (process.env.MODO ?? "REVISAO") === "AUTO" && process.env.AUTO_APROVADO === "true";
  const grupo = grupoPara(o.category, o.grupo);
  const fila = lerFila();
  for (const op of top) {
    if (jaEnviado(op.mlbId, op.precoAtual, op.cupom)) {
      log.push(`PULADO DUPLICADO_7D ${op.mlbId}`);
      continue;
    }
    const enrich = await converterLink(op.link, { conta: o.conta, category: o.category });
    if (enrich.aviso) log.push(`aviso enrich ${op.mlbId}: ${enrich.aviso.split(".")[0]}`);
    const { headline, subtitulo } = gerarHeadline(op);
    const msg = formatar({
      headline, subtitulo, nome: op.titulo, precoDe: op.precoDe,
      precoPix: op.precoAtual, cupom: op.cupom, link: enrich.linkAfiliado,
      categoria: `${catName}${o.q ? ` • “${o.q}”` : ""}`, score: op.score,
    });
    if (modoAuto) {
      const r = await enviarParaGrupo({
        grupo, imagem: op.imagem, legenda: msg, dryRun: !o.live,
      });
      log.push(`ENVIADO AUTO score=${op.score} ${op.mlbId} → ${grupo} id=${r.messageId} dryRun=${r.dryRun}`);
      if (o.live) registrarEnvio(op.mlbId, op.precoAtual, op.cupom);
    } else {
      fila.push({ mlbId: op.mlbId, titulo: op.titulo, score: op.score, motivo: op.motivo, mensagem: msg, grupo, conta: enrich.conta ?? null, imagem: op.imagem, data: new Date().toISOString() });
      log.push(`ENFILEIRADO REVISÃO score=${op.score} ${op.mlbId} → ${grupo} — aprove com: npm run dev -- fila:approve ${op.mlbId}${o.live ? " --live" : ""}`);
    }
  }
  salvarFila(fila);
  return log;
}

export function filaList(): string {
  const fila = lerFila();
  if (!fila.length) return "Fila vazia.";
  return fila.map((f: any) => `• ${f.mlbId} score=${f.score} ${f.titulo}\n  ${f.motivo}\n  ${String(f.mensagem).slice(0, 120)}…`).join("\n");
}

export async function filaApprove(mlbId: string, live: boolean): Promise<string> {
  const fila = lerFila();
  const i = fila.findIndex((f: any) => f.mlbId === mlbId);
  if (i < 0) return `Não achei ${mlbId} na fila.`;
  const item = fila[i];
  const r = await enviarParaGrupo({
    grupo: item.grupo ?? process.env.GRUPO_TESTE ?? "grupo-teste",
    imagem: item.imagem ?? "", legenda: item.mensagem, dryRun: !live,
  });
  if (live) {
    fila.splice(i, 1);
    salvarFila(fila);
  }
  return `Aprovado ${mlbId} → ${item.grupo ?? "?"} id=${r.messageId} dryRun=${r.dryRun}`;
}
