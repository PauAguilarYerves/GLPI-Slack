// Avisos de los fallos del propio puente a un canal de Slack.
//
// Sin esto, un puente roto solo se nota cuando alguien pregunta por que no le
// llegan respuestas. La clave del diseno es el agrupado: con el sondeo cada 5
// segundos, publicar cada error daria cientos de mensajes por hora y el canal
// acabaria silenciado, que es peor que no tenerlo.
import { config } from './config.js';
import { log } from './log.js';
import * as store from './store.js';

const COLOR_FALLO = '#d93025';
const COLOR_OK = '#2eb886';

let cliente = null;

export function configurarAlertas(slackClient) {
  cliente = slackClient;
}

const claveDe = (tipo) => `alerta:${tipo}`;

async function publicar(texto, blocks, color) {
  if (!config.alertChannel || !cliente) return;
  try {
    // Sin `text`: con adjuntos, Slack lo pintaria encima y el titulo saldria
    // dos veces. El aviso del movil usa el `fallback`.
    await cliente.chat.postMessage({
      channel: config.alertChannel,
      attachments: [{ color, blocks, fallback: texto }],
      unfurl_links: false,
    });
  } catch (err) {
    const code = err?.data?.error;
    if (code === 'not_in_channel' || code === 'channel_not_found') {
      log.error(
        `No se puede avisar en ${config.alertChannel}: el bot no esta en ese canal. `
        + 'Invitalo con /invite @GLPI o corrige ALERT_CHANNEL.',
      );
    } else {
      log.warn(`No se pudo publicar la alerta: ${code || err.message}`);
    }
  }
}

/**
 * Avisa de un fallo. El mismo `tipo` no se repite hasta pasado el enfriamiento,
 * y el contador de ocurrencias se acumula para que el aviso siguiente diga
 * cuantas veces ha pasado mientras callabamos.
 */
export async function alerta(tipo, titulo, detalle = null) {
  log.error(`[alerta:${tipo}] ${titulo}${detalle ? ` — ${detalle}` : ''}`);

  const clave = claveDe(tipo);
  const estado = JSON.parse(store.getKv(clave) || 'null');
  const ahora = Date.now();

  if (estado && ahora - estado.avisado < config.alertCooldownMinutes * 60000) {
    store.setKv(clave, JSON.stringify({ ...estado, veces: estado.veces + 1 }));
    return;
  }

  const repeticiones = estado ? estado.veces : 0;
  store.setKv(clave, JSON.stringify({ avisado: ahora, veces: 1, titulo }));

  const contexto = [
    detalle,
    repeticiones > 1 ? `Ha ocurrido ${repeticiones} veces desde el último aviso.` : null,
  ].filter(Boolean).join('\n');

  await publicar(`⚠ ${titulo}`, [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning:  *${titulo}*` } },
    ...(contexto
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: contexto }] }]
      : []),
  ], COLOR_FALLO);
}

/** Lo que estaba fallando ha vuelto a funcionar. Solo avisa si habia alerta. */
export async function recuperado(tipo, titulo) {
  const clave = claveDe(tipo);
  const estado = JSON.parse(store.getKv(clave) || 'null');
  if (!estado) return;

  store.deleteKv(clave);
  log.info(`[recuperado:${tipo}] ${titulo}`);

  await publicar(`✅ ${titulo}`, [
    { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark:  *${titulo}*` } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Estuvo fallando desde ${new Date(estado.avisado).toLocaleString('es-ES')}.`,
      }],
    },
  ], COLOR_OK);
}
