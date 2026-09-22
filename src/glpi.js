import { config } from './config.js';
import { log } from './log.js';

// IDs de "search options" de Ticket en GLPI. Verificalos en tu instalacion con:
//   GET /apirest.php/listSearchOptions/Ticket
export const TICKET_SO = {
  ID: 2,
  TITLE: 1,
  STATUS: 12,
  DATE_MOD: 19,
  DATE_CREATION: 15,
};

class GlpiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class GlpiClient {
  constructor(opts = config.glpi) {
    this.baseUrl = opts.url;
    this.appToken = opts.appToken;
    this.userToken = opts.userToken;
    this.profileId = opts.profileId;
    this.sessionToken = null;
    this._initializing = null;
  }

  async initSession() {
    if (this._initializing) return this._initializing;
    this._initializing = (async () => {
      const res = await fetch(`${this.baseUrl}/initSession`, {
        method: 'GET',
        headers: {
          'App-Token': this.appToken,
          Authorization: `user_token ${this.userToken}`,
          'Content-Type': 'application/json',
        },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.session_token) {
        throw new GlpiError('No se pudo iniciar sesion en GLPI', res.status, body);
      }
      this.sessionToken = body.session_token;

      // GLPI abre la sesion con el perfil predeterminado del usuario. Lo fijamos
      // para no depender de como este configurada la ficha.
      if (this.profileId) {
        await this.request('POST', '/changeActiveProfile', {
          body: { profiles_id: this.profileId }, retryOn401: false,
        });
      }
      log.info(`Sesion GLPI iniciada${this.profileId ? ` (perfil ${this.profileId})` : ''}`);
      return this.sessionToken;
    })().finally(() => { this._initializing = null; });
    return this._initializing;
  }

  async killSession() {
    if (!this.sessionToken) return;
    await this.request('GET', '/killSession').catch(() => {});
    this.sessionToken = null;
  }

  async request(method, path, { query, body, retryOn401 = true } = {}) {
    if (!this.sessionToken) await this.initSession();
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        'App-Token': this.appToken,
        'Session-Token': this.sessionToken,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retryOn401) {
      log.warn('Sesion GLPI caducada, reiniciando');
      this.sessionToken = null;
      await this.initSession();
      return this.request(method, path, { query, body, retryOn401: false });
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    // 200 OK, 201 Created, 206 Partial Content (rangos), 207 Multi-Status
    if (![200, 201, 204, 206, 207].includes(res.status)) {
      throw new GlpiError(`GLPI ${method} ${path} -> ${res.status}`, res.status, parsed);
    }
    return parsed;
  }

  // ---------- lecturas ----------

  /**
   * Tickets ordenados por ultima modificacion (desc). Recorremos paginas hasta
   * cruzar el cursor; no usamos criterios de fecha porque su semantica varia
   * entre versiones de GLPI, y este recorrido es equivalente y mas portable.
   */
  async searchTicketsModifiedSince(sinceIso, { pageSize = 50, maxPages = 20 } = {}) {
    const since = new Date(sinceIso).getTime();
    const out = [];
    for (let page = 0; page < maxPages; page += 1) {
      const start = page * pageSize;
      const params = new URLSearchParams({
        sort: String(TICKET_SO.DATE_MOD),
        order: 'DESC',
        range: `${start}-${start + pageSize - 1}`,
        rawdata: '0',
      });
      params.append('forcedisplay[0]', String(TICKET_SO.ID));
      params.append('forcedisplay[1]', String(TICKET_SO.DATE_MOD));

      let payload;
      try {
        payload = await this.request('GET', '/search/Ticket', { query: params.toString() });
      } catch (err) {
        if (err.status === 400 && start > 0) break; // rango fuera de limites
        throw err;
      }
      const rows = Object.values(payload?.data || {});
      if (rows.length === 0) break;

      let crossed = false;
      for (const row of rows) {
        const id = Number(row[TICKET_SO.ID]);
        const dateMod = glpiDateToIso(row[TICKET_SO.DATE_MOD]);
        if (!id) continue;
        if (dateMod && new Date(dateMod).getTime() <= since) { crossed = true; break; }
        out.push({ id, date_mod: dateMod });
      }
      if (crossed) break;
      if (rows.length < pageSize) break;
    }
    return out;
  }

  getTicket(id) {
    return this.request('GET', `/Ticket/${id}`);
  }

  async getFollowups(ticketId) {
    const data = await this.request('GET', `/Ticket/${ticketId}/ITILFollowup`, {
      query: new URLSearchParams({ range: '0-199', expand_dropdowns: '0' }).toString(),
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Documentos adjuntos a un seguimiento. Las imagenes GLPI las incrusta en el
   * contenido, pero los PDF y demas ficheros solo aparecen aqui.
   */
  async getFollowupDocumentIds(followupId) {
    const rows = await this.request('GET', `/ITILFollowup/${followupId}/Document_Item`, {
      query: new URLSearchParams({ range: '0-49' }).toString(),
    }).catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .map((r) => Number(r.documents_id))
      .filter(Boolean);
  }

  /** Documentos adjuntos a la solicitud inicial del ticket. */
  async getTicketDocumentIds(ticketId) {
    const rows = await this.request('GET', `/Ticket/${ticketId}/Document_Item`, {
      query: new URLSearchParams({ range: '0-49' }).toString(),
    }).catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r.itemtype === 'Ticket')
      .map((r) => Number(r.documents_id))
      .filter(Boolean);
  }

  async getSolutions(ticketId) {
    const data = await this.request('GET', `/Ticket/${ticketId}/ITILSolution`, {
      query: new URLSearchParams({ range: '0-49' }).toString(),
    }).catch(() => []);
    return Array.isArray(data) ? data : [];
  }

  /** Actores del ticket: type 1 = solicitante, 2 = asignado, 3 = observador. */
  async getTicketUsers(ticketId) {
    const data = await this.request('GET', `/Ticket/${ticketId}/Ticket_User`, {
      query: new URLSearchParams({ range: '0-99' }).toString(),
    }).catch(() => []);
    return Array.isArray(data) ? data : [];
  }

  /** Busca un email en la libreta de GLPI. Devuelve los users_id que lo tienen. */
  async findUsersByEmail(email) {
    const q = new URLSearchParams({ range: '0-9' });
    q.append('searchText[email]', email);
    const rows = await this.request('GET', '/UserEmail', { query: q.toString() }).catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => String(r.email || '').toLowerCase() === email.toLowerCase())
      .map((r) => Number(r.users_id));
  }

  async getUser(userId) {
    return this.request('GET', `/User/${userId}`).catch(() => null);
  }

  async getUserEmail(userId) {
    const rows = await this.request('GET', `/User/${userId}/UserEmail`, {
      query: new URLSearchParams({ range: '0-9' }).toString(),
    }).catch(() => []);
    const list = Array.isArray(rows) ? rows : [];
    const preferred = list.find((e) => Number(e.is_default) === 1) || list[0];
    if (preferred?.email) return preferred.email;
    const user = await this.getUser(userId);
    return user?.email || null;
  }

  /** Devuelve { users_id, email, name } del solicitante principal. */
  async getRequester(ticketId, ticket) {
    const actors = await this.getTicketUsers(ticketId);
    const requester = actors.find((a) => Number(a.type) === 1);
    const usersId = Number(requester?.users_id) || Number(ticket?.users_id_recipient) || 0;
    if (!usersId) {
      return { users_id: 0, email: requester?.alternative_email || null, name: null };
    }
    const [user, email] = await Promise.all([this.getUser(usersId), this.getUserEmail(usersId)]);
    const name = [user?.firstname, user?.realname].filter(Boolean).join(' ') || user?.name || null;
    return { users_id: usersId, email: email || requester?.alternative_email || null, name };
  }

  async getAssignedTechnician(ticketId) {
    const actors = await this.getTicketUsers(ticketId);
    const tech = actors.find((a) => Number(a.type) === 2);
    if (!tech?.users_id) return null;
    const [user, email] = await Promise.all([
      this.getUser(tech.users_id), this.getUserEmail(tech.users_id),
    ]);
    return { users_id: Number(tech.users_id), email, name: user?.realname || user?.name || null };
  }

  /** Metadatos de un documento: nombre real del fichero y tipo mime. */
  getDocument(id) {
    return this.request('GET', `/Document/${id}`);
  }

  /** Descarga el binario de un documento de GLPI. */
  async downloadDocument(id) {
    if (!this.sessionToken) await this.initSession();
    const meta = await this.getDocument(id).catch(() => null);
    const res = await fetch(`${this.baseUrl}/Document/${id}`, {
      headers: {
        'App-Token': this.appToken,
        'Session-Token': this.sessionToken,
        Accept: 'application/octet-stream',
      },
    });
    if (!res.ok) throw new GlpiError(`descarga del documento ${id} -> ${res.status}`, res.status, null);
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      buffer,
      filename: meta?.filename || `documento-${id}`,
      mime: meta?.mime || res.headers.get('content-type') || 'application/octet-stream',
      title: meta?.name || null,
    };
  }

  // ---------- escrituras ----------

  /**
   * Sube un fichero a GLPI y lo vincula al ticket.
   *
   * Son dos llamadas a proposito: si se mandan itemtype/items_id dentro del
   * uploadManifest, GLPI entra por otro camino y falla con "Fallo al mover el
   * archivo". Creamos el documento suelto y lo vinculamos despues.
   */
  async uploadDocument(ticketId, fichero) {
    const documentId = await this.createDocument(fichero);

    // GLPI puede responder 201 y aun asi no haber guardado el fichero: deja la
    // ficha con filepath vacio y un adjunto que no se puede abrir. Lo
    // comprobamos y, si ha pasado, borramos la ficha y avisamos.
    const creado = await this.getDocument(documentId).catch(() => null);
    if (!creado?.filepath) {
      await this.request('DELETE', `/Document/${documentId}`).catch(() => {});
      throw new GlpiError(
        'GLPI acepto el documento pero no guardo el fichero (filepath vacio). ' +
        'Casi siempre son los permisos del directorio de documentos en el servidor de GLPI.',
        500, null,
      );
    }

    await this.linkDocumentToTicket(documentId, ticketId);
    return documentId;
  }

  /** Vincula un documento ya existente a un ticket. */
  linkDocumentToTicket(documentId, ticketId) {
    return this.request('POST', '/Document_Item', {
      body: {
        input: {
          documents_id: Number(documentId),
          itemtype: 'Ticket',
          items_id: Number(ticketId),
        },
      },
    });
  }

  /**
   * Crea el documento. La API espera multipart: un campo uploadManifest con el
   * JSON y el binario en filename[0]. No hay que fijar Content-Type a mano:
   * fetch pone el boundary.
   */
  async createDocument({ buffer, filename, mime }) {
    if (!this.sessionToken) await this.initSession();
    const form = new FormData();
    form.append('uploadManifest', JSON.stringify({
      input: { name: filename, _filename: [filename] },
    }));
    form.append('filename[0]', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);

    const res = await fetch(`${this.baseUrl}/Document`, {
      method: 'POST',
      headers: { 'App-Token': this.appToken, 'Session-Token': this.sessionToken },
      body: form,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (![200, 201].includes(res.status)) {
      const detalle = Array.isArray(parsed) ? parsed[1] : null;
      if (detalle && /carpeta|permiso/i.test(String(detalle))) {
        throw new GlpiError(
          `GLPI no puede guardar el fichero: ${detalle} ` +
          '(permisos del directorio de documentos en el servidor de GLPI)',
          res.status, parsed,
        );
      }
      throw new GlpiError(
        `subida del documento a GLPI -> ${res.status}${detalle ? `: ${detalle}` : ''}`,
        res.status, parsed,
      );
    }
    const created = Array.isArray(parsed) ? parsed[0] : parsed;
    return Number(created?.id) || null;
  }

  /** Devuelve el ticket al estado indicado (reapertura). */
  reopenTicket(ticketId, status) {
    return this.request('PUT', `/Ticket/${ticketId}`, {
      body: { input: { id: Number(ticketId), status: Number(status) } },
    });
  }

  /** Reescribe el contenido de un seguimiento ya creado. */
  updateFollowup(followupId, contentHtml) {
    return this.request('PUT', `/ITILFollowup/${followupId}`, {
      body: { input: { id: Number(followupId), content: contentHtml } },
    });
  }

  /** Crea un seguimiento y devuelve su id (necesario para el anti-bucle). */
  async addFollowup(ticketId, contentHtml) {
    const payload = await this.request('POST', '/ITILFollowup', {
      body: { input: { itemtype: 'Ticket', items_id: Number(ticketId), content: contentHtml } },
    });
    const created = Array.isArray(payload) ? payload[0] : payload;
    const id = Number(created?.id);
    if (!id) throw new GlpiError('GLPI no devolvio el id del seguimiento', 200, payload);
    return id;
  }
}

/** '2026-09-21 10:32:11' (hora del servidor GLPI) -> ISO. */
export function glpiDateToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T')).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const glpi = new GlpiClient();

/** Enlace a la ficha del ticket en la interfaz web de GLPI. */
export function glpiTicketUrl(ticketId) {
  return `${config.glpi.url.replace(/\/apirest\.php$/, '')}/front/ticket.form.php?id=${ticketId}`;
}
