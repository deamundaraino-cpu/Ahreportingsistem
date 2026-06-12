import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  fetchConversionesFromSheet,
  computeConversionesAggregates,
  saveConversionesToDb,
  normalizeSheetConfigs,
} from '@/lib/integrations/google-sheets-conversiones'
import type { CustomColumnDef, ConversionRow } from '@/lib/integrations/google-sheets-conversiones'

/**
 * Worker de conversiones offline — sincroniza Google Sheets → DB.
 * Corre diariamente a las 8:30 AM Colombia (UTC-5) vía Vercel Cron.
 * Soporta múltiples sheets por cliente (config como array).
 *
 * GET /api/worker/google-sheets-conversiones
 * Authorization: Bearer {CRON_SECRET}
 * Opcional: ?client_id=UUID  (procesa solo ese cliente)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const clientIdFilter = request.nextUrl.searchParams.get('client_id')

  let query = supabase.from('clientes').select('id, nombre, config_api')
  if (clientIdFilter) query = query.eq('id', clientIdFilter)

  const { data: clientes, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Record<string, any> = {}

  for (const cliente of clientes || []) {
    const enabledSheets = normalizeSheetConfigs(cliente.config_api?.google_sheets_conversiones)
      .filter(s => s.enabled && s.sheet_url)

    if (enabledSheets.length === 0) continue

    try {
      let allRows: ConversionRow[] = []
      const mergedCustomCols: Record<string, CustomColumnDef> = {}

      for (const sheetCfg of enabledSheets) {
        const rows = await fetchConversionesFromSheet(sheetCfg)
        allRows = [...allRows, ...rows]
        if (sheetCfg.custom_columns) {
          Object.assign(mergedCustomCols, sheetCfg.custom_columns)
        }
      }

      const aggregates = computeConversionesAggregates(
        allRows,
        Object.keys(mergedCustomCols).length > 0 ? mergedCustomCols : undefined
      )
      const saved = await saveConversionesToDb(supabase, cliente.id, allRows, aggregates)

      results[cliente.nombre] = { success: true, sheets: enabledSheets.length, ...saved }
    } catch (err: any) {
      results[cliente.nombre] = { success: false, error: err.message }
    }
  }

  return NextResponse.json({
    processed: Object.keys(results).length,
    results,
    timestamp: new Date().toISOString(),
  })
}
