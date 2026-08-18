'use client'

import { useEffect, useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import type { BiFilters, WidgetConfig, ConditionalRule, CalculatedField } from '../BiTypes'
import type { BiMetric, BiDimension, BiQueryRow } from '@/lib/report-utm/bi-metadata'
import {
    METRIC_META, DIMENSION_META, applyValueFilters, unifiedTarget,
    fieldMetricLabel, fieldMetricFormat, fieldDimLabel, leadFieldLabel, isFieldMetric, parseFieldMetric,
    isAdditiveMetric,
    isOfflineFieldMetric, parseOfflineFieldMetric, offlineFieldLabel, offlineFieldFormat,
    isSheetToken, sheetFieldLabel, sheetFieldFormat,
    isLeadSegMetric, leadSegLabel,
} from '@/lib/report-utm/bi-metadata'
import { useBiQueryBase } from '../BiQueryContext'
import { appendWidgetFilters, widgetFilterSignature } from '../widgetQuery'
import { readUnavailable, UnavailableNote } from '../widgetDiagnostics'
import type { WidgetUnavailable } from '../widgetDiagnostics'

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

/** `decimals` (campos calculados) fija los decimales y desactiva el abreviado k/M. */
function fmtVal(value: number | null | undefined, format: ColFormat, decimals?: number): string {
    if (value === null || value === undefined) return '—'
    if (decimals !== undefined) {
        const n = value.toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        if (format === 'currency') return `$${n}`
        if (format === 'percent')  return `${n}%`
        if (format === 'ratio')    return `${n}x`
        return n
    }
    if (format === 'currency') return `$${value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    if (format === 'percent')  return `${value.toFixed(1)}%`
    if (format === 'ratio')    return `${value.toFixed(2)}x`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`
    return Math.round(value).toLocaleString('es-AR')
}

export function TableWidget({ title, config, filters, calculatedFields = [], h = 1 }: Props) {
    const queryBase = useBiQueryBase()
    // Una sola firma para todo lo que obliga a recargar: filtros del informe +
    // filtro propio del widget. Ver widgetQuery.ts.
    const filterSig = widgetFilterSignature(filters, config)
    const [rows, setRows]     = useState<BiQueryRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError]   = useState<string | null>(null)
    const [sortKey, setSortKey] = useState<string | null>(null)
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>(config.sort === 'asc' ? 'asc' : 'desc')
    /** Motivo de la primera columna que no se pudo medir, si hay alguna. */
    const [naInfo, setNaInfo] = useState<WidgetUnavailable | null>(null)

    const rawMetrics = config.metric ?? 'leads_count'
    const colKeys = rawMetrics.split(',').map(s => s.trim()).filter(Boolean)
    const dimension = config.dimension ?? 'utm_source'
    const rowLimit = config.limit ?? 100
    const showTotals = config.show_totals !== false // por defecto sí
    const conditional = config.conditional ?? []

    // separa métricas base, campos calculados y métricas de campo (fieldagg:)
    const calcMap = new Map(calculatedFields.map(c => [c.name, c]))
    const baseMetrics = colKeys.filter(k => METRIC_META[k as BiMetric]) as BiMetric[]
    const fieldMetricCols = colKeys.filter(isFieldMetric)
    // Columnas adicionales de Sheets offline (offfield:<tipo>:<clave>).
    const offlineFieldCols = colKeys.filter(isOfflineFieldMetric)
    // Campos y vistas de Sheet (sheetagg:/sheetview:).
    const sheetCols = colKeys.filter(isSheetToken)
    // Segmentos de campo de lead (leadseg:<clave>).
    const leadSegCols = colKeys.filter(isLeadSegMetric)
    const usedCalc = colKeys.filter(k => calcMap.has(k)).map(k => calcMap.get(k)!)

    function colLabel(key: string): string {
        return METRIC_META[key as BiMetric]?.label
            ?? fieldMetricLabel(key)
            ?? offlineFieldLabel(key)
            ?? sheetFieldLabel(key)
            ?? leadSegLabel(key)
            ?? calcMap.get(key)?.name ?? key
    }
    function colFormat(key: string): ColFormat {
        return (METRIC_META[key as BiMetric]?.format
            ?? calcMap.get(key)?.format
            ?? fieldMetricFormat(key)
            ?? offlineFieldFormat(key)
            ?? sheetFieldFormat(key)
            ?? 'number') as ColFormat
    }

    useEffect(() => {
        setLoading(true)
        setError(null)

        // Las dimensiones que cruzan con el reporting (campaña / anuncio /
        // conjunto) resuelven los UTM contra las campañas reales del cliente. Sin
        // cliente no hay contra qué resolver: el motor devolvería los UTM crudos y
        // el gasto en 0, que es justo la confusión que hay que evitar.
        if (unifiedTarget(dimension) !== null && !filters.cliente_id) {
            setRows([]); setLoading(false)
            setError('Selecciona un cliente en los filtros para cruzar con las campañas.')
            return
        }

        const params = new URLSearchParams({
            // `sheetCols` faltaba aquí: se calculaba arriba y se leía abajo, pero
            // nunca se PEDÍA al motor, así que una columna de campo de Sheet
            // llegaba siempre vacía. Los segmentos de lead caerían en el mismo
            // agujero, así que entran los dos.
            metrics: [...baseMetrics, ...fieldMetricCols, ...offlineFieldCols, ...sheetCols, ...leadSegCols].join(','),
            dimension,
            limit: String(rowLimit),
            sort: config.sort === 'asc' ? 'asc' : 'desc',
        })
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendWidgetFilters(params, filters, config)
        for (const c of usedCalc) params.set(`calc[${c.name}]`, c.expression)

        fetch(`${queryBase}?${params}`)
            .then(r => r.json())
            .then(json => {
                setRows(Array.isArray(json.data) ? json.data : [])
                // Una tabla mezcla columnas de varias fuentes, así que es donde
                // más se nota: se explica la primera columna que no se pudo
                // medir en vez de dejar una columna entera de ceros.
                setNaInfo(readUnavailable(json.meta, colKeys))
            })
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    }, [queryBase, rawMetrics, dimension, rowLimit, config.sort, filterSig])

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
        const sumOf = (key: string) => filteredRows.reduce((s, r) => s + Number(r[key] ?? 0), 0)
        for (const m of baseMetrics) {
            if (isAdditiveMetric(m)) t[m] = round2(sumOf(m))
        }
        // Bases de los ratios: puede que no sean columnas visibles de la tabla
        // (una tabla de solo CPL igual necesita gasto y leads para el total).
        const base = (key: string) => (key in t ? t[key] : sumOf(key))
        const spend = base('spend')
        const leads = base('leads_count')
        const sales = base('sales_count')
        const revenue = base('revenue')
        const clicks = base('clicks')
        const impressions = base('impressions')

        // ratios derivados
        if (colKeys.includes('cpl'))  t.cpl  = leads ? round2(spend / leads) : 0
        if (colKeys.includes('cpa'))  t.cpa  = sales ? round2(spend / sales) : 0
        if (colKeys.includes('roas')) t.roas = spend ? round2(revenue / spend) : 0
        if (colKeys.includes('conversion_rate')) t.conversion_rate = leads ? round2((sales / leads) * 100) : 0
        if (colKeys.includes('cpc'))  t.cpc  = clicks ? round2(spend / clicks) : 0
        if (colKeys.includes('cpm'))  t.cpm  = impressions ? round2((spend / impressions) * 1000) : 0
        if (colKeys.includes('ctr'))  t.ctr  = impressions ? round2((clicks / impressions) * 100) : 0
        // Variantes Hotmart: mismos ratios sobre la facturación agregada.
        if (colKeys.includes('hotmart_roas') || colKeys.includes('hotmart_cpa') || colKeys.includes('hotmart_roi')) {
            const hRevenue = base('hotmart_revenue')
            const hSales = base('hotmart_sales')
            if (colKeys.includes('hotmart_roas')) t.hotmart_roas = spend ? round2(hRevenue / spend) : 0
            if (colKeys.includes('hotmart_cpa'))  t.hotmart_cpa  = hSales ? round2(spend / hSales) : 0
            if (colKeys.includes('hotmart_roi'))  t.hotmart_roi  = spend ? round2(((hRevenue - spend) / spend) * 100) : 0
        }
        // La frecuencia necesita alcance, que NO es sumable entre filas (personas
        // únicas se contarían dos veces) → se deja sin total en la fila Total.
        // Métricas de campo: solo suma y respuestas (count) son aditivas por fila.
        for (const key of fieldMetricCols) {
            const agg = parseFieldMetric(key)?.agg
            if (agg === 'sum' || agg === 'count') {
                t[key] = round2(filteredRows.reduce((s, r) => s + Number(r[key] ?? 0), 0))
            }
        }
        // Columnas de Sheet: conteos e importes suman; los porcentajes no.
        for (const key of offlineFieldCols) {
            if (parseOfflineFieldMetric(key)?.type !== 'percentage') {
                t[key] = round2(filteredRows.reduce((s, r) => s + Number(r[key] ?? 0), 0))
            }
        }
        // Campos de Sheet: solo los conteos y las sumas se pueden totalizar; un
        // promedio o un extremo sumados fila a fila darían un número inventado.
        for (const key of sheetCols) {
            if (isAdditiveMetric(key)) {
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

    const dimLabel = DIMENSION_META[dimension as BiDimension]?.label ?? leadFieldLabel(dimension) ?? fieldDimLabel(dimension) ?? dimension

    return (
        <div className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col h-full">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Por {dimLabel}</p>
                    {/* Va en la cabecera y no al pie: en una tabla larga el
                        motivo tiene que verse sin hacer scroll hasta el final. */}
                    {!loading && !error && <div className="mt-1"><UnavailableNote info={naInfo} /></div>}
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
                                        <span className="inline-flex items-center gap-1.5">
                                            {row.dimension_value ?? '(total)'}
                                            {/* Sin cruce: este UTM no resolvió a ninguna campaña/anuncio real,
                                                así que su gasto en 0 es un mapeo pendiente, no un dato. */}
                                            {row.__nocross === 1 && (
                                                <span
                                                    title="Este valor no cruza con ninguna campaña del reporting, así que no tiene gasto asociado. Mapéalo en Cruce de campañas."
                                                    className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                                                    aria-label="sin cruce con campañas"
                                                />
                                            )}
                                        </span>
                                    </td>
                                    {colKeys.map(key => {
                                        const v = row[key] as number | null | undefined
                                        return (
                                            <td key={key} className={`px-5 py-2.5 text-right text-xs font-mono tabular-nums text-foreground/90 ${cellColor(key, v)}`}>
                                                {fmtVal(v, colFormat(key), calcMap.get(key)?.decimals)}
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
                                            {key in totals ? fmtVal(totals[key], colFormat(key), calcMap.get(key)?.decimals) : '—'}
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
