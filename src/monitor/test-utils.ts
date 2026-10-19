/** Utilitários compartilhados pelos testes (NÃO é arquivo *.test.ts). */

export function resJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function resRedirect(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * Substitui globalThis.fetch por um mock que registra as URLs chamadas.
 * Restaure com `restaurar()` (use try/finally).
 */
export function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): {
  chamadas: string[];
  restaurar: () => void;
} {
  const original = globalThis.fetch;
  const chamadas: string[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const u = String(input);
    chamadas.push(u);
    return impl(u, init);
  }) as typeof fetch;
  return {
    chamadas,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}
