/**
 * E/S del catálogo de conversiones personalizadas de Meta
 * (`public.meta_conversiones_catalogo`).
 *
 * Un único camino para el worker (descubre de paso, en cada sync de métricas) y
 * para el botón «Sincronizar» de ajustes (descubre a nivel cuenta, 90 días).
 * Antes cada uno tenía su copia de la lógica de nombres, sin paginar
 * `/customconversions` y pisando el nombre en cada corrida.
 *
 * El guardado NUNCA toca lo que decide el usuario (nombre manual, tipo, si
 * cuenta como resultado, archivada). Con la migración 096 lo garantiza la RPC
 * `upsert_meta_conversiones`; sin ella, se cae a un upsert de las columnas
 * antiguas (081), que tampoco las tiene.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  extraerConversionesPersonalizadas,
  etiquetaEfectiva,
  inferirTipo,
  type OrigenConversion,
} from './conversiones-personalizadas';

export const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v19.0';

/**
 * Ventana de atribución explícita para /insights: sin ella Meta aplica la de
 * cada cuenta y las cifras no serían comparables entre clientes. 7d_click +
 * 1d_view es el estándar de Meta desde iOS 14.
 */
export const META_ATTRIBUTION_WINDOWS = JSON.stringify(['7d_click', '1d_view']);

const GRAPH = () => `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const MAX_PAGINAS = 20;

export interface CuentaMeta {
  account_id: string;
  token: string;
}

export interface ConversionDescubierta {
  origen: OrigenConversion;
  /** Sufijo con sus mayúsculas originales. */
  original: string;
  /** Último día (yyyy-MM-dd) con valor > 0. */
  ultimaActividad: string | null;
}

export interface CustomConversionMeta {
  id: string;
  name: string;
  rule: unknown;
  custom_event_type: string | null;
  is_archived: boolean;
  last_fired_time: string | null;
  cuenta_id: string;
}

const actDe = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);

type Fetcher = (url: string) => Promise<{ json(): Promise<any> }>;

/** Sigue `paging.next`. Devuelve `null` si la primera página falla. */
async function paginar(
  primera: string,
  fetcher: Fetcher,
  log: (m: string) => void
): Promise<any[] | null> {
  const out: any[] = [];
  let next: string | null = primera;
  let n = 0;
  while (next && n < MAX_PAGINAS) {
    const data = await (await fetcher(next)).json();
    if (!data || data.error || !Array.isArray(data.data)) {
      log(`[conversiones] Meta respondió error: ${data?.error?.message ?? 'formato inesperado'}`);
      return n === 0 ? null : out;
    }
    out.push(...data.data);
    next = data.paging?.next ?? null;
    n++;
  }
  return out;
}

/** Acumula lo descubierto en un día, quedándose con la actividad más reciente. */
export function acumularDescubiertas(
  acc: Map<string, ConversionDescubierta>,
  dia: string | null,
  extraidas: ReturnType<typeof extraerConversionesPersonalizadas>
): void {
  for (const [key, { origen, original }] of Object.entries(extraidas.nombres)) {
    const valor = extraidas.valores[key] ?? 0;
    const prev = acc.get(key);
    const actividad = valor > 0 ? dia : null;
    if (!prev) {
      acc.set(key, { origen, original, ultimaActividad: actividad });
      continue;
    }
    // Una CC gana a un evento con la misma clave (no debería pasar: ids numéricos).
    if (prev.origen !== 'cc' && origen === 'cc') prev.origen = 'cc';
    if (actividad && (!prev.ultimaActividad || actividad > prev.ultimaActividad)) {
      prev.ultimaActividad = actividad;
      prev.original = original;
    }
  }
}

/**
 * Conversiones con actividad en `[desde, hasta]`, a nivel cuenta y por día.
 * Lee `actions` (CC) y `conversions` (eventos del píxel).
 */
export async function descubrirConversiones(
  cuentas: CuentaMeta[],
  desde: string,
  hasta: string,
  opts: { fetcher?: Fetcher; log?: (m: string) => void } = {}
): Promise<{ descubiertas: Map<string, ConversionDescubierta>; cuentasConError: string[] }> {
  const fetcher: Fetcher = opts.fetcher ?? ((u) => fetch(u));
  const log = opts.log ?? (() => {});
  const descubiertas = new Map<string, ConversionDescubierta>();
  const cuentasConError: string[] = [];
  await Promise.all(
    cuentas.map(async ({ account_id, token }) => {
      const url = new URL(`${GRAPH()}/${actDe(account_id)}/insights`);
      url.searchParams.set('access_token', token);
      url.searchParams.set('time_range', JSON.stringify({ since: desde, until: hasta }));
      url.searchParams.set('time_increment', '1');
      url.searchParams.set('fields', 'actions,conversions');
      url.searchParams.set('action_attribution_windows', META_ATTRIBUTION_WINDOWS);
      url.searchParams.set('level', 'account');
      url.searchParams.set('limit', '500');
      const filas = await paginar(url.toString(), fetcher, log).catch((e) => {
        log(`[conversiones] ${account_id}: ${e?.message}`);
        return null;
      });
      if (!filas) {
        cuentasConError.push(account_id);
        return;
      }
      for (const f of filas) {
        acumularDescubiertas(
          descubiertas,
          f?.date_start ?? null,
          extraerConversionesPersonalizadas(f?.actions, f?.conversions)
        );
      }
    })
  );
  return { descubiertas, cuentasConError };
}

/** Todas las conversiones personalizadas (reglas) de las cuentas, paginadas. */
export async function listarCustomConversions(
  cuentas: CuentaMeta[],
  opts: { fetcher?: Fetcher; log?: (m: string) => void } = {}
): Promise<Map<string, CustomConversionMeta>> {
  const fetcher: Fetcher = opts.fetcher ?? ((u) => fetch(u));
  const log = opts.log ?? (() => {});
  const out = new Map<string, CustomConversionMeta>();
  await Promise.all(
    cuentas.map(async ({ account_id, token }) => {
      const url = new URL(`${GRAPH()}/${actDe(account_id)}/customconversions`);
      url.searchParams.set('access_token', token);
      url.searchParams.set('fields', 'id,name,rule,custom_event_type,is_archived,last_fired_time');
      url.searchParams.set('limit', '500');
      const filas = await paginar(url.toString(), fetcher, log).catch((e) => {
        log(`[conversiones] customconversions ${account_id}: ${e?.message}`);
        return null;
      });
      for (const c of filas ?? []) {
        if (!c?.id) continue;
        out.set(String(c.id), {
          id: String(c.id),
          name: String(c.name ?? ''),
          rule: c.rule ?? null,
          custom_event_type: c.custom_event_type ?? null,
          is_archived: Boolean(c.is_archived),
          last_fired_time: c.last_fired_time ?? null,
          cuenta_id: account_id.replace(/^act_/, ''),
        });
      }
    })
  );
  return out;
}

export interface FilaCatalogo {
  conversion_key: string;
  field_id: string;
  origen: OrigenConversion;
  nombre_meta: string;
  regla: unknown;
  custom_event_type: string | null;
  cuenta_id: string | null;
  tipo: string;
  ultima_actividad: string | null;
}

/** Filas a guardar a partir de lo descubierto y los nombres de las CC. Puro. */
export function filasCatalogo(
  descubiertas: Map<string, ConversionDescubierta>,
  ccs: Map<string, CustomConversionMeta>
): FilaCatalogo[] {
  return Array.from(descubiertas, ([key, d]) => {
    const cc = d.origen === 'cc' ? ccs.get(key) : undefined;
    const nombre = cc?.name?.trim() || d.original;
    return {
      conversion_key: key,
      field_id: `meta_custom_${key}`,
      origen: d.origen,
      nombre_meta: nombre,
      regla: cc?.rule ?? null,
      custom_event_type: cc?.custom_event_type ?? null,
      cuenta_id: cc?.cuenta_id ?? null,
      tipo: inferirTipo(cc?.custom_event_type, nombre),
      ultima_actividad: d.ultimaActividad,
    };
  });
}

const esFuncionInexistente = (e: any) =>
  e?.code === 'PGRST202' ||
  e?.code === '42883' ||
  /function .* does not exist|Could not find the function/i.test(String(e?.message ?? ''));

/**
 * Guarda el catálogo del cliente. `last_seen`/`ultima_actividad` nunca
 * retroceden (una resincronización histórica no hace «antigua» una conversión
 * activa). Devuelve cuántas filas eran nuevas.
 */
export async function guardarCatalogo(
  db: any,
  clienteId: string,
  filas: FilaCatalogo[],
  hoy: string
): Promise<{ error: string | null; nuevas: number; total: number }> {
  if (filas.length === 0) return { error: null, nuevas: 0, total: 0 };

  const { data: previas } = await db
    .from('meta_conversiones_catalogo')
    .select('conversion_key, last_seen')
    .eq('cliente_id', clienteId);
  const previo = new Map<string, string | null>(
    ((previas ?? []) as any[]).map((r) => [r.conversion_key, r.last_seen ?? null])
  );
  const nuevas = filas.filter((f) => !previo.has(f.conversion_key)).length;

  const rpc = await db.rpc('upsert_meta_conversiones', {
    p_cliente_id: clienteId,
    p_filas: filas,
  });
  if (!rpc.error) return { error: null, nuevas, total: filas.length };
  if (!esFuncionInexistente(rpc.error)) {
    return { error: rpc.error.message, nuevas: 0, total: 0 };
  }

  // Sin la migración 096: solo columnas de la 081.
  const max = (a: string | null | undefined, b: string | null | undefined) =>
    !a ? (b ?? null) : !b ? a : a > b ? a : b;
  const legacy = filas.map((f) => ({
    cliente_id: clienteId,
    conversion_key: f.conversion_key,
    label: etiquetaEfectiva({ nombre_meta: f.nombre_meta, key: f.conversion_key }),
    field_id: f.field_id,
    last_seen: max(previo.get(f.conversion_key), f.ultima_actividad) ?? hoy,
  }));
  const { error } = await db
    .from('meta_conversiones_catalogo')
    .upsert(legacy, { onConflict: 'cliente_id,conversion_key' });
  return error
    ? { error: error.message, nuevas: 0, total: 0 }
    : { error: null, nuevas, total: filas.length };
}

/**
 * Descubre y guarda en un paso (botón de ajustes y backfill). Solo consulta
 * `/customconversions` si apareció alguna CC.
 */
export async function sincronizarCatalogo(
  db: any,
  clienteId: string,
  cuentas: CuentaMeta[],
  desde: string,
  hasta: string,
  opts: { log?: (m: string) => void } = {}
): Promise<{
  error: string | null;
  nuevas: number;
  total: number;
  cuentasConError: string[];
  claves: string[];
}> {
  const { descubiertas, cuentasConError } = await descubrirConversiones(
    cuentas,
    desde,
    hasta,
    opts
  );
  const hayCc = Array.from(descubiertas.values()).some((d) => d.origen === 'cc');
  const ccs = hayCc ? await listarCustomConversions(cuentas, opts) : new Map();
  const filas = filasCatalogo(descubiertas, ccs);
  const r = await guardarCatalogo(db, clienteId, filas, hasta);
  return { ...r, cuentasConError, claves: filas.map((f) => f.conversion_key) };
}
