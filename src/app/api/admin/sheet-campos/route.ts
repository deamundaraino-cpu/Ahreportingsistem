import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  loadCamposCliente, recalcularCamposCliente, normalizarOrigenes,
} from '@/lib/sheets/campos-db'
import { slugCampo, normalizarValorCrudo } from '@/lib/sheets/campos'
import type { SheetCampoDef } from '@/lib/sheets/campos'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * CRUD de campos de Sheet de un cliente.
 *
 *   GET    /api/admin/sheet-campos?cliente_id=   → { campos, vistas }
 *   POST   /api/admin/sheet-campos              → guarda y RECALCULA ese campo
 *   DELETE /api/admin/sheet-campos?id=          → borra (cascade lleva desglose y valores)
 *
 * El POST recalcula en la misma llamada porque un campo sin desglose no se ve en
 * ningún lado: guardar y no ver el resultado se lee como que no funcionó. El
 * recálculo lee de `sheet_filas`, así que no toca Google.
 */

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const clienteId = request.nextUrl.searchParams.get('cliente_id')
  if (!clienteId) return NextResponse.json({ error: 'cliente_id es obligatorio' }, { status: 400 })

  try {
    const catalogo = await loadCamposCliente(admin(), clienteId)
    return NextResponse.json(catalogo)
  } catch (err: any) {
    console.error('[sheet-campos] GET', err)
    return NextResponse.json({ error: err.message || 'Error al leer los campos' }, { status: 500 })
  }
}

/** Deja el mapa de valores en su forma canónica: la clave es el valor normalizado. */
function normalizarMapa(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const clave = normalizarValorCrudo(k)
    const bucket = String(v ?? '').trim()
    if (clave && bucket) out[clave] = bucket
  }
  return out
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<SheetCampoDef> & { cliente_id?: string }
    const clienteId = body.cliente_id
    if (!clienteId) return NextResponse.json({ error: 'cliente_id es obligatorio' }, { status: 400 })

    const nombre = String(body.nombre ?? '').trim()
    if (!nombre) return NextResponse.json({ error: 'El campo necesita un nombre' }, { status: 400 })

    const db = admin()
    const origenes = normalizarOrigenes(body.origenes)
    if (origenes.length === 0) {
      return NextResponse.json(
        { error: 'Asigna al menos una pestaña con una columna' },
        { status: 400 }
      )
    }

    const comun = {
      nombre,
      descripcion: body.descripcion ?? null,
      rol: body.rol ?? 'dimension',
      formato: body.formato ?? 'number',
      agregacion: body.agregacion ?? 'count',
      origenes,
      valores_map: normalizarMapa(body.valores_map),
      valores_orden: Array.isArray(body.valores_orden) ? body.valores_orden : [],
      sin_mapear: body.sin_mapear ?? 'crudo',
      max_valores: Number(body.max_valores) > 0 ? Number(body.max_valores) : 200,
      legacy_offfield: body.legacy_offfield ?? null,
      activo: body.activo !== false,
      orden: Number(body.orden) || 0,
    }

    let campoId = body.id

    if (campoId) {
      // La clave NO se toca al editar: es lo que apuntan los tokens ya guardados
      // en informes y layouts. El nombre visible sí es libre.
      const { error } = await db.from('sheet_campos').update(comun).eq('id', campoId).eq('cliente_id', clienteId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const base = slugCampo(body.clave || nombre) || 'campo'

      // La clave debe ser única por cliente; si el nombre choca con otro campo se
      // le añade un sufijo en vez de fallar y hacer que el analista adivine.
      const { data: existentes } = await db.from('sheet_campos')
        .select('clave').eq('cliente_id', clienteId)
      const usadas = new Set(((existentes ?? []) as any[]).map(r => r.clave))
      let clave = base
      let i = 2
      while (usadas.has(clave)) clave = `${base}_${i++}`

      const { data, error } = await db.from('sheet_campos')
        .insert({ cliente_id: clienteId, clave, ...comun })
        .select('id').single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      campoId = data.id
    }

    const recalculo = await recalcularCamposCliente(db, clienteId, { campoIds: [campoId!] })

    const { campos, vistas } = await loadCamposCliente(db, clienteId)
    return NextResponse.json({
      campo: campos.find(c => c.id === campoId) ?? null,
      campos,
      vistas,
      recalculo,
    })
  } catch (err: any) {
    console.error('[sheet-campos] POST', err)
    return NextResponse.json({ error: err.message || 'Error al guardar el campo' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')
  const clienteId = request.nextUrl.searchParams.get('cliente_id')
  if (!id || !clienteId) {
    return NextResponse.json({ error: 'id y cliente_id son obligatorios' }, { status: 400 })
  }

  try {
    // El desglose, el catálogo de valores y las vistas se van por ON DELETE CASCADE.
    const { error } = await admin().from('sheet_campos')
      .delete().eq('id', id).eq('cliente_id', clienteId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error al borrar el campo' }, { status: 500 })
  }
}
