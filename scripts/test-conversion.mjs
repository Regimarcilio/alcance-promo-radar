#!/usr/bin/env node
/**
 * Script de teste rápido de conversão de links
 * Testa se um link de produto é convertido corretamente para afiliado
 * 
 * Uso:
 *   COOKIE_ML='_mldataSessionId=XXX' node scripts/test-conversion.mjs <URL_ML>
 * 
 * Exemplo:
 *   COOKIE_ML='_mldataSessionId=abc123' node scripts/test-conversion.mjs "https://produto.mercadolivre.com.br/MLB-27693851"
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(raiz, "data");
const contasFile = join(dataDir, "contas.json");

const [,, ...args] = process.argv;
const urlProduto = process.env.TEST_URL || args[0] || "https://produto.mercadolivre.com.br/MLB-27693851";
const cookieML = process.env.COOKIE_ML || process._cookie;

console.log(`
╔══════════════════════════════════════════════════════════╗
║   TESTE DE CONVERSÃO ML                                   ║
╠══════════════════════════════════════════════════════════╣
║  Produto: ${urlProduto.substring(0, 70)}...  ║
║  Cookie: ${cookieML ? "CONFIGURADO ✅" : "NÃO CONFIGURADO ❌"} ║
╚══════════════════════════════════════════════════════════╝
`);

async function testarConversao() {
  if (!cookieML) {
    console.log("ℹ️  Defina COOKIE_ML e execute novamente");
    console.log("   Exemplo: COOKIE_ML='_mldataSessionId=xxx' node scripts/test-conversion.mjs");
    process.exit(1);
  }

  // Atualiza cookie
  const fs = await import("node:fs");
  try {
    const raw = fs.readFileSync(contasFile, "utf8");
    const json = JSON.parse(raw);
    
    for (const conta of json.contas) {
      if (conta.tag) {
        const existingCookies = (conta.cookie || "").split(";").map(c => c.trim()).filter(Boolean);
        const cookiesMap = new Map();
        for (const c of existingCookies) {
          const [k] = c.split("=");
          cookiesMap.set(k.toLowerCase(), c);
        }
        cookiesMap.set("_mldataSessionId", cookieML);
        conta.cookie = Array.from(cookiesMap.values()).join("; ");
      }
    }
    fs.writeFileSync(contasFile, JSON.stringify(json, null, 2) + "\n");
    console.log("✅ Cookie atualizado");
  } catch (e) {
    console.log("⚠️  Não foi possível atualizar cookie:", e.message);
  }

  // Testa conversão via API local
  console.log("\n🔄 Testando conversão via /api/colar...");
  
  const authResp = await fetch("http://localhost:8091/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: "admin", senha: "teste1234567" }),
  });
  
  if (!authResp.ok) {
    console.log("❌ Falha no login:", authResp.status);
    process.exit(1);
  }

  const cookies = authResp.headers.get("set-cookie") || "";
  
  const colarResp = await fetch("http://localhost:8091/api/colar", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Cookie": cookies
    },
    body: JSON.stringify({ url: urlProduto }),
  });

  const resultado = await colarResp.json();
  
  console.log("\n📊 RESULTADO:");
  console.log(JSON.stringify(resultado, null, 2));
  
  if (resultado.ok && resultado.link) {
    console.log("\n✅ CONVERSÃO COM SUCESSO!");
    console.log(`   Link afiliado: ${resultado.link}`);
  } else if (resultado.ok) {
    console.log(`\n⚠️  ${resultado.avisoLink || "Conversão sem sucesso"}`);
    console.log("   Verifique o cookie ML no hub de afiliados");
  } else {
    console.log("\n❌ ERRO na conversão");
  }
}

testarConversao().catch(e => {
  console.error("❌ Erro:", e.message);
  process.exit(1);
});