// Mapeo de los JSONB de `metricas_diarias` a filas de `public.ads_daily`.
//
// Puro y sin imports de servidor: lo comparten el worker (escritura en vivo), el
// backfill y sus tests. Que el mapeo viva en UN sitio es lo que garantiza que el
// backfill produzca exactamente lo mismo que el worker; si estuvieran duplicados,
// el `--verificar` compararía dos implementaciones distintas y no probaría nada.
//
// ── Formas reales de los elementos (muestreadas en producción) ───────────
// No son homogéneas, y las diferencias importan:
//
//   meta_campaigns   name, spend, clicks, impressions, reach, frequency, cpc,
//                    cpm, ctr, leads, results, purchases, link_clicks,
//                    video_views, adds_to_cart, initiates_checkout,
//                    landing_page_views
//                    → OJO: NO trae `campaign_id` ni `account_id` en las filas
//                      antiguas (de ahí que exista worker/backfill-campaign-ids),
//                      y usa `leads`, no `leads_form`.
//
//   meta_adsets      + adset_id, adset_name, campaign_id, campaign_name,
//                      account_id, leads_form, view_content, post_*, video_3s,
//                      search, contact, schedule, subscribe, start_trial,
//                      submit_application, complete_registration,
//                      messaging_conversations, page_engagement,
//                      add_to_wishlist, donate, find_location,
//                      customize_product, custom_conversions
//
//   meta_ads         igual que adsets + ad_id, ad_name
//
//   tiktok_campaigns name, spend, clicks, impressions, conversions,
//                    campaign_id, account_id
//   tiktok_adgroups  adgroup_id, adgroup_name, spend, clicks, impressions,
//                    conversions, account_id   → SIN campaign_id
//   tiktok_ads       ad_id, ad_name, …          → SIN campaign_id ni adgroup_id
//
// Esa ausencia de `campaign_id` en TikTok es exactamente por lo que sus anuncios
// no pueden colgar de una campaña y se descartan enteros bajo un filtro de
// campaña. Se arregla pidiendo los atributos a su API (ver el worker), no aquí.

export type Nivel = 'campaign' | 'adset' | 'ad';
export type Plataforma = 'meta' | 'tiktok';

/** Fila lista para insertar en `public.ads_daily`. */
export interface AdsDailyRow {
  cliente_id: string;
  fecha: string;
  plataforma: Plataforma;
  nivel: Nivel;
  entidad_key: string;
  entidad_id: string | null;
  entidad_nombre: string;
  campana_id: string | null;
  campana_nombre: string | null;
  adset_id: string | null;
  adset_nombre: string | null;
  cuenta_id: string | null;
  nombre_norm: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  link_clicks: number;
  leads_form: number;
  purchases: number;
  landing_page_views: number;
  complete_registration: number;
  adds_to_cart: number;
  initiates_checkout: number;
  view_content: number;
  video_views: number;
  video_thruplay: number;
  post_engagement: number;
  messaging_conversations: number;
  conversions: number;
  eventos: Record<string, unknown>;
  origen: string;
}

/**
 * Normalización de nombres. DEBE dar el mismo resultado que
 * `normLabel` en `bi-metadata.ts`, porque `nombre_norm` es lo que permite cruzar
 * en SQL lo que hoy se cruza en memoria. Se replica aquí en vez de importarse
 * para que este módulo lo pueda usar también el worker self-hosted, que compila
 * con su propio tsconfig y no arrastra el módulo del BI.
 *
 * Cubierto por test: `verify-ads-daily.ts` comprueba que las dos coinciden en
 * una batería de nombres reales.
 */
export function normNombre(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** Columnas propias: el resto de claves numéricas va a `eventos`. */
const COLUMNAS_EVENTO = new Set([
  'leads_form',
  'purchases',
  'landing_page_views',
  'complete_registration',
  'adds_to_cart',
  'initiates_checkout',
  'view_content',
  'video_views',
  'video_thruplay',
  'post_engagement',
  'messaging_conversations',
  'conversions',
]);

/** Claves que NO son un evento: son identidad, o ratios recalculables. */
const NO_EVENTO = new Set([
  'name',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'adgroup_id',
  'adgroup_name',
  'account_id',
  'spend',
  'impressions',
  'clicks',
  'reach',
  'link_clicks',
  // Se recalculan sobre los totales; guardarlos invitaría a promediarlos.
  'cpc',
  'cpm',
  'ctr',
  'frequency',
]);

/** De qué claves sale la identidad de la entidad en cada columna JSONB. */
interface Forma {
  plataforma: Plataforma;
  nivel: Nivel;
  /** Clave del id de la entidad. `null` = esta columna no lo trae. */
  idKey: string | null;
  /** Claves candidatas para el nombre, en orden de preferencia. */
  nameKeys: string[];
}

export const FORMAS: Record<string, Forma> = {
  meta_campaigns: {
    plataforma: 'meta',
    nivel: 'campaign',
    idKey: 'campaign_id',
    nameKeys: ['name', 'campaign_name'],
  },
  meta_adsets: {
    plataforma: 'meta',
    nivel: 'adset',
    idKey: 'adset_id',
    nameKeys: ['adset_name', 'name'],
  },
  meta_ads: { plataforma: 'meta', nivel: 'ad', idKey: 'ad_id', nameKeys: ['ad_name', 'name'] },
  tiktok_campaigns: {
    plataforma: 'tiktok',
    nivel: 'campaign',
    idKey: 'campaign_id',
    nameKeys: ['name', 'campaign_name'],
  },
  tiktok_adgroups: {
    plataforma: 'tiktok',
    nivel: 'adset',
    idKey: 'adgroup_id',
    nameKeys: ['adgroup_name', 'name'],
  },
  tiktok_ads: { plataforma: 'tiktok', nivel: 'ad', idKey: 'ad_id', nameKeys: ['ad_name', 'name'] },
};

/**
 * Convierte un elemento JSONB en una fila.
 *
 * Devuelve `null` cuando el elemento no tiene ni id ni nombre: sin ninguno de
 * los dos no hay `entidad_key` posible y la fila colisionaría con cualquier otra
 * igual de anónima. Se descarta explícitamente en vez de inventar una clave.
 */
export function mapElemento(
  columna: string,
  el: Record<string, unknown>,
  ctx: { cliente_id: string; fecha: string; origen?: string }
): AdsDailyRow | null {
  const forma = FORMAS[columna];
  if (!forma) return null;

  const entidad_id = forma.idKey ? str(el[forma.idKey]) : null;
  let entidad_nombre: string | null = null;
  for (const k of forma.nameKeys) {
    entidad_nombre = str(el[k]);
    if (entidad_nombre) break;
  }
  if (!entidad_id && !entidad_nombre) return null;

  const nombre = entidad_nombre ?? '(sin nombre)';
  const nombre_norm = normNombre(nombre);

  // `entidad_key`: el id cuando existe, y si no el nombre normalizado. Es lo
  // que hace estable el UNIQUE cuando la plataforma no da id — sin esto, dos
  // NULL no colisionan en el índice y la entidad se duplicaría cada sync.
  const entidad_key = entidad_id ?? `n:${nombre_norm}`;

  // La jerarquía: en el nivel campaña, la entidad ES la campaña.
  const campana_id = forma.nivel === 'campaign' ? entidad_id : str(el.campaign_id);
  const campana_nombre = forma.nivel === 'campaign' ? nombre : str(el.campaign_name);
  const adset_id = forma.nivel === 'adset' ? entidad_id : str(el.adset_id);
  const adset_nombre = forma.nivel === 'adset' ? nombre : str(el.adset_name);

  // Cola larga: todo lo numérico que no tiene columna propia. `custom_conversions`
  // se conserva tal cual porque es un objeto por cliente.
  const eventos: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (NO_EVENTO.has(k) || COLUMNAS_EVENTO.has(k)) continue;
    if (k === 'custom_conversions') {
      if (v && typeof v === 'object') eventos.custom = v;
      continue;
    }
    // `leads` se mapea a la columna leads_form más abajo; no se duplica aquí.
    if (k === 'leads') continue;
    const n = num(v);
    if (n !== 0) eventos[k] = n;
  }

  return {
    cliente_id: ctx.cliente_id,
    fecha: ctx.fecha,
    plataforma: forma.plataforma,
    nivel: forma.nivel,
    entidad_key,
    entidad_id,
    entidad_nombre: nombre,
    campana_id,
    campana_nombre,
    adset_id,
    adset_nombre,
    cuenta_id: str(el.account_id),
    nombre_norm,
    spend: num(el.spend),
    impressions: num(el.impressions),
    clicks: num(el.clicks),
    reach: num(el.reach),
    link_clicks: num(el.link_clicks),
    // `meta_campaigns` usa `leads`; adsets y ads usan `leads_form`. Se
    // prefiere el específico y se cae al genérico, porque si no el nivel
    // campaña quedaría siempre en 0 para esta métrica.
    leads_form: num(el.leads_form ?? el.leads),
    purchases: num(el.purchases),
    landing_page_views: num(el.landing_page_views),
    complete_registration: num(el.complete_registration),
    adds_to_cart: num(el.adds_to_cart),
    initiates_checkout: num(el.initiates_checkout),
    view_content: num(el.view_content),
    video_views: num(el.video_views),
    video_thruplay: num(el.video_thruplay),
    post_engagement: num(el.post_engagement),
    messaging_conversations: num(el.messaging_conversations),
    conversions: num(el.conversions),
    eventos,
    origen: ctx.origen ?? 'worker',
  };
}

/**
 * Niveles que se guardan para una fecha dada.
 *
 * Campaña y conjunto SIEMPRE: son los ejes con los que se agrupan los informes,
 * incluso los antiguos. El nivel anuncio solo en la ventana reciente, porque es
 * el 65% de las filas (111.800 de 171.666) y es lo que hace que la tabla no
 * quepa en el tope de 500 MB del plan. El desglose por anuncio de fechas viejas
 * sigue estando en el JSONB de `metricas_diarias`.
 */
export const VENTANA_NIVEL_AD_DIAS = 30;

export function nivelesParaFecha(fecha: string, hoy: string): Nivel[] {
  const diff = Math.floor(
    (Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${fecha}T00:00:00Z`)) / 86_400_000
  );
  return diff <= VENTANA_NIVEL_AD_DIAS ? ['campaign', 'adset', 'ad'] : ['campaign', 'adset'];
}

/** Fila de `metricas_diarias` con los 6 JSONB (lo que hace falta del select). */
export interface MetricasDiariasRow {
  cliente_id: string;
  fecha: string;
  meta_campaigns?: unknown;
  meta_adsets?: unknown;
  meta_ads?: unknown;
  tiktok_campaigns?: unknown;
  tiktok_adgroups?: unknown;
  tiktok_ads?: unknown;
}

/**
 * Expande una fila día×cliente a sus filas de `ads_daily`, respetando la ventana
 * de retención del nivel anuncio.
 *
 * Deduplica por la clave del UNIQUE: dentro de un mismo día la plataforma puede
 * repetir una entidad (varias cuentas de anuncios, o un anuncio en dos filas).
 * Sin deduplicar, el insert fallaría entero por conflicto.
 */
export function expandirFila(
  row: MetricasDiariasRow,
  opts: { hoy: string; origen?: string }
): AdsDailyRow[] {
  const niveles = new Set(nivelesParaFecha(row.fecha, opts.hoy));
  const porClave = new Map<string, AdsDailyRow>();

  for (const [columna, forma] of Object.entries(FORMAS)) {
    if (!niveles.has(forma.nivel)) continue;
    const arr = (row as unknown as Record<string, unknown>)[columna];
    if (!Array.isArray(arr)) continue;

    for (const el of arr) {
      if (!el || typeof el !== 'object') continue;
      const fila = mapElemento(columna, el as Record<string, unknown>, {
        cliente_id: row.cliente_id,
        fecha: row.fecha,
        origen: opts.origen,
      });
      if (!fila) continue;
      const k = `${fila.plataforma}|${fila.nivel}|${fila.entidad_key}`;
      const previa = porClave.get(k);
      if (!previa) {
        porClave.set(k, fila);
        continue;
      }
      // Repetida en el mismo día: se SUMAN las métricas aditivas. Es lo que
      // hace hoy el motor al recorrer el array, así que el total cuadra.
      // `reach` se queda con el máximo: son personas únicas, no se suma.
      porClave.set(k, sumarFilas(previa, fila));
    }
  }
  return [...porClave.values()];
}

const ADITIVAS = [
  'spend',
  'impressions',
  'clicks',
  'link_clicks',
  'leads_form',
  'purchases',
  'landing_page_views',
  'complete_registration',
  'adds_to_cart',
  'initiates_checkout',
  'view_content',
  'video_views',
  'video_thruplay',
  'post_engagement',
  'messaging_conversations',
  'conversions',
] as const;

function sumarFilas(a: AdsDailyRow, b: AdsDailyRow): AdsDailyRow {
  const out = { ...a };
  for (const k of ADITIVAS) out[k] = a[k] + b[k];
  // Personas únicas: sumar contaría dos veces a quien vio ambas.
  out.reach = Math.max(a.reach, b.reach);
  const eventos: Record<string, unknown> = { ...a.eventos };
  for (const [k, v] of Object.entries(b.eventos)) {
    if (k === 'custom') continue;
    eventos[k] = num(eventos[k]) + num(v);
  }
  if (a.eventos.custom || b.eventos.custom) {
    eventos.custom = {
      ...((a.eventos.custom as object) ?? {}),
      ...((b.eventos.custom as object) ?? {}),
    };
  }
  out.eventos = eventos;
  // Se conserva la identidad más completa de las dos.
  out.entidad_id = a.entidad_id ?? b.entidad_id;
  out.campana_id = a.campana_id ?? b.campana_id;
  out.campana_nombre = a.campana_nombre ?? b.campana_nombre;
  out.adset_id = a.adset_id ?? b.adset_id;
  out.adset_nombre = a.adset_nombre ?? b.adset_nombre;
  out.cuenta_id = a.cuenta_id ?? b.cuenta_id;
  return out;
}
