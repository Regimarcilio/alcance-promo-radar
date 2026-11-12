/**
 * CONTADORES da Mensageria — contadores simples para as métricas.
 *
 * Os contadores vivem em memória (são zerados a cada restart, como as demais
 * métricas de processo do Alcance) e alimentam a exportação Prometheus
 * (issue #52).
 */

export interface Contador {
  nome: string;
  labels: Record<string, string>;
  valor: number;
}

const contadores = new Map<string, { nome: string; labels: Record<string, string>; valor: number }>();

function chave(nome: string, labels?: Record<string, string>): string {
  const l = labels ?? {};
  const partes = Object.keys(l)
    .sort()
    .map((k) => `${k}=${l[k]}`);
  return partes.length ? `${nome}{${partes.join(",")}}` : nome;
}

/** Incrementa (ou cria) um contador. */
export function incrementar(nome: string, labels?: Record<string, string>, valor = 1): void {
  const k = chave(nome, labels);
  const atual = contadores.get(k);
  if (atual) atual.valor += valor;
  else contadores.set(k, { nome, labels: labels ?? {}, valor });
}

/** Valor de um contador (0 se não existe). */
export function valorContador(nome: string, labels?: Record<string, string>): number {
  return contadores.get(chave(nome, labels))?.valor ?? 0;
}

/** Todos os contadores (para a exportação Prometheus). */
export function lerContadores(): Contador[] {
  return [...contadores.values()].map((c) => ({ ...c, labels: { ...c.labels } }));
}

/** Zera os contadores (usado em teste). */
export function zerarContadores(): void {
  contadores.clear();
}
