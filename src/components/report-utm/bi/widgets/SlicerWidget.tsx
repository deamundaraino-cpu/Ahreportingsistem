'use client'

import { useEffect, useState } from 'react'
import { Loader2, Filter, Check } from 'lucide-react'
import type { BiFilters, WidgetConfig } from '../BiTypes'
import type { BiDimension } from '@/lib/report-utm/bi-metadata'
import { DIMENSION_META, fieldDimLabel, leadFieldLabel } from '@/lib/report-utm/bi-metadata'
import { useBiQueryBase } from '../BiQueryContext'

interface Props {
    title: string
    config: WidgetConfig
    filters: BiFilters
    onSetFilter?: (dimension: string, value: string | null) => void
    onSetDateRange?: (from: string, to: string) => void
}

export function SlicerWidget({ title, config, filters, onSetFilter, onSetDateRange }: Props) {
    const queryBase = useBiQueryBase()
    const dimension = (config.dimension as BiDimension) ?? 'utm_source'
    const mode = config.slicer_mode ?? 'dropdown'
    const dimLabel = DIMENSION_META[dimension]?.label ?? leadFieldLabel(dimension) ?? fieldDimLabel(dimension) ?? dimension

    const [values, setValues]   = useState<string[]>([])
    const [loading, setLoading] = useState(mode !== 'daterange')

    useEffect(() => {
        if (mode === 'daterange') { setLoading(false); return }
        setLoading(true)
        const params = new URLSearchParams({ type: 'distinct', dimension })
        if (config.source) params.set('source', config.source)
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        fetch(`${queryBase}?${params}`)
            .then(r => r.json())
            .then(json => setValues(Array.isArray(json.data) ? json.data : []))
            .catch(() => setValues([]))
            .finally(() => setLoading(false))
    }, [queryBase, dimension, mode, config.source, filters.cliente_id, filters.date_from, filters.date_to])

    // valor(es) seleccionados desde el estado global de filtros
    const current = (filters[dimension] ?? '').split(',').map(s => s.trim()).filter(Boolean)

    function selectSingle(v: string) {
        onSetFilter?.(dimension, v || null)
    }

    function toggleMulti(v: string) {
        const next = current.includes(v) ? current.filter(x => x !== v) : [...current, v]
        onSetFilter?.(dimension, next.length ? next.join(',') : null)
    }

    return (
        <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3 h-full">
            <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-emerald-500" />
                <p className="text-xs font-semibold text-foreground">{title || dimLabel}</p>
                {current.length > 0 && (
                    <span className="ml-auto px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-semibold">
                        {current.length}
                    </span>
                )}
            </div>

            {mode === 'daterange' ? (
                <div className="space-y-2">
                    <div>
                        <label className="block text-[10px] text-muted-foreground mb-1">Desde</label>
                        <input
                            type="date" value={filters.date_from ?? ''}
                            onChange={e => onSetDateRange?.(e.target.value, filters.date_to ?? e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                        />
                    </div>
                    <div>
                        <label className="block text-[10px] text-muted-foreground mb-1">Hasta</label>
                        <input
                            type="date" value={filters.date_to ?? ''}
                            onChange={e => onSetDateRange?.(filters.date_from ?? e.target.value, e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                        />
                    </div>
                </div>
            ) : loading ? (
                <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
            ) : mode === 'dropdown' ? (
                <select
                    value={current[0] ?? ''}
                    onChange={e => selectSingle(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                    <option value="">Todos</option>
                    {values.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
            ) : (
                <div className="flex flex-col gap-0.5 overflow-y-auto max-h-[220px] -mx-1">
                    {current.length > 0 && (
                        <button
                            onClick={() => onSetFilter?.(dimension, null)}
                            className="text-left px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                            Limpiar selección
                        </button>
                    )}
                    {values.map(v => {
                        const sel = current.includes(v)
                        return (
                            <button
                                key={v}
                                onClick={() => toggleMulti(v)}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors ${
                                    sel ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-medium' : 'text-foreground hover:bg-accent'
                                }`}
                            >
                                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${sel ? 'bg-emerald-500 border-emerald-500' : 'border-border'}`}>
                                    {sel && <Check className="h-2.5 w-2.5 text-white" />}
                                </span>
                                <span className="truncate">{v}</span>
                            </button>
                        )
                    })}
                    {values.length === 0 && <p className="text-[11px] text-muted-foreground px-2 py-3">Sin valores</p>}
                </div>
            )}
        </div>
    )
}
