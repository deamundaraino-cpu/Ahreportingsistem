import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  syncClienteConversiones,
  normalizeSheetConfigs,
} from '@/lib/integrations/google-sheets-conversiones'

/**
 * Worker de conversiones offline — sincroniza Google Sheets → DB.
 * Corre diariamente a las 07:00 AM Colombia (UTC-5 → 12:00 UTC) vía Vercel Cron.
 * Soporta múltiples sheets por cliente, y varias pestañas por sheet.
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
    const rawConfig = cliente.config_api?.google_sheets_conversiones
    const enabledSheets = normalizeSheetConfigs(rawConfig).filter(s => s.enabled && s.sheet_url)
    if (enabledSheets.length === 0) continue

    try {
      // Cada sheet se guarda por separado: uno que falle no borra los datos de
      // los demás ni aborta el resto del cliente.
      const { results: sheetResults } = await syncClienteConversiones(supabase, cliente.id, rawConfig)

      const failed = sheetResults.filter(r => !r.success)
      results[cliente.nombre] = {
        success: failed.length === 0,
        sheets: sheetResults.length,
        rowsProcessed: sheetResults.reduce((s, r) => s + r.rowsProcessed, 0),
        daysProcessed: sheetResults.reduce((s, r) => s + r.daysProcessed, 0),
        rowsDescartadas: sheetResults.reduce((s, r) => s + r.rowsDescartadas, 0),
        ...(failed.length > 0
          ? { errors: failed.map(r => `${r.name}: ${r.error}`) }
          : {}),
      }
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
