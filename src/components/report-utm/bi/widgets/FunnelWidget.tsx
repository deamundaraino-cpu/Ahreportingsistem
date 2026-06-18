'use client'

import { useEffect, useState } from 'react'
import { Loader2, ArrowDown } from 'lucide-react'
import type { BiFilters, WidgetConfig } from '../BiTypes'
import { appendUtmFilters, utmFilterSignature } from '@/lib/report-utm/bi-metadata'

interface Props {
    title: string
    config: WidgetConfig
    filters: BiFilters
}

interface FunnelStage {
    stage: string
    value: number
    label: string
}

function fmtN(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
    return n.toLocaleString('es-AR')
}

const STAGE_COLORS: Record<string, string> = {
    impressions: 'bg-blue-500/20 border-blue-500/40 text-blue-600 dark:text-blue-400',
    clicks:      'bg-cyan-500/20 border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
    leads:       'bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
    sales:       'bg-violet-500/20 border-violet-500/40 text-violet-600 dark:text-violet-400',
}

export function FunnelWidget({ title, config: _, filters }: Props) {
    const [stages, setStages] = useState<FunnelStage[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError]   = useState<string | null>(null)

    useEffect(() => {
        setLoading(true)
        setError(null)

        const params = new URLSearchParams({ type: 'funnel' })
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendUtmFilters(params, filters)

        fetch(`/api/report-utm/bi/query?${params}`)
            .then(r => r.json())
            .then(json => setStages(json.data ?? []))
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    }, [filters.cliente_id, filters.date_from, filters.date_to, utmFilterSignature(filters)])

    const maxVal = stages.length > 0 ? Math.max(...stages.map(s => s.value), 1) : 1

    return (
        <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4 h-full">
            <p className="text-sm font-semibold text-foreground">{title}</p>

            {loading ? (
                <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : error ? (
                <p className="text-xs text-red-500">{error}</p>
            ) : (
                <div className="flex flex-col gap-2">
                    {stages.map((s, i) => {
                        const pct = maxVal > 0 ? (s.value / maxVal) * 100 : 0
                        const convRate = i > 0 && stages[i - 1].value > 0
                            ? ((s.value / stages[i - 1].value) * 100).toFixed(1)
                            : null

                        return (
                            <div key={s.stage}>
                                {i > 0 && (
                                    <div className="flex items-center gap-2 ml-4 my-1">
                                        <ArrowDown className="h-3 w-3 text-muted-foreground/40" />
                                        {convRate !== null && (
                                            <span className="text-[10px] font-mono text-muted-foreground">
                                                {convRate}% conversión
                                            </span>
                                        )}
                                    </div>
                                )}
                                <div className={`rounded-xl border p-3 ${STAGE_COLORS[s.stage] ?? 'bg-muted border-border text-foreground'}`}>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-semibold uppercase tracking-wider">{s.label}</span>
                                        <span className="text-lg font-bold font-mono tabular-nums">{fmtN(s.value)}</span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-current opacity-60 transition-all duration-500"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
