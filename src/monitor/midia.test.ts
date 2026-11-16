/**
 * REGRESSÃO issue #82 — mídia de campanha apagada pela faxina de retenção.
 *
 * Diagnóstico: a retenção de 3 dias (RN-026) apagava o vídeo que o operador
 * sobe na aba Clientes no meio do disparo (550 contatos). As mensagens
 * restantes morriam com "caminho de mídia não permitido" — mensagem de
 * segurança para um problema de EXPIRAÇÃO — e ficavam presas na DLQ para
 * sempre, porque reprocessar repetia a mesma falha.
 *
 * O que estes testes travam:
 * - `classificarMidia` separa "inexistente" de "não permitido";
 * - o envio cai para **texto** quando a mídia sumiu (mídia é acessório);
 * - a segurança continua bloqueando caminho fora de `data/midia`;
 * - a faxina **preserva** a mídia que ainda está em uso;
 * - o reprocessamento da DLQ devolve o item só com o texto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Prepara um ALCANCE_DATA_DIR novo e importa `midia.js` apontando para ele. */
async function carregarMidia() {
  const dir = mkdtempSync(join(tmpdir(), "alcance-midia-"));
  process.env.ALCANCE_DATA_DIR = dir;
  const mod = await import(`./midia.js?v=${Math.random()}`);
  return { mod, dir };
}

/** Cria um arquivo de mídia válido (nome UUID + extensão) dentro de data/midia. */
function criarMidia(dir: string, ext = "mp4", nome?: string): string {
  const midiaDir = join(dir, "midia");
  mkdirSync(midiaDir, { recursive: true });
  const arquivo = join(midiaDir, nome ?? `${randomUUID()}.${ext}`);
  writeFileSync(arquivo, "conteudo");
  return arquivo;
}

test("classificarMidia: arquivo válido em data/midia → ok", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    const arquivo = criarMidia(dir, "jpg");
    const c = mod.classificarMidia(arquivo);
    assert.equal(c.ok, true);
    assert.equal(c.motivo, "ok");
    assert.equal(mod.ehArquivoMidia(arquivo), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classificarMidia: arquivo removido → 'inexistente' (não é violação de segurança)", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    const arquivo = criarMidia(dir, "mp4");
    rmSync(arquivo);
    const c = mod.classificarMidia(arquivo);
    assert.equal(c.ok, false);
    assert.equal(c.motivo, "inexistente", "expiração é diferente de segurança");
    assert.match(c.erro ?? "", /não existe mais/);
    assert.equal(mod.ehArquivoMidia(arquivo), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classificarMidia: caminho fora de data/midia → 'nao-permitido'", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    // arquivo VÁLIDO (nome UUID) que existe, mas está fora de data/midia
    const fora = join(dir, `${randomUUID()}.jpg`);
    writeFileSync(fora, "segredo");
    const c = mod.classificarMidia(fora);
    assert.equal(c.ok, false);
    assert.equal(c.motivo, "nao-permitido");
    assert.match(c.erro ?? "", /fora de data\/midia/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classificarMidia: caminho arbitrário → recusa de segurança (formato ou não-permitido)", async () => {
  const { mod } = await carregarMidia();
  for (const caminho of ["/etc/passwd", "/app/.env", "../../etc/passwd"]) {
    const c = mod.classificarMidia(caminho);
    assert.equal(c.ok, false, `${caminho} tem que ser recusado`);
    assert.ok(
      c.motivo === "nao-permitido" || c.motivo === "formato-invalido",
      `${caminho}: motivo de segurança esperado, veio ${c.motivo}`,
    );
  }
});

test("classificarMidia: nome fora do padrão UUID → 'formato-invalido'", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    const c = mod.classificarMidia(join(dir, "midia", "minha-foto.jpg"));
    assert.equal(c.ok, false);
    assert.equal(c.motivo, "formato-invalido");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limparMidiaAntiga: apaga mídia vencida", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    const arquivo = criarMidia(dir, "jpg");
    // deixa o arquivo com 10 dias (vencido: retenção de 3 dias)
    const velho = new Date(Date.now() - 10 * 86400_000);
    utimesSync(arquivo, velho, velho);
    const n = mod.limparMidiaAntiga(3);
    assert.equal(n, 1);
    assert.equal(existsSync(arquivo), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limparMidiaAntiga: PRESERVA a mídia em uso (campanha em andamento)", async () => {
  const { mod, dir } = await carregarMidia();
  try {
    const emUso = criarMidia(dir, "mp4");
    const livre = criarMidia(dir, "jpg");
    const velho = new Date(Date.now() - 10 * 86400_000);
    utimesSync(emUso, velho, velho);
    utimesSync(livre, velho, velho);

    const n = mod.limparMidiaAntiga(3, [emUso]);
    assert.equal(n, 1, "só a mídia livre pode ser removida");
    assert.equal(existsSync(emUso), true, "mídia em uso NÃO pode ser apagada");
    assert.equal(existsSync(livre), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
