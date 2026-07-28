import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { recalcularCamposCliente } from '@/lib/sheets/campos-db'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/admin/sheet-campos/recalcular
 * Body: { cliente_id, campo_id?, desde?, hasta? }
 *
 * Reconstruye el desglose diario **leyendo solo de la base** (`sheet_filas`).
 * No llama a Google: por eso cambiar el mapa de valores de un campo y ver el
 * resultado tarda un segundo y no hace falta esperar al sync del día siguiente.
 *
 * Sin `campo_id` recalcula todos los campos activos del cliente.
 */
export async function POST(request: NextRequest) {
  try {
    const { cliente_id, campo_id, desde, hasta } = await request.json()
    if (!cliente_id) {
      return NextResponse.json({ error: 'cliente_id es obligatorio' }, { status: 400 })
    }

    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const res = await recalcularCamposCliente(db, cliente_id, {
      campoIds: campo_id ? [campo_id] : undefined,
      desde, hasta,
    })

    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 })
    return NextResponse.json({ success: true, ...res })
  } catch (err: any) {
    console.error('[sheet-campos/recalcular]', err)
    return NextResponse.json({ error: err.message || 'Error al recalcular' }, { status: 500 })
  }
}
