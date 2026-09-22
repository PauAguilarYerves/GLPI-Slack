// Conversiones entre el HTML de GLPI y el mrkdwn de Slack.

const BASE_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', laquo: '«', raquo: '»', bull: '•',
  middot: '·', deg: '°', euro: '€', copy: '©', reg: '®', trade: '™',
  iquest: '¿', iexcl: '¡', ordm: 'º', orda: 'ª', ordf: 'ª', sect: '§', para: '¶',
};

// Entidades Latin-1 con acento: &aacute; &Ntilde; &uuml; ...
const ACCENTS = {
  acute: ['aeiouyAEIOUY', 'áéíóúýÁÉÍÓÚÝ'],
  grave: ['aeiouAEIOU', 'àèìòùÀÈÌÒÙ'],
  circ: ['aeiouAEIOU', 'âêîôûÂÊÎÔÛ'],
  uml: ['aeiouyAEIOU', 'äëïöüÿÄËÏÖÜ'],
  tilde: ['anoANO', 'ãñõÃÑÕ'],
  cedil: ['cC', 'çÇ'],
  ring: ['aA', 'åÅ'],
  slash: ['oO', 'øØ'],
};
const ENTITIES = { ...BASE_ENTITIES };
for (const [suffix, [letters, chars]] of Object.entries(ACCENTS)) {
  [...letters].forEach((letter, i) => { ENTITIES[`${letter}${suffix}`] = [...chars][i]; });
}

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
    if (name[0] === '#') {
      const isHex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(isHex ? name.slice(2) : name.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    // Entidad desconocida: la dejamos sin el '&' para no acabar con '&amp;xxx;'.
    return ENTITIES[name] ?? name;
  });
}

/** Escapa los tres caracteres que Slack interpreta como marcado. */
export function escapeSlack(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * GLPI incrusta los adjuntos dentro del propio contenido del seguimiento, como
 * enlaces a /front/document.send.php?docid=NNNN. De ahi sacamos que ficheros
 * acompanan al mensaje; no hace falta mirar Document_Item.
 */
export function extractGlpiDocIds(html) {
  const ids = new Set();
  for (const m of String(html || '').matchAll(/document\.send\.php\?docid=(\d+)/gi)) {
    ids.add(Number(m[1]));
  }
  return [...ids];
}

/** HTML de GLPI -> texto plano listo para Slack. */
export function glpiHtmlToSlack(html) {
  if (!html) return '';

  // GLPI devuelve el contenido con el HTML escapado (&lt;p&gt;Hola&lt;/p&gt;).
  // Hay que decodificar ANTES de quitar etiquetas: al reves, el filtro de
  // etiquetas no encuentra nada y el usuario acaba viendo los <p> en Slack.
  let t = decodeEntities(String(html));

  t = t
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Los adjuntos se suben a Slack como ficheros de verdad, asi que quitamos
    // del texto las imagenes incrustadas y los enlaces a document.send.php.
    .replace(/<img[^>]*>/gi, '')
    .replace(/<a[^>]*document\.send\.php[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/\(?\/?front\/document\.send\.php\?[^)\s]*\)?/gi, '');

  return escapeSlack(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Texto de Slack -> HTML simple para el campo content de GLPI. */
export function slackToGlpiHtml(text, authorLabel) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const header = authorLabel
    ? `<p><em>Respuesta recibida desde Slack — ${authorLabel}</em></p>`
    : '';
  return `${header}<p>${escaped}</p>`;
}

export function truncate(s, max = 2900) {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, max)}\n… (mensaje recortado, consulta el ticket completo en GLPI)`;
}
