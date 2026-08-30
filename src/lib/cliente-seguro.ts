import 'server-only';

/**
 * Saneado de `clientes.config_api` antes de cruzar al navegador.
 *
 * `config_api` mezcla dos cosas muy distintas: preferencias de visualización que
 * la UI necesita (qué palabras clave de Meta mostrar, qué cuentas de TikTok, qué
 * columnas de un Sheet existen) y CREDENCIALES en claro — `ga_private_key`,
 * `meta_access_token`, `tiktok_access_token`, y el `private_key` del service
 * account de Google dentro de cada `google_sheets_conversiones`.
 *
 * El dashboard se renderiza con `<DashboardClient>`, que es un componente de
 * cliente, así que TODO lo que se le pase se serializa en el payload RSC. En
 * `/p/[token]` esa página es pública y sin sesión: pasarle la fila entera del
 * cliente publicaba las credenciales en el HTML de cada enlace compartido.
 *
 * La lista es una allowlist a propósito. Una denylist ("quita private_key")
 * deja pasar cualquier credencial nueva que alguien añada mañana a config_api;
 * una allowlist falla en el sentido seguro: lo que no está declarado, no viaja.
 */

/** Claves de `config_api` que la UI del dashboard necesita y puede ver. */
const CLAVES_UI = ['meta_keywords', 'tiktok_accounts', 'google_sheets_conversiones'] as const;

/**
 * Campos de una config de Google Sheets que la UI usa para ofrecer columnas y
 * filtros. `client_email` y `private_key` quedan fuera por definición.
 */
const CLAVES_SHEET = [
  'id',
  'name',
  'enabled',
  'sheet_id',
  'sheet_name',
  'tabs',
  'custom_columns',
  'tab_name',
  'col_fecha',
  'col_tipo',
  'col_cantidad',
  'col_valor',
  'col_fuente',
  'col_campana',
  'col_notas',
] as const;

type Dict = Record<string, unknown>;

function esObjeto(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function elegir(origen: Dict, claves: readonly string[]): Dict {
  const salida: Dict = {};
  for (const k of claves) {
    if (origen[k] !== undefined) salida[k] = origen[k];
  }
  return salida;
}

/**
 * Limpia una config de Sheets (y sus pestañas anidadas, que repiten el mismo
 * shape y por tanto podrían repetir credenciales).
 */
function sanearSheet(cfg: unknown): Dict | null {
  if (!esObjeto(cfg)) return null;
  const limpio = elegir(cfg, CLAVES_SHEET);
  if (Array.isArray(limpio.tabs)) {
    limpio.tabs = limpio.tabs.map((t) => (esObjeto(t) ? elegir(t, CLAVES_SHEET) : t));
  }
  return limpio;
}

/**
 * Devuelve la parte de `config_api` que puede viajar al navegador.
 * Acepta el formato legacy (objeto suelto) y el actual (array) de
 * `google_sheets_conversiones`, igual que `normalizeSheetConfigs`.
 */
export function sanearConfigApi(configApi: unknown): Dict {
  if (!esObjeto(configApi)) return {};
  const salida = elegir(configApi, CLAVES_UI);

  const sheets = salida.google_sheets_conversiones;
  if (Array.isArray(sheets)) {
    salida.google_sheets_conversiones = sheets.map(sanearSheet).filter(Boolean);
  } else if (esObjeto(sheets)) {
    salida.google_sheets_conversiones = sanearSheet(sheets);
  }

  return salida;
}

/**
 * Sanea la fila de cliente que se entrega a un componente de cliente.
 * Preserva el resto de columnas: los secretos de `clientes` viven todos dentro
 * de `config_api`.
 */
export function sanearClienteParaUI<T extends { config_api?: unknown } | null | undefined>(
  cliente: T
): T {
  if (!cliente) return cliente;
  return { ...cliente, config_api: sanearConfigApi((cliente as Dict).config_api) };
}

/** Estado de conexión de cada integración, sin revelar la credencial. */
export type ConexionesCliente = {
  meta: boolean;
  hotmart: boolean;
  tiktok: boolean;
  ga: boolean;
};

/**
 * Traduce la presencia de credenciales a booleanos.
 *
 * La UI solo pregunta "¿está conectado?", así que no hay ninguna razón para
 * mandarle el token y dejar que lo compruebe ella. Esto permite sanear
 * `config_api` en listados que ven roles no administradores.
 */
export function flagsConexion(configApi: unknown): ConexionesCliente {
  const c = esObjeto(configApi) ? configApi : {};
  const tiene = (k: string) => Boolean(c[k]);
  return {
    meta: tiene('meta_token'),
    hotmart: tiene('hotmart_token') || tiene('hotmart_basic'),
    tiktok: tiene('tiktok_access_token') && tiene('tiktok_advertiser_id'),
    ga: tiene('ga_property_id'),
  };
}

/**
 * Fila de cliente para listados: `config_api` saneado más los flags de conexión.
 * `getClientes()` alimenta /dashboard y /soporte, que ve cualquier rol.
 */
export function sanearClienteParaListado<T extends { config_api?: unknown }>(
  cliente: T
): T & { conexiones: ConexionesCliente } {
  const raw = (cliente as Dict).config_api;
  return {
    ...cliente,
    config_api: sanearConfigApi(raw),
    conexiones: flagsConexion(raw),
  };
}
