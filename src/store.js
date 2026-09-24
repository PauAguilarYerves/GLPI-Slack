import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// node:sqlite es parte del runtime desde Node 22.5 (estable en Node 24):
// sin dependencias nativas que compilar en el servidor.
fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Vinculo ticket GLPI <-> conversacion Slack. Es la pieza central del estado.
CREATE TABLE IF NOT EXISTS conversations (
  ticket_id      INTEGER PRIMARY KEY,
  channel_id     TEXT NOT NULL,
  channel_name   TEXT,
  slack_user_id  TEXT,
  glpi_user_id   INTEGER,
  root_ts        TEXT,            -- ts del mensaje raiz (modo dm: hilo)
  status         INTEGER,
  created_at     TEXT NOT NULL,
  cleanup_at     TEXT,            -- cuando toca limpiar (ISO) tras cierre
  cleaned_at     TEXT             -- cuando se limpio realmente
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_channel ON conversations(channel_id);

-- Mensajes publicados por el bot, para poder borrarlos uno a uno al cerrar.
CREATE TABLE IF NOT EXISTS bot_messages (
  channel_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  ticket_id  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, ts)
);

-- Mensaje de Slack que corresponde a cada seguimiento, para poder reflejar
-- las ediciones que haga el tecnico en GLPI sobre un seguimiento ya enviado.
CREATE TABLE IF NOT EXISTS followup_messages (
  followup_id  INTEGER PRIMARY KEY,
  ticket_id    INTEGER NOT NULL,
  channel_id   TEXT NOT NULL,
  ts           TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

-- Mensaje del usuario en Slack -> seguimiento que genero en GLPI. Permite
-- reflejar en GLPI las ediciones que el usuario haga sobre su propio mensaje.
CREATE TABLE IF NOT EXISTS outbound_messages (
  channel_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  followup_id INTEGER NOT NULL,
  ticket_id   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, ts)
);

-- Quien ha invitado el bot a cada canal. Cualquiera que entre sin estar aqui
-- es un intruso y se le retira.
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

-- Ficheros subidos por el bot, para poder borrarlos al cerrar el ticket.
CREATE TABLE IF NOT EXISTS bot_files (
  file_id   TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL
);

-- Avisos ya dados al equipo de soporte, para no repetirlos en cada sondeo.
CREATE TABLE IF NOT EXISTS announced_tickets (
  ticket_id    INTEGER PRIMARY KEY,
  announced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tech_notifications (
  followup_id  INTEGER PRIMARY KEY,
  ticket_id    INTEGER,
  notified_at  TEXT NOT NULL
);

-- Idempotencia + anti-bucle: todo seguimiento ya procesado (o creado por el puente).
CREATE TABLE IF NOT EXISTS seen_followups (
  followup_id INTEGER PRIMARY KEY,
  ticket_id   INTEGER,
  origin      TEXT,               -- 'glpi' (enviado a Slack) | 'slack' (creado por el puente)
  seen_at     TEXT NOT NULL
);
`);

// Migraciones ligeras: la tabla ya existe en instalaciones en marcha.
const columnas = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
if (!columnas.includes('reopen_count')) {
  db.exec('ALTER TABLE conversations ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0');
}

// Saber de que seguimiento venia cada fichero permite retirarlo si ese
// seguimiento se oculta o se borra en GLPI.
// Mensaje de cierre: hay que poder quitarle el boton de reabrir cuando se usa.
if (!columnas.includes('closure_ts')) {
  db.exec('ALTER TABLE conversations ADD COLUMN closure_ts TEXT');
}

const colFicheros = db.prepare('PRAGMA table_info(bot_files)').all().map((c) => c.name);
if (colFicheros.length > 0 && !colFicheros.includes('followup_id')) {
  db.exec('ALTER TABLE bot_files ADD COLUMN followup_id INTEGER');
}

// ---------- cursor ----------
export function getCursor() {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('cursor');
  return row?.v || null;
}
export function setCursor(iso) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('cursor', iso);
}
/** Latido del sondeo: lo usa el healthcheck para saber si el puente sigue vivo. */
export function setHeartbeat(iso = new Date().toISOString()) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('heartbeat', iso);
}
export function getHeartbeat() {
  return db.prepare('SELECT v FROM kv WHERE k = ?').get('heartbeat')?.v || null;
}

/** Acceso generico al almacen clave/valor. */
export function getKv(clave) {
  return db.prepare('SELECT v FROM kv WHERE k = ?').get(clave)?.v || null;
}
export function setKv(clave, valor) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(clave, valor);
}

export function deleteKv(clave) {
  db.prepare('DELETE FROM kv WHERE k = ?').run(clave);
}

export function getActivatedAt() {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('activated_at');
  return row?.v || null;
}
export function setActivatedAt(iso) {
  db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').run('activated_at', iso);
}

// ---------- conversaciones ----------
export function getConversationByTicket(ticketId) {
  return db.prepare('SELECT * FROM conversations WHERE ticket_id = ?').get(ticketId);
}
export function getConversationByChannel(channelId) {
  return db.prepare('SELECT * FROM conversations WHERE channel_id = ?').get(channelId);
}
export function saveConversation(input) {
  // Solo los campos del statement: better-sqlite3 rechaza claves sobrantes.
  const c = {
    ticket_id: input.ticket_id,
    channel_id: input.channel_id,
    channel_name: input.channel_name ?? null,
    slack_user_id: input.slack_user_id ?? null,
    glpi_user_id: input.glpi_user_id ?? null,
    root_ts: input.root_ts ?? null,
    status: input.status ?? null,
    created_at: input.created_at ?? new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO conversations
      (ticket_id, channel_id, channel_name, slack_user_id, glpi_user_id, root_ts, status, created_at)
    VALUES (@ticket_id, @channel_id, @channel_name, @slack_user_id, @glpi_user_id, @root_ts, @status, @created_at)
    ON CONFLICT(ticket_id) DO UPDATE SET
      channel_id   = excluded.channel_id,
      channel_name = excluded.channel_name,
      slack_user_id= excluded.slack_user_id,
      root_ts      = COALESCE(excluded.root_ts, conversations.root_ts),
      status       = excluded.status
  `).run(c);
  return getConversationByTicket(c.ticket_id);
}
export function setClosureTs(ticketId, ts) {
  db.prepare('UPDATE conversations SET closure_ts = ? WHERE ticket_id = ?').run(ts, ticketId);
}
export function markCleanupDue(ticketId, whenIso) {
  db.prepare('UPDATE conversations SET cleanup_at = ? WHERE ticket_id = ? AND cleaned_at IS NULL')
    .run(whenIso, ticketId);
}
/** El ticket vuelve a estar abierto antes de que la limpieza llegara a correr. */
export function cancelCleanup(ticketId) {
  db.prepare('UPDATE conversations SET cleanup_at = NULL WHERE ticket_id = ? AND cleaned_at IS NULL')
    .run(ticketId);
}
export function markCleaned(ticketId) {
  db.prepare('UPDATE conversations SET cleaned_at = ? WHERE ticket_id = ?')
    .run(new Date().toISOString(), ticketId);
}
/**
 * Reabrir un ticket cerrado: hay que quitar las marcas de limpieza y olvidar el
 * mensaje raiz, porque los mensajes del bot se borraron al cerrar. Sin esto la
 * conversacion revive a medias: no acepta respuestas y no se vuelve a limpiar.
 */
export function reopenConversation(ticketId) {
  db.prepare(
    'UPDATE conversations SET cleaned_at = NULL, cleanup_at = NULL, root_ts = NULL WHERE ticket_id = ?'
  ).run(ticketId);
  return getConversationByTicket(ticketId);
}

/** Cada reapertura estrena canal, asi que lleva su propio numero. */
export function bumpReopenCount(ticketId) {
  db.prepare('UPDATE conversations SET reopen_count = reopen_count + 1 WHERE ticket_id = ?')
    .run(ticketId);
  return getConversationByTicket(ticketId)?.reopen_count ?? 0;
}

export function listDueCleanups(nowIso) {
  return db.prepare(
    'SELECT * FROM conversations WHERE cleaned_at IS NULL AND cleanup_at IS NOT NULL AND cleanup_at <= ?'
  ).all(nowIso);
}
export function listActiveConversations() {
  return db.prepare('SELECT * FROM conversations WHERE cleaned_at IS NULL').all();
}

// ---------- mensajes del bot ----------
export function rememberBotMessage(ticketId, channelId, ts) {
  db.prepare('INSERT OR IGNORE INTO bot_messages (channel_id, ts, ticket_id) VALUES (?, ?, ?)')
    .run(channelId, ts, ticketId);
}
export function listBotMessages(ticketId) {
  return db.prepare('SELECT * FROM bot_messages WHERE ticket_id = ? ORDER BY ts DESC').all(ticketId);
}
export function forgetBotMessages(ticketId) {
  db.prepare('DELETE FROM bot_messages WHERE ticket_id = ?').run(ticketId);
}
export function forgetBotMessage(channelId, ts) {
  db.prepare('DELETE FROM bot_messages WHERE channel_id = ? AND ts = ?').run(channelId, ts);
}

export function rememberBotFile(ticketId, fileId, followupId = null) {
  db.prepare('INSERT OR IGNORE INTO bot_files (file_id, ticket_id, followup_id) VALUES (?, ?, ?)')
    .run(fileId, ticketId, followupId);
}
export function listBotFilesByFollowup(followupId) {
  return db.prepare('SELECT file_id FROM bot_files WHERE followup_id = ?').all(followupId);
}
export function forgetBotFile(fileId) {
  db.prepare('DELETE FROM bot_files WHERE file_id = ?').run(fileId);
}
export function listBotFiles(ticketId) {
  return db.prepare('SELECT file_id FROM bot_files WHERE ticket_id = ?').all(ticketId);
}
export function forgetBotFiles(ticketId) {
  db.prepare('DELETE FROM bot_files WHERE ticket_id = ?').run(ticketId);
}

/** Los mensajes borrados ya no se pueden editar: fuera los vinculos. */
export function forgetMessageLinks(ticketId) {
  db.prepare('DELETE FROM followup_messages WHERE ticket_id = ?').run(ticketId);
  db.prepare('DELETE FROM outbound_messages WHERE ticket_id = ?').run(ticketId);
}

export function rememberFollowupMessage({ followupId, ticketId, channelId, ts, contentHash }) {
  db.prepare(`
    INSERT INTO followup_messages (followup_id, ticket_id, channel_id, ts, content_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(followup_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      ts = excluded.ts,
      content_hash = excluded.content_hash
  `).run(followupId, ticketId, channelId, ts, contentHash);
}
export function getFollowupMessage(followupId) {
  return db.prepare('SELECT * FROM followup_messages WHERE followup_id = ?').get(followupId);
}
export function listFollowupMessages(ticketId) {
  return db.prepare('SELECT * FROM followup_messages WHERE ticket_id = ?').all(ticketId);
}
export function forgetFollowupMessage(followupId) {
  db.prepare('DELETE FROM followup_messages WHERE followup_id = ?').run(followupId);
}
export function updateFollowupHash(followupId, contentHash) {
  db.prepare('UPDATE followup_messages SET content_hash = ? WHERE followup_id = ?')
    .run(contentHash, followupId);
}

export function rememberOutboundMessage({ channelId, ts, followupId, ticketId }) {
  db.prepare(`
    INSERT INTO outbound_messages (channel_id, ts, followup_id, ticket_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id, ts) DO UPDATE SET followup_id = excluded.followup_id
  `).run(channelId, ts, followupId, ticketId);
}
export function getOutboundMessage(channelId, ts) {
  return db.prepare('SELECT * FROM outbound_messages WHERE channel_id = ? AND ts = ?')
    .get(channelId, ts);
}

export function rememberInvited(channelId, userId) {
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)')
    .run(channelId, userId);
}
export function listInvited(channelId) {
  return db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channelId);
}
export function isInvited(channelId, userId) {
  return db.prepare('SELECT 1 AS hit FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId) !== undefined;
}

// ---------- avisos al equipo de soporte ----------
export function isTicketAnnounced(ticketId) {
  return db.prepare('SELECT 1 AS hit FROM announced_tickets WHERE ticket_id = ?')
    .get(ticketId) !== undefined;
}
export function markTicketAnnounced(ticketId) {
  db.prepare('INSERT OR IGNORE INTO announced_tickets (ticket_id, announced_at) VALUES (?, ?)')
    .run(ticketId, new Date().toISOString());
}
export function isTechNotified(followupId) {
  return db.prepare('SELECT 1 AS hit FROM tech_notifications WHERE followup_id = ?')
    .get(followupId) !== undefined;
}
export function markTechNotified(followupId, ticketId) {
  db.prepare('INSERT OR IGNORE INTO tech_notifications (followup_id, ticket_id, notified_at) VALUES (?, ?, ?)')
    .run(followupId, ticketId, new Date().toISOString());
}

// ---------- seguimientos ----------
export function isFollowupSeen(followupId) {
  return db.prepare('SELECT 1 AS hit FROM seen_followups WHERE followup_id = ?').get(followupId) !== undefined;
}
export function getSeenFollowup(followupId) {
  return db.prepare('SELECT * FROM seen_followups WHERE followup_id = ?').get(followupId);
}
export function updateFollowupOrigin(followupId, origin) {
  db.prepare('UPDATE seen_followups SET origin = ? WHERE followup_id = ?').run(origin, followupId);
}
export function markFollowupSeen(followupId, ticketId, origin) {
  db.prepare('INSERT OR IGNORE INTO seen_followups (followup_id, ticket_id, origin, seen_at) VALUES (?, ?, ?, ?)')
    .run(followupId, ticketId, origin, new Date().toISOString());
}

export default db;
