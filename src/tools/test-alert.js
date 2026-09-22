// Envia un aviso de prueba al canal de alertas, para comprobar que el circuito
// funciona sin tener que romper nada de verdad.
//   docker compose run --rm glpi-slack-bridge node src/tools/test-alert.js
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { configurarAlertas, alerta, recuperado } from '../alerts.js';

if (!config.alertChannel) {
  console.error('ALERT_CHANNEL esta vacio: no hay canal al que avisar.');
  process.exit(1);
}

configurarAlertas(new WebClient(config.slack.botToken));

// Un tipo distinto en cada ejecucion, para que el enfriamiento no lo silencie.
const tipo = `prueba-${Date.now()}`;

await alerta(
  tipo,
  'Prueba del canal de alertas',
  'Si ves este mensaje, el puente puede avisarte cuando algo se rompa de verdad. '
  + `Enviado desde ${process.env.HOSTNAME || 'este equipo'}.`,
);
await recuperado(tipo, 'Prueba superada');

console.log(`Enviados al canal ${config.alertChannel}: un aviso de fallo y uno de recuperacion.`);
process.exit(0);
