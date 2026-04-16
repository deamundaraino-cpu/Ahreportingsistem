'use client'

import {
    AreaChart, Area,
    BarChart, Bar,
    LineChart, Line,
    PieChart, Pie, Cell,
    RadarChart, Radar, PolarGrid, PolarAngleAxis,
    ScatterChart, Scatter, ZAxis,
    ComposedChart,
    RadialBarChart, RadialBar,
    FunnelChart, Funnel, LabelList,
    XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend
} from 'recharts'
import { evaluateFormula } from '@/lib/formula-engine'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import type { ChartDef } from '@/lib/layout-types'

// ─── Palette ──────────────────────────────────────────────────────────────────
const PALETTE: Record<string, string> = {
    amber:   '#f59e0b', cyan:    '#22d3ee', blue:    '#60a5fa',
    violet:  '#a78bfa', emerald: '#34d399', rose:    '#fb7185',
    orange:  '#fb923c', red:     '#f87171', green:   '#4ade80',
    indigo:  '#818cf8', pink:    '#f472b6', teal:    '#2dd4bf',
    lime:    '#a3e635', sky:     '#38bdf8', purple:  '#c084fc',
}
const DEFAULT_COLORS = ['amber', 'cyan', 'violet', 'emerald', 'rose', 'blue', 'orange', 'pink', 'teal', 'lime']

function hex(name: string) { return PALETTE[name] ?? '#94a3b8' }

// ─── Labels ───────────────────────────────────────────────────────────────────
const FORMULA_LABELS: Record<string, string> = {
    meta_spend: 'Gasto Meta', meta_leads: 'Leads Meta',
    meta_clicks: 'Clics', meta_impressions: 'Impresiones',
    meta_reach: 'Alcance', meta_results: 'Resultados',
    meta_purchases: 'Compras', meta_link_clicks: 'Clics Enlace',
    meta_landing_page_views: 'Landing Views', meta_video_views: 'Video Views',
    hotmart_pagos_iniciados: 'Pagos Iniciados',
    ventas_principal: 'Ventas Principal', ventas_bump: 'Ventas Bump',
    ventas_upsell: 'Ventas Upsell',
    ga_sessions: 'Sesiones GA4', ga_bounce_rate: 'Rebote GA4',
    ga_avg_session_duration: 'Duración GA4',
}
function getLabel(f: string) { return FORMULA_LABELS[f] || f }

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n: number): string {
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
    return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1)
}

// ─── Daily data builder ───────────────────────────────────────────────────────
function buildDailyData(metrics: any[], formulas: string[], varContext: Record<string, number> = {}): Array<Record<string, any>> {
    return metrics
        .filter((r: any) => r.fecha)
        .map((row: any) => {
            const pt: Record<string, any> = {
                date: format(parseISO(row.fecha), 'dd MMM', { locale: es }),
            }
            formulas.forEach(f => {
                const v = evaluateFormula(f, row, varContext)
                pt[getLabel(f)] = v === null || isNaN(v as number) ? 0 : (v as number)
            })
            return pt
        })
}

// ─── Shared axis / grid styles ────────────────────────────────────────────────
const TICK  = { fill: '#71717a', fontSize: 11 }
const GRID  = { stroke: 'rgba(255,255,255,0.05)', strokeDasharray: '3 3' }
const CURVE = 'monotone' as const

// ─── Custom tooltip ───────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null
    return (
        <div style={{
            background: '#09090b', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10, padding: '10px 14px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)', minWidth: 140,
        }}>
            {label && (
                <p style={{ color: '#52525b', fontSize: 10, textTransform: 'uppercase',
                    letterSpacing: '0.1em', fontWeight: 700, marginBottom: 8 }}>
                    {label}
                </p>
            )}
            {payload.map((e: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.color || e.fill, flexShrink: 0 }} />
                    <span style={{ color: '#a1a1aa', fontSize: 11, flex: 1 }}>{e.name}</span>
                    <span style={{ color: '#f4f4f5', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
                        {fmt(e.value)}
                    </span>
                </div>
            ))}
        </div>
    )
}

// ─── Chart type badge labels ──────────────────────────────────────────────────
const TYPE_LABELS: Record<string, string> = {
    area: '📉 Área', stacked_area: '📈 Área Apilada', bar: '📊 Barras',
    stacked_bar: '📋 Apiladas', line: '— Líneas', donut: '🍢 Rosquilla',
    pie: '🥧 Torta', composed: '📹 Compuesto', radial: '🎯 Radial',
    scatter: '⭐ Dispersión', funnel: '🔻 Embudo',
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface MetricChartsProps {
    charts: ChartDef[]
    metrics: any[]
    weeks?: any[]
    varContext?: Record<string, number>
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export function MetricCharts({ charts, metrics, varContext = {} }: MetricChartsProps) {
    if (!charts?.length) return null

    return (
        <div className="space-y-4 mb-6">
            {charts.map(chart => {
                const formulas = chart.valueFormulas.filter(Boolean)
                if (!formulas.length) return null

                const categories = formulas.map(getLabel)
                const colors = (chart.colors?.length ? chart.colors : DEFAULT_COLORS)
                    .slice(0, categories.length).map(hex)

                const data     = buildDailyData(metrics, formulas, varContext)
                const lastRow  = data[data.length - 1] ?? {}

                // Pie / donut / funnel / radial use aggregated totals per metric
                const totalByCategory = categories.map((cat, i) => ({
                    name: cat,
                    value: data.reduce((s, r) => s + (r[cat] ?? 0), 0),
                    color: colors[i],
                }))

                return (
                    <div key={chart.id}
                        className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-lg">
                        {/* Header */}
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <h3 className="text-sm font-semibold text-zinc-100">{chart.title}</h3>
                                <div className="flex flex-wrap gap-3 mt-1.5">
                                    {categories.map((cat, i) => (
                                        <span key={cat} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors[i], display: 'inline-block', flexShrink: 0 }} />
                                            {cat}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 text-[10px] text-zinc-500">
                                <span className="border border-zinc-800 px-2 py-0.5 rounded font-mono">
                                    {TYPE_LABELS[chart.type] ?? chart.type}
                                </span>
                                <span>{data.length} días</span>
                            </div>
                        </div>

                        {/* Chart */}
                        <div className="chart-dark-wrapper">
                            <ChartBody
                                type={chart.type} data={data}
                                categories={categories} colors={colors}
                                totals={totalByCategory} chartId={chart.id}
                            />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

// ─── Chart body switcher ──────────────────────────────────────────────────────
function ChartBody({ type, data, categories, colors, totals, chartId }: {
    type: string
    data: Array<Record<string, any>>
    categories: string[]
    colors: string[]
    totals: { name: string; value: number; color: string }[]
    chartId: string
}) {
    const H = 240

    // Recharts does not always render children properly if they are wrapped in a Fragment,
    // so we inline CartesianGrid, XAxis, YAxis, and Tooltip in each chart.
    if (type === 'area') return (
        <ResponsiveContainer width="100%" height={H}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                    {categories.map((_, i) => (
                        <linearGradient key={i} id={`ag-${chartId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={colors[i]} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={colors[i]} stopOpacity={0.02} />
                        </linearGradient>
                    ))}
                </defs>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />
                {categories.map((cat, i) => (
                    <Area key={cat} type={CURVE} dataKey={cat} stroke={colors[i]} strokeWidth={2}
                        fill={`url(#ag-${chartId}-${i})`} dot={false}
                        activeDot={{ r: 4, fill: colors[i], strokeWidth: 0 }} />
                ))}
            </AreaChart>
        </ResponsiveContainer>
    )

    if (type === 'stacked_area') return (
        <ResponsiveContainer width="100%" height={H}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                    {categories.map((_, i) => (
                        <linearGradient key={i} id={`sag-${chartId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={colors[i]} stopOpacity={0.5} />
                            <stop offset="95%" stopColor={colors[i]} stopOpacity={0.1} />
                        </linearGradient>
                    ))}
                </defs>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />
                {categories.map((cat, i) => (
                    <Area key={cat} type={CURVE} dataKey={cat} stackId="s" stroke={colors[i]} strokeWidth={1.5}
                        fill={`url(#sag-${chartId}-${i})`} dot={false}
                        activeDot={{ r: 4, fill: colors[i], strokeWidth: 0 }} />
                ))}
            </AreaChart>
        </ResponsiveContainer>
    )

    if (type === 'bar') return (
        <ResponsiveContainer width="100%" height={H}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barGap={4}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                {categories.map((cat, i) => (
                    <Bar key={cat} dataKey={cat} fill={colors[i]} radius={[3, 3, 0, 0]} maxBarSize={36} />
                ))}
            </BarChart>
        </ResponsiveContainer>
    )

    if (type === 'stacked_bar') return (
        <ResponsiveContainer width="100%" height={H}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                {categories.map((cat, i) => (
                    <Bar key={cat} dataKey={cat} stackId="s" fill={colors[i]}
                        radius={i === categories.length - 1 ? [3, 3, 0, 0] : [0,0,0,0]} maxBarSize={48} />
                ))}
            </BarChart>
        </ResponsiveContainer>
    )

    if (type === 'line') return (
        <ResponsiveContainer width="100%" height={H}>
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />
                {categories.map((cat, i) => (
                    <Line key={cat} type={CURVE} dataKey={cat} stroke={colors[i]} strokeWidth={2}
                        dot={false} activeDot={{ r: 4, fill: colors[i], strokeWidth: 0 }} />
                ))}
            </LineChart>
        </ResponsiveContainer>
    )

    if (type === 'composed') return (
        <ResponsiveContainer width="100%" height={H}>
            <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                {categories.map((cat, i) =>
                    i === 0
                        ? <Bar key={cat} dataKey={cat} fill={colors[i]} radius={[3, 3, 0, 0]} maxBarSize={36} opacity={0.85} />
                        : <Line key={cat} type={CURVE} dataKey={cat} stroke={colors[i]} strokeWidth={2}
                            dot={false} activeDot={{ r: 4, fill: colors[i], strokeWidth: 0 }} />
                )}
            </ComposedChart>
        </ResponsiveContainer>
    )

    if (type === 'donut' || type === 'pie') return (
        <ResponsiveContainer width="100%" height={H}>
            <PieChart>
                <Pie
                    data={totals}
                    cx="50%" cy="50%"
                    innerRadius={type === 'donut' ? '52%' : 0}
                    outerRadius="78%"
                    dataKey="value" nameKey="name"
                    paddingAngle={type === 'donut' ? 3 : 1}
                >
                    {totals.map((t, i) => (
                        <Cell key={t.name} fill={colors[i]} stroke="transparent" />
                    ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend
                    formatter={(v) => <span style={{ color: '#a1a1aa', fontSize: 11 }}>{v}</span>}
                    iconType="circle" iconSize={8}
                />
            </PieChart>
        </ResponsiveContainer>
    )

    if (type === 'radial') return (
        <ResponsiveContainer width="100%" height={H}>
            <RadialBarChart
                cx="50%" cy="50%" innerRadius="20%" outerRadius="90%"
                data={totals.map((t, i) => ({ ...t, fill: colors[i] }))}
                startAngle={90} endAngle={-270}
            >
                <PolarGrid gridType="circle" stroke="rgba(255,255,255,0.05)" />
                <RadialBar dataKey="value" background={{ fill: 'rgba(255,255,255,0.03)' }}
                    cornerRadius={4} label={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                    formatter={(v) => <span style={{ color: '#a1a1aa', fontSize: 11 }}>{v}</span>}
                    iconType="circle" iconSize={8}
                />
            </RadialBarChart>
        </ResponsiveContainer>
    )

    if (type === 'scatter') {
        const [catX, catY] = categories
        const colX = colors[0], colY = colors[1] ?? colors[0]
        const scatterData = data.map(d => ({ x: d[catX] ?? 0, y: d[catY] ?? 0, date: d.date }))
        return (
            <ResponsiveContainer width="100%" height={H}>
                <ScatterChart margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="x" type="number" name={catX ?? 'X'} tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                    <YAxis dataKey="y" type="number" name={catY ?? 'Y'} tickFormatter={fmt} tick={TICK} axisLine={false} tickLine={false} width={52} />
                    <ZAxis range={[40, 40]} />
                    <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.1)' }} />
                    <Scatter data={scatterData} fill={colX} opacity={0.8} />
                </ScatterChart>
            </ResponsiveContainer>
        )
    }

    if (type === 'funnel') {
        const funnelData = totals.map((t, i) => ({
            name: t.name, value: t.value, fill: colors[i],
        }))
        return (
            <ResponsiveContainer width="100%" height={H}>
                <FunnelChart>
                    <Tooltip content={<CustomTooltip />} />
                    <Funnel dataKey="value" data={funnelData} isAnimationActive>
                        {funnelData.map((d, i) => (
                            <Cell key={d.name} fill={colors[i]} stroke="transparent" />
                        ))}
                        <LabelList position="center" content={({ value, x, y, width, height }: any) => (
                            <text x={x + (width ?? 0) / 2} y={y + (height ?? 0) / 2 + 1}
                                textAnchor="middle" dominantBaseline="middle"
                                style={{ fill: '#fff', fontSize: 11, fontWeight: 600 }}>
                                {fmt(value)}
                            </text>
                        )} />
                    </Funnel>
                </FunnelChart>
            </ResponsiveContainer>
        )
    }

    return (
        <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">
            Tipo &quot;{type}&quot; no reconocido
        </div>
    )
}
