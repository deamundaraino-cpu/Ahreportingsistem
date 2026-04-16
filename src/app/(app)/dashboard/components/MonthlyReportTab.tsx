'use client'

import { useEffect, useState, useMemo } from 'react'
import { useParams } from 'next/navigation'
import {
    AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
    TrendingUp, TrendingDown, Minus, DollarSign, Users, Eye,
    MousePointerClick, Target, BarChart3, Share2, Download,
    Award, AlertCircle, Megaphone, ChevronLeft, ChevronRight, Calendar
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface ReportData {
    client: { name: string; logo_url: string | null; currency: string; roas_target: number }
    summary: {
        spend: number; reach: number; impressions: number; clicks: number
        results: number; leads: number; purchases: number
        cpa: number | null; roas: number | null; ctr: number | null; cpm: number | null
    }
    daily: { date: string; spend: number; results: number }[]
    campaigns: {
        name: string; spend: number; reach: number; impressions: number
        clicks: number; ctr: number; cpa: number | null; results: number
        roasStatus: 'good' | 'warning' | 'bad' | 'neutral'
    }[]
    spend_distribution: { name: string; value: number; pct: number }[]
    audience: {
        by_age: { group: string; spend_pct: number; results_pct: number }[]
        by_gender: { gender: string; spend_pct: number; results_pct: number }[]
    }
    creatives: {
        top: { name: string; thumbnail_url: string | null; cpa: number | null; ctr: number; results: number }[]
        bottom: { name: string; thumbnail_url: string | null; cpa: number | null; ctr: number; results: number }[]
    }
    previous_month: { spend: number; results: number; cpa: number | null; roas: number | null; ctr: number | null; reach: number }
    notes: string | null
}

const BRAND_BLUE = '#1E3A5F'
const BRAND_GOLD = '#F4A800'
const PIE_COLORS = ['#1E3A5F', '#F4A800', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#6B7280']

function fmt(n: number | null | undefined, decimals = 2, prefix = '', suffix = '') {
    if (n === null || n === undefined) return '—'
    return `${prefix}${n.toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`
}
function pct(n: number | null | undefined) { return fmt(n, 2, '', '%') }

function variation(current: number | null, previous: number | null, invertColors = false) {
    if (current === null || previous === null || previous === 0) return null
    const diff = ((current - previous) / previous) * 100
    const isPositive = diff > 0
    const isGood = invertColors ? !isPositive : isPositive
    return { diff: parseFloat(diff.toFixed(1)), isPositive, isGood }
}

function VarBadge({ v }: { v: ReturnType<typeof variation> }) {
    if (!v) return <span className="text-gray-400 text-xs">—</span>
    const color = v.isGood ? 'text-emerald-600' : 'text-red-500'
    const Icon = v.isPositive ? TrendingUp : TrendingDown
    return (
        <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${color}`}>
            <Icon className="w-3 h-3" />
            {Math.abs(v.diff)}%
        </span>
    )
}

function KpiCard({ label, value, varVal, icon: Icon, accent = false }: {
    label: string; value: string
    varVal?: ReturnType<typeof variation>
    icon: React.ElementType
    accent?: boolean
}) {
    return (
        <div className={`rounded-2xl p-5 border ${accent ? 'bg-[#1E3A5F] border-[#1E3A5F] text-white' : 'bg-white border-gray-100 text-gray-900'} shadow-sm`}>
            <div className="flex items-start justify-between mb-3">
                <p className={`text-xs font-semibold uppercase tracking-wider ${accent ? 'text-blue-200' : 'text-gray-400'}`}>{label}</p>
                <div className={`p-1.5 rounded-lg ${accent ? 'bg-white/10' : 'bg-[#1E3A5F]/5'}`}>
                    <Icon className={`w-4 h-4 ${accent ? 'text-[#F4A800]' : 'text-[#1E3A5F]'}`} />
                </div>
            </div>
            <p className="text-2xl font-bold tracking-tight mb-1">{value}</p>
            {varVal !== undefined && <VarBadge v={varVal} />}
        </div>
    )
}

function Skeleton({ className = '' }: { className?: string }) {
    return <div className={`animate-pulse bg-gray-200 rounded-lg ${className}`} />
}

type SortKey = 'name' | 'spend' | 'impressions' | 'clicks' | 'ctr' | 'cpa' | 'results'

// ── Main Component ─────────────────────────────────────────────────────────────

export function MonthlyReportTab({ clientId: clientIdProp }: { clientId: string }) {
    // Use URL param as primary source to match what the dashboard itself uses
    const params = useParams<{ clientId?: string }>()
    const clientId = params?.clientId || clientIdProp
    const now = new Date()
    const [selectedYear, setSelectedYear] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())
    const [selectedMonth, setSelectedMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth())

    const [data, setData] = useState<ReportData | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sortKey, setSortKey] = useState<SortKey>('spend')
    const [sortAsc, setSortAsc] = useState(false)
    const [copied, setCopied] = useState(false)
    const [generated, setGenerated] = useState(false)

    const periodoLabel = useMemo(() => {
        try {
            return format(
                parseISO(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`),
                'MMMM yyyy',
                { locale: es }
            )
        } catch { return `${selectedMonth}/${selectedYear}` }
    }, [selectedYear, selectedMonth])

    function prevMonth() {
        if (selectedMonth === 1) { setSelectedMonth(12); setSelectedYear(y => y - 1) }
        else setSelectedMonth(m => m - 1)
        setData(null); setGenerated(false)
    }

    function nextMonth() {
        const nowY = new Date().getFullYear(); const nowM = new Date().getMonth() + 1
        if (selectedYear === nowY && selectedMonth === nowM) return
        if (selectedMonth === 12) { setSelectedMonth(1); setSelectedYear(y => y + 1) }
        else setSelectedMonth(m => m + 1)
        setData(null); setGenerated(false)
    }

    function generateReport() {
        setLoading(true)
        setError(null)
        setData(null)
        fetch(`/api/reports/monthly?clientId=${clientId}&year=${selectedYear}&month=${selectedMonth}`)
            .then(r => r.json())
            .then(d => { if (d.error) setError(d.error); else setData(d) })
            .catch(e => setError(e.message))
            .finally(() => { setLoading(false); setGenerated(true) })
    }

    const sortedCampaigns = useMemo(() => {
        if (!data) return []
        return [...data.campaigns].sort((a, b) => {
            const av = a[sortKey] ?? (sortAsc ? Infinity : -Infinity)
            const bv = b[sortKey] ?? (sortAsc ? Infinity : -Infinity)
            return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
        })
    }, [data, sortKey, sortAsc])

    function toggleSort(key: SortKey) {
        if (sortKey === key) setSortAsc(a => !a)
        else { setSortKey(key); setSortAsc(false) }
    }

    function SortTh({ col, label }: { col: SortKey; label: string }) {
        const active = sortKey === col
        return (
            <th
                className={`px-3 py-3 text-right text-xs font-semibold cursor-pointer select-none whitespace-nowrap
                    ${active ? 'text-[#1E3A5F]' : 'text-gray-400 hover:text-gray-600'}`}
                onClick={() => toggleSort(col)}
            >
                {label} {active ? (sortAsc ? '↑' : '↓') : ''}
            </th>
        )
    }

    function handleShare() {
        const url = `${window.location.origin}/report/${clientId}/monthly/${selectedYear}/${selectedMonth}`
        navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
    }

    function handlePrint() { window.print() }

    function rowBg(status: string) {
        if (status === 'good') return 'bg-emerald-50/60'
        if (status === 'warning') return 'bg-amber-50/60'
        if (status === 'bad') return 'bg-red-50/40'
        return ''
    }

    const isCurrentOrFuture = (() => {
        const nowY = new Date().getFullYear(); const nowM = new Date().getMonth() + 1
        return selectedYear > nowY || (selectedYear === nowY && selectedMonth >= nowM)
    })()

    return (
        <div className="space-y-6">
            {/* ── Selector de Mes ──────────────────────────────────────────── */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
                    <div>
                        <h3 className="text-white font-semibold text-lg flex items-center gap-2">
                            <Calendar className="w-5 h-5 text-[#F4A800]" />
                            Reporte Mensual
                        </h3>
                        <p className="text-zinc-400 text-sm mt-0.5">Selecciona el período y genera el reporte completo del cliente</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {/* Month navigator */}
                        <div className="flex items-center gap-2 bg-zinc-800 rounded-xl px-3 py-2 border border-zinc-700">
                            <button
                                onClick={prevMonth}
                                className="p-1 text-zinc-400 hover:text-white transition rounded"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-white font-semibold capitalize min-w-[140px] text-center text-sm">
                                {periodoLabel}
                            </span>
                            <button
                                onClick={nextMonth}
                                disabled={isCurrentOrFuture}
                                className="p-1 text-zinc-400 hover:text-white transition rounded disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                        <button
                            onClick={generateReport}
                            disabled={loading}
                            className="flex items-center gap-2 px-5 py-2.5 bg-[#1E3A5F] hover:bg-[#16304f] text-white font-semibold text-sm rounded-xl transition disabled:opacity-60 disabled:cursor-not-allowed shadow"
                        >
                            {loading ? (
                                <>
                                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Generando...
                                </>
                            ) : (
                                <>
                                    <BarChart3 className="w-4 h-4" />
                                    Generar Reporte
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Estado inicial ──────────────────────────────────────────── */}
            {!generated && !loading && (
                <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30">
                    <BarChart3 className="w-12 h-12 text-zinc-600 mb-4" />
                    <p className="text-zinc-400 text-lg font-medium">Selecciona un período y haz clic en <strong className="text-white">Generar Reporte</strong></p>
                    <p className="text-zinc-600 text-sm mt-1">El reporte completo del cliente aparecerá aquí</p>
                </div>
            )}

            {/* ── Cargando ────────────────────────────────────────────────── */}
            {loading && (
                <div className="space-y-6">
                    <Skeleton className="h-32 w-full" />
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-28" />)}
                    </div>
                    <Skeleton className="h-64 w-full" />
                    <Skeleton className="h-96 w-full" />
                </div>
            )}

            {/* ── Error ───────────────────────────────────────────────────── */}
            {error && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                    <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
                    <p className="text-gray-500">{error}</p>
                </div>
            )}

            {/* ── Reporte completo ─────────────────────────────────────────── */}
            {data && !loading && (
                <div className="bg-gray-50 rounded-3xl font-sans print:bg-white">
                    <div className="max-w-5xl mx-auto px-4 py-10 space-y-10 print:py-4 print:space-y-6">

                        {/* BLOQUE 1: Header */}
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 print:shadow-none">
                            <div className="flex items-center gap-5">
                                {data.client.logo_url
                                    ? <img src={data.client.logo_url} alt={data.client.name} className="h-16 w-16 object-contain rounded-xl border border-gray-100" />
                                    : (
                                        <div className="h-16 w-16 rounded-xl bg-[#1E3A5F] flex items-center justify-center">
                                            <Megaphone className="w-8 h-8 text-[#F4A800]" />
                                        </div>
                                    )
                                }
                                <div>
                                    <p className="text-sm text-gray-400 font-medium">Reporte Mensual de Rendimiento</p>
                                    <h1 className="text-2xl md:text-3xl font-bold text-[#1E3A5F] capitalize">{data.client.name}</h1>
                                    <p className="text-gray-500 capitalize mt-0.5">{periodoLabel}</p>
                                </div>
                            </div>
                            <div className="flex flex-col items-start md:items-end gap-2">
                                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 text-[#1E3A5F] text-xs font-semibold border border-blue-100">
                                    <div className="w-2 h-2 rounded-full bg-[#1E3A5F]" /> Meta Ads
                                </span>
                                <p className="text-xs text-gray-400">Generado el {format(new Date(), "d 'de' MMMM, yyyy", { locale: es })}</p>
                                <div className="flex gap-2 print:hidden">
                                    <button
                                        onClick={handleShare}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition"
                                    >
                                        <Share2 className="w-3.5 h-3.5" />
                                        {copied ? '¡Copiado!' : 'Compartir'}
                                    </button>
                                    <button
                                        onClick={handlePrint}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#1E3A5F] text-white hover:bg-[#16304f] transition"
                                    >
                                        <Download className="w-3.5 h-3.5" /> PDF
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* BLOQUE 2: KPI Cards */}
                        <div>
                            <h2 className="text-lg font-bold text-[#1E3A5F] mb-4">Resumen Ejecutivo</h2>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <KpiCard label="Inversión Total" accent value={fmt(data.summary.spend, 2, `${data.client.currency} `)} varVal={variation(data.summary.spend, data.previous_month.spend, false)} icon={DollarSign} />
                                <KpiCard label="Resultados" value={data.summary.results.toLocaleString('es-MX')} varVal={variation(data.summary.results, data.previous_month.results)} icon={Target} />
                                <KpiCard label="CPA" value={fmt(data.summary.cpa, 2, `${data.client.currency} `)} varVal={variation(data.summary.cpa, data.previous_month.cpa, true)} icon={BarChart3} />
                                <KpiCard label="CTR" value={pct(data.summary.ctr)} varVal={variation(data.summary.ctr, data.previous_month.ctr)} icon={MousePointerClick} />
                                <KpiCard label="Alcance" value={data.summary.reach.toLocaleString('es-MX')} varVal={variation(data.summary.reach, data.previous_month.reach)} icon={Users} />
                                <KpiCard label="Impresiones" value={data.summary.impressions.toLocaleString('es-MX')} icon={Eye} />
                                <KpiCard label="CPM" value={fmt(data.summary.cpm, 2, `${data.client.currency} `)} icon={DollarSign} />
                                {data.summary.roas !== null
                                    ? <KpiCard label="ROAS" value={fmt(data.summary.roas, 2, '', 'x')} icon={TrendingUp} />
                                    : <KpiCard label="Clics" value={data.summary.clicks.toLocaleString('es-MX')} icon={MousePointerClick} />
                                }
                            </div>
                        </div>

                        {/* BLOQUE 3: Evolución diaria */}
                        {data.daily.length > 0 && (
                            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                <h2 className="text-lg font-bold text-[#1E3A5F] mb-1">Evolución Diaria</h2>
                                <p className="text-xs text-gray-400 mb-5">Gasto y resultados por día del mes</p>
                                <ResponsiveContainer width="100%" height={260}>
                                    <AreaChart data={data.daily} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="tabGradSpend" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor={BRAND_BLUE} stopOpacity={0.15} />
                                                <stop offset="95%" stopColor={BRAND_BLUE} stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="tabGradResults" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor={BRAND_GOLD} stopOpacity={0.2} />
                                                <stop offset="95%" stopColor={BRAND_GOLD} stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
                                        <XAxis dataKey="date" tickFormatter={d => { try { return format(parseISO(d), 'd MMM', { locale: es }) } catch { return d } }} tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
                                        <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
                                        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
                                        <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 12 }} labelFormatter={d => { try { return format(parseISO(d as string), "d 'de' MMMM", { locale: es }) } catch { return d as string } }} formatter={(value: any, name: string) => [name === 'spend' ? `$${Number(value).toFixed(2)}` : value, name === 'spend' ? 'Gasto' : 'Resultados']} />
                                        <Area yAxisId="left" type="monotone" dataKey="spend" stroke={BRAND_BLUE} strokeWidth={2} fill="url(#tabGradSpend)" dot={false} />
                                        <Area yAxisId="right" type="monotone" dataKey="results" stroke={BRAND_GOLD} strokeWidth={2} fill="url(#tabGradResults)" dot={false} />
                                        <Legend formatter={n => n === 'spend' ? 'Gasto' : 'Resultados'} iconType="circle" iconSize={8} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        )}

                        {/* BLOQUE 4: Tabla de campañas */}
                        {data.campaigns.length > 0 && (
                            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden print:shadow-none">
                                <div className="p-6 pb-3">
                                    <h2 className="text-lg font-bold text-[#1E3A5F]">Rendimiento por Campaña</h2>
                                    <p className="text-xs text-gray-400 mt-0.5">Haz clic en los encabezados para ordenar</p>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-gray-100 bg-gray-50/80">
                                                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-600 whitespace-nowrap" onClick={() => toggleSort('name')}>
                                                    Campaña {sortKey === 'name' ? (sortAsc ? '↑' : '↓') : ''}
                                                </th>
                                                <SortTh col="spend" label="Inversión" />
                                                <SortTh col="impressions" label="Impresiones" />
                                                <SortTh col="clicks" label="Clics" />
                                                <SortTh col="ctr" label="CTR" />
                                                <SortTh col="cpa" label="CPA" />
                                                <SortTh col="results" label="Resultados" />
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-50">
                                            {sortedCampaigns.map((c, i) => (
                                                <tr key={i} className={`${rowBg(c.roasStatus)} hover:bg-gray-50/60 transition`}>
                                                    <td className="px-4 py-3 text-gray-800 font-medium max-w-[240px]"><span className="block truncate">{c.name}</span></td>
                                                    <td className="px-3 py-3 text-right text-gray-700 font-mono">${c.spend.toFixed(2)}</td>
                                                    <td className="px-3 py-3 text-right text-gray-500 font-mono">{c.impressions.toLocaleString('es-MX')}</td>
                                                    <td className="px-3 py-3 text-right text-gray-500 font-mono">{c.clicks.toLocaleString('es-MX')}</td>
                                                    <td className="px-3 py-3 text-right text-gray-500 font-mono">{c.ctr.toFixed(2)}%</td>
                                                    <td className="px-3 py-3 text-right font-mono">
                                                        {c.cpa !== null
                                                            ? <span className={c.roasStatus === 'good' ? 'text-emerald-600' : c.roasStatus === 'bad' ? 'text-red-500' : 'text-amber-600'}>${c.cpa.toFixed(2)}</span>
                                                            : <span className="text-gray-300">—</span>
                                                        }
                                                    </td>
                                                    <td className="px-3 py-3 text-right text-[#1E3A5F] font-bold font-mono">{c.results}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot>
                                            <tr className="bg-[#1E3A5F]/5 border-t-2 border-[#1E3A5F]/10">
                                                <td className="px-4 py-3 text-[#1E3A5F] font-bold text-sm">Totales</td>
                                                <td className="px-3 py-3 text-right font-bold font-mono text-[#1E3A5F]">${data.summary.spend.toFixed(2)}</td>
                                                <td className="px-3 py-3 text-right font-mono text-gray-600">{data.summary.impressions.toLocaleString('es-MX')}</td>
                                                <td className="px-3 py-3 text-right font-mono text-gray-600">{data.summary.clicks.toLocaleString('es-MX')}</td>
                                                <td className="px-3 py-3 text-right font-mono text-gray-600">{data.summary.ctr !== null ? `${data.summary.ctr.toFixed(2)}%` : '—'}</td>
                                                <td className="px-3 py-3 text-right font-mono text-gray-600">{data.summary.cpa !== null ? `$${data.summary.cpa.toFixed(2)}` : '—'}</td>
                                                <td className="px-3 py-3 text-right font-bold font-mono text-[#1E3A5F]">{data.summary.results}</td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* BLOQUE 5: Distribución del presupuesto */}
                        {data.spend_distribution.length > 1 && (
                            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                <h2 className="text-lg font-bold text-[#1E3A5F] mb-1">Distribución del Presupuesto</h2>
                                <p className="text-xs text-gray-400 mb-5">Gasto por campaña</p>
                                <div className="flex flex-col md:flex-row items-center gap-8">
                                    <div className="flex-shrink-0">
                                        <ResponsiveContainer width={220} height={220}>
                                            <PieChart>
                                                <Pie data={data.spend_distribution} cx="50%" cy="50%" innerRadius={60} outerRadius={95} paddingAngle={2} dataKey="value">
                                                    {data.spend_distribution.map((_, i) => (
                                                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Gasto']} contentStyle={{ borderRadius: 10, fontSize: 12 }} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                    <div className="flex-1 space-y-2">
                                        {data.spend_distribution.map((item, i) => (
                                            <div key={i} className="flex items-center gap-3">
                                                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                                                <span className="flex-1 text-sm text-gray-700 truncate">{item.name}</span>
                                                <span className="text-sm font-semibold text-gray-900 font-mono">{item.pct}%</span>
                                                <span className="text-xs text-gray-400 font-mono w-24 text-right">${item.value.toFixed(2)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* BLOQUE 6: Audiencia */}
                        {(data.audience.by_age.length > 0 || data.audience.by_gender.length > 0) && (
                            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                <h2 className="text-lg font-bold text-[#1E3A5F] mb-5">Análisis de Audiencia</h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    {data.audience.by_age.length > 0 && (
                                        <div>
                                            <p className="text-sm font-semibold text-gray-500 mb-3">Por Edad</p>
                                            <ResponsiveContainer width="100%" height={180}>
                                                <BarChart data={data.audience.by_age} layout="vertical" margin={{ left: 8, right: 8 }}>
                                                    <XAxis type="number" tick={{ fontSize: 10, fill: '#9CA3AF' }} tickLine={false} axisLine={false} unit="%" />
                                                    <YAxis type="category" dataKey="group" tick={{ fontSize: 11, fill: '#6B7280' }} tickLine={false} axisLine={false} width={50} />
                                                    <Tooltip formatter={(v: any, n: string) => [`${v}%`, n === 'spend_pct' ? 'Gasto' : 'Resultados']} contentStyle={{ fontSize: 12, borderRadius: 10 }} />
                                                    <Bar dataKey="spend_pct" fill={BRAND_BLUE} radius={[0, 3, 3, 0]} name="Gasto" />
                                                    <Bar dataKey="results_pct" fill={BRAND_GOLD} radius={[0, 3, 3, 0]} name="Resultados" />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    )}
                                    {data.audience.by_gender.length > 0 && (
                                        <div>
                                            <p className="text-sm font-semibold text-gray-500 mb-3">Por Género</p>
                                            <ResponsiveContainer width="100%" height={180}>
                                                <BarChart data={data.audience.by_gender} layout="vertical" margin={{ left: 8, right: 8 }}>
                                                    <XAxis type="number" tick={{ fontSize: 10, fill: '#9CA3AF' }} tickLine={false} axisLine={false} unit="%" />
                                                    <YAxis type="category" dataKey="gender" tick={{ fontSize: 11, fill: '#6B7280' }} tickLine={false} axisLine={false} width={80} />
                                                    <Tooltip formatter={(v: any, n: string) => [`${v}%`, n === 'spend_pct' ? 'Gasto' : 'Resultados']} contentStyle={{ fontSize: 12, borderRadius: 10 }} />
                                                    <Bar dataKey="spend_pct" fill={BRAND_BLUE} radius={[0, 3, 3, 0]} name="Gasto" />
                                                    <Bar dataKey="results_pct" fill={BRAND_GOLD} radius={[0, 3, 3, 0]} name="Resultados" />
                                                </BarChart>
                                            </ResponsiveContainer>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* BLOQUE 7: Top/Bottom creatives */}
                        {(data.creatives.top.length > 0 || data.creatives.bottom.length > 0) && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {data.creatives.top.length > 0 && (
                                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                        <div className="flex items-center gap-2 mb-4">
                                            <Award className="w-5 h-5 text-emerald-500" />
                                            <h2 className="text-base font-bold text-gray-800">Top Performers</h2>
                                        </div>
                                        <div className="space-y-3">
                                            {data.creatives.top.map((c, i) => (
                                                <div key={i} className="flex gap-3 p-3 rounded-xl bg-emerald-50/60 border border-emerald-100">
                                                    {c.thumbnail_url
                                                        ? <img src={c.thumbnail_url} className="w-12 h-12 rounded-lg object-cover flex-shrink-0" alt="" />
                                                        : <div className="w-12 h-12 rounded-lg bg-emerald-100 flex-shrink-0 flex items-center justify-center"><Award className="w-5 h-5 text-emerald-500" /></div>
                                                    }
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-semibold text-gray-800 truncate">{c.name}</p>
                                                        <div className="flex gap-3 mt-1">
                                                            <span className="text-[10px] text-gray-500">CPA: <b className="text-emerald-600">{c.cpa !== null ? `$${c.cpa.toFixed(2)}` : '—'}</b></span>
                                                            <span className="text-[10px] text-gray-500">CTR: <b>{c.ctr.toFixed(2)}%</b></span>
                                                            <span className="text-[10px] text-gray-500">Res: <b>{c.results}</b></span>
                                                        </div>
                                                    </div>
                                                    <span className="flex-shrink-0 self-start text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white">TOP</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {data.creatives.bottom.length > 0 && (
                                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                        <div className="flex items-center gap-2 mb-4">
                                            <AlertCircle className="w-5 h-5 text-red-400" />
                                            <h2 className="text-base font-bold text-gray-800">Bajo Rendimiento</h2>
                                        </div>
                                        <div className="space-y-3">
                                            {data.creatives.bottom.map((c, i) => (
                                                <div key={i} className="flex gap-3 p-3 rounded-xl bg-red-50/60 border border-red-100">
                                                    {c.thumbnail_url
                                                        ? <img src={c.thumbnail_url} className="w-12 h-12 rounded-lg object-cover flex-shrink-0" alt="" />
                                                        : <div className="w-12 h-12 rounded-lg bg-red-100 flex-shrink-0 flex items-center justify-center"><AlertCircle className="w-5 h-5 text-red-400" /></div>
                                                    }
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-semibold text-gray-800 truncate">{c.name}</p>
                                                        <div className="flex gap-3 mt-1">
                                                            <span className="text-[10px] text-gray-500">CPA: <b className="text-red-500">{c.cpa !== null ? `$${c.cpa.toFixed(2)}` : '—'}</b></span>
                                                            <span className="text-[10px] text-gray-500">CTR: <b>{c.ctr.toFixed(2)}%</b></span>
                                                            <span className="text-[10px] text-gray-500">Res: <b>{c.results}</b></span>
                                                        </div>
                                                    </div>
                                                    <span className="flex-shrink-0 self-start text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500 text-white">BAJO</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* BLOQUE 8: Comparativo mes anterior */}
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden print:shadow-none">
                            <div className="p-6 pb-3">
                                <h2 className="text-lg font-bold text-[#1E3A5F]">Comparativo Mes Anterior</h2>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-gray-50/80 border-b border-gray-100">
                                            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400">Métrica</th>
                                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400">Mes Anterior</th>
                                            <th className="px-4 py-3 text-right text-xs font-semibold text-[#1E3A5F]">Mes Actual</th>
                                            <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400">Variación</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {[
                                            { label: 'Inversión', prev: data.previous_month.spend, curr: data.summary.spend, fmt: (v: number) => `$${v.toFixed(2)}`, invert: false },
                                            { label: 'Resultados', prev: data.previous_month.results, curr: data.summary.results, fmt: (v: number) => v.toLocaleString('es-MX'), invert: false },
                                            { label: 'CPA', prev: data.previous_month.cpa, curr: data.summary.cpa, fmt: (v: number) => `$${v.toFixed(2)}`, invert: true },
                                            { label: 'CTR', prev: data.previous_month.ctr, curr: data.summary.ctr, fmt: (v: number) => `${v.toFixed(2)}%`, invert: false },
                                            { label: 'Alcance', prev: data.previous_month.reach, curr: data.summary.reach, fmt: (v: number) => v.toLocaleString('es-MX'), invert: false },
                                        ].map(row => {
                                            const v = variation(row.curr, row.prev, row.invert)
                                            return (
                                                <tr key={row.label} className="hover:bg-gray-50/50 transition">
                                                    <td className="px-4 py-3 font-medium text-gray-700">{row.label}</td>
                                                    <td className="px-4 py-3 text-right text-gray-400 font-mono">{row.prev !== null ? row.fmt(row.prev) : '—'}</td>
                                                    <td className="px-4 py-3 text-right font-semibold text-[#1E3A5F] font-mono">{row.curr !== null ? row.fmt(row.curr) : '—'}</td>
                                                    <td className="px-4 py-3 text-right">
                                                        {v ? (
                                                            <span className={`inline-flex items-center gap-1 font-medium ${v.isGood ? 'text-emerald-600' : 'text-red-500'}`}>
                                                                {v.isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                                                                {Math.abs(v.diff)}%
                                                            </span>
                                                        ) : <Minus className="w-3.5 h-3.5 text-gray-300 ml-auto" />}
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* BLOQUE 9: Conclusiones */}
                        {data.notes && (
                            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 print:shadow-none">
                                <h2 className="text-lg font-bold text-[#1E3A5F] mb-4">Conclusiones y Recomendaciones</h2>
                                <div className="prose prose-sm max-w-none text-gray-700 leading-relaxed whitespace-pre-wrap">
                                    {data.notes}
                                </div>
                            </div>
                        )}

                        {/* BLOQUE 10: Footer */}
                        <div className="border-t border-gray-200 pt-8 flex flex-col md:flex-row items-center justify-between gap-4 print:pt-4">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-[#1E3A5F] flex items-center justify-center">
                                    <BarChart3 className="w-4 h-4 text-[#F4A800]" />
                                </div>
                                <div>
                                    <p className="text-xs font-bold text-[#1E3A5F]">AdsHouse</p>
                                    <p className="text-[10px] text-gray-400">adshouse.com</p>
                                </div>
                            </div>
                            <p className="text-xs text-gray-400 text-center">
                                Reporte generado por AdsHouse · {periodoLabel} · {format(new Date(), "d MMM yyyy", { locale: es })}
                            </p>
                            <div className="flex gap-2 print:hidden">
                                <button onClick={handleShare} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition">
                                    <Share2 className="w-3.5 h-3.5" />
                                    {copied ? '¡Copiado!' : 'Compartir enlace'}
                                </button>
                                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#1E3A5F] text-white hover:bg-[#16304f] transition">
                                    <Download className="w-3.5 h-3.5" /> Descargar PDF
                                </button>
                            </div>
                        </div>

                    </div>
                </div>
            )}

            <style>{`
                @media print {
                    @page { margin: 1.5cm; size: A4; }
                    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                    .print\\:hidden { display: none !important; }
                    .print\\:shadow-none { box-shadow: none !important; }
                    .print\\:bg-white { background: white !important; }
                    .print\\:py-4 { padding-top: 1rem !important; padding-bottom: 1rem !important; }
                    .print\\:space-y-6 > * + * { margin-top: 1.5rem !important; }
                    .print\\:pt-4 { padding-top: 1rem !important; }
                }
            `}</style>
        </div>
    )
}
