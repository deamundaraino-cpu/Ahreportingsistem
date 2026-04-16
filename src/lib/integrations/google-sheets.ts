import { GoogleSpreadsheet } from 'google-spreadsheet'
import { JWT } from 'google-auth-library'

interface GoogleSheetsConfig {
  sheet_url: string
  quality_field: string
  qualified_values: string[]
  enabled: boolean
  client_email?: string
  private_key?: string
  /** Nombres de hojas a leer. Si está vacío, lee la primera hoja. */
  sheet_names?: string[]
}

interface LeadRow {
  id: string
  created_time: string
  ad_id: string
  ad_name: string
  adset_id: string
  adset_name: string
  campaign_id: string
  campaign_name: string
  form_id: string
  form_name: string
  is_organic: string
  platform: string
  email: string
  full_name: string
  phone: string
  lead_status: string
  [key: string]: string // for dynamic quality fields
}

interface LeadResult {
  lead_data: LeadRow
  is_qualified: boolean
  qualification_field: string
  qualification_value: string
}

interface DailyAggregate {
  date: string
  leads_totales: number
  leads_calificados: number
  leads_no_calificados: number
  tasa_calificacion: number
}

/**
 * Extract spreadsheet ID from a Google Sheets URL
 */
function extractSheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

/**
 * Create an authenticated JWT client for Google Sheets API
 * Uses client-specific credentials if provided, falls back to env vars
 */
function createAuthClient(clientEmail?: string, clientKey?: string): JWT {
  const email = clientEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key = (clientKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY)?.replace(/\\n/g, '\n')

  if (!email || !key) {
    throw new Error('Google service account credentials not configured')
  }

  return new JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
}

/**
 * Fetch all leads from a Google Sheet.
 * If sheetNames is provided, reads those specific tabs and combines the rows.
 * Falls back to the first sheet if no names are given.
 */
export async function fetchLeadsFromSheet(
  sheetUrl: string,
  clientEmail?: string,
  clientKey?: string,
  sheetNames?: string[]
): Promise<LeadRow[]> {
  const sheetId = extractSheetId(sheetUrl)
  if (!sheetId) throw new Error(`Invalid Google Sheets URL: ${sheetUrl}`)

  const auth = createAuthClient(clientEmail, clientKey)
  const doc = new GoogleSpreadsheet(sheetId, auth)
  await doc.loadInfo()

  // Determine which sheets to read
  let sheetsToRead = []
  if (sheetNames && sheetNames.length > 0) {
    for (const name of sheetNames) {
      const found = doc.sheetsByTitle[name]
      if (!found) throw new Error(`Hoja "${name}" no encontrada en el documento. Hojas disponibles: ${Object.keys(doc.sheetsByTitle).join(', ')}`)
      sheetsToRead.push(found)
    }
  } else {
    sheetsToRead = [doc.sheetsByIndex[0]]
  }

  // Read and combine rows from all sheets
  const allRows: LeadRow[] = []
  for (const sheet of sheetsToRead) {
    const rows = await sheet.getRows()
    const headers = sheet.headerValues
    const sheetRows = rows.map(row => {
      const data: Record<string, string> = {}
      headers.forEach(header => {
        data[header] = row.get(header) || ''
      })
      // Tag the source sheet for debugging
      data['_sheet_name'] = sheet.title
      return data as LeadRow
    })
    allRows.push(...sheetRows)
  }

  return allRows
}

/**
 * Filter leads by quality field and qualified values
 */
export function filterQualifiedLeads(
  leads: LeadRow[],
  qualityField: string,
  qualifiedValues: string[]
): LeadResult[] {
  const normalizedValues = qualifiedValues.map(v => v.toLowerCase().trim())

  return leads.map(lead => {
    const fieldValue = lead[qualityField] || ''
    const isQualified = normalizedValues.includes(fieldValue.toLowerCase().trim())

    return {
      lead_data: lead,
      is_qualified: isQualified,
      qualification_field: qualityField,
      qualification_value: fieldValue,
    }
  })
}

/**
 * Try to extract a YYYY-MM-DD date from a lead row.
 * Checks multiple common column names and handles DD/MM/YYYY format.
 */
function extractDateFromLead(leadData: LeadRow): string {
  const candidates = [
    'created_time', 'fecha', 'date', 'timestamp', 'created_at',
    'Fecha', 'Date', 'Created Time', 'Timestamp',
  ]
  let raw = ''
  for (const key of candidates) {
    if (leadData[key]) { raw = leadData[key]; break }
  }
  // Fallback: first column that looks like a date
  if (!raw) {
    for (const val of Object.values(leadData)) {
      if (typeof val === 'string' && /\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4}/.test(val)) {
        raw = val; break
      }
    }
  }
  if (!raw) return ''
  // Handle ISO format: "2024-01-15T10:30:00" → "2024-01-15"
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.split('T')[0]
  // Handle DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`
  return ''
}

/**
 * Group leads by date and compute daily aggregates
 */
export function computeDailyAggregates(leads: LeadResult[]): DailyAggregate[] {
  const byDate = new Map<string, { total: number; qualified: number }>()

  for (const lead of leads) {
    const date = extractDateFromLead(lead.lead_data)
    if (!date || date.length !== 10) continue

    const entry = byDate.get(date) || { total: 0, qualified: 0 }
    entry.total++
    if (lead.is_qualified) entry.qualified++
    byDate.set(date, entry)
  }

  return Array.from(byDate.entries()).map(([date, counts]) => ({
    date,
    leads_totales: counts.total,
    leads_calificados: counts.qualified,
    leads_no_calificados: counts.total - counts.qualified,
    tasa_calificacion: counts.total > 0
      ? Math.round((counts.qualified / counts.total) * 10000) / 100
      : 0,
  }))
}

/**
 * Save leads and daily aggregates to the database
 */
export async function saveLeadsToDb(
  supabase: any,
  clientId: string,
  leads: LeadResult[],
  dailyAggregates: DailyAggregate[]
) {
  // 1. Upsert individual leads
  if (leads.length > 0) {
    const leadsToInsert = leads.map(l => ({
      client_id: clientId,
      date: extractDateFromLead(l.lead_data),
      lead_external_id: l.lead_data.id || null,
      lead_data: l.lead_data,
      is_qualified: l.is_qualified,
      qualification_field: l.qualification_field,
      qualification_value: l.qualification_value,
      source: 'google_sheets',
    })).filter(l => l.date.length === 10)

    // Batch insert in chunks of 500
    for (let i = 0; i < leadsToInsert.length; i += 500) {
      const chunk = leadsToInsert.slice(i, i + 500)
      await supabase.from('leads').upsert(chunk, {
        onConflict: 'client_id,lead_external_id',
        ignoreDuplicates: true,
      })
    }
  }

  // 2. Upsert daily aggregates
  if (dailyAggregates.length > 0) {
    const aggregatesToInsert = dailyAggregates.map(a => ({
      client_id: clientId,
      date: a.date,
      leads_totales: a.leads_totales,
      leads_calificados: a.leads_calificados,
      leads_no_calificados: a.leads_no_calificados,
      tasa_calificacion: a.tasa_calificacion,
    }))

    await supabase.from('leads_diarios').upsert(aggregatesToInsert, {
      onConflict: 'client_id,date',
    })
  }

  return { leadsProcessed: leads.length, daysProcessed: dailyAggregates.length }
}

export type { GoogleSheetsConfig, LeadRow, LeadResult, DailyAggregate }
