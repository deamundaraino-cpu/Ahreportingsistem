'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import {
    ResponsiveContainer,
    LineChart, Line,
    AreaChart, Area,
    BarChart, Bar, Cell,
    ComposedChart,
    ScatterChart, Scatter, ZAxis,
    PieChart, Pie, Tooltip as PieTooltip, Legend,
    XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import type { BiFilters, WidgetConfig, WidgetType, CalculatedField } from '../BiTypes'
import { WIDGET_FORMULA_KEY } from '../BiTypes'
import type { BiMetric, BiDimension, BiQueryRow, BiPivotRow } from '@/lib/report-utm/bi-metadata'
import {
    METRIC_META, DIMENSION_META, appendUtmFilters, utmFilterSignature, applyValueFilters,
    appendFieldFilters, fieldFilterSignature, appendAdvancedFilter, advancedFilterSignature,
    appendDimFilters, dimFilterSignature, widgetAdvancedSignature, withCampaignFilter,
    fieldMetricLabel, fieldMetricFormat, fieldDimLabel, isFieldMetric, metricGlossary,
    offlineFieldLabel, offlineFieldFormat, sheetFieldLabel, sheetFieldFormat,
    supportsPivot,
} from '@/lib/report-utm/bi-metadata'
import { useBiQueryBase } from '../BiQueryContext'
import { HelpTip } from '../HelpTip'

const COLORS = [
    '#10b981', '#06b6d4', '#8b5cf6', '#f59e0b',
    '#ef4444', '#3b82f6', '#f97316', '#ec4899', '#14b8a6', '#84cc16',
]

type ColFormat = 'number' | 'currency' | 'percent' | 'ratio'

interface Props {
    title: string
    type: WidgetType
    config: WidgetConfig
    filters: BiFilters
    calculatedFields?: CalculatedField[]
    onDrill?: (dimension: string, value: string) => void
}

function fmtNum(value: number, format: ColFormat): string {
    if (format === 'currency') return `$${value.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`
    if (format === 'percent')  return `${value.toFixed(1)}%`
    if (format === 'ratio')    return `${value.toFixed(2)}x`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`
    return Math.round(value).toLocaleString('es-AR')
}

function truncateLabel(s: string, max = 28): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// Tooltip propio con clases de tema (bg-card/text-foreground) → legible en claro y
// oscuro. Evita depender de hsl(var(--card)) inline (puede no coincidir con el tema).
interface ChartTooltipProps {
    active?: boolean
    payload?: Array<{ name?: string | number; value?: number | string; color?: string }>
    label?: string | number
    format: ColFormat
}
function ChartTooltip({ active, payload, label, format }: ChartTooltipProps) {
    if (!active || !payload || payload.length === 0) return null
    const hasLabel = label !== undefined && label !== null && String(label) !== ''
    return (
        <div className="rounded-lg border border-border bg-card px-2.5 py-1.5 shadow-md text-[11px] max-w-[340px]">
            {hasLabel && (
                <p className="font-medium text-foreground mb-1 break-words">{String(label)}</p>
            )}
            {payload.map((p, i) => {
                const showName = p.name !== undefined && p.name !== 'value'
                return (
                    <div key={i} className="flex items-start gap-1.5">
                        {p.color && <span className="h-2 w-2 rounded-sm shrink-0 mt-1" style={{ background: p.color }} />}
                        {showName && (
                            <span className="text-muted-foreground break-words min-w-0 flex-1">{String(p.name)}</span>
                        )}
                        <span className="text-foreground font-mono tabular-nums ml-auto shrink-0 pl-2">{fmtNum(Number(p.value ?? 0), format)}</span>
                    </div>
                )
            })}
        </div>
    )
}

export function ChartWidget({ title, type, config, filters, calculatedFields = [], onDrill }: Props) {
    const queryBase = useBiQueryBase()
    const [rows, setRows]       = useState<BiQueryRow[]>([])
    const [pivot, setPivot]     = useState<{ rows: BiPivotRow[]; seriesKeys: string[] } | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError]     = useState<string | null>(null)

    // Fórmula propia del widget: manda sobre `metric` y viaja bajo una clave fija.
    const formula   = config.formula?.trim()
    const metric    = formula ? WIDGET_FORMULA_KEY : String(config.metric ?? 'leads_count')
    const dimension = (config.dimension as BiDimension) ?? 'utm_source'
    const dimension2 = config.dimension2 && config.dimension2 !== 'none' ? config.dimension2 : undefined
    const grouping  = config.date_grouping ?? 'day'
    const limit     = config.limit ?? 15
    const sort      = config.sort ?? 'desc'
    const baseColor = config.color ?? COLORS[0]

    // El metric puede ser una métrica base o un campo calculado. El pivot
    // (dimensión secundaria) no soporta calc, así que se usa la ruta estándar.
    const calcField = calculatedFields.find(c => c.name === metric)
    const format: ColFormat = formula
        ? (config.formula_format ?? 'number')
        : ((calcField?.format ?? METRIC_META[metric as BiMetric]?.format ?? fieldMetricFormat(metric) ?? offlineFieldFormat(metric) ?? sheetFieldFormat(metric) ?? 'number') as ColFormat)
    // El pivot (dimensión secundaria) agrupa filas de lead_events/sales_events:
    // solo sabe contar filas o sumar `amount`. Por eso no aplica a campos
    // calculados, ni a métricas de campo, ni a métricas de gasto/campaña/GA4
    // (con esas devolvería un conteo de filas disfrazado). En esos casos se
    // ignora la dimensión secundaria y se usa la ruta estándar.
    const usePivot  = !formula && !calcField && !isFieldMetric(metric) && supportsPivot(metric) && !!dimension2
        && (type === 'bar' || type === 'combo' || type === 'area' || type === 'line')

    useEffect(() => {
        setLoading(true)
        setError(null)

        // El cruce por campaña requiere un cliente seleccionado
        if (dimension === 'campaign' && !filters.cliente_id) {
            setRows([]); setPivot(null); setLoading(false)
            setError('Selecciona un cliente en los filtros para el cruce por campaña.')
            return
        }

        const params = new URLSearchParams({
            // Con fórmula no se piden métricas: el motor deduce qué traer leyendo
            // los identificadores de la expresión.
            metrics: formula ? '' : metric,
            dimension,
            date_grouping: grouping,
            limit: String(limit),
            sort,
        })
        if (formula) params.set(`calc[${WIDGET_FORMULA_KEY}]`, formula)
        if (usePivot && dimension2) { params.set('type', 'pivot'); params.set('dimension2', dimension2) }
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendUtmFilters(params, filters)
        appendFieldFilters(params, filters)
        appendDimFilters(params, filters)
        appendAdvancedFilter(params, filters, withCampaignFilter(config.advanced_filter, config.campaign_filter))
        if (calcField) params.set(`calc[${calcField.name}]`, calcField.expression)

        fetch(`${queryBase}?${params}`)
            .then(r => r.json())
            .then(json => {
                if (usePivot) { setPivot(json.data ?? { rows: [], seriesKeys: [] }); setRows([]) }
                else { setRows(Array.isArray(json.data) ? json.data : []); setPivot(null) }
            })
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    }, [queryBase, metric, formula, calcField?.expression, dimension, dimension2, usePivot, grouping, limit, sort, filters.cliente_id, filters.date_from, filters.date_to, utmFilterSignature(filters), fieldFilterSignature(filters), dimFilterSignature(filters), advancedFilterSignature(filters), widgetAdvancedSignature(withCampaignFilter(config.advanced_filter, config.campaign_filter))])

    const dimLabel = DIMENSION_META[dimension]?.label ?? fieldDimLabel(dimension) ?? dimension
    const metLabel = formula ? formula : (METRIC_META[metric as BiMetric]?.label ?? fieldMetricLabel(metric) ?? offlineFieldLabel(metric) ?? sheetFieldLabel(metric) ?? calcField?.name ?? metric)

    const chartData = applyValueFilters(rows, config.value_filters).map(r => ({
        name:  r.dimension_value ?? 'Total',
        value: Number(r[metric as keyof BiQueryRow] ?? 0),
    }))

    function handleClick(name: string) {
        if (onDrill && dimension !== 'date' && dimension !== 'none') onDrill(dimension, name)
    }

    return (
        <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4 h-full">
            <div className="flex items-center justify-between">
                <p className="flex items-center gap-1 text-sm font-semibold text-foreground">
                    {title}
                    {metricGlossary(String(config.metric ?? '')) && (
                        <HelpTip text={metricGlossary(String(config.metric ?? '')) as string} size={12} />
                    )}
                </p>
                <span className="text-[10px] text-muted-foreground font-mono">
                    {dimLabel}{dimension2 ? ` × ${DIMENSION_META[dimension2 as BiDimension]?.label ?? fieldDimLabel(dimension2) ?? dimension2}` : ''} · {metLabel}
                </span>
            </div>

            {loading ? (
                <Skeleton className="flex-1 min-h-[180px] rounded-xl" />
            ) : error ? (
                <p className="text-xs text-red-500">{error}</p>
            ) : usePivot && pivot ? (
                pivot.rows.length === 0
                    ? <Empty />
                    : <PivotChartBody type={type} pivot={pivot} format={format} />
            ) : chartData.length === 0 ? (
                <Empty />
            ) : type === 'line' ? (
                <LineChartBody data={chartData} format={format} color={baseColor} />
            ) : type === 'area' ? (
                <AreaChartBody data={chartData} format={format} color={baseColor} />
            ) : type === 'bar' || type === 'combo' ? (
                <BarChartBody data={chartData} format={format} color={baseColor} onClick={handleClick} />
            ) : type === 'scatter' ? (
                <ScatterChartBody data={chartData} format={format} color={baseColor} />
            ) : type === 'pie' ? (
                <PieChartBody data={chartData} format={format} onClick={handleClick} />
            ) : null}
        </div>
    )
}

function Empty() {
    return <p className="text-xs text-muted-foreground text-center py-8">Sin datos en este rango</p>
}

function LineChartBody({ data, format, color }: { data: { name: string; value: number }[]; format: ColFormat; color: string }) {
    return (
        <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.5} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false}
                    tickFormatter={v => fmtNum(Number(v), format)} />
                <Tooltip content={<ChartTooltip format={format} />} />
                <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
        </ResponsiveContainer>
    )
}

function AreaChartBody({ data, format, color }: { data: { name: string; value: number }[]; format: ColFormat; color: string }) {
    return (
        <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                    <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                        <stop offset="95%" stopColor={color} stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.5} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false}
                    tickFormatter={v => fmtNum(Number(v), format)} />
                <Tooltip content={<ChartTooltip format={format} />} />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#grad-${color.replace('#', '')})`} />
            </AreaChart>
        </ResponsiveContainer>
    )
}

function BarChartBody({ data, format, color, onClick }: { data: { name: string; value: number }[]; format: ColFormat; color: string; onClick?: (n: string) => void }) {
    const top = data.slice(0, 15)
    return (
        <ResponsiveContainer width="100%" height={Math.max(180, top.length * 28)}>
            <BarChart data={top} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.4} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false}
                    tickFormatter={v => fmtNum(Number(v), format)} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} onClick={(d: { name?: string }) => d?.name && onClick?.(d.name)} cursor={onClick ? 'pointer' : undefined}>
                    {top.map((_, i) => <Cell key={i} fill={color === COLORS[0] ? COLORS[i % COLORS.length] : color} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    )
}

function ScatterChartBody({ data, format, color }: { data: { name: string; value: number }[]; format: ColFormat; color: string }) {
    const points = data.map((d, i) => ({ x: i + 1, y: d.value, name: d.name }))
    return (
        <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.4} />
                <XAxis type="number" dataKey="x" name="#" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis type="number" dataKey="y" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false}
                    tickFormatter={v => fmtNum(Number(v), format)} />
                <ZAxis range={[60, 60]} />
                <Tooltip content={<ChartTooltip format={format} />} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter data={points} fill={color} />
            </ScatterChart>
        </ResponsiveContainer>
    )
}

function PieChartBody({ data, format, onClick }: { data: { name: string; value: number }[]; format: ColFormat; onClick?: (n: string) => void }) {
    const top = data.slice(0, 8)
    return (
        <div className="flex flex-col gap-2 h-full min-h-0">
            <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                    <Pie data={top} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={2}
                        onClick={(d: { name?: string }) => d?.name && onClick?.(d.name)} cursor={onClick ? 'pointer' : undefined}>
                        {top.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="hsl(var(--card))" strokeWidth={1.5} />)}
                    </Pie>
                    <PieTooltip content={<ChartTooltip format={format} />} />
                </PieChart>
            </ResponsiveContainer>
            {/* Leyenda custom: nombres truncados (full en tooltip), valor, theme-aware */}
            <div className="grid grid-cols-1 gap-y-1 overflow-y-auto max-h-32 pr-1">
                {top.map((d, i) => (
                    <button
                        key={d.name}
                        type="button"
                        title={d.name}
                        onClick={() => onClick?.(d.name)}
                        className={`flex items-center gap-2 text-left rounded px-1 py-0.5 ${onClick ? 'hover:bg-accent cursor-pointer' : 'cursor-default'}`}
                    >
                        <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="text-[11px] text-foreground truncate flex-1">{d.name}</span>
                        <span className="text-[11px] text-muted-foreground font-mono tabular-nums shrink-0">{fmtNum(d.value, format)}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}

// ── Pivot (dimensión secundaria): apilado / combo ─────────────────────
function PivotChartBody({ type, pivot, format }: { type: WidgetType; pivot: { rows: BiPivotRow[]; seriesKeys: string[] }; format: ColFormat }) {
    const data = pivot.rows.map(r => ({ name: r.dimension_value, ...r.series }))
    const keys = pivot.seriesKeys

    if (type === 'line' || type === 'area') {
        const Chart = type === 'area' ? AreaChart : LineChart
        return (
            <ResponsiveContainer width="100%" height={220}>
                <Chart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.5} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={v => fmtNum(Number(v), format)} />
                    <Tooltip content={<ChartTooltip format={format} />} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} formatter={(value: string) => <span title={value} className="text-muted-foreground">{truncateLabel(value, 18)}</span>} />
                    {keys.map((k, i) => type === 'area'
                        ? <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.5} />
                        : <Line key={k} type="monotone" dataKey={k} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
                    )}
                </Chart>
            </ResponsiveContainer>
        )
    }

    // bar / combo → barras apiladas
    const ChartComp = type === 'combo' ? ComposedChart : BarChart
    return (
        <ResponsiveContainer width="100%" height={Math.max(200, data.length * 30)}>
            <ChartComp data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.4} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={v => fmtNum(Number(v), format)} />
                <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} formatter={(value: string) => <span title={value} className="text-muted-foreground">{truncateLabel(value, 18)}</span>} />
                {keys.map((k, i) => (
                    <Bar key={k} dataKey={k} stackId="a" fill={COLORS[i % COLORS.length]} radius={i === keys.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
            </ChartComp>
        </ResponsiveContainer>
    )
}
