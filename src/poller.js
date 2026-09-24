import crypto from 'node:crypto';
import { config, CLOSED_STATUSES } from './config.js';
import { log } from './log.js';
import * as store from './store.js';
import { glpi, glpiDateToIso, glpiTicketUrl as ticketUrl } from './glpi.js';
import { alerta, recuperado } from './alerts.js';
import { glpiHtmlToSlack, extractGlpiDocIds } from './format.js';
import {
  ensureConversation, postToConversation, cleanupConversation, uploadDocuments,
  updateMessage, retirarMensaje, asegurarMiembros, followupBlocks, closureBlocks,
  ticketOpenedBlocks, historyBlocks, deletedTicketBlocks, notificationText,
  nuevoTicketBlocks, respuestaEnTicketBlocks, avisarSoporte, resolverDestinatarios,
  findSlackUserByEmail, COLORES,
} from './slack.js';

/**
 * REQUISITO CRITICO: nada retroactivo.
 * En el primer arranque el cursor se fija en "ahora". Todo lo anterior queda
 * fuera para siempre; solo se procesan eventos posteriores a la activacion.
 */
export function bootstrapCursor() {
  const now = new Date().toISOString();
  if (!store.getCursor()) {
    store.setCursor(now);
    store.setActivatedAt(now);
    log.info(`Primera activacion. Cursor fijado en ${now}. No se procesara nada anterior.`);
    return;
  }

  const cursor = store.getCursor();
  const horasParado = (Date.now() - new Date(cursor).getTime()) / 3600000;

  // Un puente que ha estado caido dias procesaria de golpe todo lo acumulado:
  // decenas de canales abriendose a la vez y los limites de Slack saltando.
  if (config.maxCatchupHours > 0 && horasParado > config.maxCatchupHours) {
    store.setCursor(now);
    log.warn(
      `El cursor llevaba ${Math.round(horasParado)} h parado (limite ${config.maxCatchupHours} h). ` +
      'Se reinicia a ahora: lo ocurrido mientras el puente estuvo caido NO se enviara.',
    );
    return;
  }

  if (horasParado > 2) {
    log.warn(
      `Reanudando desde ${cursor}, hace ${Math.round(horasParado)} h. Se procesara todo lo ` +
      'ocurrido en ese intervalo. Si no es lo que quieres, para el puente y ejecuta npm run cursor:reset.',
    );
  } else {
    log.info(`Reanudando desde el cursor ${cursor}`);
  }
}

const hashContenido = (contenido) =>
  crypto.createHash('sha1').update(String(contenido || '')).digest('hex');

async function authorNameOf(usersId) {
  if (!usersId) return null;
  const user = await glpi.getUser(usersId);
  if (!user) return null;
  return [user.firstname, user.realname].filter(Boolean).join(' ') || user.name || null;
}

/**
 * Aplica los filtros de seguridad y abre la conversacion si procede.
 * Devuelve { conversation, motivo }: si conversation es null, motivo explica
 * por que se descarto, para poder marcar los seguimientos y no reintentar.
 */
async function crearConversacion(client, ticket) {
  if (config.onlyNewTickets) {
    const created = glpiDateToIso(ticket.date_creation);
    const activated = store.getActivatedAt();
    if (created && activated && new Date(created) < new Date(activated)) {
      log.debug(`Ticket ${ticket.id} anterior a la activacion; omitido por configuracion`);
      return { conversation: null, motivo: 'skipped' };
    }
  }

  let requesters = await glpi.getRequesters(ticket.id, ticket);

  // Interruptor de seguridad para pruebas: con lista blanca activa, el ticket
  // solo se atiende si algun solicitante esta en ella, y ademas solo se invita
  // a los que esten: un ticket compartido no arrastra a gente fuera del piloto.
  const allow = config.allowedRequesterEmails;
  if (allow.length > 0) {
    const permitidos = requesters.filter(
      (r) => allow.includes(String(r.email || '').toLowerCase()),
    );
    if (permitidos.length === 0) {
      log.debug(`Ticket ${ticket.id}: ningun solicitante en la lista blanca, omitido`);
      return { conversation: null, motivo: 'not-allowed' };
    }
    if (permitidos.length < requesters.length) {
      log.info(
        `Ticket ${ticket.id}: ${requesters.length - permitidos.length} solicitante(s) `
        + 'fuera de la lista blanca no entran al canal',
      );
    }
    requesters = permitidos;
  }

  let technician = null;
  if (config.inviteTechnician) {
    technician = await glpi.getAssignedTechnician(ticket.id);
    if (technician?.email) {
      technician.slackUserId = await findSlackUserByEmail(client, technician.email);
    }
  }

  const conversation = await ensureConversation(client, { ticket, requesters, technician });
  if (!conversation) {
    const correos = requesters.map((r) => r.email || '(sin correo)').join(', ');
    await alerta(
      `sin-slack:${correos}`,
      'Un usuario no recibe sus tickets en Slack',
      `El ticket #${ticket.id} tiene como solicitante a ${correos}, que no corresponde con `
      + 'ninguna cuenta de Slack. Esa persona no se enterará de las respuestas.',
    );
  }
  return { conversation, motivo: conversation ? null : 'no-slack-user' };
}

/**
 * Si anaden un solicitante al ticket despues de crear el canal, hay que meterlo
 * tambien en la conversacion. Se compara con una sola llamada a GLPI: solo
 * cuando aparece alguien nuevo se resuelve su correo y su cuenta de Slack.
 */
async function sincronizarSolicitantes(client, ticket, conversation) {
  if (config.mode !== 'channel' || conversation.cleaned_at) return;

  const claves = await glpi.getRequesterKeys(ticket.id).catch(() => []);
  const nuevas = claves.filter((k) => !store.isRequesterKnown(ticket.id, k));
  if (nuevas.length === 0) return;

  // Ya sabemos que hay alguien nuevo: ahora si toca resolver quien es.
  const requesters = await glpi.getRequesters(ticket.id, ticket);
  const allow = config.allowedRequesterEmails;

  for (const clave of nuevas) {
    store.rememberRequester(ticket.id, clave);

    const r = requesters.find(
      (x) => String(x.users_id) === clave || `email:${x.email}` === clave,
    );
    if (!r?.email) continue;

    // Con lista blanca activa, un solicitante anadido que no este en ella no
    // entra: si no, un ticket compartido colaria gente fuera del piloto.
    if (allow.length > 0 && !allow.includes(r.email.toLowerCase())) {
      log.info(`Ticket ${ticket.id}: ${r.email} anadido como solicitante pero fuera de la lista blanca`);
      continue;
    }

    const slackId = await findSlackUserByEmail(client, r.email);
    if (!slackId) {
      log.warn(`Ticket ${ticket.id}: ${r.email} anadido como solicitante pero sin cuenta de Slack`);
      continue;
    }
    if (store.isInvited(conversation.channel_id, slackId)) continue;

    await client.conversations
      .invite({ channel: conversation.channel_id, users: slackId })
      .catch((err) => {
        if (!['already_in_channel', 'cant_invite_self'].includes(err?.data?.error)) throw err;
      });
    store.rememberInvited(conversation.channel_id, slackId);
    log.info(`Ticket ${ticket.id}: ${r.email} anadido como solicitante, invitado al canal`);
  }
}

/**
 * Avisa al equipo de cada ticket que entra. Va aparte de la conversacion con el
 * usuario y NO mira la lista blanca: al equipo le interesan todos los tickets,
 * no solo los del piloto.
 */
async function anunciarTicketNuevo(client, ticket, sinceMs) {
  if (!config.notifyNewTickets) return;
  if (config.newTicketRecipients.length === 0 && !config.teamChannel) return;
  if (store.isTicketAnnounced(ticket.id)) return;

  const creado = glpiDateToIso(ticket.date_creation);
  if (!creado || new Date(creado).getTime() <= sinceMs) return;   // nada retroactivo

  store.markTicketAnnounced(ticket.id);

  const requesters = await glpi.getRequesters(ticket.id, ticket).catch(() => []);
  const solicitante = requesters.map((r) => r.name || r.email).filter(Boolean).join(', ');

  await avisarSoporte(client, {
    destinatarios: await resolverDestinatarios(client, config.newTicketRecipients),
    texto: `Ticket nuevo #${ticket.id} — ${ticket.name || ''}`.trim(),
    blocks: nuevoTicketBlocks({
      ticket, solicitante, categoria: null, glpiTicketUrl: ticketUrl(ticket.id),
    }),
  });
  log.info(`Ticket ${ticket.id} anunciado al equipo`);
}

/**
 * Avisa al tecnico asignado de las respuestas que recibe en sus tickets.
 * Incluye las que llegan desde Slack (autor = la cuenta de servicio), que son
 * justamente las que antes solo se veian entrando en GLPI.
 */
async function avisarTecnicoDeRespuestas(client, ticket, followups, sinceMs) {
  if (!config.notifyTicketReplies) return;

  const nuevos = followups
    .filter((f) => Number(f.is_private) !== 1)
    .filter((f) => !store.isTechNotified(Number(f.id)))
    .filter((f) => {
      const iso = glpiDateToIso(f.date_creation || f.date);
      return iso && new Date(iso).getTime() > sinceMs;
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (nuevos.length === 0) return;

  const tecnico = await glpi.getAssignedTechnician(ticket.id);
  const tecnicoSlackId = tecnico?.email ? await findSlackUserByEmail(client, tecnico.email) : null;

  for (const f of nuevos) {
    store.markTechNotified(Number(f.id), ticket.id);

    // Su propia respuesta no se la contamos a el.
    if (tecnico?.users_id && Number(f.users_id) === Number(tecnico.users_id)) continue;

    const autor = Number(f.users_id) === config.glpi.bridgeUserId
      ? (await glpi.getRequesters(ticket.id, ticket).catch(() => []))[0]?.name || 'El solicitante'
      : await authorNameOf(Number(f.users_id));

    await avisarSoporte(client, {
      tecnicoSlackId,
      texto: `Respuesta en el ticket #${ticket.id} de ${autor}`,
      blocks: respuestaEnTicketBlocks({
        ticket, autor, texto: glpiHtmlToSlack(f.content), glpiTicketUrl: ticketUrl(ticket.id),
      }),
    });
    log.info(`Ticket ${ticket.id}: avisado del seguimiento ${f.id} al tecnico asignado`);
  }
}

/** Sube a Slack los adjuntos referenciados por un contenido de GLPI. */
async function enviarAdjuntos(client, conversation, docIds, ticketId, followupId = null) {
  if (!docIds.length) return;
  const documentos = [];
  for (const id of docIds) {
    try {
      documentos.push(await glpi.downloadDocument(id));
    } catch (err) {
      await alerta(
        'adjunto-glpi',
        'No se pudo llevar un adjunto de GLPI a Slack',
        `Documento ${id} del ticket #${ticketId}: ${err.message}`,
      );
    }
  }
  await uploadDocuments(client, conversation, documentos, followupId);
}

/**
 * El canal se abre en cuanto se crea el ticket, con la solicitud del usuario
 * como primer mensaje. Asi el usuario ve desde el minuto uno donde va a recibir
 * las respuestas, en vez de que le aparezca un canal dias despues.
 */
async function handleNewTicket(client, ticket, sinceMs) {
  const existente = store.getConversationByTicket(ticket.id);
  if (existente && !existente.cleaned_at) return existente;

  const creado = glpiDateToIso(ticket.date_creation);
  if (!creado || new Date(creado).getTime() <= sinceMs) return null;  // nada retroactivo

  const { conversation } = await crearConversacion(client, ticket);
  if (!conversation) return null;

  const body = glpiHtmlToSlack(ticket.content);
  const ts = await postToConversation(client, conversation, {
    text: `Hemos recibido tu ticket #${ticket.id} — ${ticket.name || ''}`.trim(),
    blocks: ticketOpenedBlocks({ ticket, body, glpiTicketUrl: ticketUrl(ticket.id) }),
    color: COLORES.apertura,
  });
  log.info(`Ticket ${ticket.id} recien creado: canal abierto en ${conversation.channel_id}`);

  await enviarAdjuntos(client, conversation, [...new Set([
    ...extractGlpiDocIds(ticket.content),
    ...await glpi.getTicketDocumentIds(ticket.id),
  ])], ticket.id);

  return ts ? store.getConversationByTicket(ticket.id) : conversation;
}

/**
 * Los tickets que ya estaban abiertos cuando se activo la integracion estrenan
 * canal con una respuesta suelta y sin contexto: el usuario no sabe ni de que
 * ticket le hablan. Aqui se publica primero un resumen de lo que habia.
 */
async function publicarHistorial(client, ticket, conversation, previos) {
  const solicitud = glpiHtmlToSlack(ticket.content);
  const cuantos = config.historyMessages;

  const ultimos = cuantos > 0 ? previos.slice(-cuantos) : [];
  const anteriores = [];
  for (const f of ultimos) {
    anteriores.push({
      autor: await authorNameOf(Number(f.users_id)),
      texto: glpiHtmlToSlack(f.content),
    });
  }

  await postToConversation(client, conversation, {
    text: `Resumen del ticket #${ticket.id} — ${ticket.name || ''}`.trim(),
    color: COLORES.historial,
    blocks: historyBlocks({
      ticket, solicitud, anteriores, total: previos.length, glpiTicketUrl: ticketUrl(ticket.id),
    }),
  });
  log.info(`Ticket ${ticket.id}: publicado el resumen previo (${previos.length} mensajes anteriores)`);
}

/** Publica un seguimiento en el canal, con sus adjuntos. Devuelve la conversacion. */
async function publicarSeguimiento(client, ticket, conversation, f) {
  // Antes de publicar, que este quien tiene que leerlo.
  await asegurarMiembros(client, conversation);

  const author = await authorNameOf(Number(f.users_id));
  const body = glpiHtmlToSlack(f.content);
  const isFirst = !conversation.root_ts;

  const ts = await postToConversation(client, conversation, {
    text: notificationText(ticket, author),
    color: COLORES.respuesta,
    blocks: followupBlocks({
      ticket, authorName: author, body, glpiTicketUrl: ticketUrl(ticket.id), isFirst,
    }),
  });

  const actualizada = store.getConversationByTicket(ticket.id) || conversation;
  if (ts) {
    store.rememberFollowupMessage({
      followupId: Number(f.id),
      ticketId: ticket.id,
      channelId: actualizada.channel_id,
      ts,
      contentHash: hashContenido(f.content),
    });
  }

  // Adjuntos: las imagenes van incrustadas en el contenido, los PDF y demas
  // ficheros solo en Document_Item. Hay que mirar en los dos sitios.
  await enviarAdjuntos(client, actualizada, [...new Set([
    ...extractGlpiDocIds(f.content),
    ...await glpi.getFollowupDocumentIds(Number(f.id)),
  ])], ticket.id, Number(f.id));

  return actualizada;
}

/**
 * Lo contrario de retirar: un seguimiento que se oculto y vuelve a ser visible
 * en GLPI tiene que reaparecer en Slack. Se publica de nuevo, y aparece al
 * final del canal: Slack no permite insertar un mensaje en su sitio original.
 */
async function republicarSeguimientosVisibles(client, ticket, visibles, conversation) {
  for (const f of visibles) {
    const visto = store.getSeenFollowup(Number(f.id));
    if (visto?.origin !== 'retirado') continue;

    const actualizada = await publicarSeguimiento(client, ticket, conversation, f);
    store.updateFollowupOrigin(Number(f.id), 'glpi');
    log.info(`Ticket ${ticket.id}: seguimiento ${f.id} vuelve a ser visible, republicado`);
    Object.assign(conversation, actualizada);
  }
}

/**
 * Un seguimiento que ya viajo a Slack y que en GLPI ha dejado de ser visible:
 * el tecnico lo ha marcado como privado —tipicamente porque se equivoco de
 * destinatario— o lo ha borrado. Si alli ya no se ve, aqui tampoco.
 *
 * Se retira el mensaje y los ficheros que iban con el. Sin dejar rastro ni
 * aviso: si lo ocultaron fue por algo, y un "mensaje retirado" llamaria la
 * atencion justo sobre lo que se queria esconder. Si mas tarde vuelve a ser
 * visible en GLPI, se republica.
 */
async function retirarSeguimientosOcultos(client, ticket, followups) {
  const publicados = store.listFollowupMessages(ticket.id);
  if (publicados.length === 0) return;

  const porId = new Map(followups.map((f) => [Number(f.id), f]));

  for (const enviado of publicados) {
    const f = porId.get(enviado.followup_id);
    const borrado = !f;
    const oculto = f && Number(f.is_private) === 1;
    if (!borrado && !oculto) continue;

    await retirarMensaje(client, {
      channelId: enviado.channel_id,
      ts: enviado.ts,
      followupId: enviado.followup_id,
    });
    store.forgetFollowupMessage(enviado.followup_id);
    // 'retirado' en vez de borrar el rastro: si vuelve a hacerse visible, hay
    // que saber que hubo que quitarlo para poder republicarlo.
    if (oculto) store.updateFollowupOrigin(enviado.followup_id, 'retirado');
    log.info(
      `Ticket ${ticket.id}: seguimiento ${enviado.followup_id} `
      + `${borrado ? 'borrado' : 'marcado como privado'} en GLPI, retirado de Slack`,
    );
  }
}

/**
 * Si el tecnico edita en GLPI un seguimiento ya enviado, reescribimos el
 * mensaje de Slack en vez de publicar uno nuevo. Se detecta por el hash del
 * contenido: date_mod cambia tambien por cosas que no afectan al texto.
 */
async function syncEditedFollowups(client, ticket, followups, conversation) {
  for (const f of followups) {
    const enviado = store.getFollowupMessage(Number(f.id));
    if (!enviado) continue;

    const hash = hashContenido(f.content);
    if (hash === enviado.content_hash) continue;

    try {
      const author = await authorNameOf(Number(f.users_id));
      const body = glpiHtmlToSlack(f.content);
      await updateMessage(client, {
        channelId: enviado.channel_id,
        ts: enviado.ts,
        text: notificationText(ticket, author),
        color: COLORES.respuesta,
        blocks: followupBlocks({
          ticket,
          authorName: author,
          body,
          glpiTicketUrl: ticketUrl(ticket.id),
          // Al reescribir hay que respetar si era el primer mensaje del canal,
          // o la edicion le quitaria el enlace y el aviso.
          isFirst: enviado.ts === conversation.root_ts,
          edited: true,
        }),
      });
      store.updateFollowupHash(Number(f.id), hash);
      log.info(`Ticket ${ticket.id}: seguimiento ${f.id} editado, mensaje actualizado`);
    } catch (err) {
      log.warn(`No se pudo actualizar el seguimiento ${f.id}: ${err?.data?.error || err.message}`);
    }
  }
}

async function handleNewFollowups(client, ticket, sinceMs) {
  const followups = await glpi.getFollowups(ticket.id);

  // Al equipo de soporte se le avisa de todo, con lista blanca o sin ella.
  await avisarTecnicoDeRespuestas(client, ticket, followups, sinceMs);

  const visibles = followups
    .filter((f) => Number(f.is_private) !== 1)                         // notas internas fuera
    .filter((f) => Number(f.users_id) !== config.glpi.bridgeUserId);   // anti-bucle (autor)

  let conversation = store.getConversationByTicket(ticket.id);

  // Sobre la lista completa, no sobre las visibles: lo que hay que detectar es
  // precisamente que un seguimiento haya dejado de estar en ella.
  if (conversation && !conversation.cleaned_at) {
    await retirarSeguimientosOcultos(client, ticket, followups);
    await republicarSeguimientosVisibles(client, ticket, visibles, conversation);
    await syncEditedFollowups(client, ticket, visibles, conversation);
  }

  const fresh = visibles
    .filter((f) => !store.isFollowupSeen(Number(f.id)))                // idempotencia
    .filter((f) => {
      const iso = glpiDateToIso(f.date_creation || f.date);
      return iso && new Date(iso).getTime() > sinceMs;                 // nada retroactivo
    })
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (fresh.length === 0) return;
  if (!conversation || conversation.cleaned_at) {
    const { conversation: nueva, motivo } = await crearConversacion(client, ticket);
    if (!nueva) {
      // Marcamos vistos para no reintentar en bucle cada 30 segundos.
      fresh.forEach((f) => store.markFollowupSeen(Number(f.id), ticket.id, motivo));
      return;
    }
    conversation = nueva;

    // Canal recien abierto para un ticket que venia de antes: primero el contexto.
    const idsNuevos = new Set(fresh.map((f) => Number(f.id)));
    const previos = visibles
      .filter((f) => !idsNuevos.has(Number(f.id)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (previos.length > 0 || ticket.content) {
      await publicarHistorial(client, ticket, conversation, previos);
      conversation = store.getConversationByTicket(ticket.id) || conversation;
    }
  }

  for (const f of fresh) {
    conversation = await publicarSeguimiento(client, ticket, conversation, f);
    store.markFollowupSeen(Number(f.id), ticket.id, 'glpi');
    log.info(`Ticket ${ticket.id}: seguimiento ${f.id} enviado a ${conversation.channel_id}`);
  }
}

async function handleClosure(client, ticket, conversation) {
  if (!conversation || conversation.cleanup_at || conversation.cleaned_at) return;

  const solutions = await glpi.getSolutions(ticket.id);
  const last = solutions.sort((a, b) => Number(b.id) - Number(a.id))[0];
  const solutionText = last ? glpiHtmlToSlack(last.content) : '';

  const ts = await postToConversation(client, conversation, {
    text: `Ticket #${ticket.id} resuelto`,
    color: COLORES.cierre,
    blocks: closureBlocks({
      ticket,
      solutionText,
      delayMs: config.cleanupDelayMs,
    }),
  }).catch((err) => {
    log.warn(`No se pudo avisar del cierre del ticket ${ticket.id}: ${err.message}`);
    return null;
  });
  if (ts) store.setClosureTs(ticket.id, ts);

  const due = new Date(Date.now() + config.cleanupDelayMs).toISOString();
  store.markCleanupDue(ticket.id, due);
  log.info(`Ticket ${ticket.id} cerrado; limpieza programada para ${due}`);
}

/**
 * Un ticket borrado desaparece de la busqueda de GLPI y su GET devuelve 404, asi
 * que el sondeo normal no vuelve a verlo nunca: el canal se quedaria abierto
 * para siempre. Este barrido repasa lo que tenemos abierto y lo comprueba uno a
 * uno. De paso recoge cierres que se hayan escapado por cualquier motivo.
 */
async function barrerConversacionesAbiertas(client) {
  const activas = store.listActiveConversations().filter((c) => !c.cleanup_at);
  if (activas.length === 0) return;

  log.debug(`Barrido: repasando ${activas.length} conversacion(es) abiertas`);
  for (const conversation of activas) {
    let ticket = null;
    try {
      ticket = await glpi.getTicket(conversation.ticket_id);
    } catch (err) {
      if (err.status !== 404) {
        log.warn(`Barrido: no se pudo consultar el ticket ${conversation.ticket_id}: ${err.message}`);
        continue;
      }
    }

    const borrado = !ticket || Number(ticket.is_deleted) === 1;
    if (borrado) {
      log.warn(`Ticket ${conversation.ticket_id} eliminado en GLPI: se cierra su conversacion`);
      await postToConversation(client, conversation, {
        text: `El ticket #${conversation.ticket_id} ha sido eliminado`,
        color: COLORES.cierre,
        blocks: deletedTicketBlocks(conversation.ticket_id),
      }).catch(() => {});
      await cleanupConversation(client, store.getConversationByTicket(conversation.ticket_id));
      continue;
    }

    if (CLOSED_STATUSES.includes(Number(ticket.status))) {
      log.warn(`Ticket ${ticket.id} estaba cerrado y no se detecto en su momento`);
      await handleClosure(client, ticket, conversation);
    }
  }
}

async function runCleanups(client) {
  const due = store.listDueCleanups(new Date().toISOString());
  for (const conversation of due) {
    try {
      await cleanupConversation(client, conversation);
    } catch (err) {
      log.error(`Fallo limpiando el ticket ${conversation.ticket_id}:`, err.message);
    }
  }
}

export async function pollOnce(client) {
  const cursorIso = store.getCursor();
  const sinceMs = new Date(cursorIso).getTime();
  const startedAt = Date.now();

  const changed = await glpi.searchTicketsModifiedSince(cursorIso);
  log.debug(`Poll: ${changed.length} ticket(s) modificados desde ${cursorIso}`);

  const fallidos = [];
  for (const ref of changed) {
    try {
      // El latido marca progreso, no fin de ciclo: una puesta al dia larga es
      // legitima y no debe parecer un cuelgue.
      store.setHeartbeat();
      const ticket = await glpi.getTicket(ref.id);
      if (!ticket?.id) continue;
      const status = Number(ticket.status);
      const conversation = store.getConversationByTicket(ticket.id);

      if (CLOSED_STATUSES.includes(status)) {
        if (conversation && !conversation.cleaned_at) await handleClosure(client, ticket, conversation);
        continue; // no abrimos conversaciones nuevas para tickets ya cerrados
      }

      // Reabierto dentro del margen de gracia: hay que cancelar la limpieza o
      // el canal desaparecera con el ticket otra vez abierto.
      if (conversation && !conversation.cleaned_at && conversation.cleanup_at) {
        store.cancelCleanup(ticket.id);
        log.info(`Ticket ${ticket.id} reabierto antes de la limpieza: cancelada`);
      }

      await anunciarTicketNuevo(client, ticket, sinceMs);
      await handleNewTicket(client, ticket, sinceMs);

      const viva = store.getConversationByTicket(ticket.id);
      if (viva && !viva.cleaned_at) await sincronizarSolicitantes(client, ticket, viva);

      await handleNewFollowups(client, ticket, sinceMs);
    } catch (err) {
      // Un 404 aqui es un ticket borrado entre la busqueda y la consulta. No es
      // un fallo que haya que reintentar: del canal huerfano se ocupa el
      // barrido. Contarlo como error bloquearia el cursor para siempre.
      if (err.status === 404) {
        log.info(`Ticket ${ref.id} ya no existe; lo recogera el barrido`);
        continue;
      }
      fallidos.push({ id: ref.id, error: err.message });
      log.error(`Error procesando el ticket ${ref.id}:`, err.message, err.body ?? '');
    }
  }

  // El barrido es caro (una llamada por conversacion abierta), asi que no va en
  // cada ciclo sino cada SWEEP_INTERVAL_MINUTES.
  if (config.sweepIntervalMinutes > 0) {
    const ultimo = Number(store.getKv('last_sweep') || 0);
    if (Date.now() - ultimo > config.sweepIntervalMinutes * 60000) {
      store.setKv('last_sweep', String(Date.now()));
      await barrerConversacionesAbiertas(client).catch(
        (err) => log.error('Fallo en el barrido de conversaciones:', err.message),
      );
    }
  }

  await runCleanups(client);
  store.setHeartbeat();

  // Si algo ha fallado, el cursor NO avanza: los seguimientos nuevos se filtran
  // por fecha posterior al cursor, asi que moverlo tras un error de red o un
  // limite de la API dejaria ese mensaje fuera para siempre. Repetir el ciclo es
  // inofensivo, de eso se encarga la idempotencia de seen_followups.
  if (fallidos.length > 0) {
    const atasco = Math.round((startedAt - new Date(cursorIso).getTime()) / 60000);
    log.warn(
      `${fallidos.length} ticket(s) con error: el cursor se queda en ${cursorIso} para `
      + `reintentar. Lleva ${atasco} min sin avanzar.`,
    );

    // Un ticket que falla siempre no solo se pierde el: bloquea la cola entera,
    // porque el cursor no puede pasar de el. Eso hay que contarlo.
    if (atasco >= config.stuckAlertMinutes) {
      await alerta(
        'cursor-atascado',
        `El puente lleva ${atasco} min sin poder avanzar`,
        `Falla siempre sobre ${fallidos.length} ticket(s): `
        + `${fallidos.map((f) => `#${f.id} (${f.error})`).join('; ')}. `
        + 'Mientras no se resuelva, ningún ticket posterior se procesa.',
      );
    }
    return;
  }

  await recuperado('cursor-atascado', 'El puente vuelve a avanzar con normalidad');

  // Solape de seguridad: la idempotencia (seen_followups) evita duplicados.
  store.setCursor(new Date(startedAt - config.pollOverlapMs).toISOString());
}

export function startPolling(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(client);
      await recuperado('sondeo', 'El puente vuelve a hablar con GLPI');
    } catch (err) {
      await alerta(
        'sondeo',
        'El puente no puede consultar GLPI',
        `${err.message}. Mientras dure, nadie recibe respuestas en Slack.`,
      );
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, config.pollIntervalMs);
}
