import { readFileSync } from 'node:fs';

const src = readFileSync('src/manager/server.ts', 'utf8');

const inicio = src.indexOf('const PAGINA = `');
const comAbertura = src.slice(inicio + 'const PAGINA = '.length);
const fim = comAbertura.indexOf('`;');
const fonte = comAbertura.slice(1, fim);

console.log('Tamanho do template:', fonte.length);

// Procurar \\n (barra-n duplo) na fonte
const linhas = fonte.split('\n');
let countDubl = 0;
let countSimple = 0;

linhas.forEach((l, i) => {
  // Contar \\n e \n
  const duplos = (l.match(/\\\\n/g) || []).length;
  const simples = (l.match(/(?<!\\)\n[nt]/g) || []).length;
  if (duplos > 0 || simples > 0) {
    console.log(`Linha ${i+1}: \\n=${duplos}, \n[nt]=${simples}`);
    if (duplos > 0) countDubl += duplos;
    if (simples > 0) countSimple += simples;
  }
});

console.log(`\nTotal \\n duplo: ${countDubl}, \n simples: ${countSimple}`);

// Renderizar
const renderizado = new Function('return `' + fonte + '`')();
console.log('\nRenderizado tamanho:', renderizado.length);

// Checar no renderizado
const linhasRender = renderizado.split('\n');
let countR = 0;
const problematic = [];

linhasRender.forEach((l, i) => {
  const simples = (l.match(/(?<!\\)\n[nt]/g) || []).length;
  if (simples > 0) {
    countR += simples;
    if (problematic.length < 5) {
      problematic.push({ linha: i+1, trecho: l.slice(0, 100) });
    }
  }
});

console.log('\nNo renderizado, \n simples encontrados:', countR);
console.log('Exemplos:', JSON.stringify(problematic, null, 2));
