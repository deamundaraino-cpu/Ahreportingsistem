import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import { RevenueTrendChart, SourceDistributionChart } from '@/components/report-utm/AttributionCharts'
import { RunAggregateButton } from '@/components/report-utm/RunAggregateButton'
import {
    DollarSign,
    ShoppingBag,
    TrendingUp,
    Users,
    Filter,
    BarChart2,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

type SearchParams = {
    clienteId?: string
    days?: string
}

type Row = {
    cliente_id: string
    sale_timestamp: string | null
    received_at: string
    amount: number | string
    status: string
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
}

export default async function AtribucionPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const sp = await searchParams
    const supabase = await reportUtmClient()

    const days = Math.max(1, Math.min(180, parseInt(sp.days ?? '7', 10) || 7))
    const sinceISO = new Date(Date.now() - days * 86400_000).toISOString()

    const { data: clientes } = await supabase
        .from('clientes')
        .select('id, nombre, slug, config')
        .order('nombre')

    type Cliente = { id: string; nombre: string; slug: string; config?: { currency?: string } | null }
    const clientesList = (clientes ?? []) as Cliente[]

    let query = supabase
        .from('sales_events')
        .select('cliente_id, sale_timestamp, received_at, amount, status, utm_source, utm_medium, utm_campaign')
        .gte('received_at', sinceISO)

    if (sp.clienteId) query = query.eq('cliente_id', sp.clienteId)

    const { data: events, error } = await query.limit(50000)
    const list = (events ?? []) as Row[]

    // Solo aprobadas para revenue
    const approved = list.filter((r) => r.status === 'approved')

    const totalEvents = list.length
    const totalRevenue = approved.reduce((s, r) => s + Number(r.amount ?? 0), 0)
    const aov = approved.length > 0 ? totalRevenue / approved.length : 0
    const distinctSources = new Set(approved.map((r) => r.utm_source ?? 'directo')).size

    // Trend por día (revenue + sales)
    const trendMap = new Map<string, { revenue: number; sales: number }>()
    for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - (days - 1 - i) * 86400_000)
        const key = d.toISOString().slice(0, 10)
        trendMap.set(key, { revenue: 0, sales: 0 })
    }
    for (const r of approved) {
        const ts = r.sale_timestamp ?? r.received_at
        const day = new Date(ts).toISOString().slice(0, 10)
        const entry = trendMap.get(day)
        if (entry) {
            entry.revenue += Number(r.amount ?? 0)
            entry.sales += 1
        }
    }
    const trend = Array.from(trendMap.entries()).map(([day, v]) => ({
        day: day.slice(5), // MM-DD
        revenue: Number(v.revenue.toFixed(2)),
        sales: v.sales,
    }))

    // Distribución por source
    const sourceMap = new Map<string, { revenue: number; sales: number }>()
    for (const r of approved) {
        const key = r.utm_source || 'directo'
        const e = sourceMap.get(key) ?? { revenue: 0, sales: 0 }
        e.revenue += Number(r.amount ?? 0)
        e.sales += 1
        sourceMap.set(key, e)
    }
    const sourceDist = Array.from(sourceMap.entries())
        .map(([source, v]) => ({ source, revenue: Number(v.revenue.toFixed(2)), sales: v.sales }))
        .sort((a, b) => b.revenue - a.revenue)

    // Matriz UTM source × campaign
    type Cell = {
        source: string
        campaign: string
        sales: number
        revenue: number
        refunds: number
        refundsAmount: number
    }
    const matrix = new Map<string, Cell>()
    for (const r of list) {
        const source = r.utm_source || 'directo'
        const campaign = r.utm_campaign || '(sin campaña)'
        const key = `${source}||${campaign}`
        let cell = matrix.get(key)
        if (!cell) {
            cell = { source, campaign, sales: 0, revenue: 0, refunds: 0, refundsAmount: 0 }
            matrix.set(key, cell)
        }
        const amt = Number(r.amount ?? 0)
        if (r.status === 'approved') {
            cell.sales += 1
            cell.revenue += amt
        } else if (r.status === 'refunded' || r.status === 'chargeback') {
            cell.refunds += 1
            cell.refundsAmount += amt
        }
    }
    const matrixRows = Array.from(matrix.values()).sort((a, b) => b.revenue - a.revenue)

    const currency = clientesList.find((c) => c.id === sp.clienteId)?.config?.currency ?? 'BRL'

    const buildHref = (override: Partial<SearchParams>) => {
        const merged = { ...sp, ...override }
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(merged)) if (v) params.set(k, String(v))
        const qs = params.toString()
        return `/report-utm/atribucion${qs ? `?${qs}` : ''}`
    }

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        Report-UTM · Fase 2
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
                        Atribución UTM
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Últimos {days} días · {totalEvents.toLocaleString()} eventos
                        {sp.clienteId
                            ? ` · ${clientesList.find((c) => c.id === sp.clienteId)?.nombre ?? ''}`
                            : ' · todos los clientes'}
                    </p>
                </div>
                <RunAggregateButton clienteId={sp.clienteId} hours={days * 24} />
            </div>

            {/* Filtros */}
            <form
                method="GET"
                className="rounded-2xl border border-border bg-card p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <p className="text-xs font-medium text-muted-foreground">Filtros</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <SelectField label="Cliente" name="clienteId" defaultValue={sp.clienteId ?? ''}>
                        <option value="">Todos los clientes</option>
                        {clientesList.map((c) => (
                            <option key={c.id} value={c.id}>{c.nombre}</option>
                        ))}
                    </SelectField>
                    <SelectField label="Rango" name="days" defaultValue={String(days)}>
                        <option value="1">Últimas 24h</option>
                        <option value="7">Últimos 7 días</option>
                        <option value="14">Últimos 14 días</option>
                        <option value="30">Últimos 30 días</option>
                        <option value="90">Últimos 90 días</option>
                    </SelectField>
                    <div className="flex items-end gap-2">
                        <button
                            type="submit"
                            className="px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm nav-active-emerald"
                        >
                            Aplicar
                        </button>
                        <Link
                            href="/report-utm/atribucion"
                            className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors"
                        >
                            Limpiar
                        </Link>
                    </div>
                </div>
            </form>

            {error && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <p className="text-[11px] font-mono text-amber-800 dark:text-amber-300">{error.message}</p>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Stat label="Eventos" value={totalEvents.toLocaleString()} icon={ShoppingBag} />
                <Stat label="Revenue aprobado" value={`${currency} ${totalRevenue.toFixed(2)}`} icon={DollarSign} />
                <Stat label="Ticket promedio" value={`${currency} ${aov.toFixed(2)}`} icon={TrendingUp} />
                <Stat label="Sources distintas" value={String(distinctSources)} icon={Users} />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-4">
                        Revenue diario
                    </h3>
                    <RevenueTrendChart data={trend} currency={currency} />
                </div>
                <div className="rounded-2xl border border-border bg-card p-5">
                    <h3 className="text-sm font-semibold text-foreground mb-4">
                        Distribución por source
                    </h3>
                    <SourceDistributionChart data={sourceDist} />
                </div>
            </div>

            {/* Top sources */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">
                        Top sources
                    </h2>
                </div>
                {sourceDist.length > 0 ? (
                    <table className="w-full">
                        <thead className="bg-muted/60">
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                <th className="px-6 py-3">Source</th>
                                <th className="px-6 py-3 text-right">Ventas</th>
                                <th className="px-6 py-3 text-right">Revenue</th>
                                <th className="px-6 py-3 text-right">AOV</th>
                                <th className="px-6 py-3 text-right">% del total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {sourceDist.map((s) => {
                                const pct = totalRevenue > 0 ? (s.revenue / totalRevenue) * 100 : 0
                                const sourceAov = s.sales > 0 ? s.revenue / s.sales : 0
                                return (
                                    <tr key={s.source} className="hover:bg-accent">
                                        <td className="px-6 py-3 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                                            {s.source}
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                                            {s.sales.toLocaleString()}
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs font-semibold text-foreground">
                                            {currency} {s.revenue.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                                            {currency} {sourceAov.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                                            <div className="flex items-center gap-2 justify-end">
                                                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                                    <div
                                                        className="h-full bg-emerald-500"
                                                        style={{ width: `${Math.min(100, pct)}%` }}
                                                    />
                                                </div>
                                                <span className="font-mono text-[11px] w-10 text-right">
                                                    {pct.toFixed(1)}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                ) : (
                    <EmptyTableMsg />
                )}
            </div>

            {/* Matriz UTM */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-2">
                        <BarChart2 className="h-4 w-4 text-emerald-500" />
                        <h2 className="text-sm font-semibold text-foreground">
                            Matriz UTM source × campaign
                        </h2>
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono">
                        {matrixRows.length} combinaciones
                    </p>
                </div>
                {matrixRows.length > 0 ? (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                        <table className="w-full">
                            <thead className="bg-muted/60 sticky top-0">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <th className="px-6 py-3">Source</th>
                                    <th className="px-6 py-3">Campaign</th>
                                    <th className="px-6 py-3 text-right">Ventas</th>
                                    <th className="px-6 py-3 text-right">Revenue</th>
                                    <th className="px-6 py-3 text-right">AOV</th>
                                    <th className="px-6 py-3 text-right">Reembolsos</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {matrixRows.map((c) => {
                                    const cellAov = c.sales > 0 ? c.revenue / c.sales : 0
                                    return (
                                        <tr key={`${c.source}-${c.campaign}`} className="hover:bg-accent">
                                            <td className="px-6 py-3 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                                                {c.source}
                                            </td>
                                            <td className="px-6 py-3 text-xs font-mono text-foreground/90">
                                                {c.campaign}
                                            </td>
                                            <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                                                {c.sales}
                                            </td>
                                            <td className="px-6 py-3 text-right text-xs font-semibold text-foreground">
                                                {currency} {c.revenue.toFixed(2)}
                                            </td>
                                            <td className="px-6 py-3 text-right text-xs text-muted-foreground">
                                                {currency} {cellAov.toFixed(2)}
                                            </td>
                                            <td className="px-6 py-3 text-right text-xs">
                                                {c.refunds > 0 ? (
                                                    <span className="text-red-600 dark:text-red-400">
                                                        -{currency} {c.refundsAmount.toFixed(2)} ({c.refunds})
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground/70">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <EmptyTableMsg />
                )}
            </div>

            <p className="text-[11px] text-muted-foreground">
                Datos calculados en vivo desde <code className="font-mono px-1 py-0.5 rounded bg-muted">report_utm.sales_events</code>.
                El cron <code className="font-mono px-1 py-0.5 rounded bg-muted">/api/cron/report-utm/aggregate</code> actualiza
                {' '}<code className="font-mono px-1 py-0.5 rounded bg-muted">hourly_metrics</code> cada 15 min para queries más rápidas a futuro.
            </p>
        </div>
    )
}

function Stat({
    label,
    value,
    icon: Icon,
}: {
    label: string
    value: string
    icon: typeof DollarSign
}) {
    return (
        <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                    <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
            </div>
            <p className="mt-3 text-xl font-bold text-foreground truncate">{value}</p>
        </div>
    )
}

function SelectField({
    label,
    name,
    defaultValue,
    children,
}: {
    label: string
    name: string
    defaultValue: string
    children: React.ReactNode
}) {
    return (
        <label className="block">
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</span>
            <select
                name={name}
                defaultValue={defaultValue}
                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
            >
                {children}
            </select>
        </label>
    )
}

function EmptyTableMsg() {
    return (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            Sin datos en este rango. Probá ampliar el rango o aplicar el webhook desde la página del cliente.
        </div>
    )
}
