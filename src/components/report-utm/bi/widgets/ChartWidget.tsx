'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import type { BiFilters, WidgetConfig, WidgetType } from '../BiTypes'
import type { BiMetric, BiDimension, BiQueryRow, BiPivotRow } from '@/lib/report-utm/bi-metadata'
import { METRIC_META, DIMENSION_META, appendUtmFilters, utmFilterSignature } from '@/lib/report-utm/bi-metadata'

const COLORS = [
    '#10b981', '#06b6d4', '#8b5cf6', '#f59e0b',
    '#ef4444', '#3b82f6', '#f97316', '#ec4899', '#14b8a6', '#84cc16',
]

interface Props {
    title: string
    type: WidgetType
    config: WidgetConfig
    filters: BiFilters
    onDrill?: (dimension: string, value: string) => void
}

function fmtNum(value: number, metric: BiMetric): string {
    const m = METRIC_META[metric]
    if (!m) return String(Math.round(value))
    if (m.format === 'currency') return `$${value.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`
    if (m.format === 'percent')  return `${value.toFixed(1)}%`
    if (m.format === 'ratio')    return `${value.toFixed(2)}x`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`
    return Math.round(value).toLocaleString('es-AR')
}

const TOOLTIP_STYLE = { fontSize: 11, borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))' }

export function ChartWidget({ title, type, config, filters, onDrill }: Props) {
    const [rows, setRows]       = useState<BiQueryRow[]>([])
    const [pivot, setPivot]     = useState<{ rows: BiPivotRow[]; seriesKeys: string[] } | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError]     = useState<string | null>(null)

    const metric    = (config.metric as BiMetric) ?? 'leads_count'
    const dimension = (config.dimension as BiDimension) ?? 'utm_source'
    const dimension2 = config.dimension2 && config.dimension2 !== 'none' ? config.dimension2 : undefined
    const grouping  = config.date_grouping ?? 'day'
    const limit     = config.limit ?? 15
    const sort      = config.sort ?? 'desc'
    const baseColor = config.color ?? COLORS[0]
    const usePivot  = !!dimension2 && (type === 'bar' || type === 'combo' || type === 'area' || type === 'line')

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
            metrics: metric,
            dimension,
            date_grouping: grouping,
            limit: String(limit),
            sort,
        })
        if (usePivot && dimension2) { params.set('type', 'pivot'); params.set('dimension2', dimension2) }
        if (filters.cliente_id) params.set('cliente_id', filters.cliente_id)
        if (filters.date_from)  params.set('date_from', filters.date_from)
        if (filters.date_to)    params.set('date_to', filters.date_to)
        appendUtmFilters(params, filters)

        fetch(`/api/report-utm/bi/query?${params}`)
            .then(r => r.json())
            .then(json => {
                if (usePivot) { setPivot(json.data ?? { rows: [], seriesKeys: [] }); setRows([]) }
                else { setRows(json.data ?? []); setPivot(null) }
            })
            .catch(() => setError('Error al cargar'))
            .finally(() => setLoading(false))
    }, [metric, dimension, dimension2, usePivot, grouping, limit, sort, filters.cliente_id, filters.date_from, filters.date_to, utmFilterSignature(filters)])

    const dimLabel = DIMENSION_META[dimension]?.label ?? dimension
    const metLabel = METRIC_META[metric]?.label ?? metric

    const chartData = rows.map(r => ({
        name:  r.dimension_value ?? 'Total',
        value: Number(r[metric as keyof BiQueryRow] ?? 0),
    }))

    function handleClick(name: string) {
        if (onDrill && dimension !== 'date' && dimension !== 'none') onDrill(dimension, name)
    }

    return (
        <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-4 h-full">
            <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">{title}</p>
                <span className="text-[10px] text-muted-foreground font-mono">
                    {dimLabel}{dimension2 ? ` × ${DIMENSION_META[dimension2]?.label}` : ''} · {metLabel}
                </span>
            </div>

            {loading ? (
                <div className="flex-1 flex items-center justify-center min-h-[180px]">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : error ? (
                <p className="text-xs text-red-500">{error}</p>
            ) : usePivot && pivot ? (
                pivot.rows.length === 0
                    ? <Empty />
                    : <PivotChartBody type={type} pivot={pivot} metric={metric} />
            ) : chartData.length === 0 ? (
                <Empty />
            ) : type === 'line' ? (
                <LineChartBody data={chartData} metric={metric} color={baseColor} />
            ) : type === 'area' ? (
                <AreaChartBody data={chartData} metric={metric} color={baseColor} />
            ) : type === 'bar' || type === 'combo' ? (
                <BarChartBody data={chartData} metric={metric} color={baseColor} onClick={handleClick} />
            ) : type === 'scatter' ? (
                <ScatterChartBody data={chartData} metric={metric} color={baseColor} />
            ) : type === 'pie' ? (
                <PieChartBody data={chartData} metric={metric} onClick={handleClick} />
            ) : null}
        </div>
    )
}

function Empty() {
    return <p className="text-xs text-muted-foreground text-center py-8">Sin datos en este rango</p>
}

function LineChartBody({ data, metric, color }: { data: { name: string; value: number }[]; metric: BiMetric; color: string }) {
    return (
        <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.5} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false}
                    tickFormatter={v => fmtNum(Number(v), metric)} />
                <Tooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} />
                <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
        </ResponsiveContainer>
    )
}

function AreaChartBody({ data, metric, color }: { data: { name: string; value: number }[]; metric: BiMetric; color: string }) {
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
                    tickFormatter={v => fmtNum(Number(v), metric)} />
                <Tooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#grad-${color.replace('#', '')})`} />
            </AreaChart>
        </ResponsiveContainer>
    )
}

function BarChartBody({ data, metric, color, onClick }: { data: { name: string; value: number }[]; metric: BiMetric; color: string; onClick?: (n: string) => void }) {
    const top = data.slice(0, 15)
    return (
        <ResponsiveContainer width="100%" height={Math.max(180, top.length * 28)}>
            <BarChart data={top} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.4} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false}
                    tickFormatter={v => fmtNum(Number(v), metric)} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} onClick={(d: { name?: string }) => d?.name && onClick?.(d.name)} cursor={onClick ? 'pointer' : undefined}>
                    {top.map((_, i) => <Cell key={i} fill={color === COLORS[0] ? COLORS[i % COLORS.length] : color} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    )
}

function ScatterChartBody({ data, metric, color }: { data: { name: string; value: number }[]; metric: BiMetric; color: string }) {
    const points = data.map((d, i) => ({ x: i + 1, y: d.value, name: d.name }))
    return (
        <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.4} />
                <XAxis type="number" dataKey="x" name="#" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                <YAxis type="number" dataKey="y" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false}
                    tickFormatter={v => fmtNum(Number(v), metric)} />
                <ZAxis range={[60, 60]} />
                <Tooltip
                    formatter={(v: number) => fmtNum(v, metric)}
                    labelFormatter={() => ''}
                    contentStyle={TOOLTIP_STYLE}
                    cursor={{ strokeDasharray: '3 3' }}
                />
                <Scatter data={points} fill={color} />
            </ScatterChart>
        </ResponsiveContainer>
    )
}

function PieChartBody({ data, metric, onClick }: { data: { name: string; value: number }[]; metric: BiMetric; onClick?: (n: string) => void }) {
    const top = data.slice(0, 8)
    return (
        <ResponsiveContainer width="100%" height={220}>
            <PieChart>
                <Pie data={top} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={44} paddingAngle={2}
                    onClick={(d: { name?: string }) => d?.name && onClick?.(d.name)} cursor={onClick ? 'pointer' : undefined}>
                    {top.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <PieTooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
            </PieChart>
        </ResponsiveContainer>
    )
}

// ── Pivot (dimensión secundaria): apilado / combo ─────────────────────
function PivotChartBody({ type, pivot, metric }: { type: WidgetType; pivot: { rows: BiPivotRow[]; seriesKeys: string[] }; metric: BiMetric }) {
    const data = pivot.rows.map(r => ({ name: r.dimension_value, ...r.series }))
    const keys = pivot.seriesKeys

    if (type === 'line' || type === 'area') {
        const Chart = type === 'area' ? AreaChart : LineChart
        return (
            <ResponsiveContainer width="100%" height={220}>
                <Chart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" strokeOpacity={0.5} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={v => fmtNum(Number(v), metric)} />
                    <Tooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
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
                <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} className="text-muted-foreground" tickLine={false} axisLine={false} tickFormatter={v => fmtNum(Number(v), metric)} />
                <Tooltip formatter={(v: number) => fmtNum(v, metric)} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                {keys.map((k, i) => (
                    <Bar key={k} dataKey={k} stackId="a" fill={COLORS[i % COLORS.length]} radius={i === keys.length - 1 ? [4, 4, 0, 0] : undefined} />
                ))}
            </ChartComp>
        </ResponsiveContainer>
    )
}
