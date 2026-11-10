/**
 * Utilitários compartilhados do projeto.
 */

/**
 * Extrai a hora do formato "HH:MM" ou retorna o número diretamente.
 * Útil para processar variáveis que podem vir como "08:00" ou como número puro.
 */
export function extrairHora(valor: string | undefined, padrao: number): number {
  if (!valor) return padrao;
  const num = Number(valor);
  // Se for NaN (ex.: "08:00"), extrai a parte antes dos dois pontos
  return isNaN(num) ? Number(valor.split(":")[0]) : num;
}

/**
 * Obtém a hora local em America/Sao_Paulo.
 */
export function horaSaoPaulo(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
}

/**
 * Verifica se está dentro da janela de envio (8h-23h por padrão).
 * Lê variáveis de ambiente JANELA_INICIO / JANELA_FIM (formato "HH:MM" ou número).
 */
export function dentroDaJanela(
  inicio: number | string = process.env.JANELA_INICIO ?? 8,
  fim: number | string = process.env.JANELA_FIM ?? 23,
  horaAtual: number = horaSaoPaulo()
): boolean {
  const ini = typeof inicio === "number" ? inicio : extrairHora(String(inicio), 8);
  const f = typeof fim === "number" ? fim : extrairHora(String(fim), 23);
  return horaAtual >= ini && horaAtual < f;
}

/** Alias para compatibilidade com clientes.ts (horário comercial = janela de envio). */
export const dentroDaJanelaComercial = dentroDaJanela;