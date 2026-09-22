// Vuelve a fijar el cursor en "ahora": util si el puente ha estado parado
// mucho tiempo y NO quieres recuperar los eventos acumulados.
import * as store from '../store.js';

const now = new Date().toISOString();
store.setCursor(now);
console.log(`Cursor reiniciado a ${now}. No se procesara nada anterior.`);
