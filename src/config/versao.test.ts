import test from "node:test";
import assert from "node:assert/strict";
import { versaoDoApp } from "./versao.js";

test("versaoDoApp: lê a versão do package.json (fonte única de verdade)", () => {
  const v = versaoDoApp();
  assert.match(v, /^\d+\.\d+\.\d+/, `versão inesperada: ${v}`);
});

test("versaoDoApp: devolve sempre o mesmo valor (cache)", () => {
  assert.equal(versaoDoApp(), versaoDoApp());
});
