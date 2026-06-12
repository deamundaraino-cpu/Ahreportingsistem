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
 * Sync manual de conversiones offline desde Google Sheets.
 * POST /api/admin/sync-conversiones-offline
 * Body: { clientId: string }
 * Sincroniza todos los sheets habilitados del cliente y combina sus filas.
 */
export async function POST(request: NextRequest) {
  try {
    const { clientId } = await request.json()
    if (!clientId) {
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: cliente, error: clientError } = await supabase
      .from('clientes')
      .select('id, nombre, config_api')
      .eq('id', clientId)
      .single()

    if (clientError || !cliente) {
      return NextResponse.json({ error: 'Cliente no encontrado' }, { status: 404 })
    }

    const allSheets = normalizeSheetConfigs(cliente.config_api?.google_sheets_conversiones)
    const enabledSheets = allSheets.filter(s => s.enabled && s.sheet_url)

    if (enabledSheets.length === 0) {
      return NextResponse.json(
        { error: 'No hay sheets de conversiones habilitados para este cliente' },
        { status: 400 }
      )
    }

    // Combinar filas y custom_columns de todos los sheets habilitados
    let allRows: ConversionRow[] = []
    const mergedCustomCols: Record<string, CustomColumnDef> = {}
    const sheetErrors: string[] = []

    for (const sheetCfg of enabledSheets) {
      try {
        const rows = await fetchConversionesFromSheet(sheetCfg)
        allRows = [...allRows, ...rows]
        if (sheetCfg.custom_columns) {
          Object.assign(mergedCustomCols, sheetCfg.custom_columns)
        }
      } catch (err: any) {
        sheetErrors.push(`${sheetCfg.name || sheetCfg.sheet_url}: ${err.message}`)
      }
    }

    const aggregates = computeConversionesAggregates(
      allRows,
      Object.keys(mergedCustomCols).length > 0 ? mergedCustomCols : undefined
    )
    const saved = await saveConversionesToDb(supabase, cliente.id, allRows, aggregates)

    const porTipo = allRows.reduce<Record<string, { cantidad: number; valor: number }>>((acc, r) => {
      if (!acc[r.tipo]) acc[r.tipo] = { cantidad: 0, valor: 0 }
      acc[r.tipo].cantidad += r.cantidad
      acc[r.tipo].valor    += r.valor ?? 0
      return acc
    }, {})

    return NextResponse.json({
      success:         true,
      clientName:      cliente.nombre,
      totalFilas:      allRows.length,
      diasProcesados:  saved.daysProcessed,
      sheetsProcessed: enabledSheets.length,
      porTipo,
      ...(sheetErrors.length > 0 ? { warnings: sheetErrors } : {}),
      timestamp:       new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('Error sync conversiones offline:', error)
    return NextResponse.json(
      { error: error.message || 'Error al sincronizar conversiones offline' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/sync-conversiones-offline?clientId=UUID
 * Verifica si el cliente tiene al menos un sheet habilitado.
 */
export async function GET(request: NextRequest) {
  try {
    const clientId = request.nextUrl.searchParams.get('clientId')
    if (!clientId) {
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: cliente } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single()

    const sheets = normalizeSheetConfigs(cliente?.config_api?.google_sheets_conversiones)
    const enabledSheets = sheets.filter(s => s.enabled && s.sheet_url)

    return NextResponse.json({
      isConfigured: enabledSheets.length > 0,
      sheetsCount:  enabledSheets.length,
      sheetNames:   enabledSheets.map(s => s.name || s.sheet_url),
    })
  } catch {
    return NextResponse.json({ error: 'Error al verificar configuración' }, { status: 500 })
  }
}
