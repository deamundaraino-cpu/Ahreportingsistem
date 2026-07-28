import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { loadCamposCliente } from '@/lib/sheets/campos-db'
import { slugCampo } from '@/lib/sheets/campos'
import type { SheetCampoVistaDef } from '@/lib/sheets/campos'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Vistas guardadas de un campo: "Leads 20-100" = contar las filas cuyo valor
 * esté en (20-100). Se comportan como una métrica más.
 *
 *   POST   /api/admin/sheet-campos/vistas    → alta o edición
 *   DELETE /api/admin/sheet-campos/vistas?id=
 *
 * A diferencia de los campos, una vista NO necesita recálculo: se evalúa sobre
 * el desglose diario que ya está guardado, así que cambiar sus valores es
 * instantáneo.
 */

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<SheetCampoVistaDef> & { cliente_id?: string }
    const clienteId = body.cliente_id
    if (!clienteId || !body.campo_id) {
      return NextResponse.json({ error: 'cliente_id y campo_id son obligatorios' }, { status: 400 })
    }

    const nombre = String(body.nombre ?? '').trim()
    if (!nombre) return NextResponse.json({ error: 'La vista necesita un nombre' }, { status: 400 })

    const valores = Array.isArray(body.valores) ? body.valores.filter(Boolean) : []
    if (valores.length === 0) {
      return NextResponse.json({ error: 'Elige al menos un valor para la vista' }, { status: 400 })
    }

    const db = admin()
    const comun = {
      campo_id: body.campo_id,
      nombre,
      agregacion: body.agregacion ?? 'count',
      operador: body.operador === 'not_in' ? 'not_in' : 'in',
      valores,
      formato: body.formato ?? 'number',
      activo: body.activo !== false,
      orden: Number(body.orden) || 0,
    }

    if (body.id) {
      const { error } = await db.from('sheet_campo_vistas')
        .update(comun).eq('id', body.id).eq('cliente_id', clienteId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const base = slugCampo(body.clave || nombre) || 'vista'
      const { data: existentes } = await db.from('sheet_campo_vistas')
        .select('clave').eq('cliente_id', clienteId)
      const usadas = new Set(((existentes ?? []) as any[]).map(r => r.clave))
      let clave = base
      let i = 2
      while (usadas.has(clave)) clave = `${base}_${i++}`

      const { error } = await db.from('sheet_campo_vistas')
        .insert({ cliente_id: clienteId, clave, ...comun })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const { campos, vistas } = await loadCamposCliente(db, clienteId)
    return NextResponse.json({ campos, vistas })
  } catch (err: any) {
    console.error('[sheet-campos/vistas] POST', err)
    return NextResponse.json({ error: err.message || 'Error al guardar la vista' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')
  const clienteId = request.nextUrl.searchParams.get('cliente_id')
  if (!id || !clienteId) {
    return NextResponse.json({ error: 'id y cliente_id son obligatorios' }, { status: 400 })
  }

  try {
    const db = admin()
    const { error } = await db.from('sheet_campo_vistas')
      .delete().eq('id', id).eq('cliente_id', clienteId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const { campos, vistas } = await loadCamposCliente(db, clienteId)
    return NextResponse.json({ success: true, campos, vistas })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al borrar la vista' }, { status: 500 })
  }
}
