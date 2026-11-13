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

// ---------- gauges ----------

/**
 * Gauges (valor instantâneo, não acumula): o valor é **substituído** a cada
 * medição — é o que serve para "tempo de espera até o reenvio" (aging).
 */
export interface Gauge {
  nome: string;
  labels: Record<string, string>;
  valor: number;
}

const gauges = new Map<string, { nome: string; labels: Record<string, string>; valor: number }>();

/** Define (substitui) o valor de um gauge. */
export function definirGauge(nome: string, labels?: Record<string, string>, valor = 0): void {
  const k = chave(nome, labels);
  gauges.set(k, { nome, labels: labels ?? {}, valor });
}

/** Valor de um gauge (0 se não existe). */
export function valorGauge(nome: string, labels?: Record<string, string>): number {
  return gauges.get(chave(nome, labels))?.valor ?? 0;
}

/** Todos os gauges (para a exportação Prometheus). */
export function lerGauges(): Gauge[] {
  return [...gauges.values()].map((g) => ({ ...g, labels: { ...g.labels } }));
}

/** Zera os gauges (usado em teste). */
export function zerarGauges(): void {
  gauges.clear();
}

/** Buckets do histograma de latência (ms). */
export const BUCKETS_LATENCIA = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export interface Histograma {
  nome: string;
  labels: Record<string, string>;
  /** contagem acumulada por bucket */
  buckets: number[];
  soma: number;
  total: number;
}

const histogramas = new Map<string, Histograma>();

/** Observa um valor de latência (ms) no histograma. */
export function observarLatencia(nome: string, labels: Record<string, string> | undefined, ms: number): void {
  const k = chave(nome, labels);
  let h = histogramas.get(k);
  if (!h) {
    h = { nome, labels: labels ?? {}, buckets: BUCKETS_LATENCIA.map(() => 0), soma: 0, total: 0 };
    histogramas.set(k, h);
  }
  h.soma += ms;
  h.total += 1;
  for (let i = 0; i < BUCKETS_LATENCIA.length; i++) {
    if (ms <= BUCKETS_LATENCIA[i]) h.buckets[i] += 1;
  }
}

/** Todos os histogramas (para a exportação Prometheus). */
export function lerHistogramas(): Histograma[] {
  return [...histogramas.values()].map((h) => ({ ...h, labels: { ...h.labels } }));
}
