'use client'

import { useState, useRef, useCallback } from 'react'
import { cloneLayoutForCliente, saveClienteLayout, resetClienteLayout, saveTabOverrides } from '../_actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    LayoutDashboard, X, GripVertical, ChevronRight,
    RotateCcw, Save, Loader2, Check,
    ChevronLeft, Eye, EyeOff, LayoutPanelTop, Plus, Database, BarChart3
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ColDef, CardDef, ChartDef, ChartType, ReportLayout, CardColor } from '@/lib/layout-types'

// ─── Available Metrics for Dropdown ──────────────────────────────────────────

const AVAILABLE_METRICS = [
    // Meta Ads
    { id: 'meta_spend', label: 'Meta: Gasto' },
    { id: 'meta_impressions', label: 'Meta: Impresiones' },
    { id: 'meta_clicks', label: 'Meta: Clics (Todos)' },
    { id: 'meta_link_clicks', label: 'Meta: Clics en el enlace' },
    { id: 'meta_cpc', label: 'Meta: CPC (Todos)' },
    { id: 'meta_cpc_link', label: 'Meta: CPC (Enlace)' },
    { id: 'meta_cpm', label: 'Meta: CPM' },
    { id: 'meta_ctr', label: 'Meta: CTR (Todos)' },
    { id: 'meta_ctr_link', label: 'Meta: CTR (Enlace)' },
    { id: 'meta_reach', label: 'Meta: Alcance' },
    { id: 'meta_frequency', label: 'Meta: Frecuencia' },
    { id: 'meta_leads', label: 'Meta: Clientes Potenciales (Leads)' },
    { id: 'meta_cpl', label: 'Meta: Costo por Lead (CPL)' },
    { id: 'meta_purchases', label: 'Meta: Compras' },
    { id: 'meta_cpp', label: 'Meta: Costo por Compra (CPP)' },
    { id: 'meta_roas', label: 'Meta: ROAS (Retorno de Inversión)' },
    { id: 'meta_adds_to_cart', label: 'Meta: Artículos al carrito' },
    { id: 'meta_cost_per_add_to_cart', label: 'Meta: Costo por Add to Cart' },
    { id: 'meta_initiates_checkout', label: 'Meta: Pagos Iniciados' },
    { id: 'meta_cost_per_initiate_checkout', label: 'Meta: Costo por Pago Inic.' },
    { id: 'meta_landing_page_views', label: 'Meta: Vistas de pág. de destino' },
    { id: 'meta_cost_per_landing_page_view', label: 'Meta: Costo por Vista Pág.' },
    { id: 'meta_results', label: 'Meta: Resultados' },
    { id: 'meta_cost_per_result', label: 'Meta: Costo por Resultado' },
    { id: 'meta_video_views', label: 'Meta: Reproducciones de Video' },

    // Meta: Conversiones Personalizadas
    { id: 'meta_custom_leadtcc', label: 'Meta: Lead TCC' },
    { id: 'meta_custom_lead_neuroemocion', label: 'Meta: Lead Neuro' },
    { id: 'meta_custom_leads_psico_clinica', label: 'Meta: Lead Psico Clínica' },
    { id: 'meta_custom_leadautismo', label: 'Meta: Lead Autismo' },
    { id: 'meta_custom_lead_docenciau', label: 'Meta: Lead Docencia' },

    // Google Analytics 4
    { id: 'ga_sessions', label: 'GA4: Sesiones' },
    { id: 'ga_bounce_rate', label: 'GA4: Tasa de Rebote' },
    { id: 'ga_avg_session_duration', label: 'GA4: Duración Promedio' },

    // Hotmart
    { id: 'hotmart_pagos_iniciados', label: 'Hotmart: Pagos Inic.' },
    { id: 'hotmart_clics_link', label: 'Hotmart: Clics Link' },
    { id: 'ventas_principal', label: 'Ventas (Principal)' },
    { id: 'ventas_bump', label: 'Ventas (Bump)' },
    { id: 'ventas_upsell', label: 'Ventas (Upsell)' }
]

/** Build dynamic metric list merging static + catalog custom conversions */
function buildAvailableMetrics(conversionesCatalogo: { conversion_key: string; label: string; field_id: string }[]) {
    const dynamic = conversionesCatalogo.map(c => ({ id: c.field_id, label: `Meta: ${c.label}` }))
    // Merge, removing duplicates by id
    const existing = new Set(AVAILABLE_METRICS.map(m => m.id))
    const extras = dynamic.filter(d => !existing.has(d.id))
    return [...AVAILABLE_METRICS, ...extras]
}

// ─── Formula Input component ──────────────────────────────────────────────────

function FormulaInput({ value, onChange, disabled, availableMetrics }: {
    value: string
    onChange: (val: string) => void
    disabled?: boolean
    availableMetrics?: { id: string; label: string }[]
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [search, setSearch] = useState('')
    const metrics = availableMetrics || AVAILABLE_METRICS

    const insertMetric = (metricId: string) => {
        const currentPos = inputRef.current?.selectionStart || value.length
        const newVal = value.slice(0, currentPos) + (value.length > 0 && currentPos > 0 && !value.endsWith(' ') ? ' ' : '') + metricId + ' ' + value.slice(currentPos)
        onChange(newVal)
        setSearch('')
    }

    const filteredMetrics = metrics.filter(m => m.label.toLowerCase().includes(search.toLowerCase()) || m.id.toLowerCase().includes(search.toLowerCase()))

    return (
        <div className="flex-1 flex relative items-center min-w-0">
            <Input
                ref={inputRef}
                value={value}
                onChange={e => onChange(e.target.value)}
                className={`h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-full font-mono ${!disabled ? 'pr-8' : ''}`}
                placeholder="Fórmula"
                disabled={disabled}
            />
            {!disabled && (
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
                            {filteredMetrics.map(m => (
                                <button
                                    key={m.id}
                                    onClick={() => insertMetric(m.id)}
                                    className="w-full text-left px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded transition flex flex-col gap-0.5"
                                >
                                    <span className="font-semibold text-zinc-200">{m.label}</span>
                                    <span className="text-[10px] text-zinc-500 font-mono">{m.id}</span>
                                </button>
                            ))}
                            {filteredMetrics.length === 0 && (
                                <p className="text-center text-xs text-zinc-600 py-4">No se encontraron métricas</p>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    )
}

// ─── Metric Type Selector ─────────────────────────────────────────────────────

type MetricType = 'number' | 'currency' | 'percent'

function getMetricType(prefix?: string, suffix?: string): MetricType {
    if (suffix === '%') return 'percent'
    if (prefix === '$') return 'currency'
    return 'number'
}

function applyMetricType(type: MetricType): { prefix: string; suffix: string; decimals: number } {
    if (type === 'currency') return { prefix: '$', suffix: '', decimals: 2 }
    if (type === 'percent') return { prefix: '', suffix: '%', decimals: 2 }
    return { prefix: '', suffix: '', decimals: 0 }
}

function MetricTypeSelector({ prefix, suffix, onChange }: {
    prefix?: string
    suffix?: string
    onChange: (vals: { prefix: string; suffix: string; decimals: number }) => void
}) {
    const current = getMetricType(prefix, suffix)
    const types: { type: MetricType; icon: string; label: string; active: string; inactive: string }[] = [
        { type: 'number', icon: '#', label: 'Número', active: 'bg-zinc-600 text-white border-zinc-500', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-zinc-500 hover:text-zinc-300' },
        { type: 'currency', icon: '$', label: 'Moneda', active: 'bg-emerald-600/30 text-emerald-300 border-emerald-500/60', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-emerald-500/40 hover:text-emerald-400' },
        { type: 'percent', icon: '%', label: 'Porcentaje', active: 'bg-blue-600/30 text-blue-300 border-blue-500/60', inactive: 'bg-zinc-900 text-zinc-500 border-zinc-700 hover:border-blue-500/40 hover:text-blue-400' },
    ]
    return (
        <div className="flex gap-1 flex-shrink-0" title="Tipo de métrica">
            {types.map(t => (
                <button
                    key={t.type}
                    onClick={() => onChange(applyMetricType(t.type))}
                    title={t.label}
                    className={`w-6 h-7 rounded border text-xs font-bold transition flex-shrink-0 ${current === t.type ? t.active : t.inactive}`}
                >
                    {t.icon}
                </button>
            ))}
        </div>
    )
}

// ─── DnD Column Row ───────────────────────────────────────────────────────────

function DraggableColumnRow({
    col, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics
}: {
    col: ColDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (col: ColDef) => void
    onRemove: () => void
    availableMetrics?: { id: string; label: string }[]
}) {
    return (
        <div
            className="relative group/row flex items-stretch"
            draggable
            onDragStart={(e) => { e.stopPropagation(); onDragStart(index) }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(e, index) }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(index) }}
        >
            {/* Scrollable row content */}
            <div
                className={`flex items-center gap-2 bg-zinc-900 border rounded-l-lg px-3 py-2.5 transition cursor-grab active:cursor-grabbing select-none flex-1 min-w-0 overflow-x-auto ${col.hidden ? 'border-zinc-800 border-r-0 opacity-50' : 'border-zinc-700 border-r-0 hover:border-zinc-600'}`}
            >
                <GripVertical className="w-4 h-4 text-zinc-600 flex-shrink-0 group-hover/row:text-zinc-400 transition" />

                <button
                    onClick={() => onUpdate({ ...col, hidden: !col.hidden })}
                    className="flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition"
                    title={col.hidden ? 'Mostrar columna' : 'Ocultar columna'}
                >
                    {col.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>

                <Input
                    value={col.label}
                    onChange={e => onUpdate({ ...col, label: e.target.value })}
                    className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-28 flex-shrink-0"
                    placeholder="Etiqueta"
                />

                <FormulaInput
                    value={col.formula}
                    onChange={val => onUpdate({ ...col, formula: val.trim() })}
                    disabled={col.formula === 'fecha'}
                    availableMetrics={availableMetrics}
                />

                {col.formula !== 'fecha' && (
                    <MetricTypeSelector
                        prefix={col.prefix}
                        suffix={col.suffix}
                        onChange={vals => onUpdate({ ...col, ...vals })}
                    />
                )}

                <button
                    onClick={() => onUpdate({ ...col, highlight: !col.highlight })}
                    title="Colorear según impacto"
                    className={`flex-shrink-0 w-6 h-7 rounded border text-xs transition ${col.highlight ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-zinc-900 border-zinc-700 text-zinc-600 hover:text-zinc-400'}`}
                >
                    ✦
                </button>

                {/* Manual indicator */}
                {col.isManual && (
                    <span className="flex-shrink-0 text-[9px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">
                        Manual
                    </span>
                )}
            </div>

            {/* Sticky delete button — always visible */}
            {col.formula !== 'fecha' && (
                <button
                    onClick={onRemove}
                    title="Eliminar columna"
                    className={`flex-shrink-0 flex items-center justify-center w-8 bg-zinc-900 border border-l-0 rounded-r-lg transition text-zinc-600 hover:text-red-400 hover:bg-red-400/5 hover:border-red-400/30 ${col.hidden ? 'border-zinc-800 opacity-50' : 'border-zinc-700'}`}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    )
}

// ─── DnD Card Row ─────────────────────────────────────────────────────────────

const COLOR_OPTIONS: { val: CardColor; bg: string }[] = [
    { val: 'default', bg: 'bg-zinc-400' },
    { val: 'emerald', bg: 'bg-emerald-400' },
    { val: 'blue', bg: 'bg-blue-400' },
    { val: 'amber', bg: 'bg-amber-400' },
    { val: 'red', bg: 'bg-red-400' },
]

function DraggableCardRow({
    card, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics
}: {
    card: CardDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (card: CardDef) => void
    onRemove: () => void
    availableMetrics?: { id: string; label: string }[]
}) {
    return (
        <div
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => { e.preventDefault(); onDragOver(e, index) }}
            onDrop={() => onDrop(index)}
            className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2.5 group transition cursor-grab active:cursor-grabbing select-none hover:border-zinc-600"
        >
            <GripVertical className="w-4 h-4 text-zinc-600 flex-shrink-0 group-hover:text-zinc-400 transition" />

            <div className="flex gap-1 flex-shrink-0 mr-1">
                {COLOR_OPTIONS.map(opt => (
                    <button
                        key={opt.val}
                        onClick={() => onUpdate({ ...card, color: opt.val })}
                        className={`w-3 h-3 rounded-full ${opt.bg} transition ${card.color === opt.val ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : 'opacity-40 hover:opacity-100'}`}
                    />
                ))}
            </div>

            <Input
                value={card.label}
                onChange={e => onUpdate({ ...card, label: e.target.value })}
                className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-32 flex-shrink-0"
                placeholder="Etiqueta"
            />

            <FormulaInput
                value={card.formula}
                onChange={val => onUpdate({ ...card, formula: val.trim() })}
                availableMetrics={availableMetrics}
            />

            <MetricTypeSelector
                prefix={card.prefix}
                suffix={card.suffix}
                onChange={vals => onUpdate({ ...card, ...vals })}
            />

            <button onClick={onRemove} className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition ml-1">
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}

// ─── DnD Chart Row ────────────────────────────────────────────────────────────

const CHART_TYPES: { val: ChartType; label: string; icon: string }[] = [
    { val: 'area',        label: 'Área',            icon: '📉' },
    { val: 'stacked_area',label: 'Área Apilada',    icon: '📈' },
    { val: 'bar',         label: 'Barras',          icon: '📊' },
    { val: 'stacked_bar', label: 'Barras Apiladas', icon: '📋' },
    { val: 'line',        label: 'Líneas',         icon: '—' },
    { val: 'donut',       label: 'Rosquilla',       icon: '🍢' },
    { val: 'pie',         label: 'Torta',           icon: '🥧' },
    { val: 'composed',    label: 'Barra + Línea',    icon: '📹' },
    { val: 'radial',      label: 'Radial',          icon: '🎯' },
    { val: 'scatter',     label: 'Dispersión',      icon: '⭐' },
    { val: 'funnel',      label: 'Embudo',          icon: '🔻' },
]

const CHART_COLOR_OPTIONS = [
    { val: 'amber',   hex: '#f59e0b' }, { val: 'cyan',    hex: '#22d3ee' },
    { val: 'blue',    hex: '#60a5fa' }, { val: 'violet',  hex: '#a78bfa' },
    { val: 'emerald', hex: '#34d399' }, { val: 'rose',    hex: '#fb7185' },
    { val: 'orange',  hex: '#fb923c' }, { val: 'red',     hex: '#f87171' },
    { val: 'indigo',  hex: '#818cf8' }, { val: 'teal',    hex: '#2dd4bf' },
    { val: 'lime',    hex: '#a3e635' }, { val: 'pink',    hex: '#f472b6' },
]

function DraggableChartRow({
    chart, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics
}: {
    chart: ChartDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (chart: ChartDef) => void
    onRemove: () => void
    availableMetrics?: { id: string; label: string }[]
}) {
    const isCircular = chart.type === 'donut' || chart.type === 'pie' || chart.type === 'radial' || chart.type === 'funnel'
    const maxMetrics = chart.type === 'scatter' ? 2 : isCircular ? 6 : 5

    function addMetric() {
        if (chart.valueFormulas.length >= maxMetrics) return
        onUpdate({ ...chart, valueFormulas: [...chart.valueFormulas, ''], colors: [...(chart.colors || []), 'blue'] })
    }

    function removeMetric(i: number) {
        const newF = chart.valueFormulas.filter((_, idx) => idx !== i)
        const newC = (chart.colors || []).filter((_, idx) => idx !== i)
        onUpdate({ ...chart, valueFormulas: newF, colors: newC })
    }

    function updateMetric(i: number, val: string) {
        const newF = [...chart.valueFormulas]
        newF[i] = val.trim()
        onUpdate({ ...chart, valueFormulas: newF })
    }

    function updateColor(i: number, val: string) {
        const newC = [...(chart.colors || [])]
        newC[i] = val
        onUpdate({ ...chart, colors: newC })
    }

    return (
        <div
            draggable
            onDragStart={(e) => { e.stopPropagation(); onDragStart(index) }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(e, index) }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(index) }}
            className="flex flex-col gap-2.5 bg-zinc-900 border border-zinc-700 rounded-xl p-3 group transition cursor-grab active:cursor-grabbing select-none hover:border-zinc-600"
        >
            {/* Row 1: drag handle + type select + title + remove */}
            <div className="flex items-center gap-2">
                <GripVertical className="w-4 h-4 text-zinc-600 flex-shrink-0 group-hover:text-zinc-400 transition" />

                <select
                    value={chart.type}
                    onChange={(e) => onUpdate({ ...chart, type: e.target.value as ChartType })}
                    className="h-7 text-xs bg-zinc-950 border border-zinc-700 text-zinc-200 rounded px-1.5 max-w-[130px]"
                >
                    {CHART_TYPES.map(t => (
                        <option key={t.val} value={t.val}>{t.icon} {t.label}</option>
                    ))}
                </select>

                <Input
                    value={chart.title}
                    onChange={e => onUpdate({ ...chart, title: e.target.value })}
                    className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 flex-1 min-w-[80px]"
                    placeholder="Título"
                />

                <button onClick={onRemove} className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Row 2: metrics list */}
            <div className="pl-6 space-y-1.5">
                {chart.valueFormulas.map((formula, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                        {/* Color dot picker */}
                        <select
                            value={(chart.colors || [])[i] || 'amber'}
                            onChange={(e) => updateColor(i, e.target.value)}
                            className="h-6 w-6 text-[0px] rounded-full border-0 cursor-pointer flex-shrink-0 overflow-hidden"
                            style={{ background: CHART_COLOR_OPTIONS.find(c => c.val === ((chart.colors || [])[i] || 'amber'))?.hex ?? '#f59e0b' }}
                            title="Color de serie"
                        >
                            {CHART_COLOR_OPTIONS.map(c => (
                                <option key={c.val} value={c.val}>{c.val}</option>
                            ))}
                        </select>

                        <div className="flex-1">
                            <FormulaInput
                                value={formula}
                                onChange={(val) => updateMetric(i, val)}
                                availableMetrics={availableMetrics}
                            />
                        </div>

                        {chart.valueFormulas.length > 1 && (
                            <button onClick={() => removeMetric(i)} className="text-zinc-700 hover:text-red-400 transition flex-shrink-0">
                                <X className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                ))}

                {/* Add metric button */}
                {chart.valueFormulas.length < maxMetrics && (
                    <button
                        onClick={addMetric}
                        className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-amber-400 transition mt-1"
                    >
                        <Plus className="w-3 h-3" /> Añadir métrica
                    </button>
                )}

                {chart.type === 'scatter' && chart.valueFormulas.length < 2 && (
                    <p className="text-[9px] text-zinc-600 mt-0.5">El gráfico de dispersión necesita exactamente 2 métricas (eje X e Y).</p>
                )}
            </div>
        </div>
    )
}

// ─── Preset formulas for quick-insert ────────────────────────────────────────

const PRESETS: { label: string; formula: string; prefix?: string; suffix?: string }[] = [
    { label: 'Gasto', formula: 'meta_spend', prefix: '$' },
    { label: 'Impresiones', formula: 'meta_impressions' },
    { label: 'Clics', formula: 'meta_clicks' },
    { label: 'CTR %', formula: '(meta_clicks / meta_impressions) * 100', suffix: '%' },
    { label: 'CPC', formula: 'meta_spend / meta_clicks', prefix: '$' },
    { label: 'CPM', formula: '(meta_spend / meta_impressions) * 1000', prefix: '$' },
    { label: 'ROAS', formula: '(ventas_principal + ventas_bump + ventas_upsell) / meta_spend', suffix: 'x' },
    { label: 'ROI %', formula: '((ventas_principal + ventas_bump + ventas_upsell - meta_spend) / meta_spend) * 100', suffix: '%' },
    { label: 'CPA', formula: 'meta_spend / (ventas_principal + ventas_bump + ventas_upsell)', prefix: '$' },
    { label: 'Ventas', formula: 'ventas_principal + ventas_bump + ventas_upsell', prefix: '$' },
    { label: 'Visitas GA4', formula: 'ga_sessions' },
    { label: 'Checkouts', formula: 'hotmart_pagos_iniciados' },
]

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function LayoutConfigModal({
    clienteId,
    currentLayout,
    allLayouts,
    isCustomized,
    onClose,
    onLayoutApplied,
    tabId,
    conversionesCatalogo = [],
}: {
    clienteId: string
    currentLayout: ReportLayout | null
    allLayouts: any[]
    isCustomized: boolean
    onClose: () => void
    onLayoutApplied: (layout: ReportLayout) => void
    tabId?: string
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
}) {
    const availableMetrics = buildAvailableMetrics(conversionesCatalogo)
    const [step, setStep] = useState<'select' | 'edit'>(currentLayout ? 'edit' : 'select')
    const [workingLayout, setWorkingLayout] = useState<ReportLayout | null>(currentLayout)
    const [loading, setLoading] = useState(false)
    const [saved, setSaved] = useState(false)

    // DnD state
    const dragIndex = useRef<number | null>(null)
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
    const dragType = useRef<'col' | 'card' | null>(null)

    // ── Template selection ────────────────────────────────────────────────────

    async function handleSelectTemplate(globalLayoutId: string) {
        setLoading(true)
        const res = await cloneLayoutForCliente(clienteId, globalLayoutId)
        setLoading(false)
        if (res.error) { alert(res.error); return }
        setWorkingLayout(res.data as ReportLayout)
        setStep('edit')
    }

    // ── DnD handlers ─────────────────────────────────────────────────────────

    const handleDragStart = useCallback((index: number, type: 'col' | 'card') => {
        dragIndex.current = index
        dragType.current = type
    }, [])

    const handleDragOver = useCallback((_e: React.DragEvent, index: number, type: 'col' | 'card') => {
        if (dragType.current !== type) return
        setDragOverIndex(index)
    }, [])

    const handleDrop = useCallback((targetIndex: number, type: 'col' | 'card') => {
        const srcIndex = dragIndex.current
        if (srcIndex === null || dragType.current !== type || !workingLayout) {
            dragIndex.current = null
            dragType.current = null
            setDragOverIndex(null)
            return
        }
        if (srcIndex === targetIndex) {
            dragIndex.current = null
            dragType.current = null
            setDragOverIndex(null)
            return
        }

        if (type === 'col') {
            const cols = [...workingLayout.columnas]
            const [moved] = cols.splice(srcIndex, 1)
            cols.splice(targetIndex, 0, moved)
            setWorkingLayout(prev => prev ? { ...prev, columnas: cols } : prev)
        } else if (type === 'card') {
            const cards = [...workingLayout.tarjetas]
            const [moved] = cards.splice(srcIndex, 1)
            cards.splice(targetIndex, 0, moved)
            setWorkingLayout(prev => prev ? { ...prev, tarjetas: cards } : prev)
        } else {
            const charts = [...(workingLayout.graficos || [])]
            const [moved] = charts.splice(srcIndex, 1)
            charts.splice(targetIndex, 0, moved)
            setWorkingLayout(prev => prev ? { ...prev, graficos: charts } : prev)
        }

        dragIndex.current = null
        dragType.current = null
        setDragOverIndex(null)
    }, [workingLayout])

    // ── Update handlers ───────────────────────────────────────────────────────

    function updateCol(index: number, col: ColDef) {
        if (!workingLayout) return
        const cols = [...workingLayout.columnas]
        cols[index] = col
        setWorkingLayout({ ...workingLayout, columnas: cols })
    }

    function removeCol(index: number) {
        if (!workingLayout) return
        setWorkingLayout({ ...workingLayout, columnas: workingLayout.columnas.filter((_, i) => i !== index) })
    }

    function updateCard(index: number, card: CardDef) {
        if (!workingLayout) return
        const cards = [...workingLayout.tarjetas]
        cards[index] = card
        setWorkingLayout({ ...workingLayout, tarjetas: cards })
    }

    function removeCard(index: number) {
        if (!workingLayout) return
        setWorkingLayout({ ...workingLayout, tarjetas: workingLayout.tarjetas.filter((_, i) => i !== index) })
    }

    function updateChart(index: number, chart: ChartDef) {
        if (!workingLayout) return
        const charts = [...(workingLayout.graficos || [])]
        charts[index] = chart
        setWorkingLayout({ ...workingLayout, graficos: charts })
    }

    function removeChart(index: number) {
        if (!workingLayout) return
        setWorkingLayout({ ...workingLayout, graficos: (workingLayout.graficos || []).filter((_, i) => i !== index) })
    }

    function addPreset(p: typeof PRESETS[0], type: 'col' | 'card') {
        if (!workingLayout) return
        if (type === 'col') {
            const newCol: ColDef = {
                id: crypto.randomUUID(),
                label: p.label,
                formula: p.formula,
                prefix: p.prefix || '',
                suffix: p.suffix || '',
                decimals: 2,
                align: 'right',
            }
            setWorkingLayout({ ...workingLayout, columnas: [...workingLayout.columnas, newCol] })
        } else {
            const newCard: CardDef = {
                id: crypto.randomUUID(),
                label: p.label,
                formula: p.formula,
                prefix: p.prefix || '',
                suffix: p.suffix || '',
                decimals: 2,
                color: 'default'
            }
            setWorkingLayout({ ...workingLayout, tarjetas: [...workingLayout.tarjetas, newCard] })
        }
    }

    function addManualMetric() {
        if (!workingLayout) return
        const newCol: ColDef = {
            id: crypto.randomUUID(),
            label: 'Métrica Manual',
            formula: 'manual_nueva_metrica',
            isManual: true,
            align: 'right',
        }
        setWorkingLayout({ ...workingLayout, columnas: [...workingLayout.columnas, newCol] })
    }

    function addChart() {
        if (!workingLayout) return
        const newChart: ChartDef = {
             id: crypto.randomUUID(),
             title: 'Nuevo Gráfico',
             type: 'area',
             categoryColumns: ['fecha'],
             valueFormulas: ['meta_spend', 'meta_leads'],
             colors: ['amber', 'cyan']
        }
        setWorkingLayout({ ...workingLayout, graficos: [...(workingLayout.graficos || []), newChart] })
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    async function handleSave() {
        if (!workingLayout) return
        setLoading(true)

        let res
        if (tabId && tabId !== 'general') {
            res = await saveTabOverrides(clienteId, tabId, {
                columnas: workingLayout.columnas,
                tarjetas: workingLayout.tarjetas,
                graficos: workingLayout.graficos,
            })
        } else {
            res = await saveClienteLayout(clienteId, {
                columnas: workingLayout.columnas,
                tarjetas: workingLayout.tarjetas,
                graficos: workingLayout.graficos,
            })
        }

        setLoading(false)
        if (res.error) { alert(res.error); return }
        setSaved(true)
        onLayoutApplied(workingLayout)
        setTimeout(() => setSaved(false), 2000)
    }

    async function handleReset() {
        if (!confirm('¿Restablecer al layout por defecto?')) return
        setLoading(true)

        if (tabId && tabId !== 'general') {
            await saveTabOverrides(clienteId, tabId, {
                columnas: null,
                tarjetas: null,
            })
        } else {
            await resetClienteLayout(clienteId)
        }

        setLoading(false)
        onLayoutApplied(null as any)
        onClose()
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8 bg-black/80 backdrop-blur-md" onClick={onClose}>
            <div
                className="relative bg-[#0a0a0c] border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[95vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/60 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                            <LayoutDashboard className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div className="flex flex-col">
                            <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                                {tabId && tabId !== 'general' ? 'Personalizar Vista de Pestaña' : 'Personalización de Layout'}
                                {isCustomized && (!tabId || tabId === 'general') && (
                                    <span className="text-[10px] bg-indigo-500/20 text-indigo-300 font-bold px-2 py-0.5 rounded uppercase tracking-wide border border-indigo-500/30">
                                        Personalizado
                                    </span>
                                )}
                            </h2>
                            <p className="text-xs text-zinc-500">
                                {tabId && tabId !== 'general'
                                    ? 'Los cambios se aplicarán UNICAMENTE a esta pestaña.'
                                    : 'Ajusta métricas, orden y visibilidad exclusivos para este cliente.'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {step === 'edit' && isCustomized && (
                            <Button size="sm" variant="ghost" onClick={handleReset} disabled={loading} className="text-zinc-500 hover:text-red-400 gap-1.5 text-xs">
                                <RotateCcw className="w-3.5 h-3.5" /> Restablecer
                            </Button>
                        )}
                        <button onClick={onClose} className="text-zinc-500 hover:text-white transition p-1.5 hover:bg-zinc-800 rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">
                    {step === 'select' ? (
                        <div className="max-w-2xl mx-auto space-y-4 py-8">
                            <div className="text-center mb-8">
                                <h3 className="text-xl font-semibold text-white">Elige una plantilla de inicio</h3>
                                <p className="text-sm text-zinc-400 mt-2">Se creará una copia privada para que puedas editarla libremente.</p>
                            </div>
                            {allLayouts.map(l => (
                                <button
                                    key={l.id}
                                    onClick={() => handleSelectTemplate(l.id)}
                                    className="w-full text-left bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-indigo-500/50 rounded-xl p-5 group transition"
                                >
                                    <div className="flex justify-between items-center">
                                        <span className="text-base font-semibold text-white group-hover:text-indigo-400 transition">{l.nombre}</span>
                                        <ChevronRight className="w-5 h-5 text-zinc-600 transition group-hover:translate-x-1 group-hover:text-indigo-400" />
                                    </div>
                                    <p className="text-xs text-zinc-500 mt-1">{l.descripcion}</p>
                                </button>
                            ))}
                        </div>
                    ) : workingLayout && (
                        <>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 min-w-0">
                            {/* Columns Section */}
                            <div className="space-y-4 flex flex-col min-w-0">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-1 h-4 bg-indigo-500 rounded-full" />
                                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Columnas de Tabla</h3>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={addManualMetric} className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 bg-emerald-500/10 px-2 py-1 rounded transition">
                                            <Plus className="w-3 h-3" /> Input Manual
                                        </button>
                                        <button onClick={() => addPreset(PRESETS[0], 'col')} className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 px-2 py-1 rounded transition">
                                            <Plus className="w-3 h-3" /> Nueva Columna
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-2 pb-2 custom-scrollbar pr-2">
                                    {workingLayout.columnas.map((col, i) => (
                                        <div
                                            key={col.id}
                                            className={`transition-all duration-150 ${dragOverIndex === i && dragType.current === 'col' && dragIndex.current !== i ? 'pt-8 relative before:absolute before:top-0 before:left-0 before:right-0 before:h-1 before:bg-blue-500 before:rounded' : ''}`}
                                        >
                                            <DraggableColumnRow
                                                col={col}
                                                index={i}
                                                onDragStart={() => handleDragStart(i, 'col')}
                                                onDragOver={(e) => handleDragOver(e, i, 'col')}
                                                onDrop={() => handleDrop(i, 'col')}
                                                onUpdate={v => updateCol(i, v)}
                                                onRemove={() => removeCol(i)}
                                                availableMetrics={availableMetrics}
                                            />
                                        </div>
                                    ))}
                                </div>

                                <div className="pt-2">
                                    <p className="text-[10px] text-zinc-600 font-bold uppercase mb-2">Añadir métrica rápida:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {PRESETS.map(p => (
                                            <button key={p.formula} onClick={() => addPreset(p, 'col')} className="text-[10px] bg-zinc-900 border border-zinc-800 hover:border-indigo-500/40 text-zinc-400 hover:text-indigo-300 px-2 py-1 rounded transition">
                                                {p.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Cards Section */}
                            <div className="space-y-4 flex flex-col min-w-0">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-1 h-4 bg-emerald-500 rounded-full" />
                                        <h3 className="text-sm font-bold text-white uppercase tracking-wider">Tarjetas Superiores</h3>
                                    </div>
                                    <button onClick={() => addPreset(PRESETS[0], 'card')} className="text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                                        <Plus className="w-3 h-3" /> Nueva Tarjeta
                                    </button>
                                </div>

                                <div className="space-y-2 overflow-x-auto pb-2 min-w-0 custom-scrollbar pr-2">
                                    {workingLayout.tarjetas.map((card, i) => (
                                        <div key={card.id}>
                                            <DraggableCardRow
                                                card={card}
                                                index={i}
                                                onDragStart={() => handleDragStart(i, 'card')}
                                                onDragOver={(e) => handleDragOver(e, i, 'card')}
                                                onDrop={() => handleDrop(i, 'card')}
                                                onUpdate={v => updateCard(i, v)}
                                                onRemove={() => removeCard(i)}
                                                availableMetrics={availableMetrics}
                                            />
                                        </div>
                                    ))}
                                    {workingLayout.tarjetas.length === 0 && (
                                        <div className="border border-zinc-800 border-dashed rounded-xl p-8 text-center bg-zinc-950/20">
                                            <LayoutPanelTop className="w-6 h-6 text-zinc-700 mx-auto mb-2 opacity-50" />
                                            <p className="text-xs text-zinc-600">No hay tarjetas configuradas.</p>
                                        </div>
                                    )}
                                </div>

                                <div className="pt-2">
                                    <p className="text-[10px] text-zinc-600 font-bold uppercase mb-2">Añadir tarjeta rápida:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {PRESETS.map(p => (
                                            <button key={p.formula} onClick={() => addPreset(p, 'card')} className="text-[10px] bg-zinc-900 border border-zinc-800 hover:border-emerald-500/40 text-zinc-400 hover:text-emerald-300 px-2 py-1 rounded transition">
                                                {p.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Charts Section */}
                        <div className="pt-8 border-t border-zinc-800 space-y-4">
                             <div className="flex items-center justify-between">
                                 <div className="flex items-center gap-2">
                                     <div className="w-1 h-4 bg-amber-500 rounded-full" />
                                     <h3 className="text-sm font-bold text-white uppercase tracking-wider">Gráficos de Rendimiento</h3>
                                 </div>
                                 <button onClick={addChart} className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 bg-amber-500/10 px-2 py-1 rounded transition">
                                     <Plus className="w-3 h-3" /> Añadir Gráfico
                                 </button>
                             </div>

                             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {(workingLayout.graficos || []).map((chart, i) => (
                                    <DraggableChartRow
                                        key={chart.id}
                                        chart={chart}
                                        index={i}
                                        onDragStart={() => handleDragStart(i, 'chart' as any)}
                                        onDragOver={(e) => handleDragOver(e, i, 'chart' as any)}
                                        onDrop={() => handleDrop(i, 'chart' as any)}
                                        onUpdate={v => updateChart(i, v)}
                                        onRemove={() => removeChart(i)}
                                        availableMetrics={availableMetrics}
                                    />
                                ))}
                                {(!workingLayout.graficos || workingLayout.graficos.length === 0) && (
                                     <div className="col-span-full border border-zinc-800 border-dashed rounded-xl p-8 text-center bg-zinc-950/20">
                                         <BarChart3 className="w-6 h-6 text-zinc-700 mx-auto mb-2 opacity-50" />
                                         <p className="text-xs text-zinc-600">No hay gráficos configurados. Haz clic en "Añadir Gráfico" para crear uno.</p>
                                     </div>
                                )}
                             </div>
                        </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {step === 'edit' && workingLayout && (
                    <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-950/80 flex-shrink-0">
                        <button onClick={() => setStep('select')} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1.5 transition">
                            <ChevronLeft className="w-4 h-4" /> Cambiar Plantilla
                        </button>
                        <div className="flex gap-3">
                            <Button variant="outline" onClick={onClose} className="border-zinc-700 text-zinc-400 hover:text-white text-xs px-6">
                                Cancelar
                            </Button>
                            <Button
                                onClick={handleSave}
                                disabled={loading || saved}
                                className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[160px] text-xs font-bold gap-2"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                                {saved ? '¡GUARDADO!' : 'APLICAR AL CLIENTE'}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
