/**
 * Reparto de `public.clientes.config_api` entre las pestañas de la ficha del
 * cliente.
 *
 * La ficha era una sola columna con seis bloques y un botón «Guardar Todo» al
 * final que reescribía el JSONB ENTERO con el snapshot leído al abrir la
 * página. Eso no solo era incómodo: se llevaba por delante lo que el servidor
 * hubiera escrito mientras tanto —los tokens cifrados de Hotmart que renueva el
 * cron, `meta_estado_cuentas` que escribe el vigilante de cuentas—. Al guardar
 * por pestaña se manda un PARCHE con las claves de esa pestaña y nada más, y
 * `public.fusionar_config_api` lo funde en la base con `||`. El resto del
 * objeto ni se lee ni se toca.
 *
 * Módulo puro a propósito: lo importan el navegador, la acción de servidor y el
 * script de verificación. Sin React, sin Supabase, sin `server-only`.
 */

export const PESTANAS = ['general', 'meta', 'google', 'hotmart', 'tiktok', 'crm'] as const;
export type Pestana = (typeof PESTANAS)[number];

export const ETIQUETA_PESTANA: Record<Pestana, string> = {
  general: 'General',
  meta: 'Meta',
  google: 'Google',
  hotmart: 'Hotmart',
  tiktok: 'TikTok',
  crm: 'CRM y Web',
};

/**
 * Qué claves de `config_api` escribe cada pestaña.
 *
 * Una clave no puede estar en dos sitios: si lo estuviera, guardar una pestaña
 * pisaría lo que el usuario tiene a medias en la otra. `verify-config-pestanas`
 * lo comprueba.
 */
export const CLAVES_POR_PESTANA: Record<Pestana, readonly string[]> = {
  // Layout, perfil de IA, moneda, metas, branding y reglas de lead no viven en
  // `config_api`: cada uno guarda por su cuenta contra su propia tabla.
  general: [],

  meta: [
    'meta_token',
    'meta_token_expires_at',
    'meta_connection_status',
    'meta_accounts',
    'meta_account_id',
    // Filtra qué campañas de Meta entran en el dashboard.
    'meta_keywords',
  ],

  google: [
    'ga_property_id',
    'ga_property_name',
    'ga_account_name',
    'ga_client_email',
    'ga_private_key',
    'ga_project_id',
    'google_sheets_conversiones',
  ],

  hotmart: [
    'hotmart_auth_mode',
    'hotmart_connection_status',
    'hotmart_last_checked_at',
    'hotmart_client_id',
    'hotmart_client_secret',
    'hotmart_token',
    'hotmart_basic',
  ],

  tiktok: ['tiktok_access_token', 'tiktok_accounts'],

  // Meta Lead Ads, CAPI, GoHighLevel, Hotmart webhook, Google Ads, S2S y los
  // webhooks salientes viven en `report_utm.integrations`. Cada tarjeta guarda
  // con su propia acción, así que aquí no hay nada de `config_api` que mandar.
  crm: [],
};

/**
 * Claves que escribe SOLO el servidor y que ningún parche puede tocar.
 *
 * Son justo las que el «Guardar Todo» pisaba: tokens que renueva el cron de
 * Hotmart, el estado de las cuentas de Meta y el `advertiser_id` legacy de
 * TikTok, que hoy solo se lee para migrar la config vieja a `tiktok_accounts`.
 */
export const CLAVES_SOLO_SERVIDOR: readonly string[] = [
  'hotmart_access_token',
  'hotmart_access_token_enc',
  'hotmart_refresh_token',
  'hotmart_refresh_token_enc',
  'hotmart_basic_enc',
  'hotmart_token_expires_at',
  'meta_estado_cuentas',
  'tiktok_advertiser_id',
];

const TODAS_LAS_CLAVES = new Set(Object.values(CLAVES_POR_PESTANA).flat());

/** ¿Esta clave la gestiona alguna pestaña del formulario? */
export function esClaveDePestana(clave: string): boolean {
  return TODAS_LAS_CLAVES.has(clave);
}

/** Base64 sin depender del entorno: `btoa` en el navegador, `Buffer` en Node. */
function aBase64(texto: string): string {
  return typeof btoa === 'function' ? btoa(texto) : Buffer.from(texto, 'utf8').toString('base64');
}

type Config = Record<string, unknown>;
type ConCuenta = { account_id?: string };

/**
 * La config tal y como se guardaría: mezcla el estado del formulario con lo que
 * se deriva de él.
 *
 * `metaAccounts`, `tiktokAccounts` y el `hotmart_basic` calculado viven fuera
 * del objeto `config` mientras se edita. Esta función es la MISMA que usan el
 * guardado y el cálculo de «cambios sin guardar»: si el dirty se calculara
 * sobre el objeto crudo, la pestaña de Hotmart nacería sucia en todo cliente
 * que tenga client_id y secret pero no `hotmart_basic`.
 */
export function construirConfigEfectiva(
  config: Config,
  metaAccounts: ConCuenta[],
  tiktokAccounts: unknown[]
): Config {
  const clientId = config.hotmart_client_id as string | undefined;
  const secret = config.hotmart_client_secret as string | undefined;
  const basicCalculado =
    !config.hotmart_basic && clientId && secret
      ? aBase64(`${clientId}:${secret}`)
      : (config.hotmart_basic as string | undefined);

  return {
    ...config,
    meta_accounts: metaAccounts,
    meta_account_id: metaAccounts[0]?.account_id || config.meta_account_id || '',
    tiktok_accounts: tiktokAccounts,
    hotmart_basic: basicCalculado || config.hotmart_basic || '',
  };
}

/** El parche a mandar al guardar una pestaña: sus claves y ninguna más. */
export function construirParche(efectiva: Config, pestana: Pestana): Config {
  const parche: Config = {};
  for (const clave of CLAVES_POR_PESTANA[pestana]) {
    if (efectiva[clave] !== undefined) parche[clave] = efectiva[clave];
  }
  return parche;
}

/**
 * Huella estable para comparar «lo que hay» con «lo guardado».
 *
 * `JSON.stringify` normal depende del orden de inserción, y el objeto que
 * devuelve Postgres no trae las claves en el mismo orden que el que construye
 * el formulario: sin ordenar, media ficha aparecería sucia nada más abrirla.
 */
export function huella(valor: unknown): string {
  return JSON.stringify(valor, (_clave, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

/** Huella de cada pestaña, para fijar la línea base de «sin cambios». */
export function huellasPorPestana(efectiva: Config): Record<Pestana, string> {
  return Object.fromEntries(
    PESTANAS.map((p) => [p, huella(construirParche(efectiva, p))])
  ) as Record<Pestana, string>;
}
