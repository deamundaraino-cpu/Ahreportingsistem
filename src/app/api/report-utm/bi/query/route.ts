import { NextRequest, NextResponse } from 'next/server'
import { runBiQuery, runFunnelQuery, runComparison, runPivotQuery, runDistinctValues } from '@/lib/report-utm/bi-query'
import { runCampaignQuery } from '@/lib/report-utm/campaign-data'
import type { BiMetric, BiDimension, DateGrouping, CalculatedFieldDef } from '@/lib/report-utm/bi-metadata'
import { createClient } from '@/utils/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sp = req.nextUrl.searchParams

    const type = sp.get('type') ?? 'standard' // 'standard' | 'funnel' | 'compare' | 'pivot'
    const cliente_id  = sp.get('cliente_id') ?? undefined
    const date_from   = sp.get('date_from') ?? undefined
    const date_to     = sp.get('date_to') ?? undefined
    const date_grouping = (sp.get('date_grouping') ?? 'day') as DateGrouping
    const dimension   = (sp.get('dimension') ?? 'none') as BiDimension
    const dimension2  = (sp.get('dimension2') ?? undefined) as BiDimension | undefined
    const limit       = parseInt(sp.get('limit') ?? '500', 10)
    const sort        = (sp.get('sort') ?? 'desc') as 'asc' | 'desc'

    // metrics can be comma-separated or multiple ?metrics[]=
    const metricsRaw = sp.get('metrics') ?? sp.getAll('metrics[]').join(',')
    const metrics = metricsRaw.split(',').filter(Boolean) as BiMetric[]

    // extra filters like ?filters[utm_source]=facebook
    const filters: Record<string, string> = {}
    for (const [key, value] of sp.entries()) {
        const m = key.match(/^filters\[(.+)\]$/)
        if (m && value) filters[m[1]] = value
    }

    // campos calculados: ?calc[Nombre]=expresion
    const calculated: CalculatedFieldDef[] = []
    for (const [key, value] of sp.entries()) {
        const m = key.match(/^calc\[(.+)\]$/)
        if (m && value) calculated.push({ name: m[1], expression: value })
    }

    const baseParams = {
        cliente_id, metrics, dimension, dimension2,
        date_from, date_to, date_grouping, filters, limit, sort,
        calculated: calculated.length ? calculated : undefined,
    }

    try {
        if (type === 'funnel') {
            const data = await runFunnelQuery({ cliente_id, date_from, date_to, filters })
            return NextResponse.json({ data })
        }

        if (type === 'distinct') {
            const data = await runDistinctValues({ cliente_id, dimension, date_from, date_to, filters })
            return NextResponse.json({ data })
        }

        if (type === 'pivot') {
            if (!metrics.length || !dimension2) {
                return NextResponse.json({ error: 'pivot requires metric + dimension2' }, { status: 400 })
            }
            const data = await runPivotQuery(baseParams, metrics[0])
            return NextResponse.json({ data })
        }

        // Dimensión "campaign": cruce real leads/ventas ↔ gasto de campañas.
        if (dimension === 'campaign') {
            if (!cliente_id) {
                return NextResponse.json({ error: 'El cruce por campaña requiere seleccionar un cliente.' }, { status: 400 })
            }
            const data = await runCampaignQuery({ cliente_id, date_from, date_to, filters, limit })
            return NextResponse.json({ data })
        }

        if (!metrics.length) {
            return NextResponse.json({ error: 'metrics is required' }, { status: 400 })
        }

        if (type === 'compare') {
            const data = await runComparison(baseParams)
            return NextResponse.json({ data })
        }

        const data = await runBiQuery(baseParams)
        return NextResponse.json({ data })
    } catch (err) {
        console.error('[bi/query]', err)
        return NextResponse.json({ error: 'Query error' }, { status: 500 })
    }
}
