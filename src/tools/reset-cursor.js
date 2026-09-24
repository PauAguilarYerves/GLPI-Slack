// Mueve el cursor del puente.
//
//   node src/tools/reset-cursor.js                      -> lo fija en "ahora"
//   node src/tools/reset-cursor.js 2026-09-24T10:39:00Z -> lo fija en esa fecha
//
// Fijarlo en "ahora" descarta lo acumulado durante una parada. Retrocederlo
// reprocesa lo ocurrido desde esa fecha: util para recuperar algo que se perdio,
// pero comprueba antes cuantos tickets se han movido en ese intervalo.
import * as store from '../store.js';

const argumento = process.argv[2];
let destino;

if (!argumento) {
  destino = new Date();
} else {
  destino = new Date(argumento);
  if (Number.isNaN(destino.getTime())) {
    console.error(`Fecha no valida: ${argumento}. Usa formato ISO, por ejemplo 2026-09-24T10:39:00Z`);
    process.exit(1);
  }
}

const anterior = store.getCursor();
store.setCursor(destino.toISOString());

console.log(`Cursor: ${anterior} -> ${destino.toISOString()}`);
console.log(destino.getTime() < new Date(anterior).getTime()
  ? 'Se reprocesara lo ocurrido desde esa fecha.'
  : 'No se procesara nada anterior.');
