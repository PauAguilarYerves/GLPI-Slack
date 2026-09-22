// Comprueba que el sondeo sigue latiendo. Sale con 1 si lleva demasiado tiempo
// parado, para que Docker reinicie el contenedor en vez de dejarlo colgado
// "arrancado" pero sin hacer nada.
import { config } from '../config.js';
import * as store from '../store.js';

const latido = store.getHeartbeat();
if (!latido) {
  // Aun no ha completado el primer ciclo: se le da un margen desde el arranque.
  process.exit(0);
}

const margen = Math.max(config.pollIntervalMs * 3, 120000);
const antiguedad = Date.now() - new Date(latido).getTime();

if (antiguedad > margen) {
  console.error(`Sin latido desde hace ${Math.round(antiguedad / 1000)}s (limite ${Math.round(margen / 1000)}s)`);
  process.exit(1);
}
process.exit(0);
