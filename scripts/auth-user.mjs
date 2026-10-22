#!/usr/bin/env node
/**
 * Cria/atualiza um usuário do painel Alcance.
 *
 * Uso:
 *   npm run auth:user -- admin --telefone 5511999999999
 *   AUTH_PASSWORD='senha-forte' npm run auth:user -- admin --telefone 5511999999999
 *
 * O celular (WhatsApp) é obrigatório: o sistema envia para ele um código
 * alfanumérico de 10 posições, pedido no PRIMEIRO login (2FA de ativação).
 *
 * O hash scrypt é gravado em data/auth-users.json (modo 0600).
 * Nunca imprime a senha nem o hash.
 */
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb } from "node:crypto";
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

  // ---------- celular (WhatsApp) ----------
  // aceita: --telefone 5511999999999 | --telefone=5511999999999 | AUTH_TELEFONE=...
  let telefone = "";
  const args = process.argv.slice(2);
  const iTel = args.findIndex((a) => a === "--telefone" || a.startsWith("--telefone="));
  if (iTel >= 0) {
    const bruto = args[iTel];
    telefone = bruto.includes("=") ? bruto.split("=").slice(1).join("=") : args[iTel + 1] ?? "";
  }
  telefone = String(process.env.AUTH_TELEFONE ?? telefone ?? "").trim();
  if (!telefone) {
    console.error(
      "Informe o WhatsApp do usuário: --telefone 5511999999999 (ou AUTH_TELEFONE=...).",
    );
    process.exit(1);
  }
  const digitos = String(telefone).replace(/\D/g, "");
  const telFinal = digitos.length === 11 ? `55${digitos}` : digitos;
  if (telFinal.length < 10 || telFinal.length > 15) {
    console.error("Telefone inválido: use DDI + DDD + número (ex.: 5511999999999).");
    process.exit(1);
  }

  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
  // ALCANCE_DATA_DIR permite criar credencial em diretório temporário (smoke/CI).
  const dataDir = process.env.ALCANCE_DATA_DIR || join(raiz, "data");
  const arquivo = join(dataDir, "auth-users.json");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const usuarios = lerArquivo(arquivo);
  const existente = usuarios.find((u) => u.usuario.toLowerCase() === usuario);
  const hash = await hashSenha(senha);
  const agora = new Date().toISOString();

  let alvo;
  if (existente) {
    existente.hash = hash;
    existente.desativado = false;
    existente.atualizadoEm = agora;
    alvo = existente;
    console.log(`Senha atualizada para "${usuario}".`);
  } else {
    alvo = {
      id: randomUUID(),
      usuario,
      hash,
      papel: "admin",
      criadoEm: agora,
    };
    usuarios.push(alvo);
    console.log(`Usuário "${usuario}" criado.`);
  }

  // celular + verificação pendente
  const codigo = gerarCodigo();
  alvo.telefone = telFinal;
  alvo.verificacao = {
    hash: createHash("sha256").update(`${alvo.id}:${codigo}`).digest("hex"),
    expiraEm: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    tentativas: 0,
  };

  writeFileSync(arquivo, JSON.stringify({ usuarios }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(arquivo, 0o600);
  console.log(`Credencial salva em ${arquivo} (modo 0600).`);

  // envia o código para o WhatsApp cadastrado
  const enviado = await enviarCodigo(telFinal, codigo, usuario);
  if (enviado.ok) {
    console.log(`Código de verificação enviado para o WhatsApp ${mascarar(telFinal)}.`);
    console.log("No primeiro login o painel pede esse código (10 posições).");
  } else {
    console.error(`⚠️  Não foi possível enviar o código: ${enviado.erro}`);
    console.error("   O usuário foi criado, mas o celular precisa ser confirmado antes do 1º login.");
    console.error("   Reexecute o comando depois de a Evolution estar no ar.");
  }
  console.log("Reinicie o painel para garantir a leitura da nova credencial.");
}

/** Código alfanumérico de 10 posições (sem 0/O e 1/I). */
function gerarCodigo() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alfabeto[randomInt(0, alfabeto.length)];
  return s;
}

function mascarar(tel) {
  const d = String(tel).replace(/\D/g, "");
  return d.length < 4 ? "••••" : `${d.slice(0, 2)}•••${d.slice(-4)}`;
}

/** Envia o código por WhatsApp (Evolution). */
async function enviarCodigo(telefone, codigo, usuario) {
  const base = (process.env.EVO_URL ?? "").replace(/\/$/, "");
  const key = process.env.EVO_KEY ?? "";
  const inst = process.env.EVO_INSTANCE ?? "radar-piloto";
  if (!base || !key) return { ok: false, erro: "Evolution não configurada (EVO_URL/EVO_KEY)" };
  const texto = [
    `🔐 *Alcance — verificação de celular*`,
    ``,
    `Olá, ${usuario}!`,
    `Seu código de acesso é:`,
    ``,
    `\`${codigo}\``,
    ``,
    `Ele vale por 10 minutos. Se não foi você, ignore esta mensagem.`,
  ].join("\n");
  try {
    const r = await fetch(`${base}/message/sendText/${inst}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ number: `${telefone}@s.whatsapp.net`, text: texto }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, erro: `Evolution ${r.status}${t ? `: ${t.slice(0, 120)}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: String(e?.message ?? e) };
  }
}

principal().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
