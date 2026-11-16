/**
 * Mídia da origem — parte de RF-034.
 *
 * Com `webhookBase64: true` na instância, o webhook entrega a PRÓPRIA imagem que
 * a origem publicou (~200KB). Guardamos em disco (data/midia/) em vez de embutir
 * na fila/estado — senão o JSON viraria dezenas de MB.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDirAtual } from "../config/paths.js";

/**
 * Diretório de mídia. Resolvido **em tempo de chamada** (não no import),
 * igual ao `dataDirAtual()`: assim teste/smoke conseguem trocar
 * `ALCANCE_DATA_DIR` sem recarregar o módulo.
 */
export function midiaDirAtual(): string {
  return join(dataDirAtual(), "midia");
}

/** Diretório de mídia (compatibilidade: valor fixo no import). */
export const midiaDir = join(dataDirAtual(), "midia");

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4",
};
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4",
};

const NOME_SEGURO = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mp4)$/i;

/** Grava o base64 da origem em disco e devolve o caminho (ou null). */
export function salvarMidia(base64: string, mimetype = "image/jpeg"): string | null {
  try {
    const limpo = base64.replace(/^data:[^;]+;base64,/, "");
    if (!limpo) return null;
    const ext = EXT[mimetype.toLowerCase()] ?? "jpg";
    const dir = midiaDirAtual();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const caminho = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(caminho, Buffer.from(limpo, "base64"), { mode: 0o600 });
    return caminho;
  } catch {
    return null;
  }
}

function dentroDaMidia(caminho: string): boolean {
  try {
    // a pasta de mídia pode não existir ainda (primeiro boot / ambiente novo):
    // nesse caso nada está dentro dela.
    const dir = midiaDirAtual();
    if (!existsSync(dir)) return false;
    const raiz = realpathSync(dir);
    const alvo = realpathSync(caminho);
    return alvo === raiz || alvo.startsWith(raiz + "/");
  } catch {
    return false;
  }
}

/**
 * Por que um caminho de mídia local não pode ser usado.
 *
 * - `ok` — arquivo válido dentro de `data/midia`;
 * - `inexistente` — o arquivo **não existe mais**: foi removido pela faxina de
 *   retenção (RN-026) ou o disco foi limpo. Não é segurança: o caminho é
 *   legítimo, o arquivo é que sumiu;
 * - `nao-permitido` — o caminho está fora de `data/midia` (violação de
 *   segurança: tentaria ler `/app/.env`);
 * - `formato-invalido` — o nome do arquivo não é `<uuid>.<ext>` de mídia
 *   (violação de segurança).
 *
 * A distinção importa: o erro "caminho de mídia não permitido" era devolvido
 * para os DOIS casos, então uma mídia expirada pela retenção aparecia como
 * tentativa de invasão e o operador não sabia o que fazer (issue #82).
 */
export type MotivoMidia = "ok" | "inexistente" | "nao-permitido" | "formato-invalido";

export interface ClassificacaoMidia {
  ok: boolean;
  motivo: MotivoMidia;
  /** mensagem legível para o operador (quando `ok` é falso) */
  erro?: string;
}

/**
 * Classifica um caminho de mídia local.
 *
 * Não lança: devolve o motivo. `nao-permitido` e `formato-invalido` são
 * violações de segurança (bloqueiam o envio); `inexistente` é expiração
 * (o chamador pode seguir só com o texto).
 */
export function classificarMidia(caminho: string): ClassificacaoMidia {
  if (!caminho) return { ok: false, motivo: "ok" };
  try {
    if (!NOME_SEGURO.test(basename(caminho))) {
      return {
        ok: false,
        motivo: "formato-invalido",
        erro: "nome de arquivo de mídia inválido (esperado <uuid>.<jpg|png|webp|gif|mp4>)",
      };
    }
    if (!existsSync(caminho)) {
      return {
        ok: false,
        motivo: "inexistente",
        erro: "arquivo de mídia não existe mais (removido pela limpeza de retenção)",
      };
    }
    if (!dentroDaMidia(caminho)) {
      return {
        ok: false,
        motivo: "nao-permitido",
        erro: "caminho de mídia fora de data/midia",
      };
    }
    return { ok: true, motivo: "ok" };
  } catch {
    return { ok: false, motivo: "nao-permitido", erro: "caminho de mídia inválido" };
  }
}

/**
 * Só aceita arquivos com nome UUID e extensão de mídia DENTRO de data/midia.
 * Impede que um caminho arbitrário (`/app/.env`) seja lido e enviado.
 */
export function ehArquivoMidia(caminho: string): boolean {
  try {
    if (!caminho) return false;
    return classificarMidia(caminho).ok;
  } catch {
    return false;
  }
}

/** Converte um caminho de mídia em base64 com mimetype, respeitando a allowlist. */
export function lerMidia(caminho: string): { base64: string; mimetype: string } | null {
  try {
    if (!ehArquivoMidia(caminho)) return null;
    const ext = (caminho.split(".").pop() ?? "jpg").toLowerCase();
    return { base64: readFileSync(caminho).toString("base64"), mimetype: MIME[ext] ?? "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Remove mídias mais antigas que `dias` (chamado pelo worker).
 *
 * `emUso` são caminhos que **NÃO** podem ser removidos mesmo vencido o prazo:
 * mídia de campanha ainda em andamento, item na fila ou mensagem parada na
 * DLQ. Sem essa proteção (issue #82), a faxina apagava o vídeo de uma
 * campanha de 550 contatos no meio do disparo e as mensagens restantes
 * morriam com "caminho de mídia não permitido".
 */
export function limparMidiaAntiga(dias = 3, emUso?: Iterable<string>): number {
  try {
    const dir = midiaDirAtual();
    if (!existsSync(dir)) return 0;
    const protegidos = new Set<string>();
    for (const p of emUso ?? []) {
      if (!p) continue;
      protegidos.add(basename(p));
    }
    const limite = Date.now() - dias * 86400_000;
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (protegidos.has(f)) continue; // ainda em uso: preserva
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < limite) {
          rmSync(p);
          n++;
        }
      } catch { /* ignore */ }
    }
    return n;
  } catch {
    return 0;
  }
}

const HOSTS_PRIVADOS = [
  /^localhost$/i, /\.local$/i, /^127\./, /^10\./, /^192\.168\./,
  /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/i, /^\[?f[cd]/i, /^\[?fe80/i,
];

/**
 * URL de imagem aceitável para a Evolution buscar: http(s), sem credenciais e
 * sem host interno/privado (SSRF). A decisão é feita antes de repassar a URL.
 */
export function urlImagemSegura(bruta: string): boolean {
  try {
    const u = new URL(bruta);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    if (bruta.length > 2048) return false;
    const host = u.hostname.toLowerCase();
    if (!host || !host.includes(".")) return false;
    if (HOSTS_PRIVADOS.some((re) => re.test(host))) return false;
    return true;
  } catch {
    return false;
  }
}
