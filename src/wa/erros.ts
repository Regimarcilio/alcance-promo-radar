/**
 * Classificação de erros de envio (WhatsApp/Evolution).
 *
 * Vive num módulo neutro para que a camada de Mensageria (política de retry)
 * possa classificar o erro **sem** criar ciclo de import com o dispatch.
 */

/** Erro de rede/conexão (vale repetir)? 5xx, "Connection Closed", socket, timeout. */
export function ehErroTransitorio(msg: string): boolean {
  return /Evolution (sendMedia|sendText)?\s*5\d\d|Connection Closed|Precondition Required|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|terminated|other side closed/i.test(
    msg
  );
}
