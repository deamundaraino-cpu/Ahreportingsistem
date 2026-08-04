import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { fetchAllRows } from '@/lib/report-utm/bi-query'
import { parseFieldNumber } from '@/lib/report-utm/bi-metadata'
import type { FormFieldMeta } from '@/lib/report-utm/bi-metadata'
import { colombiaRangeBounds } from '@/lib/colombia-date'

export const dynamic = 'force-dynamic'

/**
 * Descubre los campos de formulario disponibles para un cliente en un rango.
 *
 *   GET /api/report-utm/bi/form-fields?cliente_id=&date_from=&date_to=
 *
 * Escanea `report_utm.lead_events.raw_fields` (JSONB plano por lead) y devuelve,
 * por cada clave encontrada: cobertura (fracción de leads que la traen), tipo
 * inferido (número/texto), cantidad de valores distintos y una muestra. El BI
 * usa esta lista para ofrecer los campos como dimensiones y como métricas
 * (sum/avg/…) en el editor de widgets.
 *
 * Tope de escaneo: 20k leads (los más recientes cuentan primero por el rango).
 */
export async function GET(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sp = req.nextUrl.searchParams
    const cliente_id = sp.get('cliente_id') ?? undefined
    const date_from  = sp.get('date_from') ?? undefined
    const date_to    = sp.get('date_to') ?? undefined

    const dateFrom = date_from ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = date_to   ?? new Date().toISOString().slice(0, 10)

    try {
        const admin = await createAdminClient()
        const rows = await fetchAllRows(() => {
            let q = admin
                .schema('report_utm')
                .from('lead_events')
                .select('id,raw_fields')
                .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
                .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
                .not('raw_fields', 'is', null)
            if (cliente_id) q = q.eq('cliente_id', cliente_id)
            return q
        }, 1000, 20000)

        interface Stat { present: number; numeric: number; values: Set<string> }
        const stats = new Map<string, Stat>()
        let total = 0

        for (const r of rows) {
            const rf = r.raw_fields as Record<string, unknown> | null
            if (!rf || typeof rf !== 'object') continue
            total++
            for (const [key, val] of Object.entries(rf)) {
                if (val === null || val === undefined) continue
                const s = String(val).trim()
                if (!s) continue
                let st = stats.get(key)
                if (!st) { st = { present: 0, numeric: 0, values: new Set() }; stats.set(key, st) }
                st.present++
                if (parseFieldNumber(s) !== null) st.numeric++
                if (st.values.size < 30) st.values.add(s)
            }
        }

        const data: FormFieldMeta[] = Array.from(stats.entries())
            .map(([key, st]) => ({
                key,
                label: key,
                type: (st.present > 0 && st.numeric / st.present >= 0.8 ? 'number' : 'text') as FormFieldMeta['type'],
                coverage: total > 0 ? st.present / total : 0,
                distinctCount: st.values.size,
                sampleValues: Array.from(st.values).slice(0, 8),
            }))
            .sort((a, b) => b.coverage - a.coverage || a.label.localeCompare(b.label))

        return NextResponse.json({ data, total })
    } catch (err) {
        console.error('[bi/form-fields]', err)
        return NextResponse.json({ error: 'Query error' }, { status: 500 })
    }
}
