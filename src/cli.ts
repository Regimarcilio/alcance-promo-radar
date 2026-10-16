import "dotenv/config";
import catsJson from "./categorias.json" with { type: "json" };
import { FiltrosSchema } from "./hunter/schema.js";
import { hunt } from "./hunter/service.js";
import { rankear } from "./scorer.js";
import { formatar, headlinePara } from "./wa/formatter.js";
import { jaEnviado, registrarEnvio } from "./store/dedup.js";
import { enviarParaGrupo } from "./wa/dispatch.js";
import { runAuto, filaList, filaApprove } from "./jobs/auto.js";

const CATS: { id: string; name: string }[] = catsJson as { id: string; name: string }[];

const cmd = process.argv[2] ?? "ajuda";
const get = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] ?? d : d;
};

if (cmd === "categorias:list") {
  console.log(CATS.map((c) => `${c.id} | ${c.name}`).join("\n"));
} else if (cmd === "hunter:buscar") {
  const filtros = FiltrosSchema.parse({
    category: get("category", "MLB3937"),
    sub: get("sub", ""),
    q: get("q", ""),
    descontoMin: Number(get("desconto-min", "30")),
    teto: Number(get("teto", "500")),
    limite: Number(get("limite", "3")),
  });
  const dryRun = process.argv.includes("--dry-run");
  const catName = CATS.find((c) => c.id === filtros.category)?.name ?? filtros.category;
  const { url, candidatos, mock } = await hunt(filtros);
  console.log(`busca: ${url} ${mock ? "(MOCK piloto — API 403/offline)" : "(LIVE)"}`);
  console.log(`candidatos: ${candidatos.length}`);
  const top = rankear(candidatos, 0, filtros.descontoMin).slice(0, filtros.limite);
  for (const o of top) {
    if (jaEnviado(o.mlbId, o.precoAtual, o.cupom)) {
      console.log(`- PULADO DUPLICADO_7D ${o.mlbId} ${o.titulo}`);
      continue;
    }
    const msg = formatar({ ...headlinePara(o, catName) });
    console.log(`\n### score=${o.score} ${o.selo} | ${o.motivo}\n${o.titulo}\n${msg}\n`);
    if (process.argv.includes("--enviar")) {
      const r = await enviarParaGrupo({
        grupo: process.env.GRUPO_TESTE ?? "grupo-teste",
        imagem: o.imagem, legenda: msg, dryRun,
      });
      console.log(`enviado: ${r.messageId} dryRun=${r.dryRun}`);
      if (!r.dryRun) registrarEnvio(o.mlbId, o.precoAtual, o.cupom);
    }
  }
} else if (cmd === "hunter:auto") {
  // Uma passada do caçador — feita para cron: */120 8-22 * * * cd ... && npm start -- hunter:auto ...
  const filtros = FiltrosSchema.parse({
    category: get("category", "MLB3937"),
    sub: get("sub", ""),
    q: get("q", ""),
    descontoMin: Number(get("desconto-min", "30")),
    teto: Number(get("teto", "500")),
    limite: Number(get("limite", "3")),
  });
  const out = await runAuto({
    ...filtros,
    corte: Number(get("corte", "0")),
    live: process.argv.includes("--live"),
    conta: get("conta", "") || undefined,
    grupo: get("grupo", "") || undefined,
  });
  console.log(out.join("\n"));
} else if (cmd === "fila:list") {
  console.log(filaList());
} else if (cmd === "fila:approve") {
  const mlbId = process.argv[3] ?? "";
  console.log(await filaApprove(mlbId, process.argv.includes("--live")));
} else if (cmd === "evo:qr") {
  const { baixarQr, engine } = await import("./wa/evolution-go.js");
  const arq = get("save", "qr.png");
  console.log(`engine=${engine()} — buscando QR... (crie a instância antes via /instance/create)`);
  console.log(`QR salvo em ${await baixarQr(arq)} — escaneie em <60s (WhatsApp → Aparelhos conectados)`);
} else if (cmd === "evo:status") {
  const { statusConexao, engine } = await import("./wa/evolution-go.js");
  console.log(`engine=${engine()} — ${await statusConexao()}`);
} else if (cmd === "cesta:importar") {
  // Importa docs/10-cesta-semente.md (tabela | categoria | url | pix | de | titulo | foto |)
  const { readFileSync } = await import("node:fs");
  const { salvarCesta } = await import("./ml/piloto.js");
  const arq = process.argv[3] ?? "docs/10-cesta-semente.md";
  const linhas = readFileSync(arq, "utf8").split("\n");
  const porCat = new Map<string, string[]>();
  let emComentario = false;
  for (const ln of linhas) {
    const t = ln.trim();
    if (t.includes("<!--")) emComentario = true;
    if (emComentario) {
      if (t.includes("-->")) emComentario = false;
      continue;
    }
    if (!t.startsWith("|") || t.includes("---")) continue;
    const cols = t.split("|").map((x) => x.trim()).filter((x, i, a) => i > 0 && i < a.length - 1);
    if (cols.length < 2 || !/^MLB\d+$/.test(cols[0] ?? "") || !/^https?:\/\//.test(cols[1] ?? "")) continue;
    const [cat, url, pix = "", de = "", titulo = "", foto = ""] = cols;
    const item = [url, pix, de, titulo, foto].join(" | ");
    if (!porCat.has(cat)) porCat.set(cat, []);
    porCat.get(cat)!.push(item);
  }
  let total = 0;
  let totalAtt = 0;
  for (const [cat, items] of porCat) {
    const r = salvarCesta(cat, items);
    total += r.novos;
    totalAtt += r.atualizados;
    console.log(`${cat}: +${r.novos} novo(s), ${r.atualizados} atualizado(s)`);
  }
  console.log(`total: ${total} novo(s) + ${totalAtt} atualizado(s) de ${arq}`);
} else {
  console.log(`autoMensagemWhats v0.4
uso:
  npm run dev -- categorias:list
  npm run dev -- hunter:buscar --category MLB3937 --q "Orient" --desconto-min 30 --teto 500 --limite 3 [--enviar] [--dry-run]
  npm run dev -- hunter:auto --category MLB3937 --q "" --corte 75 [--live]   # cron a cada 2h (REVISAO enfilera, AUTO envia)
  npm run dev -- fila:list
  npm run dev -- fila:approve MLB-4210056475 [--live]
  npm run dev -- evo:qr [--save qr.png]         # baixa o QR (v2 ou GO conforme EVO_ENGINE)
  npm run dev -- evo:status                      # state open = pareado
  kill-switch AUTO: touch data/AUTO_OFF (para) / rm data/AUTO_OFF (retoma)
cron exemplo:
  0 8,10,12,14,16,18,20,22 * * * cd /home/oficina/PROJETOS/autoMensagemWhats && npm start -- hunter:auto --category MLB3937 --live >> data/cron.log 2>&1`);
}
