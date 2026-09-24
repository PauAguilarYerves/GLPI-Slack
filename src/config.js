import 'dotenv/config';

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase());
}
function int(v, def) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (revisa tu .env)`);
  return v;
}

export const config = {
  glpi: {
    url: required('GLPI_URL').replace(/\/+$/, ''),
    appToken: required('GLPI_APP_TOKEN'),
    userToken: required('GLPI_USER_TOKEN'),
    bridgeUserId: int(process.env.GLPI_BRIDGE_USER_ID, 0),
    // Perfil con el que trabaja la sesion. Sin esto GLPI usa el predeterminado
    // del usuario, que suele ser Self-Service y no ve los tickets de nadie.
    profileId: int(process.env.GLPI_PROFILE_ID, 0),
  },
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: process.env.SLACK_APP_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    // Solo Enterprise Grid: token de organizacion con admin.conversations:write.
    adminToken: process.env.SLACK_ADMIN_TOKEN || '',
    socketMode: !!process.env.SLACK_APP_TOKEN,
    port: int(process.env.PORT, 3000),
  },
  mode: (process.env.CONVERSATION_MODE || 'channel').toLowerCase(), // channel | dm
  channelPrefix: process.env.CHANNEL_PREFIX || 'soporte-',
  // Añadir el titulo del ticket al nombre del canal (soporte-6210-el-pc-no-arranca)
  channelIncludeTitle: bool(process.env.CHANNEL_INCLUDE_TITLE, true),
  pollIntervalMs: int(process.env.POLL_INTERVAL_SECONDS, 30) * 1000,
  pollOverlapMs: int(process.env.POLL_OVERLAP_SECONDS, 60) * 1000,
  // Si el puente ha estado caido mas de estas horas, el cursor se reinicia a
  // "ahora" en vez de procesar la avalancha acumulada. 0 = sin limite.
  maxCatchupHours: int(process.env.MAX_CATCHUP_HOURS, 0),
  // Cada cuanto se repasan las conversaciones abiertas para detectar tickets
  // borrados o cierres que se hayan escapado. 0 = desactivado.
  sweepIntervalMinutes: int(process.env.SWEEP_INTERVAL_MINUTES, 10),
  // Si el sondeo deja de dar senales de vida durante estos minutos, el proceso
  // se suicida para que el supervisor (Docker, systemd) lo levante de nuevo.
  // 0 = desactivado.
  watchdogMinutes: int(process.env.WATCHDOG_MINUTES, 5),
  // Canal privado donde el puente avisa de sus propios fallos. Vacio = solo log.
  alertChannel: process.env.ALERT_CHANNEL || '',
  // Un mismo tipo de fallo no se repite antes de estos minutos: con el sondeo a
  // 5 segundos, publicar cada error convertiria el canal en ruido inservible.
  alertCooldownMinutes: int(process.env.ALERT_COOLDOWN_MINUTES, 30),
  // Si un ticket falla una y otra vez, el cursor deja de avanzar y con el se
  // para todo lo demas. Pasados estos minutos, hay que avisar.
  stuckAlertMinutes: int(process.env.STUCK_ALERT_MINUTES, 5),
  // archive = solo archivar (el usuario aun lo encuentra en "canales archivados")
  // purge   = borrar mensajes del bot + EXPULSAR a los miembros + archivar  <- desaparece
  // delete  = purge + admin.conversations.delete (solo Enterprise Grid)
  cleanupMode: (process.env.CLEANUP_MODE || 'purge').toLowerCase(),
  // inline = el usuario responde escribiendo en el canal (natural, pero sus
  //          mensajes son suyos y el bot no puede borrarlos)
  // modal  = el usuario responde en una ventana emergente; en el canal NO queda
  //          ni un solo mensaje humano, asi que el bot puede borrarlo todo
  replyMode: (process.env.REPLY_MODE || 'inline').toLowerCase(),
  // Barra de color a la izquierda del mensaje segun el tipo. A false, mensajes planos.
  messageColors: bool(process.env.MESSAGE_COLORS, true),
  // CLEANUP_DELAY_SECONDS manda si esta puesto; si no, se usan los minutos.
  // Si el usuario escribe durante el margen de gracia posterior al cierre, se
  // reabre el ticket en GLPI en vez de dejar que el canal desaparezca.
  reopenOnReply: bool(process.env.REOPEN_ON_REPLY, true),
  // Estado al que vuelve el ticket reabierto. 2 = en curso (asignado).
  reopenStatus: int(process.env.REOPEN_STATUS, 2),
  // Avisar por Slack al tecnico asignado cuando un ticket se reabre.
  notifyTechnician: bool(process.env.NOTIFY_TECHNICIAN, true),
  // Canal del equipo de soporte (ID C... o #nombre) para los avisos que no
  // tienen un tecnico asignado al que dirigirse. Vacio = no se usa.
  teamChannel: process.env.TEAM_CHANNEL || '',
  // Avisar de cada ticket nuevo que entra en GLPI.
  notifyNewTickets: bool(process.env.NOTIFY_NEW_TICKETS, false),
  // A quien avisar de los tickets nuevos, por mensaje directo. Correos
  // separados por comas. Si esta vacio se usa TEAM_CHANNEL.
  newTicketRecipients: (process.env.NEW_TICKET_RECIPIENTS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // Avisar al tecnico asignado de cada respuesta que reciben sus tickets.
  notifyTicketReplies: bool(process.env.NOTIFY_TICKET_REPLIES, false),
  cleanupDelayMs: process.env.CLEANUP_DELAY_SECONDS
    ? int(process.env.CLEANUP_DELAY_SECONDS, 0) * 1000
    : int(process.env.CLEANUP_DELAY_MINUTES, 0) * 60 * 1000,
  onlyNewTickets: bool(process.env.ONLY_TICKETS_CREATED_AFTER_ACTIVATION, false),
  // Al abrir el canal de un ticket que ya existia antes de la integracion, se
  // publica un resumen con la solicitud y los ultimos N mensajes. 0 = solo el
  // recuento y el enlace a GLPI.
  historyMessages: int(process.env.HISTORY_MESSAGES, 3),
  inviteTechnician: bool(process.env.INVITE_TECHNICIAN, false),
  // Si alguien se sale del canal de su ticket y el tecnico responde, se le
  // vuelve a meter: si no, la respuesta no la lee nadie.
  reinviteOnReply: bool(process.env.REINVITE_ON_REPLY, true),
  // Expulsa de los canales de ticket a quien no haya invitado el propio puente.
  enforcePrivacy: bool(process.env.ENFORCE_PRIVACY, true),
  // Usuarios de Slack (IDs U... separados por comas) que pueden entrar siempre.
  privacyAllowlist: (process.env.PRIVACY_ALLOWLIST || '')
    .split(',').map((u) => u.trim()).filter(Boolean),
  // Modo pruebas: solo se actua sobre tickets cuyo solicitante este en esta lista.
  // Vacio = todos. Es el interruptor de seguridad para pilotar sin tocar a nadie.
  allowedRequesterEmails: (process.env.ALLOWED_REQUESTER_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  // No escribe nada en Slack ni en GLPI: solo registra lo que haria.
  dryRun: bool(process.env.DRY_RUN, false),
  dbPath: process.env.DB_PATH || './data/bridge.sqlite',
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Estados de ticket en GLPI
export const TICKET_STATUS = {
  NEW: 1,
  ASSIGNED: 2,
  PLANNED: 3,
  WAITING: 4,
  SOLVED: 5,
  CLOSED: 6,
};
export const CLOSED_STATUSES = [TICKET_STATUS.SOLVED, TICKET_STATUS.CLOSED];
