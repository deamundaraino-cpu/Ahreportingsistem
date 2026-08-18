// Segmentos de campo de lead de un cliente (report_utm.lead_campo_segmentos).
//
//   GET    ?cliente_id=       → segmentos definidos
//   POST   { …segmento }      → alta o edición
//   DELETE ?id=               → baja
//
// Un segmento es un subconjunto con nombre de los buckets de un campo —«Desde
// 2M» = estos tres— que se ofrece como MÉTRICA (`leadseg:<clave>`, alias
// `lseg__<clave>`). Hermano de esta misma carpeta: el CRUD de los campos.

import { NextRequest, NextResponse } from 'next/server'
import { reportUtmAdminClient } from '@/lib/report-utm/client'
import { checkWriteRole, getUserRole } from '@/lib/report-utm/auth'
import {
    loadLeadCampos, loadLeadSegmentos, saveLeadSegmento, deleteLeadSegmento,
} from '@/lib/report-utm/lead-campos-db'
import { slugCampo } from '@/lib/report-utm/lead-campos'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    const role = await getUserRole()
    if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const clienteId = req.nextUrl.searchParams.get('cliente_id')
    if (!clienteId) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 })

    const rtm = await reportUtmAdminClient()
    const campos = await loadLeadCampos(rtm, clienteId)
    const segmentos = await loadLeadSegmentos(rtm, clienteId, campos)
    return NextResponse.json({ data: segmentos })
}

export async function POST(req: NextRequest) {
    const { ok } = await checkWriteRole()
    if (!ok) return NextResponse.json({ error: 'Sin permiso para editar segmentos.' }, { status: 403 })

    const body = await req.json().catch(() => null)
    if (!body?.cliente_id) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 })
    if (!body?.campo_id) return NextResponse.json({ error: 'campo_id requerido' }, { status: 400 })

    const rtm = await reportUtmAdminClient()
    const campos = await loadLeadCampos(rtm, body.cliente_id)

    // El campo padre tiene que ser de ESTE cliente: sin la comprobación, un
    // campo_id de otro cliente crearía un segmento que nunca bucketiza nada.
    const campo = campos.find(c => c.id === body.campo_id)
    if (!campo) return NextResponse.json({ error: 'El campo de lead no existe para este cliente.' }, { status: 400 })

    // La clave solo se calcula en el ALTA: es lo que queda guardado dentro de los
    // widgets y de las fórmulas, así que renombrar el segmento no debe moverla.
    let clave = String(body.clave ?? '').trim()
    if (!body.id) {
        clave = slugCampo(clave || String(body.nombre ?? ''))
        if (!clave) return NextResponse.json({ error: 'El nombre no produce una clave válida.' }, { status: 400 })
        const existentes = await loadLeadSegmentos(rtm, body.cliente_id, campos)
        if (existentes.some(s => s.clave === clave)) {
            let n = 2
            while (existentes.some(s => s.clave === `${clave}_${n}`)) n++
            clave = `${clave}_${n}`
        }
    }

    const res = await saveLeadSegmento(rtm, {
        id: body.id,
        cliente_id: body.cliente_id,
        campo_id: body.campo_id,
        clave,
        nombre: String(body.nombre ?? ''),
        descripcion: body.descripcion ?? null,
        operador: body.operador === 'not_in' ? 'not_in' : 'in',
        valores: Array.isArray(body.valores) ? body.valores.map(String) : [],
        activo: body.activo,
        orden: body.orden,
    })

    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ data: { id: res.id, clave } })
}

export async function DELETE(req: NextRequest) {
    const { ok } = await checkWriteRole()
    if (!ok) return NextResponse.json({ error: 'Sin permiso para borrar segmentos.' }, { status: 403 })

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 })

    const rtm = await reportUtmAdminClient()
    const res = await deleteLeadSegmento(rtm, id)
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ ok: true })
}
