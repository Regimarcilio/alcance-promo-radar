/**
 * FAVORITOS DO MERCADO LIVRE (bookmarks).
 *
 * Objetivo: a cada oferta divulgada, guardar o item na lista de favoritos da
 * conta de afiliado — assim o afiliado tem uma vitrine central do que já
 * postou, e (com a conta logada) o cliente enxerga o restante da lista.
 *
 * API (Mercado Livre):
 *   POST   /users/me/bookmarks           body { item_id }  → adiciona
 *   GET    /users/me/bookmarks                        → lista
 *   DELETE /users/me/bookmarks/{item_id}              → remove
 *
 * Exige **access token OAuth** do usuário (`ML_ACCESS_TOKEN`). O projeto
 * hoje trabalha com TAG + COOKIE (que não autenticam a API de favoritos):
 * sem o token, o módulo fica INERTE e nada é enviado.
 *
 * O item precisa ser o anúncio do PRÓPRIO vendedor? A API aceita qualquer
 * item público; anúncios de terceiros podem ser recusados pela API — nesse
 * caso o erro é registrado e o fluxo continua (favoritar nunca pode derrubar
 * a publicação de uma oferta).
 */
import { createHash } from "node:crypto";

const API = "https://api.mercadolibre.com";

/** Token OAuth do afiliado (env). Sem ele, o módulo é inerte. */
export function tokenMl(): string {
  return process.env.ML_ACCESS_TOKEN?.trim() ?? "";
}

export function favoritosHabilitados(): boolean {
  return !!tokenMl();
}

interface RespostaMl {
  ok: boolean;
  erro?: string;
  jaFavorito?: boolean;
}

/** Chave de idempotência: evita favoritar o mesmo item várias vezes. */
function chaveItem(itemId: string): string {
  return createHash("sha1").update(itemId.trim().toUpperCase()).digest("hex").slice(0, 16);
}

/** Adiciona um item aos favoritos do afiliado. Nunca lança. */
export async function favoritarItem(itemId: string): Promise<RespostaMl> {
  const id = String(itemId ?? "").trim().toUpperCase();
  if (!/^(MLB|MLA|MLM|MLT)-?\d{6,}$/.test(id)) return { ok: false, erro: "item_id inválido" };
  const token = tokenMl();
  if (!token) return { ok: false, erro: "ML_ACCESS_TOKEN não configurado" };

  try {
    const r = await fetch(`${API}/users/me/bookmarks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: id }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 200 || r.status === 201) return { ok: true };
    const t = await r.text().catch(() => "");
    // já está nos favoritos → não é erro
    if (r.status === 409 || /já existe|already/i.test(t)) return { ok: true, jaFavorito: true };
    return { ok: false, erro: `ML ${r.status}${t ? `: ${t.slice(0, 120)}` : ""}` };
  } catch (e) {
    return { ok: false, erro: String((e as Error)?.message ?? e) };
  }
}

/** Lista os favoritos do afiliado (para conferência). */
export async function listarFavoritos(): Promise<{ item_id: string; bookmarked_date: string }[] | null> {
  const token = tokenMl();
  if (!token) return null;
  try {
    const r = await fetch(`${API}/users/me/bookmarks`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as unknown;
    return Array.isArray(j) ? (j as { item_id: string; bookmarked_date: string }[]) : null;
  } catch {
    return null;
  }
}

export { chaveItem };
