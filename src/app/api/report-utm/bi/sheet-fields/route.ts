import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { loadCamposCliente } from '@/lib/sheets/campos-db'
import type { SheetFieldMeta, SheetViewMeta } from '@/lib/report-utm/bi-metadata'

export const dynamic = 'force-dynamic'

/**
 * Campos de Sheet de un cliente, para que el BI los ofrezca como métrica,
 * dimensión y filtro.
 *
 *   GET /api/report-utm/bi/sheet-fields?cliente_id=
 *
 * Un campo unifica columnas equivalentes de varias pestañas bajo un nombre
 * visible propio; ese nombre es el que devuelve este endpoint y el que acaba
 * viéndose en el selector de métricas, en las tablas y en las gráficas.
 *
 * Los valores (buckets) viajan en la respuesta para que el constructor de
 * filtros pueda ofrecerlos sin una llamada extra a `type=distinct`.
 *
 * Convive con `/bi/offline-fields`, que sigue sirviendo las columnas sueltas
 * (`offfield:*`) de los informes anteriores a este módulo.
 */
export async function GET(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const clienteId = req.nextUrl.searchParams.get('cliente_id')
    if (!clienteId) return NextResponse.json({ data: { fields: [], views: [] } })

    try {
        const admin = await createAdminClient()

        // Los campos viven en `public`, los informes traen el id de report_utm.
        const { data: rtmCliente } = await admin
            .schema('report_utm').from('clientes')
            .select('public_cliente_id').eq('id', clienteId).maybeSingle()
        const publicId = rtmCliente?.public_cliente_id
        if (!publicId) return NextResponse.json({ data: { fields: [], views: [] } })

        const { campos, vistas } = await loadCamposCliente(admin, publicId, { soloActivos: true })
        if (campos.length === 0) return NextResponse.json({ data: { fields: [], views: [] } })

        // Los valores salen del desglose, no de la config: son los que de verdad
        // existen en los datos del rango completo.
        const { data: desglose } = await admin.from('sheet_campo_valores_diarios')
            .select('campo_id, valor')
            .eq('cliente_id', publicId)

        const valoresPorCampo = new Map<string, Set<string>>()
        for (const r of (desglose ?? []) as unknown as Record<string, unknown>[]) {
            const id = String(r.campo_id)
            const set = valoresPorCampo.get(id) ?? new Set<string>()
            const v = String(r.valor ?? '').trim()
            if (v) set.add(v)
            valoresPorCampo.set(id, set)
        }

        const fields: SheetFieldMeta[] = campos.map(c => {
            const vistos = Array.from(valoresPorCampo.get(c.id) ?? [])
            // El orden que definió el analista manda; el resto va detrás,
            // alfabético, para que "1-10, 11-20, 20-100" no salga como texto.
            const orden = c.valores_orden ?? []
            const pos = (v: string) => { const i = orden.indexOf(v); return i === -1 ? orden.length : i }
            return {
                clave: c.clave,
                nombre: c.nombre,
                rol: c.rol,
                formato: c.formato,
                agregacion: c.agregacion,
                valores: vistos.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b)),
                alta_cardinalidad: c.alta_cardinalidad,
                sources: Array.from(new Set(
                    (c.origenes ?? []).map(o => o.tab_name === '*' ? 'Todas las pestañas' : o.tab_name)
                )),
            }
        })

        const views: SheetViewMeta[] = vistas.map(v => ({
            clave: v.clave,
            nombre: v.nombre,
            campo_clave: v.campo_clave,
            agregacion: v.agregacion,
            formato: v.formato,
        }))

        return NextResponse.json({ data: { fields, views } })
    } catch (err) {
        console.error('[bi/sheet-fields]', err)
        return NextResponse.json({ error: 'Query error' }, { status: 500 })
    }
}
