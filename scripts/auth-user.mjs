#!/usr/bin/env node
/**
 * Cria/atualiza um usuário do painel Alcance.
 *
 * Uso:
 *   npm run auth:user -- admin
 *   AUTH_PASSWORD='senha-forte' npm run auth:user -- admin
 *
 * O hash scrypt é gravado em data/auth-users.json (modo 0600).
 * Nunca imprime a senha nem o hash.
 */
import { randomBytes, randomUUID, scrypt as scryptCb } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 32768;
const R = 8;
const P = 1;
const MAXMEM = 64 * 1024 * 1024;
const KEYLEN = 64;

function hashSenha(senha) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scryptCb(senha, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, key) => {
      if (err) return reject(err);
      resolve(
        ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$"),
      );
    });
  });
}

function lerSenha(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Sem TTY. Use AUTH_PASSWORD=... npm run auth:user -- <usuario>"));
      return;
    }
    process.stdout.write(prompt);
    let senha = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          limpar();
          process.stdout.write("\n");
          resolve(senha);
          return;
        }
        if (ch === "\u0003") {
          limpar();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (senha) {
            senha = senha.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        senha += ch;
        process.stdout.write("*");
      }
    };
    const limpar = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

function lerArquivo(p) {
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const lista = Array.isArray(raw) ? raw : Array.isArray(raw?.usuarios) ? raw.usuarios : [];
    return lista.filter((u) => u && typeof u.usuario === "string" && typeof u.hash === "string");
  } catch {
    return [];
  }
}

async function principal() {
  const usuario = String(process.argv[2] ?? "admin").trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}$/.test(usuario)) {
    console.error("Usuário inválido. Use 2-64 caracteres: a-z, 0-9, ponto, hífen ou underscore.");
    process.exit(1);
  }

  let senha = process.env.AUTH_PASSWORD ?? "";
  if (!senha) {
    senha = await lerSenha(`Senha para "${usuario}": `);
    const confirma = await lerSenha("Confirme a senha: ");
    if (senha !== confirma) {
      console.error("As senhas não conferem.");
      process.exit(1);
    }
  }
  if (senha.length < 8) {
    console.error("A senha precisa ter pelo menos 8 caracteres.");
    process.exit(1);
  }
  if (senha.length > 1024) {
    console.error("Senha longa demais.");
    process.exit(1);
  }

  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = join(raiz, "data");
  const arquivo = join(dataDir, "auth-users.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const usuarios = lerArquivo(arquivo);
  const existente = usuarios.find((u) => u.usuario.toLowerCase() === usuario);
  const hash = await hashSenha(senha);
  const agora = new Date().toISOString();

  if (existente) {
    existente.hash = hash;
    existente.desativado = false;
    existente.atualizadoEm = agora;
    console.log(`Senha atualizada para "${usuario}".`);
  } else {
    usuarios.push({
      id: randomUUID(),
      usuario,
      hash,
      papel: "admin",
      criadoEm: agora,
    });
    console.log(`Usuário "${usuario}" criado.`);
  }

  writeFileSync(arquivo, JSON.stringify({ usuarios }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(arquivo, 0o600);
  console.log(`Credencial salva em ${arquivo} (modo 0600).`);
  console.log("Reinicie o painel para garantir a leitura da nova credencial.");
}

principal().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
