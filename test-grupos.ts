import { listarGrupos } from './src/monitor/evolution.js';

async function main() {
  try {
    const grupos = await listarGrupos(true);
    console.log('Grupos encontrados:', grupos.length);
    grupos.forEach(g => console.log(' -', g.nome, g.jid, 'size:', g.tamanho));
  } catch(e) {
    console.error('Erro:', e.message);
  }
}
main();