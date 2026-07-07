'use client'

import { useEffect, useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { BiFilters, WidgetConfig, ConditionalRule, CalculatedField } from '../BiTypes'
import type { BiMetric, BiDimension, BiQueryRow } from '@/lib/report-utm/bi-metadata'
import {
    METRIC_META, DIMENSION_META, appendUtmFilters, utmFilterSignature, applyValueFilters,
    appendFieldFilters, fieldFilterSignature, appendAdvancedFilter, advancedFilterSignature,
    appendDimFilters, dimFilterSignature, widgetAdvancedSignature,
    fieldMetricLabel, fieldMetricFormat, fieldDimLabel, isFieldMetric, parseFieldMetric,
} from '@/lib/report-utm/bi-metadata'

interface Props {
    title: string
    config: WidgetConfig
    filters: BiFilters
    calculatedFields?: CalculatedField[]
    /** Alto del widget (1x/2x/3x): escala la altura visible de la tabla antes de scroll. */
    h?: number
}

// Altura visible (px) de la tabla según el "Alto" del widget. Más allá, scroll interno.
const TABLE_MAX_H: Record<number, number> = { 1: 320, 2: 540, 3: 760 }

type ColFormat = 'number' | 'currency' | 'percent' | 'ratio'

function fmtVal(value: number | null | undefined, format: ColFormat): string {
    if (value === null || value === undefined) return '—'
    if (format === 'currency') return `$${value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (format === 'percent')  return `${value.toFixed(1)}%`
    if (format === 'ratio')    return `${value.toFixed(2)}x`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`
    return Math.round(value).toLocaleString('es-AR')
}

const ADDITIVE = new Set(['leads_count', 'sales_count', 'revenue', 'spend', 'clicks', 'impressions'])

export function TableWidget({ title, config, filters, calculatedFields = [], h = 1 }: Props) {
    const [rows, setRows]     = useState<BiQueryRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError]   = useState<string | null>(null)
    const [sortKey, setSortKey] = useState<string | null>(null)
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

    const rawMetrics = config.metric ?? 'leads_count'
    const colKeys = rawMetrics.split(',').map(s => s.trim()).filter(Boolean)
    const dimension = config.dimension ?? 'utm_source'
    const showTotals = config.show_totals !== false // por defecto sí
    const conditional = config.conditional ?? []

    // separa métricas base, campos calculados y métricas de campo (fieldagg:)
    const calcMap = new Map(calculatedFields.map(c => [c.name, c]))
    const baseMetrics = colKeys.filter(k => METRIC_META[k as BiMetric]) as BiMetric[]
    const fieldMetricCols = colKeys.filter(isFieldMetric)
    const usedCalc = colKeys.filter(k => calcMap.has(k)).map(k => calcMap.get(k)!)

    function colLabel(key: string): string {
        return METRIC_META[key as BiMetric]?.label ?? fieldMetricLabel(key) ?? calcMap.get(key)?.name ?? key
    }
    function colFormat(key: string): ColFormat {
        return (METRIC_META[key as BiMetric]?.format ?? calcMap.get(key)?.format ?? fieldMetricFormat(key) ?? 'number') as ColFormat
    }

    useEffect(() => {
        setLoading(true)
        setError(null)

        // El cruce por campaña requiere un cliente seleccionado
        if (dimension === 'campaign' && !filters.cliente_id) {
            setRows([]); setLoading(false)
            setError('Selecciona un cliente en los filtros para el cruce por campaña.')
            return
        }

        const params = new URLSearchParams({
            metrics: [...baseMetrics, ...fieldMetricCols].join(','),
            dimension,
            limit: '100',
        })
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendUtmFilters(params, filters)
        appendFieldFilters(params, filters)
        appendDimFilters(params, filters)
        appendAdvancedFilter(params, filters, config.advanced_filter)
        for (const c of usedCalc) params.set(`calc[${c.name}]`, c.expression)

        fetch(`/api/report-utm/bi/query?${params}`)
            .then(r => r.json())
            .then(json => setRows(json.data ?? []))
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    }, [rawMetrics, dimension, filters.cliente_id, filters.date_from, filters.date_to, utmFilterSignature(filters), fieldFilterSignature(filters), dimFilterSignature(filters), advancedFilterSignature(filters), widgetAdvancedSignature(config.advanced_filter)])

    // Filtros por valor: oculta filas que no cumplan (ej. spend > 0)
    const filteredRows = applyValueFilters(rows, config.value_filters)

    const sorted = [...filteredRows].sort((a, b) => {
        if (!sortKey) return 0
        const av = Number(a[sortKey] ?? 0)
        const bv = Number(b[sortKey] ?? 0)
        return sortDir === 'desc' ? bv - av : av - bv
    })

    function toggleSort(key: string) {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        else { setSortKey(key); setSortDir('desc') }
    }

    // Totales: suma aditivas; ratios se recalculan sobre los totales base.
    function computeTotals(): Record<string, number> {
        const t: Record<string, number> = {}
        for (const m of baseMetrics) {
            if (ADDITIVE.has(m)) t[m] = filteredRows.reduce((s, r) => s + Number(r[m] ?? 0), 0)
        }
        // ratios derivados
        if (colKeys.includes('cpl'))  t.cpl  = t.leads_count ? round2(t.spend / t.leads_count) : 0
        if (colKeys.includes('cpa'))  t.cpa  = t.sales_count ? round2(t.spend / t.sales_count) : 0
        if (colKeys.includes('roas')) t.roas = t.spend ? round2(t.revenue / t.spend) : 0
        if (colKeys.includes('conversion_rate')) t.conversion_rate = t.leads_count ? round2((t.sales_count / t.leads_count) * 100) : 0
        if (colKeys.includes('cpc'))  t.cpc  = t.clicks ? round2(t.spend / t.clicks) : 0
        if (colKeys.includes('cpm'))  t.cpm  = t.impressions ? round2((t.spend / t.impressions) * 1000) : 0
        // Métricas de campo: solo suma y respuestas (count) son aditivas por fila.
        for (const key of fieldMetricCols) {
            const agg = parseFieldMetric(key)?.agg
            if (agg === 'sum' || agg === 'count') {
                t[key] = round2(filteredRows.reduce((s, r) => s + Number(r[key] ?? 0), 0))
            }
        }
        return t
    }
    const totals = showTotals ? computeTotals() : null

    function cellColor(key: string, value: number | null | undefined): string {
        if (value === null || value === undefined) return ''
        const rule = conditional.find(c => c.metric === key)
        if (!rule) return ''
        const hit = rule.op === 'gt' ? value > rule.value : value < rule.value
        if (!hit) return ''
        if (rule.color === 'green') return 'text-emerald-600 dark:text-emerald-400 font-semibold'
        if (rule.color === 'red')   return 'text-red-600 dark:text-red-400 font-semibold'
        return 'text-amber-600 dark:text-amber-400 font-semibold'
    }

    const dimLabel = DIMENSION_META[dimension as BiDimension]?.label ?? fieldDimLabel(dimension) ?? dimension

    return (
        <div className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col h-full">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
                <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Por {dimLabel}</p>
                </div>
                {(config.value_filters?.length ?? 0) > 0 && !loading && !error && (
                    <span className="shrink-0 text-[10px] font-mono text-muted-foreground bg-muted/60 px-2 py-1 rounded-md">
                        {filteredRows.length} de {rows.length} filas
                    </span>
                )}
            </div>

            {loading ? (
                <div className="flex-1 p-4 space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-8 rounded" />
                    ))}
                </div>
            ) : error ? (
                <p className="text-xs text-red-500 p-5">{error}</p>
            ) : sorted.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">Sin datos</p>
            ) : (
                <div className="overflow-auto" style={{ maxHeight: TABLE_MAX_H[h] ?? TABLE_MAX_H[1] }}>
                    <table className="w-full">
                        <thead className="bg-muted/60 sticky top-0">
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                <th className="px-5 py-3">{dimLabel}</th>
                                {colKeys.map(key => (
                                    <th key={key} className="px-5 py-3 text-right cursor-pointer hover:text-foreground" onClick={() => toggleSort(key)}>
                                        <span className="inline-flex items-center gap-1">
                                            {colLabel(key)}
                                            <ArrowUpDown className="h-3 w-3 opacity-50" />
                                        </span>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {sorted.map((row, i) => (
                                <tr key={i} className="hover:bg-accent">
                                    <td className="px-5 py-2.5 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                                        {row.dimension_value ?? '(total)'}
                                    </td>
                                    {colKeys.map(key => {
                                        const v = row[key] as number | null | undefined
                                        return (
                                            <td key={key} className={`px-5 py-2.5 text-right text-xs font-mono tabular-nums text-foreground/90 ${cellColor(key, v)}`}>
                                                {fmtVal(v, colFormat(key))}
                                            </td>
                                        )
                                    })}
                                </tr>
                            ))}
                        </tbody>
                        {totals && (
                            <tfoot className="bg-muted/40 sticky bottom-0 border-t-2 border-border">
                                <tr className="text-xs font-semibold">
                                    <td className="px-5 py-2.5 text-foreground">Total</td>
                                    {colKeys.map(key => (
                                        <td key={key} className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground">
                                            {key in totals ? fmtVal(totals[key], colFormat(key)) : '—'}
                                        </td>
                                    ))}
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            )}
        </div>
    )
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}
