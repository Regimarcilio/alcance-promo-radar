/**
 * PRIORIDADE DO ENVIO sobre operações administrativas.
 *
 * O envio de ofertas é o negócio; adicionar contatos ao grupo é operação
 * administrativa. As DUAS coisas usam a mesma conta do WhatsApp e o mesmo
 * orçamento de taxa (rate limit). Se as duas disputarem, o envio falha com
 * 500/rate-overlimit e a oferta é perdida.
 *
 * Aqui o envio marca "estou usando a conta agora"; o job de adição ESPERA
 * esse intervalo antes de mexer no grupo. Assim a adição acontece na folga
 * entre os envios — nunca competindo com eles.
 */
const ATIVO_MS = Number(process.env.ENVIO_ATIVO_MS ?? 20000); // janela reservada ao envio
let ultimoEnvio = 0;

/** Registra que um envio acabou de acontecer (bloqueia adições por um instante). */
export function marcarEnvioAtivo(): void {
  ultimoEnvio = Date.now();
}

/** Houve envio nos últimos ATIVO_MS? */
export function envioAtivo(): boolean {
  return Date.now() - ultimoEnvio < ATIVO_MS;
}

/** Espera até a conta ficar livre para uma operação administrativa. */
export async function aguardarEnvioLivre(): Promise<void> {
  while (envioAtivo()) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
