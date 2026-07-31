'use client'

import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { BiFilters, WidgetConfig } from '../BiTypes'
import { isLowerBetter } from '@/lib/report-utm/bi-metadata'
import { useBiQueryBase } from '../BiQueryContext'
import { appendWidgetFilters, widgetFilterSignature } from '../widgetQuery'

interface Props {
    title: string
    config: WidgetConfig
    filters: BiFilters
}

// Métricas que alimentan el resumen. Se piden todas de una vez con
// comparación de período, y luego se redactan las frases con las que existan.
const SUMMARY_METRICS = ['spend', 'leads_count', 'cpl', 'sales_count', 'revenue', 'roas'] as const

type Totals = Partial<Record<(typeof SUMMARY_METRICS)[number], number>>

function money(n: number): string {
    return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function count(n: number): string {
    return Math.round(n).toLocaleString('es-AR')
}

/** Variación relativa en %, o null si no es comparable. */
function pctChange(cur: number, prev: number): number | null {
    if (!Number.isFinite(prev) || prev === 0) return null
    return ((cur - prev) / prev) * 100
}

/** "un 12% mejor" / "un 8% peor" según el sentido de la métrica. */
function comparePhrase(metric: string, cur: number, prev: number): string {
    const delta = pctChange(cur, prev)
    if (delta === null || Math.abs(delta) < 1) return 'en línea con el período anterior'
    const better = isLowerBetter(metric) ? delta < 0 : delta > 0
    return `un ${Math.abs(delta).toFixed(0)}% ${better ? 'mejor' : 'peor'} que el período anterior`
}

/** Redacta el resumen en lenguaje simple a partir de los totales. */
export function buildSummarySentences(cur: Totals, prev: Totals): string[] {
    const out: string[] = []

    const spend = cur.spend ?? 0
    const leads = cur.leads_count ?? 0
    const cpl   = cur.cpl ?? 0

    if (spend > 0 || leads > 0) {
        let s = `Se invirtieron ${money(spend)} en publicidad y se consiguieron ${count(leads)} contactos`
        if (cpl > 0) s += ` a un costo promedio de ${money(cpl)} cada uno`
        s += '.'
        out.push(s)
    }

    if (cpl > 0 && (prev.cpl ?? 0) > 0) {
        out.push(`El costo por contacto fue ${comparePhrase('cpl', cpl, prev.cpl ?? 0)}.`)
    } else if (leads > 0 && (prev.leads_count ?? 0) > 0) {
        out.push(`La captación de contactos fue ${comparePhrase('leads_count', leads, prev.leads_count ?? 0)}.`)
    }

    const sales   = cur.sales_count ?? 0
    const revenue = cur.revenue ?? 0
    const roas    = cur.roas ?? 0
    if (sales > 0 || revenue > 0) {
        let s = `Se registraron ${count(sales)} ventas por ${money(revenue)}`
        if (roas > 0) s += `, un retorno de ${roas.toFixed(2)}x sobre lo invertido`
        s += '.'
        out.push(s)
        if (roas > 0 && (prev.roas ?? 0) > 0) {
            out.push(`El retorno de la inversión fue ${comparePhrase('roas', roas, prev.roas ?? 0)}.`)
        }
    }

    if (out.length === 0) out.push('Todavía no hay datos suficientes en este período para generar un resumen.')
    return out
}

/**
 * Resumen ejecutivo: traduce las métricas del período a 2-4 frases en lenguaje
 * simple. El trafficker puede sobreescribir el texto con `config.text` antes de
 * enviar el informe al cliente.
 */
export function SummaryWidget({ title, config, filters }: Props) {
    const queryBase = useBiQueryBase()
    // Una sola firma para todo lo que obliga a recargar: filtros del informe +
    // filtro propio del widget. Ver widgetQuery.ts.
    const filterSig = widgetFilterSignature(filters, config)
    // Texto manual: no se consulta nada (y no hay estado de carga).
    const manual = config.text?.trim()

    const [sentences, setSentences] = useState<string[] | null>(null)
    const [loading, setLoading] = useState(!manual)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (manual) return
        setLoading(true)
        setError(null)

        const params = new URLSearchParams({
            metrics: SUMMARY_METRICS.join(','),
            dimension: 'none',
            type: 'compare',
        })
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendWidgetFilters(params, filters, config)

        fetch(`${queryBase}?${params}`)
            .then(r => r.json())
            .then(json => {
                const cur  = (json.data?.current?.[0] ?? {}) as Totals
                const prev = (json.data?.previous?.[0] ?? {}) as Totals
                setSentences(buildSummarySentences(cur, prev))
            })
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [queryBase, manual, filterSig])

    const accent = config.accent || '#10b981'

    return (
        <div
            className="rounded-2xl border border-border bg-card p-5 h-full"
            style={{ borderLeft: `3px solid ${accent}` }}
        >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-3">
                <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} />
                {title || 'Resumen del período'}
            </p>

            {manual ? (
                <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">{manual}</p>
            ) : loading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">Analizando…</span>
                </div>
            ) : error ? (
                <p className="text-xs text-red-500">{error}</p>
            ) : (
                <ul className="space-y-1.5">
                    {(sentences ?? []).map((s, i) => (
                        <li key={i} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
                            <span style={{ color: accent }}>•</span>
                            <span>{s}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
