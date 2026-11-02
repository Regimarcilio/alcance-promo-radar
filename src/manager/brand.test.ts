/** Marca EX: favicon no <head> e footer "Developed by EX Technologies". */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aplicarMarca, FAVICON_HTML, FOOTER_HTML } from "./brand.js";

function raizProjeto(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "manager", "server.ts"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("raiz do projeto não encontrada");
}

const HTML = '<!DOCTYPE html><html><head><title>x</title></head><body><main>ok</main></body></html>';

test("marca: insere favicon EX e footer no login e no dashboard", () => {
  const out = aplicarMarca(HTML);
  assert.ok(out.includes('href="/assets/brand/logo-ex-icon.png"'), "favicon EX ausente");
  assert.ok(out.includes('class="ex-brand-footer"'), "footer ausente");
  assert.ok(out.includes("Developed by"), "texto 'Developed by' ausente");
  assert.ok(out.includes("<strong>EX Technologies</strong>"), "texto 'EX Technologies' ausente");
  // favicon dentro do head e footer antes do </body>
  assert.ok(out.indexOf("logo-ex-icon.png") < out.indexOf("</head>"));
  assert.ok(out.indexOf("ex-brand-footer") < out.lastIndexOf("</body>"));
});

test("marca: é idempotente (não duplica favicon nem footer)", () => {
  const uma = aplicarMarca(HTML);
  const duas = aplicarMarca(uma);
  assert.equal((duas.match(/ex-brand-footer/g) ?? []).length, (uma.match(/ex-brand-footer/g) ?? []).length);
  assert.equal((duas.match(/logo-ex-icon\.png/g) ?? []).length, (uma.match(/logo-ex-icon\.png/g) ?? []).length);
});

test("marca: substitui o favicon antigo do dashboard", () => {
  const antigo =
    '<html><head><link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></head><body></body></html>';
  const out = aplicarMarca(antigo);
  assert.ok(!out.includes("data:image/svg+xml"), "favicon antigo deveria sair");
  assert.ok(out.includes("/assets/brand/logo-ex-icon.png"));
});

test("marca: login.html real recebe símbolo e footer", () => {
  const bruto = readFileSync(join(raizProjeto(), "src", "manager", "login.html"), "utf8");
  const out = aplicarMarca(bruto);
  assert.ok(out.includes(FAVICON_HTML.split("\n")[0]));
  assert.ok(out.includes(FOOTER_HTML.trim().split("\n")[0]));
  assert.ok(out.includes("Developed by <strong>EX Technologies</strong>"));
});

test("marca: arquivos de logo existem no projeto", () => {
  const base = join(raizProjeto(), "src", "manager", "assets");
  assert.ok(existsSync(join(base, "logo-ex.jpeg")), "logo-ex.jpeg ausente");
  assert.ok(existsSync(join(base, "logo-ex-icon.png")), "logo-ex-icon.png ausente");
});
