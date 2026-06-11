'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { cloneLayoutForCliente, saveClienteLayout, resetClienteLayout, saveTabOverrides } from '../_actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    LayoutDashboard, X, GripVertical, ChevronRight,
    RotateCcw, Save, Loader2, Check,
    ChevronLeft, Eye, EyeOff, LayoutPanelTop, Plus, Database, BarChart3, Copy
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from '@/components/ui/popover'
import type { ColDef, CardDef, ChartDef, ChartType, ReportLayout, CardColor, CampaignFilterSpec, CampaignFilterOperator, RankingTableDef, RankingColumnDef } from '@/lib/layout-types'

// ─── Available Metrics for Dropdown ──────────────────────────────────────────

export const AVAILABLE_METRICS = [
    // ── Meta · Entrega ────────────────────────────────────────────────────────
    { id: 'meta_spend',       label: 'Meta: Gasto' },
    { id: 'meta_impressions', label: 'Meta: Impresiones' },
    { id: 'meta_reach',       label: 'Meta: Alcance' },
    { id: 'meta_frequency',   label: 'Meta: Frecuencia' },
    { id: 'meta_clicks',      label: 'Meta: Clics (Todos)' },
    { id: 'meta_link_clicks', label: 'Meta: Clics en el enlace' },

    // ── Meta · Costos y Tasas ─────────────────────────────────────────────────
    { id: 'meta_cpm',      label: 'Meta: CPM' },
    { id: 'meta_cpc',      label: 'Meta: CPC (Todos)' },
    { id: 'meta_cpc_link', label: 'Meta: CPC (Enlace)' },
    { id: 'meta_ctr',      label: 'Meta: CTR (Todos)' },
    { id: 'meta_ctr_link', label: 'Meta: CTR (Enlace)' },

    // ── Meta · Leads y Registro ───────────────────────────────────────────────
    { id: 'meta_leads',                            label: 'Meta: Leads (Pixel)' },
    { id: 'meta_cpl',                              label: 'Meta: Costo por Lead Pixel (CPL)' },
    { id: 'meta_leads_form',                       label: 'Meta: Clientes potenciales (Formulario)' },
    { id: 'meta_cpl_form',                         label: 'Meta: Costo por Lead Formulario' },
    { id: 'meta_complete_registration',            label: 'Meta: Registros completados' },
    { id: 'meta_cost_per_complete_registration',   label: 'Meta: Costo por Registro' },
    { id: 'meta_submit_application',               label: 'Meta: Solicitudes enviadas' },
    { id: 'meta_start_trial',                      label: 'Meta: Trials iniciados' },
    { id: 'meta_subscribe',                        label: 'Meta: Suscripciones' },

    // ── Meta · Compras y Carrito ──────────────────────────────────────────────
    { id: 'meta_purchases',                        label: 'Meta: Compras' },
    { id: 'meta_cpp',                              label: 'Meta: Costo por Compra (CPP)' },
    { id: 'meta_roas',                             label: 'Meta: ROAS' },
    { id: 'meta_adds_to_cart',                     label: 'Meta: Añadir al carrito' },
    { id: 'meta_cost_per_add_to_cart',             label: 'Meta: Costo por Add to Cart' },
    { id: 'meta_initiates_checkout',               label: 'Meta: Inicio de pago (Checkout)' },
    { id: 'meta_cost_per_initiate_checkout',       label: 'Meta: Costo por Checkout' },

    // ── Meta · Contenido y Navegación ────────────────────────────────────────
    { id: 'meta_landing_page_views',               label: 'Meta: Vistas de Landing Page' },
    { id: 'meta_cost_per_landing_page_view',       label: 'Meta: Costo por Vista LP' },
    { id: 'meta_view_content',                     label: 'Meta: Ver contenido (ViewContent)' },
    { id: 'meta_cost_per_view_content',            label: 'Meta: Costo por ViewContent' },
    { id: 'meta_search',                           label: 'Meta: Búsquedas (Search)' },
    { id: 'meta_add_to_wishlist',                  label: 'Meta: Lista de deseos' },
    { id: 'meta_customize_product',               label: 'Meta: Personalizar producto' },

    // ── Meta · Acciones locales y contacto ────────────────────────────────────
    { id: 'meta_contact',                          label: 'Meta: Contactos' },
    { id: 'meta_cost_per_contact',                 label: 'Meta: Costo por Contacto' },
    { id: 'meta_schedule',                         label: 'Meta: Citas agendadas' },
    { id: 'meta_cost_per_schedule',                label: 'Meta: Costo por Cita' },
    { id: 'meta_find_location',                    label: 'Meta: Encontrar ubicación' },
    { id: 'meta_donate',                           label: 'Meta: Donaciones' },

    // ── Meta · Video ──────────────────────────────────────────────────────────
    { id: 'meta_video_views',        label: 'Meta: Vistas de video' },
    { id: 'meta_video_3s_views',     label: 'Meta: Vistas 3 segundos' },
    { id: 'meta_video_thruplay',     label: 'Meta: ThruPlay' },
    { id: 'meta_cost_per_thruplay',  label: 'Meta: Costo por ThruPlay' },

    // ── Meta · Engagement ─────────────────────────────────────────────────────
    { id: 'meta_page_engagement',  label: 'Meta: Engagement de página' },
    { id: 'meta_post_engagement',  label: 'Meta: Engagement de publicación' },
    { id: 'meta_post_reactions',   label: 'Meta: Reacciones' },
    { id: 'meta_post_shares',      label: 'Meta: Compartidos' },
    { id: 'meta_post_saves',       label: 'Meta: Guardados' },
    { id: 'meta_post_comments',    label: 'Meta: Comentarios' },

    // ── Meta · Mensajería ─────────────────────────────────────────────────────
    { id: 'meta_messaging_conversations_started',  label: 'Meta: Conversaciones iniciadas' },
    { id: 'meta_cost_per_messaging_conversation',  label: 'Meta: Costo por Conversación' },

    // ── Meta · Resultado de objetivo ─────────────────────────────────────────
    { id: 'meta_results',          label: 'Meta: Resultados' },
    { id: 'meta_cost_per_result',  label: 'Meta: Costo por Resultado' },

    // ── Hotmart ───────────────────────────────────────────────────────────────
    { id: 'hotmart_pagos_iniciados',  label: 'Hotmart: Pagos Iniciados' },
    { id: 'hotmart_clics_link',       label: 'Hotmart: Clics Link' },

    // ── Ventas · Totales globales ─────────────────────────────────────────────
    { id: 'ventas_principal',        label: 'Ventas: Neto Principal' },
    { id: 'ventas_bump',             label: 'Ventas: Neto Bump' },
    { id: 'ventas_upsell',           label: 'Ventas: Neto Upsell' },
    { id: 'ventas_principal_bruto',  label: 'Ventas: Bruto Principal' },
    { id: 'ventas_bump_bruto',       label: 'Ventas: Bruto Bump' },
    { id: 'ventas_upsell_bruto',     label: 'Ventas: Bruto Upsell' },
    { id: 'ventas_principal_count',  label: 'Ventas: # Compras Principal' },
    { id: 'ventas_bump_count',       label: 'Ventas: # Compras Bump' },
    { id: 'ventas_upsell_count',     label: 'Ventas: # Compras Upsell' },
    { id: 'total_facturacion_bruta', label: 'Ventas: Facturación Bruta Total' },
    { id: 'total_facturacion_neta',  label: 'Ventas: Facturación Neta Total' },
    { id: 'total_roas',              label: 'Ventas: ROAS Total' },
    { id: 'total_roi',               label: 'Ventas: ROI Total' },
    { id: 'total_dinero_bolsa',      label: 'Ventas: Dinero en Bolsa Total' },
    { id: 'total_costo_compra',      label: 'Ventas: Costo/Compra Total' },

    // ── Funnel Hotmart · Métricas por pestaña ─────────────────────────────────
    { id: 'funnel_principal_count',    label: 'Funnel: # Compras Principal' },
    { id: 'funnel_principal_neto',     label: 'Funnel: Neto Principal' },
    { id: 'funnel_principal_bruto',    label: 'Funnel: Bruto Principal (API)' },
    { id: 'funnel_principal_price',    label: 'Funnel: Precio Público Principal' },
    { id: 'funnel_bump_count',         label: 'Funnel: # Order Bumps' },
    { id: 'funnel_bump_neto',          label: 'Funnel: Neto Order Bump' },
    { id: 'funnel_bump_bruto',         label: 'Funnel: Bruto Order Bump' },
    { id: 'funnel_upsell_count',       label: 'Funnel: # Upsells' },
    { id: 'funnel_upsell_neto',        label: 'Funnel: Neto Upsell' },
    { id: 'funnel_upsell_bruto',       label: 'Funnel: Bruto Upsell' },
    { id: 'funnel_upsell_visits',      label: 'Funnel: Visitas Pág. Upsell' },
    { id: 'funnel_pagos_iniciados',    label: 'Funnel: Pagos Iniciados (GA4)' },
    { id: 'funnel_facturacion_bruta',  label: 'Funnel: Facturación Bruta' },
    { id: 'funnel_facturacion_neta',   label: 'Funnel: Facturación Neta' },
    { id: 'funnel_roas',               label: 'Funnel: ROAS' },
    { id: 'funnel_roi',                label: 'Funnel: ROI' },
    { id: 'funnel_dinero_bolsa',       label: 'Funnel: Dinero en Bolsa' },
    { id: 'funnel_costo_compra',       label: 'Funnel: Costo/Compra' },
    { id: 'funnel_costo_visita',       label: 'Funnel: Costo/Visita' },
    { id: 'funnel_costo_pago',         label: 'Funnel: Costo/Pago Iniciado' },
    { id: 'funnel_pct_conversion',     label: 'Funnel: % Conversión General' },
    { id: 'funnel_pct_clics_visitas',  label: 'Funnel: % Clics→Visitas' },
    { id: 'funnel_pct_visitas_pagos',  label: 'Funnel: % Visitas→Pagos' },
    { id: 'funnel_pct_pagos_compras',  label: 'Funnel: % Pagos→Compras' },
    { id: 'funnel_pct_conv_order',     label: 'Funnel: % Conv. Order Bump' },
    { id: 'funnel_pct_conv_upsell',    label: 'Funnel: % Conv. Upsell' },

    // ── Google Analytics 4 ────────────────────────────────────────────────────
    { id: 'ga_sessions',              label: 'GA4: Sesiones' },
    { id: 'ga_bounce_rate',           label: 'GA4: Tasa de Rebote' },
    { id: 'ga_avg_session_duration',  label: 'GA4: Duración Media Sesión' },

    // ── TikTok Ads ────────────────────────────────────────────────────────────
    { id: 'tiktok_spend',             label: 'TikTok: Gasto' },
    { id: 'tiktok_impressions',       label: 'TikTok: Impresiones' },
    { id: 'tiktok_clicks',            label: 'TikTok: Clics' },
    { id: 'tiktok_conversions',       label: 'TikTok: Conversiones' },
    { id: 'tiktok_cpc',               label: 'TikTok: CPC' },
    { id: 'tiktok_cpm',               label: 'TikTok: CPM' },
    { id: 'tiktok_ctr',               label: 'TikTok: CTR (%)' },
    { id: 'tiktok_cpa',               label: 'TikTok: CPA' },

    // ── Manual ────────────────────────────────────────────────────────────────
    { id: 'leads_registrados', label: 'Leads Registrados (Manual)' },

    // ── Google Sheets · Leads ─────────────────────────────────────────────────
    { id: 'leads_totales',        label: 'GSheets: Leads Totales' },
    { id: 'leads_calificados',    label: 'GSheets: Leads Calificados' },
    { id: 'leads_no_calificados', label: 'GSheets: Leads No Calificados' },
    { id: 'tasa_calificacion',    label: 'GSheets: Tasa de Calificación (%)' },
]

/** Build dynamic metric list merging static + catalog custom conversions */
export function buildAvailableMetrics(conversionesCatalogo: { conversion_key: string; label: string; field_id: string }[]) {
    const dynamic = conversionesCatalogo.map(c => ({ id: c.field_id, label: `Meta: ${c.label}` }))
    // Merge, removing duplicates by id
    const existing = new Set(AVAILABLE_METRICS.map(m => m.id))
    const extras = dynamic.filter(d => !existing.has(d.id))
    return [...AVAILABLE_METRICS, ...extras]
}

// ─── Formula Input component ──────────────────────────────────────────────────

export function FormulaInput({ value, onChange, disabled, availableMetrics }: {
    value: string
    onChange: (val: string) => void
    disabled?: boolean
    availableMetrics?: { id: string; label: string }[]
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [search, setSearch] = useState('')
    const [activeTab, setActiveTab] = useState<'all' | 'meta' | 'tiktok' | 'ventas' | 'ga4'>('all')
    const metrics = availableMetrics || AVAILABLE_METRICS

    const insertMetric = (metricId: string) => {
        const currentPos = inputRef.current?.selectionStart || value.length
        const newVal = value.slice(0, currentPos) + (value.length > 0 && currentPos > 0 && !value.endsWith(' ') ? ' ' : '') + metricId + ' ' + value.slice(currentPos)
        onChange(newVal)
        setSearch('')
    }

    const filteredMetrics = metrics.filter(m => {
        const matchesSearch = m.label.toLowerCase().includes(search.toLowerCase()) || m.id.toLowerCase().includes(search.toLowerCase())
        if (!matchesSearch) return false
        if (activeTab === 'all') return true
        if (activeTab === 'meta') return m.id.startsWith('meta_')
        if (activeTab === 'tiktok') return m.id.startsWith('tiktok_')
        if (activeTab === 'ventas') return m.id.startsWith('ventas_') || m.id.startsWith('total_') || m.id.startsWith('funnel_')
        if (activeTab === 'ga4') return m.id.startsWith('ga_')
        return true
    })

    return (
        <div className="flex-1 flex relative items-center min-w-0">
            <Input
                ref={inputRef}
                value={value}
                onChange={e => onChange(e.target.value)}
                className={`h-7 text-xs bg-background border-border text-foreground w-full font-mono ${!disabled ? 'pr-8' : ''}`}
                placeholder="Fórmula"
                disabled={disabled}
            />
            {!disabled && (
                <Popover>
                    <PopoverTrigger asChild>
                        <button className="absolute right-1 text-muted-foreground/70 hover:text-indigo-400 p-1 transition bg-background rounded" title="Insertar métrica">
                            <Database className="w-3.5 h-3.5" />
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-0 bg-card border-border" style={{ zIndex: 9999 }} align="end" side="bottom" avoidCollisions={true} collisionBoundary={[]} collisionPadding={8}>
                        <div className="p-2 border-b border-border bg-background rounded-t-lg">
                            <Input
                                placeholder="Buscar métrica..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="h-8 text-xs bg-card border-border focus-visible:ring-indigo-500/50"
                            />
                        </div>
                        <div className="flex gap-1 p-1 bg-background border-b border-border text-[9px] overflow-x-auto custom-scrollbar">
                            {(['all', 'meta', 'tiktok', 'ventas', 'ga4'] as const).map(tab => (
                                <button
                                    key={tab}
                                    type="button"
                                    onClick={() => setActiveTab(tab)}
                                    className={`px-1.5 py-0.5 rounded transition whitespace-nowrap flex-shrink-0 ${activeTab === tab ? 'bg-indigo-600 text-white font-semibold' : 'text-muted-foreground hover:text-foreground'}`}
                                >
                                    {tab === 'all' ? 'Todos' : tab === 'ventas' ? 'Ventas' : tab === 'ga4' ? 'GA4' : tab === 'tiktok' ? 'TikTok' : 'Meta'}
                                </button>
                            ))}
                        </div>
                        <div className="max-h-48 overflow-y-auto custom-scrollbar p-1">
                            {filteredMetrics.map(m => (
                                <button
                                    key={m.id}
                                    onClick={() => insertMetric(m.id)}
                                    className="w-full text-left px-2 py-1.5 text-xs text-foreground/90 hover:bg-accent rounded transition flex flex-col gap-0.5"
                                >
                                    <span className="font-semibold text-foreground">{m.label}</span>
                                    <span className="text-[10px] text-muted-foreground/70 font-mono">{m.id}</span>
                                </button>
                            ))}
                            {filteredMetrics.length === 0 && (
                                <p className="text-center text-xs text-muted-foreground/70 py-4">No se encontraron métricas</p>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    )
}

// ─── Metric Type Selector ─────────────────────────────────────────────────────

export type MetricType = 'number' | 'currency' | 'percent'

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

export function MetricTypeSelector({ prefix, suffix, onChange }: {
    prefix?: string
    suffix?: string
    onChange: (vals: { prefix: string; suffix: string; decimals: number }) => void
}) {
    const current = getMetricType(prefix, suffix)
    const types: { type: MetricType; icon: string; label: string; active: string; inactive: string }[] = [
        { type: 'number', icon: '#', label: 'Número', active: 'bg-secondary text-secondary-foreground border-ring', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-muted-foreground/50 hover:text-foreground/90' },
        { type: 'currency', icon: '$', label: 'Moneda', active: 'bg-emerald-600/30 text-emerald-600 dark:text-emerald-300 border-emerald-500/60', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-emerald-500/40 hover:text-emerald-400' },
        { type: 'percent', icon: '%', label: 'Porcentaje', active: 'bg-blue-600/30 text-blue-600 dark:text-blue-300 border-blue-500/60', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-blue-500/40 hover:text-blue-400' },
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
    col, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics, campaignGroups = [], campaignNames = []
}: {
    col: ColDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (col: ColDef) => void
    onRemove: () => void
    availableMetrics?: { id: string; label: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
}) {
    return (
        <div
            className="relative group/row flex items-stretch"
            draggable
            onDragStart={(e) => { e.stopPropagation(); onDragStart(index) }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); onDragOver(e, index) }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(index) }}
        >
            <div
                className={`flex flex-col gap-1.5 bg-card border rounded-l-lg px-3 py-2.5 transition cursor-grab active:cursor-grabbing select-none flex-1 min-w-0 ${col.hidden ? 'border-border border-r-0 opacity-50' : 'border-border border-r-0 hover:border-muted-foreground/40'}`}
            >
                {/* Row 1: grip + eye + label + formula */}
                <div className="flex items-center gap-2">
                    <GripVertical className="w-4 h-4 text-muted-foreground/70 flex-shrink-0 group-hover/row:text-muted-foreground transition" />

                    <button
                        onClick={() => onUpdate({ ...col, hidden: !col.hidden })}
                        className="flex-shrink-0 text-muted-foreground/70 hover:text-foreground transition"
                        title={col.hidden ? 'Mostrar columna' : 'Ocultar columna'}
                    >
                        {col.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>

                    <Input
                        value={col.label}
                        onChange={e => onUpdate({ ...col, label: e.target.value })}
                        className="h-7 text-xs bg-background border-border text-foreground w-28 flex-shrink-0"
                        placeholder="Etiqueta"
                    />

                    <FormulaInput
                        value={col.formula}
                        onChange={val => onUpdate({ ...col, formula: val.trim() })}
                        disabled={col.formula === 'fecha'}
                        availableMetrics={availableMetrics}
                    />
                </div>

                {/* Row 2: type + highlight + campaign filter (only for non-fecha columns) */}
                {col.formula !== 'fecha' && (
                    <div className="flex flex-col gap-1 pl-6">
                        <div className="flex items-center gap-2">
                            <MetricTypeSelector
                                prefix={col.prefix}
                                suffix={col.suffix}
                                onChange={vals => onUpdate({ ...col, ...vals })}
                            />

                            <button
                                onClick={() => onUpdate({ ...col, highlight: !col.highlight })}
                                title="Colorear según impacto"
                                className={`flex-shrink-0 w-6 h-7 rounded border text-xs transition ${col.highlight ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-600 dark:text-indigo-400' : 'bg-card border-border text-muted-foreground/70 hover:text-muted-foreground'}`}
                            >
                                ✦
                            </button>

                            <CampaignFilterPicker
                                value={col.campaignFilter}
                                onChange={v => onUpdate({ ...col, campaignFilter: v })}
                                campaignGroups={campaignGroups}
                                campaignNames={campaignNames}
                            />

                            {col.isManual && (
                                <span className="flex-shrink-0 text-[9px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">
                                    Manual
                                </span>
                            )}
                        </div>

                    </div>
                )}
            </div>

            {/* Sticky delete button */}
            {col.formula !== 'fecha' && (
                <button
                    onClick={onRemove}
                    title="Eliminar columna"
                    className={`flex-shrink-0 flex items-center justify-center w-8 bg-card border border-l-0 rounded-r-lg transition text-muted-foreground/70 hover:text-red-400 hover:bg-red-400/5 hover:border-red-400/30 ${col.hidden ? 'border-border opacity-50' : 'border-border'}`}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    )
}

// ─── TikTok Account Picker ────────────────────────────────────────────────────

export const hasTikTokFormula = (formula: string) => formula.includes('tiktok_')

export function TikTokAccountPicker({
    value,
    accounts,
    onChange,
}: {
    value?: string
    accounts: { id: string; label: string; advertiser_id: string }[]
    onChange: (v: string) => void
}) {
    if (accounts.length === 0) return null
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground/70 shrink-0">Cuenta TikTok:</span>
            <select
                value={value || ''}
                onChange={e => onChange(e.target.value)}
                className="h-6 bg-background border border-border text-foreground/90 rounded px-1.5 text-xs"
            >
                <option value="">Todas las cuentas</option>
                {accounts.map(a => (
                    <option key={a.id} value={a.advertiser_id}>
                        {a.label} ({a.advertiser_id})
                    </option>
                ))}
            </select>
        </div>
    )
}

// ─── DnD Card Row ─────────────────────────────────────────────────────────────

export const COLOR_OPTIONS: { val: CardColor; bg: string }[] = [
    { val: 'default', bg: 'bg-muted-foreground/70' },
    { val: 'emerald', bg: 'bg-emerald-400' },
    { val: 'blue', bg: 'bg-blue-400' },
    { val: 'amber', bg: 'bg-amber-400' },
    { val: 'red', bg: 'bg-red-400' },
]

function DraggableCardRow({
    card, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, onDuplicate, availableMetrics, campaignGroups = [], campaignNames = [], tiktokAccounts = []
}: {
    card: CardDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (card: CardDef) => void
    onRemove: () => void
    onDuplicate?: () => void
    availableMetrics?: { id: string; label: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
}) {
    return (
        <div
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => { e.preventDefault(); onDragOver(e, index) }}
            onDrop={() => onDrop(index)}
            className="flex items-start gap-2 bg-card border border-border rounded-lg px-3 py-2.5 group transition cursor-grab active:cursor-grabbing select-none hover:border-muted-foreground/40"
        >
            <GripVertical className="w-4 h-4 text-muted-foreground/70 flex-shrink-0 group-hover:text-muted-foreground transition mt-1.5" />

            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                {/* Row 1: label + formula */}
                <div className="flex items-center gap-2">
                    <div className="flex gap-1 flex-shrink-0">
                        {COLOR_OPTIONS.map(opt => (
                            <button
                                key={opt.val}
                                onClick={() => onUpdate({ ...card, color: opt.val })}
                                className={`w-3 h-3 rounded-full ${opt.bg} transition ${card.color === opt.val ? 'ring-2 ring-ring ring-offset-2 ring-offset-background scale-110' : 'opacity-40 hover:opacity-100'}`}
                            />
                        ))}
                    </div>

                    <Input
                        value={card.label}
                        onChange={e => onUpdate({ ...card, label: e.target.value })}
                        className="h-7 text-xs bg-background border-border text-foreground w-28 flex-shrink-0"
                        placeholder="Etiqueta"
                    />

                    <FormulaInput
                        value={card.formula}
                        onChange={val => onUpdate({ ...card, formula: val.trim() })}
                        availableMetrics={availableMetrics}
                    />
                </div>

                {/* Row 2: type selector + campaign filter + TikTok account */}
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <MetricTypeSelector
                            prefix={card.prefix}
                            suffix={card.suffix}
                            onChange={vals => onUpdate({ ...card, ...vals })}
                        />
                        <CampaignFilterPicker
                            value={card.campaignFilter}
                            onChange={v => onUpdate({ ...card, campaignFilter: v })}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                        />
                    </div>
                    {hasTikTokFormula(card.formula) && (
                        <TikTokAccountPicker
                            value={card.account_id}
                            accounts={tiktokAccounts}
                            onChange={v => onUpdate({ ...card, account_id: v || undefined })}
                        />
                    )}
                </div>
            </div>

            <div className="flex flex-col gap-1 flex-shrink-0 mt-1.5">
                {onDuplicate && (
                    <button onClick={onDuplicate} title="Duplicar tarjeta" className="text-muted-foreground/50 hover:text-emerald-400 transition">
                        <Copy className="w-3.5 h-3.5" />
                    </button>
                )}
                <button onClick={onRemove} className="text-muted-foreground/50 hover:text-red-400 transition">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    )
}

// ─── DnD Chart Row ────────────────────────────────────────────────────────────

export const CHART_TYPES: { val: ChartType; label: string; icon: string }[] = [
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

export const CHART_COLOR_OPTIONS = [
    { val: 'amber',   hex: '#f59e0b' }, { val: 'cyan',    hex: '#22d3ee' },
    { val: 'blue',    hex: '#60a5fa' }, { val: 'violet',  hex: '#a78bfa' },
    { val: 'emerald', hex: '#34d399' }, { val: 'rose',    hex: '#fb7185' },
    { val: 'orange',  hex: '#fb923c' }, { val: 'red',     hex: '#f87171' },
    { val: 'indigo',  hex: '#818cf8' }, { val: 'teal',    hex: '#2dd4bf' },
    { val: 'lime',    hex: '#a3e635' }, { val: 'pink',    hex: '#f472b6' },
]

function DraggableChartRow({
    chart, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, onDuplicate, availableMetrics, campaignGroups = [], campaignNames = [], tiktokAccounts = []
}: {
    chart: ChartDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (chart: ChartDef) => void
    onRemove: () => void
    onDuplicate?: () => void
    availableMetrics?: { id: string; label: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
}) {
    const isCircular = chart.type === 'donut' || chart.type === 'pie' || chart.type === 'radial' || chart.type === 'funnel'
    const maxMetrics = chart.type === 'scatter' ? 2 : isCircular ? 6 : 5
    const isCartesian = ['area', 'stacked_area', 'bar', 'stacked_bar', 'line', 'composed'].includes(chart.type)

    function addMetric() {
        if (chart.valueFormulas.length >= maxMetrics) return
        onUpdate({
            ...chart,
            valueFormulas: [...chart.valueFormulas, ''],
            colors: [...(chart.colors || []), 'blue'],
            yAxes: chart.yAxes ? [...chart.yAxes, 'left'] : undefined,
            types: chart.types ? [...chart.types, ''] : undefined,
            strokeWidths: chart.strokeWidths ? [...chart.strokeWidths, 2] : undefined,
            units: chart.units ? [...chart.units, 'number'] : undefined
        })
    }

    function removeMetric(i: number) {
        const newF = chart.valueFormulas.filter((_, idx) => idx !== i)
        const newC = (chart.colors || []).filter((_, idx) => idx !== i)
        const newY = chart.yAxes ? chart.yAxes.filter((_, idx) => idx !== i) : undefined
        const newT = chart.types ? chart.types.filter((_, idx) => idx !== i) : undefined
        const newW = chart.strokeWidths ? chart.strokeWidths.filter((_, idx) => idx !== i) : undefined
        const newU = chart.units ? chart.units.filter((_, idx) => idx !== i) : undefined
        onUpdate({ ...chart, valueFormulas: newF, colors: newC, yAxes: newY, types: newT, strokeWidths: newW, units: newU })
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
            className="flex flex-col gap-2.5 bg-card border border-border rounded-xl p-3 group transition cursor-grab active:cursor-grabbing select-none hover:border-muted-foreground/40"
        >
            {/* Row 1: drag handle + type select + title + remove */}
            <div className="flex items-center gap-2">
                <GripVertical className="w-4 h-4 text-muted-foreground/70 flex-shrink-0 group-hover:text-muted-foreground transition" />

                <select
                    value={chart.type}
                    onChange={(e) => onUpdate({ ...chart, type: e.target.value as ChartType })}
                    className="h-7 text-xs bg-background border border-border text-foreground rounded px-1.5 max-w-[130px]"
                >
                    {CHART_TYPES.map(t => (
                        <option key={t.val} value={t.val}>{t.icon} {t.label}</option>
                    ))}
                </select>

                <Input
                    value={chart.title}
                    onChange={e => onUpdate({ ...chart, title: e.target.value })}
                    className="h-7 text-xs bg-background border-border text-foreground flex-1 min-w-[80px]"
                    placeholder="Título"
                />

                <div className="flex items-center gap-1 flex-shrink-0">
                    {onDuplicate && (
                        <button onClick={onDuplicate} title="Duplicar gráfico" className="text-muted-foreground/50 hover:text-emerald-400 transition">
                            <Copy className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button onClick={onRemove} className="text-muted-foreground/50 hover:text-red-400 transition">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Row 2: metrics list */}
            <div className="pl-6 space-y-2">
                {chart.valueFormulas.map((formula, i) => (
                    <div key={i} className="space-y-1.5 p-2 bg-background/40 rounded-lg border border-border">
                        <div className="flex items-center gap-1.5">
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
                                <button onClick={() => removeMetric(i)} className="text-muted-foreground/50 hover:text-red-400 transition flex-shrink-0">
                                    <X className="w-3 h-3" />
                                </button>
                            )}
                        </div>

                        {/* Series overrides */}
                        <div className="pl-7 mt-1.5 w-full">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-background/45 p-2 rounded-lg border border-border text-[9px] text-muted-foreground w-full min-w-0">
                                <div className="flex flex-col gap-1">
                                    <span className="text-muted-foreground/70 font-medium">Unidad</span>
                                    <div className="flex gap-1 flex-shrink-0">
                                        {[
                                            { type: 'number' as const, icon: '#', label: 'Número', active: 'bg-secondary text-secondary-foreground border-ring', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-muted-foreground/50 hover:text-foreground/90' },
                                            { type: 'currency' as const, icon: '$', label: 'Moneda', active: 'bg-emerald-600/30 text-emerald-600 dark:text-emerald-300 border-emerald-500/60', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-emerald-500/40 hover:text-emerald-400' },
                                            { type: 'percent' as const, icon: '%', label: 'Porcentaje', active: 'bg-blue-600/30 text-blue-600 dark:text-blue-300 border-blue-500/60', inactive: 'bg-card text-muted-foreground/70 border-border hover:border-blue-500/40 hover:text-blue-400' },
                                        ].map(t => {
                                            const currentUnit = chart.units?.[i] || 'number'
                                            const isActive = currentUnit === t.type
                                            return (
                                                <button
                                                    key={t.type}
                                                    type="button"
                                                    onClick={() => {
                                                        const newUnits: ('number' | 'currency' | 'percent')[] = [...(chart.units || [])]
                                                        while (newUnits.length < chart.valueFormulas.length) newUnits.push('number')
                                                        newUnits[i] = t.type
                                                        onUpdate({ ...chart, units: newUnits })
                                                    }}
                                                    title={t.label}
                                                    className={`w-6 h-6 rounded border text-[11px] font-bold transition flex-shrink-0 flex items-center justify-center ${isActive ? t.active : t.inactive}`}
                                                >
                                                    {t.icon}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>

                                {isCartesian ? (
                                    <>
                                        <div className="flex flex-col gap-1 min-w-0">
                                            <span className="text-muted-foreground/70 font-medium">Tipo</span>
                                            <select
                                                value={chart.types?.[i] || ''}
                                                onChange={(e) => {
                                                    const newTypes: ('line' | 'bar' | 'area' | '')[] = [...(chart.types || [])]
                                                    while (newTypes.length < chart.valueFormulas.length) newTypes.push('')
                                                    newTypes[i] = e.target.value as 'line' | 'bar' | 'area' | ''
                                                    onUpdate({ ...chart, types: newTypes })
                                                }}
                                                className="bg-card border border-border text-foreground/90 rounded px-1 py-0.5 outline-none cursor-pointer h-6 text-[10px] w-full min-w-0"
                                            >
                                                <option value="">Por defecto</option>
                                                <option value="line">Línea</option>
                                                <option value="bar">Barras</option>
                                                <option value="area">Área</option>
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1 min-w-0">
                                            <span className="text-muted-foreground/70 font-medium">Eje Y</span>
                                            <select
                                                value={chart.yAxes?.[i] || 'left'}
                                                onChange={(e) => {
                                                    const newAxes = [...(chart.yAxes || [])]
                                                    while (newAxes.length < chart.valueFormulas.length) newAxes.push('left')
                                                    newAxes[i] = e.target.value as 'left' | 'right'
                                                    onUpdate({ ...chart, yAxes: newAxes })
                                                }}
                                                className="bg-card border border-border text-foreground/90 rounded px-1 py-0.5 outline-none cursor-pointer h-6 text-[10px] w-full min-w-0"
                                            >
                                                <option value="left">Izq (Pral)</option>
                                                <option value="right">Der (Sec)</option>
                                            </select>
                                        </div>

                                        <div className="flex flex-col gap-1 min-w-0">
                                            <span className="text-muted-foreground/70 font-medium">Grosor</span>
                                            <select
                                                value={chart.strokeWidths?.[i] ?? 2}
                                                onChange={(e) => {
                                                    const newWidths = [...(chart.strokeWidths || [])]
                                                    while (newWidths.length < chart.valueFormulas.length) newWidths.push(2)
                                                    newWidths[i] = Number(e.target.value)
                                                    onUpdate({ ...chart, strokeWidths: newWidths })
                                                }}
                                                className="bg-card border border-border text-foreground/90 rounded px-1 py-0.5 outline-none cursor-pointer h-6 text-[10px] w-full min-w-0"
                                            >
                                                <option value={1}>1px</option>
                                                <option value={2}>2px</option>
                                                <option value={3}>3px</option>
                                                <option value={4}>4px</option>
                                                <option value={5}>5px</option>
                                            </select>
                                        </div>
                                    </>
                                ) : (
                                    <div className="col-span-3"></div>
                                )}
                            </div>
                        </div>
                    </div>
                ))}

                {/* Add metric button */}
                {chart.valueFormulas.length < maxMetrics && (
                    <button
                        onClick={addMetric}
                        className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-amber-400 transition mt-1 pl-1"
                    >
                        <Plus className="w-3 h-3" /> Añadir métrica
                    </button>
                )}

                {chart.type === 'scatter' && chart.valueFormulas.length < 2 && (
                    <p className="text-[9px] text-muted-foreground/70 mt-0.5 pl-1">El gráfico de dispersión necesita exactamente 2 métricas (eje X e Y).</p>
                )}
            </div>

            {/* Row 3: Global Chart Settings */}
            <div className="pl-6 pt-2 border-t border-border space-y-2 text-[10px]">
                {/* Periodicity & Show Data Labels */}
                <div className="flex flex-wrap items-center gap-4">
                    {isCartesian && (
                        <div className="flex flex-col gap-0.5">
                            <span className="text-muted-foreground/70 font-medium">Temporalidad por defecto:</span>
                            <select
                                value={chart.periodicity || 'day'}
                                onChange={(e) => onUpdate({ ...chart, periodicity: e.target.value as any })}
                                className="bg-background border border-border text-foreground/90 rounded px-1.5 py-0.5 outline-none hover:border-muted-foreground/30 cursor-pointer text-[9px]"
                            >
                                <option value="day">Día</option>
                                <option value="week">Semana</option>
                                <option value="month">Mes</option>
                                <option value="year">Año</option>
                            </select>
                        </div>
                    )}

                    <div className="flex items-center gap-1.5 mt-2">
                        <input
                            type="checkbox"
                            id={`labels-${chart.id}`}
                            checked={chart.showDataLabels || false}
                            onChange={(e) => onUpdate({ ...chart, showDataLabels: e.target.checked })}
                            className="rounded border-border bg-background text-amber-500 focus:ring-amber-500 w-3 h-3 cursor-pointer"
                        />
                        <label htmlFor={`labels-${chart.id}`} className="text-muted-foreground cursor-pointer">
                            Etiquetas de datos
                        </label>
                    </div>
                </div>

                {/* Campaign filter & Height */}
                <div className="flex flex-col gap-1 mt-1">
                    {chart.valueFormulas.some(hasTikTokFormula) && (
                        <TikTokAccountPicker
                            value={chart.account_id}
                            accounts={tiktokAccounts}
                            onChange={v => onUpdate({ ...chart, account_id: v || undefined })}
                        />
                    )}
                    <div className="flex items-center justify-between gap-2">
                        <CampaignFilterPicker
                            value={chart.campaignFilter}
                            onChange={v => onUpdate({ ...chart, campaignFilter: v })}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                        />
                        <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-muted-foreground/70">Alto:</span>
                            <input
                                type="number"
                                value={chart.height || 240}
                                onChange={(e) => onUpdate({ ...chart, height: Math.max(100, Number(e.target.value)) })}
                                className="w-12 h-6 text-xs text-center bg-background border border-border text-foreground/90 rounded outline-none"
                                min={100}
                                max={600}
                            />
                            <span className="text-muted-foreground/50 text-[9px]">px</span>
                        </div>
                    </div>
                </div>
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
    { label: 'Checkouts', formula: 'hotmart_pagos_iniciados' },
]

// ─── Campaign Filter Picker ───────────────────────────────────────────────────

const FILTER_OPERATORS: { value: CampaignFilterOperator; label: string; multi: boolean }[] = [
    { value: 'includes',    label: 'Incluye',         multi: false },
    { value: 'excludes',    label: 'Excluye',         multi: false },
    { value: 'exact',       label: 'Coincide con',    multi: false },
    { value: 'not_exact',   label: 'No coincide con', multi: false },
    { value: 'starts_with', label: 'Inicia con',      multi: false },
    { value: 'ends_with',   label: 'Finaliza con',    multi: false },
    { value: 'any_of',      label: 'Entre estas',     multi: true  },
    { value: 'none_of',     label: 'Fuera de estas',  multi: true  },
]

export function CampaignFilterPicker({
    value,
    onChange,
    campaignGroups,
    campaignNames = [],
}: {
    value?: CampaignFilterSpec
    onChange: (v: CampaignFilterSpec | undefined) => void
    campaignGroups: { id: string; nombre: string }[]
    campaignNames?: string[]
}) {
    const currentOp: CampaignFilterOperator = (value?.type === 'keyword' && value.operator) ? value.operator : 'includes'
    const isMulti = FILTER_OPERATORS.find(o => o.value === currentOp)?.multi ?? false

    const [kwSearch, setKwSearch] = useState(
        value?.type === 'keyword' && !isMulti && typeof value.value === 'string' ? value.value : ''
    )
    const [showSuggestions, setShowSuggestions] = useState(false)
    const [showMultiPanel, setShowMultiPanel] = useState(false)
    const [multiSearch, setMultiSearch] = useState('')

    useEffect(() => {
        if (value?.type !== 'keyword' || isMulti) setKwSearch('')
    }, [value, isMulti])

    const selectedMulti: string[] = (value?.type === 'keyword' && Array.isArray(value.value)) ? value.value : []

    const suggestions = campaignNames.filter(n =>
        kwSearch === '' || n.toLowerCase().includes(kwSearch.toLowerCase())
    )

    const filteredMultiNames = campaignNames.filter(n =>
        multiSearch === '' || n.toLowerCase().includes(multiSearch.toLowerCase())
    )

    function handleOperatorChange(op: CampaignFilterOperator) {
        const opDef = FILTER_OPERATORS.find(o => o.value === op)!
        if (opDef.multi) {
            onChange({ type: 'keyword', operator: op, value: selectedMulti })
            setShowMultiPanel(true)
        } else {
            const currentVal = typeof kwSearch === 'string' && kwSearch ? kwSearch : ''
            onChange(currentVal ? { type: 'keyword', operator: op, value: currentVal } : undefined)
        }
    }

    function toggleMultiItem(name: string) {
        const next = selectedMulti.includes(name)
            ? selectedMulti.filter(n => n !== name)
            : [...selectedMulti, name]
        onChange(next.length > 0 ? { type: 'keyword', operator: currentOp, value: next } : undefined)
    }

    const hasFilter = value !== undefined

    return (
        <div className="flex items-center gap-1.5 flex-shrink-0" title="Filtro de campaña (opcional)">
            <span className="text-[10px] text-muted-foreground/70 flex-shrink-0">Campaña:</span>

            {/* Group selector */}
            {campaignGroups.length > 0 && (
                <select
                    value={value?.type === 'group' && typeof value.value === 'string' ? value.value : ''}
                    onChange={e => {
                        if (e.target.value) onChange({ type: 'group', operator: undefined, value: e.target.value })
                        else if (value?.type === 'group') onChange(undefined)
                    }}
                    className="h-6 text-xs bg-background border border-border text-foreground/90 rounded px-1.5 max-w-[100px]"
                >
                    <option value="">Grupo...</option>
                    {campaignGroups.map(g => (
                        <option key={g.id} value={g.id}>{g.nombre}</option>
                    ))}
                </select>
            )}

            {/* Operator selector */}
            <select
                value={currentOp}
                onChange={e => handleOperatorChange(e.target.value as CampaignFilterOperator)}
                className="h-6 text-xs bg-background border border-border text-foreground/90 rounded px-1.5 max-w-[120px]"
            >
                {FILTER_OPERATORS.map(op => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                ))}
            </select>

            {/* Text input for single-value operators */}
            {!isMulti && (
                <Popover open={showSuggestions && suggestions.length > 0} onOpenChange={open => { if (!open) setShowSuggestions(false) }}>
                    <PopoverAnchor asChild>
                        <Input
                            value={kwSearch}
                            onChange={e => {
                                setKwSearch(e.target.value)
                                if (e.target.value) onChange({ type: 'keyword', operator: currentOp, value: e.target.value })
                                else if (value?.type === 'keyword') onChange(undefined)
                                setShowSuggestions(true)
                            }}
                            onFocus={() => setShowSuggestions(true)}
                            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                            placeholder="Buscar campaña..."
                            className="h-6 text-xs bg-background border-border text-foreground/90 w-40"
                        />
                    </PopoverAnchor>
                    <PopoverContent
                        className="p-0 bg-card border-border w-56 max-h-48 overflow-y-auto custom-scrollbar"
                        style={{ zIndex: 9999 }}
                        align="start"
                        side="bottom"
                        avoidCollisions={true}
                        collisionBoundary={[]}
                        collisionPadding={8}
                        onOpenAutoFocus={e => e.preventDefault()}
                    >
                        {suggestions.map(name => (
                            <button
                                key={name}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => {
                                    setKwSearch(name)
                                    onChange({ type: 'keyword', operator: currentOp, value: name })
                                    setShowSuggestions(false)
                                }}
                                className="w-full text-left px-2 py-1.5 text-xs text-foreground/90 hover:bg-accent transition truncate block"
                            >
                                {name}
                            </button>
                        ))}
                    </PopoverContent>
                </Popover>
            )}

            {/* Multi-select panel for any_of / none_of */}
            {isMulti && (
                <Popover open={showMultiPanel} onOpenChange={open => { setShowMultiPanel(open); if (!open) setMultiSearch('') }}>
                    <PopoverTrigger asChild>
                        <button
                            className={`h-6 px-2 text-xs rounded border transition flex items-center gap-1 ${
                                selectedMulti.length > 0
                                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-600 dark:text-indigo-300'
                                    : 'bg-background border-border text-muted-foreground hover:border-muted-foreground/50'
                            }`}
                        >
                            {selectedMulti.length > 0 ? `${selectedMulti.length} campaña${selectedMulti.length > 1 ? 's' : ''}` : 'Seleccionar...'}
                            <ChevronRight className={`w-3 h-3 transition-transform ${showMultiPanel ? 'rotate-90' : ''}`} />
                        </button>
                    </PopoverTrigger>
                    <PopoverContent
                        className="p-0 bg-card border-border w-64"
                        style={{ zIndex: 9999 }}
                        align="start"
                        side="bottom"
                        avoidCollisions={true}
                        collisionBoundary={[]}
                        collisionPadding={8}
                        onOpenAutoFocus={e => e.preventDefault()}
                    >
                        <div className="p-2 border-b border-border">
                            <Input
                                value={multiSearch}
                                onChange={e => setMultiSearch(e.target.value)}
                                placeholder="Buscar campaña..."
                                className="h-6 text-xs bg-background border-border text-foreground/90 w-full"
                                autoFocus
                            />
                        </div>
                        <div className="max-h-52 overflow-y-auto custom-scrollbar py-1">
                            {filteredMultiNames.length === 0 ? (
                                <p className="px-3 py-2 text-xs text-muted-foreground/70">Sin resultados</p>
                            ) : filteredMultiNames.map(name => {
                                const checked = selectedMulti.includes(name)
                                return (
                                    <button
                                        key={name}
                                        onClick={() => toggleMultiItem(name)}
                                        className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-accent transition"
                                    >
                                        <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition ${
                                            checked ? 'bg-indigo-500 border-indigo-500' : 'border-muted-foreground/40'
                                        }`}>
                                            {checked && <Check className="w-2.5 h-2.5 text-white" />}
                                        </span>
                                        <span className={`truncate ${checked ? 'text-indigo-600 dark:text-indigo-300' : 'text-foreground/90'}`}>{name}</span>
                                    </button>
                                )
                            })}
                        </div>
                        {selectedMulti.length > 0 && (
                            <div className="p-2 border-t border-border flex justify-between items-center">
                                <span className="text-[10px] text-muted-foreground/70">{selectedMulti.length} seleccionada{selectedMulti.length > 1 ? 's' : ''}</span>
                                <button
                                    onClick={() => onChange(undefined)}
                                    className="text-[10px] text-red-600 dark:text-red-400 hover:text-red-300 transition"
                                >
                                    Limpiar
                                </button>
                            </div>
                        )}
                    </PopoverContent>
                </Popover>
            )}

            {/* Clear button */}
            {hasFilter && (
                <button
                    onClick={() => { onChange(undefined); setKwSearch('') }}
                    title="Limpiar filtro de campaña"
                    className="text-muted-foreground/70 hover:text-red-400 transition flex-shrink-0"
                >
                    <X className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}

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
    campaignGroups = [],
    campaignNames = [],
    tiktokAccounts = [],
}: {
    clienteId: string
    currentLayout: ReportLayout | null
    allLayouts: any[]
    isCustomized: boolean
    onClose: () => void
    onLayoutApplied: (layout: ReportLayout) => void
    tabId?: string
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
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
        const layout = res.data as ReportLayout
        setWorkingLayout({ ...layout, blocks_order: reconcileOrder(layout) })
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

    const reconcileOrder = useCallback((layout: ReportLayout): string[] => {
        const availableBlockIds: string[] = [
            ...layout.tarjetas.map(t => `card:${t.id}`),
            ...(layout.graficos || []).map(g => `chart:${g.id}`),
            'table',
            ...(layout.text_blocks || []).map(t => `text:${t.id}`),
            ...(layout.ranking_tables || []).map(r => `ranking:${r.id}`),
        ]
        const savedOrder = layout.blocks_order || []
        const validSaved = savedOrder.filter(id => availableBlockIds.includes(id))
        const missingFromSaved = availableBlockIds.filter(id => !savedOrder.includes(id))
        return [...validSaved, ...missingFromSaved]
    }, [])

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

    function addCustomMetric() {
        // Obsolete as per new requirements
    }

    function addTextBlock() {
        if (!workingLayout) return
        const newText: import('@/lib/layout-types').TextBlockDef = {
             id: crypto.randomUUID(),
             content: 'Nuevo Título',
             style: 'h2',
             align: 'left'
        }
        setWorkingLayout({ 
            ...workingLayout, 
            text_blocks: [...(workingLayout.text_blocks || []), newText],
            blocks_order: [...(workingLayout.blocks_order || []), `text:${newText.id}`]
        })
    }

    function updateTextBlock(index: number, val: Partial<import('@/lib/layout-types').TextBlockDef>) {
        if (!workingLayout) return
        const newBlocks = [...(workingLayout.text_blocks || [])]
        newBlocks[index] = { ...newBlocks[index], ...val }
        setWorkingLayout({ ...workingLayout, text_blocks: newBlocks })
    }

    function duplicateCard(index: number) {
        if (!workingLayout) return
        const source = workingLayout.tarjetas[index]
        if (!source) return
        const copy = { ...source, id: crypto.randomUUID(), label: `${source.label} (copia)` }
        const cards = [...workingLayout.tarjetas]
        cards.splice(index + 1, 0, copy)
        const newOrder = [...(workingLayout.blocks_order || [])]
        const pos = newOrder.indexOf(`card:${source.id}`)
        if (pos >= 0) newOrder.splice(pos + 1, 0, `card:${copy.id}`)
        else newOrder.push(`card:${copy.id}`)
        setWorkingLayout({ ...workingLayout, tarjetas: cards, blocks_order: newOrder })
    }

    function duplicateChart(index: number) {
        if (!workingLayout) return
        const source = (workingLayout.graficos || [])[index]
        if (!source) return
        const copy = { ...source, id: crypto.randomUUID(), title: `${source.title} (copia)`, colors: [...(source.colors || [])], valueFormulas: [...source.valueFormulas] }
        const charts = [...(workingLayout.graficos || [])]
        charts.splice(index + 1, 0, copy)
        const newOrder = [...(workingLayout.blocks_order || [])]
        const pos = newOrder.indexOf(`chart:${source.id}`)
        if (pos >= 0) newOrder.splice(pos + 1, 0, `chart:${copy.id}`)
        else newOrder.push(`chart:${copy.id}`)
        setWorkingLayout({ ...workingLayout, graficos: charts, blocks_order: newOrder })
    }

    function duplicateRankingTable(index: number) {
        if (!workingLayout) return
        const source = (workingLayout.ranking_tables || [])[index]
        if (!source) return
        const copy = { ...source, id: crypto.randomUUID(), title: `${source.title} (copia)`, columns: source.columns.map((c: any) => ({ ...c })) }
        const tables = [...(workingLayout.ranking_tables || [])]
        tables.splice(index + 1, 0, copy)
        const newOrder = [...(workingLayout.blocks_order || [])]
        const pos = newOrder.indexOf(`ranking:${source.id}`)
        if (pos >= 0) newOrder.splice(pos + 1, 0, `ranking:${copy.id}`)
        else newOrder.push(`ranking:${copy.id}`)
        setWorkingLayout({ ...workingLayout, ranking_tables: tables, blocks_order: newOrder })
    }

    function duplicateTextBlock(index: number) {
        if (!workingLayout) return
        const source = (workingLayout.text_blocks || [])[index]
        if (!source) return
        const copy = { ...source, id: crypto.randomUUID() }
        const newBlocks = [...(workingLayout.text_blocks || [])]
        newBlocks.splice(index + 1, 0, copy)
        const newOrder = [...(workingLayout.blocks_order || [])]
        const sourceKey = `text:${source.id}`
        const pos = newOrder.indexOf(sourceKey)
        newOrder.splice(pos + 1, 0, `text:${copy.id}`)
        setWorkingLayout({ ...workingLayout, text_blocks: newBlocks, blocks_order: newOrder })
    }

    function removeTextBlock(index: number) {
        if (!workingLayout) return
        const newBlocks = [...(workingLayout.text_blocks || [])]
        const blockToRemove = newBlocks[index]
        newBlocks.splice(index, 1)
        
        const newOrder = (workingLayout.blocks_order || []).filter(id => id !== `text:${blockToRemove.id}`)
        setWorkingLayout({ 
            ...workingLayout, 
            text_blocks: newBlocks,
            blocks_order: newOrder
        })
    }

    function addRankingTable() {
        if (!workingLayout) return
        const newTable: RankingTableDef = {
            id: crypto.randomUUID(),
            title: 'Nueva Tabla de Ranking',
            dimension: 'campaigns',
            columns: [
                { formula: 'meta_spend', label: 'Gasto', prefix: '$', decimals: 2 },
                { formula: 'meta_leads', label: 'Leads', decimals: 0 },
                { formula: 'meta_spend / meta_leads', label: 'CPL', prefix: '$', decimals: 2 },
            ],
            topN: 10,
            sortColumnIndex: 0,
            sortOrder: 'desc',
            showRank: true,
        }
        const newTables = [...(workingLayout.ranking_tables || []), newTable]
        const newOrder = [...(workingLayout.blocks_order || []), `ranking:${newTable.id}`]
        setWorkingLayout({ ...workingLayout, ranking_tables: newTables, blocks_order: newOrder })
    }

    function updateRankingTable(index: number, table: RankingTableDef) {
        if (!workingLayout) return
        const tables = [...(workingLayout.ranking_tables || [])]
        tables[index] = table
        setWorkingLayout({ ...workingLayout, ranking_tables: tables })
    }

    function removeRankingTable(index: number) {
        if (!workingLayout) return
        const table = (workingLayout.ranking_tables || [])[index]
        if (!table) return
        const tables = (workingLayout.ranking_tables || []).filter((_, i) => i !== index)
        const newOrder = (workingLayout.blocks_order || []).filter(id => id !== `ranking:${table.id}`)
        setWorkingLayout({ ...workingLayout, ranking_tables: tables, blocks_order: newOrder })
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
                text_blocks: workingLayout.text_blocks,
                custom_metrics: workingLayout.custom_metrics,
                blocks_order: reconcileOrder(workingLayout),
                ranking_tables: workingLayout.ranking_tables,
            })
        } else {
            res = await saveClienteLayout(clienteId, {
                columnas: workingLayout.columnas,
                tarjetas: workingLayout.tarjetas,
                graficos: workingLayout.graficos,
                text_blocks: workingLayout.text_blocks,
                custom_metrics: workingLayout.custom_metrics,
                blocks_order: reconcileOrder(workingLayout),
                ranking_tables: workingLayout.ranking_tables,
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
                className="relative bg-[#0a0a0c] border border-border rounded-2xl shadow-2xl w-full max-w-6xl max-h-[95vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background/60 flex-shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                            <LayoutDashboard className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div className="flex flex-col">
                            <h2 className="text-base font-bold text-foreground tracking-tight flex items-center gap-2">
                                {tabId && tabId !== 'general' ? 'Personalizar Vista de Pestaña' : 'Personalización de Layout'}
                                {isCustomized && (!tabId || tabId === 'general') && (
                                    <span className="text-[10px] bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 font-bold px-2 py-0.5 rounded uppercase tracking-wide border border-indigo-500/30">
                                        Personalizado
                                    </span>
                                )}
                            </h2>
                            <p className="text-xs text-muted-foreground/70">
                                {tabId && tabId !== 'general'
                                    ? 'Los cambios se aplicarán UNICAMENTE a esta pestaña.'
                                    : 'Ajusta métricas, orden y visibilidad exclusivos para este cliente.'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {step === 'edit' && isCustomized && (
                            <Button size="sm" variant="ghost" onClick={handleReset} disabled={loading} className="text-muted-foreground/70 hover:text-red-400 gap-1.5 text-xs">
                                <RotateCcw className="w-3.5 h-3.5" /> Restablecer
                            </Button>
                        )}
                        <button onClick={onClose} className="text-muted-foreground/70 hover:text-foreground transition p-1.5 hover:bg-accent rounded-lg">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">
                    {step === 'select' ? (
                        <div className="max-w-2xl mx-auto space-y-4 py-8">
                            <div className="text-center mb-8">
                                <h3 className="text-xl font-semibold text-foreground">Elige una plantilla de inicio</h3>
                                <p className="text-sm text-muted-foreground mt-2">Se creará una copia privada para que puedas editarla libremente.</p>
                            </div>
                            {allLayouts.map(l => (
                                <button
                                    key={l.id}
                                    onClick={() => handleSelectTemplate(l.id)}
                                    className="w-full text-left bg-card hover:bg-accent border border-border hover:border-indigo-500/50 rounded-xl p-5 group transition"
                                >
                                    <div className="flex justify-between items-center">
                                        <span className="text-base font-semibold text-foreground group-hover:text-indigo-400 transition">{l.nombre}</span>
                                        <ChevronRight className="w-5 h-5 text-muted-foreground/70 transition group-hover:translate-x-1 group-hover:text-indigo-400" />
                                    </div>
                                    <p className="text-xs text-muted-foreground/70 mt-1">{l.descripcion}</p>
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
                                        <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Columnas de Tabla</h3>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={addManualMetric} className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:text-emerald-300 flex items-center gap-1 bg-emerald-500/10 px-2 py-1 rounded transition">
                                            <Plus className="w-3 h-3" /> Input Manual
                                        </button>
                                        <button onClick={() => addPreset(PRESETS[0], 'col')} className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 px-2 py-1 rounded transition">
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
                                                campaignGroups={campaignGroups}
                                                campaignNames={campaignNames}
                                            />
                                        </div>
                                    ))}
                                </div>

                                <div className="pt-2">
                                    <p className="text-[10px] text-muted-foreground/70 font-bold uppercase mb-2">Añadir métrica rápida:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {PRESETS.map(p => (
                                            <button key={p.formula} onClick={() => addPreset(p, 'col')} className="text-[10px] bg-card border border-border hover:border-indigo-500/40 text-muted-foreground hover:text-indigo-300 px-2 py-1 rounded transition">
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
                                        <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Tarjetas Superiores</h3>
                                    </div>
                                    <button onClick={() => addPreset(PRESETS[0], 'card')} className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
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
                                                onDuplicate={() => duplicateCard(i)}
                                                availableMetrics={availableMetrics}
                                                campaignGroups={campaignGroups}
                                                campaignNames={campaignNames}
                                                tiktokAccounts={tiktokAccounts}
                                            />
                                        </div>
                                    ))}
                                    {workingLayout.tarjetas.length === 0 && (
                                        <div className="border border-border border-dashed rounded-xl p-8 text-center bg-background/20">
                                            <LayoutPanelTop className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2 opacity-50" />
                                            <p className="text-xs text-muted-foreground/70">No hay tarjetas configuradas.</p>
                                        </div>
                                    )}
                                </div>

                                <div className="pt-2">
                                    <p className="text-[10px] text-muted-foreground/70 font-bold uppercase mb-2">Añadir tarjeta rápida:</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {PRESETS.map(p => (
                                            <button key={p.formula} onClick={() => addPreset(p, 'card')} className="text-[10px] bg-card border border-border hover:border-emerald-500/40 text-muted-foreground hover:text-emerald-300 px-2 py-1 rounded transition">
                                                {p.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Charts Section */}
                        <div className="pt-8 border-t border-border space-y-4">
                             <div className="flex items-center justify-between">
                                 <div className="flex items-center gap-2">
                                     <div className="w-1 h-4 bg-amber-500 rounded-full" />
                                     <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Gráficos de Rendimiento</h3>
                                 </div>
                                 <button onClick={addChart} className="text-[10px] text-amber-600 dark:text-amber-400 hover:text-amber-300 flex items-center gap-1 bg-amber-500/10 px-2 py-1 rounded transition">
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
                                        onDuplicate={() => duplicateChart(i)}
                                        availableMetrics={availableMetrics}
                                        campaignGroups={campaignGroups}
                                        campaignNames={campaignNames}
                                        tiktokAccounts={tiktokAccounts}
                                    />
                                ))}
                                {(!workingLayout.graficos || workingLayout.graficos.length === 0) && (
                                     <div className="col-span-full border border-border border-dashed rounded-xl p-8 text-center bg-background/20">
                                         <BarChart3 className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2 opacity-50" />
                                         <p className="text-xs text-muted-foreground/70">No hay gráficos configurados. Haz clic en "Añadir Gráfico" para crear uno.</p>
                                     </div>
                                )}
                             </div>
                        </div>
                        
                        {/* Text Blocks / Titles Section */}
                        <div className="pt-8 border-t border-border space-y-4">
                             <div className="flex items-center justify-between">
                                 <div className="flex items-center gap-2">
                                     <div className="w-1 h-4 bg-purple-500 rounded-full" />
                                     <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Títulos y Separadores</h3>
                                 </div>
                                 <button onClick={addTextBlock} className="text-[10px] text-purple-600 dark:text-purple-400 hover:text-purple-300 flex items-center gap-1 bg-purple-500/10 px-2 py-1 rounded transition">
                                     <Plus className="w-3 h-3" /> Añadir Título
                                 </button>
                             </div>

                             <div className="space-y-3">
                                {(workingLayout.text_blocks || []).map((block: any, i: number) => (
                                    <div key={block.id} className="flex flex-col gap-3 bg-card border border-border rounded-xl p-4">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1 space-y-3">
                                                <Input
                                                    value={block.content}
                                                    onChange={e => updateTextBlock(i, { content: e.target.value })}
                                                    className="h-9 text-sm font-bold bg-background border-border text-foreground placeholder:text-muted-foreground/70"
                                                    placeholder="Escribe el título aquí..."
                                                />
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <select 
                                                        value={block.style} 
                                                        onChange={e => updateTextBlock(i, { style: e.target.value as any })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Grosor (Jerarquía)"
                                                    >
                                                        <option value="h1">Grosor H1 (Bold)</option>
                                                        <option value="h2">Grosor H2 (Semibold)</option>
                                                        <option value="h3">Grosor H3 (Medium)</option>
                                                        <option value="p">Grosor Normal</option>
                                                    </select>
                                                    <select 
                                                        value={block.fontSize || ''} 
                                                        onChange={e => updateTextBlock(i, { fontSize: e.target.value as any })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Tamaño Personalizado"
                                                    >
                                                        <option value="">Tamaño Default</option>
                                                        <option value="sm">Pequeño</option>
                                                        <option value="base">Normal</option>
                                                        <option value="xl">Extra Grande</option>
                                                        <option value="2xl">2XL</option>
                                                        <option value="4xl">4XL</option>
                                                        <option value="6xl">6XL</option>
                                                        <option value="8xl">8XL (Gigante)</option>
                                                    </select>
                                                    <select 
                                                        value={block.fontFamily || ''} 
                                                        onChange={e => updateTextBlock(i, { fontFamily: e.target.value as any })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Tipografía"
                                                    >
                                                        <option value="">Fuente (Sans)</option>
                                                        <option value="serif">Serif (Clásica)</option>
                                                        <option value="mono">Monoespaciada</option>
                                                    </select>
                                                    <select 
                                                        value={block.color || 'white'} 
                                                        onChange={e => updateTextBlock(i, { color: e.target.value as any })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Color del texto"
                                                    >
                                                        <option value="white">Blanco</option>
                                                        <option value="zinc">Gris Zinc</option>
                                                        <option value="indigo">Índigo</option>
                                                        <option value="emerald">Verde Esmeralda</option>
                                                        <option value="amber">Ámbar (Amarillo)</option>
                                                        <option value="rose">Rosa / Rojo</option>
                                                        <option value="cyan">Cyan</option>
                                                        <option value="blue">Azul</option>
                                                    </select>
                                                    <select 
                                                        value={block.align || 'left'} 
                                                        onChange={e => updateTextBlock(i, { align: e.target.value as 'left' | 'center' | 'right' })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Alineación"
                                                    >
                                                        <option value="left">Izquierda</option>
                                                        <option value="center">Centro</option>
                                                        <option value="right">Derecha</option>
                                                    </select>
                                                    <select 
                                                        value={block.backgroundColor || ''} 
                                                        onChange={e => updateTextBlock(i, { backgroundColor: e.target.value })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Fondo de Tarjeta"
                                                    >
                                                        <option value="">Sin Fondo (Transparente)</option>
                                                        <option value="bg-card/60 border-border">Gris Suave</option>
                                                        <option value="bg-card border-border">Gris Sólido (Tarjeta)</option>
                                                        <option value="bg-indigo-500/10 border-indigo-500/20">Índigo Sutil</option>
                                                        <option value="bg-emerald-500/10 border-emerald-500/20">Verde Sutil</option>
                                                        <option value="bg-amber-500/10 border-amber-500/20">Ámbar Sutil</option>
                                                        <option value="bg-rose-500/10 border-rose-500/20">Rosa Sutil</option>
                                                        <option value="bg-indigo-600 border-indigo-500 text-white">Índigo Sólido</option>
                                                    </select>
                                                    <select 
                                                        value={block.borderRadius || 'xl'} 
                                                        onChange={e => updateTextBlock(i, { borderRadius: e.target.value as any })}
                                                        className="bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground/90 outline-none hover:border-muted-foreground/30 cursor-pointer"
                                                        title="Redondeado"
                                                    >
                                                        <option value="none">Esquinas Rectas</option>
                                                        <option value="sm">Redondeado SM</option>
                                                        <option value="md">Redondeado MD</option>
                                                        <option value="lg">Redondeado LG</option>
                                                        <option value="xl">Redondeado XL (Default)</option>
                                                        <option value="2xl">Redondeado 2XL</option>
                                                        <option value="full">Cápsula (Full)</option>
                                                    </select>
                                                </div>
                                            </div>
                                            <button onClick={() => duplicateTextBlock(i)} title="Duplicar título" className="text-muted-foreground/70 hover:text-purple-400 p-1.5 rounded bg-background border border-border transition flex-shrink-0">
                                                <Copy className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => removeTextBlock(i)} title="Eliminar título" className="text-muted-foreground/70 hover:text-red-400 p-1.5 rounded bg-background border border-border transition flex-shrink-0">
                                                <X className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {(!workingLayout.text_blocks || workingLayout.text_blocks.length === 0) && (
                                     <div className="border border-border border-dashed rounded-xl p-8 text-center bg-background/20">
                                         <p className="text-xs text-muted-foreground/70">No hay títulos configurados. Puedes usarlos para separar secciones en el Dashboard.</p>
                                     </div>
                                )}
                             </div>
                        </div>
                        {/* Rankings Section */}
                        <div className="pt-8 border-t border-border space-y-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div className="w-1 h-4 bg-cyan-500 rounded-full" />
                                    <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Tablas de Ranking</h3>
                                </div>
                                <button onClick={addRankingTable} className="text-[10px] text-cyan-600 dark:text-cyan-400 hover:text-cyan-300 flex items-center gap-1 bg-cyan-500/10 px-2 py-1 rounded transition">
                                    <Plus className="w-3 h-3" /> Agregar tabla
                                </button>
                            </div>

                            <div className="space-y-4">
                                {(workingLayout?.ranking_tables || []).map((table, ti) => (
                                    <div key={table.id} className="bg-card border border-border rounded-xl p-4 space-y-3">
                                        {/* Table header row */}
                                        <div className="flex items-center gap-2">
                                            <Input
                                                value={table.title}
                                                onChange={e => updateRankingTable(ti, { ...table, title: e.target.value })}
                                                className="h-7 text-xs bg-background border-border text-foreground flex-1"
                                                placeholder="Título de la tabla"
                                            />
                                            <button onClick={() => duplicateRankingTable(ti)} title="Duplicar tabla" className="flex-shrink-0 text-muted-foreground/50 hover:text-emerald-400 transition">
                                                <Copy className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => removeRankingTable(ti)} className="flex-shrink-0 text-muted-foreground/50 hover:text-red-400 transition">
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                        {/* Settings row */}
                                        <div className="flex flex-wrap items-center gap-2 text-[10px]">
                                            <div className="flex items-center gap-1">
                                                <span className="text-muted-foreground/70">Dimensión:</span>
                                                <select
                                                    value={table.dimension}
                                                    onChange={e => updateRankingTable(ti, { ...table, dimension: e.target.value as any })}
                                                    className="h-6 bg-background border border-border text-foreground/90 rounded px-1.5"
                                                >
                                                    <optgroup label="Meta">
                                                        <option value="campaigns">Campañas</option>
                                                        <option value="ads">Anuncios</option>
                                                        <option value="adsets">Conjuntos</option>
                                                    </optgroup>
                                                    <optgroup label="TikTok">
                                                        <option value="tiktok_campaigns">Campañas</option>
                                                        <option value="tiktok_ads">Anuncios</option>
                                                        <option value="tiktok_adgroups">Grupos</option>
                                                    </optgroup>
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-muted-foreground/70">Top:</span>
                                                <select
                                                    value={table.topN}
                                                    onChange={e => updateRankingTable(ti, { ...table, topN: Number(e.target.value) })}
                                                    className="h-6 bg-background border border-border text-foreground/90 rounded px-1.5"
                                                >
                                                    {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-muted-foreground/70">Orden:</span>
                                                <select
                                                    value={table.sortOrder}
                                                    onChange={e => updateRankingTable(ti, { ...table, sortOrder: e.target.value as 'desc' | 'asc' })}
                                                    className="h-6 bg-background border border-border text-foreground/90 rounded px-1.5"
                                                >
                                                    <option value="desc">Mayor → Menor</option>
                                                    <option value="asc">Menor → Mayor</option>
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-muted-foreground/70">Columna de orden:</span>
                                                <select
                                                    value={table.sortColumnIndex}
                                                    onChange={e => updateRankingTable(ti, { ...table, sortColumnIndex: Number(e.target.value) })}
                                                    className="h-6 bg-background border border-border text-foreground/90 rounded px-1.5"
                                                >
                                                    {table.columns.map((col, ci) => (
                                                        <option key={ci} value={ci}>{col.label || `Col ${ci + 1}`}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <label className="flex items-center gap-1 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={table.showRank !== false}
                                                    onChange={e => updateRankingTable(ti, { ...table, showRank: e.target.checked })}
                                                    className="w-3 h-3 accent-cyan-500"
                                                />
                                                <span className="text-muted-foreground">Mostrar #</span>
                                            </label>
                                        </div>

                                        {/* Campaign filter — Meta only */}
                                        {!table.dimension.startsWith('tiktok_') && (
                                            <div className="pl-1">
                                                <CampaignFilterPicker
                                                    value={table.campaignFilter}
                                                    onChange={v => updateRankingTable(ti, { ...table, campaignFilter: v })}
                                                    campaignGroups={campaignGroups}
                                                    campaignNames={campaignNames}
                                                />
                                            </div>
                                        )}

                                        {/* TikTok account picker — visible for TikTok dimensions */}
                                        {table.dimension.startsWith('tiktok_') && (
                                            <div className="pl-1">
                                                <TikTokAccountPicker
                                                    value={table.account_id}
                                                    accounts={tiktokAccounts}
                                                    onChange={v => updateRankingTable(ti, { ...table, account_id: v || undefined })}
                                                />
                                            </div>
                                        )}

                                        {/* Columns list */}
                                        <div className="space-y-2 pt-1 border-t border-border">
                                            <p className="text-[10px] text-muted-foreground/70 font-medium uppercase">Columnas de métricas</p>
                                            {table.columns.map((col, ci) => (
                                                <div key={ci} className="flex items-center gap-1.5">
                                                    <Input
                                                        value={col.label}
                                                        onChange={e => {
                                                            const cols = [...table.columns]
                                                            cols[ci] = { ...col, label: e.target.value }
                                                            updateRankingTable(ti, { ...table, columns: cols })
                                                        }}
                                                        className="h-6 text-xs bg-background border-border text-foreground w-24 flex-shrink-0"
                                                        placeholder="Etiqueta"
                                                    />
                                                    <div className="flex-1">
                                                        <FormulaInput
                                                            value={col.formula}
                                                            onChange={val => {
                                                                const cols = [...table.columns]
                                                                cols[ci] = { ...col, formula: val.trim() }
                                                                updateRankingTable(ti, { ...table, columns: cols })
                                                            }}
                                                            availableMetrics={availableMetrics}
                                                        />
                                                    </div>
                                                    <MetricTypeSelector
                                                        prefix={col.prefix}
                                                        suffix={col.suffix}
                                                        onChange={vals => {
                                                            const cols = [...table.columns]
                                                            cols[ci] = { ...col, ...vals }
                                                            updateRankingTable(ti, { ...table, columns: cols })
                                                        }}
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            const cols = [...table.columns]
                                                            cols[ci] = { ...col, highlight: !col.highlight }
                                                            updateRankingTable(ti, { ...table, columns: cols })
                                                        }}
                                                        title="Heatmap"
                                                        className={`flex-shrink-0 w-6 h-6 rounded border text-xs transition ${col.highlight ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-600 dark:text-indigo-400' : 'bg-card border-border text-muted-foreground/70 hover:text-muted-foreground'}`}
                                                    >
                                                        ✦
                                                    </button>
                                                    {table.columns.length > 1 && (
                                                        <button
                                                            onClick={() => {
                                                                const cols = table.columns.filter((_, i) => i !== ci)
                                                                const newSortIdx = table.sortColumnIndex >= cols.length
                                                                    ? cols.length - 1
                                                                    : table.sortColumnIndex
                                                                updateRankingTable(ti, { ...table, columns: cols, sortColumnIndex: newSortIdx })
                                                            }}
                                                            className="flex-shrink-0 text-muted-foreground/50 hover:text-red-400 transition"
                                                        >
                                                            <X className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                            <button
                                                onClick={() => {
                                                    const cols = [...table.columns, { formula: 'meta_spend', label: 'Nueva', prefix: '$', decimals: 2 }]
                                                    updateRankingTable(ti, { ...table, columns: cols })
                                                }}
                                                className="text-[10px] text-cyan-500 hover:text-cyan-400 flex items-center gap-1 mt-1"
                                            >
                                                <Plus className="w-3 h-3" /> Agregar columna
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {(!workingLayout?.ranking_tables || workingLayout.ranking_tables.length === 0) && (
                                    <div className="border border-border border-dashed rounded-xl p-8 text-center bg-background/20">
                                        <p className="text-xs text-muted-foreground/70">No hay tablas de ranking. Haz clic en "Agregar tabla" para crear una.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                {step === 'edit' && workingLayout && (
                    <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-background/80 flex-shrink-0">
                        <button onClick={() => setStep('select')} className="text-xs text-muted-foreground/70 hover:text-foreground/90 flex items-center gap-1.5 transition">
                            <ChevronLeft className="w-4 h-4" /> Cambiar Plantilla
                        </button>
                        <div className="flex gap-3">
                            <Button variant="outline" onClick={onClose} className="border-border text-muted-foreground hover:text-foreground text-xs px-6">
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
