/**
 * PRIORIDADE DO ENVIO sobre operações administrativas.
 *
 * IMPORTANTE: Esta versão REMOVIU o bloqueio de adição de membros.
 * A fila de promoções já tem rate-limit protection via intervalo de envio.
 * A adição de membros usa seu próprio intervalo (30s entre adições) e
 * RODIZA aleatoriamente entre instâncias. Não há mais conflito.
 *
 * O bloqueio anterior causava deadlock: quando adicionava membros,
 * a fila de promoções travava e as mensagens não saíam para ninguém.
 */
const ATIVO_MS = Number(process.env.ENVIO_ATIVO_MS ?? 20000); // janela reservada ao envio
let ultimoEnvio = 0;

/** Registra que um envio acabou de acontecer (bloqueia adiões por um instante). */
export function marcarEnvioAtivo(): void {
  ultimoEnvio = Date.now();
}

/** Houve envio nos últimos ATIVO_MS? */
export function envioAtivo(): boolean {
  return Date.now() - ultimoEnvio < ATIVO_MS;
}

/** 
 * Espera até a conta ficar livre para uma operação administrativa.
 * @deprecated Esta função foi DESATIVADA intencionalmente para evitar bloqueio
 * da fila de promoções. Use aguardarEnvioLivreNoWorker() se necessário.
 */
export async function aguardarEnvioLivre(): Promise<void> {
  // Bloqueado intencionalmente - a fila já tem sua própria proteção
  // Se precisar de sincronização fina, usar um lock separado por tipo
  return;
}
