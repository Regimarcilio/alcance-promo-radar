#!/usr/bin/env npx tsx
/**
 * ML OAuth Helper — fluxo Server-Side automatizado
 *
 * Uso:
 *   npx tsx scripts/ml-oauth.ts
 *
 * Requisitos:
 *   - App criado em https://developers.mercadolivre.com.br/devcenter/create-app
 *   - Redirect URI cadastrado: http://localhost:3000/callback
 *   - Client ID e Secret Key em mãos
 *
 * O script:
 *   1. Pergunta Client ID e Secret Key (input oculto)
 *   2. Sobe server HTTP em localhost:3000/callback
 *   3. Abre navegador na URL de autorização
 *   4. Captura o `code` do redirect
 *   4. Faz POST em /oauth/token e mostra access_token + refresh_token
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { URLSearchParams } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const PORT = Number(process.env.PORT) || 3001;  // default 3001 para evitar conflito com Grafana
const CALLBACK_PATH = "/callback";
const AUTH_URL = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const STATE = "ml-oauth-" + Date.now();

async function ask(question: string, hide = false): Promise<string> {
  const rl = readline.createInterface({ input, output });
  if (hide) {
    // hack simples: não ecoa no terminal (funciona na maioria)
    process.stdin.setRawMode?.(true);
  }
  const ans = await rl.question(question);
  rl.close();
  if (hide) process.stdin.setRawMode?.(false);
  console.log(hide ? "" : "");
  return ans.trim();
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", reject);
    // xdg-open/open/start retornam imediatamente, não dá para esperar "close"
    setTimeout(resolve, 500);
  });
}

function waitForCode(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.startsWith(path)) {
        const url = new URL(req.url, `http://localhost:${port}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <html><body style="font-family:system-ui;padding:2rem;text-align:center">
              <h2>✅ Autorização recebida!</h2>
              <p>Pode fechar esta janela e voltar ao terminal.</p>
              <script>setTimeout(()=>window.close(),2000)</script>
            </body></html>
          `);
          server.close();
          resolve(code);
        } else if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <html><body style="font-family:system-ui;padding:2rem;text-align:center;color:#c00">
              <h2>❌ Erro na autorização</h2>
              <p>${error}: ${errorDesc || "desconhecido"}</p>
            </body></html>
          `);
          server.close();
          reject(new Error(`${error}: ${errorDesc}`));
        } else {
          res.writeHead(404);
          res.end("Not found");
          server.close();
          reject(new Error("Callback sem code nem error"));
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, () => {
      console.log(`\n🌐 Server ouvindo em http://localhost:${port}${path}`);
    });

    server.on("error", (e) => reject(e));
  });
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; user_id: number }> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data as { access_token: string; refresh_token: string; expires_in: number; user_id: number };
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("   ML OAuth Helper — Server-Side Flow");
  console.log("═══════════════════════════════════════════\n");

  console.log("Pré-requisitos:");
  console.log("  1. App criado em https://developers.mercadolivre.com.br/devcenter/create-app");
  console.log(`  2. Redirect URI cadastrado: http://localhost:${PORT}/callback`);
  console.log("  3. Usuário admin da conta ML (não colaborador)\n");

  const clientId = await ask("Client ID (App ID): ");
  if (!clientId) throw new Error("Client ID obrigatório");

  const clientSecret = await ask("Secret Key (Chave secreta): ", true);
  if (!clientSecret) throw new Error("Secret Key obrigatória");

  const redirectUri = `http://localhost:${PORT}${CALLBACK_PATH}`;

  // 1. Monta URL de autorização
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: STATE,
  });
  const authUrl = `${AUTH_URL}?${authParams.toString()}`;

  console.log("\n📋 Abrindo navegador para autorização...");
  console.log(`   URL: ${authUrl}\n`);

  // 2. Inicia server ANTES de abrir navegador (race condition)
  const codePromise = waitForCode(PORT, CALLBACK_PATH);

  // 3. Abre navegador
  await openBrowser(authUrl);

  // 4. Aguarda callback
  console.log("⏳ Aguardando você clicar 'Permitir' no navegador...");
  const code = await codePromise;
  console.log(`\n✅ Code recebido: ${code.slice(0, 20)}...`);

  // 5. Troca por tokens
  console.log("🔄 Trocando code por access_token + refresh_token...\n");
  const tokens = await exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);

  // 6. Mostra resultado
  console.log("═══════════════════════════════════════════");
  console.log("   SUCESSO — Tokens obtidos");
  console.log("═══════════════════════════════════════════\n");

  console.log("📋 COPIE ESTES VALORES:\n");
  console.log(`ML_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`ML_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`ML_TOKEN_EXPIRES_IN=${tokens.expires_in}  # segundos (≈6h)`);
  console.log(`ML_USER_ID=${tokens.user_id}\n`);

  console.log("📝 Próximos passos:");
  console.log("  1. Adicione ao seu .env (NUNCA commite):");
  console.log(`     ML_ACCESS_TOKEN=${tokens.access_token}`);
  console.log("  2. Guarde o REFRESH_TOKEN em local seguro (password manager, vault)");
  console.log("  3. Quando o access_token expirar (6h), use o refresh_token:");
  console.log("     curl -X POST 'https://api.mercadolibre.com/oauth/token' \\");
  console.log("       -d 'grant_type=refresh_token' \\");
  console.log(`       -d 'client_id=${clientId}' \\`);
  console.log("       -d 'client_secret=SUA_SECRET_KEY' \\");
  console.log(`       -d 'refresh_token=${tokens.refresh_token}'`);
  console.log("\n  4. O novo refresh_token retornado substitui o anterior (uso único).\n");
}

main().catch((e) => {
  console.error("\n❌ Erro:", e.message);
  process.exit(1);
});