import pkg from '@slack/bolt';
import { config } from './config.js';
import { log } from './log.js';
import * as store from './store.js';
import { glpi, glpiTicketUrl } from './glpi.js';
import { slackToGlpiHtml } from './format.js';
import { bootstrapCursor, startPolling } from './poller.js';
import {
  REPLY_ACTION_ID, REPLY_VIEW_ID, OPEN_GLPI_ACTION_ID, downloadSlackFile,
  postToConversation, reopenedBlocks, avisarSoporte, avisoReaperturaBlocks,
  findSlackUserByEmail, COLORES,
} from './slack.js';

const { App } = pkg;

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken || undefined,
  socketMode: config.slack.socketMode,
  signingSecret: config.slack.signingSecret || undefined,
});

/**
 * Slack -> GLPI. Unico camino de escritura, lo usan tanto las respuestas
 * escritas en el canal como las enviadas desde la ventana emergente.
 */
async function etiquetaDe(client, slackUserId) {
  const profile = await client.users.info({ user: slackUserId }).catch(() => null);
  return profile?.user?.real_name || profile?.user?.name || slackUserId;
}

async function pushReplyToGlpi(client, { ticketId, text, slackUserId }) {
  const label = await etiquetaDe(client, slackUserId);
  const followupId = await glpi.addFollowup(ticketId, slackToGlpiHtml(text, label));

  // Clave anti-bucle: marcamos como visto el seguimiento que acabamos de crear
  // para que el sondeo no lo devuelva a Slack.
  store.markFollowupSeen(followupId, ticketId, 'slack');
  log.info(`Slack -> GLPI: ticket ${ticketId}, seguimiento ${followupId}`);
  return followupId;
}

/**
 * El usuario escribe durante el margen de gracia posterior al cierre. Eso es la
 * senal de que el problema no estaba resuelto, asi que se reabre el ticket en
 * GLPI y se cancela la limpieza del canal.
 *
 * Devuelve true si el ticket ha vuelto a estar abierto.
 */
async function reabrirPorRespuesta(client, conversation, slackUserId, mensaje) {
  try {
    await glpi.reopenTicket(conversation.ticket_id, config.reopenStatus);
  } catch (err) {
    log.error(
      `No se pudo reabrir el ticket ${conversation.ticket_id}:`,
      err.message, err.body ?? '',
    );
    return false;
  }

  store.cancelCleanup(conversation.ticket_id);

  const quien = await etiquetaDe(client, slackUserId);
  await postToConversation(client, store.getConversationByTicket(conversation.ticket_id), {
    text: `Ticket #${conversation.ticket_id} reabierto`,
    color: COLORES.reapertura,
    blocks: reopenedBlocks({ ticket: { id: conversation.ticket_id }, quien }),
  }).catch(() => {});

  // Y que el equipo de soporte se entere sin tener que mirar GLPI.
  try {
    const ticket = await glpi.getTicket(conversation.ticket_id);
    const tecnico = await glpi.getAssignedTechnician(conversation.ticket_id);
    const tecnicoSlackId = tecnico?.email
      ? await findSlackUserByEmail(client, tecnico.email)
      : null;

    await avisarSoporte(client, {
      tecnicoSlackId,
      texto: `Ticket #${ticket.id} reabierto por ${quien}`,
      blocks: avisoReaperturaBlocks({
        ticket, quien, mensaje, glpiTicketUrl: glpiTicketUrl(ticket.id),
      }),
    });
  } catch (err) {
    log.warn(`No se pudo avisar a soporte de la reapertura del ${conversation.ticket_id}: ${err.message}`);
  }

  log.info(`Ticket ${conversation.ticket_id} reabierto: el usuario respondio tras el cierre`);
  return true;
}

// Los avisos al usuario van como efimeros: no se guardan en el canal,
// asi que no dejan rastro que borrar despues.
function ephemeral(client, channel, user, text) {
  return client.chat.postEphemeral({ channel, user, text }).catch(() => {});
}

// ---------------------------------------------------------------
// Respuesta escrita directamente en la conversacion (REPLY_MODE=inline)
// ---------------------------------------------------------------
// Subtipos que SI son una respuesta del usuario. El resto (ediciones, borrados,
// entradas y salidas del canal, mensajes de sistema) se ignoran.
const SUBTIPOS_VALIDOS = new Set([undefined, null, '', 'file_share', 'thread_broadcast']);

/**
 * El usuario edita en Slack un mensaje que ya viajo a GLPI: reescribimos alli
 * el seguimiento en vez de crear uno nuevo. Sin esto, el tecnico se queda con
 * el texto antiguo y nadie se entera de la correccion.
 */
async function handleSlackEdit(event, client) {
  const msg = event.message;
  if (!msg || msg.bot_id || msg.subtype === 'tombstone') return;

  const enlace = store.getOutboundMessage(event.channel, msg.ts);
  if (!enlace) return;

  const texto = (msg.text || '').trim();
  if (!texto) return;

  try {
    const label = await etiquetaDe(client, msg.user);
    await glpi.updateFollowup(enlace.followup_id, slackToGlpiHtml(texto, `${label} (editado)`));
    await client.reactions
      .add({ channel: event.channel, timestamp: msg.ts, name: 'pencil2' })
      .catch(() => {});
    log.info(`Slack -> GLPI: seguimiento ${enlace.followup_id} actualizado tras editarse en Slack`);
  } catch (err) {
    log.error(`No se pudo actualizar el seguimiento ${enlace.followup_id}:`, err.message, err.body ?? '');
    await ephemeral(client, event.channel, msg.user,
      'He visto tu edición pero no he podido llevarla a GLPI. El técnico sigue viendo el texto anterior.');
  }
}

app.event('message', async ({ event, client }) => {
  if (event.subtype === 'message_changed') {
    await handleSlackEdit(event, client);
    return;
  }
  if (event.bot_id || !event.user) return;
  if (!SUBTIPOS_VALIDOS.has(event.subtype)) return;

  const ficheros = event.files || [];
  const texto = (event.text || '').trim();
  // Un archivo sin comentario tampoco puede pasar de largo en silencio.
  if (!texto && ficheros.length === 0) return;

  let conversation = store.getConversationByChannel(event.channel);
  if (!conversation) return;
  if (conversation.cleaned_at) {
    await ephemeral(client, event.channel, event.user,
      'Este ticket ya está cerrado. Abre uno nuevo en GLPI si necesitas más ayuda.');
    return;
  }

  // Cerrado pero dentro del margen de gracia: la respuesta lo reabre.
  const enMargenDeGracia = Boolean(conversation.cleanup_at) && !conversation.cleaned_at;
  if (enMargenDeGracia && config.reopenOnReply) {
    const reabierto = await reabrirPorRespuesta(client, conversation, event.user, texto);
    if (!reabierto) {
      await ephemeral(client, event.channel, event.user,
        'He registrado tu mensaje, pero no he podido reabrir el ticket en GLPI. '
        + `Avisa al equipo o ábrelo de nuevo aquí: ${glpiTicketUrl(conversation.ticket_id)}`);
    }
    conversation = store.getConversationByTicket(conversation.ticket_id) || conversation;
  }

  try {
    // Primero los adjuntos: si alguno falla, el texto del usuario se registra
    // igualmente y el seguimiento deja constancia de lo que no pudo subirse.
    const subidos = [];
    const fallidos = [];
    for (const f of ficheros) {
      try {
        const fichero = await downloadSlackFile(f);
        await glpi.uploadDocument(conversation.ticket_id, fichero);
        subidos.push(fichero.filename);
      } catch (err) {
        log.warn(`Adjunto ${f.name} del ticket ${conversation.ticket_id}: ${err.message}`);
        fallidos.push(f.name || 'sin nombre');
      }
    }

    const notas = [];
    if (subidos.length) notas.push(`[Archivos adjuntados desde Slack: ${subidos.join(', ')}]`);
    if (fallidos.length) notas.push(`[No se pudieron subir: ${fallidos.join(', ')}]`);

    const followupId = await pushReplyToGlpi(client, {
      ticketId: conversation.ticket_id,
      text: [texto || '(sin texto)', ...notas].join('\n\n'),
      slackUserId: event.user,
    });
    // Guardamos el vinculo para poder reflejar despues las ediciones.
    store.rememberOutboundMessage({
      channelId: event.channel,
      ts: event.ts,
      followupId,
      ticketId: conversation.ticket_id,
    });
    await client.reactions
      .add({ channel: event.channel, timestamp: event.ts, name: 'white_check_mark' })
      .catch(() => {});

    if (fallidos.length) {
      await ephemeral(client, event.channel, event.user,
        `No he podido subir a GLPI: *${fallidos.join(', ')}*. ` +
        `Adjúntalos a mano en ${glpiTicketUrl(conversation.ticket_id)}`);
    }
  } catch (err) {
    log.error(`No se pudo añadir el seguimiento al ticket ${conversation.ticket_id}:`, err.message, err.body ?? '');
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'warning' }).catch(() => {});
    await ephemeral(client, event.channel, event.user,
      'No he podido registrar tu respuesta en GLPI. Inténtalo de nuevo en unos minutos.');
  }
});

// ---------------------------------------------------------------
// Respuesta desde ventana emergente (REPLY_MODE=modal)
// El usuario no llega a publicar ningun mensaje en Slack: todo lo que
// queda en el canal lo ha escrito el bot, y por tanto el bot puede borrarlo.
// ---------------------------------------------------------------
// El boton "Ver en GLPI" solo abre un enlace, pero Slack envia el evento igual
// y hay que confirmarlo o Bolt lo registra como no gestionado.
app.action(OPEN_GLPI_ACTION_ID, async ({ ack }) => { await ack(); });

app.action(REPLY_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  const ticketId = Number(body.actions[0].value);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: REPLY_VIEW_ID,
      private_metadata: JSON.stringify({ ticketId, channelId: body.channel?.id }),
      title: { type: 'plain_text', text: `Ticket #${ticketId}` },
      submit: { type: 'plain_text', text: 'Enviar' },
      close: { type: 'plain_text', text: 'Cancelar' },
      blocks: [{
        type: 'input',
        block_id: 'reply',
        label: { type: 'plain_text', text: 'Tu respuesta' },
        element: {
          type: 'plain_text_input', action_id: 'text', multiline: true,
          placeholder: { type: 'plain_text', text: 'Escribe aquí tu respuesta para el técnico' },
        },
      }],
    },
  });
});

app.view(REPLY_VIEW_ID, async ({ ack, body, view, client }) => {
  const { ticketId, channelId } = JSON.parse(view.private_metadata || '{}');
  const text = view.state.values.reply.text.value;
  const conversation = store.getConversationByTicket(ticketId);

  if (!conversation || conversation.cleaned_at) {
    await ack({
      response_action: 'errors',
      errors: { reply: 'Este ticket ya está cerrado.' },
    });
    return;
  }

  try {
    await pushReplyToGlpi(client, { ticketId, text, slackUserId: body.user.id });
    await ack();
    await ephemeral(client, channelId || conversation.channel_id, body.user.id,
      'Respuesta enviada al ticket. ✅');
  } catch (err) {
    log.error(`No se pudo añadir el seguimiento al ticket ${ticketId}:`, err.message, err.body ?? '');
    await ack({
      response_action: 'errors',
      errors: { reply: 'No he podido registrarlo en GLPI. Inténtalo de nuevo en unos minutos.' },
    });
  }
});

/**
 * Un canal privado de Slack lo puede ampliar cualquiera de sus miembros, y un
 * ticket puede llevar datos que solo incumben a quien lo abrio. Aqui se retira
 * a quien entre sin que lo haya invitado el puente.
 *
 * No es una barrera perfecta: entre que alguien entra y se le retira pasan uno
 * o dos segundos, tiempo de leer si esta mirando. Pero cierra el caso real, que
 * es el companero que se queda dentro indefinidamente.
 */
app.event('member_joined_channel', async ({ event, client }) => {
  if (!config.enforcePrivacy) return;

  const conversation = store.getConversationByChannel(event.channel);
  if (!conversation) return;                        // no es un canal nuestro

  const botUserId = (await client.auth.test()).user_id;
  if (event.user === botUserId) return;
  if (store.isInvited(event.channel, event.user)) return;
  if (config.privacyAllowlist.includes(event.user)) return;

  try {
    await ephemeral(client, event.channel, event.user,
      `Este canal es la conversación privada del ticket #${conversation.ticket_id} `
      + 'con la persona que lo abrió, así que te saco de él. '
      + 'Si necesitas seguir este ticket, míralo directamente en GLPI.');
    await client.conversations.kick({ channel: event.channel, user: event.user });
    log.warn(`Ticket ${conversation.ticket_id}: ${event.user} entro sin invitacion y se le ha retirado`);

    if (event.inviter && event.inviter !== event.user) {
      await ephemeral(client, event.channel, event.inviter,
        'He retirado a la persona que invitaste: este canal es privado del ticket. '
        + 'Si hace falta que alguien más lo vea, añádelo como observador en GLPI.');
    }
  } catch (err) {
    const code = err?.data?.error;
    log.error(
      `No se pudo retirar a ${event.user} del ticket ${conversation.ticket_id}: ${code || err.message}`
      + (code === 'restricted_action'
        ? '. El workspace restringe quien puede retirar miembros de canales privados.'
        : ''),
    );
  }
});

let pollTimer;

async function main() {
  await glpi.initSession();
  bootstrapCursor();
  await app.start(config.slack.socketMode ? undefined : config.slack.port);
  log.info(
    `Puente GLPI<->Slack activo (conversacion=${config.mode}, respuesta=${config.replyMode}, ` +
    `limpieza=${config.cleanupMode}, socket=${config.slack.socketMode})`,
  );
  pollTimer = startPolling(app.client);
}

async function shutdown(signal) {
  log.info(`${signal} recibido, cerrando...`);
  clearInterval(pollTimer);
  await app.stop().catch(() => {});
  await glpi.killSession().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));

main().catch((err) => {
  log.error('Arranque fallido:', err.message, err.body ?? '');
  process.exit(1);
});
