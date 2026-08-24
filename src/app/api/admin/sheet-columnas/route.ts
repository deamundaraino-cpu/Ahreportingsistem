import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listarColumnasDisponibles } from '@/lib/sheets/campos-db'
import { normalizeSheetConfigs } from '@/lib/integrations/google-sheets-conversiones'
import { requireAdminRole } from '@/lib/report-utm/auth'
import { esUuid } from '@/lib/validation'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/admin/sheet-columnas?cliente_id=
 *
 * Qué columnas hay disponibles en cada pestaña ya sincronizada, con valores de
 * ejemplo. Es lo que puebla el mapeo "esta pestaña → esta columna" del editor de
 * campos, y sale de `sheet_filas`: **no llama a Google**, así que el selector
 * abre al instante y funciona aunque la cuenta esté desconectada.
 *
 * Devuelve además el nombre visible de cada sheet (que vive en la config del
 * cliente) para no mostrar UUIDs en el desplegable.
 */
export async function GET(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole()
  if (denied) return denied

  const clienteId = request.nextUrl.searchParams.get('cliente_id')
  if (!esUuid(clienteId)) return NextResponse.json({ error: 'cliente_id debe ser un UUID válido' }, { status: 400 })

  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const [{ data: cliente }, fuentes] = await Promise.all([
      db.from('clientes').select('config_api').eq('id', clienteId).maybeSingle(),
      listarColumnasDisponibles(db, clienteId),
    ])

    const nombrePorSheet = new Map<string, string>()
    for (const cfg of normalizeSheetConfigs((cliente as any)?.config_api?.google_sheets_conversiones)) {
      nombrePorSheet.set(cfg.id!, cfg.name || cfg.sheet_url || cfg.id!)
    }

    return NextResponse.json({
      fuentes: fuentes.map(f => ({
        ...f,
        sheet_nombre: nombrePorSheet.get(f.sheet_id) ?? f.sheet_id,
      })),
    })
  } catch (err: any) {
    console.error('[sheet-columnas]', err)
    return NextResponse.json({ error: err.message || 'Error al leer las columnas' }, { status: 500 })
  }
}
