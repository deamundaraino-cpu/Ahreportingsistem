import { randomUUID } from 'crypto'
import { GoogleSpreadsheet } from 'google-spreadsheet'
import type { GoogleSpreadsheetWorksheet } from 'google-spreadsheet'
import { JWT, OAuth2Client } from 'google-auth-library'
import { hasAgencyGoogleConnection, getAgencyAccessToken } from './google-auth'
import { sanitizarColumna, parseNumeroSheet } from '../sheets/campos'
import type { SheetRawRow } from '../sheets/campos'

// La capa cruda del sync es la entrada del motor de campos: el tipo vive allí,
// que es client-safe, y se reexporta para no romper a quien ya lo importa desde
// esta librería.
export type { SheetRawRow }

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type CustomColumnType = 'count' | 'currency' | 'percentage' | 'date' | 'text'

/** Qué columnas de una pestaña se guardan en crudo en `sheet_filas`. */
export type SheetRawMode = 'all' | 'declared' | 'none'

export interface CustomColumnDef {
  col_name: string          // nombre exacto en el Sheet (ej: "Citas Agendadas")
  type: CustomColumnType
  label: string             // nombre para el dashboard
  include: boolean          // si false, se ignora en el sync
  sample_values?: string[]  // solo durante detección, no se persiste
}

/**
 * Config de UNA pestaña dentro de un spreadsheet. Cada pestaña tiene su propio
 * mapeo de columnas: dos pestañas del mismo doc pueden llamar distinto a la
 * columna de fecha o exponer columnas adicionales diferentes.
 */
export interface SheetTabConfig {
  /** UUID para identificar la pestaña en la UI (no es el ID de Google). */
  id: string
  /** Título exacto de la pestaña. Vacío = primera pestaña del doc. */
  sheet_name: string
  enabled: boolean
  col_fecha?: string
  col_tipo?: string
  col_cantidad?: string
  col_valor?: string
  col_fuente?: string
  col_notas?: string
  /**
   * Cada fila vale UNA conversión. Para hojas donde una fila = un lead/venta
   * (exports de formularios de Meta, listados de WhatsApp…), que no tienen
   * columna de cantidad: sin esto todas sus filas se descartaban por cantidad 0.
   */
  count_rows?: boolean
  /**
   * Valor fijo de `tipo` cuando la pestaña no tiene columna de tipo. Sin él, las
   * filas entran como 'otro' y no suman en `offline_leads` / `offline_ventas`.
   */
  tipo_fijo?: string
  /** Columnas adicionales de ESTA pestaña definidas por el analista. */
  custom_columns?: Record<string, CustomColumnDef>
  /**
   * Qué se guarda en `sheet_filas` (la capa cruda sobre la que se definen los
   * campos de Sheet):
   *   'all'      → todas las columnas de la pestaña (por defecto)
   *   'declared' → solo las declaradas en `custom_columns` con include
   *   'none'     → nada; la pestaña solo alimenta conversiones_offline
   */
  raw_mode?: SheetRawMode
  /**
   * Columnas sanitizadas que NUNCA se guardan en crudo. `detectSheetColumns`
   * las propone con una heurística de PII / alta cardinalidad (email, teléfono,
   * documento…) y el analista confirma.
   */
  raw_exclude?: string[]
}

export interface ConversionesConfig {
  /** UUID que identifica esta config de sheet dentro del array del cliente. */
  id?: string
  /** Nombre visible en la UI (ej: "Leads WhatsApp"). */
  name?: string
  enabled: boolean
  sheet_url: string
  /**
   * Pestañas a sincronizar de este documento. Formato actual: la UI escribe
   * siempre `tabs`. Las configs anteriores (una sola pestaña con los campos
   * planos de abajo) se convierten al vuelo en `normalizeTabs`.
   */
  tabs?: SheetTabConfig[]
  // ── Campos legacy (una sola pestaña, mapeo a nivel de sheet) ──────────────
  sheet_name?: string
  col_fecha?: string
  col_tipo?: string
  col_cantidad?: string
  col_valor?: string
  col_fuente?: string
  col_notas?: string
  custom_columns?: Record<string, CustomColumnDef>
  client_email?: string
  private_key?: string
}

/** Un archivo de Google Drive tipo Spreadsheet. */
export interface DriveSheet {
  id: string
  name: string
  url: string
  modifiedTime: string
}

/** Una pestaña real del documento, tal como la reporta Google. */
export interface SheetTabInfo {
  title: string
  index: number
  rowCount: number
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
        : []

  // El id es la clave de partición en la base (sheet_id): una config sin id
  // guardada antes de esta versión recibe uno derivado de su posición.
  return list.map((cfg, i) => ({ ...cfg, id: cfg.id || `sheet_${i}`, tabs: normalizeTabs(cfg) }))
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
    }))
  }
  return [{
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
  }]
}

/** Une las columnas adicionales de todas las pestañas de un sheet. */
export function mergeTabCustomColumns(tabs: SheetTabConfig[]): Record<string, CustomColumnDef> {
  const merged: Record<string, CustomColumnDef> = {}
  for (const tab of tabs) {
    if (tab.custom_columns) Object.assign(merged, tab.custom_columns)
  }
  return merged
}

export interface ConversionRow {
  fecha: string
  tipo: string
  cantidad: number
  valor: number | null
  fuente: string
  notas: string
  custom_fields: Record<string, any>
  /** Config de sheet de la que proviene la fila (para el replace por sheet). */
  sheet_id: string
  /** Pestaña concreta de la que proviene la fila. */
  tab_name: string
}

export interface ConversionDiaria {
  fecha: string
  tipo: string
  fuente: string
  total_cantidad: number
  total_valor: number
  custom_fields: Record<string, number>
}

export interface DetectedColumn {
  col_name: string
  sanitized_name: string
  proposed_type: CustomColumnType
  label: string
  sample_values: string[]
  /**
   * La columna parece PII o de alta cardinalidad (un valor distinto por fila).
   * La UI la propone marcada para `raw_exclude`: guardarla en crudo abulta la
   * tabla sin servir como dimensión.
   */
  sensible: boolean
}

/** Resultado de leer UNA pestaña: cuántas filas entraron y cuáles se descartaron. */
export interface TabSyncQuality {
  tab_name: string
  rows_ok: number
  fecha_invalida: number
  cantidad_invalida: number
  /**
   * Filas que no entran como conversión (cantidad <= 0) pero sí se guardan en
   * crudo. Antes desaparecían del todo; ahora siguen disponibles para los
   * campos de Sheet, y el número lo hace visible en el log de sync.
   */
  solo_crudas?: number
  /** Columnas guardadas en crudo para esta pestaña. */
  columnas_crudas?: number
  warnings: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractSheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

async function createAuthClient(clientEmail?: string, clientKey?: string): Promise<JWT | OAuth2Client> {
  if (await hasAgencyGoogleConnection()) return await getAgencyAccessToken()
  const email = clientEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key = (clientKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY)?.replace(/\\n/g, '\n')
  if (!email || !key) throw new Error('Google service account credentials not configured')
  return new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] })
}

/** Abre el documento una sola vez (loadInfo trae ya todas las pestañas). */
async function loadDoc(config: ConversionesConfig): Promise<GoogleSpreadsheet> {
  const sheetId = extractSheetId(config.sheet_url)
  if (!sheetId) throw new Error(`URL de Google Sheets inválida: ${config.sheet_url}`)
  const auth = await createAuthClient(config.client_email, config.private_key)
  const doc = new GoogleSpreadsheet(sheetId, auth)
  await doc.loadInfo()
  return doc
}

/** Resuelve la pestaña por título; vacío = la primera del documento. */
function resolveTab(doc: GoogleSpreadsheet, tabName: string): GoogleSpreadsheetWorksheet {
  const name = tabName?.trim()
  if (!name) return doc.sheetsByIndex[0]
  const sheet = doc.sheetsByTitle[name]
  if (!sheet) {
    const available = Object.keys(doc.sheetsByTitle).join(', ')
    throw new Error(`Pestaña "${name}" no encontrada. Disponibles: ${available}`)
  }
  return sheet
}

/** Alias del sanitizador compartido con el motor de campos (`lib/sheets/campos`). */
export function sanitizeColName(name: string): string {
  return sanitizarColumna(name)
}

function inferType(name: string, samples: string[]): CustomColumnType {
  const n = name.toLowerCase()
  if (/tasa|rate|pct|porcentaje|ratio|conversion|efectividad|%/.test(n)) return 'percentage'
  if (/valor|revenue|precio|costo|cost|spend|inversion|ingreso|factur|usd|cop|eur|\$|monto/.test(n)) return 'currency'
  if (/fecha|date|dia|mes|semana|periodo/.test(n)) return 'date'
  // Si la mayoría de muestras no son numéricas → texto
  const numericCount = samples.filter(v => {
    const cleaned = v.replace(/[^0-9.,-]/g, '')
    return cleaned.length > 0 && !isNaN(parseFloat(cleaned))
  }).length
  if (samples.length > 0 && numericCount < samples.length * 0.5) return 'text'
  return 'count'
}

/**
 * Columnas que no conviene guardar en crudo: datos personales y campos con un
 * valor distinto por fila (id, email, teléfono). No sirven como dimensión y son
 * las que más abultan `sheet_filas`. Es una sugerencia: la UI las propone
 * marcadas en `raw_exclude` y el analista puede desmarcarlas.
 */
export function esColumnaSensible(name: string): boolean {
  const n = sanitizeColName(name)
  return /(^|_)(id|ids)$/.test(n) ||
    /email|correo|telefono|phone|whatsapp|celular|movil|nombre|apellido|documento|cedula|dni|nit|pasaporte|direccion|address/.test(n)
}

/**
 * ¿Es una fecha que existe en el calendario? "2026-02-31" tiene forma válida pero
 * no existe, y Postgres rechaza la sentencia entera al insertarla.
 */
function fechaExiste(iso: string): boolean {
  const [a, m, d] = iso.split('-').map(Number)
  if (!a || !m || !d) return false
  const dt = new Date(Date.UTC(a, m - 1, d))
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
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
 */
function parseDate(raw: string): string {
  if (!raw) return ''
  const t = raw.trim()
  // Acepta fecha sola, ISO con T y "YYYY-MM-DD HH:MM:SS" (separador espacio, el
  // que usan los exports de formularios de Meta). Antes solo se cortaba por la
  // T, así que la variante con espacio se descartaba como fecha inválida.
  let iso = ''
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    iso = t.slice(0, 10)
  } else {
    const dmy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
    if (dmy) {
      iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
      // Con día ≤ 12 la fecha es ambigua (dd/mm vs mm/dd). Si leerla como dd/mm no
      // da un día real, se prueba mm/dd antes de descartarla.
      if (!fechaExiste(iso)) {
        const alt = `${dmy[3]}-${dmy[1].padStart(2, '0')}-${dmy[2].padStart(2, '0')}`
        iso = fechaExiste(alt) ? alt : iso
      }
    } else {
      const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
      if (mdy) iso = `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`
    }
  }

  return iso && fechaExiste(iso) ? iso : ''
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
  return parseNumeroSheet(raw) ?? 0
}

/** Nombres de columna estándar de una pestaña (con sus valores por defecto). */
function standardColNames(tab: SheetTabConfig) {
  return {
    colFecha:    tab.col_fecha    || 'fecha',
    colTipo:     tab.col_tipo     || 'tipo',
    colCantidad: tab.col_cantidad || 'cantidad',
    colValor:    tab.col_valor    || 'valor',
    colFuente:   tab.col_fuente   || 'fuente',
    colNotas:    tab.col_notas    || 'notas',
  }
}

/** Nombres que una columna de fecha suele llevar, en orden de preferencia. */
const ALIAS_FECHA = ['fecha', 'date', 'created_time', 'fecha_hora', 'día', 'dia']

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
  const configurada = (tab.col_fecha ?? '').trim()
  if (configurada) return { col: configurada, auto: false }

  const norm = headers.map(h => h.toLowerCase().trim())
  for (const alias of ALIAS_FECHA) {
    const i = norm.indexOf(alias)
    if (i >= 0) return { col: headers[i], auto: false }
  }
  const i = norm.findIndex(h => /fecha|date/.test(h))
  if (i >= 0) return { col: headers[i], auto: true }

  // Ninguna candidata: se devuelve el valor por defecto para que el llamador
  // lance el error de siempre, con su lista de columnas disponibles.
  return { col: 'fecha', auto: false }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Lista las pestañas reales del documento, para que la UI ofrezca elegirlas en
 * vez de teclear el nombre a mano.
 */
export async function listSheetTabs(config: ConversionesConfig): Promise<SheetTabInfo[]> {
  const doc = await loadDoc(config)
  return doc.sheetsByIndex.map((s, index) => ({
    title: s.title,
    index,
    rowCount: s.rowCount ?? 0,
  }))
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
  const target = tab ?? normalizeTabs(config)[0]
  const doc = await loadDoc(config)
  const sheet = resolveTab(doc, target.sheet_name)

  const rows = await sheet.getRows({ limit: 6 })
  const headers = sheet.headerValues ?? []

  const std = standardColNames(target)
  // La de fecha se resuelve contra las cabeceras reales, igual que en el parser:
  // si no, una columna auto-detectada («FECHA DE AGENDA») se ofrecería aquí como
  // columna extra a la vez que el sync la usa de eje temporal.
  std.colFecha = resolveColFecha(target, headers).col
  const standardCols = new Set(Object.values(std).map(c => c.toLowerCase().trim()))
  const extraHeaders = headers.filter(h => !standardCols.has(h.toLowerCase().trim()))

  const columns = extraHeaders.map(col => {
    const samples = rows
      .map(r => (r.get(col) || '').toString().trim())
      .filter(Boolean)
      .slice(0, 5)

    const sanitized = sanitizeColName(col)
    const existing = target.custom_columns?.[sanitized]

    return {
      col_name:       col,
      sanitized_name: sanitized,
      proposed_type:  existing?.type ?? inferType(col, samples),
      label:          existing?.label ?? col,
      sample_values:  samples,
      sensible:       esColumnaSensible(col),
    }
  })

  return { headers, columns }
}

/** Fila del Sheet, reducida a lo que necesita el parser (facilita probarlo). */
export interface SheetRowLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(column: string): any
}

/** Lo que produce una pestaña: conversiones, filas crudas y reporte de calidad. */
export interface TabPayload {
  conversiones: ConversionRow[]
  crudas: SheetRawRow[]
  quality: TabSyncQuality
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
  const mode: SheetRawMode = tab.raw_mode ?? 'all'
  if (mode === 'none') return []

  const exclude = new Set((tab.raw_exclude ?? []).map(sanitizeColName))

  const candidatas = mode === 'declared'
    ? Object.entries(tab.custom_columns ?? {})
        .filter(([, def]) => def.include)
        .map(([sanitized, def]) => ({ header: def.col_name, sanitized }))
    : headers.map(h => ({ header: h, sanitized: sanitizeColName(h) }))

  const vistas = new Set<string>()
  const out: Array<{ header: string; sanitized: string }> = []
  for (const c of candidatas) {
    if (!c.sanitized || exclude.has(c.sanitized) || vistas.has(c.sanitized)) continue
    vistas.add(c.sanitized)
    out.push(c)
  }
  return out
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
    cantidad_invalida: 0,
    solo_crudas: 0,
    columnas_crudas: 0,
    warnings: [],
  }

  const { colTipo, colCantidad, colValor, colFuente, colNotas } = standardColNames(tab)
  const { col: colFecha, auto: fechaAdivinada } = resolveColFecha(tab, headers)

  const headersLower = headers.map(h => h.toLowerCase().trim())
  if (!headersLower.includes(colFecha.toLowerCase().trim())) {
    throw new Error(`Columna de fecha "${colFecha}" no encontrada. Disponibles: ${headers.join(', ')}`)
  }
  if (fechaAdivinada) {
    quality.warnings.push(
      `Sin columna de fecha configurada: se está usando "${colFecha}". ` +
      `Confírmala en Ajustes del cliente → Google Sheets si no es el eje temporal que quieres.`
    )
  }
  // Un nombre de columna mal escrito se leía como vacío sin aviso: ahora queda
  // registrado en el reporte de calidad del sync. Las columnas resueltas por
  // configuración (cantidad con `count_rows`, tipo con `tipo_fijo`) no se avisan.
  const opcionales: Record<string, string> = { valor: colValor, fuente: colFuente, notas: colNotas }
  if (!tab.count_rows) opcionales.cantidad = colCantidad
  if (!tab.tipo_fijo)  opcionales.tipo = colTipo
  for (const [label, col] of Object.entries(opcionales)) {
    if (!headersLower.includes(col.toLowerCase().trim())) {
      quality.warnings.push(`Columna de ${label} "${col}" no existe en la pestaña`)
    }
  }

  const standardCols = new Set(
    [colFecha, colTipo, colCantidad, colValor, colFuente, colNotas].map(c => c.toLowerCase().trim())
  )

  // Columnas extra: las configuradas con include:true, o todas las detectadas
  // si la pestaña aún no tiene configuración (comportamiento legacy).
  const customCols = tab.custom_columns
  let extraColsToProcess: Array<{ header: string; sanitized: string; type: CustomColumnType }>

  if (customCols && Object.keys(customCols).length > 0) {
    extraColsToProcess = Object.entries(customCols)
      .filter(([, def]) => def.include)
      .map(([sanitized, def]) => ({ header: def.col_name, sanitized, type: def.type }))
    for (const col of extraColsToProcess) {
      if (!headersLower.includes(col.header.toLowerCase().trim())) {
        quality.warnings.push(`Columna adicional "${col.header}" no existe en la pestaña`)
      }
    }
  } else {
    extraColsToProcess = headers
      .filter(h => !standardCols.has(h.toLowerCase().trim()))
      .map(h => ({ header: h, sanitized: sanitizeColName(h), type: 'count' as CustomColumnType }))
  }

  // Capa cruda: independiente del mapeo estándar, incluye también las columnas
  // de fecha/tipo/cantidad… porque un campo de Sheet puede apuntar a cualquiera.
  const rawCols = rawColsForTab(headers, tab)
  quality.columnas_crudas = rawCols.length

  const conversiones: ConversionRow[] = []
  const crudas: SheetRawRow[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const fecha = parseDate((row.get(colFecha) || '').toString())
    if (!fecha || fecha.length !== 10) {
      // Fila totalmente vacía (relleno del Sheet): no es un error de datos.
      const isBlank = headers.every(h => !(row.get(h) || '').toString().trim())
      if (!isBlank) quality.fecha_invalida++
      continue
    }

    if (rawCols.length > 0) {
      const valores: Record<string, string> = {}
      for (const col of rawCols) {
        const raw = (row.get(col.header) ?? '').toString().trim()
        if (raw) valores[col.sanitized] = raw
      }
      crudas.push({ sheet_id: sheetId, tab_name: tabTitle, fecha, fila_num: i + 1, valores })
    }

    const rawTipo  = (row.get(colTipo) ?? '').toString().trim()
    const tipo     = (rawTipo || tab.tipo_fijo || 'otro').toLowerCase()
    // En modo "una fila = una conversión" la columna de cantidad no se lee.
    const cantidad = tab.count_rows ? 1 : toNumber((row.get(colCantidad) || '0').toString())
    const rawValor = (row.get(colValor) || '').toString()
    const valor    = rawValor.trim() ? toNumber(rawValor) : null
    const fuente   = (row.get(colFuente) || '').toString().trim()
    const notas    = (row.get(colNotas)  || '').toString().trim()

    // No es conversión, pero su fila cruda ya quedó guardada arriba: sigue
    // sirviendo para los campos de Sheet.
    if (cantidad <= 0) { quality.cantidad_invalida++; quality.solo_crudas!++; continue }

    const custom_fields: Record<string, any> = {}
    for (const col of extraColsToProcess) {
      const raw = (row.get(col.header) || '').toString().trim()
      if (!raw) continue
      if (col.type === 'count' || col.type === 'currency' || col.type === 'percentage') {
        const n = toNumber(raw)
        if (!isNaN(n)) custom_fields[col.sanitized] = n
      } else {
        custom_fields[col.sanitized] = raw
      }
    }

    conversiones.push({
      fecha, tipo, cantidad, valor, fuente, notas, custom_fields,
      sheet_id: sheetId, tab_name: tabTitle,
    })
  }

  quality.rows_ok = conversiones.length
  // Los descartes se explican con la columna concreta: un "0 filas importadas"
  // sin motivo obliga a adivinar si falla la fecha, la cantidad o el mapeo.
  if (quality.fecha_invalida > 0) {
    quality.warnings.push(`${quality.fecha_invalida} filas sin fecha válida en "${colFecha}"`)
  }
  if (quality.cantidad_invalida > 0) {
    quality.warnings.push(
      `${quality.cantidad_invalida} filas con cantidad 0 o vacía en "${colCantidad}"` +
      ' — si el Sheet trae una conversión por fila, activa "Cada fila es una conversión"'
    )
  }
  return { conversiones, crudas, quality }
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
  const { conversiones, quality } = parseTabPayload(headers, rows, tab, sheetId, tabTitle)
  return { rows: conversiones, quality }
}

/** Lee una pestaña ya resuelta del documento y la parsea. */
async function parseTabRows(
  sheet: GoogleSpreadsheetWorksheet,
  tab: SheetTabConfig,
  sheetId: string
): Promise<TabPayload> {
  const rows = await sheet.getRows()
  return parseTabPayload(sheet.headerValues ?? [], rows, tab, sheetId, sheet.title)
}

/**
 * Lee todas las pestañas habilitadas de un documento. El doc se carga una sola
 * vez y cada pestaña aplica su propio mapeo de columnas.
 *
 * Una pestaña que falla (no existe, sin columna de fecha) queda como warning y
 * no impide sincronizar las demás; si fallan TODAS se lanza el error para que
 * el sheet se marque como fallido y sus datos anteriores se conserven.
 */
export async function fetchConversionesFromSheet(
  config: ConversionesConfig
): Promise<{ rows: ConversionRow[]; crudas: SheetRawRow[]; quality: TabSyncQuality[] }> {
  const sheetId = config.id || 'sheet_0'
  const tabs = normalizeTabs(config).filter(t => t.enabled)
  if (tabs.length === 0) return { rows: [], crudas: [], quality: [] }

  const doc = await loadDoc(config)

  const allRows: ConversionRow[] = []
  const allCrudas: SheetRawRow[] = []
  const quality: TabSyncQuality[] = []
  let failed = 0

  for (const tab of tabs) {
    try {
      const sheet = resolveTab(doc, tab.sheet_name)
      const res = await parseTabRows(sheet, tab, sheetId)
      allRows.push(...res.conversiones)
      allCrudas.push(...res.crudas)
      quality.push(res.quality)
    } catch (err: any) {
      failed++
      quality.push({
        tab_name: tab.sheet_name || '(primera pestaña)',
        rows_ok: 0, fecha_invalida: 0, cantidad_invalida: 0,
        warnings: [err.message || 'Error leyendo la pestaña'],
      })
    }
  }

  if (failed === tabs.length) {
    throw new Error(quality.map(q => `${q.tab_name}: ${q.warnings.join('; ')}`).join(' | '))
  }

  return { rows: allRows, crudas: allCrudas, quality }
}

/**
 * Agrupa por fecha+tipo+fuente.
 * - count / currency → suma
 * - percentage → promedio ponderado por cantidad de la fila
 */
export function computeConversionesAggregates(
  rows: ConversionRow[],
  customColumnsConfig?: Record<string, CustomColumnDef>
): ConversionDiaria[] {
  const map = new Map<string, ConversionDiaria & { _pct_sums: Record<string, { total: number; weight: number }> }>()

  for (const row of rows) {
    const key = `${row.fecha}|${row.tipo}|${row.fuente}`
    let entry = map.get(key)

    if (!entry) {
      entry = {
        fecha: row.fecha, tipo: row.tipo, fuente: row.fuente,
        total_cantidad: 0, total_valor: 0,
        custom_fields: {}, _pct_sums: {},
      }
      map.set(key, entry)
    }

    entry.total_cantidad += row.cantidad
    entry.total_valor    += row.valor ?? 0

    for (const [k, v] of Object.entries(row.custom_fields)) {
      const colType = customColumnsConfig?.[k]?.type ?? 'count'
      if (colType === 'text' || colType === 'date') continue

      if (colType === 'percentage') {
        // Promedio ponderado: cada fila contribuye val*cantidad
        if (!entry._pct_sums[k]) entry._pct_sums[k] = { total: 0, weight: 0 }
        entry._pct_sums[k].total  += (v as number) * row.cantidad
        entry._pct_sums[k].weight += row.cantidad
      } else {
        // count / currency → suma directa
        entry.custom_fields[k] = (entry.custom_fields[k] ?? 0) + (v as number)
      }
    }
  }

  // Resolver porcentajes ponderados
  return Array.from(map.values()).map(({ _pct_sums, ...entry }) => {
    for (const [k, { total, weight }] of Object.entries(_pct_sums)) {
      entry.custom_fields[k] = weight > 0 ? total / weight : 0
    }
    return entry
  })
}

/**
 * Lista los Google Sheets (spreadsheets) accesibles para la cuenta OAuth de la agencia.
 * Usa la API REST de Drive v3 con el access_token del OAuth.
 */
export async function listGoogleSheets(): Promise<DriveSheet[]> {
  const client = await getAgencyAccessToken()
  const { token } = await client.getAccessToken()
  if (!token) throw new Error('No se pudo obtener el access token de la cuenta de la agencia')

  const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false")
  const fields = encodeURIComponent('files(id,name,webViewLink,modifiedTime)')
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=modifiedTime+desc&pageSize=50`

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).error?.message || `Drive API error: ${res.status}`)
  }

  const data = await res.json() as { files?: any[] }
  return (data.files || []).map((f: any) => ({
    id: f.id as string,
    name: f.name as string,
    url: f.webViewLink as string,
    modifiedTime: f.modifiedTime as string,
  }))
}

/**
 * Reemplazo completo de UN sheet del cliente, en orden seguro.
 *
 * Se inserta primero el lote nuevo con un `sync_batch_id` y solo al terminar se
 * borran las filas de lotes anteriores DE ESE MISMO SHEET. Antes el borrado era
 * por cliente: en un sync multi-sheet, si un sheet fallaba, el replace con las
 * filas de los que sí funcionaron borraba silenciosamente sus datos.
 */
export async function saveConversionesSheetToDb(
  supabase: any,
  clienteId: string,
  sheetId: string,
  rows: ConversionRow[],
  aggregates: ConversionDiaria[],
  crudas: SheetRawRow[] = []
): Promise<{ rowsProcessed: number; daysProcessed: number; rawProcessed: number; rawError?: string }> {
  const batchId = randomUUID()

  /**
   * Deshace el lote a medias para no dejar duplicados junto a los datos viejos.
   *
   * NO toca `conversiones_offline_diarias` a propósito. Esa tabla se escribe con
   * upsert, así que una fila sobrescrita ya lleva el `sync_batch_id` nuevo:
   * borrarla por lote se llevaría por delante el agregado anterior, que era dato
   * bueno. Y no hace falta — cada fila es el agregado COMPLETO de su
   * (sheet, día, tipo, fuente), no una suma parcial, así que una mezcla de dos
   * ejecuciones sigue siendo coherente; a lo sumo queda algún día desactualizado
   * hasta el siguiente sync.
   */
  const rollback = async () => {
    for (const t of ['conversiones_offline', 'sheet_filas']) {
      await supabase.from(t).delete().eq('sync_batch_id', batchId)
    }
  }

  if (rows.length > 0) {
    const toInsert = rows.map(r => ({
      cliente_id: clienteId, fecha: r.fecha, tipo: r.tipo,
      cantidad: r.cantidad, valor: r.valor, fuente: r.fuente, notas: r.notas,
      custom_fields: r.custom_fields, sync_batch_id: batchId,
      sheet_id: sheetId, tab_name: r.tab_name,
    }))
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from('conversiones_offline').insert(toInsert.slice(i, i + 500))
      if (error) {
        await rollback()
        throw new Error(`Error insertando conversiones: ${error.message}`)
      }
    }
  }

  if (aggregates.length > 0) {
    const toInsert = aggregates.map(a => ({
      cliente_id: clienteId, fecha: a.fecha, tipo: a.tipo, fuente: a.fuente,
      total_cantidad: a.total_cantidad, total_valor: a.total_valor,
      custom_fields: a.custom_fields, sync_batch_id: batchId, sheet_id: sheetId,
    }))
    // UPSERT, no insert: `uq_conv_diarias_origen` es único por
    // (cliente_id, sheet_id, fecha, tipo, fuente) y el lote anterior sigue en la
    // tabla hasta el replace de abajo, así que un insert chocaba con él a partir
    // del segundo sync de cada sheet ("Error insertando agregados").
    //
    // El upsert es además lo correcto semánticamente: el agregado de un
    // (sheet, día, tipo, fuente) es único por definición. Al sobrescribirlo se
    // actualiza también su `sync_batch_id`, de modo que el borrado posterior
    // sigue retirando solo las filas que este sync ya no produce.
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from('conversiones_offline_diarias')
        .upsert(toInsert.slice(i, i + 500), { onConflict: 'cliente_id,sheet_id,fecha,tipo,fuente' })
      if (error) {
        await rollback()
        throw new Error(`Error insertando agregados: ${error.message}`)
      }
    }
  }

  // Capa cruda: mismo lote que las conversiones, para que el replace de abajo
  // deje las tres tablas en el mismo estado.
  //
  // Un fallo aquí NO tumba el sheet: la capa cruda alimenta los campos de Sheet,
  // pero las conversiones y sus agregados ya están guardados y son lo que ven
  // hoy dashboards e informes. Si falla (p. ej. la migración 057 todavía no está
  // aplicada), se retira solo el lote crudo a medias y se dejan intactas las
  // filas crudas anteriores — mejor una capa cruda desactualizada que ninguna.
  let rawOk = true
  let rawError: string | null = null

  if (crudas.length > 0) {
    const toInsert = crudas.map(r => ({
      cliente_id: clienteId, sheet_id: sheetId, tab_name: r.tab_name,
      fecha: r.fecha, fila_num: r.fila_num, valores: r.valores,
      sync_batch_id: batchId,
    }))
    for (let i = 0; i < toInsert.length && rawOk; i += 500) {
      const { error } = await supabase.from('sheet_filas').insert(toInsert.slice(i, i + 500))
      if (error) {
        rawOk = false
        rawError = error.message
        await supabase.from('sheet_filas').delete().eq('sync_batch_id', batchId)
        console.error(`[conversiones] sheet ${sheetId}: no se pudo guardar la capa cruda:`, error.message)
      }
    }
  }

  // El lote nuevo está completo: recién ahora se retira el anterior de este sheet.
  const aReemplazar = ['conversiones_offline', 'conversiones_offline_diarias']
  if (rawOk) aReemplazar.push('sheet_filas')
  const replaceErrors: string[] = []
  for (const t of aReemplazar) {
    const err = await borrarLotesAnteriores(supabase, t, clienteId, sheetId, batchId)
    if (err) {
      replaceErrors.push(`${t}: ${err}`)
      console.error(`[conversiones] sheet ${sheetId}: no se pudo retirar el lote anterior de ${t}:`, err)
    }
  }

  // Un replace fallido deja una copia entera del sheet conviviendo con la nueva.
  // Se propaga como `rawError` (lo único que llega al log de sync) porque durante
  // meses este fallo fue invisible: el error del delete se descartaba y el sync
  // reportaba éxito mientras `sheet_filas` acumulaba un duplicado por ejecución.
  const replaceError = replaceErrors.length > 0
    ? `No se retiraron lotes anteriores — hay filas duplicadas en ${replaceErrors.join('; ')}`
    : null

  return {
    rowsProcessed: rows.length,
    daysProcessed: aggregates.length,
    rawProcessed: rawOk ? crudas.length : 0,
    ...(rawError || replaceError
      ? { rawError: [rawError, replaceError].filter(Boolean).join(' | ') }
      : {}),
  }
}

/**
 * Retira los lotes anteriores de un sheet, uno por `sync_batch_id`.
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
  const MAX_LOTES = 50
  for (let i = 0; i < MAX_LOTES; i++) {
    const { data, error } = await supabase.from(tabla)
      .select('sync_batch_id')
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheetId)
      .neq('sync_batch_id', batchId)
      .limit(1)
    if (error) return error.message
    if (!data || data.length === 0) return null

    const lote = data[0].sync_batch_id
    const { error: delError } = await supabase.from(tabla)
      .delete().eq('cliente_id', clienteId).eq('sheet_id', sheetId).eq('sync_batch_id', lote)
    if (delError) return delError.message
  }
  return `quedan lotes sin retirar tras ${MAX_LOTES} intentos`
}

/**
 * Borra las filas que ya no pertenecen a ningún sheet configurado: las de un
 * sheet eliminado de la config y las anteriores a la trazabilidad por sheet
 * (sheet_id NULL). Debe llamarse DESPUÉS de los saves — si no, borraría los
 * datos legacy antes de que el sync los repueble.
 */
export async function cleanupOrphanConversiones(
  supabase: any,
  clienteId: string,
  validSheetIds: string[]
): Promise<number> {
  let deleted = 0

  // Lista para el filtro `not.in` de PostgREST. Se hace por negación en vez de
  // listar primero los sheet_id existentes: aquel `select ... limit(5000)`
  // dejaba de ver los sheets huérfanos en clientes con muchas filas, y
  // `sheet_filas` es bastante más grande que las otras dos.
  const validList = validSheetIds.length > 0
    ? `(${validSheetIds.map(id => `"${String(id).replace(/"/g, '""')}"`).join(',')})`
    : null

  for (const table of ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas']) {
    // Filas anteriores a la trazabilidad por sheet. Van aparte porque en SQL
    // `NULL NOT IN (...)` no es verdadero y el filtro de abajo no las alcanza.
    const { error: nullErr, count } = await supabase.from(table)
      .delete({ count: 'exact' }).eq('cliente_id', clienteId).is('sheet_id', null)
    if (!nullErr) deleted += count ?? 0

    let q = supabase.from(table)
      .delete({ count: 'exact' }).eq('cliente_id', clienteId).not('sheet_id', 'is', null)
    if (validList) q = q.not('sheet_id', 'in', validList)

    const { error, count: c } = await q
    if (!error) deleted += c ?? 0
  }

  return deleted
}

export type SyncLogStatus = 'ok' | 'partial' | 'error'

/** Fila del log tal como la devuelve el endpoint de estado (para la UI). */
export interface SheetSyncStatus {
  sheet_id: string
  run_at: string
  status: SyncLogStatus
  rows_ok: number
  rows_descartadas: number
  detalle: { por_pestana?: TabSyncQuality[]; error?: string }
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
    const rowsOk = quality.reduce((s, q) => s + q.rows_ok, 0)
    const descartadas = quality.reduce((s, q) => s + q.fecha_invalida + q.cantidad_invalida, 0)

    await supabase.from('conversiones_offline_sync_log').insert({
      cliente_id: clienteId,
      sheet_id: sheetId,
      status,
      rows_ok: rowsOk,
      rows_descartadas: descartadas,
      detalle: { por_pestana: quality, ...(errorMessage ? { error: errorMessage } : {}) },
    })

    // Retención: solo los 20 registros más recientes por (cliente, sheet).
    const { data: old } = await supabase.from('conversiones_offline_sync_log')
      .select('id').eq('cliente_id', clienteId).eq('sheet_id', sheetId)
      .order('run_at', { ascending: false }).range(20, 999)
    const ids = ((old ?? []) as { id: string }[]).map(r => r.id)
    if (ids.length > 0) {
      await supabase.from('conversiones_offline_sync_log').delete().in('id', ids)
    }
  } catch (err) {
    console.error('[conversiones] no se pudo registrar el log de sync:', err)
  }
}

/**
 * Sincroniza TODOS los sheets habilitados de un cliente: fetch por sheet,
 * agregados por sheet, replace por sheet y log de calidad. Un sheet que falla no
 * afecta a los demás ni borra sus datos.
 */
export interface SheetSyncResult {
  sheet_id: string
  name: string
  success: boolean
  rowsProcessed: number
  daysProcessed: number
  rowsDescartadas: number
  /** Filas guardadas en crudo en `sheet_filas` (base de los campos de Sheet). */
  rawProcessed: number
  quality: TabSyncQuality[]
  error?: string
}

export async function syncClienteConversiones(
  supabase: any,
  clienteId: string,
  rawConfig: unknown
): Promise<{
  results: SheetSyncResult[]
  rows: ConversionRow[]
  campos?: { campos: number; dias: number; valores: number; avisos: string[]; error?: string }
}> {
  const allSheets = normalizeSheetConfigs(rawConfig)
  const enabledSheets = allSheets.filter(s => s.enabled && s.sheet_url)

  const results: SheetSyncResult[] = []
  const allRows: ConversionRow[] = []

  for (const sheetCfg of enabledSheets) {
    const sheetId = sheetCfg.id!
    const label = sheetCfg.name || sheetCfg.sheet_url
    try {
      const { rows, crudas, quality } = await fetchConversionesFromSheet(sheetCfg)
      const customCols = mergeTabCustomColumns(normalizeTabs(sheetCfg))
      const aggregates = computeConversionesAggregates(
        rows,
        Object.keys(customCols).length > 0 ? customCols : undefined
      )
      const saved = await saveConversionesSheetToDb(supabase, clienteId, sheetId, rows, aggregates, crudas)
      allRows.push(...rows)

      // La capa cruda es auxiliar: si falla, el sheet queda 'partial' con el
      // motivo, pero sus conversiones y agregados sí quedaron guardados.
      if (saved.rawError && quality.length > 0) {
        quality[0].warnings.push(`No se pudo guardar la capa cruda: ${saved.rawError}`)
      }

      const descartadas = quality.reduce((s, q) => s + q.fecha_invalida + q.cantidad_invalida, 0)
      const hasWarnings = quality.some(q => q.warnings.length > 0)
      const status: SyncLogStatus = hasWarnings ? 'partial' : 'ok'
      await logSyncResult(supabase, clienteId, sheetId, status, quality)

      results.push({
        sheet_id: sheetId, name: label, success: true,
        rowsProcessed: saved.rowsProcessed, daysProcessed: saved.daysProcessed,
        rowsDescartadas: descartadas, rawProcessed: saved.rawProcessed, quality,
      })
    } catch (err: any) {
      await logSyncResult(supabase, clienteId, sheetId, 'error', [], err.message)
      results.push({
        sheet_id: sheetId, name: label, success: false,
        rowsProcessed: 0, daysProcessed: 0, rowsDescartadas: 0, rawProcessed: 0,
        quality: [], error: err.message,
      })
    }
  }

  // Los sheets retirados de la config (y los datos previos a la trazabilidad por
  // sheet) se limpian con la config ya leída correctamente.
  await cleanupOrphanConversiones(supabase, clienteId, enabledSheets.map(s => s.id!))

  // Los campos de Sheet se derivan de la capa cruda, así que se recalculan al
  // final, con `sheet_filas` ya reemplazada y sin los huérfanos.
  //
  // Un fallo aquí NO tumba el sync: las conversiones y la capa cruda ya están
  // guardadas y el recálculo se puede repetir solo, sin volver a Google. El
  // import es dinámico para no meter la capa de campos en el arranque de los
  // workers que solo sincronizan conversiones.
  let campos: { campos: number; dias: number; valores: number; avisos: string[]; error?: string } | undefined
  try {
    const { recalcularCamposCliente } = await import('../sheets/campos-db')
    campos = await recalcularCamposCliente(supabase, clienteId)
    if (campos.error) console.error(`[conversiones] recálculo de campos: ${campos.error}`)
  } catch (err: unknown) {
    const motivo = err instanceof Error ? err.message : 'Error al recalcular los campos'
    console.error('[conversiones] no se pudieron recalcular los campos de Sheet:', motivo)
    campos = { campos: 0, dias: 0, valores: 0, avisos: [], error: motivo }
  }

  return { results, rows: allRows, campos }
}
