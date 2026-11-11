/** Testes da verificação de celular por WhatsApp (código de 10 posições). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gerarCodigo,
  hashCodigo,
  mascarTelefone,
  normalizarTelefone,
  precisaCodigo,
  salvarVerificacao,
  telefoneValido,
  validarCodigo,
} from "./verificacao.js";

function dirTemporario(usuarios: unknown[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "alcance-verif-"));
  writeFileSync(join(dir, "auth-users.json"), JSON.stringify({ usuarios }));
  return dir;
}

test("código: 10 posições alfanuméricas (sem 0/O, 1/I)", () => {
  for (let i = 0; i < 50; i++) {
    const c = gerarCodigo();
    assert.equal(c.length, 10);
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  }
});

test("telefone: valida e normaliza (11 dígitos BR ganham 55)", () => {
  assert.equal(telefoneValido("11999999999"), true);
  assert.equal(telefoneValido("5511999999999"), true);
  assert.equal(telefoneValido("123"), false);
  assert.equal(telefoneValido(""), false);
  assert.equal(normalizarTelefone("(11) 99999-9999"), "5511999999999");
  assert.equal(normalizarTelefone("5511999999999"), "5511999999999");
});

test("máscara do telefone: nunca mostra o número inteiro", () => {
  const m = mascarTelefone("5511999999999");
  assert.ok(!m.includes("9999999999"), `mascara vazou o número: ${m}`);
  assert.match(m, /^55•••9999$/);
});

test("hash do código: determinístico e não é o código", () => {
  const h = hashCodigo("u1", "ABC234XYZ1");
  assert.equal(h, hashCodigo("u1", "ABC234XYZ1"));
  assert.notEqual(h, hashCodigo("u2", "ABC234XYZ1"));
  assert.equal(h.length, 64);
  assert.ok(!h.includes("ABC234"));
});

test("validação: código certo ativa o celular; errado conta tentativa", () => {
  const dir = dirTemporario([
    { id: "u1", usuario: "admin", hash: "x", papel: "admin", criadoEm: "2026-01-01" },
  ]);
  try {
    const codigo = "ABCD2345EF";
    const u = { id: "u1", usuario: "admin", telefone: "5511999999999" };
    salvarVerificacao(dir, "u1", u.telefone, {
      hash: hashCodigo("u1", codigo),
      expiraEm: new Date(Date.now() + 60000).toISOString(),
      tentativas: 0,
    });
    const usuario = { id: "u1", telefone: u.telefone, verificacao: {
      hash: hashCodigo("u1", codigo),
      expiraEm: new Date(Date.now() + 60000).toISOString(),
      tentativas: 0,
    } };

    // errado
    const r1 = validarCodigo(usuario, "XXXX9999XX", dir);
    assert.equal(r1.ok, false);
    assert.equal(r1.ok === false && r1.motivo, "invalido");

    // certo
    const r2 = validarCodigo(usuario, codigo, dir);
    assert.equal(r2.ok, true);

    // persistiu a confirmação
    const salvo = JSON.parse(readFileSync(join(dir, "auth-users.json"), "utf8"));
    assert.ok(salvo.usuarios[0].verificacao.verificadoEm);
    assert.equal(precisaCodigo(salvo.usuarios[0]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validação: código expirado é recusado", () => {
  const dir = dirTemporario();
  try {
    const usuario = { id: "u1", telefone: "5511999999999", verificacao: {
      hash: hashCodigo("u1", "ABCD2345EF"),
      expiraEm: new Date(Date.now() - 1000).toISOString(),
      tentativas: 0,
    } };
    const r = validarCodigo(usuario, "ABCD2345EF", dir);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.motivo, "expirado");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validação: trava depois de 5 tentativas erradas", () => {
  const dir = dirTemporario();
  try {
    const usuario = { id: "u1", telefone: "5511999999999", verificacao: {
      hash: hashCodigo("u1", "ABCD2345EF"),
      expiraEm: new Date(Date.now() + 60000).toISOString(),
      tentativas: 0,
    } };
    let ultimo: any = null;
    for (let i = 0; i < 5; i++) ultimo = validarCodigo(usuario, "ERRADO0000", dir);
    assert.equal(ultimo.ok, false);
    assert.equal(ultimo.ok === false && ultimo.motivo, "tentativas");
    // mesmo com o código certo agora, está travado
    const r = validarCodigo(usuario, "ABCD2345EF", dir);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.motivo, "tentativas");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("precisaCodigo: usuário sem celular não é bloqueado", () => {
  assert.equal(precisaCodigo({}), false);
  assert.equal(precisaCodigo({ telefone: "5511999999999" }), true);
  assert.equal(
    precisaCodigo({ telefone: "5511999999999", verificacao: { verificadoEm: "2026-01-01" } }),
    false,
  );
});
