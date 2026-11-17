#!/usr/bin/env node
/**
 * Script de manutenção de cookie ML
 * 
 * Uso:
 *   COOKIE_ML='_mldataSessionId=xxx' node scripts/maintain-cookie.mjs
 * 
 * Este script:
 * 1. Atualiza o cookie em data/contas.json
 * 2. Verifica se consegue gerar link afiliado
 * 3. Reinicia o servidor manager (opcional)
 * 
 * Para obter cookie ML:
 *   1. Acesse https://www.mercadolivre.com.br afiliados.hub
 *   2. Abra DevTools (F12)
 *   3. Aba Application > Cookies > https://www.mercadolivre.com.br
 *   4. Copie o valor de _mldataSessionId
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(raiz, "data");
const arquivo = join(dataDir, "contas.json");

const cookie = process.env.COOKIE_ML?.trim();
if (!cookie) {
  console.error("❌ Use COOKIE_ML='_mldataSessionId=xxx'");
  process.exit(1);
}

try {
  const raw = readFileSync(arquivo, "utf8");
  const json = JSON.parse(raw);
  
  if (!json.contas || !Array.isArray(json.contas)) {
    console.error("❌ Estrutura de contas inválida");
    process.exit(1);
  }
  
  console.log(`🔧 Atualizando cookie em ${json.contas.length} contas...`);
  
  // Atualiza cookie em todas as contas
  let atualizou = 0;
  for (const conta of json.contas) {
    if (conta.tag) {
      // Mantém cookies existentes, só atualiza o _mldataSessionId
      const existingCookies = (conta.cookie || '').split(';').map(c => c.trim()).filter(Boolean);
      const cookiesDict = new Map();
      
      // Adiciona cookies existentes
      for (const c of existingCookies) {
        const [k] = c.split('=');
        cookiesDict.set(k.toLowerCase(), c);
      }
      
      // Atualiza/replace mldataSessionId
      const [key] = cookie.split('=');
      cookiesDict.set(key.toLowerCase(), cookie.trim());
      
      conta.cookie = Array.from(cookiesDict.values()).join('; ');
      atualizou++;
    }
  }
  
  // Escrita segura
  const tmp = `${arquivo}.${Date.now()}.tmp`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n");
  renameSync(tmp, arquivo);
  console.log(`✅ Cookie atualizado para ${atualizou} contas`);
  console.log(`   Tag afiliado: ${json.contas[0]?.tag}`);
  
  // Verifica se o sistema reconhece o cookie
  console.log("\n📋 Verificando sistema...");
  try {
    const resp = await fetch('https://www.mercadolivre.com.br/gz/cart/v2/info/header', {
      headers: { 'user-agent': 'Mozilla/5.0' },
      cookie: cookie
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log(`   Sessão ativa: ${data?.user?.id ? '✅' : '⚠️'}`);
    }
  } catch (e) {
    console.log(`   Aviso: não foi possível verificar sessão (${e.message})`);
  }
  
  console.log("\n📌 Próximos passos:");
  console.log("   1. Recarregue o painel ou aguarde renovação automática");
  console.log("   2. Use /api/colar para converter links");
  console.log("\n⏰ Lembre-se: cookie expira em ~30 minutos!");
  
} catch (e) {
  console.error("❌ Erro:", e.message);
  process.exit(1);
}