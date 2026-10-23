/**
 * Orquestrador do modo MONITOR (E6 / RF-030–035).
 * Fluxo: webhook Evolution → origem monitorada? → parser → transformer →
 *        template → router (destinos) → dedup/anti-loop.
 */
import { randomUUID } from "node:crypto";
import { detectar, rotulo, limparTexto, type OfertaDetectada } from "./parser.js";
import { expandirLink } from "./curtos.js";
import { transformar } from "./transformer.js";
import { extrairPrecos } from "./produto.js";
import { salvarMidia } from "./midia.js";
import { destinosPara, ehMonitorado, carregarMonitor } from "./grupos.js";
import { registrarOfertaDeGrupo } from "./grupos-vistos.js";
import { jaMonitorado, reservarMonitorado, registrarEvento } from "./state.js";
import { enfileirar, tamanhoFila, intervaloFila, ehRajada, entregarItem } from "./fila.js";
import { enviarParaGrupo } from "../wa/dispatch.js";
import { formatar } from "../wa/formatter.js";

/** Payload cru do Evolution (v2 e GO usam nomes ligeiramente diferentes). */
export interface WebhookPayload {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    remoteJid?: string;
    fromMe?: boolean;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string; mimetype?: string };
      /** presente quando a instância tem webhookBase64: true */
      base64?: string;
    };
    pushName?: string;
  };
}

export interface MensagemExtraida {
  origem: string;
  deMim: boolean;
  texto: string;
  messageId: string;
  /** Foto que a ORIGEM publicou (base64 do webhook), quando houver. */
  midia?: { base64: string; mimetype: string };
}

/**
 * Desembrulha mensagens "temporárias" (grupo com mensagens que desaparecem),
 * "ver uma vez" e documento-com-legenda. Sem isso, grupos que usam
 * ephemeralMessage chegam como `tipos:["ephemeralMessage"]` e o texto/imagem
 * fica escondido um nível abaixo — era o caso da #55 Emipe.
 */
function desembrulhar(m: any): any {
  let atual: any = m ?? {};
  for (let i = 0; i < 5; i++) {
    const prox =
      atual.ephemeralMessage?.message ??
      atual.viewOnceMessage?.message ??
      atual.viewOnceMessageV2?.message ??
      atual.documentWithCaptionMessage?.message ??
      atual.editedMessage?.message ??
      null;
    if (!prox) break;
    atual = prox;
  }
  return atual;
}

/** Extrai o essencial do payload do webhook, tolerante a variações. */
export function extrairMensagem(p: WebhookPayload): MensagemExtraida | null {
  const d = p.data ?? {};
  const origem = d.key?.remoteJid ?? d.remoteJid ?? "";
  const deMim = d.key?.fromMe ?? d.fromMe ?? false;
  const bruto: any = d.message ?? {};
  const msg: any = desembrulhar(bruto); // ephemeral/viewOnce/documentWithCaption
  const texto =
    msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? "";
  const messageId = d.key?.id ?? "";
  if (!origem || !texto.trim()) return null;
  // base64 pode vir no envelope externo ou no interno (ephemeral)
  const b64 =
    typeof msg.base64 === "string" ? msg.base64 : typeof bruto.base64 === "string" ? bruto.base64 : "";
  const midia = b64
    ? { base64: b64, mimetype: msg.imageMessage?.mimetype ?? "image/jpeg" }
    : undefined;
  return { origem, deMim, texto, messageId, midia };
}

/** Foto da origem tem prioridade? Agora é escolha persistida na UI (monitor.json). */
function fotoDaOrigemPrimeiro(): boolean {
  return carregarMonitor().foto !== "produto";
}

export interface ResultadoMonitor {
  acao: "IGNORADO" | "DUPLICADO" | "REVISAO" | "ENCAMINHADO" | "ENFILEIRADO" | "ERRO";
  programa?: string;
  motivo?: string;
  mensagem?: string;
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
  // MONITOR_DRY=1 força modo teste em TUDO (nenhum envio real sai) — rede de
  // segurança para mexer no sistema sem atingir o grupo de verdade.
  const dryRun = process.env.MONITOR_DRY === "1" ? true : opts.dryRun ?? false;
  // Teste (dryRun) não conta estatística nem consome dedup: simular não pode
  // inflar o painel nem bloquear a oferta real que chegar depois.
  const registrar = (ev: Parameters<typeof registrarEvento>[0]): void => {
    if (!dryRun) registrarEvento(ev);
  };

  // 1) Origem monitorada? (RF-030)
  if (msg.deMim || !ehMonitorado(msg.origem)) {
    // Grupo novo? Guarda a evidência (link + preço) para o sync diário
    // adicioná-lo como origem sem precisar de configuração manual.
    if (!msg.deMim) registrarOfertaDeGrupo(msg.origem, msg.texto);
    return { acao: "IGNORADO", motivo: msg.deMim ? "mensagem própria" : "origem não monitorada" };
  }

  // 2) Detectar oferta/link (RF-031)
  const oferta: OfertaDetectada = detectar(msg.texto);
  if (!oferta.principal) {
    // 2.1) Link no domínio da própria origem (ex.: oferta.emipefps.com/amazon/XXXX):
    // expande para a URL final (amazon.com.br/dp/ASIN?tag=...) e reclassifica.
    // Sem isso, o post do Emipe via domínio próprio morria em "sem link".
    const desconhecido = oferta.links.find((l) => l.programa === "desconhecido");
    if (desconhecido) {
      const expandido = await expandirLink(desconhecido.url);
      if (expandido) {
        oferta.principal = expandido;
        oferta.textoLimpo = limparTexto(msg.texto, desconhecido.url);
      }
    }
  }
  if (!oferta.principal) {
    // Diagnóstico: quais domínios chegaram e não foram reconhecidos? Sem isso
    // o operador só vê "link não reconhecido" e não sabe o que adicionar.
    const doms = [...new Set(oferta.links.map((l) => l.host).filter(Boolean))].slice(0, 3);
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: "desconhecido",
      idProduto: null, linkTransformado: null, destino: null,
      status: "REVISAO",
      detalhe: doms.length ? `sem link de afiliado reconhecido (${doms.join(", ")})` : "sem link de afiliado reconhecido",
    });
    return { acao: "REVISAO", motivo: doms.length ? `link não reconhecido (${doms.join(", ")})` : "link não reconhecido" };
  }

  // 3) Transformar para o link do usuário (RF-032 / RN-012)
  const tr = await transformar(oferta.principal, { conta: opts.conta });

  // Id efetivo p/ dedup: o do link, ou o resolvido do anúncio (links curtos
  // não trazem id na URL). Sem isso o mesmo produto duplicaria no grupo.
  const idEfetivo =
    oferta.principal.idProduto ??
    (tr.produto?.id ? tr.produto.id.replace(/^MLB-?/i, "MLB") : null);

  // 4) Dedup 7d (RF-035)
  if (jaMonitorado(oferta.principal.programa, idEfetivo, tr.url, msg.origem)) {
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url, destino: null,
      status: "DUPLICADO",
    });
    return { acao: "DUPLICADO", programa: rotulo(oferta.principal.programa) };
  }

  // 5) Link válido? senão fila de revisão (RN-012)
  if (!tr.ok) {
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: tr.motivo,
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: tr.motivo };
  }

  // 6) Monta a mensagem repassada (formato anterior + link do usuário)
  const corpo = montarRepasse(msg.texto, oferta, tr.url, tr.produto ?? null);

  // 6.1) Qual foto usar: por padrão a que a ORIGEM publicou (a mesma do post);
  //      se não vier, cai para a og:image do anúncio. MONITOR_FOTO=produto inverte.
  const arquivoOrigem = msg.midia?.base64 ? salvarMidia(msg.midia.base64, msg.midia.mimetype) : null;
  const fotoProduto = tr.produto?.imagem ?? "";
  const foto = fotoDaOrigemPrimeiro()
    ? arquivoOrigem ?? fotoProduto
    : fotoProduto || arquivoOrigem || "";
  const fonteFoto = !foto ? "sem foto" : foto === arquivoOrigem ? "foto da origem" : "foto do anúncio";

  // 7) Envio direto desligado? deixa na fila de revisão (UI: "OFF = vai p/ revisão")
  if (!carregarMonitor().autoEnviar) {
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: "envio direto desligado — aguardando revisão",
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: "autoEnviar=false", mensagem: corpo };
  }

  // 8) Rotear destinos (RF-033/034 / RN-010 anti-loop)
  const destinos = destinosPara(msg.origem);
  if (destinos.length === 0) {
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url, destino: null,
      status: "REVISAO", detalhe: "nenhum grupo de destino configurado",
    });
    return { acao: "REVISAO", programa: rotulo(oferta.principal.programa), motivo: "sem destinos", mensagem: corpo };
  }

  const item = {
    id: randomUUID(),
    criadoEm: new Date().toISOString(),
    origem: msg.origem,
    programa: oferta.principal.programa,
    idProduto: idEfetivo,
    link: tr.url,
    mensagem: corpo,
    imagem: foto,
    fonte: fonteFoto,
    destinos: destinos.map((d) => d.jid),
  };
  // 8) Teste (dryRun): simula o envio sem reservar dedup e sem contar evento.
  if (dryRun) {
    const simulados: { jid: string; messageId: string }[] = [];
    for (const destino of destinos) {
      const r = await enviarParaGrupo({
        grupo: destino.jid,
        imagem: foto,
        legenda: corpo,
        dryRun: true,
      });
      simulados.push({ jid: destino.jid, messageId: r.messageId });
    }
    return {
      acao: "ENCAMINHADO",
      programa: rotulo(oferta.principal.programa),
      mensagem: corpo,
      destinos: simulados,
    };
  }

  // Reserva ATÔMICA (sem await entre checar e gravar): duas mensagens do mesmo
  // produto em paralelo não passam as duas. Substitui o check+mark separados,
  // que tinham uma janela de corrida entre eles.
  if (!reservarMonitorado(oferta.principal.programa, idEfetivo, tr.url, msg.origem)) {
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url, destino: null,
      status: "DUPLICADO",
    });
    return { acao: "DUPLICADO", programa: rotulo(oferta.principal.programa) };
  }

  // 9) Rajada? Só da 4ª mensagem da MESMA origem no último minuto em diante
  //    entra na fila (liberada 1 a cada 2 min). Até 3, segue na hora.
  if (ehRajada(msg.origem)) {
    enfileirar(item);
    registrar({
      em: new Date().toISOString(), origem: msg.origem, programa: oferta.principal.programa,
      idProduto: idEfetivo, linkTransformado: tr.url,
      destino: destinos.map((d) => d.jid).join(","),
      status: "ENFILEIRADA",
      detalhe: `rajada (>3/min): fila ${tamanhoFila()} item(ns), 1 a cada ${intervaloFila()}s · ${fonteFoto}`,
    });
    return {
      acao: "ENFILEIRADO",
      programa: rotulo(oferta.principal.programa),
      mensagem: corpo,
    };
  }

  const enviados = await entregarItem(item);
  return {
    acao: "ENCAMINHADO",
    programa: rotulo(oferta.principal.programa),
    mensagem: corpo,
    destinos: enviados,
  };
}

/**
 * Formata a mensagem repassada.
 * - Com dados reais do anúncio (título + preço): usa o TEMPLATE ANTERIOR
 *   (RN-001 v3: foto 🔥 título + De/Por + link) — formato completo, não só texto.
 * - Sem dados suficientes: preserva o texto original + troca o link (fallback).
 */
export function montarRepasse(
  textoOriginal: string,
  oferta: OfertaDetectada,
  linkNovo: string,
  produto?: { titulo: string | null; imagem: string | null } | null
): string {
  if (produto?.titulo) {
    const { precoDe, precoAtual } = extrairPrecos(textoOriginal);
    if (precoAtual != null) {
      try {
        return formatar({
          headline: "",
          subtitulo: "",
          nome: produto.titulo,
          precoDe,
          precoPix: precoAtual,
          link: linkNovo,
          categoria: oferta.principal?.programa ?? "desconhecido",
          score: 0,
        });
      } catch {
        /* mensagem longa/inválida → usa o fallback abaixo */
      }
    }
  }
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
