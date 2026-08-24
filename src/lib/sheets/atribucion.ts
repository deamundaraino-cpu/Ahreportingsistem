/**
 * Atribución publicitaria de una fila de Sheet — motor puro.
 *
 * ── Qué problema resuelve ────────────────────────────────────────────────
 * La exportación de Meta Lead Ads que los clientes vuelcan a un Sheet trae, en
 * cada fila, la identidad EXACTA del anuncio que la generó:
 *
 *   campaign_id  "c:120235587549050178"     campaign_name  "[ÑUÑOA][CAPTACIÓN]…"
 *   adset_id     "as:120247665005500178"    adset_name     "[MATTA][ADVANTAGE]…"
 *   ad_id        "ag:120247737093830178"    ad_name        "[AD 10 JUL][Ñuñoa]…"
 *
 * Esos ids son la mejor clave de cruce que existe en la plataforma: son los
 * mismos que emite la API de Meta, así que no dependen de cómo esté escrito el
 * nombre. Hasta ahora se perdían al resumir las filas en el desglose diario
 * (`sheet_campo_valores_diarios`), que solo conserva `campo_id × fecha × valor`.
 *
 * ── Por qué esto es un adaptador y no un resolver nuevo ──────────────────
 * `campaign-resolver` ya sabe cruzar por id con la cascada correcta (override →
 * utm_id contra campaign_id → utm_id contra ad_id → nombres). Lo único que le
 * falta a una fila de Sheet para entrar por esa puerta es tener forma de
 * `UtmRecord`. Eso es todo lo que hace este módulo: traducir, no re-implementar.
 *
 * `utm_id` se rellena con el id MÁS ESPECÍFICO disponible (anuncio → conjunto →
 * campaña) a propósito: el índice mapea `ad_id` a las tres cosas
 * (`byAdId` → campaña, `adByAdId` → anuncio, `adsetByAdId` → conjunto), así que
 * con el id de anuncio se resuelven los tres niveles de una sola vez. Con el de
 * campaña solo se resolvería el primero.
 *
 * Puro y client-safe: sin Supabase, sin red. Lo importan el motor del BI y los
 * scripts de verificación.
 */

/**
 * Alias conocidos de cada parte de la identidad publicitaria.
 *
 * Salen de las columnas REALES que hay hoy en `sheet_filas.valores` (la
 * exportación de Meta Lead Ads y las variantes en español que escriben los
 * clientes a mano), no de una lista teórica. El orden importa: gana el primero
 * que aparezca con valor.
 *
 * Las claves ya vienen sanitizadas por `sanitizarColumna` (minúsculas, sin
 * acentos, `_` como separador), así que aquí se comparan tal cual.
 */
export const ALIAS_ATRIBUCION = {
  campaign_id: ['campaign_id', 'id_de_campana', 'id_campana', 'campana_id'],
  adset_id: ['adset_id', 'ad_set_id', 'id_conjunto', 'conjunto_id'],
  ad_id: ['ad_id', 'anuncio_id', 'id_anuncio'],
  campaign_name: ['campaign_name', 'campana', 'campania', 'nombre_de_campana', 'nombre_campana'],
  adset_name: ['adset_name', 'ad_set_name', 'conjunto', 'nombre_conjunto', 'nombre_del_conjunto'],
  ad_name: ['ad_name', 'anuncio', 'nombre_anuncio', 'nombre_del_anuncio'],
  platform: ['platform', 'plataforma', 'publisher_platform'],
  email: ['email', 'correo', 'correo_electronico', 'e_mail', 'mail'],
  phone: ['phone', 'phone_number', 'telefono', 'celular', 'whatsapp'],
} as const;

export type ParteAtribucion = keyof typeof ALIAS_ATRIBUCION;

/**
 * Prefijos de tipo con los que Meta exporta sus ids en el Sheet.
 *
 * Es un conjunto CERRADO a propósito. La alternativa —recortar cualquier cosa
 * que parezca `xx:`— destroza valores de texto legítimos: `"nota:revisar"` se
 * convertiría en `"revisar"` y `"10:30"` en `"30"`, contaminando el cruce con
 * basura que nadie relaciona con esta función.
 *
 * Si algún día Meta añade un prefijo nuevo, el id se queda sin recortar y esa
 * fila cruza por nombre en vez de por id. Se degrada, que es lo correcto: es
 * infinitamente preferible a estropear una columna de texto.
 */
const PREFIJOS_META = new Set(['c', 'as', 'ag', 'ad', 'f', 'l', 'p']);

/**
 * Quita el prefijo de tipo con el que Meta exporta sus ids (`c:`, `as:`, `ag:`,
 * `f:`, `l:`, `p:`).
 *
 * Es lo que separa `"c:120235587549050178"` de `"120235587549050178"`, que es la
 * forma en que el id vive en `ads_daily.entidad_id` y en `utm_id`. Sin esto el
 * cruce falla al 100 % y en silencio.
 */
export function limpiarIdSheet(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // `\S+` (sin espacios) descarta las frases: un id nunca lleva espacios.
  const m = /^([a-z]{1,3}):(\S+)$/i.exec(s);
  if (!m) return s;
  return PREFIJOS_META.has(m[1].toLowerCase()) ? m[2] : s;
}

/** Primer valor no vacío entre los alias de una parte. */
export function valorAtribucion(
  valores: Record<string, unknown> | null | undefined,
  parte: ParteAtribucion
): string {
  if (!valores) return '';
  for (const alias of ALIAS_ATRIBUCION[parte]) {
    const v = valores[alias];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** La identidad publicitaria de una fila, ya con los ids limpios. */
export interface AtribucionFila {
  campaign_id: string;
  adset_id: string;
  ad_id: string;
  campaign_name: string;
  adset_name: string;
  ad_name: string;
  platform: string;
}

export function atribucionDeFila(
  valores: Record<string, unknown> | null | undefined
): AtribucionFila {
  return {
    campaign_id: limpiarIdSheet(valorAtribucion(valores, 'campaign_id')),
    adset_id: limpiarIdSheet(valorAtribucion(valores, 'adset_id')),
    ad_id: limpiarIdSheet(valorAtribucion(valores, 'ad_id')),
    campaign_name: valorAtribucion(valores, 'campaign_name'),
    adset_name: valorAtribucion(valores, 'adset_name'),
    ad_name: valorAtribucion(valores, 'ad_name'),
    platform: valorAtribucion(valores, 'platform'),
  };
}

/**
 * ¿La fila trae algo con lo que atribuir? Si no, no tiene sentido pedir el
 * resolver ni contarla como cruzable: irá a `(sin campaña)` como cualquier
 * lead huérfano.
 */
export function filaEsAtribuible(valores: Record<string, unknown> | null | undefined): boolean {
  const a = atribucionDeFila(valores);
  return Boolean(a.ad_id || a.adset_id || a.campaign_id || a.campaign_name || a.ad_name);
}

/**
 * Forma `UtmRecord` de una fila de Sheet, lista para `campaign-resolver`.
 *
 * `utm_id` toma el id más específico disponible (ver cabecera del módulo).
 * Los nombres van a la ranura que la cascada consulta para cada nivel:
 * `utm_campaign` → nombre de campaña, `utm_content` → nombre de anuncio,
 * `utm_term` → nombre de conjunto. Es exactamente el mismo contrato que cumple
 * un lead, así que el cruce se comporta igual para las dos fuentes.
 */
export function utmDeFilaSheet(valores: Record<string, unknown> | null | undefined): {
  utm_id: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_source: string | null;
} {
  const a = atribucionDeFila(valores);
  return {
    utm_id: a.ad_id || a.adset_id || a.campaign_id || null,
    utm_campaign: a.campaign_name || null,
    utm_content: a.ad_name || null,
    utm_term: a.adset_name || null,
    utm_source: a.platform || null,
  };
}

/** Correo normalizado de la fila, para cruzar un CRM contra los leads. */
export function correoDeFila(valores: Record<string, unknown> | null | undefined): string {
  return valorAtribucion(valores, 'email').toLowerCase().trim();
}
