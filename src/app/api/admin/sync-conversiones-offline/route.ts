import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  syncClienteConversiones,
  normalizeSheetConfigs,
} from '@/lib/integrations/google-sheets-conversiones'

// Releer un documento entero y recalcular los campos no cabe en el timeout por
// defecto: sin esto la petición moría a mitad y el cliente no se enteraba.
export const maxDuration = 60

/**
 * Sync manual de conversiones offline desde Google Sheets.
 * POST /api/admin/sync-conversiones-offline
 * Body: { clientId: string, sheetId?: string, recalcularCampos?: boolean }
 * Sincroniza todos los sheets habilitados del cliente (cada uno con sus
 * pestañas) de forma independiente: el fallo de uno no toca los datos de otro.
 *
 * Con `sheetId` sincroniza solo ese documento. Un cliente con varios sheets de
 * decenas de miles de filas no cabe entero en los 60s de la función: la UI los
 * recorre de uno en uno y recalcula los campos al final (`recalcularCampos`).
 */
export async function POST(request: NextRequest) {
  try {
    const { clientId, sheetId, recalcularCampos } = await request.json()
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

    const rawConfig = cliente.config_api?.google_sheets_conversiones
    const enabledSheets = normalizeSheetConfigs(rawConfig).filter(s => s.enabled && s.sheet_url)

    if (enabledSheets.length === 0) {
      return NextResponse.json(
        { error: 'No hay sheets de conversiones habilitados para este cliente' },
        { status: 400 }
      )
    }

    if (sheetId && !enabledSheets.some(s => s.id === sheetId)) {
      return NextResponse.json(
        { error: 'El sheet indicado no existe o está deshabilitado' },
        { status: 400 }
      )
    }

    const { results, rows, campos } = await syncClienteConversiones(supabase, cliente.id, rawConfig, {
      sheetId,
      // Por defecto se recalcula; el sync por sheet no, porque el recálculo
      // recorre la capa cruda entera y se lanza una sola vez al terminar todos.
      recalcularCampos: recalcularCampos ?? !sheetId,
    })

    const porTipo = rows.reduce<Record<string, { cantidad: number; valor: number }>>((acc, r) => {
      if (!acc[r.tipo]) acc[r.tipo] = { cantidad: 0, valor: 0 }
      acc[r.tipo].cantidad += r.cantidad
      acc[r.tipo].valor    += r.valor ?? 0
      return acc
    }, {})

    const warnings = [
      ...results.filter(r => !r.success).map(r => `${r.name}: ${r.error}`),
      ...results.flatMap(r => r.quality.flatMap(q =>
        q.warnings.map(w => `${r.name} › ${q.tab_name}: ${w}`)
      )),
      ...(campos?.error ? [`Campos de Sheet: ${campos.error}`] : []),
      ...(campos?.avisos ?? []),
    ]

    return NextResponse.json({
      success:         results.some(r => r.success),
      clientName:      cliente.nombre,
      totalFilas:      rows.length,
      diasProcesados:  results.reduce((s, r) => s + r.daysProcessed, 0),
      filasDescartadas: results.reduce((s, r) => s + r.rowsDescartadas, 0),
      filasCrudas:     results.reduce((s, r) => s + r.rawProcessed, 0),
      sheetsProcessed: results.length,
      camposRecalculados: campos?.campos ?? 0,
      porTipo,
      sheets: results.map(r => ({
        sheet_id: r.sheet_id, name: r.name, success: r.success,
        filas: r.rowsProcessed, dias: r.daysProcessed,
        descartadas: r.rowsDescartadas, crudas: r.rawProcessed, quality: r.quality,
        ...(r.error ? { error: r.error } : {}),
      })),
      ...(warnings.length > 0 ? { warnings } : {}),
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
 * Verifica si el cliente tiene al menos un sheet habilitado y devuelve el
 * estado del último sync de cada uno (filas ok/descartadas, avisos por pestaña).
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

    // Último log por sheet. La tabla puede no existir aún (migración 056 sin
    // aplicar): en ese caso simplemente no se reporta estado.
    const lastSync: Record<string, any> = {}
    const { data: logs } = await supabase
      .from('conversiones_offline_sync_log')
      .select('sheet_id, run_at, status, rows_ok, rows_descartadas, detalle')
      .eq('cliente_id', clientId)
      .order('run_at', { ascending: false })
      .limit(100)

    for (const log of (logs ?? []) as any[]) {
      if (!lastSync[log.sheet_id]) lastSync[log.sheet_id] = log
    }

    return NextResponse.json({
      isConfigured: enabledSheets.length > 0,
      sheetsCount:  enabledSheets.length,
      sheetNames:   enabledSheets.map(s => s.name || s.sheet_url),
      lastSync,
    })
  } catch {
    return NextResponse.json({ error: 'Error al verificar configuración' }, { status: 500 })
  }
}
