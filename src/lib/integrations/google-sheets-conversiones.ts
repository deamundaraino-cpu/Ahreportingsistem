import { randomUUID } from 'crypto';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import type { GoogleSpreadsheetWorksheet } from 'google-spreadsheet';
import { JWT, OAuth2Client } from 'google-auth-library';
import { hasAgencyGoogleConnection, getAgencyAccessToken } from './google-auth';
import { sanitizarColumna, parseNumeroSheet } from '../sheets/campos';
import type { SheetRawRow } from '../sheets/campos';
import { fetchAllRows } from '../supabase-paginate';

// La capa cruda del sync es la entrada del motor de campos: el tipo vive allí,
// que es client-safe, y se reexporta para no romper a quien ya lo importa desde
// esta librería.
export type { SheetRawRow };

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type CustomColumnType = 'count' | 'currency' | 'percentage' | 'date' | 'text';

/** Qué columnas de una pestaña se guardan en crudo en `sheet_filas`. */
export type SheetRawMode = 'all' | 'declared' | 'none';

export interface CustomColumnDef {
  col_name: string; // nombre exacto en el Sheet (ej: "Citas Agendadas")
  type: CustomColumnType;
  label: string; // nombre para el dashboard
  include: boolean; // si false, se ignora en el sync
  sample_values?: string[]; // solo durante detección, no se persiste
}

/**
 * Config de UNA pestaña dentro de un spreadsheet. Cada pestaña tiene su propio
 * mapeo de columnas: dos pestañas del mismo doc pueden llamar distinto a la
 * columna de fecha o exponer columnas adicionales diferentes.
 */
export interface SheetTabConfig {
  /** UUID para identificar la pestaña en la UI (no es el ID de Google). */
  id: string;
  /** Título exacto de la pestaña. Vacío = primera pestaña del doc. */
  sheet_name: string;
  enabled: boolean;
  col_fecha?: string;
  col_tipo?: string;
  col_cantidad?: string;
  col_valor?: string;
  col_fuente?: string;
  col_notas?: string;
  /**
   * Cada fila vale UNA conversión. Para hojas donde una fila = un lead/venta
   * (exports de formularios de Meta, listados de WhatsApp…), que no tienen
   * columna de cantidad: sin esto todas sus filas se descartaban por cantidad 0.
   */
  count_rows?: boolean;
  /**
   * Valor fijo de `tipo` cuando la pestaña no tiene columna de tipo. Sin él, las
   * filas entran como 'otro' y no suman en `offline_leads` / `offline_ventas`.
   */
  tipo_fijo?: string;
  /** Columnas adicionales de ESTA pestaña definidas por el analista. */
  custom_columns?: Record<string, CustomColumnDef>;
  /**
   * Qué se guarda en `sheet_filas` (la capa cruda sobre la que se definen los
   * campos de Sheet):
   *   'all'      → todas las columnas de la pestaña (por defecto)
   *   'declared' → solo las declaradas en `custom_columns` con include
   *   'none'     → nada; la pestaña solo alimenta conversiones_offline
   */
  raw_mode?: SheetRawMode;
  /**
   * Columnas sanitizadas que NUNCA se guardan en crudo. `detectSheetColumns`
   * las propone con una heurística de PII / alta cardinalidad (email, teléfono,
   * documento…) y el analista confirma.
   */
  raw_exclude?: string[];
}

export interface ConversionesConfig {
  /** UUID que identifica esta config de sheet dentro del array del cliente. */
  id?: string;
  /** Nombre visible en la UI (ej: "Leads WhatsApp"). */
  name?: string;
  enabled: boolean;
  sheet_url: string;
  /**
   * Pestañas a sincronizar de este documento. Formato actual: la UI escribe
   * siempre `tabs`. Las configs anteriores (una sola pestaña con los campos
   * planos de abajo) se convierten al vuelo en `normalizeTabs`.
   */
  tabs?: SheetTabConfig[];
  // ── Campos legacy (una sola pestaña, mapeo a nivel de sheet) ──────────────
  sheet_name?: string;
  col_fecha?: string;
  col_tipo?: string;
  col_cantidad?: string;
  col_valor?: string;
  col_fuente?: string;
  col_notas?: string;
  custom_columns?: Record<string, CustomColumnDef>;
  client_email?: string;
  private_key?: string;
}

/** Un archivo de Google Drive tipo Spreadsheet. */
export interface DriveSheet {
  id: string;
  name: string;
  url: string;
  modifiedTime: string;
}

/** Una pestaña real del documento, tal como la reporta Google. */
export interface SheetTabInfo {
  title: string;
  index: number;
  rowCount: number;
}

/**
 * Normaliza el campo google_sheets_conversiones (que puede ser un objeto legacy
 * o un array) y devuelve siempre un array de ConversionesConfig con `tabs`
 * resueltas y un `id` estable (necesario para el replace por sheet).
 */
export function normalizeSheetConfigs(raw: unknown): ConversionesConfig[] {
  const list: ConversionesConfig[] = !raw
    ? []
    : Array.isArray(raw)
      ? (raw as ConversionesConfig[])
      : typeof raw === 'object'
        ? [{ id: 'legacy', name: 'Sheet Principal', ...(raw as ConversionesConfig) }]
        : [];

  // El id es la clave de partición en la base (sheet_id): una config sin id
  // guardada antes de esta versión recibe uno derivado de su posición.
  return list.map((cfg, i) => ({ ...cfg, id: cfg.id || `sheet_${i}`, tabs: normalizeTabs(cfg) }));
}

/**
 * Devuelve las pestañas de un sheet. Si la config es del formato plano anterior
 * (sin `tabs`), sintetiza una única pestaña con su mapeo — así el worker
 * sincroniza configs viejas sin necesidad de migrar el JSONB en producción.
 */
export function normalizeTabs(cfg: ConversionesConfig): SheetTabConfig[] {
  if (Array.isArray(cfg.tabs) && cfg.tabs.length > 0) {
    return cfg.tabs.map((t, i) => ({
      ...t,
      id: t.id || `tab_${i}`,
      sheet_name: t.sheet_name ?? '',
      enabled: t.enabled !== false,
    }));
  }
  return [
    {
      id: cfg.id ? `${cfg.id}_tab` : 'tab_0',
      sheet_name: cfg.sheet_name ?? '',
      enabled: true,
      col_fecha: cfg.col_fecha,
      col_tipo: cfg.col_tipo,
      col_cantidad: cfg.col_cantidad,
      col_valor: cfg.col_valor,
      col_fuente: cfg.col_fuente,
      col_notas: cfg.col_notas,
      custom_columns: cfg.custom_columns,
    },
  ];
}

/** Une las columnas adicionales de todas las pestañas de un sheet. */
export function mergeTabCustomColumns(tabs: SheetTabConfig[]): Record<string, CustomColumnDef> {
  const merged: Record<string, CustomColumnDef> = {};
  for (const tab of tabs) {
    if (tab.custom_columns) Object.assign(merged, tab.custom_columns);
  }
  return merged;
}

export interface ConversionRow {
  fecha: string;
  tipo: string;
  cantidad: number;
  valor: number | null;
  fuente: string;
  notas: string;
  custom_fields: Record<string, any>;
  /** Config de sheet de la que proviene la fila (para el replace por sheet). */
  sheet_id: string;
  /** Pestaña concreta de la que proviene la fila. */
  tab_name: string;
  /**
   * Número de fila dentro de la pestaña, 1-indexado como en `SheetRawRow`.
   *
   * Es la tercera pata de la clave natural (cliente, sheet, pestaña, fila) que
   * permite al sync escribir por UPSERT en vez de reinsertar el sheet entero.
   * Sin él, `conversiones_offline` no tiene forma de identificar una fila: su
   * contenido se repite —25.863 filas reales dan sólo 776 combinaciones
   * distintas de (fecha, tipo, fuente, cantidad, valor, notas)—.
   */
  fila_num: number;
}

export interface ConversionDiaria {
  fecha: string;
  tipo: string;
  fuente: string;
  total_cantidad: number;
  total_valor: number;
  custom_fields: Record<string, number>;
}

export interface DetectedColumn {
  col_name: string;
  sanitized_name: string;
  proposed_type: CustomColumnType;
  label: string;
  sample_values: string[];
  /**
   * La columna parece PII o de alta cardinalidad (un valor distinto por fila).
   * La UI la propone marcada para `raw_exclude`: guardarla en crudo abulta la
   * tabla sin servir como dimensión.
   */
  sensible: boolean;
}

/** Resultado de leer UNA pestaña: cuántas filas entraron y cuáles se descartaron. */
export interface TabSyncQuality {
  tab_name: string;
  rows_ok: number;
  /** Filas con algo escrito en la columna de fecha que no se pudo leer. */
  fecha_invalida: number;
  /**
   * Filas con contenido pero la celda de fecha vacía: plantillas con columnas
   * prellenadas o registros a medio escribir. Van aparte de `fecha_invalida`
   * porque no son un formato roto: mezcladas, 400 filas de plantilla tapaban
   * que un mes entero se estaba descartando por escribir "01/09/26".
   */
  fecha_vacia?: number;
  /** Hasta 3 valores de fecha rechazados, tal cual, para que el aviso sea accionable. */
  ejemplos_fecha_invalida?: string[];
  cantidad_invalida: number;
  /**
   * Filas que no entran como conversión (cantidad <= 0) pero sí se guardan en
   * crudo. Antes desaparecían del todo; ahora siguen disponibles para los
   * campos de Sheet, y el número lo hace visible en el log de sync.
   */
  solo_crudas?: number;
  /** Columnas guardadas en crudo para esta pestaña. */
  columnas_crudas?: number;
  /**
   * Parte de `cantidad_invalida`: filas con una cantidad que no es un entero
   * válido ("1,5", un teléfono). Van aparte porque el remedio es otro —revisar
   * el mapeo—, no activar "Cada fila es una conversión".
   */
  cantidad_rechazada?: number;
  ejemplos_cantidad_rechazada?: string[];
  /** Filas cuyo valor no cabe en NUMERIC(12,2): se guardaron sin valor. */
  valor_fuera_de_rango?: number;
  ejemplos_valor_fuera_de_rango?: string[];
  warnings: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractSheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

async function createAuthClient(
  clientEmail?: string,
  clientKey?: string
): Promise<JWT | OAuth2Client> {
  if (await hasAgencyGoogleConnection()) return await getAgencyAccessToken();
  const email = clientEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (clientKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY)?.replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service account credentials not configured');
  return new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
}

/** Abre el documento una sola vez (loadInfo trae ya todas las pestañas). */
async function loadDoc(config: ConversionesConfig): Promise<GoogleSpreadsheet> {
  const sheetId = extractSheetId(config.sheet_url);
  if (!sheetId) throw new Error(`URL de Google Sheets inválida: ${config.sheet_url}`);
  const auth = await createAuthClient(config.client_email, config.private_key);
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  return doc;
}

/** Lo único que la resolución de pestañas necesita del documento. */
type DocPestanas = Pick<GoogleSpreadsheet, 'sheetsByIndex' | 'sheetsByTitle'>;

/** Resuelve la pestaña por título; vacío = la primera del documento. */
function resolveTab(doc: DocPestanas, tabName: string): GoogleSpreadsheetWorksheet {
  const name = tabName?.trim();
  if (!name) return doc.sheetsByIndex[0];
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) {
    const available = Object.keys(doc.sheetsByTitle).join(', ');
    throw new Error(`Pestaña "${name}" no encontrada. Disponibles: ${available}`);
  }
  return sheet;
}

/**
 * Títulos REALES de todas las pestañas habilitadas —tal como quedan en
 * `tab_name`—, o null si alguna no aparece en el documento.
 *
 * Es la lista con la que se retiran las filas de pestañas borradas o renombradas
 * (`sheet_podar_tabs`), así que falla del lado seguro: una pestaña habilitada que
 * no se encuentra —renombrada en Google, una errata en la config— devuelve null y
 * no se poda nada, porque no hay forma de saber qué filas antiguas le pertenecen.
 * Una pestaña que existe pero no se pudo parsear sí entra, y conserva sus filas.
 * El nombre vacío resuelve a la primera pestaña, como en el sync.
 */
export function resolverTitulosVivos(doc: DocPestanas, tabs: SheetTabConfig[]): string[] | null {
  const titulos: string[] = [];
  for (const tab of tabs.filter((t) => t.enabled)) {
    try {
      const hoja = resolveTab(doc, tab.sheet_name);
      if (!hoja) return null;
      titulos.push(hoja.title);
    } catch {
      return null;
    }
  }
  return titulos;
}

/**
 * `resolverTitulosVivos` abriendo el documento. Null si Google no responde: sin
 * la lista no se poda, que es lo prudente.
 *
 * Existe para que la consolidación del sync por pestañas calcule la lista en el
 * servidor en vez de aceptar la que mande el navegador, que decidiría qué filas
 * se borran.
 */
export async function titulosVivosDelSheet(cfg: ConversionesConfig): Promise<string[] | null> {
  try {
    return resolverTitulosVivos(await loadDoc(cfg), normalizeTabs(cfg));
  } catch (e) {
    console.warn(
      `[conversiones] sheet ${cfg.id}: no se pudieron leer las pestañas para la poda:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

/** Alias del sanitizador compartido con el motor de campos (`lib/sheets/campos`). */
export function sanitizeColName(name: string): string {
  return sanitizarColumna(name);
}

function inferType(name: string, samples: string[]): CustomColumnType {
  const n = name.toLowerCase();
  if (/tasa|rate|pct|porcentaje|ratio|conversion|efectividad|%/.test(n)) return 'percentage';
  if (/valor|revenue|precio|costo|cost|spend|inversion|ingreso|factur|usd|cop|eur|\$|monto/.test(n))
    return 'currency';
  if (/fecha|date|dia|mes|semana|periodo/.test(n)) return 'date';
  // Si la mayoría de muestras no son numéricas → texto
  const numericCount = samples.filter((v) => {
    const cleaned = v.replace(/[^0-9.,-]/g, '');
    return cleaned.length > 0 && !isNaN(parseFloat(cleaned));
  }).length;
  if (samples.length > 0 && numericCount < samples.length * 0.5) return 'text';
  return 'count';
}

/**
 * Columnas que no conviene guardar en crudo: datos personales y campos con un
 * valor distinto por fila (id, email, teléfono). No sirven como dimensión y son
 * las que más abultan `sheet_filas`. Es una sugerencia: la UI las propone
 * marcadas en `raw_exclude` y el analista puede desmarcarlas.
 */
export function esColumnaSensible(name: string): boolean {
  const n = sanitizeColName(name);
  return (
    /(^|_)(id|ids)$/.test(n) ||
    /email|correo|telefono|phone|whatsapp|celular|movil|nombre|apellido|documento|cedula|dni|nit|pasaporte|direccion|address/.test(
      n
    )
  );
}

/**
 * ¿Es una fecha que existe en el calendario? "2026-02-31" tiene forma válida pero
 * no existe, y Postgres rechaza la sentencia entera al insertarla.
 */
function fechaExiste(iso: string): boolean {
  const [a, m, d] = iso.split('-').map(Number);
  if (!a || !m || !d) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Normaliza la celda de fecha a `YYYY-MM-DD`, o devuelve '' si no es una fecha
 * real (la fila se descarta aguas arriba).
 *
 * La comprobación de que el día EXISTE no es teórica: una hoja de cliente traía
 * un "31/02/2026" que pasaba el regex, llegaba a Postgres como "2026-02-31" y
 * reventaba con `date/time field value out of range`. Como se inserta por lotes de
 * 500, esa única celda tumbaba el sheet completo y el cliente se quedaba sin
 * conversiones. Mejor descartar la fila que perderlas todas.
 *
 * El año de dos dígitos tampoco es teórico: desde el 1-sep-2026 la hoja
 * GESTION LEADS de Somos rentable escribe "01/09/26" en vez de "01/09/2026", y
 * como solo se aceptaban cuatro cifras el mes entero se descartaba —con el sync
 * en verde—. Lo mismo le pasaba desde siempre a sus filas de sep–nov 2025. Dos
 * cifras se leen como 20yy: no hay hojas con fechas del siglo pasado.
 */
export function parseDate(raw: string): string {
  if (!raw) return '';
  const t = raw.trim();
  // Acepta fecha sola, ISO con T y "YYYY-MM-DD HH:MM:SS" (separador espacio, el
  // que usan los exports de formularios de Meta). Antes solo se cortaba por la
  // T, así que la variante con espacio se descartaba como fecha inválida.
  //
  // El `(?!\d)` cierra el año: sin él "01/09/20261" pasaba como 2026-09-01.
  let iso = '';
  if (/^\d{4}-\d{2}-\d{2}(?!\d)/.test(t)) {
    iso = t.slice(0, 10);
  } else {
    const dmy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/);
    if (dmy) {
      const anio = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
      iso = `${anio}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      // Con día ≤ 12 la fecha es ambigua (dd/mm vs mm/dd). Si leerla como dd/mm no
      // da un día real, se prueba mm/dd antes de descartarla.
      if (!fechaExiste(iso)) {
        const alt = `${anio}-${dmy[1].padStart(2, '0')}-${dmy[2].padStart(2, '0')}`;
        iso = fechaExiste(alt) ? alt : iso;
      }
    }
  }

  return iso && fechaExiste(iso) ? iso : '';
}

/**
 * Convierte el texto de una celda a número. Acepta las dos convenciones de
 * separadores (misma regla que `parseFieldNumber` del BI):
 *   "1.000,50" → 1000.5    "1,000.50" → 1000.5    "12,5" → 12.5
 *
 * El "1.200" con punto de miles es el caso importante: la versión anterior
 * limpiaba solo las comas y parseFloat lo leía como 1.2, así que un valor de
 * $1.200 entraba a la base como 1,2.
 */
function toNumber(raw: string): number {
  return parseNumeroSheet(raw) ?? 0;
}

/**
 * Límites de las columnas de destino (`migrations/023`): `cantidad INTEGER` y
 * `valor NUMERIC(12,2)`.
 *
 * El upsert va en trozos de 500 filas decodificados con `jsonb_to_recordset`, así
 * que UNA celda fuera de tipo —"1,5" en la cantidad, un teléfono en el valor—
 * hacía que Postgres rechazara el trozo entero y el sheet completo quedaba en
 * error. Mejor descartar esa fila con un aviso que perderlas todas.
 */
const CANTIDAD_MAX = 2_147_483_647;
const VALOR_MAX = 1e10;

/**
 * Cabecera REAL de la pestaña para un nombre configurado, sin distinguir
 * mayúsculas ni espacios de los extremos; si no existe, el nombre tal cual.
 *
 * Las comprobaciones de cabecera ignoran mayúsculas y espacios, pero `row.get`
 * pide el nombre EXACTO: una "Fecha " con espacio pasaba la comprobación y
 * después cada fila se leía vacía. Vale para las columnas estándar y también
 * para las adicionales y la capa cruda declarada, que tenían el mismo agujero.
 */
function resolverCabecera(headers: string[], nombre: string): string {
  const buscado = nombre.toLowerCase().trim();
  return headers.find((h) => h.toLowerCase().trim() === buscado) ?? nombre;
}

/** Nombres de columna estándar de una pestaña (con sus valores por defecto). */
function standardColNames(tab: SheetTabConfig) {
  return {
    colFecha: tab.col_fecha || 'fecha',
    colTipo: tab.col_tipo || 'tipo',
    colCantidad: tab.col_cantidad || 'cantidad',
    colValor: tab.col_valor || 'valor',
    colFuente: tab.col_fuente || 'fuente',
    colNotas: tab.col_notas || 'notas',
  };
}

/** Nombres que una columna de fecha suele llevar, en orden de preferencia. */
const ALIAS_FECHA = ['fecha', 'date', 'created_time', 'fecha_hora', 'día', 'dia'];

/**
 * Resuelve la columna de fecha de una pestaña.
 *
 * Con `col_fecha` configurada se respeta tal cual. Sin ella se busca entre las
 * cabeceras: primero los alias habituales, luego la primera que contenga
 * "fecha"/"date". La migración 059 creó las hojas de leads legacy SIN columna de
 * fecha dando por hecho justo este fallback ("el parser ya resuelve fecha /
 * date / created_time"), pero no existía: la hoja moría con "Columna de fecha
 * «fecha» no encontrada" y no sincronizaba nada.
 *
 * `auto` marca que se adivinó, para avisarlo en el reporte de calidad: adivinar
 * en silencio es peor que fallar — nadie revisaría si el eje temporal elegido es
 * el que el cliente quería.
 */
function resolveColFecha(tab: SheetTabConfig, headers: string[]): { col: string; auto: boolean } {
  const configurada = (tab.col_fecha ?? '').trim();
  if (configurada) return { col: configurada, auto: false };

  const norm = headers.map((h) => h.toLowerCase().trim());
  for (const alias of ALIAS_FECHA) {
    const i = norm.indexOf(alias);
    if (i >= 0) return { col: headers[i], auto: false };
  }
  const i = norm.findIndex((h) => /fecha|date/.test(h));
  if (i >= 0) return { col: headers[i], auto: true };

  // Ninguna candidata: se devuelve el valor por defecto para que el llamador
  // lance el error de siempre, con su lista de columnas disponibles.
  return { col: 'fecha', auto: false };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Lista las pestañas reales del documento, para que la UI ofrezca elegirlas en
 * vez de teclear el nombre a mano.
 */
export async function listSheetTabs(config: ConversionesConfig): Promise<SheetTabInfo[]> {
  const doc = await loadDoc(config);
  return doc.sheetsByIndex.map((s, index) => ({
    title: s.title,
    index,
    rowCount: s.rowCount ?? 0,
  }));
}

/**
 * Inspecciona los encabezados de UNA pestaña y propone tipos para cada columna
 * extra. No guarda nada — solo devuelve sugerencias para que el analista
 * confirme. Devuelve también los headers completos para poblar el mapeo estándar.
 */
export async function detectSheetColumns(
  config: ConversionesConfig,
  tab?: SheetTabConfig
): Promise<{ headers: string[]; columns: DetectedColumn[] }> {
  const target = tab ?? normalizeTabs(config)[0];
  const doc = await loadDoc(config);
  const sheet = resolveTab(doc, target.sheet_name);

  const rows = await sheet.getRows({ limit: 6 });
  const headers = sheet.headerValues ?? [];

  const std = standardColNames(target);
  // La de fecha se resuelve contra las cabeceras reales, igual que en el parser:
  // si no, una columna auto-detectada («FECHA DE AGENDA») se ofrecería aquí como
  // columna extra a la vez que el sync la usa de eje temporal.
  std.colFecha = resolveColFecha(target, headers).col;
  const standardCols = new Set(Object.values(std).map((c) => c.toLowerCase().trim()));
  const extraHeaders = headers.filter((h) => !standardCols.has(h.toLowerCase().trim()));

  const columns = extraHeaders.map((col) => {
    const samples = rows
      .map((r) => (r.get(col) || '').toString().trim())
      .filter(Boolean)
      .slice(0, 5);

    const sanitized = sanitizeColName(col);
    const existing = target.custom_columns?.[sanitized];

    return {
      col_name: col,
      sanitized_name: sanitized,
      proposed_type: existing?.type ?? inferType(col, samples),
      label: existing?.label ?? col,
      sample_values: samples,
      sensible: esColumnaSensible(col),
    };
  });

  return { headers, columns };
}

/** Fila del Sheet, reducida a lo que necesita el parser (facilita probarlo). */
export interface SheetRowLike {
  get(column: string): any;
}

/** Lo que produce una pestaña: conversiones, filas crudas y reporte de calidad. */
export interface TabPayload {
  conversiones: ConversionRow[];
  crudas: SheetRawRow[];
  quality: TabSyncQuality;
}

/**
 * Columnas que se guardan en crudo para una pestaña, según `raw_mode` y
 * `raw_exclude`. Se deduplica por nombre sanitizado conservando la primera
 * aparición: dos encabezados distintos pueden sanitizar igual ("Ciudad" y
 * "ciudad.").
 */
function rawColsForTab(
  headers: string[],
  tab: SheetTabConfig
): Array<{ header: string; sanitized: string }> {
  const mode: SheetRawMode = tab.raw_mode ?? 'all';
  if (mode === 'none') return [];

  const exclude = new Set((tab.raw_exclude ?? []).map(sanitizeColName));

  const candidatas =
    mode === 'declared'
      ? Object.entries(tab.custom_columns ?? {})
          .filter(([, def]) => def.include)
          .map(([sanitized, def]) => ({ header: resolverCabecera(headers, def.col_name), sanitized }))
      : headers.map((h) => ({ header: h, sanitized: sanitizeColName(h) }));

  const vistas = new Set<string>();
  const out: Array<{ header: string; sanitized: string }> = [];
  for (const c of candidatas) {
    if (!c.sanitized || exclude.has(c.sanitized) || vistas.has(c.sanitized)) continue;
    vistas.add(c.sanitized);
    out.push(c);
  }
  return out;
}

/**
 * Recorre las filas de una pestaña UNA sola vez y produce las dos capas:
 *
 *   • `conversiones` — el modelo interpretado de siempre (fecha/tipo/cantidad/
 *     valor/fuente/notas + columnas adicionales tipadas). Sin cambios.
 *   • `crudas` — la fila tal cual, con todas sus columnas sin convertir. Es la
 *     capa sobre la que se definen los campos de Sheet, y se emite AUNQUE la
 *     fila no llegue a ser conversión (cantidad <= 0): una fila sin cantidad
 *     sigue teniendo valores de campo. La fecha sí es obligatoria en ambas —
 *     es el eje temporal de todo el módulo.
 *
 * Pura: no toca red ni base, así que es la parte verificable del sync
 * (ver scripts/verify-conversiones-multitab.ts).
 */
export function parseTabPayload(
  headers: string[],
  rows: SheetRowLike[],
  tab: SheetTabConfig,
  sheetId: string,
  tabTitle: string
): TabPayload {
  const quality: TabSyncQuality = {
    tab_name: tabTitle,
    rows_ok: 0,
    fecha_invalida: 0,
    fecha_vacia: 0,
    cantidad_invalida: 0,
    solo_crudas: 0,
    columnas_crudas: 0,
    warnings: [],
  };

  const std = standardColNames(tab);
  const { col: fechaConfig, auto: fechaAdivinada } = resolveColFecha(tab, headers);

  const headersLower = headers.map((h) => h.toLowerCase().trim());
  if (!headersLower.includes(fechaConfig.toLowerCase().trim())) {
    throw new Error(
      `Columna de fecha "${fechaConfig}" no encontrada. Disponibles: ${headers.join(', ')}`
    );
  }

  // Se resuelve una vez a la cabecera real (ver `resolverCabecera`).
  const colFecha = resolverCabecera(headers, fechaConfig);
  const colTipo = resolverCabecera(headers, std.colTipo);
  const colCantidad = resolverCabecera(headers, std.colCantidad);
  const colValor = resolverCabecera(headers, std.colValor);
  const colFuente = resolverCabecera(headers, std.colFuente);
  const colNotas = resolverCabecera(headers, std.colNotas);

  if (fechaAdivinada) {
    quality.warnings.push(
      `Sin columna de fecha configurada: se está usando "${colFecha}". ` +
        `Confírmala en Ajustes del cliente → Google Sheets si no es el eje temporal que quieres.`
    );
  }
  // Un nombre de columna mal escrito se leía como vacío sin aviso: ahora queda
  // registrado en el reporte de calidad del sync. Las columnas resueltas por
  // configuración (cantidad con `count_rows`, tipo con `tipo_fijo`) no se avisan.
  //
  // Valor, fuente y notas son opcionales de verdad: solo se avisa si alguien las
  // configuró con un nombre que no existe. Avisar de sus nombres por defecto en
  // cada hoja de leads —que no los tiene— dejaba TODOS los sync en `partial`, y
  // un estado que siempre está en ámbar no avisa de nada.
  const opcionales: Record<string, string | undefined> = {
    valor: tab.col_valor,
    fuente: tab.col_fuente,
    notas: tab.col_notas,
  };
  if (!tab.count_rows) opcionales.cantidad = std.colCantidad;
  if (!tab.tipo_fijo) opcionales.tipo = std.colTipo;
  for (const [label, col] of Object.entries(opcionales)) {
    if (!col?.trim()) continue;
    if (!headersLower.includes(col.toLowerCase().trim())) {
      quality.warnings.push(`Columna de ${label} "${col}" no existe en la pestaña`);
    }
  }

  const standardCols = new Set(
    [colFecha, colTipo, colCantidad, colValor, colFuente, colNotas].map((c) =>
      c.toLowerCase().trim()
    )
  );

  // Columnas extra: las configuradas con include:true, o todas las detectadas
  // si la pestaña aún no tiene configuración (comportamiento legacy).
  const customCols = tab.custom_columns;
  let extraColsToProcess: Array<{ header: string; sanitized: string; type: CustomColumnType }>;

  if (customCols && Object.keys(customCols).length > 0) {
    extraColsToProcess = Object.entries(customCols)
      .filter(([, def]) => def.include)
      // La clave sigue siendo la `sanitized` configurada: re-sanearla desde la
      // cabecera resuelta cambiaría las claves de `custom_fields` y los tokens del BI.
      .map(([sanitized, def]) => ({
        header: resolverCabecera(headers, def.col_name),
        sanitized,
        type: def.type,
      }));
    for (const col of extraColsToProcess) {
      if (!headersLower.includes(col.header.toLowerCase().trim())) {
        quality.warnings.push(`Columna adicional "${col.header}" no existe en la pestaña`);
      }
    }
  } else {
    extraColsToProcess = headers
      .filter((h) => !standardCols.has(h.toLowerCase().trim()))
      .map((h) => ({
        header: h,
        sanitized: sanitizeColName(h),
        type: 'count' as CustomColumnType,
      }));
  }

  // Capa cruda: independiente del mapeo estándar, incluye también las columnas
  // de fecha/tipo/cantidad… porque un campo de Sheet puede apuntar a cualquiera.
  const rawCols = rawColsForTab(headers, tab);
  quality.columnas_crudas = rawCols.length;

  const conversiones: ConversionRow[] = [];
  const crudas: SheetRawRow[] = [];

  const ejemplos: string[] = [];
  const ejemplosCantidad: string[] = [];
  const ejemplosValor: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const celdaFecha = (row.get(colFecha) ?? '').toString().trim();
    const fecha = parseDate(celdaFecha);
    if (!fecha) {
      if (celdaFecha) {
        quality.fecha_invalida++;
        if (ejemplos.length < 3 && !ejemplos.includes(celdaFecha)) ejemplos.push(celdaFecha);
      } else {
        // Sin fecha. Una fila totalmente vacía es relleno del Sheet y no cuenta;
        // una con contenido (plantilla prellenada, registro a medias) va aparte
        // de las fechas ilegibles, porque no es un formato roto.
        const isBlank = headers.every((h) => !(row.get(h) || '').toString().trim());
        if (!isBlank) quality.fecha_vacia!++;
      }
      continue;
    }

    if (rawCols.length > 0) {
      const valores: Record<string, string> = {};
      for (const col of rawCols) {
        const raw = (row.get(col.header) ?? '').toString().trim();
        if (raw) valores[col.sanitized] = raw;
      }
      crudas.push({ sheet_id: sheetId, tab_name: tabTitle, fecha, fila_num: i + 1, valores });
    }

    const rawTipo = (row.get(colTipo) ?? '').toString().trim();
    const tipo = (rawTipo || tab.tipo_fijo || 'otro').toLowerCase();
    // En modo "una fila = una conversión" la columna de cantidad no se lee.
    const celdaCantidad = tab.count_rows ? '' : (row.get(colCantidad) || '').toString().trim();
    const cantidad = tab.count_rows ? 1 : toNumber(celdaCantidad || '0');
    const fuente = (row.get(colFuente) || '').toString().trim();
    const notas = (row.get(colNotas) || '').toString().trim();

    // No es conversión, pero su fila cruda ya quedó guardada arriba: sigue
    // sirviendo para los campos de Sheet.
    if (cantidad <= 0) {
      quality.cantidad_invalida++;
      quality.solo_crudas!++;
      continue;
    }

    // Una cantidad que no cabe en `INTEGER` tumbaba el trozo entero (ver
    // `CANTIDAD_MAX`). No se redondea: un decimal en la columna que cuenta
    // conversiones casi siempre es un mapeo equivocado —un importe, una tasa—, y
    // redondear lo escondería (0,4 además acabaría en 0).
    if (!Number.isInteger(cantidad) || cantidad > CANTIDAD_MAX) {
      quality.cantidad_invalida++;
      quality.cantidad_rechazada = (quality.cantidad_rechazada ?? 0) + 1;
      quality.solo_crudas!++;
      if (ejemplosCantidad.length < 3 && !ejemplosCantidad.includes(celdaCantidad)) {
        ejemplosCantidad.push(celdaCantidad);
      }
      continue;
    }

    // Sin número legible el valor es null, no 0: "N/A" no es una venta de cero.
    // Uno fuera de NUMERIC(12,2) se guarda sin valor —la fila sigue siendo
    // conversión— y queda avisado: suele ser un teléfono o un documento.
    const celdaValor = (row.get(colValor) || '').toString().trim();
    let valor = celdaValor ? parseNumeroSheet(celdaValor) : null;
    if (
      valor !== null &&
      (!Number.isFinite(valor) || Math.abs(Math.round(valor * 100) / 100) >= VALOR_MAX)
    ) {
      quality.valor_fuera_de_rango = (quality.valor_fuera_de_rango ?? 0) + 1;
      if (ejemplosValor.length < 3 && !ejemplosValor.includes(celdaValor)) {
        ejemplosValor.push(celdaValor);
      }
      valor = null;
    }

    const custom_fields: Record<string, any> = {};
    for (const col of extraColsToProcess) {
      const raw = (row.get(col.header) || '').toString().trim();
      if (!raw) continue;
      if (col.type === 'count' || col.type === 'currency' || col.type === 'percentage') {
        const n = toNumber(raw);
        if (!isNaN(n)) custom_fields[col.sanitized] = n;
      } else {
        custom_fields[col.sanitized] = raw;
      }
    }

    conversiones.push({
      fecha,
      tipo,
      cantidad,
      valor,
      fuente,
      notas,
      custom_fields,
      sheet_id: sheetId,
      tab_name: tabTitle,
      // Mismo `i + 1` que la fila cruda de arriba: las dos salen de esta misma
      // vuelta del bucle, así que comparten número de fila y con él la clave.
      fila_num: i + 1,
    });
  }

  quality.rows_ok = conversiones.length;
  // Los descartes se explican con la columna concreta: un "0 filas importadas"
  // sin motivo obliga a adivinar si falla la fecha, la cantidad o el mapeo.
  //
  // El aviso cita valores reales rechazados: «677 filas sin fecha válida» no
  // decía que el problema era "01/09/26", y había que abrir el Sheet a adivinar.
  if (quality.fecha_invalida > 0) {
    quality.ejemplos_fecha_invalida = ejemplos;
    quality.warnings.push(
      `${quality.fecha_invalida} filas con una fecha que no se entiende en "${colFecha}"` +
        ` (p. ej. ${ejemplos.map((e) => `"${e}"`).join(', ')})` +
        ' — escríbela como DD/MM/AAAA o AAAA-MM-DD'
    );
  }
  const cantidadVacia = quality.cantidad_invalida - (quality.cantidad_rechazada ?? 0);
  if (cantidadVacia > 0) {
    quality.warnings.push(
      `${cantidadVacia} filas con cantidad 0 o vacía en "${colCantidad}"` +
        ' — si el Sheet trae una conversión por fila, activa "Cada fila es una conversión"'
    );
  }
  if (quality.cantidad_rechazada) {
    quality.ejemplos_cantidad_rechazada = ejemplosCantidad;
    quality.warnings.push(
      `${quality.cantidad_rechazada} filas con una cantidad que no es un número entero válido en "${colCantidad}"` +
        ` (p. ej. ${ejemplosCantidad.map((e) => `"${e}"`).join(', ')})` +
        ' — la cantidad cuenta conversiones; si es un importe, mapéala como valor o como columna adicional'
    );
  }
  if (quality.valor_fuera_de_rango) {
    quality.ejemplos_valor_fuera_de_rango = ejemplosValor;
    quality.warnings.push(
      `${quality.valor_fuera_de_rango} filas con un valor fuera de rango en "${colValor}"` +
        ` (p. ej. ${ejemplosValor.map((e) => `"${e}"`).join(', ')})` +
        ' — se guardaron sin valor; ¿es un teléfono o un documento?'
    );
  }
  return { conversiones, crudas, quality };
}

/**
 * Solo las conversiones de una pestaña. Se conserva porque es la firma que usan
 * las comprobaciones del parser y porque el resto del sync de conversiones
 * offline no necesita la capa cruda.
 */
export function parseRowsForTab(
  headers: string[],
  rows: SheetRowLike[],
  tab: SheetTabConfig,
  sheetId: string,
  tabTitle: string
): { rows: ConversionRow[]; quality: TabSyncQuality } {
  const { conversiones, quality } = parseTabPayload(headers, rows, tab, sheetId, tabTitle);
  return { rows: conversiones, quality };
}

/** Lee una pestaña ya resuelta del documento y la parsea. */
async function parseTabRows(
  sheet: GoogleSpreadsheetWorksheet,
  tab: SheetTabConfig,
  sheetId: string
): Promise<TabPayload> {
  const rows = await sheet.getRows();
  return parseTabPayload(sheet.headerValues ?? [], rows, tab, sheetId, sheet.title);
}

/**
 * Lee todas las pestañas habilitadas de un documento. El doc se carga una sola
 * vez y cada pestaña aplica su propio mapeo de columnas.
 *
 * Una pestaña que falla (no existe, sin columna de fecha) queda como warning y
 * no impide sincronizar las demás; si fallan TODAS se lanza el error para que
 * el sheet se marque como fallido y sus datos anteriores se conserven.
 */
export async function fetchConversionesFromSheet(config: ConversionesConfig): Promise<{
  rows: ConversionRow[];
  crudas: SheetRawRow[];
  quality: TabSyncQuality[];
  /**
   * Títulos de las pestañas leídas ENTERAS, tal y como quedan en `tab_name`.
   *
   * Es lo único que el sync puede podar sin riesgo: una pestaña que falló sale
   * de aquí, así que conserva sus filas anteriores en vez de quedarse vacía por
   * un error de lectura. Una pestaña leída bien pero con 0 filas sí entra —el
   * Sheet está vacío de verdad y sus filas viejas deben irse—.
   */
  tabsLeidas: string[];
  /** Ver `resolverTitulosVivos`: base de la poda de pestañas retiradas. */
  tabsVivas: string[] | null;
}> {
  const sheetId = config.id || 'sheet_0';
  const tabs = normalizeTabs(config).filter((t) => t.enabled);
  if (tabs.length === 0) {
    return { rows: [], crudas: [], quality: [], tabsLeidas: [], tabsVivas: [] };
  }

  const doc = await loadDoc(config);
  const tabsVivas = resolverTitulosVivos(doc, tabs);

  const allRows: ConversionRow[] = [];
  const allCrudas: SheetRawRow[] = [];
  const quality: TabSyncQuality[] = [];
  const tabsLeidas: string[] = [];
  let failed = 0;

  for (const tab of tabs) {
    try {
      const sheet = resolveTab(doc, tab.sheet_name);
      const res = await parseTabRows(sheet, tab, sheetId);
      allRows.push(...res.conversiones);
      allCrudas.push(...res.crudas);
      quality.push(res.quality);
      tabsLeidas.push(res.quality.tab_name);
    } catch (err: any) {
      failed++;
      quality.push({
        tab_name: tab.sheet_name || '(primera pestaña)',
        rows_ok: 0,
        fecha_invalida: 0,
        cantidad_invalida: 0,
        warnings: [err.message || 'Error leyendo la pestaña'],
      });
    }
  }

  if (failed === tabs.length) {
    throw new Error(quality.map((q) => `${q.tab_name}: ${q.warnings.join('; ')}`).join(' | '));
  }

  return { rows: allRows, crudas: allCrudas, quality, tabsLeidas, tabsVivas };
}

/**
 * Agrupa por fecha+tipo+fuente.
 * - count / currency → suma
 * - percentage → promedio ponderado por cantidad de la fila
 */
export function computeConversionesAggregates(
  rows: FilaAgregable[],
  customColumnsConfig?: Record<string, CustomColumnDef>
): ConversionDiaria[] {
  return finalizarAgregados(computeConversionesAggregatesParcial(rows, customColumnsConfig));
}

/** Lo que la agregación lee de una conversión: sirve igual la del parser que la de la base. */
export type FilaAgregable = Pick<
  ConversionRow,
  'fecha' | 'tipo' | 'fuente' | 'cantidad' | 'valor' | 'custom_fields'
>;

/**
 * Agregados diarios a partir de filas de `conversiones_offline` tal como las
 * devuelve PostgREST.
 *
 * Es lo que permite que los totales se recalculen desde la base y no desde lo
 * leído en esta corrida: con una pestaña caída, lo leído no incluye sus filas,
 * y los totales del día —cuya clave no lleva la pestaña— la borraban del BI
 * mientras el dashboard, que lee las filas, la seguía contando.
 *
 * Los porcentajes salen idénticos: el ponderado solo necesita el valor y la
 * cantidad de cada fila, y las dos cosas se guardan fila a fila. `fuente` se
 * normaliza a '' porque la columna de agregados es NOT NULL y hay filas antiguas
 * con NULL.
 */
export function agregadosDesdeFilasDb(
  filas: Array<Record<string, unknown>>,
  customColumnsConfig?: Record<string, CustomColumnDef>
): ConversionDiaria[] {
  const rows: FilaAgregable[] = filas.map((f) => ({
    fecha: String(f.fecha),
    tipo: String(f.tipo ?? 'otro'),
    fuente: String(f.fuente ?? ''),
    cantidad: Number(f.cantidad) || 0,
    valor: f.valor === null || f.valor === undefined ? null : Number(f.valor),
    custom_fields: (f.custom_fields as Record<string, any> | null) ?? {},
  }));
  const custom =
    customColumnsConfig && Object.keys(customColumnsConfig).length > 0
      ? customColumnsConfig
      : undefined;
  return computeConversionesAggregates(rows, custom);
}

/**
 * Agregado a medio hacer: conserva las sumas de los porcentajes en vez de su
 * división. Es lo que permite sumar el aporte de varias pestañas sin perder el
 * ponderado — promediar promedios daría otro número.
 */
export interface ConversionDiariaParcial extends ConversionDiaria {
  _pct_sums: Record<string, { total: number; weight: number }>;
}

/** Igual que `computeConversionesAggregates`, pero sin resolver los porcentajes. */
export function computeConversionesAggregatesParcial(
  rows: FilaAgregable[],
  customColumnsConfig?: Record<string, CustomColumnDef>
): ConversionDiariaParcial[] {
  const map = new Map<string, ConversionDiariaParcial>();

  for (const row of rows) {
    const key = `${row.fecha}|${row.tipo}|${row.fuente}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        fecha: row.fecha,
        tipo: row.tipo,
        fuente: row.fuente,
        total_cantidad: 0,
        total_valor: 0,
        custom_fields: {},
        _pct_sums: {},
      };
      map.set(key, entry);
    }

    entry.total_cantidad += row.cantidad;
    entry.total_valor += row.valor ?? 0;

    for (const [k, v] of Object.entries(row.custom_fields)) {
      const colType = customColumnsConfig?.[k]?.type ?? 'count';
      if (colType === 'text' || colType === 'date') continue;
      // Solo números. `mergeTabCustomColumns` se queda con la última definición,
      // así que una clave `text` en una pestaña y `count` en otra hacía
      // `0 + "abc"` = "0abc". Con el recálculo desde la base también llegan filas
      // escritas con una config anterior.
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (colType === 'percentage') {
        if (!entry._pct_sums[k]) entry._pct_sums[k] = { total: 0, weight: 0 };
        entry._pct_sums[k].total += (v as number) * row.cantidad;
        entry._pct_sums[k].weight += row.cantidad;
      } else {
        entry.custom_fields[k] = (entry.custom_fields[k] ?? 0) + (v as number);
      }
    }
  }

  return Array.from(map.values());
}

/** Suma los agregados parciales de varias pestañas del mismo sheet. */
export function mergeAgregadosParciales(
  partes: ConversionDiariaParcial[][]
): ConversionDiariaParcial[] {
  const map = new Map<string, ConversionDiariaParcial>();

  for (const parte of partes) {
    for (const a of parte) {
      const key = `${a.fecha}|${a.tipo}|${a.fuente}`;
      const acc = map.get(key);
      if (!acc) {
        map.set(key, {
          ...a,
          custom_fields: { ...a.custom_fields },
          _pct_sums: Object.fromEntries(
            Object.entries(a._pct_sums ?? {}).map(([k, v]) => [k, { ...v }])
          ),
        });
        continue;
      }
      acc.total_cantidad += a.total_cantidad;
      acc.total_valor += a.total_valor;
      for (const [k, v] of Object.entries(a.custom_fields)) {
        acc.custom_fields[k] = (acc.custom_fields[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(a._pct_sums ?? {})) {
        if (!acc._pct_sums[k]) acc._pct_sums[k] = { total: 0, weight: 0 };
        acc._pct_sums[k].total += v.total;
        acc._pct_sums[k].weight += v.weight;
      }
    }
  }

  return Array.from(map.values());
}

/** Resuelve los porcentajes ponderados y deja el agregado listo para guardar. */
export function finalizarAgregados(parciales: ConversionDiariaParcial[]): ConversionDiaria[] {
  return parciales.map(({ _pct_sums, ...entry }) => {
    for (const [k, { total, weight }] of Object.entries(_pct_sums ?? {})) {
      entry.custom_fields[k] = weight > 0 ? total / weight : 0;
    }
    return entry;
  });
}

/**
 * Lista los Google Sheets (spreadsheets) accesibles para la cuenta OAuth de la agencia.
 * Usa la API REST de Drive v3 con el access_token del OAuth.
 */
export async function listGoogleSheets(): Promise<DriveSheet[]> {
  const client = await getAgencyAccessToken();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('No se pudo obtener el access token de la cuenta de la agencia');

  const q = encodeURIComponent(
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
  );
  const fields = encodeURIComponent('files(id,name,webViewLink,modifiedTime)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=modifiedTime+desc&pageSize=50`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error?.message || `Drive API error: ${res.status}`);
  }

  const data = (await res.json()) as { files?: any[] };
  return (data.files || []).map((f: any) => ({
    id: f.id as string,
    name: f.name as string,
    url: f.webViewLink as string,
    modifiedTime: f.modifiedTime as string,
  }));
}

/** Filas por llamada a las RPC de upsert (migración 069). */
const UPSERT_TRAMO = 500;

/**
 * Manda un tramo de filas a la RPC de upsert y devuelve cuántas escribió.
 *
 * La RPC resuelve el diff en la propia sentencia: inserta las claves nuevas,
 * actualiza las que cambiaron de hash y descarta —sin escribir— las idénticas.
 * El número que devuelve es la métrica que interesa vigilar: en un Sheet que no
 * se ha tocado tiene que ser 0.
 */
async function upsertTramos(
  supabase: any,
  rpc: string,
  clienteId: string,
  sheetId: string,
  batchId: string,
  filas: Record<string, unknown>[]
): Promise<number> {
  let escritas = 0;
  for (let i = 0; i < filas.length; i += UPSERT_TRAMO) {
    const { data, error } = await supabase.rpc(rpc, {
      p_cliente_id: clienteId,
      p_sheet_id: sheetId,
      p_batch: batchId,
      p_filas: filas.slice(i, i + UPSERT_TRAMO),
    });
    if (error) throw new Error(error.message);
    escritas += Number(data ?? 0);
  }
  return escritas;
}

/**
 * ¿La lectura de hoy deja una pestaña con muchas menos conversiones de las que
 * guarda la base? Vaciarla del todo siempre es sospechoso; perder más de la
 * mitad, solo con un histórico que merezca el nombre (con 10 filas, borrar 7 a
 * mano es normal).
 *
 * Pura para poder comprobarla sin base (scripts/verify-conversiones-multitab.ts).
 */
export function caidaSospechosa(existentes: number, nuevas: number): boolean {
  if (existentes <= 0) return false;
  if (nuevas === 0) return true;
  return existentes >= 50 && nuevas < existentes * 0.5;
}

/** Poda una pestaña dejando vivas solo las filas cuyo número sigue en el Sheet. */
async function podarTab(
  supabase: any,
  rpc: string,
  clienteId: string,
  sheetId: string,
  tab: string,
  vivas: number[]
): Promise<void> {
  const { error } = await supabase.rpc(rpc, {
    p_cliente_id: clienteId,
    p_sheet_id: sheetId,
    p_tab_name: tab,
    p_vivas: vivas,
  });
  if (error) throw new Error(error.message);
}

/**
 * Escribe el lote de UNA tanda (un sheet entero, o una sola pestaña de él).
 *
 * ── Por qué ya no es un INSERT ──────────────────────────────────
 * Hasta la migración 069 esto insertaba el sheet ENTERO con un `sync_batch_id`
 * nuevo y `consolidarLoteSheet` borraba después el lote anterior. Medido en
 * producción: 1,5 millones de INSERT y 1,5 millones de DELETE para sostener
 * 25.863 filas vivas —unas 37 reescrituras por fila superviviente—, aunque el
 * Sheet no hubiera cambiado nada.
 *
 * Ahora se escribe por UPSERT contra la clave natural
 * (cliente_id, sheet_id, tab_name, fila_num) y la RPC compara un hash del
 * contenido: la fila que no cambió no se toca. Un sync sobre un Sheet estable
 * escribe cero filas.
 *
 * ── Y por qué el borrado se hace aquí y no al consolidar ────────
 * El criterio ya no es «lo que no lleve el lote de hoy» —que obligaba a esperar
 * a tener todas las pestañas— sino «las filas de ESTA pestaña cuyo número ya no
 * existe». Eso es local a la pestaña, así que se resuelve en el momento y una
 * pestaña no puede borrar lo de otra por mucho que se adelante.
 *
 * `tabsSincronizadas` marca qué pestañas se han leído enteras en esta tanda.
 * Sólo esas se podan: una pestaña que no se pudo leer conserva sus datos en vez
 * de quedarse vacía. Si no se pasa, se deduce de las filas recibidas (más
 * `tabName` cuando la tanda es de una sola pestaña).
 *
 * ── Qué pasa si falla a mitad ───────────────────────────────────
 * Un UPSERT no se puede deshacer: la fila anterior ya no está para restaurarla.
 * A cambio, el fallo no borra nada —la poda sólo corre si todos los tramos de
 * esa tabla entraron—, así que la pestaña queda con una mezcla de filas nuevas
 * y viejas y el siguiente sync la cuadra. Antes el fallo se deshacía entero,
 * pero a cambio de reescribirlo todo en cada corrida.
 */
export async function insertarLoteSheet(
  supabase: any,
  clienteId: string,
  sheetId: string,
  batchId: string,
  rows: ConversionRow[],
  crudas: SheetRawRow[] = [],
  tabName?: string,
  tabsSincronizadas?: string[]
): Promise<{ rowsProcessed: number; rawProcessed: number; rawError?: string }> {
  const tabs = tabsSincronizadas ?? [
    ...new Set([
      ...(tabName ? [tabName] : []),
      ...rows.map((r) => r.tab_name),
      ...crudas.map((r) => r.tab_name),
    ]),
  ];

  // ── Guarda de poda ────────────────────────────────────────────
  // La poda de abajo borra toda fila de la pestaña que no venga en esta
  // lectura. Si un cambio de formato (fecha, separadores, una columna
  // renombrada) deja la pestaña sin filas válidas, se llevaría el histórico
  // entero con el sync en `partial`, que no avisa a nadie. Ante una caída así
  // se para el sheet con error y los datos anteriores se quedan donde están.
  for (const tab of tabs) {
    const nuevas = rows.filter((r) => r.tab_name === tab).length;
    const { count, error } = await supabase
      .from('conversiones_offline')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheetId)
      .eq('tab_name', tab);
    if (error) throw new Error(`No se pudo comprobar el histórico de "${tab}": ${error.message}`);
    if (caidaSospechosa(count ?? 0, nuevas)) {
      throw new Error(
        `La pestaña "${tab}" pasaría de ${count} a ${nuevas} conversiones: no se sincroniza para no borrar su histórico. ` +
          'Revisa el formato de la fecha, de la cantidad y las columnas del Sheet; si la vaciaste a propósito, desactiva la pestaña en Ajustes.'
      );
    }
  }

  // ── Conversiones ──────────────────────────────────────────────
  await upsertTramos(
    supabase,
    'conversiones_offline_upsert_lote',
    clienteId,
    sheetId,
    batchId,
    rows.map((r) => ({
      tab_name: r.tab_name,
      fila_num: r.fila_num,
      fecha: r.fecha,
      tipo: r.tipo,
      cantidad: r.cantidad,
      valor: r.valor,
      fuente: r.fuente,
      notas: r.notas,
      custom_fields: r.custom_fields,
    }))
  ).catch((e: Error) => {
    throw new Error(`Error escribiendo conversiones: ${e.message}`);
  });

  for (const tab of tabs) {
    await podarTab(
      supabase,
      'conversiones_offline_podar_tab',
      clienteId,
      sheetId,
      tab,
      rows.filter((r) => r.tab_name === tab).map((r) => r.fila_num)
    ).catch((e: Error) => {
      throw new Error(`Error podando conversiones de "${tab}": ${e.message}`);
    });
  }

  // ── Capa cruda ────────────────────────────────────────────────
  // Un fallo aquí NO tumba el sheet: la capa cruda alimenta los campos de Sheet,
  // pero las conversiones y sus agregados ya están guardados y son lo que ven
  // hoy dashboards e informes. Si falla (p. ej. la migración 069 todavía no
  // está aplicada), se deja la capa cruda como estaba y se avisa — mejor una
  // capa cruda desactualizada que ninguna.
  let rawOk = true;
  let rawError: string | null = null;

  try {
    await upsertTramos(
      supabase,
      'sheet_filas_upsert_lote',
      clienteId,
      sheetId,
      batchId,
      crudas.map((r) => ({
        tab_name: r.tab_name,
        fecha: r.fecha,
        fila_num: r.fila_num,
        valores: r.valores,
      }))
    );
    for (const tab of tabs) {
      await podarTab(
        supabase,
        'sheet_filas_podar_tab',
        clienteId,
        sheetId,
        tab,
        crudas.filter((r) => r.tab_name === tab).map((r) => r.fila_num)
      );
    }
  } catch (e: unknown) {
    rawOk = false;
    rawError = e instanceof Error ? e.message : 'Error desconocido';
    console.error(`[conversiones] sheet ${sheetId}: no se pudo guardar la capa cruda:`, rawError);
  }

  return {
    rowsProcessed: rows.length,
    rawProcessed: rawOk ? crudas.length : 0,
    ...(rawError ? { rawError } : {}),
  };
}

/** Columnas de `conversiones_offline` que necesita el recálculo (más `id`, para paginar). */
const COLUMNAS_RECALCULO = 'id, fecha, tipo, cantidad, valor, fuente, custom_fields';

/**
 * Agregados diarios de UN sheet leyendo todas sus filas de la base, de todas sus
 * pestañas. Lanza si la lectura no se completa: con un recuento parcial, el
 * borrado del lote anterior sustituiría totales buenos por otros incompletos.
 */
async function leerAgregadosSheetDesdeDb(
  supabase: any,
  clienteId: string,
  sheetId: string,
  customCols: Record<string, CustomColumnDef>
): Promise<ConversionDiaria[]> {
  const filas = await fetchAllRows(
    () =>
      supabase
        .from('conversiones_offline')
        .select(COLUMNAS_RECALCULO)
        .eq('cliente_id', clienteId)
        .eq('sheet_id', sheetId),
    1000,
    200_000,
    { estricto: true }
  );
  return agregadosDesdeFilasDb(filas, customCols);
}

/**
 * Cierra un lote: recalcula los agregados diarios del sheet y retira los lotes
 * anteriores.
 *
 * Se llama UNA vez por sheet, con las filas ya escritas. Los agregados se
 * recalculan desde `conversiones_offline`, no desde lo leído en la corrida:
 * `uq_conv_diarias_origen` es único por (cliente, sheet, fecha, tipo, fuente)
 * **sin la pestaña**, así que un agregado hecho solo con las pestañas que se
 * pudieron leer pisaba el total del día y borraba del BI lo aportado por la
 * pestaña caída, que seguía en las filas y en el dashboard. Antes, además, el
 * sync por pestañas los recibía sumados desde el navegador. Leyendo la base, la
 * fuente de verdad es una sola y cualquier consolidación repara la deriva que
 * dejara una corrida a medias.
 *
 * El orden importa:
 *   1. se retiran las pestañas huérfanas, para que no entren en el recálculo;
 *   2. se recalcula — si la lectura falla, se lanza SIN escribir ni borrar nada:
 *      los totales anteriores siguen en pie hasta el próximo sync;
 *   3. upsert de los agregados con el lote nuevo;
 *   4. retirada de los lotes anteriores.
 *
 * `conservarCrudas` evita retirar las pestañas huérfanas cuando la capa cruda de
 * esta corrida quedó incompleta: mejor una capa cruda vieja que ninguna.
 *
 * `tabsVivas` son los títulos reales de las pestañas habilitadas (ver
 * `resolverTitulosVivos`). Todo lo que haya en la base bajo otra pestaña se
 * retira: es lo que queda cuando se borra, renombra o deshabilita una pestaña, y
 * desde la migración 069 ya no lo barre el reemplazo por lotes. Sin lista (null
 * o sin pasar) no se poda: no hay forma de distinguir "esta pestaña ya no
 * existe" de "no sé qué pestañas hay".
 */
export async function consolidarLoteSheet(
  supabase: any,
  clienteId: string,
  sheetCfg: ConversionesConfig,
  batchId: string,
  opts: { conservarCrudas?: boolean; tabsVivas?: string[] | null } = {}
): Promise<{ daysProcessed: number; replaceError?: string }> {
  const sheetId = sheetCfg.id!;
  const replaceErrors: string[] = [];

  // 1. Pestañas retiradas de la config: lo único que la poda por fila no
  // alcanza, porque a esa pestaña ya nadie la sincroniza.
  const { tabsVivas, conservarCrudas } = opts;
  if (!conservarCrudas && tabsVivas && tabsVivas.length > 0) {
    const { error: podaErr } = await supabase.rpc('sheet_podar_tabs', {
      p_cliente_id: clienteId,
      p_sheet_id: sheetId,
      p_tabs: tabsVivas,
    });
    if (podaErr) {
      replaceErrors.push(`pestañas huérfanas: ${podaErr.message}`);
      console.error(
        `[conversiones] sheet ${sheetId}: no se pudieron retirar las pestañas huérfanas:`,
        podaErr.message
      );
    }
  }

  // 2. Recálculo desde la base, fallando cerrado.
  let aggregates: ConversionDiaria[];
  try {
    aggregates = await leerAgregadosSheetDesdeDb(
      supabase,
      clienteId,
      sheetId,
      mergeTabCustomColumns(normalizeTabs(sheetCfg))
    );
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.error(`[conversiones] sheet ${sheetId}: no se pudieron recalcular los agregados:`, motivo);
    throw new Error(
      `No se pudieron recalcular los totales diarios (${motivo}). Las filas del Sheet sí se guardaron; ` +
        'el BI conserva los totales del sync anterior hasta el próximo.'
    );
  }

  // 3. Agregados del lote nuevo.
  if (aggregates.length > 0) {
    const toInsert = aggregates.map((a) => ({
      cliente_id: clienteId,
      fecha: a.fecha,
      tipo: a.tipo,
      fuente: a.fuente,
      total_cantidad: a.total_cantidad,
      total_valor: a.total_valor,
      custom_fields: a.custom_fields,
      sync_batch_id: batchId,
      sheet_id: sheetId,
    }));
    // UPSERT, no insert: el lote anterior sigue en la tabla hasta el replace de
    // abajo, así que un insert chocaba con él a partir del segundo sync de cada
    // sheet ("Error insertando agregados").
    //
    // El upsert es además lo correcto semánticamente: el agregado de un
    // (sheet, día, tipo, fuente) es único por definición. Al sobrescribirlo se
    // actualiza también su `sync_batch_id`, de modo que el borrado posterior
    // sigue retirando solo las filas que este sync ya no produce.
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase
        .from('conversiones_offline_diarias')
        .upsert(toInsert.slice(i, i + 500), {
          onConflict: 'cliente_id,sheet_id,fecha,tipo,fuente',
        });
      if (error) throw new Error(`Error insertando agregados: ${error.message}`);
    }
  }

  // 4. `conversiones_offline_diarias` sigue con el reemplazo por lotes: son 518
  // filas, se escriben por upsert sobre su propia clave única y el borrado del
  // lote anterior cuesta lo que un índice. No compensa cambiarla.
  //
  // `conversiones_offline` y `sheet_filas` YA NO pasan por aquí: desde la
  // migración 069 su borrado es la poda por número de fila que hace
  // `insertarLoteSheet`, pestaña a pestaña. Dejar además el borrado por lote
  // sería destructivo: las filas que no cambiaron conservan a propósito el
  // `sync_batch_id` de un lote anterior —no se reescriben— y este barrido se
  // las llevaría por delante.
  const err = await borrarLotesAnteriores(
    supabase,
    'conversiones_offline_diarias',
    clienteId,
    sheetId,
    batchId
  );
  if (err) {
    replaceErrors.push(`conversiones_offline_diarias: ${err}`);
    console.error(
      `[conversiones] sheet ${sheetId}: no se pudo retirar el lote anterior de agregados:`,
      err
    );
  }

  // Un replace fallido deja una copia entera del sheet conviviendo con la nueva.
  // Se propaga hacia arriba porque durante meses este fallo fue invisible: el
  // error del delete se descartaba y el sync reportaba éxito mientras
  // `sheet_filas` acumulaba un duplicado por ejecución.
  return {
    daysProcessed: aggregates.length,
    ...(replaceErrors.length > 0
      ? {
          replaceError: `No se retiraron lotes anteriores — hay filas duplicadas en ${replaceErrors.join('; ')}`,
        }
      : {}),
  };
}

/**
 * Reemplazo completo de UN sheet del cliente, en orden seguro: inserta el lote
 * nuevo entero y solo entonces retira los anteriores DE ESE MISMO SHEET. Antes
 * el borrado era por cliente: en un sync multi-sheet, si un sheet fallaba, el
 * replace con las filas de los que sí funcionaron borraba sus datos.
 */
export async function saveConversionesSheetToDb(
  supabase: any,
  clienteId: string,
  sheetCfg: ConversionesConfig,
  rows: ConversionRow[],
  crudas: SheetRawRow[] = [],
  /**
   * Pestañas leídas enteras (ver `fetchConversionesFromSheet`). Sólo esas se
   * podan fila a fila.
   */
  tabsLeidas?: string[],
  /**
   * Títulos reales de las pestañas habilitadas (ver `resolverTitulosVivos`). Lo
   * que quede en la base bajo otro título se retira. Una pestaña que existe pero
   * no se pudo leer está en la lista, así que conserva sus filas; con null no se
   * poda nada.
   */
  tabsVivas?: string[] | null
): Promise<{
  rowsProcessed: number;
  daysProcessed: number;
  rawProcessed: number;
  rawError?: string;
}> {
  const batchId = randomUUID();
  const insertado = await insertarLoteSheet(
    supabase,
    clienteId,
    sheetCfg.id!,
    batchId,
    rows,
    crudas,
    undefined,
    tabsLeidas
  );
  const cerrado = await consolidarLoteSheet(supabase, clienteId, sheetCfg, batchId, {
    conservarCrudas: !!insertado.rawError,
    tabsVivas,
  });

  const motivos = [insertado.rawError, cerrado.replaceError].filter(Boolean);
  return {
    rowsProcessed: insertado.rowsProcessed,
    daysProcessed: cerrado.daysProcessed,
    rawProcessed: insertado.rawProcessed,
    ...(motivos.length > 0 ? { rawError: motivos.join(' | ') } : {}),
  };
}

/**
 * Retira los lotes anteriores de un sheet, uno por `sync_batch_id`.
 *
 * Desde la migración 069 sólo la usa `conversiones_offline_diarias`. Las otras
 * dos tablas pasaron a poda por número de fila; aplicarles esto además borraría
 * las filas que no cambiaron, que a propósito conservan un lote anterior.
 *
 * Antes era un solo `.neq('sync_batch_id', batchId)`. El plan lo resolvía con un
 * Index Scan por (cliente_id, sheet_id) y `sync_batch_id` como filtro, así que
 * tocaba TODAS las filas del sheet de una vez: con ~80 mil filas y el índice GIN
 * sobre `valores` no cabía en el `statement_timeout` de 8 s del rol de PostgREST.
 * El delete moría, su error se descartaba y el lote viejo se quedaba.
 *
 * Borrando lote a lote cada sentencia usa `idx_sheet_filas_batch` de lleno y sólo
 * toca las filas de ese lote. En régimen normal es un único lote.
 */
async function borrarLotesAnteriores(
  supabase: any,
  tabla: string,
  clienteId: string,
  sheetId: string,
  batchId: string
): Promise<string | null> {
  // Se pide UN lote pendiente y se borra, hasta que no queden. No se listan todos
  // de golpe a propósito: PostgREST corta el select en `max-rows`, y esas primeras
  // filas pueden ser todas del mismo lote y ocultar el resto.
  const MAX_LOTES = 50;
  for (let i = 0; i < MAX_LOTES; i++) {
    const { data, error } = await supabase
      .from(tabla)
      .select('sync_batch_id')
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheetId)
      .neq('sync_batch_id', batchId)
      .limit(1);
    if (error) return error.message;
    if (!data || data.length === 0) return null;

    const lote = data[0].sync_batch_id;
    const { error: delError } = await supabase
      .from(tabla)
      .delete()
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheetId)
      .eq('sync_batch_id', lote);
    if (delError) return delError.message;
  }
  return `quedan lotes sin retirar tras ${MAX_LOTES} intentos`;
}

/** Filas por sentencia de borrado. Ver `borrarPorPaginas`. */
const BORRADO_PAGINA = 500;

/**
 * Borra filas por páginas de id en vez de en una sola sentencia.
 *
 * Un `delete` masivo sobre `sheet_filas` no cabe en el `statement_timeout` de 8 s
 * del rol de PostgREST: el índice GIN sobre `valores` hace que decenas de miles de
 * filas no entren ni de lejos. Y como el error se ignoraba, la basura se quedaba
 * y crecía en cada corrida. Troceado, cada sentencia toca 500 filas y termina.
 *
 * Devuelve cuántas borró y, si no pudo terminar, por qué — el llamador decide si
 * eso es un aviso o un fallo, pero ya no pasa desapercibido.
 */
async function borrarPorPaginas(
  supabase: any,
  tabla: string,
  filtrar: (q: any) => any,
  maxPaginas = 400
): Promise<{ borradas: number; error?: string }> {
  let borradas = 0;
  for (let i = 0; i < maxPaginas; i++) {
    const { data, error } = await filtrar(supabase.from(tabla).select('id')).limit(BORRADO_PAGINA);
    if (error) return { borradas, error: error.message };
    if (!data || data.length === 0) return { borradas };

    const ids = (data as { id: string }[]).map((r) => r.id);
    const { error: delErr } = await supabase.from(tabla).delete().in('id', ids);
    if (delErr) return { borradas, error: delErr.message };
    borradas += ids.length;
  }
  return { borradas, error: `quedan filas por retirar tras ${maxPaginas} páginas` };
}

/**
 * Borra las filas que ya no pertenecen a ningún sheet de la config: las de un
 * sheet eliminado y las anteriores a la trazabilidad por sheet (sheet_id NULL).
 * Debe llamarse DESPUÉS de los saves — si no, borraría los datos legacy antes de
 * que el sync los repueble.
 *
 * `configuredSheetIds` son TODOS los sheets de la config, habilitados o no.
 * Deshabilitar un sheet es pausar su sync, no tirar su historia; cuando esta
 * función recibía solo los habilitados, quitar la casilla borraba los datos.
 */
export async function cleanupOrphanConversiones(
  supabase: any,
  clienteId: string,
  configuredSheetIds: string[]
): Promise<{ deleted: number; errors: string[] }> {
  let deleted = 0;
  const errors: string[] = [];

  // Lista para el filtro `not.in` de PostgREST. Se hace por negación en vez de
  // listar primero los sheet_id existentes: aquel `select ... limit(5000)`
  // dejaba de ver los sheets huérfanos en clientes con muchas filas, y
  // `sheet_filas` es bastante más grande que las otras dos.
  const validList =
    configuredSheetIds.length > 0
      ? `(${configuredSheetIds.map((id) => `"${String(id).replace(/"/g, '""')}"`).join(',')})`
      : null;

  for (const table of ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas']) {
    // Las filas con sheet_id NULL van aparte: en SQL `NULL NOT IN (...)` no es
    // verdadero, así que el filtro de abajo no las alcanza.
    const nulos = await borrarPorPaginas(supabase, table, (q: any) =>
      q.eq('cliente_id', clienteId).is('sheet_id', null)
    );
    deleted += nulos.borradas;
    if (nulos.error) errors.push(`${table} (legacy): ${nulos.error}`);

    const retirados = await borrarPorPaginas(supabase, table, (q: any) => {
      const base = q.eq('cliente_id', clienteId).not('sheet_id', 'is', null);
      return validList ? base.not('sheet_id', 'in', validList) : base;
    });
    deleted += retirados.borradas;
    if (retirados.error) errors.push(`${table}: ${retirados.error}`);
  }

  return { deleted, errors };
}

export type SyncLogStatus = 'ok' | 'partial' | 'error';

/** Fila del log tal como la devuelve el endpoint de estado (para la UI). */
export interface SheetSyncStatus {
  sheet_id: string;
  run_at: string;
  status: SyncLogStatus;
  rows_ok: number;
  rows_descartadas: number;
  detalle: { por_pestana?: TabSyncQuality[]; error?: string };
}

/**
 * Registra el resultado del sync de un sheet (filas ok, descartadas y avisos por
 * pestaña) para que la UI de settings pueda mostrarlo. Nunca lanza: un fallo de
 * log no debe tumbar un sync que sí guardó datos.
 */
export async function logSyncResult(
  supabase: any,
  clienteId: string,
  sheetId: string,
  status: SyncLogStatus,
  quality: TabSyncQuality[],
  errorMessage?: string
): Promise<void> {
  try {
    const rowsOk = quality.reduce((s, q) => s + q.rows_ok, 0);
    const descartadas = quality.reduce((s, q) => s + q.fecha_invalida + q.cantidad_invalida, 0);

    await supabase.from('conversiones_offline_sync_log').insert({
      cliente_id: clienteId,
      sheet_id: sheetId,
      status,
      rows_ok: rowsOk,
      rows_descartadas: descartadas,
      detalle: { por_pestana: quality, ...(errorMessage ? { error: errorMessage } : {}) },
    });

    // Retención: solo los 20 registros más recientes por (cliente, sheet).
    const { data: old } = await supabase
      .from('conversiones_offline_sync_log')
      .select('id')
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheetId)
      .order('run_at', { ascending: false })
      .range(20, 999);
    const ids = ((old ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length > 0) {
      await supabase.from('conversiones_offline_sync_log').delete().in('id', ids);
    }
  } catch (err) {
    console.error('[conversiones] no se pudo registrar el log de sync:', err);
  }
}

/**
 * Sincroniza TODOS los sheets habilitados de un cliente: fetch por sheet,
 * agregados por sheet, replace por sheet y log de calidad. Un sheet que falla no
 * afecta a los demás ni borra sus datos.
 */
export interface SheetSyncResult {
  sheet_id: string;
  name: string;
  success: boolean;
  rowsProcessed: number;
  daysProcessed: number;
  rowsDescartadas: number;
  /** Filas guardadas en crudo en `sheet_filas` (base de los campos de Sheet). */
  rawProcessed: number;
  quality: TabSyncQuality[];
  error?: string;
}

/** Respuesta de `POST /api/admin/sync-conversiones-offline`, tal como la lee la UI. */
export interface SyncConversionesResponse {
  success: boolean;
  clientName: string;
  totalFilas: number;
  diasProcesados: number;
  filasDescartadas: number;
  filasCrudas: number;
  sheetsProcessed: number;
  camposRecalculados: number;
  warnings?: string[];
  error?: string;
}

/** Lo que devuelve sincronizar una pestaña suelta. */
export interface TabSyncResult {
  tab_id: string;
  tab_name: string;
  rowsProcessed: number;
  rawProcessed: number;
  rowsDescartadas: number;
  quality: TabSyncQuality[];
  rawError?: string;
}

/**
 * Sincroniza UNA pestaña dentro del lote `batchId`, sin agregar ni reemplazar.
 *
 * Es la unidad del sync partido: un documento de decenas de miles de filas no
 * cabe entero en el tiempo de una función, pero una pestaña sí. Todas las
 * pestañas de una corrida comparten `batchId` y `consolidarLoteSheet` cierra al
 * final; hasta entonces los datos anteriores siguen intactos, que es lo que hace
 * que una corrida a medias no deje al cliente sin dato.
 */
export async function syncTabConversiones(
  supabase: any,
  clienteId: string,
  sheetCfg: ConversionesConfig,
  tabId: string,
  batchId: string
): Promise<TabSyncResult> {
  const sheetId = sheetCfg.id!;
  const tab = normalizeTabs(sheetCfg).find((t) => t.id === tabId);
  if (!tab) throw new Error(`La pestaña ${tabId} no está en la configuración del sheet`);
  if (tab.enabled === false) throw new Error(`La pestaña "${tab.sheet_name}" está deshabilitada`);

  // Se le pasa el sheet con esta única pestaña: `fetchConversionesFromSheet` abre
  // el documento y recorre las que reciba.
  const { rows, crudas, quality, tabsLeidas } = await fetchConversionesFromSheet({
    ...sheetCfg,
    tabs: [tab],
  });

  // Los agregados ya no salen de aquí: `consolidarLoteSheet` los recalcula desde
  // la base con todas las pestañas del sheet.
  //
  // Se poda por `tabsLeidas`, no por `tab.sheet_name`: cuando la config deja el
  // nombre vacío ("la primera pestaña"), el título real sólo se conoce tras
  // abrir el documento, y es ese el que quedó en `tab_name`.
  const guardado = await insertarLoteSheet(
    supabase,
    clienteId,
    sheetId,
    batchId,
    rows,
    crudas,
    tab.sheet_name,
    tabsLeidas
  );

  return {
    tab_id: tabId,
    tab_name: tab.sheet_name,
    rowsProcessed: guardado.rowsProcessed,
    rawProcessed: guardado.rawProcessed,
    rowsDescartadas: quality.reduce((s, q) => s + q.fecha_invalida + q.cantidad_invalida, 0),
    quality,
    ...(guardado.rawError ? { rawError: guardado.rawError } : {}),
  };
}

export interface SyncClienteConversionesOptions {
  /**
   * Sincroniza solo este sheet. Los demás quedan intactos: un documento grande
   * no cabe junto a los otros en el `maxDuration` de una función, así que la UI
   * los sincroniza de uno en uno.
   */
  sheetId?: string;
  /**
   * Recalcular los campos de Sheet al terminar (por defecto sí). El recálculo
   * recorre toda la capa cruda del cliente, así que quien sincroniza sheet a
   * sheet lo apaga y lo lanza una sola vez al final.
   */
  recalcularCampos?: boolean;
}

export async function syncClienteConversiones(
  supabase: any,
  clienteId: string,
  rawConfig: unknown,
  opts: SyncClienteConversionesOptions = {}
): Promise<{
  results: SheetSyncResult[];
  rows: ConversionRow[];
  campos?: { campos: number; dias: number; valores: number; avisos: string[]; error?: string };
  /** Filas retiradas de sheets que ya no están en la config, y lo que no se pudo retirar. */
  limpieza: { deleted: number; errors: string[] };
}> {
  const allSheets = normalizeSheetConfigs(rawConfig);
  const enabledSheets = allSheets.filter((s) => s.enabled && s.sheet_url);

  // La limpieza de huérfanos de abajo mira SIEMPRE `enabledSheets` (todos), no
  // esta lista: si no, sincronizar un sheet suelto borraría los datos del resto.
  const targetSheets = opts.sheetId
    ? enabledSheets.filter((s) => s.id === opts.sheetId)
    : enabledSheets;

  const results: SheetSyncResult[] = [];
  const allRows: ConversionRow[] = [];

  for (const sheetCfg of targetSheets) {
    const sheetId = sheetCfg.id!;
    const label = sheetCfg.name || sheetCfg.sheet_url;
    try {
      const { rows, crudas, quality, tabsLeidas, tabsVivas } =
        await fetchConversionesFromSheet(sheetCfg);
      // La poda de pestañas huérfanas va por `tabsVivas` y no por `tabsLeidas`:
      // una pestaña que existe pero falló al leerse no está en `tabsLeidas`, y
      // retirar «todo lo que no esté en la lista» se llevaría sus datos buenos.
      // `tabsVivas` sí la incluye, y es null si falta alguna.
      const saved = await saveConversionesSheetToDb(
        supabase,
        clienteId,
        sheetCfg,
        rows,
        crudas,
        tabsLeidas,
        tabsVivas
      );
      allRows.push(...rows);

      // La capa cruda es auxiliar: si falla, el sheet queda 'partial' con el
      // motivo, pero sus conversiones y agregados sí quedaron guardados.
      if (saved.rawError && quality.length > 0) {
        quality[0].warnings.push(`No se pudo guardar la capa cruda: ${saved.rawError}`);
      }

      const descartadas = quality.reduce((s, q) => s + q.fecha_invalida + q.cantidad_invalida, 0);
      const hasWarnings = quality.some((q) => q.warnings.length > 0);
      const status: SyncLogStatus = hasWarnings ? 'partial' : 'ok';
      await logSyncResult(supabase, clienteId, sheetId, status, quality);

      results.push({
        sheet_id: sheetId,
        name: label,
        success: true,
        rowsProcessed: saved.rowsProcessed,
        daysProcessed: saved.daysProcessed,
        rowsDescartadas: descartadas,
        rawProcessed: saved.rawProcessed,
        quality,
      });
    } catch (err: any) {
      await logSyncResult(supabase, clienteId, sheetId, 'error', [], err.message);
      results.push({
        sheet_id: sheetId,
        name: label,
        success: false,
        rowsProcessed: 0,
        daysProcessed: 0,
        rowsDescartadas: 0,
        rawProcessed: 0,
        quality: [],
        error: err.message,
      });
    }
  }

  // Los sheets retirados de la config (y los datos previos a la trazabilidad por
  // sheet) se limpian con la config ya leída correctamente. Se pasan TODOS los
  // sheets, no solo los habilitados: deshabilitar pausa el sync, no borra nada.
  const limpieza = await cleanupOrphanConversiones(
    supabase,
    clienteId,
    allSheets.map((s) => s.id!)
  );
  if (limpieza.errors.length > 0) {
    console.error('[conversiones] limpieza de huérfanos incompleta:', limpieza.errors.join(' | '));
  }

  // Los campos de Sheet se derivan de la capa cruda, así que se recalculan al
  // final, con `sheet_filas` ya reemplazada y sin los huérfanos.
  //
  // Un fallo aquí NO tumba el sync: las conversiones y la capa cruda ya están
  // guardadas y el recálculo se puede repetir solo, sin volver a Google. El
  // import es dinámico para no meter la capa de campos en el arranque de los
  // workers que solo sincronizan conversiones.
  let campos:
    { campos: number; dias: number; valores: number; avisos: string[]; error?: string } | undefined;
  if (opts.recalcularCampos === false) return { results, rows: allRows, campos, limpieza };
  try {
    const { recalcularCamposCliente } = await import('../sheets/campos-db');
    campos = await recalcularCamposCliente(supabase, clienteId);
    if (campos.error) console.error(`[conversiones] recálculo de campos: ${campos.error}`);
  } catch (err: unknown) {
    const motivo = err instanceof Error ? err.message : 'Error al recalcular los campos';
    console.error('[conversiones] no se pudieron recalcular los campos de Sheet:', motivo);
    campos = { campos: 0, dias: 0, valores: 0, avisos: [], error: motivo };
  }

  return { results, rows: allRows, campos, limpieza };
}
