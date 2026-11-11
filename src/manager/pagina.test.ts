/**
 * Regressão: o HTML do painel é um template literal do TypeScript. Um escape
 * simples (\n) dentro dele vira quebra de linha real no JS servido e QUEBRA
 * TODO o script do painel (SyntaxError silencioso no navegador).
 *
 * Este teste renderiza o template e valida a sintaxe de cada bloco <script>.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Raiz do projeto (o teste roda compilado em dist/). */
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

const fonte = readFileSync(join(raizProjeto(), "src", "manager", "server.ts"), "utf8");

/** Extrai o texto bruto do template `const PAGINA = `...`;`. */
function extrairTemplatePAGINA(src: string): string {
  const inicio = src.indexOf("const PAGINA = `");
  assert.ok(inicio >= 0, "PAGINA não encontrada em server.ts");
  const comAbertura = src.slice(inicio + "const PAGINA = ".length);
  const fim = comAbertura.indexOf("`;");
  assert.ok(fim > 0, "fechamento do template PAGINA não encontrado");
  return comAbertura.slice(1, fim);
}

/** Renderiza o template igual o TypeScript faria (mesmas regras de escape). */
function renderizarPAGINA(): string {
  return new Function("return `" + extrairTemplatePAGINA(fonte) + "`;")() as string;
}

test("HTML do painel: nenhum escape \\n simples dentro do template literal", () => {
  const texto = extrairTemplatePAGINA(fonte);
  // \n simples (não precedido de outra barra) vira quebra real no JS servido.
  const achados: { linha: number; trecho: string }[] = [];
  texto.split("\n").forEach((l, i) => {
    const re = /(?<!\\)\\[nrt]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      achados.push({ linha: i + 1, trecho: l.slice(Math.max(0, m.index - 40), m.index + 40) });
    }
  });
  assert.equal(
    achados.length,
    0,
    `escape simples dentro do template literal quebra o JS do painel:\n` +
      achados.map((a) => `  linha ~${a.linha}: ...${a.trecho}...`).join("\n"),
  );
});

test("HTML do painel: cada bloco <script> é JavaScript válido", () => {
  const html = renderizarPAGINA();
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(html))) {
    n++;
    const js = m[1];
    // new Function só PARSEIA o código: SyntaxError sai aqui se estiver inválido.
    assert.doesNotThrow(
      () => new Function(js),
      `bloco <script> #${n} tem sintaxe inválida (o painel inteiro para de funcionar)`,
    );
  }
  assert.ok(n >= 2, `esperava ao menos 2 blocos <script>, achou ${n}`);
});

test("HTML do painel: elementos e funções da aba Clientes presentes", () => {
  const html = renderizarPAGINA();
  for (const id of ["cligrupo", "cliaddbox", "cligrupoalvo", "clilist", "clibusca"]) {
    assert.ok(html.includes(`id="${id}"`), `elemento #${id} ausente no HTML`);
  }
  for (const fn of ["filtroContatos", "atualizarCaixaAdicionar", "adicionarAoGrupo", "carregarGruposAlvo"]) {
    assert.ok(html.includes(fn), `função ${fn} ausente no script do painel`);
  }
});
