import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.SESSION_SECRET = "teste-".padEnd(48, "x");
delete process.env.AUTH_COOKIE_SECURE;

const auth = await import("./auth.js");

const dir = mkdtempSync(join(tmpdir(), "alcance-auth-"));
writeFileSync(
  join(dir, "auth-users.json"),
  JSON.stringify({
    usuarios: [
      {
        id: "u1",
        usuario: "admin",
        hash: "scrypt$32768$8$1$AAAA$AAAA",
        papel: "admin",
        criadoEm: new Date().toISOString(),
      },
    ],
  }),
);
auth.configurarAuth(dir);

after(() => rmSync(dir, { recursive: true, force: true }));

test("hash scrypt: aceita a senha correta e rejeita a errada", async () => {
  const hash = await auth.hashSenha("Senha!123");
  assert.equal(await auth.verificarSenha("Senha!123", hash), true);
  assert.equal(await auth.verificarSenha("senha!123", hash), false);
  assert.equal(await auth.verificarSenha("Senha!123", "lixo"), false);
});

test("iguais: compara strings em tempo constante", () => {
  assert.equal(auth.iguais("abc", "abc"), true);
  assert.equal(auth.iguais("abc", "abd"), false);
  assert.equal(auth.iguais("abc", 123), false);
});

test("sessão: cria, valida, rejeita assinatura adulterada e encerra", () => {
  const { valor } = auth.criarSessao(
    { id: "u1", usuario: "admin", hash: "x", papel: "admin", criadoEm: "" },
    "127.0.0.1",
    "teste",
  );
  const ok = auth.validarSessao(valor);
  assert.equal(ok?.usuario.usuario, "admin");
  assert.ok(ok?.sid);

  const [sid, assinatura] = valor.split(".");
  const adulterada = assinatura.slice(0, -1) + (assinatura.endsWith("A") ? "B" : "A");
  assert.equal(auth.validarSessao(sid + "." + adulterada), null);

  auth.encerrarSessao(ok!.sid);
  assert.equal(auth.validarSessao(valor), null);
});

test("cookie: HttpOnly, SameSite=Strict, Path e Max-Age", () => {
  const c = auth.cookieSessao("sid.assinatura", 28800);
  assert.match(c, /^alcance_sid=sid\.assinatura;/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=28800/);
  assert.doesNotMatch(c, /Secure/);
  assert.match(auth.cookieExpirado(), /Max-Age=0/);
});

test("rate-limit: bloqueia a 6ª tentativa e libera no clear", () => {
  const ip = "192.0.2.77";
  for (let i = 0; i < 5; i += 1) {
    assert.equal(auth.checarLimite(ip).ok, true);
    auth.registrarTentativa(ip);
  }
  const bloqueado = auth.checarLimite(ip);
  assert.equal(bloqueado.ok, false);
  assert.ok(bloqueado.retryAfter > 0);
  auth.limparLimite(ip);
  assert.equal(auth.checarLimite(ip).ok, true);
});

test("auditoria: mascara IP e grava JSONL", () => {
  auth.auditar("teste", {
    usuario: "admin",
    ip: "191.0.2.3",
    ua: "node-test",
    detalhe: "ok",
  });
  const linha = readFileSync(join(dir, "auth-audit.log"), "utf8").trim();
  assert.match(linha, /"evento":"teste"/);
  assert.match(linha, /"ip":"191\.0\.2\.0\/24"/);
  assert.doesNotMatch(linha, /191\.0\.2\.3/);
});

test("validação de configuração: usuário ativo + segredo", () => {
  assert.doesNotThrow(() => auth.validarConfigAuth());
});
