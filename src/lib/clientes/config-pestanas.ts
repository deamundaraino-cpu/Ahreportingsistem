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
  'hotmart_client_secret_enc',
  'hotmart_token_enc',
  'hotmart_token_expires_at',
  'meta_estado_cuentas',
  'tiktok_advertiser_id',
];

type Config = Record<string, unknown>;

// ── Secretos de Hotmart ─────────────────────────────────────────
//
// `hotmart_client_secret`, `hotmart_basic` y `hotmart_token` se guardaban EN
// CLARO en `config_api` y viajaban enteros al navegador al abrir la ficha. Ahora
// la base guarda la versión cifrada (`*_enc`) y el navegador solo recibe este
// marcador: sabe que hay algo guardado, no qué. `hotmart_client_id` no es
// secreto y sigue en claro.

/** Lo que ve el formulario en lugar de un secreto ya guardado. */
export const SECRETO_GUARDADO = '__guardado__';

/** Cada secreto de Hotmart que escribe el formulario, con su clave cifrada. */
export const SECRETOS_HOTMART = {
  hotmart_client_secret: 'hotmart_client_secret_enc',
  hotmart_basic: 'hotmart_basic_enc',
  hotmart_token: 'hotmart_token_enc',
} as const;

type SecretoHotmart = keyof typeof SECRETOS_HOTMART;

const PARES_SECRETOS = Object.entries(SECRETOS_HOTMART) as Array<[SecretoHotmart, string]>;

/** Tokens de HotConnect: el formulario no los usa para nada. */
const TOKENS_HOTCONNECT = [
  'hotmart_access_token',
  'hotmart_access_token_enc',
  'hotmart_refresh_token',
  'hotmart_refresh_token_enc',
];

/** ¿El usuario escribió un valor nuevo (ni vacío ni el marcador)? */
function esValorNuevo(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v !== SECRETO_GUARDADO;
}

/**
 * ¿El `hotmart_basic` guardado queda viejo con lo que trae el formulario?
 *
 * El Basic es `base64(client_id:secret)` y `basicDeConfig` lo prefiere a la
 * pareja. Si llega un secreto nuevo sin un Basic nuevo, el guardado se calculó
 * con el secreto anterior: conservarlo haría que el worker siguiera
 * autenticando con la credencial vieja.
 */
function basicObsoleto(formulario: Config): boolean {
  return (
    esValorNuevo(formulario.hotmart_client_id) &&
    esValorNuevo(formulario.hotmart_client_secret) &&
    !esValorNuevo(formulario.hotmart_basic)
  );
}

/**
 * Cambia cada secreto de Hotmart guardado por `SECRETO_GUARDADO` antes de
 * mandar la config al navegador.
 *
 * Las claves cifradas y los tokens de HotConnect se quitan: el formulario no
 * los edita, y un token en claro sin migrar no tiene por qué salir del servidor.
 */
export function enmascararSecretosHotmart(config: Config): Config {
  const salida: Config = { ...config };
  for (const [plana, cifrada] of PARES_SECRETOS) {
    if (salida[plana] || salida[cifrada]) salida[plana] = SECRETO_GUARDADO;
    delete salida[cifrada];
  }
  for (const clave of TOKENS_HOTCONNECT) delete salida[clave];
  return salida;
}

/**
 * El parche de la pestaña de Hotmart tal y como debe llegar a la base.
 *
 *  - Un secreto nuevo se cifra en su clave `*_enc` y la copia en claro se
 *    borra (`null`): dejarla convertiría el cifrado en decorativo.
 *  - `SECRETO_GUARDADO` significa «no lo toques»: la clave sale del parche y
 *    `fusionar_config_api` conserva lo que haya.
 *  - `''` se guarda como `null`. Antes se escribía `hotmart_basic: ''` tal
 *    cual, y cinco clientes acabaron con esa cadena vacía en la base. Un
 *    secreto vaciado a propósito borra también su versión cifrada.
 *
 * Pura: el cifrado llega como argumento para que este módulo siga sin
 * depender de `crypto` (lo importa también el navegador).
 */
export function prepararParcheHotmart(parche: Config, cifrar: (valor: string) => string): Config {
  const salida: Config = {};
  for (const [clave, valor] of Object.entries(parche)) {
    salida[clave] = typeof valor === 'string' && valor.trim() === '' ? null : valor;
  }

  if (basicObsoleto(parche)) salida.hotmart_basic = null;

  for (const [plana, cifrada] of PARES_SECRETOS) {
    if (!(plana in salida)) continue;
    const valor = salida[plana];
    if (valor === SECRETO_GUARDADO) {
      delete salida[plana];
      continue;
    }
    salida[cifrada] = esValorNuevo(valor) ? cifrar(valor) : null;
    salida[plana] = null;
  }
  return salida;
}

/** Las claves del formulario que cuentan como credencial al probar la conexión. */
const CREDENCIALES_FORMULARIO = ['hotmart_client_id', ...Object.keys(SECRETOS_HOTMART)];

/**
 * La config con la que se prueba la conexión: la guardada, con lo que el
 * usuario haya tecleado encima.
 *
 * El formulario ya no tiene los secretos (llega `SECRETO_GUARDADO`), así que
 * probar «lo que hay en pantalla» exige partir de la base. Lo que el usuario
 * cambió manda; lo enmascarado se queda como está. Un valor del formulario
 * anula también la versión cifrada guardada, o `leerSecreto` la preferiría.
 *
 * El modo de conexión no se toma del formulario: solo lo cambia el callback de
 * OAuth, que escribe directamente en la base.
 */
export function superponerFormularioHotmart(guardada: Config, formulario: Config): Config {
  const salida: Config = { ...guardada };
  for (const clave of CREDENCIALES_FORMULARIO) {
    if (!(clave in formulario)) continue;
    const valor = formulario[clave];
    if (valor === SECRETO_GUARDADO) continue;
    salida[clave] = typeof valor === 'string' && valor.trim() !== '' ? valor : null;
    const cifrada = SECRETOS_HOTMART[clave as SecretoHotmart];
    if (cifrada) salida[cifrada] = null;
  }
  if (basicObsoleto(formulario)) {
    salida.hotmart_basic = null;
    salida.hotmart_basic_enc = null;
  }
  return salida;
}

const TODAS_LAS_CLAVES = new Set(Object.values(CLAVES_POR_PESTANA).flat());

/** ¿Esta clave la gestiona alguna pestaña del formulario? */
export function esClaveDePestana(clave: string): boolean {
  return TODAS_LAS_CLAVES.has(clave);
}

/** Base64 sin depender del entorno: `btoa` en el navegador, `Buffer` en Node. */
function aBase64(texto: string): string {
  return typeof btoa === 'function' ? btoa(texto) : Buffer.from(texto, 'utf8').toString('base64');
}

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
 *
 * El Basic solo se calcula con un secreto TECLEADO: con `SECRETO_GUARDADO` no
 * hay de dónde sacarlo, y se deja lo guardado. Un secreto nuevo sí recalcula el
 * Basic enmascarado, que se hizo con el secreto anterior.
 */
export function construirConfigEfectiva(
  config: Config,
  metaAccounts: ConCuenta[],
  tiktokAccounts: unknown[]
): Config {
  const clientId = config.hotmart_client_id as string | undefined;
  const secret = config.hotmart_client_secret;
  const basic = config.hotmart_basic as string | null | undefined;
  const basicCalculado =
    clientId && esValorNuevo(secret) && (!basic || basic === SECRETO_GUARDADO)
      ? aBase64(`${clientId}:${secret}`)
      : basic;

  return {
    ...config,
    meta_accounts: metaAccounts,
    meta_account_id: metaAccounts[0]?.account_id || config.meta_account_id || '',
    tiktok_accounts: tiktokAccounts,
    // Sin nada que calcular la clave se queda como venía. Antes se forzaba
    // `''`, y esa cadena vacía acababa guardada como si fuera una credencial.
    ...(basicCalculado !== undefined ? { hotmart_basic: basicCalculado } : {}),
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
