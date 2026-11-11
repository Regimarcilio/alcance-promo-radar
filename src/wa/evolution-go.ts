/**
 * Provider Evolution GO (ADR-001, engine alternativo).
 * Fonte: https://docs.evolutionfoundation.com.br/evolution-go/installation
 * Diferenças p/ v2: exige Postgres, auth `apikey` (global ou token da
 * instância), QR em GET /instance/{nome}/qrcode, Swagger em /swagger/index.html.
 *
 * Endpoint de envio: a GO é a reescrita Go da Evolution e mantém o contrato
 * /message/sendText/{instance}; como a doc pública detalha só instance/qrcode,
 * o path é configurável via EVO_GO_SEND_PATH (confirme no Swagger em runtime).
 */
export function goBase(): string {
  return (process.env.EVO_GO_URL ?? "http://localhost:8081").replace(/\/$/, "");
}

export function goKey(): string {
  return process.env.EVO_GO_KEY ?? process.env.EVO_KEY ?? "";
}

export function goInstance(): string {
  return process.env.EVO_INSTANCE ?? "radar-piloto";
}

/** URL do QR na GO (difere da v2, que usa /instance/connect/{nome}). */
export function goQrUrl(base?: string, instance?: string): string {
  return `${base ?? goBase()}/instance/${instance ?? goInstance()}/qrcode`;
}

export function v2ConnectUrl(base?: string, instance?: string): string {
  const b = (base ?? process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
  return `${b}/instance/connect/${instance ?? goInstance()}`;
}

export function engine(): "v2" | "go" {
  return (process.env.EVO_ENGINE ?? "v2").toLowerCase() === "go" ? "go" : "v2";
}

function sendPath(instance: string): string {
  const tpl = process.env.EVO_GO_SEND_PATH ?? "/message/sendText/{instance}";
  return `${goBase()}${tpl.replace("{instance}", instance)}`;
}

export interface EnvioResult {
  messageId: string;
  dryRun: boolean;
}

export async function enviarViaGo(args: {
  grupo: string;
  imagem: string;
  legenda: string;
  dryRun: boolean;
}): Promise<EnvioResult> {
  if (args.dryRun) {
    console.log(`[dry-run:go] grupo=${args.grupo} legenda=${args.legenda.length}chars`);
    return { messageId: `dryrun-go-${Date.now()}`, dryRun: true };
  }
  if (!goKey()) throw new Error("Evolution GO não configurada (EVO_GO_KEY/EVO_KEY) — envio abortado");
  const res = await fetch(sendPath(goInstance()), {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: goKey() },
    body: JSON.stringify({ number: args.grupo, text: args.legenda }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await res.text();
  if (res.status === 404) {
    throw new Error(
      `GO 404 no path de envio — confirme o endpoint no Swagger (${goBase()}/swagger/index.html) e ajuste EVO_GO_SEND_PATH. Resposta: ${body.slice(0, 200)}`
    );
  }
  if (!res.ok) throw new Error(`Evolution GO ${res.status}: ${body.slice(0, 300)}`);
  try {
    const json: any = JSON.parse(body);
    return { messageId: String(json.key?.id ?? json.id ?? json.messageId ?? Date.now()), dryRun: false };
  } catch {
    return { messageId: `go-${Date.now()}`, dryRun: false };
  }
}

/** Baixa o QR (v2 ou GO conforme EVO_ENGINE) e salva em PNG. Retorna o arquivo. */
export async function baixarQr(arquivo = "qr.png"): Promise<string> {
  const { writeFileSync } = await import("node:fs");
  const eng = engine();
  const url = eng === "go" ? goQrUrl() : v2ConnectUrl();
  const key = eng === "go" ? goKey() : process.env.EVO_KEY ?? "";
  const res = await fetch(url, { headers: { apikey: key } });
  if (!res.ok) throw new Error(`QR ${res.status} em ${url} — a instância existe? (crie com /instance/create primeiro)`);
  const json: any = await res.json();
  const b64: string = json.base64 ?? json.qrcode?.base64 ?? json.qrcode ?? "";
  const limpo = b64.includes(",") ? b64.split(",").slice(-1)[0] : b64;
  if (!limpo) throw new Error(`Resposta sem QR. Verifique state em /instance/connectionState (v2) ou /instance/all (GO).`);
  writeFileSync(arquivo, Buffer.from(limpo, "base64"));
  return arquivo;
}

export async function statusConexao(): Promise<string> {
  const eng = engine();
  if (eng === "go") {
    const res = await fetch(`${goBase()}/instance/all`, { headers: { apikey: goKey() } });
    if (!res.ok) throw new Error(`GO status ${res.status}`);
    const json: any = await res.json();
    const list: any[] = json.data ?? json.instances ?? [];
    const inst = list.find((i: any) => (i.name ?? i.instanceName) === goInstance());
    if (!inst) return `instância ${goInstance()} não encontrada na GO.`;
    return `GO ${goInstance()}: connected=${inst.connected ?? "?"} jid=${inst.jid ?? "-"} motivo=${inst.disconnect_reason ?? "-"}`;
  }
  const base = (process.env.EVO_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const res = await fetch(`${base}/instance/connectionState/${goInstance()}`, {
    headers: { apikey: process.env.EVO_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`v2 status ${res.status}`);
  return `v2 ${goInstance()}: ${await res.text()}`;
}
