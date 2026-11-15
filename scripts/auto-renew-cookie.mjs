#!/usr/bin/env node
/**
 * Script de renovação automática de cookie ML
 * 
 * Uso:
 *   node scripts/auto-renew-cookie.mjs
 * 
 * Funciona capturando cookie de navegação do browser
 * usando puppeteer-stealth ou manualmente via DevTools
 * 
 * Alternativa: cron job que roda a cada 25 minutos
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.ALCANCE_DATA_DIR || join(raiz, "data");
const contasFile = join(dataDir, "contas.json");

console.log(`
╔══════════════════════════════════════════════════════════╗
║   RENOVAÇÃO AUTOMÁTICA DE COOKIE ML                      ║
╠══════════════════════════════════════════════════════════╣
║  INSTRUÇÕES PARA O USUÁRIO:                             ║
║                                                          ║
║  1. Abra o Chrome/Brave em modo de desenvolvimento      ║
║  2. Acesse: https://www.mercadolivre.com.br/afiliados   ║
║  3. Faça login (2FA pode ser ignorado se já autenticado) ║
║  4. Abra DevTools (F12) → Aba "Application"             ║
║  5. Cookies → https://www.mercadolivre.com.br           ║
║  6. Copie o valor de "_mldataSessionId"                 ║
║                                                          ║
║  7. Rode o comando:                                        ║
║     COOKIE_ML='_mldataSessionId=XXX' node scripts/maintain-cookie.mjs ║
║                                                          ║
║  ⚠️  COOKIE EXPIRA A CADA 25-30 MINUTOS!                 ║
║  ⚠️  AGENDAR: */25 * * * * (cron)                       ║
╚══════════════════════════════════════════════════════════╝
`);

// Função de renovação manual (chamada externa)
export async function renovarCookie(cookieValue) {
  const fs = await import("node:fs");
  
  if (!cookieValue || typeof cookieValue !== "string") {
    console.error("❌ Cookie inválido");
    return false;
  }

  try {
    const raw = fs.readFileSync(contasFile, "utf8");
    const json = JSON.parse(raw);
    
    if (!Array.isArray(json.contas)) {
      console.error("❌ Estrutura de contas inválida");
      return false;
    }

    const novoCookie = `_mldataSessionId=${cookieValue}`;
    let atualizou = 0;

    for (const conta of json.contas) {
      if (conta.tag) {
        const existingCookies = (conta.cookie || "").split(";").map(c => c.trim()).filter(Boolean);
        const cookiesMap = new Map();
        
        for (const c of existingCookies) {
          const [k] = c.split("=");
          cookiesMap.set(k.toLowerCase(), c);
        }
        
        cookiesMap.set("_mldataSessionId", novoCookie);
        conta.cookie = Array.from(cookiesMap.values()).join("; ");
        atualizou++;
      }
    }

    fs.writeFileSync(contasFile, JSON.stringify(json, null, 2) + "\n");
    console.log(`✅ Cookie renovado para ${atualizou} contas`);
    return true;

  } catch (e) {
    console.error("❌ Erro:", e.message);
    return false;
  }
}

// Exporta para uso como módulo
export default renovarCookie;