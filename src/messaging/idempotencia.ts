/**
 * IDEMPOTÊNCIA — chaves de negócio e registro de mensagens já processadas.
 *
 * Erro comum da aula de Mensageria: *"não tratar mensagens duplicadas"*. Com
 * ACK/DLQ a reentrega deixa de ser acidental e passa a ser uma decisão — logo,
 * cada tipo de mensagem tem uma **chave de negócio** e o consumidor consulta o
 * registro ANTES do efeito:
 *
 * - já processada → **ACK imediato**, sem reenviar (log
 *   `[mensageria] duplicata ignorada: <chave>`);
 * - não processada → processa e, **junto do ACK**, registra a chave.
 *
 * A chave é gravada **nunca antes** do ACK: se o processo morrer entre o
 * efeito e o registro, a reentrega reenvia (at-least-once com chave — é a
 * recomendação da aula para "pagamentos").
 *
 * O registro é genérico (retenção + limite + escrita atômica) e serve de base
 * para o dedup do Monitor (`src/store/dedup.ts`), sem mudar a API dele.
 */
import { join } from "node:path";
import { dataDirAtual } from "../config/paths.js";
import { gravarJsonAtomico, lerJson } from "../store/json.js";

export interface EntradaChave {
  /** instante do registro (ISO) */
  data: string;
  /** campos extras (ex.: `dia`, `tipo`) */
  [campo: string]: unknown;
}

export interface OpcoesRegistro {
  /** arquivo do registro */
  arquivo: string;
  /** retenção em dias (default 30) */
  retencaoDias?: number;
  /** limite de chaves guardadas (default 50 000) */
  limite?: number;
  /** nome do campo que guarda a chave (default "chave") */
  campoChave?: string;
}

export interface RegistroChaves {
  /** a chave já foi processada (dentro da retenção)? */
  tem(chave: string, retencaoDias?: number): boolean;
  /** registra a chave como processada (grava junto do ACK) */
  registrar(chave: string, meta?: Record<string, unknown>, retencaoDias?: number): void;
  /** apaga todas as chaves (devolve quantas foram removidas) */
  limpar(): number;
  /** quantas chaves estão guardadas */
  tamanho(): number;
  /** entradas guardadas */
  entradas(): EntradaChave[];
  /** apaga as chaves expiradas (devolve quantas foram removidas) */
  limparExpiradas(retencaoDias?: number): number;
}

/** Cria um registro de chaves (reutilizável — base do dedup do Monitor). */
export function criarRegistro(op: OpcoesRegistro): RegistroChaves {
  const campo = op.campoChave ?? "chave";
  const retencao = (dias?: number) =>
    Number.isFinite(dias as number) && (dias as number) > 0 ? Number(dias) : (op.retencaoDias ?? 30);
  const limite = () => (Number.isFinite(op.limite as number) && (op.limite as number) > 0 ? Number(op.limite) : 50_000);

  const ler = (): EntradaChave[] => {
    const raw = lerJson<any>(op.arquivo, []);
    return Array.isArray(raw) ? (raw as EntradaChave[]) : [];
  };

  const gravar = (arr: EntradaChave[], retencaoDias?: number): void => {
    const corte = Date.now() - retencao(retencaoDias) * 86_400_000;
    const vivos = arr.filter((e) => {
      const t = Date.parse(String(e?.data ?? ""));
      return Number.isFinite(t) ? t >= corte : true;
    });
    const guardados = vivos.slice(Math.max(0, vivos.length - limite()));
    gravarJsonAtomico(op.arquivo, guardados);
  };

  return {
    tem(chave, retencaoDias) {
      const corte = Date.now() - retencao(retencaoDias) * 86_400_000;
      return ler().some((e) => {
        if (String(e?.[campo] ?? "") !== chave) return false;
        const t = Date.parse(String(e?.data ?? ""));
        return Number.isFinite(t) ? t >= corte : true;
      });
    },
    registrar(chave, meta, retencaoDias) {
      const arr = ler().filter((e) => String(e?.[campo] ?? "") !== chave);
      // `meta` pode sobrescrever o instante (ex.: registro retroativo)
      arr.push({ data: new Date().toISOString(), ...(meta ?? {}), [campo]: chave });
      gravar(arr, retencaoDias);
    },
    limpar() {
      const n = ler().length;
      gravarJsonAtomico(op.arquivo, []);
      return n;
    },
    tamanho() {
      return ler().length;
    },
    entradas() {
      return ler();
    },
    limparExpiradas(retencaoDias) {
      const antes = ler().length;
      gravar(ler(), retencaoDias);
      return antes - ler().length;
    },
  };
}

// ---------- registro da camada de Mensageria ----------

function arquivoProcessados(): string {
  return join(dataDirAtual(), "messaging", "processados.json");
}

/** Registro padrão da mensageria (30 dias, 50 000 chaves). */
export function registroMensageria(): RegistroChaves {
  return criarRegistro({
    arquivo: arquivoProcessados(),
    retencaoDias: Number(process.env.MENSAGERIA_IDEMPOTENCIA_DIAS ?? 30),
    limite: Number(process.env.MENSAGERIA_IDEMPOTENCIA_LIMITE ?? 50_000),
  });
}

/** A chave já foi processada com sucesso? */
export function jaProcessado(chave: string): boolean {
  if (!chave) return false;
  return registroMensageria().tem(chave);
}

/** Registra a chave como processada (chamado junto do ACK). */
export function registrarProcessado(chave: string, tipo?: string): void {
  if (!chave) return;
  registroMensageria().registrar(chave, tipo ? { tipo } : undefined);
}

/** Quantas chaves estão guardadas / a mais antiga. */
export function estatisticasIdempotencia(): { total: number; maisAntigaEm: string | null } {
  const entradas = registroMensageria().entradas();
  const datas = entradas.map((e) => String(e?.data ?? "")).filter(Boolean).sort();
  return { total: entradas.length, maisAntigaEm: datas[0] ?? null };
}

/** Limpa as chaves expiradas (devolve quantas foram removidas). */
export function limparProcessados(): number {
  return registroMensageria().limparExpiradas();
}

// ---------- chaves por tipo de mensagem ----------

/**
 * Chave de idempotência por tipo de mensagem (centraliza o cálculo).
 *
 * | tipo                  | chave                                  |
 * |-----------------------|----------------------------------------|
 * | `cliente.enviar`      | `${disparoId}:${jid}`                  |
 * | `monitor.encaminhar`  | hash `mlbId|preco|cupom` (o do Monitor) |
 * | `monitor.add-grupo`   | `${jid}:${telefone}`                   |
 * | evento de tópico      | `${tipo}:${id}`                        |
 */
export function chaveDe(tipo: string, dados: any): string {
  switch (String(tipo)) {
    case "cliente.enviar": {
      // campanha com disparo → `${disparoId}:${jid}`; sem disparo → id do item
      const campanha = String(dados?.disparoId ?? dados?.id ?? "sem-disparo");
      return `${campanha}:${String(dados?.jid ?? "")}`;
    }
    case "monitor.encaminhar": {
      const mlbId = String(dados?.mlbId ?? dados?.idProduto ?? "");
      const preco = Number(dados?.preco ?? 0);
      const cupom = dados?.cupom ? String(dados.cupom).toUpperCase() : "";
      return `${mlbId}|${preco}|${cupom}`;
    }
    case "monitor.add-grupo":
      return `${String(dados?.jid ?? "")}:${String(dados?.telefone ?? "")}`;
    default:
      // evento de tópico: o próprio id do envelope já é único
      return `${String(tipo)}:${String(dados?.id ?? "")}`;
  }
}
