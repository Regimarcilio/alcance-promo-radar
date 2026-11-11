import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  aplicarMarcaDagua,
  calcularGeometria,
  caminhoMascote,
  marcaAtiva,
} from "./marca-dagua.js";

async function foto(
  largura: number,
  altura: number,
  formato: "jpeg" | "png" = "jpeg"
): Promise<string> {
  const img = sharp({
    create: {
      width: largura,
      height: altura,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  });
  const buf = formato === "png" ? await img.png().toBuffer() : await img.jpeg().toBuffer();
  return buf.toString("base64");
}

function comEnv(valores: Record<string, string | undefined>, fn: () => Promise<void>) {
  const antigos: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(valores)) {
    antigos[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(antigos)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("geometria: 1080 usa 194px com margem de 36px", () => {
  assert.deepEqual(calcularGeometria(1080, 1080), { tamanho: 194, margem: 36 });
});

test("geometria: 400 cai no mínimo de 72px e margem 14px", () => {
  assert.deepEqual(calcularGeometria(400, 400), { tamanho: 72, margem: 14 });
});

test("geometria: 100 limita o selo a 42% do lado", () => {
  assert.deepEqual(calcularGeometria(100, 100), { tamanho: 42, margem: 8 });
});

test("geometria: imagem minúscula não deixa o selo vazar", () => {
  const { tamanho, margem } = calcularGeometria(50, 50);
  assert.equal(tamanho, 21);
  assert.ok(tamanho + margem <= 50);
  assert.equal(margem, 8);
});

test("marca ativa por padrão e desligável por env", async () => {
  await comEnv({ MONITOR_MARCA: undefined }, async () => {
    assert.equal(marcaAtiva(), true);
  });
  await comEnv({ MONITOR_MARCA: "0" }, async () => {
    assert.equal(marcaAtiva(), false);
  });
});

test("caminho padrão aponta para a mascote do projeto", () => {
  assert.match(caminhoMascote(), /image\/Guru dos Achadinhos\.png$/);
});

test("aplica selo, mantém dimensões e devolve JPEG", async () => {
  const entrada = await foto(1080, 1080);
  const r = await aplicarMarcaDagua(entrada, "image/jpeg");
  assert.ok(r, "esperava foto marcada");
  assert.equal(r.mimetype, "image/jpeg");
  const meta = await sharp(Buffer.from(r.media, "base64")).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1080);
  assert.equal(meta.format, "jpeg");
});

test("selo altera o canto inferior direito e preserva o resto", async () => {
  const entrada = await foto(1080, 1080);
  const r = await aplicarMarcaDagua(entrada, "image/jpeg");
  assert.ok(r);
  const { data, info } = await sharp(Buffer.from(r.media, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const [r0, g0, b0] = pixel(5, 5);
  assert.ok(r0 > 240 && g0 < 15 && b0 < 15, `canto superior esquerdo deveria seguir vermelho: ${r0},${g0},${b0}`);
  // Ponto dentro do selo (20px além do canto superior esquerdo do adesivo):
  // deve ter saído do vermelho puro da foto de teste.
  const left = info.width - 194 - 36;
  const top = info.height - 194 - 36;
  const [r1, g1, b1] = pixel(left + 20, top + 20);
  const delta = Math.abs(r1 - 254) + g1 + b1;
  assert.ok(delta > 60, `selo não foi composto no canto inferior direito: ${r1},${g1},${b1}`);
});

test("aceita PNG e data URI sem mimetype explícito", async () => {
  const entrada = await foto(400, 300, "png");
  const r = await aplicarMarcaDagua(`data:image/png;base64,${entrada}`);
  assert.ok(r);
  assert.equal(r.mimetype, "image/jpeg");
  const meta = await sharp(Buffer.from(r.media, "base64")).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 300);
});

test("GIF e vídeo ficam intactos", async () => {
  const entrada = await foto(200, 200);
  assert.equal(await aplicarMarcaDagua(entrada, "image/gif"), null);
  assert.equal(await aplicarMarcaDagua(entrada, "video/mp4"), null);
});

test("falha aberta para buffer inválido", async () => {
  const invalido = Buffer.from("isto não é uma imagem").toString("base64");
  assert.equal(await aplicarMarcaDagua(invalido, "image/jpeg"), null);
});

test("falha aberta quando a mascote não existe", async () => {
  const entrada = await foto(300, 300);
  await comEnv({ MONITOR_MARCA_ARQUIVO: "/caminho/que/nao/existe.png" }, async () => {
    assert.equal(await aplicarMarcaDagua(entrada, "image/jpeg"), null);
  });
});

test("MONITOR_MARCA=0 desliga a composição", async () => {
  const entrada = await foto(300, 300);
  await comEnv({ MONITOR_MARCA: "0" }, async () => {
    assert.equal(await aplicarMarcaDagua(entrada, "image/jpeg"), null);
  });
});
