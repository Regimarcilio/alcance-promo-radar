/**
 * Orquestrador do modo MONITOR (E6 / RF-030–035).
 * Fluxo: webhook Evolution → origem monitorada? → parser → transformer →
 *        template → router (destinos) → dedup/anti-loop.
 */
import { detectar, rotulo, type OfertaDetectada } from "./parser.js";
import { transformar } from "./transformer.js";
import { destinosPara, ehMonitorado, carregarMonitor } from "./grupos.js";
import { jaMonitorado, marcarMonitorado, registrarEvento } from "./state.js";
import { enviarParaGrupo } from "../wa/dispatch.js";

/** Payload cru do Evolution (v2 e GO usam nomes ligeiramente diferentes). */
export interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    remoteJid?: string;
    fromMe?: boolean;
    message?: { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string } };
    pushName?: string;
  };
}

export interface MensagemExtraida {
  origem: string;
  deMim: boolean;
  texto: string;
  messageId: string;
}

/** Extrai o essencial do payload do webhook, tolerante a variações. */
export function extrairMensagem(p: WebhookPayload): MensagemExtraida | null {
  const d = p.data ?? {};
  const origem = d.key?.remoteJid ?? d.remoteJid ?? "";
  const deMim = d.key?.fromMe ?? d.fromMe ?? false;
  const msg = d.message ?? {};
  const texto =
    msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? "";
  const messageId = d.key?.id ?? "";
  if (!origem || !texto.trim()) return null;
  return { origem, deMim, texto, messageId };
}

export interface ResultadoMonitor {
  acao: "IGNORADO" | "DUPLICADO" | "REVISAO" | "ENCAMINHADO" | "ERRO";
  programa?: string;
  motivo?: string;
  destinos?: { jid: string; messageId: string }[];
}

/**
 * Processa uma mensagem recebida. Não lança: devolve o resultado e registra o evento.
 * `dryRun` propaga para o dispatch (teste sem enviar de verdade).
 */
export async function processar(
  msg: MensagemExtraida,
  opts: { dryRun?: boolean; conta?: string } = {}
): Promise<ResultadoMonitor> {
  const dryRun = opts.dryRun ?? false;

  // 1) Origem monitorada? (RF-030)
  if (msg.deMim || !ehMonitorado(msg.origem)) {
    return { acao: "IGNORADO", motivo: msg.deMim ? "mensagem própria" : "origem não monitorada" };
  }

  // 2) Detectar oferta/link (RF-031)
  const oferta: OfertaDetectada = detectar(msg.texto);
  if (!oferta.principal) {
    registrarEvento({
      em: new Date().toISOString(), origem: msg.origem, programa: "desconhecido",
      idProduto: null, linkTransformado: null, destino: null,
      status: "REVISAO", detalhe: "sem link de afiliado reconhecido",
    });
    return { acao: "REVISAO", motivo: "link não reconhecido" };
  }

  // 3) Transformar para o link do usuário (RF-032 / RN-012)
  const tr = await transformar(oferta.principal, { conta: opts.conta });

  // 4) Dedup 7d (RF-035)
  if (jaMonitorado(oferta.principal.programa, oferta.principal.idProduto, tr.url)) {
    registrarEvento({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: oferta.principal.idProduto, linkTransformado: tr.url, destino: null,
      status: "DUPLICADO",
    });
    return { acao: "DUPLICADO", programa: rotulo(oferta.principal.programa) };
  }

  // 5) Link válido? senão fila de revisão (RN-012)
  if (!tr.ok) {
    registrarEvento({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: oferta.principal.idProduto, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: tr.motivo,
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: tr.motivo };
  }

  // 6) Envio direto desligado? deixa na fila de revisão (UI: "OFF = vai p/ revisão")
  if (!carregarMonitor().autoEnviar) {
    registrarEvento({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: oferta.principal.idProduto, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: "envio direto desligado — aguardando revisão",
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: "autoEnviar=false" };
  }

  // 7) Montar mensagem e rotear destinos (RF-033/034 / RN-010 anti-loop)
  const corpo = montarRepasse(msg.texto, oferta, tr.url);
  const destinos = destinosPara(msg.origem);
  if (destinos.length === 0) {
    registrarEvento({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: oferta.principal.idProduto, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: "nenhum grupo de destino configurado",
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: "sem destinos" };
  }

  const enviados: { jid: string; messageId: string }[] = [];
  for (const destino of destinos) {
    try {
      const r = await enviarParaGrupo({ grupo: destino.jid, imagem: "", legenda: corpo, dryRun });
      enviados.push({ jid: destino.jid, messageId: r.messageId });
    } catch (e: any) {
      registrarEvento({
        em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
        idProduto: oferta.principal.idProduto, linkTransformado: tr.url, destino: destino.jid,
        status: "ERRO", detalhe: String(e?.message ?? e).slice(0, 120),
      });
    }
  }

  if (enviados.length > 0) marcarMonitorado(oferta.principal.programa, oferta.principal.idProduto, tr.url);
  registrarEvento({
    em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
    idProduto: oferta.principal.idProduto, linkTransformado: tr.url,
    destino: enviados.map((e) => e.jid).join(",") || null,
    status: enviados.length > 0 ? "ENCAMINHADA" : "ERRO",
    messageId: enviados[0]?.messageId,
  });
  return {
    acao: enviados.length > 0 ? "ENCAMINHADO" : "ERRO",
    programa: rotulo(oferta.principal.programa),
    destinos: enviados,
  };
}

/**
 * Formata a mensagem repassada: preserva o texto original (título/contexto),
 * troca o link pelo do usuário e acrescenta o rodapé padrão.
 */
export function montarRepasse(textoOriginal: string, oferta: OfertaDetectada, linkNovo: string): string {
  const base = oferta.textoLimpo || textoOriginal.replace(oferta.principal?.url ?? "", "").trim();
  const linhas = [
    ...(base ? [base, ``] : []),
    `🛒 Link do Produto ⤵️`,
    linkNovo,
  ];
  const txt = linhas.join("\n").trim();
  if (txt.length > 4096) return txt.slice(0, 4090) + "…";
  return txt;
}

/** Modo automático liga/desliga o envio direto (senão vai para revisão). */
export function autoEnviar(): boolean {
  return carregarMonitor().autoEnviar;
}
