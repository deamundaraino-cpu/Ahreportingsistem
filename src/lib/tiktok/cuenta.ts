/**
 * Moneda y zona horaria de una cuenta publicitaria de TikTok.
 *
 * Por qué existe
 * ──────────────
 * El worker guarda `spend` de TikTok tal cual lo devuelve la API, sin saber en
 * qué moneda está ni en qué zona horaria corta TikTok el día de sus informes
 * (`stat_time_day` es el día del ANUNCIANTE, no el de Colombia). Meta ya deja su
 * moneda en `config_api.meta_estado_cuentas`; TikTok no dejaba nada, así que
 * cualquier conversión o ajuste de zona tenía que adivinar.
 *
 * `/advertiser/info/` lo da en una llamada barata con el mismo token que ya lee
 * los informes, sin permisos extra. El resultado se deja en
 * `config_api.tiktok_cuentas_info` con el mismo merge atómico que usa el
 * vigilante de cuentas de Meta (`fusionar_config_api`, migración 066), y se
 * relee como mucho una vez al día: la moneda y la zona de una cuenta no cambian
 * (TikTok no deja cambiarlas una vez creada), así que preguntar más es gasto.
 *
 * Nunca lanza: no saber la moneda NO puede tumbar la sincronización del gasto.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { tiktokFetch } from '@/lib/rate-limit';

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

/** Cada cuánto se vuelve a preguntar a TikTok por una cuenta ya conocida. */
export const INFO_CUENTA_TTL_MS = 24 * 60 * 60 * 1000;

export type InfoCuentaTikTok = {
  advertiser_id: string;
  nombre: string | null;
  /** ISO 4217 («USD», «COP», «CLP»…). */
  currency: string | null;
  /** Zona IANA con la que TikTok corta `stat_time_day` («America/Bogota»). */
  timezone: string | null;
  /** Zona que muestra el Ads Manager; puede diferir de `timezone` en cuentas antiguas. */
  display_timezone: string | null;
  /** Momento de la consulta (ISO). */
  ts: string;
};

/** Lo que se persiste por cuenta en `config_api.tiktok_cuentas_info`. */
export type InfoCuentaPersistida = Omit<InfoCuentaTikTok, 'advertiser_id'>;

/** Interpreta un elemento de `data.list` de `/advertiser/info/`. Puro. */
export function interpretarInfoCuenta(raw: any, ts = new Date().toISOString()): InfoCuentaTikTok {
  const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    advertiser_id: String(raw?.advertiser_id ?? '').trim(),
    nombre: txt(raw?.name),
    currency: txt(raw?.currency)?.toUpperCase() ?? null,
    timezone: txt(raw?.timezone),
    display_timezone: txt(raw?.display_timezone),
    ts,
  };
}

// Caché en memoria por proceso: el worker llama una vez por rango y por cliente,
// y el mismo anunciante puede estar en dos clientes (Somos rentable / Sur
// Profundo comparten cuenta a propósito).
const cache = new Map<string, InfoCuentaTikTok>();

/** Solo para las comprobaciones. */
export function _olvidarInfoCuentas(): void {
  cache.clear();
}

/**
 * Moneda y zona horaria de UNA cuenta. `null` si TikTok no responde o el token
 * no ve la cuenta: no saber la moneda no es lo mismo que saber que es otra.
 */
export async function tiktokInfoCuenta(
  advertiserId: string,
  token: string,
  opts?: { fetchImpl?: (url: string, init?: RequestInit) => Promise<{ json(): Promise<any> }> }
): Promise<InfoCuentaTikTok | null> {
  const id = String(advertiserId ?? '').trim();
  if (!id || !token) return null;
  const previa = cache.get(id);
  if (previa && Date.now() - Date.parse(previa.ts) < INFO_CUENTA_TTL_MS) return previa;

  const url = new URL(`${TIKTOK_API}/advertiser/info/`);
  url.searchParams.set('advertiser_ids', JSON.stringify([id]));
  url.searchParams.set(
    'fields',
    JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone', 'display_timezone'])
  );
  try {
    const f = opts?.fetchImpl ?? tiktokFetch;
    const res = await f(url.toString(), { headers: { 'Access-Token': token } });
    const json = await res.json();
    // TikTok responde 200 con `code !== 0` en los errores.
    if (json?.code !== 0) return null;
    const fila = (json?.data?.list ?? []).find((r: any) => String(r?.advertiser_id ?? '') === id);
    if (!fila) return null;
    const info = interpretarInfoCuenta(fila);
    cache.set(id, info);
    return info;
  } catch {
    return null;
  }
}

/** Cuentas de TikTok de un cliente (multi-cuenta o legacy), sin duplicados. */
export function cuentasTikTokDe(
  config: Record<string, any> | null | undefined
): Array<{ advertiser_id: string; token: string; raw: Record<string, any> }> {
  const cfg = config ?? {};
  let cuentas: Array<{ advertiser_id: string; token: string; raw: Record<string, any> }> = [];
  if (Array.isArray(cfg.tiktok_accounts) && cfg.tiktok_accounts.length > 0) {
    cuentas = cfg.tiktok_accounts
      .filter((a: any) => a?.advertiser_id)
      .map((a: any) => ({
        advertiser_id: String(a.advertiser_id).trim(),
        token: String(a.access_token || cfg.tiktok_access_token || ''),
        raw: a,
      }));
  } else if (cfg.tiktok_access_token && cfg.tiktok_advertiser_id) {
    cuentas = [
      {
        advertiser_id: String(cfg.tiktok_advertiser_id).trim(),
        token: String(cfg.tiktok_access_token),
        raw: {},
      },
    ];
  }
  const vistas = new Set<string>();
  return cuentas.filter((c) => {
    if (!c.token || vistas.has(c.advertiser_id)) return false;
    vistas.add(c.advertiser_id);
    return true;
  });
}

/**
 * ¿El cliente tiene TikTok conectado? Una cuenta con token, multi-cuenta o legacy.
 *
 * Único criterio para el dashboard interno y el espejo público: antes el interno
 * pedía `tiktok_advertiser_id` + token (y no veía a los clientes multi-cuenta)
 * y el espejo solo el token (y veía a uno con el token a medio configurar). La
 * misma pestaña resolvía los alias de TikTok distinto según dónde se abriera.
 */
export function tiktokConectado(config: Record<string, any> | null | undefined): boolean {
  return cuentasTikTokDe(config).length > 0;
}

/**
 * Refresca `config_api.tiktok_cuentas_info` de un cliente. Solo pregunta por las
 * cuentas sin dato o con dato de más de 24 h. Devuelve el mapa resultante (lo
 * persistido + lo nuevo) para quien quiera usarlo en la misma corrida.
 */
export async function actualizarInfoCuentasTikTok(
  db: any,
  cliente: { id: string; config_api?: Record<string, any> | null }
): Promise<Record<string, InfoCuentaPersistida>> {
  const previo = (cliente.config_api?.tiktok_cuentas_info ?? {}) as Record<
    string,
    InfoCuentaPersistida
  >;
  const pendientes = cuentasTikTokDe(cliente.config_api).filter((c) => {
    const ts = previo[c.advertiser_id]?.ts;
    return !ts || Date.now() - Date.parse(String(ts)) >= INFO_CUENTA_TTL_MS;
  });
  if (pendientes.length === 0) return previo;

  const infos = (
    await Promise.all(pendientes.map((c) => tiktokInfoCuenta(c.advertiser_id, c.token)))
  ).filter((i): i is InfoCuentaTikTok => i !== null);
  if (infos.length === 0) return previo;

  const parche: Record<string, InfoCuentaPersistida> = {};
  for (const { advertiser_id, ...resto } of infos) parche[advertiser_id] = resto;
  const fusionado = { ...previo, ...parche };
  try {
    // Merge atómico: no pisa lo que otro escritor haya guardado en `config_api`
    // entre medias (mismo camino que `meta_estado_cuentas`).
    await db.rpc('fusionar_config_api', {
      p_cliente_id: cliente.id,
      p_parche: { tiktok_cuentas_info: fusionado },
    });
  } catch {
    /* no fatal: la próxima corrida lo reintenta */
  }
  return fusionado;
}
