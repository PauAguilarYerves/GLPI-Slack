// Comprobacion previa: verifica credenciales, permisos y correspondencia de
// identidades SIN escribir absolutamente nada en GLPI ni en Slack.
//   npm run check
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { glpi } from '../glpi.js';

let fallos = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const ko = (m) => { fallos += 1; console.log(`  ✗ ${m}`); };
const nota = (m) => console.log(`    ${m}`);

console.log('\n── GLPI ──');
let sesion = null;
try {
  await glpi.initSession();
  ok('initSession: App-Token y user_token validos');
  sesion = await glpi.request('GET', '/getFullSession');
  const glpiID = sesion?.session?.glpiID;
  nota(`cuenta de servicio: ${sesion?.session?.glpiname || '?'} (users_id ${glpiID})`);
  const perfil = sesion?.session?.glpiactiveprofile?.name;
  nota(`perfil activo: ${perfil} | entidad: ${sesion?.session?.glpiactive_entity_name}`);
  if (/self.?service/i.test(perfil || '')) {
    ko('el perfil Self-Service solo ve los tickets propios: el puente no vera nada');
  }
  if (!config.glpi.bridgeUserId) {
    ko(`GLPI_BRIDGE_USER_ID esta a 0. Ponlo a ${glpiID} o el bot se reenviara sus propios mensajes`);
  } else if (Number(config.glpi.bridgeUserId) !== Number(glpiID)) {
    ko(`GLPI_BRIDGE_USER_ID=${config.glpi.bridgeUserId} pero la sesion es el usuario ${glpiID}`);
  } else {
    ok('GLPI_BRIDGE_USER_ID coincide con la cuenta de servicio (anti-bucle activo)');
  }
} catch (err) {
  ko(`no se pudo abrir sesion: ${err.message}`);
  nota(JSON.stringify(err.body ?? ''));
}

try {
  const sonda = new URLSearchParams({ range: '0-0', sort: '19', order: 'DESC' });
  sonda.append('forcedisplay[0]', '2');
  const total = (await glpi.request('GET', '/search/Ticket', { query: sonda.toString() }))?.totalcount ?? 0;
  if (total === 0) {
    ko('la cuenta de servicio no ve NINGUN ticket: revisa el perfil y la entidad asignados');
  } else {
    ok(`la cuenta de servicio ve ${total} ticket(s)`);
  }

  const tickets = await glpi.searchTicketsModifiedSince(new Date(Date.now() - 86400000).toISOString());
  nota(`${tickets.length} ticket(s) modificados en las ultimas 24 h`);
  if (tickets.length) {
    const t = await glpi.getTicket(tickets[0].id);
    const f = await glpi.getFollowups(tickets[0].id);
    const r = await glpi.getRequester(tickets[0].id, t);
    ok(`lectura completa del ticket ${t.id}: ${f.length} seguimiento(s), solicitante ${r.email || 'SIN EMAIL'}`);
    if (!r.email) nota('sin email no hay forma de encontrar al usuario en Slack');
  } else {
    nota('sin tickets recientes no se ha podido probar la lectura de seguimientos');
  }
} catch (err) {
  ko(`el perfil de la cuenta de servicio no permite leer tickets: ${err.message}`);
}

console.log('\n── Slack ──');
const web = new WebClient(config.slack.botToken);
let botUserId = null;
try {
  const auth = await web.auth.test();
  botUserId = auth.user_id;
  ok(`auth.test: bot ${auth.user} en el workspace ${auth.team}`);
} catch (err) {
  ko(`SLACK_BOT_TOKEN invalido: ${err?.data?.error || err.message}`);
}

if (botUserId) {
  try {
    await web.conversations.list({ types: 'private_channel', limit: 1 });
    ok('groups:read disponible');
  } catch (err) {
    ko(`falta groups:read: ${err?.data?.error}`);
  }
}

if (config.slack.socketMode) ok('Socket Mode configurado (SLACK_APP_TOKEN presente)');
else ko('sin SLACK_APP_TOKEN: necesitaras exponer un endpoint publico y SLACK_SIGNING_SECRET');

console.log('\n── Lista blanca de pruebas ──');
if (config.allowedRequesterEmails.length === 0) {
  ko('ALLOWED_REQUESTER_EMAILS esta vacia: el puente actuara sobre TODOS los usuarios');
} else {
  for (const email of config.allowedRequesterEmails) {
    try {
      const res = await web.users.lookupByEmail({ email });
      ok(`${email} existe en Slack -> ${res.user.id} (${res.user.real_name})`);
    } catch (err) {
      ko(`${email} no existe en Slack (${err?.data?.error}). Debe ser el email de su cuenta de Slack`);
    }
    try {
      const ids = await glpi.findUsersByEmail(email);
      if (ids.length === 0) {
        ko(`${email} no figura como email de ningun usuario de GLPI: nunca se le abriria conversacion`);
      } else {
        ok(`${email} existe en GLPI -> users_id ${ids.join(', ')}`);
      }
    } catch (err) {
      ko(`no se pudo comprobar ${email} en GLPI: ${err.message}`);
    }
  }
}

console.log('\n── Configuracion ──');
console.log(`  conversacion=${config.mode}  respuesta=${config.replyMode}  limpieza=${config.cleanupMode}`);
console.log(`  DRY_RUN=${config.dryRun}  sondeo=${config.pollIntervalMs / 1000}s  BD=${config.dbPath}`);
if (config.mode !== 'channel') nota('en modo dm la conversacion NO puede desaparecer del usuario');

await glpi.killSession().catch(() => {});
console.log(fallos === 0 ? '\nTodo listo.\n' : `\n${fallos} problema(s) que resolver antes de arrancar.\n`);
process.exit(fallos === 0 ? 0 : 1);
