import { WebClient } from '@slack/web-api';
import { config } from './config.js';
import { log } from './log.js';
import * as store from './store.js';
import { truncate, escapeSlack, glpiHtmlToSlack as glpiHtmlToSlackSeguro } from './format.js';
import { alerta } from './alerts.js';

// Token de organizacion (Enterprise Grid) para el borrado real del canal.
const adminClient = config.slack.adminToken ? new WebClient(config.slack.adminToken) : null;

// Barra lateral de color: distingue de un vistazo quien habla y en que fase
// esta el ticket, sin necesidad de leer.
export const COLORES = {
  apertura: '#2eb886',   // verde: solicitud recibida
  respuesta: '#1264a3',  // azul: responde el soporte
  historial: '#a0a0a0',  // gris claro: resumen de lo anterior a la integracion
  reapertura: '#e8912d', // naranja: el ticket vuelve a estar vivo
  cierre: '#616061',     // gris: resuelto, el canal esta a punto de irse
};

/** "El PC no arranca" -> "el-pc-no-arranca" */
function slug(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // fuera acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Nombre de canal: minusculas, sin espacios ni puntos, maximo 80 caracteres.
 * El id va siempre delante y garantiza que no haya colisiones; el titulo es
 * lo que hace que el canal se reconozca de un vistazo en la barra lateral.
 */
/**
 * `ticket-prueba-api-glpi-en-slack-02-6215`
 * El id va siempre al final: hace el nombre unico sin excepciones, asi que dos
 * tickets con el mismo titulo nunca pueden acabar compartiendo canal. El titulo
 * se recorta si hace falta, nunca el id.
 */
export function channelNameForTicket(ticketId, title, { reapertura = 0 } = {}) {
  // Cada reapertura estrena canal: -r2, -r3... El anterior se queda archivado.
  const reabierto = reapertura > 0 ? `-r${reapertura + 1}` : '';
  const sufijo = `-${ticketId}${reabierto}`;
  if (!config.channelIncludeTitle) return `${config.channelPrefix}${ticketId}${reabierto}`;

  const hueco = 80 - config.channelPrefix.length - sufijo.length;
  const cola = slug(title).slice(0, Math.max(hueco, 0)).replace(/-+$/, '');
  return cola
    ? `${config.channelPrefix}${cola}${sufijo}`
    : `${config.channelPrefix}${ticketId}${reabierto}`;
}

// El email de una persona no cambia entre sondeos: se cachea para no gastar
// llamadas a users.lookupByEmail, que tiene limite de 50 por minuto.
const cacheSlackIds = new Map();

/** Resuelve una lista de correos a IDs de Slack, saltandose los que no existan. */
export async function resolverDestinatarios(client, correos) {
  const ids = [];
  for (const correo of correos) {
    if (!cacheSlackIds.has(correo)) {
      cacheSlackIds.set(correo, await findSlackUserByEmail(client, correo).catch(() => null));
    }
    const id = cacheSlackIds.get(correo);
    if (id) ids.push(id);
    else log.warn(`Aviso al equipo: ${correo} no tiene cuenta de Slack`);
  }
  return ids;
}

export async function findSlackUserByEmail(client, email) {
  if (!email) return null;
  try {
    const res = await client.users.lookupByEmail({ email });
    return res.user?.id || null;
  } catch (err) {
    if (err?.data?.error === 'users_not_found') return null;
    throw err;
  }
}

async function findPrivateChannelByName(client, name) {
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'private_channel',
      exclude_archived: false,
      limit: 200,
      cursor,
    });
    const found = (res.channels || []).find((c) => c.name === name);
    if (found) return found;
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

/**
 * Crea (o recupera) la conversacion Slack de un ticket y la persiste.
 * Modo 'channel': canal privado dedicado -> se puede archivar al cerrar.
 * Modo 'dm': conversacion directa -> solo se pueden borrar los mensajes del bot.
 */
export async function ensureConversation(client, { ticket, requesters, technician }) {
  const existing = store.getConversationByTicket(ticket.id);
  if (existing && !existing.cleaned_at) return existing;

  const solicitantes = requesters.filter((r) => r.email);
  const requester = solicitantes[0] || requesters[0] || { users_id: 0, email: null };

  if (config.dryRun) {
    log.info(
      `[DRY RUN] Crearia conversacion para el ticket ${ticket.id} -> `
      + solicitantes.map((r) => r.email).join(', '),
    );
    store.reopenConversation(ticket.id);
    return store.saveConversation({
      ticket_id: ticket.id,
      channel_id: `DRY-${ticket.id}`,
      channel_name: channelNameForTicket(ticket.id, ticket.name),
      slack_user_id: null,
      glpi_user_id: requester.users_id,
      status: Number(ticket.status),
    });
  }

  // Todos los solicitantes entran al canal, no solo el primero.
  const slackIds = [];
  for (const r of solicitantes) {
    const id = await findSlackUserByEmail(client, r.email);
    if (id) slackIds.push(id);
    else log.warn(`Ticket ${ticket.id}: sin usuario Slack para ${r.email}`);
  }
  if (slackIds.length === 0) {
    log.warn(`Ticket ${ticket.id}: ningun solicitante tiene cuenta de Slack`);
    return null;
  }
  const slackUserId = slackIds[0];

  if (config.mode === 'dm') {
    const im = await client.conversations.open({ users: slackUserId });
    return store.saveConversation({
      ticket_id: ticket.id,
      channel_id: im.channel.id,
      channel_name: null,
      slack_user_id: slackUserId,
      glpi_user_id: requester.users_id,
      status: Number(ticket.status),
    });
  }

  let channelId = null;

  // Una reapertura estrena canal en vez de resucitar el viejo: al cerrar se
  // borraron los mensajes del bot pero no los del usuario, asi que reutilizarlo
  // dejaria una conversacion a medias, con las respuestas de uno solo.
  const esReapertura = Boolean(existing?.cleaned_at);
  const vuelta = esReapertura ? store.bumpReopenCount(ticket.id) : (existing?.reopen_count ?? 0);
  let name = channelNameForTicket(ticket.id, ticket.name, { reapertura: vuelta });

  // Canal ya existente y vivo para este ticket: se reutiliza por id.
  if (!esReapertura && existing?.channel_id && !existing.channel_id.startsWith('DRY-')) {
    channelId = existing.channel_id;
    name = existing.channel_name || name;
    await client.conversations.unarchive({ channel: channelId }).catch((err) => {
      if (err?.data?.error !== 'not_archived') throw err;
    });
  }

  if (!channelId) {
    try {
      const created = await client.conversations.create({ name, is_private: true });
      channelId = created.channel.id;
    } catch (err) {
      if (err?.data?.error !== 'name_taken') throw err;

      // El nombre lleva el id, asi que solo puede estar ocupado por este mismo
      // ticket: un canal que quedo huerfano de un arranque anterior.
      const found = await findPrivateChannelByName(client, name);
      if (!found) throw err;
      channelId = found.id;
      if (found.is_archived) await client.conversations.unarchive({ channel: channelId });
    }
  }

  const invitees = [...new Set(slackIds)];
  if (config.inviteTechnician && technician?.slackUserId) invitees.push(technician.slackUserId);
  await client.conversations.invite({ channel: channelId, users: invitees.join(',') })
    .catch((err) => {
      if (!['already_in_channel', 'cant_invite_self'].includes(err?.data?.error)) throw err;
    });
  // Queda constancia de a quien hemos invitado: el resto sobra en este canal.
  invitees.forEach((u) => store.rememberInvited(channelId, u));

  store.saveConversation({
    ticket_id: ticket.id,
    channel_id: channelId,
    channel_name: name,
    slack_user_id: slackUserId,
    glpi_user_id: requester.users_id,
    status: Number(ticket.status),
  });

  // Si veniamos de un ticket cerrado y limpiado, hay que revivir la fila entera.
  if (existing?.cleaned_at) {
    log.info(`Ticket ${ticket.id} reabierto: conversacion restaurada en ${channelId}`);
    return store.reopenConversation(ticket.id);
  }
  return store.getConversationByTicket(ticket.id);
}

/**
 * Slack archiva un canal privado cuando se queda sin miembros humanos, y sobre
 * un canal archivado no se puede ni invitar ni publicar. Si el ticket sigue
 * vivo, el canal tiene que volver a estarlo.
 *
 * Ejecuta la accion y, si falla por archivado, desarchiva y reintenta una vez.
 */
async function conCanalVivo(client, channelId, accion) {
  try {
    return await accion();
  } catch (err) {
    if (err?.data?.error !== 'is_archived') throw err;
    log.info(`Canal ${channelId} archivado y el ticket sigue abierto: desarchivando`);
    await client.conversations.unarchive({ channel: channelId }).catch((e) => {
      if (e?.data?.error !== 'not_archived') throw e;
    });
    return accion();
  }
}

/**
 * Se asegura de que siga en el canal todo el que el puente invito. Alguien pudo
 * salirse —o le sacaron— con el ticket aun abierto, y entonces las respuestas
 * del tecnico caerian en un canal que esa persona ya no ve.
 *
 * Se invita directamente en vez de listar los miembros primero: si ya esta
 * dentro, Slack responde `already_in_channel` y no hay nada que hacer. Una
 * llamada en vez de dos.
 */
export async function asegurarMiembros(client, conversation) {
  if (!config.reinviteOnReply || config.mode !== 'channel' || config.dryRun) return;

  for (const { user_id: userId } of store.listInvited(conversation.channel_id)) {
    try {
      await conCanalVivo(client, conversation.channel_id, () =>
        client.conversations.invite({ channel: conversation.channel_id, users: userId }));
      log.info(
        `Ticket ${conversation.ticket_id}: ${userId} se habia salido del canal `
        + 'y se le ha vuelto a invitar',
      );
    } catch (err) {
      const code = err?.data?.error;
      if (['already_in_channel', 'cant_invite_self'].includes(code)) continue;
      log.warn(`No se pudo reinvitar a ${userId} al ticket ${conversation.ticket_id}: ${code}`);
    }
  }
}

/** Publica y recuerda el ts, para poder borrar el mensaje al cerrar el ticket. */
/**
 * Envuelve los bloques en un adjunto de color, si esta activado.
 *
 * El texto de la notificacion NO puede ir ademas como `text`: Slack lo pintaria
 * encima del adjunto y saldria duplicado. Dentro del adjunto va como `fallback`,
 * que es lo que usa el aviso del movil.
 */
function conColor(blocks, color, texto) {
  if (!color || !config.messageColors) return { blocks, text: truncate(texto) };
  return { attachments: [{ color, blocks, fallback: truncate(texto) }] };
}

export async function postToConversation(client, conversation, { text, blocks, color, threadTs }) {
  if (config.dryRun) {
    const cuerpo = blocks?.find((b) => b.type === 'section')?.text?.text ?? text;
    log.info(`[DRY RUN] Publicaria en el ticket ${conversation.ticket_id}: ${String(cuerpo).slice(0, 300)}`);
    return null;
  }
  const res = await conCanalVivo(client, conversation.channel_id, () =>
    client.chat.postMessage({
      channel: conversation.channel_id,
      ...conColor(blocks, color, text),
      thread_ts: threadTs || (config.mode === 'dm' ? conversation.root_ts : undefined),
      unfurl_links: false,
      unfurl_media: false,
    }));
  store.rememberBotMessage(conversation.ticket_id, conversation.channel_id, res.ts);
  if (!conversation.root_ts) {
    store.saveConversation({ ...conversation, root_ts: res.ts });
  }
  return res.ts;
}

let botUserIdCache = null;
async function getBotUserId(client) {
  if (!botUserIdCache) {
    const auth = await client.auth.test();
    botUserIdCache = auth.user_id;
  }
  return botUserIdCache;
}

async function deleteBotMessages(client, conversation) {
  for (const msg of store.listBotMessages(conversation.ticket_id)) {
    try {
      await client.chat.delete({ channel: msg.channel_id, ts: msg.ts });
    } catch (err) {
      const code = err?.data?.error;
      if (!['message_not_found', 'channel_not_found', 'cant_delete_message'].includes(code)) {
        log.warn(`No se pudo borrar ${msg.ts} del ticket ${conversation.ticket_id}: ${code}`);
      }
    }
  }
  store.forgetBotMessages(conversation.ticket_id);

  // Los ficheros subidos por el bot no desaparecen al borrar el mensaje:
  // hay que borrar el fichero en si.
  for (const { file_id: fileId } of store.listBotFiles(conversation.ticket_id)) {
    try {
      await client.files.delete({ file: fileId });
    } catch (err) {
      const code = err?.data?.error;
      if (!['file_not_found', 'file_deleted'].includes(code)) {
        log.warn(`No se pudo borrar el fichero ${fileId}: ${code}`);
      }
    }
  }
  store.forgetBotFiles(conversation.ticket_id);
}

/**
 * Expulsa a todos los humanos del canal privado.
 * Esta es la pieza clave para que el ticket DESAPAREZCA del cliente del usuario:
 * un canal privado del que no eres miembro no aparece en la barra lateral, ni en
 * "canales archivados", ni en los resultados de busqueda. Archivar sin expulsar
 * deja el canal accesible para quien fue miembro.
 * Debe hacerse ANTES de archivar: en un canal archivado ya no se puede expulsar.
 */
async function kickMembers(client, conversation) {
  const botUserId = await getBotUserId(client);
  let cursor;
  const humans = [];
  do {
    const res = await client.conversations.members({
      channel: conversation.channel_id, limit: 200, cursor,
    });
    humans.push(...(res.members || []).filter((u) => u !== botUserId));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const user of humans) {
    try {
      await client.conversations.kick({ channel: conversation.channel_id, user });
    } catch (err) {
      const code = err?.data?.error;
      if (['cant_kick_self', 'not_in_channel', 'user_not_found'].includes(code)) continue;
      if (code === 'restricted_action') {
        await alerta(
          'permisos-expulsar',
          'No se pueden cerrar los canales de los tickets resueltos',
          'El workspace restringe quién puede retirar miembros de canales privados, así que '
          + 'los usuarios siguen viendo conversaciones de tickets ya cerrados. Se ajusta en '
          + 'Settings & administration → Workspace settings → Permissions.',
        );
        continue;
      }
      log.warn(`No se pudo expulsar a ${user}: ${code}`);
    }
  }
  return humans.length;
}

/**
 * Sube a la conversacion los adjuntos que venian con el seguimiento de GLPI.
 * Se registran para poder borrarlos al cerrar el ticket.
 */
export async function uploadDocuments(client, conversation, documentos, followupId = null) {
  for (const doc of documentos) {
    if (config.dryRun) {
      log.info(`[DRY RUN] Subiria ${doc.filename} (${doc.buffer.length} bytes) al ticket ${conversation.ticket_id}`);
      continue;
    }
    try {
      const res = await client.files.uploadV2({
        channel_id: conversation.channel_id,
        file: doc.buffer,
        filename: doc.filename,
        title: doc.title || doc.filename,
      });
      for (const f of res.files || []) {
        const id = f.id || f.files?.[0]?.id;
        if (id) store.rememberBotFile(conversation.ticket_id, id, followupId);
        for (const sub of f.files || []) {
          if (sub.id) store.rememberBotFile(conversation.ticket_id, sub.id, followupId);
        }
      }
      log.info(`Ticket ${conversation.ticket_id}: adjunto ${doc.filename} subido a Slack`);
    } catch (err) {
      const code = err?.data?.error;
      if (code === 'missing_scope') {
        await alerta(
          'permisos-ficheros',
          'Falta el permiso files:write en la app de Slack',
          'Los adjuntos de GLPI no se pueden subir. Añádelo en OAuth & Permissions y reinstala la app.',
        );
      } else {
        log.warn(`No se pudo subir ${doc.filename}: ${code || err.message}`);
      }
    }
  }
}

/**
 * Limpieza al cerrar el ticket. Tres niveles, de menos a mas definitivo:
 *
 *   archive  el canal queda archivado pero el ex-miembro lo sigue viendo
 *   purge    se borran los mensajes del bot, se expulsa a los miembros y se
 *            archiva -> para el usuario el ticket deja de existir (por defecto)
 *   delete   ademas, admin.conversations.delete borra el canal de verdad;
 *            requiere Enterprise Grid y SLACK_ADMIN_TOKEN
 *
 * Lo que NINGUN modo puede hacer: borrar los mensajes escritos por el propio
 * usuario. Un bot solo puede borrar los suyos. Por eso 'purge' retira el acceso
 * en vez de borrarlos, y por eso existe REPLY_MODE=modal (el usuario no llega a
 * escribir ningun mensaje en Slack, asi que no queda ninguno que borrar).
 */
export async function cleanupConversation(client, conversation) {
  const { cleanupMode } = config;
  const isChannel = config.mode === 'channel';

  if (config.dryRun) {
    log.info(`[DRY RUN] Limpiaria el ticket ${conversation.ticket_id} (${cleanupMode})`);
    store.markCleaned(conversation.ticket_id);
    return;
  }

  if (cleanupMode !== 'archive') await deleteBotMessages(client, conversation);

  if (isChannel && cleanupMode !== 'archive') {
    const kicked = await kickMembers(client, conversation);
    log.info(`Ticket ${conversation.ticket_id}: ${kicked} miembro(s) retirados del canal`);
  }

  if (isChannel) {
    try {
      await client.conversations.archive({ channel: conversation.channel_id });
    } catch (err) {
      const code = err?.data?.error;
      if (code !== 'already_archived') {
        log.warn(`No se pudo archivar ${conversation.channel_id}: ${code}`);
      }
    }
  }

  if (cleanupMode === 'delete' && isChannel) {
    if (!adminClient) {
      log.error('CLEANUP_MODE=delete requiere SLACK_ADMIN_TOKEN (Enterprise Grid). Canal solo archivado.');
    } else {
      try {
        await adminClient.admin.conversations.delete({ channel_id: conversation.channel_id });
        log.info(`Canal ${conversation.channel_id} eliminado definitivamente`);
      } catch (err) {
        log.error(`admin.conversations.delete fallo: ${err?.data?.error}. El canal queda archivado.`);
      }
    }
  }

  if (!isChannel) {
    log.warn(
      `Ticket ${conversation.ticket_id}: en modo DM solo se han borrado los mensajes del bot. ` +
      'Las respuestas del usuario permanecen en su conversacion directa. ' +
      'Usa CONVERSATION_MODE=channel si necesitas que no quede rastro.',
    );
  }

  store.forgetMessageLinks(conversation.ticket_id);
  store.markCleaned(conversation.ticket_id);
  log.info(`Conversacion del ticket ${conversation.ticket_id} limpiada (${cleanupMode})`);
}

export const REPLY_ACTION_ID = 'glpi_reply_open';
export const REPLY_VIEW_ID = 'glpi_reply_submit';
export const OPEN_GLPI_ACTION_ID = 'glpi_open_ticket';
export const REOPEN_ACTION_ID = 'glpi_reopen_ticket';

/** Texto de la notificacion push: es lo unico que se lee en el movil. */
/** Descarga un fichero de Slack usando el token del bot. */
export async function downloadSlackFile(file) {
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error(`el fichero ${file.name || file.id} no trae URL de descarga`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slack.botToken}` } });
  if (!res.ok) throw new Error(`descarga de ${file.name} -> ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Slack devuelve HTML de login en vez de un 401 cuando falta files:read.
  if (buffer.subarray(0, 15).toString('utf8').toLowerCase().includes('<!doctype html')) {
    throw new Error('Slack no ha devuelto el fichero: falta el permiso files:read');
  }
  return { buffer, filename: file.name || `slack-${file.id}`, mime: file.mimetype };
}

export function notificationText(ticket, authorName) {
  const quien = authorName ? ` de ${authorName}` : '';
  return `Nueva respuesta${quien} en tu ticket #${ticket.id} — ${ticket.name || ''}`.trim();
}

/**
 * Retira de Slack un mensaje ya publicado y los ficheros que lo acompanaban.
 * Se usa cuando el tecnico oculta o borra el seguimiento en GLPI: si alli ha
 * dejado de ser visible, aqui tampoco debe estarlo.
 */
export async function retirarMensaje(client, { channelId, ts, followupId }) {
  if (config.dryRun) {
    log.info(`[DRY RUN] Retiraria el mensaje ${ts} de ${channelId}`);
    return;
  }

  try {
    await client.chat.delete({ channel: channelId, ts });
  } catch (err) {
    const code = err?.data?.error;
    if (!['message_not_found', 'channel_not_found'].includes(code)) {
      log.warn(`No se pudo retirar el mensaje ${ts}: ${code}`);
    }
  }
  store.forgetBotMessage(channelId, ts);

  for (const { file_id: fileId } of store.listBotFilesByFollowup(followupId)) {
    await client.files.delete({ file: fileId }).catch((err) => {
      const code = err?.data?.error;
      if (!['file_not_found', 'file_deleted'].includes(code)) {
        log.warn(`No se pudo retirar el fichero ${fileId}: ${code}`);
      }
    });
    store.forgetBotFile(fileId);
  }
}

/** Reescribe un mensaje ya publicado (cuando el tecnico edita el seguimiento). */
export async function updateMessage(client, { channelId, ts, text, blocks, color }) {
  if (config.dryRun) {
    log.info(`[DRY RUN] Actualizaria el mensaje ${ts} de ${channelId}`);
    return;
  }
  await client.chat.update({
    channel: channelId, ts, ...conColor(blocks, color, text),
  });
}

export function followupBlocks({ ticket, authorName, body, glpiTicketUrl, isFirst, edited }) {
  // Caso normal: el canal ya se abrio con la solicitud, asi que aqui sobra el
  // titulo, el separador y las instrucciones. Solo quien responde y que dice.
  if (!isFirst) {
    const blocks = [
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: [
            `:speech_balloon:  Respuesta de *${escapeSlack(authorName || 'Soporte')}*`,
            edited ? '· _editado_' : null,
          ].filter(Boolean).join(' '),
        }],
      },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(body || '_(sin contenido)_') } },
    ];
    return blocks;
  }

  // Solo cuando el seguimiento es lo primero que abre el canal (tickets que ya
  // existian antes de activar la integracion).
  const titulo = escapeSlack(ticket.name || 'Sin título');
  const firma = [
    authorName ? `respuesta de *${escapeSlack(authorName)}*` : 'nueva respuesta del soporte',
    edited ? '· _editado_' : null,
  ].filter(Boolean).join(' ');

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${titulo}*\n\`#${ticket.id}\`  ·  ${firma}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(body || '_(sin contenido)_') } },
  ];

  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        text: { type: 'plain_text', text: 'Ver en GLPI', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Escribe en este canal para responder. Desaparecerá cuando el ticket se resuelva.',
    }],
  });
  return blocks;
}

/** Primer mensaje del canal: la solicitud tal y como la escribio el usuario. */
export function ticketOpenedBlocks({ ticket, body, glpiTicketUrl }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlack(ticket.name || 'Sin título')}*\n\`#${ticket.id}\`  ·  _solicitud recibida_`,
      },
    },
  ];
  if (body) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(body) } });
  }
  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        text: { type: 'plain_text', text: 'Ver en GLPI', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Te avisaremos por aquí. Escribe en el canal para añadir información. '
        + 'Desaparecerá cuando el ticket se resuelva.',
    }],
  });
  return blocks;
}

/**
 * Cabecera para los tickets que ya estaban abiertos antes de la integracion.
 * Sin esto el usuario aterriza en un canal con una respuesta suelta y sin saber
 * de que ticket le hablan.
 */
export function historyBlocks({ ticket, solicitud, anteriores, total, glpiTicketUrl }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlack(ticket.name || 'Sin título')}*\n\`#${ticket.id}\`  ·  _ticket ya en curso_`,
      },
    },
  ];

  if (solicitud) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Tu solicitud:*\n${truncate(solicitud, 1200)}` },
    });
  }

  for (const m of anteriores) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:speech_balloon:  *${escapeSlack(m.autor || 'Soporte')}*` }],
    });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(m.texto, 900) } });
  }

  const ocultos = Math.max(total - anteriores.length, 0);
  const aviso = ocultos > 0
    ? `Hay ${ocultos} mensaje(s) anteriores que no se muestran aquí.`
    : 'Esta es la conversación que llevabais hasta ahora.';

  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        text: { type: 'plain_text', text: 'Ver el ticket completo', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${aviso} A partir de ahora seguimos por aquí.` }],
  });
  return blocks;
}

/**
 * Avisa al equipo de soporte por Slack. Sin esto, la reapertura solo se ve
 * entrando en GLPI o en el correo que nadie lee, que es el problema que esta
 * integracion venia a resolver.
 *
 * Intenta primero el mensaje directo al tecnico asignado; si no hay tecnico o
 * no tiene cuenta de Slack, cae al canal del equipo.
 */
export async function avisarSoporte(client, { tecnicoSlackId, destinatarios, texto, blocks }) {
  const destinos = [];
  if (destinatarios?.length) {
    destinos.push(...destinatarios);
  } else {
    if (config.notifyTechnician && tecnicoSlackId) destinos.push(tecnicoSlackId);
    if (config.teamChannel && (!tecnicoSlackId || !config.notifyTechnician)) {
      destinos.push(config.teamChannel);
    }
  }
  if (destinos.length === 0) {
    log.debug('Aviso sin destinatario en Slack: ni tecnico asignado, ni lista, ni TEAM_CHANNEL');
    return;
  }

  for (const destino of destinos) {
    if (config.dryRun) {
      log.info(`[DRY RUN] Avisaria a ${destino}: ${texto}`);
      continue;
    }
    try {
      await client.chat.postMessage({
        channel: destino, text: truncate(texto), blocks, unfurl_links: false,
      });
    } catch (err) {
      const code = err?.data?.error;
      if (code === 'not_in_channel' || code === 'channel_not_found') {
        log.error(
          `No se pudo avisar en ${destino}: el bot no esta en ese canal. `
          + 'Invitalo con /invite @GLPI TicketBot o corrige TEAM_CHANNEL.',
        );
      } else {
        log.warn(`No se pudo avisar a ${destino}: ${code || err.message}`);
      }
    }
  }
}

/** El ticket ya no existe en GLPI: alguien lo borro. */
export function deletedTicketBlocks(ticketId) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wastebasket:  *Ticket eliminado*\n\`#${ticketId}\` ya no existe en GLPI, `
          + 'así que esta conversación se cierra.',
      },
    },
  ];
}

/** Ha entrado un ticket nuevo en GLPI. */
export function nuevoTicketBlocks({ ticket, solicitante, categoria, glpiTicketUrl }) {
  const detalles = [
    solicitante ? `*Solicitante:* ${escapeSlack(solicitante)}` : null,
    categoria ? `*Categoría:* ${escapeSlack(categoria)}` : null,
  ].filter(Boolean).join('   ·   ');

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:inbox_tray:  *Ticket nuevo*\n\`#${ticket.id}\`  ·  `
          + `*${escapeSlack(ticket.name || 'Sin título')}*`,
      },
    },
  ];
  if (detalles) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: detalles }] });

  const cuerpo = truncate(glpiHtmlToSlackSeguro(ticket.content), 700);
  if (cuerpo) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cuerpo } });

  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        text: { type: 'plain_text', text: 'Abrir en GLPI', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  return blocks;
}

/** Alguien ha respondido en un ticket que tienes asignado. */
export function respuestaEnTicketBlocks({ ticket, autor, texto, glpiTicketUrl }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:speech_balloon:  *Respuesta en tu ticket*\n\`#${ticket.id}\`  ·  `
          + `${escapeSlack(ticket.name || '')}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlack(autor || 'El solicitante')}* escribe:\n`
          + `>${truncate(String(texto || '').replace(/\n/g, '\n>'), 800)}`,
      },
    },
  ];
  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        style: 'primary',
        text: { type: 'plain_text', text: 'Responder en GLPI', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  return blocks;
}

/** Aviso al equipo: un ticket que dabais por cerrado vuelve a estar vivo. */
export function avisoReaperturaBlocks({ ticket, quien, mensaje, glpiTicketUrl }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:arrows_counterclockwise:  *Ticket reabierto por el usuario*\n`
          + `\`#${ticket.id}\`  ·  ${escapeSlack(ticket.name || '')}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlack(quien || 'El solicitante')}* ha respondido tras el cierre:\n`
          + `>${truncate(String(mensaje || '').replace(/\n/g, '\n>'), 800)}`,
      },
    },
  ];
  if (glpiTicketUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: OPEN_GLPI_ACTION_ID,
        style: 'primary',
        text: { type: 'plain_text', text: 'Abrir el ticket', emoji: false },
        url: glpiTicketUrl,
      }],
    });
  }
  return blocks;
}

/** Aviso de que el ticket vuelve a estar abierto porque el usuario ha escrito. */
export function reopenedBlocks({ ticket, quien }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:arrows_counterclockwise:  *Ticket reabierto*\n\`#${ticket.id}\`  ·  `
          + `${escapeSlack(quien || 'el solicitante')} ha respondido tras el cierre.`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'El equipo de soporte lo verá de nuevo en su cola. Este canal se queda abierto.',
      }],
    },
  ];
}

/** Aviso de cierre, con el mismo lenguaje visual que el resto. */
/** "45 segundos", "5 minutos", "24 horas" */
function describirEspera(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} segundos`;
  const minutos = Math.round(ms / 60000);
  if (minutos < 60) return `${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`;
  const horas = Math.round(minutos / 60);
  return `${horas} ${horas === 1 ? 'hora' : 'horas'}`;
}

export function closureBlocks({ ticket, solutionText, delayMs, reabiertoPor = null }) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark:  *Ticket resuelto*\n\`#${ticket.id}\`  ·  ${escapeSlack(ticket.name || '')}`,
      },
    },
  ];
  if (solutionText) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(solutionText) } });
  }
  // Reabrir tiene que ser un acto consciente: por eso un boton, y no el simple
  // hecho de escribir. Una vez usado, desaparece.
  if (!reabiertoPor) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: REOPEN_ACTION_ID,
        style: 'danger',
        text: { type: 'plain_text', text: 'Sigo con el problema', emoji: false },
        value: String(ticket.id),
      }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: reabiertoPor
        ? `:arrows_counterclockwise:  Reabierto por ${escapeSlack(reabiertoPor)}.`
        : [
          delayMs > 0
            ? `Este canal desaparecerá en ${describirEspera(delayMs)}.`
            : 'Este canal desaparecerá ahora.',
          'Si el problema sigue, pulsa el botón antes de que se cierre.',
        ].join(' '),
    }],
  });
  return blocks;
}
