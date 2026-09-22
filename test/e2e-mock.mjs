// Prueba de integracion con GLPI y Slack simulados: no toca ningun sistema real.
//   npm test
// Cubre: alta de conversacion, entrega del seguimiento, idempotencia,
// anti-bucle (el eco de Slack no vuelve) y limpieza al cerrar el ticket.
const pad = (n) => String(n).padStart(2, '0');
const glpiNow = (offsetMs = 0) => {
  const d = new Date(Date.now() + offsetMs);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

let ticketStatus = 2;
let ticketBorrado = false;
// Tickets extra que aparecen a mitad de la prueba (alta reciente).
const extras = new Map();
const createdFollowups = [];
let followups = [{
  id: 9001, itemtype: 'Ticket', items_id: 42, is_private: 0, users_id: 7,
  content: '<p>Hola, <b>reinicia</b> el equipo y dime si arranca. M&aacute;s info en <a href="https://kb/1">KB</a>.</p>',
  date_creation: glpiNow(),
}];

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const p = u.pathname.replace('/apirest.php', '');
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (p === '/initSession') return json({ session_token: 'sess-1' });
  if (p === '/killSession') return json({});
  if (p === '/changeActiveProfile') return json({});
  if (p === '/search/Ticket') {
    const range = u.searchParams.get('range');
    if (!range.startsWith('0-')) return json({ data: {} });
    const filas = { 0: { 2: 42, 19: glpiNow() } };
    let i = 1;
    for (const id of extras.keys()) filas[i++] = { 2: id, 19: glpiNow() };
    return json({ totalcount: i, count: i, data: filas });
  }
  if (p === '/Ticket/42') {
    if (ticketBorrado) return json(['ERROR_ITEM_NOT_FOUND', 'Elemento no encontrado'], 404);
    return json({ id: 42, name: 'El PC no arranca', status: ticketStatus, date_creation: '2026-09-20 09:00:00' });
  }
  const extra = /^\/Ticket\/(\d+)$/.exec(p);
  if (extra && extras.has(Number(extra[1]))) return json(extras.get(Number(extra[1])));
  // Sub-recursos de los tickets extra (no del 42, que tiene sus propias rutas).
  const sub = /^\/Ticket\/(\d+)\/(ITILFollowup|ITILSolution|Document_Item|Ticket_User)$/.exec(p);
  if (sub && extras.has(Number(sub[1]))) {
    return json(sub[2] === 'Ticket_User' ? [{ users_id: 5, type: 1 }] : []);
  }
  if (p === '/Ticket/42/ITILFollowup') return json(followups);
  if (/^\/ITILFollowup\/\d+\/Document_Item$/.test(p)) return json([]);
  if (p === '/Ticket/42/ITILSolution') return json([{ id: 555, content: '<p>Cambiada la fuente de alimentaci&oacute;n.</p>' }]);
  // Dos solicitantes (type 1) y un tecnico asignado (type 2).
  if (p === '/Ticket/42/Ticket_User') {
    return json([{ users_id: 5, type: 1 }, { users_id: 6, type: 1 }, { users_id: 7, type: 2 }]);
  }
  if (p === '/User/5') return json({ id: 5, name: 'pau', firstname: 'Pau', realname: 'Pérez' });
  if (p === '/User/7') return json({ id: 7, name: 'tecnico', firstname: 'Marta', realname: 'Gil' });
  if (p === '/User/6') return json({ id: 6, name: 'lucia', firstname: 'Lucía', realname: 'Soler' });
  if (p === '/User/5/UserEmail') return json([{ email: 'pau@empresa.com', is_default: 1 }]);
  if (p === '/User/6/UserEmail') return json([{ email: 'lucia@empresa.com', is_default: 1 }]);
  if (p === '/User/7/UserEmail') return json([{ email: 'marta@empresa.com', is_default: 1 }]);
  if (p === '/ITILFollowup' && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    const id = 9500 + createdFollowups.length;
    createdFollowups.push({ id, ...body.input });
    followups.push({ id, itemtype: 'Ticket', items_id: 42, is_private: 0, users_id: 99, content: body.input.content, date_creation: glpiNow(1000) });
    return json({ id, message: '' }, 201);
  }
  throw new Error(`endpoint no simulado: ${opts.method || 'GET'} ${p}`);
};

// Con MESSAGE_COLORS los bloques viajan dentro de attachments, no sueltos.
const cuerpoDe = ({ blocks, attachments, text }) => {
  const bs = blocks || attachments?.[0]?.blocks || [];
  return bs.filter((b) => b.type === 'section').at(-1)?.text?.text ?? text;
};

const calls = [];
let canalArchivado = false;
let fallarEnvio = false;
let ts = 1700000000;
const fakeClient = {
  auth: { test: async () => ({ user_id: 'U_BOT' }) },
  users: {
    lookupByEmail: async ({ email }) => {
      calls.push(['lookupByEmail', email]);
      const mapa = { 'pau@empresa.com': 'U_PAU', 'lucia@empresa.com': 'U_LUCIA', 'marta@empresa.com': 'U_MARTA' };
      const id = mapa[email];
      if (!id) { const e = new Error('users_not_found'); e.data = { error: 'users_not_found' }; throw e; }
      return { user: { id } };
    },
    info: async ({ user }) => ({ user: { real_name: 'Pau Pérez', name: user } }),
  },
  conversations: {
    create: async ({ name, is_private }) => {
      calls.push(['create', name, is_private]);
      // Solo el nombre original queda ocupado tras archivarse.
      if (name === 'ticket-el-pc-no-arranca-42' && canalArchivado) {
        const err = new Error('name_taken'); err.data = { error: 'name_taken' }; throw err;
      }
      if (name === 'ticket-el-pc-no-arranca-42') return { channel: { id: 'C_TKT42' } };
      return { channel: { id: 'C_' + name } };
    },
    list: async () => ({ channels: [{ id: 'C_TKT42', name: 'ticket-el-pc-no-arranca-42', is_archived: canalArchivado }] }),
    unarchive: async ({ channel }) => { calls.push(['unarchive', channel]); canalArchivado = false; return {}; },
    invite: async ({ channel, users }) => { calls.push(['invite', channel, users]); return {}; },
    setPurpose: async () => ({}),
    members: async ({ channel }) => { calls.push(['members', channel]); return { members: ['U_BOT', 'U_PAU'] }; },
    kick: async ({ channel, user }) => { calls.push(['kick', channel, user]); return {}; },
    archive: async ({ channel }) => { calls.push(['archive', channel]); canalArchivado = true; return {}; },
  },
  chat: {
    postMessage: async (args) => {
      if (fallarEnvio) { const e = new Error('ratelimited'); e.data = { error: 'ratelimited' }; throw e; }
      ts += 1;
      calls.push(['postMessage', args.channel, cuerpoDe(args)]);
      return { ts: `${ts}.000100` };
    },
    delete: async ({ channel, ts: t }) => { calls.push(['delete', channel, t]); return {}; },
    update: async (args) => {
      calls.push(['update', args.channel, args.ts, String(cuerpoDe(args)).replace(/\n/g, ' ')]);
      return {};
    },
    postEphemeral: async () => ({}),
  },
  reactions: { add: async () => ({}) },
};

const store = await import('../src/store.js');
const { pollOnce, bootstrapCursor } = await import('../src/poller.js');
const { glpi } = await import('../src/glpi.js');
const { slackToGlpiHtml } = await import('../src/format.js');

bootstrapCursor();
store.setCursor(new Date(Date.now() - 3600_000).toISOString());

console.log('--- PASADA 1: seguimiento nuevo del tecnico ---');
await pollOnce(fakeClient);
const llamadas1 = calls.splice(0);
llamadas1.forEach((c) => console.log(' ', c.join(' | ').slice(0, 220)));

const invitados = llamadas1.find((c) => c[0] === 'invite');
if (!invitados || !String(invitados[2]).includes('U_PAU') || !String(invitados[2]).includes('U_LUCIA')) {
  console.error('FALLO: con dos solicitantes deben entrar los dos al canal. Invitados:', invitados?.[2]);
  process.exit(1);
}
console.log('  dos solicitantes invitados:', invitados[2]);

console.log('--- PASADA 2: sin novedades (idempotencia) ---');
await pollOnce(fakeClient);
console.log('  llamadas a Slack:', calls.length);

console.log('--- Slack -> GLPI ---');
const conv = store.getConversationByChannel('C_TKT42');
const fid = await glpi.addFollowup(conv.ticket_id, slackToGlpiHtml('Ya arranca, gracias', 'Pau Pérez'));
store.markFollowupSeen(fid, conv.ticket_id, 'slack');
console.log('  seguimiento creado en GLPI:', fid, '->', createdFollowups.at(-1).content);

console.log('--- PASADA 3: el eco NO debe volver a Slack ---');
calls.splice(0);
await pollOnce(fakeClient);
console.log('  llamadas a Slack:', calls.length, calls.map(c=>c[0]));

console.log('--- PASADA 3b: el tecnico EDITA el seguimiento ---');
followups[0].content = '<p>Corrijo: <b>NO</b> reinicies el equipo todavia.</p>';
calls.splice(0);
await pollOnce(fakeClient);
calls.forEach((c) => console.log(' ', c.join(' | ').slice(0, 200)));
if (!calls.some((c) => c[0] === 'update')) {
  console.error('FALLO: la edicion no actualizo el mensaje de Slack');
  process.exit(1);
}
if (calls.some((c) => c[0] === 'postMessage')) {
  console.error('FALLO: la edicion publico un mensaje nuevo en vez de reescribir el existente');
  process.exit(1);
}

console.log('--- PASADA 4: ticket resuelto -> aviso + limpieza ---');
ticketStatus = 5;
calls.splice(0);
await pollOnce(fakeClient);   // detecta cierre, programa limpieza (delay 0)
await pollOnce(fakeClient);   // ejecuta la limpieza
calls.forEach((c) => console.log(' ', c.join(' | ').slice(0, 200)));
console.log('  limpiada:', !!store.getConversationByTicket(42).cleaned_at);

// Se guarda antes de que las pasadas siguientes limpien el registro de llamadas.
const accionesCierre = calls.map((c) => c[0]);

console.log('--- PASADA 4b: ticket RECIEN CREADO abre canal sin esperar respuesta ---');
extras.set(77, {
  id: 77, name: 'No tengo acceso a la VPN', status: 1,
  date_creation: glpiNow(), content: '&#60;p&#62;Desde ayer no me deja conectar.&#60;/p&#62;',
});
store.setCursor(new Date(Date.now() - 60000).toISOString());
calls.splice(0);
await pollOnce(fakeClient);
calls.filter((c) => c[1] !== 'C_TKT42').forEach((c) => console.log(' ', c.join(' | ').slice(0, 170)));
const creado = calls.find((c) => c[0] === 'create');
if (!creado) { console.error('FALLO: no se abrio canal para el ticket recien creado'); process.exit(1); }
console.log('  nombre del canal:', creado[1]);
if (creado[1] !== 'ticket-no-tengo-acceso-a-la-vpn-77') {
  console.error('FALLO: nombre de canal inesperado'); process.exit(1);
}

console.log('--- PASADA 5: el ticket se REABRE ---');
extras.clear();
ticketStatus = 2;
followups.push({
  id: 9010, itemtype: 'Ticket', items_id: 42, is_private: 0, users_id: 7,
  content: '<p>Reabro: ha vuelto a fallar.</p>', date_creation: glpiNow(2000),
});
store.setCursor(new Date(Date.now() - 60000).toISOString());
calls.splice(0);
await pollOnce(fakeClient);
calls.forEach((c) => console.log(' ', c.join(' | ').slice(0, 180)));

const reabierta = store.getConversationByTicket(42);
console.log('  cleaned_at:', reabierta.cleaned_at, '| cleanup_at:', reabierta.cleanup_at);
if (reabierta.cleaned_at || reabierta.cleanup_at) {
  console.error('FALLO: la conversacion reabierta sigue marcada como limpiada');
  process.exit(1);
}
const nuevoCanal = calls.find((c) => c[0] === 'create');
if (!nuevoCanal) {
  console.error('FALLO: la reapertura no creo un canal nuevo');
  process.exit(1);
}
if (!String(nuevoCanal[1]).endsWith('-r2')) {
  console.error('FALLO: el canal de la reapertura deberia acabar en -r2, es', nuevoCanal[1]);
  process.exit(1);
}
if (calls.some((c) => c[0] === 'unarchive')) {
  console.error('FALLO: se reutilizo el canal viejo en vez de estrenar uno');
  process.exit(1);
}
if (!calls.some((c) => c[0] === 'postMessage')) {
  console.error('FALLO: el seguimiento de la reapertura no llego a Slack');
  process.exit(1);
}

console.log('--- PASADA 6: si Slack falla, el cursor NO avanza ---');
followups.push({
  id: 9020, itemtype: 'Ticket', items_id: 42, is_private: 0, users_id: 7,
  content: '<p>Mensaje que no debe perderse.</p>', date_creation: glpiNow(3000),
});
const cursorAntes = store.getCursor();
fallarEnvio = true;
calls.splice(0);
await pollOnce(fakeClient);
const cursorDespues = store.getCursor();
console.log('  cursor antes :', cursorAntes);
console.log('  cursor despues:', cursorDespues);
if (cursorAntes !== cursorDespues) {
  console.error('FALLO: el cursor avanzo pese al error; ese mensaje se habria perdido');
  process.exit(1);
}

fallarEnvio = false;
calls.splice(0);
await pollOnce(fakeClient);
const entregado = calls.find((c) => c[0] === 'postMessage' && String(c[2]).includes('no debe perderse'));
if (!entregado) {
  console.error('FALLO: el mensaje no se reintento tras recuperarse Slack');
  process.exit(1);
}
console.log('  reintento OK:', entregado[2]);
if (store.getCursor() === cursorAntes) {
  console.error('FALLO: el cursor deberia avanzar una vez resuelto el error');
  process.exit(1);
}

console.log('--- PASADA 7: el ticket se ELIMINA en GLPI ---');
// El ticket sigue vivo en el estado del puente tras la reapertura de la pasada 5.
ticketBorrado = true;
store.setKv('last_sweep', '0');           // forzar el barrido en este ciclo
calls.splice(0);
await pollOnce(fakeClient);
calls.forEach((c) => console.log(' ', c.join(' | ').slice(0, 170)));
const tras = store.getConversationByTicket(42);
if (!tras.cleaned_at) {
  console.error('FALLO: el canal de un ticket eliminado sigue abierto');
  process.exit(1);
}
if (!calls.some((c) => c[0] === 'archive')) {
  console.error('FALLO: no se archivo el canal del ticket eliminado');
  process.exit(1);
}
ticketBorrado = false;

const acciones = accionesCierre;
const esperado = ['delete', 'kick', 'archive'];
const faltan = esperado.filter((a) => !acciones.includes(a));
if (faltan.length) {
  console.error('FALLO: la limpieza no ejecuto', faltan.join(', '));
  process.exit(1);
}
if (acciones.indexOf('kick') > acciones.indexOf('archive')) {
  console.error('FALLO: se expulso despues de archivar; en un canal archivado ya no se puede');
  process.exit(1);
}
console.log('\nOK: el canal queda sin miembros humanos y archivado.');
