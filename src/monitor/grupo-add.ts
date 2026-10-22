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
  /** última mensagem de erro */
  ultimoErro: string | null;
  /** a conta esbarrou no rate limit do WhatsApp */
  limitado: boolean;
  /** quando terminou */
  finishedEm: string | null;
}

const vazio = (): EstadoAdicao => ({
  rodando: false,
  grupo: "",
  total: 0,
  feitos: 0,
  adicionados: 0,
  jaNoGrupo: 0,
  falhos: [],
  ultimoErro: null,
  limitado: false,
  finishedEm: null,
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

/**
 * Inicia a adição em background. Se já houver um job rodando, devolve o
 * estado atual (não duplica).
 */
export function iniciarAdicaoGrupo(grupoJid: string, numeros: string[]): EstadoAdicao {
  if (estado.rodando) return estadoAdicao();
  const lista = [...new Set(numeros.filter(Boolean))];
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
      if (r.ok) estado.adicionados++;
      else if (r.jaNoGrupo) estado.jaNoGrupo++;
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
  })();

  return estadoAdicao();
}
