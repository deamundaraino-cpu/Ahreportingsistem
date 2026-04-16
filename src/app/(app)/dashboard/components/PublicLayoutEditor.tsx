'use client'

import { useState, useRef, useCallback } from 'react'
import { savePublicLayout } from '@/app/(app)/admin/settings/_actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    Globe, X, GripVertical, Save, Loader2, Check, Plus, Database, BarChart3, Map
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CardDef, ChartDef, ChartType, CardColor } from '@/lib/layout-types'

// ─── Available Metrics ──────────────────────────────────────────────────────

const AVAILABLE_METRICS = [
    { id: 'meta_spend', label: 'Meta: Gasto' },
    { id: 'meta_impressions', label: 'Meta: Impresiones' },
    { id: 'meta_clicks', label: 'Meta: Clics (Todos)' },
    { id: 'meta_link_clicks', label: 'Meta: Clics en el enlace' },
    { id: 'meta_reach', label: 'Meta: Alcance' },
    { id: 'meta_leads', label: 'Meta: Leads (Pixel)' },
    { id: 'meta_leads_form', label: 'Meta: Clientes potenciales (Formulario)' },
    { id: 'meta_purchases', label: 'Meta: Compras' },
    { id: 'meta_results', label: 'Meta: Resultados' },
    { id: 'meta_landing_page_views', label: 'Meta: Vistas de pág. destino' },
    { id: 'meta_video_views', label: 'Meta: Reproducciones de Video' },
    { id: 'meta_adds_to_cart', label: 'Meta: Artículos al carrito' },
    { id: 'meta_initiates_checkout', label: 'Meta: Pagos Iniciados' },
    { id: 'hotmart_pagos_iniciados', label: 'Hotmart: Checkouts' },
    { id: 'hotmart_pagos_iniciados', label: 'Hotmart: Pagos Inic.' },
    { id: 'ventas_principal', label: 'Ventas (Principal)' },
    { id: 'ventas_bump', label: 'Ventas (Bump)' },
    { id: 'ventas_upsell', label: 'Ventas (Upsell)' },
    { id: 'ga_sessions', label: 'GA4: Sesiones' },
    { id: 'ga_bounce_rate', label: 'GA4: Tasa de Rebote' },
    { id: 'ga_avg_session_duration', label: 'GA4: Duración M. Sesión' },
    // ── Google Sheets · Leads ──────────────────────────────────────────────
    { id: 'leads_totales',        label: 'GSheets: Leads Totales' },
    { id: 'leads_calificados',    label: 'GSheets: Leads Calificados' },
    { id: 'leads_no_calificados', label: 'GSheets: Leads No Calificados' },
    { id: 'tasa_calificacion',    label: 'GSheets: Tasa de Calificación (%)' },
]

function buildAvailableMetrics(conversionesCatalogo: { conversion_key: string; label: string; field_id: string }[]) {
    const dynamic = conversionesCatalogo.map(c => ({ id: c.field_id, label: `Meta: ${c.label}` }))
    const existing = new Set(AVAILABLE_METRICS.map(m => m.id))
    const extras = dynamic.filter(d => !existing.has(d.id))
    return [...AVAILABLE_METRICS, ...extras]
}

// ─── Preset KPIs for Executive views ────────────────────────────────────────

const EXECUTIVE_PRESETS: { label: string; formula: string; prefix?: string; suffix?: string; color?: CardColor }[] = [
    { label: 'Inversión Total', formula: 'meta_spend', prefix: '$', color: 'red' },
    { label: 'Total Leads', formula: 'meta_leads', color: 'blue' },
    { label: 'Costo por Lead', formula: 'meta_spend / meta_leads', prefix: '$', color: 'amber' },
    { label: 'Facturación', formula: 'ventas_principal + ventas_bump + ventas_upsell', prefix: '$', color: 'emerald' },
    { label: 'ROAS', formula: '(ventas_principal + ventas_bump + ventas_upsell) / meta_spend', suffix: 'x', color: 'default' },
    { label: 'ROI %', formula: '((ventas_principal + ventas_bump + ventas_upsell - meta_spend) / meta_spend) * 100', suffix: '%', color: 'emerald' },
    { label: 'Compras', formula: 'meta_purchases', color: 'emerald' },
    { label: 'Costo por Compra', formula: 'meta_spend / meta_purchases', prefix: '$', color: 'amber' },
    { label: 'Alcance Total', formula: 'meta_reach', color: 'blue' },
    { label: 'Checkouts', formula: 'hotmart_pagos_iniciados', color: 'blue' },
    { label: 'Resultados Meta', formula: 'meta_results', color: 'default' },
    { label: 'Costo por Resultado', formula: 'meta_spend / meta_results', prefix: '$', color: 'amber' },
    // ── Google Sheets · Leads ──────────────────────────────────────────────
    { label: 'Leads Totales (GSheets)', formula: 'leads_totales', color: 'blue' },
    { label: 'Leads Calificados', formula: 'leads_calificados', color: 'emerald' },
    { label: 'Leads No Calificados', formula: 'leads_no_calificados', color: 'red' },
    { label: 'Tasa Calificación %', formula: 'tasa_calificacion', suffix: '%', color: 'amber' },
    { label: 'Costo x Lead Calificado', formula: 'meta_spend / leads_calificados', prefix: '$', color: 'amber' },
]

// ─── Formula Input ──────────────────────────────────────────────────────────

function FormulaInput({ value, onChange, availableMetrics }: {
    value: string
    onChange: (val: string) => void
    availableMetrics: { id: string; label: string }[]
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [search, setSearch] = useState('')

    const insertMetric = (metricId: string) => {
        const currentPos = inputRef.current?.selectionStart || value.length
        const newVal = value.slice(0, currentPos) + (value.length > 0 && currentPos > 0 && !value.endsWith(' ') ? ' ' : '') + metricId + ' ' + value.slice(currentPos)
        onChange(newVal)
        setSearch('')
    }

    const filtered = availableMetrics.filter(m => m.label.toLowerCase().includes(search.toLowerCase()) || m.id.toLowerCase().includes(search.toLowerCase()))

    return (
        <div className="flex-1 flex relative items-center min-w-0">
            <Input
                ref={inputRef}
                value={value}
                onChange={e => onChange(e.target.value)}
                className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-full font-mono pr-8"
                placeholder="Fórmula"
            />
            <Popover>
                <PopoverTrigger asChild>
                    <button className="absolute right-1 text-zinc-500 hover:text-indigo-400 p-1 transition bg-zinc-950 rounded" title="Insertar métrica">
                        <Database className="w-3.5 h-3.5" />
                    </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0 bg-zinc-900 border-zinc-800 z-[110]" align="end" side="bottom">
                    <div className="p-2 border-b border-zinc-800 bg-zinc-950 rounded-t-lg">
                        <Input
                            placeholder="Buscar métrica..."
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="h-8 text-xs bg-zinc-900 border-zinc-800 focus-visible:ring-indigo-500/50"
                        />
                    </div>
                    <div className="max-h-48 overflow-y-auto custom-scrollbar p-1">
                        {filtered.map(m => (
                            <button
                                key={m.id}
                                onClick={() => insertMetric(m.id)}
                                className="w-full text-left px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded transition flex flex-col gap-0.5"
                            >
                                <span className="font-semibold text-zinc-200">{m.label}</span>
                                <span className="text-[10px] text-zinc-500 font-mono">{m.id}</span>
                            </button>
                        ))}
                        {filtered.length === 0 && (
                            <p className="text-center text-xs text-zinc-600 py-4">No se encontraron métricas</p>
                        )}
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    )
}

// ─── Metric Type Selector ───────────────────────────────────────────────────

type MetricType = 'number' | 'currency' | 'percent'

function getMetricType(prefix?: string, suffix?: string): MetricType {
    if (suffix === '%' || suffix === 'x') return 'percent'
    if (prefix === '$') return 'currency'
    return 'number'
}

function applyMetricType(type: MetricType): { prefix: string; suffix: string; decimals: number } {
    if (type === 'currency') return { prefix: '$', suffix: '', decimals: 2 }
    if (type === 'percent') return { prefix: '', suffix: '%', decimals: 2 }
    return { prefix: '', suffix: '', decimals: 0 }
}

function MetricTypeSelector({ prefix, suffix, onChange }: {
    prefix?: string, suffix?: string
    onChange: (vals: { prefix: string; suffix: string; decimals: number }) => void
}) {
    const current = getMetricType(prefix, suffix)
    const types: { type: MetricType; icon: string; active: string; inactive: string }[] = [
        { type: 'number', icon: '#', active: 'bg-zinc-600 text-white border-zinc-500', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-zinc-500 hover:text-zinc-300' },
        { type: 'currency', icon: '$', active: 'bg-emerald-600/30 text-emerald-300 border-emerald-500/60', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-emerald-500/40 hover:text-emerald-400' },
        { type: 'percent', icon: '%', active: 'bg-blue-600/30 text-blue-300 border-blue-500/60', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-blue-500/40 hover:text-blue-400' },
    ]
    return (
        <div className="flex gap-1 flex-shrink-0">
            {types.map(t => (
                <button key={t.type} onClick={() => onChange(applyMetricType(t.type))} className={`w-6 h-7 rounded border text-xs font-bold transition flex-shrink-0 ${current === t.type ? t.active : t.inactive}`}>{t.icon}</button>
            ))}
        </div>
    )
}

// ─── Color Options ──────────────────────────────────────────────────────────

const COLOR_OPTIONS: { val: CardColor; bg: string }[] = [
    { val: 'default', bg: 'bg-zinc-400' },
    { val: 'emerald', bg: 'bg-emerald-400' },
    { val: 'blue', bg: 'bg-blue-400' },
    { val: 'amber', bg: 'bg-amber-400' },
    { val: 'red', bg: 'bg-red-400' },
]

const CHART_TYPES: { val: ChartType; label: string; icon: string }[] = [
    { val: 'area', label: 'Área', icon: '📉' },
    { val: 'bar', label: 'Barras', icon: '📊' },
    { val: 'stacked_bar', label: 'Barras Apiladas', icon: '📋' },
    { val: 'line', label: 'Líneas', icon: '—' },
    { val: 'donut', label: 'Rosquilla', icon: '🍢' },
    { val: 'pie', label: 'Torta', icon: '🥧' },
    { val: 'composed', label: 'Barra + Línea', icon: '📹' },
    { val: 'funnel', label: 'Embudo', icon: '🔻' },
]

const CHART_COLOR_OPTIONS = [
    { val: 'amber', hex: '#f59e0b' }, { val: 'cyan', hex: '#22d3ee' },
    { val: 'blue', hex: '#60a5fa' }, { val: 'violet', hex: '#a78bfa' },
    { val: 'emerald', hex: '#34d399' }, { val: 'rose', hex: '#fb7185' },
    { val: 'orange', hex: '#fb923c' }, { val: 'red', hex: '#f87171' },
    { val: 'indigo', hex: '#818cf8' }, { val: 'teal', hex: '#2dd4bf' },
]

// ─── Main Editor Component ──────────────────────────────────────────────────

export function PublicLayoutEditor({
    clienteId,
    initialLayout,
    conversionesCatalogo = [],
    onClose,
}: {
    clienteId: string
    initialLayout: { tarjetas: CardDef[]; graficos: ChartDef[] } | null
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
    onClose: () => void
}) {
    const availableMetrics = buildAvailableMetrics(conversionesCatalogo)
    const [tarjetas, setTarjetas] = useState<CardDef[]>(initialLayout?.tarjetas || [])
    const [graficos, setGraficos] = useState<ChartDef[]>(initialLayout?.graficos || [])
    const [showCountryBreakdown, setShowCountryBreakdown] = useState<boolean>((initialLayout as any)?.show_country_breakdown ?? false)
    const [leadsFormula, setLeadsFormula] = useState<string>((initialLayout as any)?.leads_formula || 'meta_leads')
    const [loading, setLoading] = useState(false)
    const [saved, setSaved] = useState(false)

    // ── Card handlers ─────────────────────────────────────────────────────

    function addCard() {
        setTarjetas(prev => [...prev, {
            id: crypto.randomUUID(),
            label: 'Nueva Métrica',
            formula: '',
            prefix: '',
            suffix: '',
            decimals: 2,
            color: 'default',
        }])
    }

    function addPreset(p: typeof EXECUTIVE_PRESETS[0]) {
        setTarjetas(prev => [...prev, {
            id: crypto.randomUUID(),
            label: p.label,
            formula: p.formula,
            prefix: p.prefix || '',
            suffix: p.suffix || '',
            decimals: 2,
            color: p.color || 'default',
        }])
    }

    function updateCard(i: number, card: CardDef) {
        setTarjetas(prev => { const n = [...prev]; n[i] = card; return n })
    }

    function removeCard(i: number) {
        setTarjetas(prev => prev.filter((_, idx) => idx !== i))
    }

    // ── Chart handlers ────────────────────────────────────────────────────

    function addChart() {
        setGraficos(prev => [...prev, {
            id: crypto.randomUUID(),
            title: 'Nuevo Gráfico',
            type: 'bar',
            categoryColumns: ['fecha'],
            valueFormulas: ['meta_spend'],
            colors: ['amber']
        }])
    }

    function updateChart(i: number, chart: ChartDef) {
        setGraficos(prev => { const n = [...prev]; n[i] = chart; return n })
    }

    function removeChart(i: number) {
        setGraficos(prev => prev.filter((_, idx) => idx !== i))
    }

    // ── Save ──────────────────────────────────────────────────────────────

    async function handleSave() {
        setLoading(true)
        const res = await savePublicLayout(clienteId, { tarjetas, graficos, show_country_breakdown: showCountryBreakdown, leads_formula: leadsFormula } as any)
        setLoading(false)
        if (res.error) { alert(res.error); return }
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8 bg-black/80 backdrop-blur-md" onClick={onClose}>
            <div
                className="relative bg-[#0a0a0c] border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/60 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-500/10 rounded-lg">
                            <Globe className="w-5 h-5 text-emerald-400" />
                        </div>
                        <div className="flex flex-col">
                            <h2 className="text-base font-bold text-white tracking-tight">
                                Vista Ejecutiva Pública
                            </h2>
                            <p className="text-xs text-zinc-500">
                                Configura las tarjetas KPI y gráficos que verá tu cliente. Sin tabla de detalle diario.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={loading}
                            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                        >
                            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                            {saved ? '¡Guardado!' : 'Guardar'}
                        </Button>
                        <button onClick={onClose} className="text-zinc-500 hover:text-white transition p-1.5 hover:bg-zinc-800 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">

                    {/* KPI Cards Section */}
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                                <span className="w-6 h-6 bg-emerald-500/10 text-emerald-400 flex items-center justify-center rounded text-xs font-bold">K</span>
                                Tarjetas KPI
                                <span className="text-[10px] text-zinc-500 font-normal">({tarjetas.length})</span>
                            </h3>
                            <Button size="sm" variant="outline" onClick={addCard} className="gap-1 text-xs border-zinc-700 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/40">
                                <Plus className="w-3.5 h-3.5" /> Tarjeta vacía
                            </Button>
                        </div>

                        {/* Quick add presets */}
                        <div className="flex flex-wrap gap-1.5 mb-4">
                            {EXECUTIVE_PRESETS.map(p => (
                                <button
                                    key={p.label}
                                    onClick={() => addPreset(p)}
                                    className="text-[10px] px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-400 transition"
                                >
                                    + {p.label}
                                </button>
                            ))}
                        </div>

                        {tarjetas.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 border border-dashed border-zinc-800 rounded-xl text-center">
                                <span className="text-3xl mb-3">📊</span>
                                <p className="text-sm text-zinc-400 font-medium">Sin tarjetas aún</p>
                                <p className="text-xs text-zinc-600 mt-1">Añade KPIs ejecutivos usando los presets de arriba o crea uno vacío.</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {tarjetas.map((card, i) => (
                                    <div key={card.id} className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 group transition hover:border-zinc-600">
                                        <GripVertical className="w-4 h-4 text-zinc-600 flex-shrink-0" />

                                        {/* Color dots */}
                                        <div className="flex gap-1 flex-shrink-0 mr-1">
                                            {COLOR_OPTIONS.map(opt => (
                                                <button
                                                    key={opt.val}
                                                    onClick={() => updateCard(i, { ...card, color: opt.val })}
                                                    className={`w-3 h-3 rounded-full ${opt.bg} transition ${card.color === opt.val ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : 'opacity-40 hover:opacity-100'}`}
                                                />
                                            ))}
                                        </div>

                                        <Input
                                            value={card.label}
                                            onChange={e => updateCard(i, { ...card, label: e.target.value })}
                                            className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-36 flex-shrink-0"
                                            placeholder="Etiqueta"
                                        />

                                        <FormulaInput
                                            value={card.formula}
                                            onChange={val => updateCard(i, { ...card, formula: val.trim() })}
                                            availableMetrics={availableMetrics}
                                        />

                                        <MetricTypeSelector
                                            prefix={card.prefix}
                                            suffix={card.suffix}
                                            onChange={vals => updateCard(i, { ...card, ...vals })}
                                        />

                                        <button onClick={() => removeCard(i)} className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition ml-1">
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="border-t border-zinc-800" />

                    {/* Country Breakdown Toggle */}
                    <div className="flex flex-col gap-3 p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-blue-500/10 rounded-lg">
                                    <Map className="w-4 h-4 text-blue-400" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-zinc-200">Desglose por País</p>
                                    <p className="text-xs text-zinc-500 mt-0.5">Gasto, leads y CPL por país detectado en el nombre de campaña <code className="text-zinc-400 bg-zinc-800 px-1 rounded">[PAÍS]</code></p>
                                </div>
                            </div>
                            <button
                                onClick={() => setShowCountryBreakdown(v => !v)}
                                className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${showCountryBreakdown ? 'bg-blue-600' : 'bg-zinc-700'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${showCountryBreakdown ? 'translate-x-5' : 'translate-x-0'}`} />
                            </button>
                        </div>
                        {showCountryBreakdown && (
                            <div className="pl-11 flex items-center gap-2">
                                <span className="text-xs text-zinc-500 whitespace-nowrap">Métrica de Leads:</span>
                                <Input
                                    value={leadsFormula}
                                    onChange={e => setLeadsFormula(e.target.value.trim())}
                                    placeholder="meta_leads"
                                    className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 font-mono flex-1"
                                />
                                <span className="text-[10px] text-zinc-600 whitespace-nowrap">ej: meta_custom_leadduaypiar</span>
                            </div>
                        )}
                    </div>

                    {/* Divider */}
                    <div className="border-t border-zinc-800" />

                    {/* Charts Section */}
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                                <span className="w-6 h-6 bg-blue-500/10 text-blue-400 flex items-center justify-center rounded text-xs font-bold">
                                    <BarChart3 className="w-3.5 h-3.5" />
                                </span>
                                Gráficos
                                <span className="text-[10px] text-zinc-500 font-normal">({graficos.length})</span>
                            </h3>
                            <Button size="sm" variant="outline" onClick={addChart} className="gap-1 text-xs border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-500/40">
                                <Plus className="w-3.5 h-3.5" /> Nuevo Gráfico
                            </Button>
                        </div>

                        {graficos.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 border border-dashed border-zinc-800 rounded-xl text-center">
                                <span className="text-3xl mb-3">📈</span>
                                <p className="text-sm text-zinc-400 font-medium">Sin gráficos aún</p>
                                <p className="text-xs text-zinc-600 mt-1">Añade gráficos para visualizar las métricas del cliente.</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {graficos.map((chart, i) => (
                                    <div key={chart.id} className="flex flex-col gap-2.5 bg-zinc-900 border border-zinc-700 rounded-xl p-3 group transition hover:border-zinc-600">
                                        {/* Row 1: type + title + remove */}
                                        <div className="flex items-center gap-2">
                                            <GripVertical className="w-4 h-4 text-zinc-600 flex-shrink-0" />

                                            <select
                                                value={chart.type}
                                                onChange={(e) => updateChart(i, { ...chart, type: e.target.value as ChartType })}
                                                className="h-7 text-xs bg-zinc-950 border border-zinc-700 text-zinc-200 rounded px-1.5 max-w-[130px]"
                                            >
                                                {CHART_TYPES.map(t => (
                                                    <option key={t.val} value={t.val}>{t.icon} {t.label}</option>
                                                ))}
                                            </select>

                                            <Input
                                                value={chart.title}
                                                onChange={e => updateChart(i, { ...chart, title: e.target.value })}
                                                className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 flex-1 min-w-[80px]"
                                                placeholder="Título"
                                            />

                                            <button onClick={() => removeChart(i)} className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition">
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                        {/* Row 2: metrics */}
                                        <div className="pl-6 space-y-1.5">
                                            {chart.valueFormulas.map((formula, mi) => (
                                                <div key={mi} className="flex items-center gap-1.5">
                                                    <select
                                                        value={(chart.colors || [])[mi] || 'amber'}
                                                        onChange={(e) => {
                                                            const newC = [...(chart.colors || [])]
                                                            newC[mi] = e.target.value
                                                            updateChart(i, { ...chart, colors: newC })
                                                        }}
                                                        className="h-6 w-6 text-[0px] rounded-full border-0 cursor-pointer flex-shrink-0 overflow-hidden"
                                                        style={{ background: CHART_COLOR_OPTIONS.find(c => c.val === ((chart.colors || [])[mi] || 'amber'))?.hex ?? '#f59e0b' }}
                                                    >
                                                        {CHART_COLOR_OPTIONS.map(c => (
                                                            <option key={c.val} value={c.val}>{c.val}</option>
                                                        ))}
                                                    </select>

                                                    <div className="flex-1">
                                                        <FormulaInput
                                                            value={formula}
                                                            onChange={(val) => {
                                                                const newF = [...chart.valueFormulas]
                                                                newF[mi] = val.trim()
                                                                updateChart(i, { ...chart, valueFormulas: newF })
                                                            }}
                                                            availableMetrics={availableMetrics}
                                                        />
                                                    </div>

                                                    {chart.valueFormulas.length > 1 && (
                                                        <button onClick={() => {
                                                            const newF = chart.valueFormulas.filter((_, idx) => idx !== mi)
                                                            const newC = (chart.colors || []).filter((_, idx) => idx !== mi)
                                                            updateChart(i, { ...chart, valueFormulas: newF, colors: newC })
                                                        }} className="text-zinc-700 hover:text-red-400 transition flex-shrink-0">
                                                            <X className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            ))}

                                            {chart.valueFormulas.length < 5 && (
                                                <button
                                                    onClick={() => updateChart(i, { ...chart, valueFormulas: [...chart.valueFormulas, ''], colors: [...(chart.colors || []), 'blue'] })}
                                                    className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-amber-400 transition mt-1"
                                                >
                                                    <Plus className="w-3 h-3" /> Añadir métrica
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
