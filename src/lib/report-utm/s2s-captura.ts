// ── Captura de un evento web: UTMs, IDs, IP del visitante e idempotencia ──
//
// Lo comparten el endpoint del pixel JS (`/pixel/event`) y el S2S de WordPress
// (`/pixel/s2s`). Vive aparte y sin base de datos para que las comprobaciones
// (scripts/verify-s2s-captura.ts) lo ejerciten sin firma HMAC ni Postgres.
//
// Cuatro agujeros que tapa, todos medidos en la captura de WordPress:
//
//   1. El body ganaba a la URL con `??`, así que un `utm_source: ""` del body
//      tapaba el `utm_source=fb` de la landing. Ahora gana el primer valor NO
//      VACÍO, venga de donde venga.
//   2. La IP y el país salían de las cabeceras de la petición, que en el S2S es
//      el servidor de WordPress, no el visitante. El plugin manda la IP real en
//      el body; aquí se valida que sea pública antes de creérsela.
//   3. Un reintento de WordPress duplicaba el lead. Ahora cada lead lleva un
//      `external_id` (`s2s:<hash>`) y el índice único de la migración 035
//      (`cliente_id, external_id`) rechaza la segunda copia.
//   4. Un formulario enviado desde una página sin UTM (la de «gracias», un
//      popup en otra URL) llegaba sin atribución aunque el visitante hubiera
//      entrado por un anuncio. El plugin reenvía las cookies de toque del pixel
//      y aquí se usa la del último toque cuando la URL no trae nada.

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { claveEmail, claveTelefono } from './lead-duplicados';
import { idPublicitario } from './lead-ids';

// ── Utilidades puras ──────────────────────────────────────────────────

/** Texto limpio o null. Un `""` o un `"  "` no es un valor. */
export function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Primer valor no vacío, en orden de prioridad. */
export function primerNoVacio(...vals: unknown[]): string | null {
  for (const v of vals) {
    const t = txt(v);
    if (t) return t;
  }
  return null;
}

/**
 * Primer candidato que es un ID de plataforma de verdad. No basta con el primero
 * no vacío: una macro sin rellenar (`{{ad.id}}`) en el body taparía el ID bueno
 * de la URL y luego se descartaría, perdiendo los dos.
 */
function primerId(...vals: unknown[]): string | null {
  for (const v of vals) {
    const id = idPublicitario(v);
    if (id) return id;
  }
  return null;
}

// ── UTMs e IDs ────────────────────────────────────────────────────────

export const CAMPOS_UTM = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'click_id',
] as const;
export const CAMPOS_ID = ['campaign_id', 'adset_id', 'ad_id'] as const;

export type CampoCaptura = (typeof CAMPOS_UTM)[number] | (typeof CAMPOS_ID)[number];
export type CamposCaptura = Record<CampoCaptura, string | null>;

const VACIO: CamposCaptura = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  utm_id: null,
  click_id: null,
  campaign_id: null,
  adset_id: null,
  ad_id: null,
};

/**
 * UTMs, click id e IDs de la query string de una URL.
 *
 * El plugin de WordPress manda `page_url` (el referer: la landing con sus UTMs)
 * y no los UTMs sueltos. Hay que leerlos ANTES de `normalizarPageUrl`, que
 * recorta `utm_*` y los click ids de la URL que se guarda.
 */
export function parseUtmsFromUrl(url: string | null | undefined): Partial<CamposCaptura> {
  if (!url) return {};
  try {
    const qs = new URL(url).searchParams;
    return {
      utm_source: txt(qs.get('utm_source')),
      utm_medium: txt(qs.get('utm_medium')),
      utm_campaign: txt(qs.get('utm_campaign')),
      utm_content: txt(qs.get('utm_content')),
      utm_term: txt(qs.get('utm_term')),
      utm_id: txt(qs.get('utm_id')),
      campaign_id: txt(qs.get('campaign_id')),
      adset_id: txt(qs.get('adset_id')),
      ad_id: txt(qs.get('ad_id')),
      // `fbclid=` vacío no debe tapar un `gclid` con valor.
      click_id: primerNoVacio(
        qs.get('fbclid'),
        qs.get('gclid'),
        qs.get('ttclid'),
        qs.get('click_id')
      ),
    };
  } catch {
    return {};
  }
}

/**
 * ¿Trae el evento algo que atribuya? Mismo criterio que el pixel para reescribir
 * la cookie de último toque: fuente, campaña, medio, click id o un ID de la
 * entidad. `utm_content` y `utm_term` solos no bastan: sin campaña no cruzan.
 */
export function tieneSenal(c: Partial<CamposCaptura>): boolean {
  return Boolean(
    c.utm_source ||
    c.utm_campaign ||
    c.utm_medium ||
    c.click_id ||
    c.utm_id ||
    c.campaign_id ||
    c.adset_id ||
    c.ad_id
  );
}

/**
 * Un toque del pixel (cookie `rutm_ft` / `rutm_lt`) traducido a campos.
 *
 * El pixel guarda `source`, `medium`, `campaign`, `content`, `term`,
 * `click_id` y los IDs con su nombre (`utm_id`, `campaign_id`…). El plugin lo
 * reenvía como objeto, pero se acepta también la cadena JSON tal cual sale de
 * la cookie, y los nombres `utm_*` por si otro emisor los manda así.
 */
export function camposDeToque(v: unknown): Partial<CamposCaptura> | null {
  let t: unknown = v;
  if (typeof t === 'string') {
    let s = t.trim();
    if (!s) return null;
    // La cookie viaja con percent-encoding (`encodeURIComponent` en el pixel).
    if (s.startsWith('%7B') || s.startsWith('%7b')) {
      try {
        s = decodeURIComponent(s);
      } catch {
        return null;
      }
    }
    try {
      t = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const o = t as Record<string, unknown>;
  return {
    utm_source: primerNoVacio(o.source, o.utm_source),
    utm_medium: primerNoVacio(o.medium, o.utm_medium),
    utm_campaign: primerNoVacio(o.campaign, o.utm_campaign),
    utm_content: primerNoVacio(o.content, o.utm_content),
    utm_term: primerNoVacio(o.term, o.utm_term),
    utm_id: txt(o.utm_id),
    click_id: txt(o.click_id),
    campaign_id: txt(o.campaign_id),
    adset_id: txt(o.adset_id),
    ad_id: txt(o.ad_id),
  };
}

/** Lo que `resolverCampos` lee del body. */
export type BodyCaptura = Partial<Record<CampoCaptura, unknown>> & {
  page_url?: unknown;
  /** Cookie `rutm_lt` del pixel, reenviada por el plugin (0.5.0). */
  last_touch?: unknown;
  /** Cookie `rutm_ft` del pixel: solo se usa si no llega la de último toque. */
  first_touch?: unknown;
};

export type CamposResueltos = CamposCaptura & {
  /** De dónde salió la atribución: el propio evento o la cookie de toque. */
  origen: 'evento' | 'toque' | 'ninguno';
};

/**
 * UTMs e IDs efectivos de un evento.
 *
 *   1. Cada campo: primer valor no vacío entre el body y la URL de la página.
 *   2. Si con eso el evento no trae NINGUNA señal, se toma el último toque
 *      (o el primero, si no hay último) que reenvía el plugin. Va en bloque y
 *      no campo a campo: mezclar la fuente de la URL con la campaña de la
 *      cookie inventaría una combinación que no existió.
 *
 * Los IDs de la entidad solo se aceptan si son IDs de verdad (ver lead-ids.ts).
 */
export function resolverCampos(body: BodyCaptura): CamposResueltos {
  const url = parseUtmsFromUrl(txt(body.page_url));
  const directo: CamposCaptura = { ...VACIO };
  for (const k of CAMPOS_UTM) directo[k] = primerNoVacio(body[k], url[k]);
  for (const k of CAMPOS_ID) directo[k] = primerId(body[k], url[k]);
  if (tieneSenal(directo)) return { ...directo, origen: 'evento' };

  const toque = [camposDeToque(body.last_touch), camposDeToque(body.first_touch)].find(
    (t): t is Partial<CamposCaptura> => t !== null && tieneSenal(t)
  );
  if (!toque) return { ...directo, origen: 'ninguno' };

  const out: CamposCaptura = { ...VACIO };
  for (const k of CAMPOS_UTM) out[k] = primerNoVacio(directo[k], toque[k]);
  for (const k of CAMPOS_ID) out[k] = primerId(directo[k], toque[k]);
  return { ...out, origen: tieneSenal(out) ? 'toque' : 'ninguno' };
}

/**
 * Guarda `utm_id` y los IDs de la entidad dentro de `custom_data`.
 *
 * `pixel_events` no tiene columnas para ellos (migraciones 013 y 026) y no se
 * añaden: la tabla se purga a los pocos días y nadie cruza por ahí. Pero el
 * pixel ya los manda, y tirarlos dejaría el pageview sin lo único que lo ata al
 * anuncio. Van bajo una clave propia (`_rutm_ids`) para no pisar lo que el sitio
 * mande en `rutm('track', …, datos)`. Sin ningún ID no se toca nada.
 */
export function customDataConIds(
  custom: unknown,
  c: Pick<CamposCaptura, 'utm_id' | 'campaign_id' | 'adset_id' | 'ad_id'>
): Record<string, unknown> | null {
  const base =
    custom && typeof custom === 'object' && !Array.isArray(custom)
      ? (custom as Record<string, unknown>)
      : null;
  const ids: Record<string, string> = {};
  for (const k of ['utm_id', 'campaign_id', 'adset_id', 'ad_id'] as const) {
    if (c[k]) ids[k] = c[k] as string;
  }
  if (Object.keys(ids).length === 0) return base;
  return { ...(base ?? {}), _rutm_ids: ids };
}

// ── IP y país del visitante ───────────────────────────────────────────

function ipv4Privada(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast y reservadas (incluye 255.255.255.255)
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Privada(ip: string): boolean {
  const s = ip.toLowerCase();
  // IPv4 mapeada (`::ffff:10.0.0.1`): manda la IPv4 de dentro.
  const mapeada = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeada) return ipv4Privada(mapeada[1]);
  if (s === '::' || s === '::1') return true;
  const primer = parseInt(s.split(':')[0] || '0', 16);
  return (
    (primer & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
    (primer & 0xffc0) === 0xfe80 || // fe80::/10 (enlace local)
    (primer & 0xff00) === 0xff00 || // ff00::/8 (multicast)
    s.startsWith('2001:db8:') || // documentación
    s.startsWith('::') // sin prefijo: compatibles IPv4 y reservadas
  );
}

/**
 * La IP si es una IPv4/IPv6 válida y PÚBLICA; si no, null.
 *
 * Una privada (10.x, 192.168.x, ::1…) es la del proxy o el balanceador delante
 * de WordPress, no la del visitante: guardarla sería tan inútil como la del
 * servidor, y mentiría más porque parece de alguien.
 */
export function ipPublica(v: unknown): string | null {
  const ip = txt(v);
  if (!ip || ip.length > 45) return null;
  const version = isIP(ip);
  if (version === 4) return ipv4Privada(ip) ? null : ip;
  if (version === 6) return ipv6Privada(ip) ? null : ip;
  return null;
}

/**
 * País ISO-3166 de dos letras, o null. `XX` (desconocido) y `T1` (Tor) son los
 * comodines de Cloudflare y no son países.
 */
export function paisVisitante(v: unknown): string | null {
  const p = txt(v)?.toUpperCase() ?? null;
  if (!p || !/^[A-Z]{2}$/.test(p) || p === 'XX') return null;
  return p;
}

// ── Idempotencia: external_id ─────────────────────────────────────────

export const PREFIJO_EXTERNAL_S2S = 's2s:';
const LARGO_MAX_EXTERNAL = 200;

/** Lo que `externalIdS2S` lee del body. */
export type BodyExternalId = {
  external_id?: unknown;
  form_id?: unknown;
  form_name?: unknown;
  lead_email?: unknown;
  lead_phone?: unknown;
};

/**
 * `external_id` del lead S2S, con prefijo `s2s:`.
 *
 * El índice único `(cliente_id, external_id)` de la migración 035 lo comparten
 * Meta Lead Ads (leadgen_id crudo) y GHL (`ghl:`); el prefijo impide que un id
 * de WordPress choque con uno de ellos. Por eso se añade también al que manda
 * el plugin si no lo trae.
 *
 * Si el plugin no manda ninguno (versiones anteriores a la 0.5.0) se deriva uno
 * determinista: hash de formulario + contacto normalizado + minuto del evento.
 * Así un doble envío del mismo formulario en el mismo minuto cae en el índice.
 * Sin email ni teléfono no hay nada estable que hashear y se devuelve null: dos
 * leads anónimos distintos del mismo formulario y minuto se fundirían en uno.
 *
 * El plugin 0.5.0 calcula el mismo hash en PHP (`build_external_id`) al primer
 * intento y lo reutiliza en cada reintento, que es lo que hace idempotente el
 * reintento aunque llegue minutos después.
 */
export function externalIdS2S(body: BodyExternalId, ahora: Date): string | null {
  const propio = txt(body.external_id);
  if (propio) {
    const conPrefijo = propio.startsWith(PREFIJO_EXTERNAL_S2S)
      ? propio
      : `${PREFIJO_EXTERNAL_S2S}${propio}`;
    return conPrefijo.slice(0, LARGO_MAX_EXTERNAL);
  }
  const email = claveEmail(body.lead_email);
  const telefono = claveTelefono(body.lead_phone);
  const contacto = email ? `e:${email}` : telefono ? `t:${telefono}` : null;
  if (!contacto) return null;
  const formulario = primerNoVacio(body.form_id, body.form_name) ?? '';
  // Minuto UTC: `2026-09-28T14:05`. Mismo formato que `gmdate('Y-m-d\TH:i')`.
  const minuto = ahora.toISOString().slice(0, 16);
  const hash = createHash('sha256').update(`${formulario}|${contacto}|${minuto}`).digest('hex');
  return `${PREFIJO_EXTERNAL_S2S}${hash.slice(0, 32)}`;
}
