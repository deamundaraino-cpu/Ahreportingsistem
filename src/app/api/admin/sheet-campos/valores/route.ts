import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listarValoresCrudos } from '@/lib/sheets/campos-db'
import { requireAdminRole } from '@/lib/report-utm/auth'
import { esUuid } from '@/lib/validation'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/admin/sheet-campos/valores?cliente_id=&campo_id=&limite=500
 *
 * Valores crudos que el campo ha visto en los datos ya sincronizados, con su
 * conteo de filas y las pestañas donde aparecen. Es lo que alimenta el agrupador:
 * el analista ve "20 a 100" (312 filas, Form A) y "20-100" (98 filas, Form B) y
 * los junta en un mismo bucket con un clic.
 *
 * Sale del catálogo materializado, no de escanear `sheet_filas`: el editor tiene
 * que abrirse al instante.
 */
export async function GET(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole()
  if (denied) return denied

  const clienteId = request.nextUrl.searchParams.get('cliente_id')
  const campoId = request.nextUrl.searchParams.get('campo_id')
  const limite = Number(request.nextUrl.searchParams.get('limite')) || 500

  if (!esUuid(clienteId) || !esUuid(campoId)) {
    return NextResponse.json({ error: 'cliente_id y campo_id deben ser UUID válidos' }, { status: 400 })
  }

  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { valores, totalDistintos } = await listarValoresCrudos(db, clienteId, campoId, limite)
    return NextResponse.json({ valores, total_distintos: totalDistintos })
  } catch (err: any) {
    console.error('[sheet-campos/valores]', err)
    return NextResponse.json({ error: err.message || 'Error al leer los valores' }, { status: 500 })
  }
}
