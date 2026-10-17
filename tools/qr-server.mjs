/**
 * Ferramenta de pareamento: serve uma página que mostra o QR da instância
 * Evolution e o atualiza sozinho (~12s). A EVO_KEY fica server-side.
 * Uso:  node tools/qr-server.mjs   →  abra http://localhost:8097
 */
import http from "node:http";
import "dotenv/config";

const EVO = process.env.EVO_URL || "http://localhost:8082";
const KEY = process.env.EVO_KEY || "";
const INST = process.env.EVO_INSTANCE || "radar-piloto";
const PORT = Number(process.env.QR_PORT || 8097);

const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>QR — ${INST}</title>
<style>body{background:#0b141a;color:#e9edef;font-family:system-ui,sans-serif;text-align:center;padding:24px}
img{width:320px;height:320px;image-rendering:pixelated;background:#fff;padding:10px;border-radius:12px}
.ok{box-shadow:0 0 0 3px #00a884} #s{margin-top:12px;color:#8696a0;font-size:14px}
h2{margin-bottom:14px} b{color:#00a884}</style></head><body>
<h2>Parear WhatsApp — <b>${INST}</b></h2>
<img id="q" alt="QR">
<div id="s">carregando…</div>
<script>
async function tick(){
  try{
    const j=await (await fetch('/qr')).json();
    if(j.erro){document.getElementById('s').textContent='erro: '+j.erro;return;}
    if(j.state==='open'){
      const q=document.getElementById('q');q.classList.add('ok');
      document.getElementById('s').innerHTML='✅ <b>CONECTADO!</b> Pode fechar esta página.';
      return;
    }
    if(j.base64)document.getElementById('q').src=j.base64;
    document.getElementById('s').textContent='atualizado '+new Date().toLocaleTimeString('pt-BR')+' • estado: '+(j.state||'?');
  }catch(e){document.getElementById('s').textContent='erro: '+e.message;}
}
tick();setInterval(tick,12000);
</script></body></html>`;

http.createServer(async (req, res) => {
  if (req.url === "/qr") {
    try {
      const j = await (await fetch(`${EVO}/instance/connect/${INST}`, { headers: { apikey: KEY } })).json();
      const st = await (await fetch(`${EVO}/instance/connectionState/${INST}`, { headers: { apikey: KEY } })).json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ base64: j.base64, count: j.count, state: st?.instance?.state }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ erro: String(e?.message ?? e) }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(PORT, "0.0.0.0", () => console.log(`QR em http://localhost:${PORT} (instância ${INST})`));
