// Resumen del cruce UTM ↔ campañas para un cliente y un rango.
//
// Alimenta el chip «Cruce 94%» de los widgets y el banner del informe. Devuelve
// SOLO el resumen (dos porcentajes, los métodos y los peores casos), no el
// desglose completo que consume la página `/report-utm/cruce-campanas`: el chip
// se pinta en cada carga de informe y no puede costar lo que cuesta esa página.
//
// La decisión de producto detrás de esto: el cruce sigue siendo automático y el
// usuario no configura nada, pero deja de ser opaco. Cuando algo no cruza, el
// informe lo dice y enlaza a donde se arregla.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { getCrossDiagnostics } from '@/lib/report-utm/campaign-data'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sp = req.nextUrl.searchParams
    const cliente_id = sp.get('cliente_id')
    if (!cliente_id) {
        return NextResponse.json({ error: 'cliente_id is required' }, { status: 400 })
    }

    try {
        const d = await getCrossDiagnostics({
            cliente_id,
            date_from: sp.get('date_from') ?? undefined,
            date_to: sp.get('date_to') ?? undefined,
        })

        const leadsTotal = d.coverage.total
        const leadsSinCruce = d.coverage.methods.none ?? 0

        return NextResponse.json({
            data: {
                // ── Lado de los leads ────────────────────────────────
                leads: {
                    total: leadsTotal,
                    matched: leadsTotal - leadsSinCruce,
                    // `null` y no 0% cuando no hay leads: no es que cruzara mal,
                    // es que no hay nada que cruzar.
                    pct: leadsTotal > 0
                        ? Math.round(((leadsTotal - leadsSinCruce) / leadsTotal) * 1000) / 10
                        : null,
                    methods: d.coverage.methods,
                },
                // ── Lado del gasto (nuevo) ───────────────────────────
                spend: d.spend,
                // ── Los peores casos, para el tooltip y el panel ─────
                unmatchedTop: d.suggestions.slice(0, 8).map(s => ({
                    field: s.field, value: s.value, leads: s.count,
                    suggestion: s.suggestion?.campaign_name ?? null,
                    confidence: s.suggestion?.confidence ?? null,
                })),
                // UTMs que NO son mapeables (macros sin renderizar, vacíos): son
                // un problema de datos en origen, no de mapeo, y conviene
                // separarlas para no ofrecer un arreglo que no existe.
                invalidTop: d.invalid.slice(0, 8),
            },
        }, { headers: { 'Cache-Control': 'private, max-age=60' } })
    } catch (err) {
        console.error('[bi/cross-summary]', err)
        return NextResponse.json({ error: 'Cross summary error' }, { status: 500 })
    }
}
