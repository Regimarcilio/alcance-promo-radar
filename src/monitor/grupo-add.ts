/**
 * ADICIONAR CONTATOS AO GRUPO — job em BACKGROUND.
 *
 * Por que em background: cada operação de grupo no WhatsApp pode demorar até
 * 60s quando a conta está com limite (rate-overlimit). Fazer isso dentro do
 * request HTTP travaria a tela por minutos. O job roda em segundo plano, em
 * GOTINHA (um contato por vez, com pausa), e a UI acompanha o progresso.
 *
 * O WhatsApp recusa adição em rajada: por isso o drip + o backoff. Se ainda
 * assim vier o limite, o job registra e segue para o próximo contato.
 */
import { adicionarUmParticipante } from "./evolution.js";
import { aguardarEnvioLivre } from "./envio-lock.js";
import { enviarBoasVindas, type LegendaOverride } from "../clientes/boas-vindas.js";
import { contaPareada } from "./evolution.js";

export interface EstadoAdicao {
  rodando: boolean;
  /** grupo em que está rodando */
  grupo: string;
  total: number;
  /** contatos já processados (ok ou falha) */
  feitos: number;
  /** contatos que entraram no grupo */
  adicionados: number;
  /** contatos que já estavam no grupo */
  jaNoGrupo: number;
  /** contatos que falharam */
  falhos: string[];
  /** boas-vindas enviadas (DM) para quem entrou */
  boasVindas: number;
  /** boas-vindas que falharam (não afetam a adição) */
  boasVindasFalhas: number;
  /** última mensagem de erro */
  ultimoErro: string | null;
  /** a conta esbarrou no rate limit do WhatsApp */
  limitado: boolean;
  /** quando terminou */
  finishedEm: string | null;
  /** fora da janela 6h–22h: aguardar até 6h do dia seguinte */
  foraJanela: boolean;
}

const vazio = (): EstadoAdicao => ({
  rodando: false,
  grupo: "",
  total: 0,
  feitos: 0,
  adicionados: 0,
  jaNoGrupo: 0,
  falhos: [],
  boasVindas: 0,
  boasVindasFalhas: 0,
  ultimoErro: null,
  limitado: false,
  finishedEm: null,
  foraJanela: false,
});

let estado: EstadoAdicao = vazio();

export function estadoAdicao(): EstadoAdicao {
  return { ...estado, falhos: [...estado.falhos] };
}

/** Configura o ritmo do job (ms). */
function cfg(nome: string, padrao: number): number {
  const v = Number(process.env[nome] ?? padrao);
  return Number.isFinite(v) && v >= 0 ? v : padrao;
}

/** Captura o ownerJid da conta (admin do grupo). Cacheado para evitar chamada repetida. */
let ownerJidCache: string | null = null;
async function obterOwnerJid(): Promise<string | null> {
  if (ownerJidCache) return ownerJidCache;
  try {
    const c = await contaPareada();
    ownerJidCache = c.jid;
    return ownerJidCache;
  } catch {
    return null;
  }
}

/** Verifica se está dentro da janela 6h–22h (inclusive). */
function dentroJanela(): boolean {
  const agora = new Date();
  const hora = agora.getHours();
  return hora >= 6 && hora < 22;
}

/** Calcula milissegundos até as 06:00 do próximo dia. */
function msAte6h(): number {
  const agora = new Date();
  const proxima6h = new Date(agora);
  proxima6h.setHours(6, 0, 0, 0);
  if (agora.getHours() >= 22) proxima6h.setDate(proxima6h.getDate() + 1);
  return Math.max(0, proxima6h.getTime() - agora.getTime());
}

/**
 * Inicia a adição em background. Se já houver um job rodando, devolve o
 * estado atual (não duplica).
 *
 * Parâmetros:
 * - grupoJid: ID do grupo no formato "120363412937047408@g.us"
 * - numeros: lista de números de telefone (sem +) dos contatos a adicionar
 * - opts: opções extras (legenda/imagem override para boas-vindas)
 */
export async function iniciarAdicaoGrupo(
  grupoJid: string,
  numeros: string[],
  opts: { legendaOverride?: LegendaOverride } = {},
): Promise<EstadoAdicao> {
  if (estado.rodando) return estadoAdicao();

  // Verifica janela 6h–22h
  if (!dentroJanela()) {
    const mg = msAte6h();
    estado = {
      ...vazio(),
      rodando: true,
      grupo: grupoJid,
      total: 0,
      finishedEm: new Date(Date.now() + mg).toISOString(),
      foraJanela: true,
    };
    // Agenda o start para 6h do dia seguinte
    setTimeout(() => iniciarAdicaoGrupo(grupoJid, numeros, opts).catch(console.error), mg);
    return estadoAdicao();
  }

  // Filtra admin do grupo (ownerJid)
  const owner = await obterOwnerJid();
  const adminNum = owner ? owner.split("@")[0] : null;
  const lista = [...new Set(numeros.filter(Boolean))].filter((n) => {
    if (!adminNum) return true;
    return !n.startsWith(adminNum);
  });

  estado = {
    ...vazio(),
    rodando: true,
    grupo: grupoJid,
    total: lista.length,
    finishedEm: null,
  };

  const pausa = cfg("GRUPO_ADICIONAR_PAUSA_MS", 3000);
  const espera = cfg("GRUPO_ADICIONAR_ESPERA_MS", 45000);
  const tentativas = cfg("GRUPO_ADICIONAR_TENTATIVAS", 3);

  void (async () => {
    for (const num of lista) {
      // O envio tem prioridade: a adição só acontece na folga entre envios.
      await aguardarEnvioLivre();
      const r = await adicionarUmParticipante(grupoJid, num, { esperas: espera, tentativas });
      if (r.ok && !r.jaNoGrupo) {
        estado.adicionados++;
        // Só manda boas-vindas com confirmação REAL do add (status 200/201).
        // Falha aqui não pode derrubar a adição.
        if (r.confirmado) {
          try {
            const bv = await enviarBoasVindas(num, {
              instancia: r.instancia,
              legendaOverride: opts.legendaOverride,
            });
            if (bv.ok && !bv.pulado) estado.boasVindas++;
            else if (!bv.ok) estado.boasVindasFalhas++;
          } catch {
            estado.boasVindasFalhas++;
          }
        }
      } else if (r.ok && r.jaNoGrupo) estado.jaNoGrupo++;
      else {
        estado.falhos.push(num);
        if (r.erro) estado.ultimoErro = r.erro;
        if (r.limitado) estado.limitado = true;
      }
      estado.feitos++;
      if (estado.feitos < lista.length) {
        await new Promise((s) => setTimeout(s, pausa));
      }
    }
    estado.rodando = false;
    estado.finishedEm = new Date().toISOString();
  })().catch((e) => {
    estado.ultimoErro = String(e);
    estado.rodando = false;
    estado.finishedEm = new Date().toISOString();
  });

  return estadoAdicao();
}