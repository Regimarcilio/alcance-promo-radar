/**
 * Marca EX Technologies — aplicada nas páginas do manager (login e dashboard).
 *
 * O logo fica em `src/manager/assets/` e é servido por `/assets/brand/*` para
 * o navegador cachear (não infla o HTML). `aplicarMarca` troca o favicon
 * antigo, insere o símbolo EX no <head> e o footer antes de </body>.
 */

export const FAVICON_HTML =
  '<link rel="icon" type="image/png" sizes="256x256" href="/assets/brand/logo-ex-icon.png">\n' +
  '<link rel="apple-touch-icon" href="/assets/brand/logo-ex-icon.png">';

export const FOOTER_HTML = `
<footer class="ex-brand-footer" role="contentinfo" aria-label="Developed by EX Technologies">
  <img src="/assets/brand/logo-ex-icon.png" alt="EX Technologies" width="22" height="22" loading="lazy">
  <span>Developed by <strong>EX Technologies</strong></span>
</footer>
<style>
  .ex-brand-footer{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:55;
    display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;
    background:rgba(15,23,42,.82);color:#f8fafc;box-shadow:0 8px 22px rgba(2,6,23,.24);
    font:600 11.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    letter-spacing:.2px;pointer-events:none;opacity:.94;
    backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  .ex-brand-footer img{height:22px;width:22px;object-fit:cover;border-radius:5px;
    box-shadow:0 0 0 1px rgba(255,255,255,.16)}
  .ex-brand-footer strong{font-weight:800;color:#f5c451}
  @media (max-width:520px){
    .ex-brand-footer{font-size:10.5px;padding:5px 9px;bottom:8px}
    .ex-brand-footer img{height:18px;width:18px}
  }
</style>
`;

/** Marca uma versão do HTML. Idempotente: aplicar duas vezes não duplica. */
export function aplicarMarca(html: string): string {
  if (html.includes('class="ex-brand-footer"')) return html;
  // remove favicon antigo (o dashboard usa um SVG verde)
  const semIcone = html.replace(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>\s*/gi, "");
  let out = semIcone.replace(/<\/head>/i, `${FAVICON_HTML}\n</head>`);
  out = out.replace(/<\/body>/i, `${FOOTER_HTML}\n</body>`);
  return out;
}
