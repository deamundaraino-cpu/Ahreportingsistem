import { GoogleSpreadsheet } from 'google-spreadsheet'
import { JWT, OAuth2Client } from 'google-auth-library'
import { hasAgencyGoogleConnection, getAgencyAccessToken } from './google-auth'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type CustomColumnType = 'count' | 'currency' | 'percentage' | 'date' | 'text'

export interface CustomColumnDef {
  col_name: string          // nombre exacto en el Sheet (ej: "Citas Agendadas")
  type: CustomColumnType
  label: string             // nombre para el dashboard
  include: boolean          // si false, se ignora en el sync
  sample_values?: string[]  // solo durante detección, no se persiste
}

export interface ConversionesConfig {
  /** UUID que identifica esta config de sheet dentro del array del cliente. */
  id?: string
  /** Nombre visible en la UI (ej: "Leads WhatsApp"). */
  name?: string
  enabled: boolean
  sheet_url: string
  sheet_name?: string
  col_fecha?: string
  col_tipo?: string
  col_cantidad?: string
  col_valor?: string
  col_fuente?: string
  col_notas?: string
  /** Columnas adicionales del Sheet definidas/confirmadas por el analista. */
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

/**
 * Normaliza el campo google_sheets_conversiones (que puede ser un objeto legacy
 * o un array) y devuelve siempre un array de ConversionesConfig.
 */
export function normalizeSheetConfigs(raw: unknown): ConversionesConfig[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as ConversionesConfig[]
  if (typeof raw === 'object') return [{ id: 'legacy', name: 'Sheet Principal', ...(raw as ConversionesConfig) }]
  return []
}

export interface ConversionRow {
  fecha: string
  tipo: string
  cantidad: number
  valor: number | null
  fuente: string
  notas: string
  custom_fields: Record<string, number>
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

export function sanitizeColName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
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

function parseDate(raw: string): string {
  if (!raw) return ''
  const t = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.split('T')[0]
  const dmy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`
  return ''
}

function toNumber(raw: string): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Inspecciona los encabezados del Sheet y propone tipos para cada columna extra.
 * No guarda nada — solo devuelve sugerencias para que el analista confirme.
 */
export async function detectSheetColumns(config: ConversionesConfig): Promise<DetectedColumn[]> {
  const sheetId = extractSheetId(config.sheet_url)
  if (!sheetId) throw new Error(`URL de Google Sheets inválida: ${config.sheet_url}`)

  const auth = await createAuthClient(config.client_email, config.private_key)
  const doc = new GoogleSpreadsheet(sheetId, auth)
  await doc.loadInfo()

  let sheet
  if (config.sheet_name?.trim()) {
    sheet = doc.sheetsByTitle[config.sheet_name.trim()]
    if (!sheet) {
      const available = Object.keys(doc.sheetsByTitle).join(', ')
      throw new Error(`Pestaña "${config.sheet_name}" no encontrada. Disponibles: ${available}`)
    }
  } else {
    sheet = doc.sheetsByIndex[0]
  }

  const rows = await sheet.getRows({ limit: 6 })
  const headers = sheet.headerValues

  const colFecha    = (config.col_fecha    || 'fecha').toLowerCase().trim()
  const colTipo     = (config.col_tipo     || 'tipo').toLowerCase().trim()
  const colCantidad = (config.col_cantidad || 'cantidad').toLowerCase().trim()
  const colValor    = (config.col_valor    || 'valor').toLowerCase().trim()
  const colFuente   = (config.col_fuente   || 'fuente').toLowerCase().trim()
  const colNotas    = (config.col_notas    || 'notas').toLowerCase().trim()
  const standardCols = new Set([colFecha, colTipo, colCantidad, colValor, colFuente, colNotas])

  const extraHeaders = headers.filter(h => !standardCols.has(h.toLowerCase().trim()))

  return extraHeaders.map(col => {
    const samples = rows
      .map(r => (r.get(col) || '').toString().trim())
      .filter(Boolean)
      .slice(0, 5)

    const sanitized = sanitizeColName(col)
    const existing = config.custom_columns?.[sanitized]

    return {
      col_name:       col,
      sanitized_name: sanitized,
      proposed_type:  existing?.type ?? inferType(col, samples),
      label:          existing?.label ?? col,
      sample_values:  samples,
    }
  })
}

/**
 * Lee todas las filas de conversiones. Procesa columnas extra según custom_columns si
 * está configurado; si no hay configuración, lee todas las columnas numéricas.
 */
export async function fetchConversionesFromSheet(config: ConversionesConfig): Promise<ConversionRow[]> {
  const sheetId = extractSheetId(config.sheet_url)
  if (!sheetId) throw new Error(`URL de Google Sheets inválida: ${config.sheet_url}`)

  const auth = await createAuthClient(config.client_email, config.private_key)
  const doc = new GoogleSpreadsheet(sheetId, auth)
  await doc.loadInfo()

  let sheet
  if (config.sheet_name?.trim()) {
    sheet = doc.sheetsByTitle[config.sheet_name.trim()]
    if (!sheet) {
      const available = Object.keys(doc.sheetsByTitle).join(', ')
      throw new Error(`Pestaña "${config.sheet_name}" no encontrada. Disponibles: ${available}`)
    }
  } else {
    sheet = doc.sheetsByIndex[0]
  }

  const rows = await sheet.getRows()
  const headers = sheet.headerValues

  const colFecha    = config.col_fecha    || 'fecha'
  const colTipo     = config.col_tipo     || 'tipo'
  const colCantidad = config.col_cantidad || 'cantidad'
  const colValor    = config.col_valor    || 'valor'
  const colFuente   = config.col_fuente   || 'fuente'
  const colNotas    = config.col_notas    || 'notas'

  const standardCols = new Set(
    [colFecha, colTipo, colCantidad, colValor, colFuente, colNotas].map(c => c.toLowerCase().trim())
  )

  if (!headers.map(h => h.toLowerCase().trim()).includes(colFecha.toLowerCase().trim())) {
    throw new Error(`Columna de fecha "${colFecha}" no encontrada. Disponibles: ${headers.join(', ')}`)
  }

  // Determinar qué columnas extra procesar
  // Si hay custom_columns configuradas → solo las que tienen include:true y type numérico
  // Si no hay configuración → todas las numéricas (comportamiento legacy)
  const customCols = config.custom_columns
  let extraColsToProcess: Array<{ header: string; sanitized: string; type: CustomColumnType }>

  if (customCols && Object.keys(customCols).length > 0) {
    extraColsToProcess = Object.entries(customCols)
      .filter(([, def]) => def.include && def.type !== 'date' && def.type !== 'text')
      .map(([sanitized, def]) => ({ header: def.col_name, sanitized, type: def.type }))
  } else {
    // Legacy: detectar automáticamente
    extraColsToProcess = headers
      .filter(h => !standardCols.has(h.toLowerCase().trim()))
      .map(h => ({ header: h, sanitized: sanitizeColName(h), type: 'count' as CustomColumnType }))
  }

  const conversiones: ConversionRow[] = []

  for (const row of rows) {
    const fecha = parseDate((row.get(colFecha) || '').toString())
    if (!fecha || fecha.length !== 10) continue

    const tipo     = (row.get(colTipo)     || 'otro').toString().trim().toLowerCase()
    const cantidad = toNumber((row.get(colCantidad) || '0').toString())
    const rawValor = (row.get(colValor) || '').toString()
    const valor    = rawValor.trim() ? toNumber(rawValor) : null
    const fuente   = (row.get(colFuente) || '').toString().trim()
    const notas    = (row.get(colNotas)  || '').toString().trim()

    if (cantidad <= 0) continue

    const custom_fields: Record<string, number> = {}
    for (const col of extraColsToProcess) {
      const raw = (row.get(col.header) || '').toString().trim()
      if (!raw) continue
      const n = toNumber(raw)
      if (!isNaN(n)) custom_fields[col.sanitized] = n
    }

    conversiones.push({ fecha, tipo, cantidad, valor, fuente, notas, custom_fields })
  }

  return conversiones
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

      if (colType === 'percentage') {
        // Promedio ponderado: cada fila contribuye val*cantidad
        if (!entry._pct_sums[k]) entry._pct_sums[k] = { total: 0, weight: 0 }
        entry._pct_sums[k].total  += v * row.cantidad
        entry._pct_sums[k].weight += row.cantidad
      } else {
        // count / currency → suma directa
        entry.custom_fields[k] = (entry.custom_fields[k] ?? 0) + v
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
 * Full-replace por cliente.
 */
export async function saveConversionesToDb(
  supabase: any,
  clienteId: string,
  rows: ConversionRow[],
  aggregates: ConversionDiaria[]
): Promise<{ rowsProcessed: number; daysProcessed: number }> {
  await supabase.from('conversiones_offline').delete().eq('cliente_id', clienteId)
  await supabase.from('conversiones_offline_diarias').delete().eq('cliente_id', clienteId)

  if (rows.length > 0) {
    const toInsert = rows.map(r => ({
      cliente_id: clienteId, fecha: r.fecha, tipo: r.tipo,
      cantidad: r.cantidad, valor: r.valor, fuente: r.fuente, notas: r.notas,
    }))
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from('conversiones_offline').insert(toInsert.slice(i, i + 500))
      if (error) throw new Error(`Error insertando conversiones: ${error.message}`)
    }
  }

  if (aggregates.length > 0) {
    const toInsert = aggregates.map(a => ({
      cliente_id: clienteId, fecha: a.fecha, tipo: a.tipo, fuente: a.fuente,
      total_cantidad: a.total_cantidad, total_valor: a.total_valor,
      custom_fields: a.custom_fields,
    }))
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabase.from('conversiones_offline_diarias').insert(toInsert.slice(i, i + 500))
      if (error) throw new Error(`Error insertando agregados: ${error.message}`)
    }
  }

  return { rowsProcessed: rows.length, daysProcessed: aggregates.length }
}
