'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createLayout, updateLayout, deleteLayout } from '../settings/_actions'
import { Plus, Trash2, Save, GripVertical, LayoutDashboard, Loader2, PenSquare, X, ChevronDown, ChevronUp, Search, Database } from 'lucide-react'
import { SEMANTIC_ALIASES } from '@/lib/formula-engine'

// ─── Catálogo completo de métricas por categoría ──────────────────────────────
const METRIC_CATALOG = [
    {
        category: 'Meta · Entrega',
        color: 'blue',
        metrics: [
            { id: 'meta_spend',       label: 'Gasto',         desc: 'Importe total gastado' },
            { id: 'meta_impressions', label: 'Impresiones',   desc: 'Veces que se mostró el anuncio' },
            { id: 'meta_reach',       label: 'Alcance',       desc: 'Personas únicas alcanzadas' },
            { id: 'meta_frequency',   label: 'Frecuencia',    desc: 'Promedio de impresiones por persona' },
            { id: 'meta_clicks',      label: 'Clics (todos)', desc: 'Total de clics en el anuncio' },
            { id: 'meta_link_clicks', label: 'Clics en enlace', desc: 'Clics que llevan al destino' },
        ],
    },
    {
        category: 'Meta · Costos y Tasas',
        color: 'blue',
        metrics: [
            { id: 'meta_cpm',      label: 'CPM',       desc: 'Costo por 1.000 impresiones' },
            { id: 'meta_cpc',      label: 'CPC',       desc: 'Costo por clic (todos)' },
            { id: 'meta_cpc_link', label: 'CPC enlace',desc: 'Costo por clic en enlace' },
            { id: 'meta_ctr',      label: 'CTR %',     desc: 'Tasa de clics (todos)' },
            { id: 'meta_ctr_link', label: 'CTR enlace %', desc: 'Tasa de clics en enlace' },
        ],
    },
    {
        category: 'Meta · Leads y Registro',
        color: 'indigo',
        metrics: [
            { id: 'meta_leads',                       label: 'Leads',                  desc: 'Evento lead estándar de píxel' },
            { id: 'meta_cpl',                         label: 'CPL',                    desc: 'Costo por lead (calculado)' },
            { id: 'meta_complete_registration',       label: 'Registros completados',  desc: 'Evento CompleteRegistration' },
            { id: 'meta_cost_per_complete_registration', label: 'Costo / Registro',    desc: 'Calculado' },
            { id: 'meta_submit_application',          label: 'Solicitudes enviadas',   desc: 'Evento SubmitApplication' },
            { id: 'meta_start_trial',                 label: 'Trials iniciados',       desc: 'Evento StartTrial' },
            { id: 'meta_subscribe',                   label: 'Suscripciones',          desc: 'Evento Subscribe' },
        ],
    },
    {
        category: 'Meta · Compras y Carrito',
        color: 'emerald',
        metrics: [
            { id: 'meta_purchases',                   label: 'Compras',                desc: 'Evento Purchase estándar' },
            { id: 'meta_cpp',                         label: 'CPP',                    desc: 'Costo por compra (calculado)' },
            { id: 'meta_roas',                        label: 'ROAS',                   desc: 'Retorno sobre gasto publicitario' },
            { id: 'meta_adds_to_cart',                label: 'Añadir al carrito',      desc: 'Evento AddToCart' },
            { id: 'meta_cost_per_add_to_cart',        label: 'Costo / AddToCart',      desc: 'Calculado' },
            { id: 'meta_initiates_checkout',          label: 'Inicio de pago',         desc: 'Evento InitiateCheckout' },
            { id: 'meta_cost_per_initiate_checkout',  label: 'Costo / Checkout',       desc: 'Calculado' },
        ],
    },
    {
        category: 'Meta · Contenido y Navegación',
        color: 'amber',
        metrics: [
            { id: 'meta_landing_page_views',          label: 'Vistas de landing',      desc: 'Evento ViewLandingPage' },
            { id: 'meta_cost_per_landing_page_view',  label: 'Costo / Vista LP',       desc: 'Calculado' },
            { id: 'meta_view_content',                label: 'Ver contenido',          desc: 'Evento ViewContent' },
            { id: 'meta_cost_per_view_content',       label: 'Costo / ViewContent',    desc: 'Calculado' },
            { id: 'meta_search',                      label: 'Búsquedas',              desc: 'Evento Search' },
            { id: 'meta_add_to_wishlist',             label: 'Lista de deseos',        desc: 'Evento AddToWishlist' },
            { id: 'meta_customize_product',           label: 'Personalizar producto',  desc: 'Evento CustomizeProduct' },
        ],
    },
    {
        category: 'Meta · Acciones locales y contacto',
        color: 'amber',
        metrics: [
            { id: 'meta_contact',                     label: 'Contactos',              desc: 'Evento Contact' },
            { id: 'meta_cost_per_contact',            label: 'Costo / Contacto',       desc: 'Calculado' },
            { id: 'meta_schedule',                    label: 'Citas agendadas',        desc: 'Evento Schedule' },
            { id: 'meta_cost_per_schedule',           label: 'Costo / Cita',           desc: 'Calculado' },
            { id: 'meta_find_location',               label: 'Encontrar ubicación',    desc: 'Evento FindLocation' },
            { id: 'meta_donate',                      label: 'Donaciones',             desc: 'Evento Donate' },
        ],
    },
    {
        category: 'Meta · Video',
        color: 'purple',
        metrics: [
            { id: 'meta_video_views',        label: 'Vistas de video',    desc: 'Vistas totales de video' },
            { id: 'meta_video_3s_views',     label: 'Vistas 3 segundos',  desc: 'Reproducciones de ≥3s' },
            { id: 'meta_video_thruplay',     label: 'ThruPlay',           desc: 'Vistas completas (15s+)' },
            { id: 'meta_cost_per_thruplay',  label: 'Costo / ThruPlay',   desc: 'Calculado' },
        ],
    },
    {
        category: 'Meta · Engagement',
        color: 'pink',
        metrics: [
            { id: 'meta_page_engagement',  label: 'Engagement de página',       desc: 'Interacciones con la página' },
            { id: 'meta_post_engagement',  label: 'Engagement de publicación',  desc: 'Interacciones con el post' },
            { id: 'meta_post_reactions',   label: 'Reacciones',                 desc: 'Me gusta, amor, etc.' },
            { id: 'meta_post_shares',      label: 'Compartidos',                desc: 'Veces que compartieron' },
            { id: 'meta_post_saves',       label: 'Guardados',                  desc: 'Veces que guardaron' },
            { id: 'meta_post_comments',    label: 'Comentarios',                desc: 'Comentarios en el post' },
        ],
    },
    {
        category: 'Meta · Mensajería',
        color: 'pink',
        metrics: [
            { id: 'meta_messaging_conversations_started',  label: 'Conversaciones iniciadas', desc: 'Chats en Messenger/WhatsApp/Instagram' },
            { id: 'meta_cost_per_messaging_conversation',  label: 'Costo / Conversación',     desc: 'Calculado' },
        ],
    },
    {
        category: 'Meta · Resultado de objetivo',
        color: 'zinc',
        metrics: [
            { id: 'meta_results',           label: 'Resultados',          desc: 'Resultado principal del objetivo' },
            { id: 'meta_cost_per_result',   label: 'Costo por resultado', desc: 'Calculado' },
        ],
    },
    {
        category: 'Hotmart',
        color: 'red',
        metrics: [
            { id: 'hotmart_pagos_iniciados',  label: 'Checkouts iniciados', desc: 'Pagos iniciados en Hotmart' },
            { id: 'hotmart_clics_link',       label: 'Clics en enlace',     desc: 'Clics a página de ventas' },
        ],
    },
    {
        category: 'Ventas · Totales',
        color: 'emerald',
        metrics: [
            { id: 'ventas_principal',        label: 'Neto Principal',         desc: 'Ingresos netos del producto principal' },
            { id: 'ventas_bump',             label: 'Neto Bump',              desc: 'Ingresos netos de order bump' },
            { id: 'ventas_upsell',           label: 'Neto Upsell',            desc: 'Ingresos netos de upsell' },
            { id: 'ventas_principal_bruto',  label: 'Bruto Principal',        desc: 'Precio de venta × compras del principal' },
            { id: 'ventas_bump_bruto',       label: 'Bruto Bump',             desc: 'Precio de venta × compras del bump' },
            { id: 'ventas_upsell_bruto',     label: 'Bruto Upsell',           desc: 'Precio de venta × compras del upsell' },
            { id: 'ventas_principal_count',  label: '# Compras Principal',    desc: 'Cantidad de ventas del principal' },
            { id: 'ventas_bump_count',       label: '# Compras Bump',         desc: 'Cantidad de ventas del bump' },
            { id: 'ventas_upsell_count',     label: '# Compras Upsell',       desc: 'Cantidad de ventas del upsell' },
            { id: 'total_facturacion_bruta', label: 'Facturación Bruta Total',desc: 'Bruto principal + bump + upsell' },
            { id: 'total_facturacion_neta',  label: 'Facturación Neta Total', desc: 'Neto principal + bump + upsell' },
            { id: 'total_roas',              label: 'ROAS Total',             desc: 'Neto total / gasto Meta' },
            { id: 'total_roi',               label: 'ROI Total',              desc: '(Neto total - gasto) / gasto' },
            { id: 'total_dinero_bolsa',      label: 'Dinero en Bolsa Total',  desc: 'Neto total - gasto Meta' },
            { id: 'total_costo_compra',      label: 'Costo/Compra Total',     desc: 'Gasto / compras del principal' },
        ],
    },
    {
        category: 'Funnel Hotmart · Por pestaña',
        color: 'orange',
        metrics: [
            { id: 'funnel_principal_count',   label: '# Compras Principal',    desc: 'Ventas del producto principal de este funnel' },
            { id: 'funnel_principal_neto',    label: 'Neto Principal',          desc: 'Ingresos netos del principal (comisión productora)' },
            { id: 'funnel_principal_bruto',   label: 'Bruto Principal (API)',   desc: 'Gross del producto principal según Hotmart (varía con coupons/moneda)' },
            { id: 'funnel_principal_price',   label: 'Precio Público Principal',desc: 'Precio configurado en el tab (para calcular bruta fija = precio × ventas)' },
            { id: 'funnel_bump_count',        label: '# Order Bumps',           desc: 'Ventas del order bump de este funnel' },
            { id: 'funnel_bump_neto',         label: 'Neto Order Bump',         desc: 'Ingresos netos del bump' },
            { id: 'funnel_bump_bruto',        label: 'Bruto Order Bump',        desc: 'Precio de venta × compras del bump' },
            { id: 'funnel_upsell_count',      label: '# Upsells',              desc: 'Ventas del upsell de este funnel' },
            { id: 'funnel_upsell_neto',       label: 'Neto Upsell',            desc: 'Ingresos netos del upsell' },
            { id: 'funnel_upsell_bruto',      label: 'Bruto Upsell',           desc: 'Precio de venta × compras del upsell' },
            { id: 'funnel_upsell_visits',     label: 'Visitas Pág. Upsell',    desc: 'Pageviews de la página de upsell (GA4)' },
            { id: 'funnel_pagos_iniciados',   label: 'Pagos Iniciados',        desc: 'Visitas a la página de pago (GA4)' },
            { id: 'funnel_facturacion_bruta', label: 'Facturación Bruta',      desc: 'Precio público × nº ventas principal (requiere precio configurado en el tab)' },
            { id: 'funnel_facturacion_neta',  label: 'Facturación Neta',       desc: 'Comisiones reales: neto principal + neto bump + neto upsell' },
            { id: 'funnel_roas',              label: 'ROAS',                   desc: 'Neto total / gasto Meta' },
            { id: 'funnel_roi',               label: 'ROI',                    desc: '(Neto total - gasto) / gasto' },
            { id: 'funnel_dinero_bolsa',      label: 'Dinero en Bolsa',        desc: 'Neto total - gasto Meta' },
            { id: 'funnel_costo_compra',      label: 'Costo/Compra',           desc: 'Gasto / compras del principal' },
            { id: 'funnel_costo_visita',      label: 'Costo/Visita',           desc: 'Gasto / sesiones del funnel' },
            { id: 'funnel_costo_pago',        label: 'Costo/Pago Iniciado',    desc: 'Gasto / pagos iniciados' },
            { id: 'funnel_pct_conversion',    label: '% Conv. General',        desc: 'Compras / clics Meta × 100' },
            { id: 'funnel_pct_clics_visitas', label: '% Clics→Visitas',        desc: 'Sesiones / clics × 100' },
            { id: 'funnel_pct_visitas_pagos', label: '% Visitas→Pagos',        desc: 'Pagos iniciados / sesiones × 100' },
            { id: 'funnel_pct_pagos_compras', label: '% Pagos→Compras',        desc: 'Compras / pagos iniciados × 100' },
            { id: 'funnel_pct_conv_order',    label: '% Conv. Order Bump',     desc: 'Bumps / compras principal × 100' },
            { id: 'funnel_pct_conv_upsell',   label: '% Conv. Upsell',         desc: 'Upsells / visitas upsell × 100' },
        ],
    },
    {
        category: 'Google Analytics 4',
        color: 'sky',
        metrics: [
            { id: 'ga_sessions',              label: 'Sesiones',             desc: 'Sesiones totales' },
            { id: 'ga_bounce_rate',           label: 'Tasa de Rebote',       desc: 'Rebote promedio' },
            { id: 'ga_avg_session_duration',  label: 'Duración Med. Sesión', desc: 'Duración en segundos' },
        ],
    },
    {
        category: 'Manual',
        color: 'zinc',
        metrics: [
            { id: 'leads_registrados', label: 'Leads registrados', desc: 'Entrada manual de leads' },
        ],
    },
    {
        category: 'Google Sheets · Leads',
        color: 'green',
        metrics: [
            { id: 'leads_totales',        label: 'Leads Totales',          desc: 'Total de leads de todas las hojas' },
            { id: 'leads_calificados',    label: 'Leads Calificados',      desc: 'Leads que cumplen los criterios de calidad' },
            { id: 'leads_no_calificados', label: 'Leads No Calificados',   desc: 'Leads que no cumplen los criterios de calidad' },
            { id: 'tasa_calificacion',    label: 'Tasa de Calificación %', desc: 'Porcentaje de leads calificados sobre el total' },
        ],
    },
]

// Colores de categoría
const CATEGORY_COLORS: Record<string, string> = {
    blue:    'bg-blue-500/10 text-blue-300 border-blue-500/20 hover:bg-blue-500/20',
    indigo:  'bg-indigo-500/10 text-indigo-300 border-indigo-500/20 hover:bg-indigo-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20',
    amber:   'bg-amber-500/10 text-amber-300 border-amber-500/20 hover:bg-amber-500/20',
    purple:  'bg-purple-500/10 text-purple-300 border-purple-500/20 hover:bg-purple-500/20',
    pink:    'bg-pink-500/10 text-pink-300 border-pink-500/20 hover:bg-pink-500/20',
    orange:  'bg-orange-500/10 text-orange-300 border-orange-500/20 hover:bg-orange-500/20',
    red:     'bg-red-500/10 text-red-300 border-red-500/20 hover:bg-red-500/20',
    zinc:    'bg-zinc-700/40 text-zinc-300 border-zinc-600/30 hover:bg-zinc-700/60',
    green:   'bg-green-500/10 text-green-300 border-green-500/20 hover:bg-green-500/20',
}

// ─── Quick formula templates ──────────────────────────────────────────────────
const FORMULA_PRESETS = [
    { label: 'CPM',          formula: 'meta_cpm',                                                                   prefix: '$', suffix: '' },
    { label: 'CPC',          formula: 'meta_cpc',                                                                   prefix: '$', suffix: '' },
    { label: 'CTR %',        formula: 'meta_ctr',                                                                   prefix: '',  suffix: '%' },
    { label: 'CPL',          formula: 'meta_cpl',                                                                   prefix: '$', suffix: '' },
    { label: 'CPP',          formula: 'meta_cpp',                                                                   prefix: '$', suffix: '' },
    { label: 'ROAS',         formula: 'meta_roas',                                                                  prefix: '',  suffix: 'x' },
    { label: 'ROI %',        formula: '((ventas_principal + ventas_bump + ventas_upsell - meta_spend) / meta_spend) * 100', prefix: '', suffix: '%' },
    { label: 'Total Ventas', formula: 'ventas_principal + ventas_bump + ventas_upsell',                             prefix: '$', suffix: '' },
]

// ─── Buscador / Catálogo de métricas ─────────────────────────────────────────
function MetricCatalog({ onInsert }: { onInsert: (id: string) => void }) {
    const [query, setQuery] = useState('')
    const [expanded, setExpanded] = useState(false)

    const filtered = query.trim()
        ? METRIC_CATALOG.map(cat => ({
            ...cat,
            metrics: cat.metrics.filter(m =>
                m.label.toLowerCase().includes(query.toLowerCase()) ||
                m.id.toLowerCase().includes(query.toLowerCase()) ||
                m.desc.toLowerCase().includes(query.toLowerCase())
            )
          })).filter(cat => cat.metrics.length > 0)
        : METRIC_CATALOG

    return (
        <div className="border border-zinc-700 rounded-lg bg-zinc-950/80 overflow-hidden">
            <button
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800/50 transition"
            >
                <span className="flex items-center gap-2">
                    <Search className="w-3.5 h-3.5 text-zinc-500" />
                    Catálogo de métricas — haz click en una para insertarla en la fórmula
                </span>
                {expanded ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />}
            </button>

            {expanded && (
                <div className="border-t border-zinc-800">
                    <div className="p-2">
                        <Input
                            placeholder="Buscar métrica..."
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            className="bg-zinc-900 border-zinc-700 text-zinc-100 h-7 text-xs"
                            autoFocus
                        />
                    </div>
                    <div className="max-h-72 overflow-y-auto px-2 pb-2 space-y-3">
                        {filtered.map(cat => (
                            <div key={cat.category}>
                                <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1 px-1">{cat.category}</p>
                                <div className="flex flex-wrap gap-1">
                                    {cat.metrics.map(m => (
                                        <button
                                            key={m.id}
                                            title={`${m.desc}\n${m.id}`}
                                            onClick={() => onInsert(m.id)}
                                            className={`text-[10px] px-2 py-0.5 rounded border transition cursor-pointer ${CATEGORY_COLORS[cat.color]}`}
                                        >
                                            {m.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                        {filtered.length === 0 && (
                            <p className="text-xs text-zinc-500 text-center py-4">Sin resultados para "{query}"</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Empty defaults ───────────────────────────────────────────────────────────
const emptyColumn = () => ({ id: crypto.randomUUID(), label: '', formula: '', prefix: '', suffix: '', decimals: 2, align: 'right', highlight: false })
const emptyTarjeta = () => ({ id: crypto.randomUUID(), label: '', formula: '', prefix: '', suffix: '', decimals: 2, color: 'default' })
const emptyLayout = () => ({ nombre: '', descripcion: '', columnas: [{ ...emptyColumn(), formula: 'fecha', label: 'Fecha', align: 'left', decimals: 0 }], tarjetas: [], source_mapping: {} as Record<string, string> })

// ─── Column/Tarjeta row editor ────────────────────────────────────────────────
function FieldRow({ item, onChange, onRemove }: { item: any; onChange: (v: any) => void; onRemove: () => void }) {
    return (
        <div className="grid grid-cols-12 gap-2 items-start bg-zinc-950/60 border border-zinc-800 rounded-lg p-3">
            <div className="col-span-1 flex justify-center pt-2.5 text-zinc-600">
                <GripVertical className="w-4 h-4" />
            </div>
            <div className="col-span-3">
                <Input placeholder="Etiqueta" value={item.label} onChange={e => onChange({ ...item, label: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-4">
                <Input placeholder="Fórmula (ej: meta_spend / meta_clicks)" value={item.formula} onChange={e => onChange({ ...item, formula: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs font-mono" />
                <div className="flex flex-wrap gap-1 mt-1">
                    {FORMULA_PRESETS.map(p => (
                        <button key={p.label} onClick={() => onChange({ ...item, label: item.label || p.label, formula: p.formula, prefix: p.prefix, suffix: p.suffix })} className="text-[10px] bg-zinc-800 hover:bg-indigo-500/20 hover:text-indigo-300 text-zinc-400 px-1.5 py-0.5 rounded transition">
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="col-span-1">
                <Input placeholder="$" value={item.prefix || ''} onChange={e => onChange({ ...item, prefix: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1">
                <Input placeholder="%" value={item.suffix || ''} onChange={e => onChange({ ...item, suffix: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1">
                <Input placeholder="2" type="number" min={0} max={6} value={item.decimals ?? 2} onChange={e => onChange({ ...item, decimals: parseInt(e.target.value) || 0 })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1 flex justify-end">
                <button onClick={onRemove} className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition">
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}

// ─── Layout Editor ────────────────────────────────────────────────────────────
function LayoutEditor({ initial, onSave, onCancel }: { initial: any; onSave: (l: any) => Promise<void>; onCancel: () => void }) {
    const [layout, setLayout] = useState(initial)
    const [saving, setSaving] = useState(false)
    // Tracks which field row is "active" for metric insertion: { section: 'col'|'card', idx: number }
    const [activeField, setActiveField] = useState<{ section: 'col' | 'card'; idx: number } | null>(null)

    const updateCol = (idx: number, val: any) => {
        const cols = [...layout.columnas]; cols[idx] = val
        setLayout({ ...layout, columnas: cols })
    }
    const removeCol = (idx: number) => setLayout({ ...layout, columnas: layout.columnas.filter((_: any, i: number) => i !== idx) })
    const addCol = () => {
        const newCol = emptyColumn()
        setLayout({ ...layout, columnas: [...layout.columnas, newCol] })
        setActiveField({ section: 'col', idx: layout.columnas.length })
    }

    const updateCard = (idx: number, val: any) => {
        const cards = [...layout.tarjetas]; cards[idx] = val
        setLayout({ ...layout, tarjetas: cards })
    }
    const removeCard = (idx: number) => setLayout({ ...layout, tarjetas: layout.tarjetas.filter((_: any, i: number) => i !== idx) })
    const addCard = () => {
        const newCard = emptyTarjeta()
        setLayout({ ...layout, tarjetas: [...layout.tarjetas, newCard] })
        setActiveField({ section: 'card', idx: layout.tarjetas.length })
    }

    // Insert metric ID into the formula of the active field
    function handleInsertMetric(metricId: string) {
        if (!activeField) return
        if (activeField.section === 'col') {
            const col = layout.columnas[activeField.idx]
            if (!col) return
            const current = col.formula || ''
            updateCol(activeField.idx, { ...col, formula: current ? current + ' ' + metricId : metricId })
        } else {
            const card = layout.tarjetas[activeField.idx]
            if (!card) return
            const current = card.formula || ''
            updateCard(activeField.idx, { ...card, formula: current ? current + ' ' + metricId : metricId })
        }
    }

    const colHeaders = (
        <div className="grid grid-cols-12 gap-2 text-[10px] text-zinc-500 font-medium px-1 mb-1">
            <div className="col-span-1" />
            <div className="col-span-3">Etiqueta</div>
            <div className="col-span-4">Fórmula</div>
            <div className="col-span-1">Prefijo</div>
            <div className="col-span-1">Sufijo</div>
            <div className="col-span-1">Dec.</div>
            <div className="col-span-1" />
        </div>
    )

    return (
        <div className="space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle className="text-white text-base">Información de la Plantilla</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label className="text-zinc-300">Nombre de la Plantilla</Label>
                        <Input value={layout.nombre} onChange={e => setLayout({ ...layout, nombre: e.target.value })} placeholder="ej: Plantilla Camaradictos" className="bg-zinc-950 border-zinc-700 text-zinc-100" />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-zinc-300">Descripción (opcional)</Label>
                        <Input value={layout.descripcion || ''} onChange={e => setLayout({ ...layout, descripcion: e.target.value })} placeholder="Para qué tipo de cliente..." className="bg-zinc-950 border-zinc-700 text-zinc-100" />
                    </div>
                </CardContent>
            </Card>

            {/* Catálogo de métricas */}
            <MetricCatalog onInsert={handleInsertMetric} />
            {activeField && (
                <p className="text-[11px] text-indigo-400 text-center -mt-3">
                    Insertando en: <span className="font-mono font-semibold">
                        {activeField.section === 'col'
                            ? layout.columnas[activeField.idx]?.label || `columna ${activeField.idx + 1}`
                            : layout.tarjetas[activeField.idx]?.label || `tarjeta ${activeField.idx + 1}`}
                    </span> — haz click en otra fila para cambiar el destino
                </p>
            )}

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-white text-base">Columnas de la Tabla</CardTitle>
                            <CardDescription className="text-zinc-400">Define cada columna que aparecerá en la tabla diaria. Haz click en una fila para activarla como destino del catálogo.</CardDescription>
                        </div>
                        <Button size="sm" variant="outline" onClick={addCol} className="gap-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                            <Plus className="w-3.5 h-3.5" /> Añadir columna
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2">
                    {colHeaders}
                    {layout.columnas.map((col: any, i: number) => (
                        <div key={col.id} onClick={() => setActiveField({ section: 'col', idx: i })} className={`rounded-lg ring-1 transition ${activeField?.section === 'col' && activeField.idx === i ? 'ring-indigo-500/60' : 'ring-transparent'}`}>
                            <FieldRow item={col} onChange={v => updateCol(i, v)} onRemove={() => removeCol(i)} />
                        </div>
                    ))}
                    {layout.columnas.length === 0 && (
                        <p className="text-xs text-zinc-500 text-center py-4">Sin columnas. Añade al menos la columna "fecha".</p>
                    )}
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-white text-base">Tarjetas de Resumen</CardTitle>
                            <CardDescription className="text-zinc-400">Métricas que aparecerán como tarjetas grandes en la parte superior.</CardDescription>
                        </div>
                        <Button size="sm" variant="outline" onClick={addCard} className="gap-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                            <Plus className="w-3.5 h-3.5" /> Añadir tarjeta
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2">
                    {colHeaders}
                    {layout.tarjetas.map((card: any, i: number) => (
                        <div key={card.id} onClick={() => setActiveField({ section: 'card', idx: i })} className={`rounded-lg ring-1 transition ${activeField?.section === 'card' && activeField.idx === i ? 'ring-indigo-500/60' : 'ring-transparent'}`}>
                            <FieldRow item={card} onChange={v => updateCard(i, v)} onRemove={() => removeCard(i)} />
                        </div>
                    ))}
                    {layout.tarjetas.length === 0 && (
                        <p className="text-xs text-zinc-500 text-center py-4">Sin tarjetas de resumen todavía.</p>
                    )}
                </CardContent>
            </Card>

            {/* Source Mapping */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-cyan-400" />
                        <div>
                            <CardTitle className="text-white text-base">Mapeo de Fuentes de Datos</CardTitle>
                            <CardDescription className="text-zinc-400">
                                Define de dónde se obtiene cada métrica clave. Usa <code className="text-cyan-400 bg-zinc-800 px-1 rounded">$visitas</code>, <code className="text-cyan-400 bg-zinc-800 px-1 rounded">$pagos_iniciados</code>, etc. en tus fórmulas.
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Attribution Strategy Preset */}
                    <div className="pb-3 border-b border-zinc-800">
                        <label className="text-xs font-medium text-zinc-400 mb-2 block">Preset de Estrategia</label>
                        <select
                            value={layout.attribution_strategy || 'custom'}
                            onChange={e => {
                                const strategy = e.target.value
                                let newMapping: Record<string, string> = { ...(layout.source_mapping || {}) }
                                if (strategy === 'full_meta') {
                                    newMapping = {
                                        '$visitas': 'meta_landing_page_views',
                                        '$pagos_iniciados': 'meta_initiates_checkout',
                                        '$conversiones': 'meta_purchases',
                                        '$facturacion_principal': 'ventas_principal',
                                        '$facturacion_bump': 'ventas_bump',
                                        '$facturacion_upsell': 'ventas_upsell',
                                    }
                                } else if (strategy === 'hybrid') {
                                    newMapping = {
                                        '$visitas': 'ga_sessions',
                                        '$pagos_iniciados': 'hotmart_pagos_iniciados',
                                        '$conversiones': 'meta_purchases',
                                        '$facturacion_principal': 'ventas_principal',
                                        '$facturacion_bump': 'ventas_bump',
                                        '$facturacion_upsell': 'ventas_upsell',
                                    }
                                } else if (strategy === 'full_hotmart') {
                                    newMapping = {
                                        '$visitas': 'meta_landing_page_views',
                                        '$pagos_iniciados': 'hotmart_pagos_iniciados',
                                        '$conversiones': 'meta_purchases',
                                        '$facturacion_principal': 'ventas_principal',
                                        '$facturacion_bump': 'ventas_bump',
                                        '$facturacion_upsell': 'ventas_upsell',
                                    }
                                }
                                setLayout({ ...layout, attribution_strategy: strategy, source_mapping: newMapping })
                            }}
                            className="w-full h-8 text-xs bg-zinc-950 border border-zinc-700 text-zinc-100 rounded-md px-2 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition"
                        >
                            <option value="custom">Custom — Configuración manual</option>
                            <option value="hybrid">Híbrido — Visitas: GA4, Pagos: Hotmart, Conversiones: Meta</option>
                            <option value="full_meta">Full Meta — Todo desde Meta Ads</option>
                            <option value="full_hotmart">Full Hotmart — Ventas desde Hotmart</option>
                        </select>
                    </div>

                    {Object.entries(SEMANTIC_ALIASES).map(([alias, config]) => (
                        <div key={alias} className="grid grid-cols-12 gap-3 items-center">
                            <div className="col-span-4">
                                <div className="flex items-center gap-2">
                                    <code className="text-xs text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded border border-cyan-500/20 font-mono">{alias}</code>
                                    <span className="text-xs text-zinc-400">{config.label}</span>
                                </div>
                            </div>
                            <div className="col-span-8">
                                <select
                                    value={(layout.source_mapping || {})[alias] || config.defaultSource}
                                    onChange={e => setLayout({ ...layout, source_mapping: { ...(layout.source_mapping || {}), [alias]: e.target.value } })}
                                    className="w-full h-8 text-xs bg-zinc-950 border border-zinc-700 text-zinc-100 rounded-md px-2 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 transition"
                                >
                                    {config.options.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    ))}
                </CardContent>
                <CardFooter className="border-t border-zinc-800 flex justify-between pt-4">
                    <Button variant="outline" onClick={onCancel} className="border-zinc-700 text-zinc-400">Cancelar</Button>
                    <Button disabled={saving || !layout.nombre} onClick={async () => { setSaving(true); await onSave(layout); setSaving(false) }} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Guardar Plantilla
                    </Button>
                </CardFooter>
            </Card>
        </div>
    )
}

// ─── Main Builder Client ──────────────────────────────────────────────────────
export function LayoutBuilderClient({ layouts: initial, isAdmin = false }: { layouts: any[]; isAdmin?: boolean }) {
    const [layouts, setLayouts] = useState(initial)
    const [editing, setEditing] = useState<any | null>(null)
    const [isNew, setIsNew] = useState(false)

    async function handleSave(layout: any) {
        if (isNew) {
            const res = await createLayout({ nombre: layout.nombre, descripcion: layout.descripcion, columnas: layout.columnas, tarjetas: layout.tarjetas, source_mapping: layout.source_mapping || {}, attribution_strategy: layout.attribution_strategy || 'custom' })
            if (res.success) {
                setLayouts(prev => [...prev, res.data])
                setEditing(null)
                setIsNew(false)
            }
        } else {
            await updateLayout(layout.id, { nombre: layout.nombre, descripcion: layout.descripcion, columnas: layout.columnas, tarjetas: layout.tarjetas, source_mapping: layout.source_mapping || {}, attribution_strategy: layout.attribution_strategy || 'custom' })
            setLayouts(prev => prev.map(l => l.id === layout.id ? layout : l))
            setEditing(null)
        }
    }

    async function handleDelete(id: string) {
        if (!confirm('¿Eliminar esta plantilla? Los clientes que la usen volverán a la vista clásica.')) return
        await deleteLayout(id)
        setLayouts(prev => prev.filter(l => l.id !== id))
    }

    if (editing) {
        return <LayoutEditor initial={editing} onSave={handleSave} onCancel={() => { setEditing(null); setIsNew(false) }} />
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button onClick={() => { setEditing(emptyLayout()); setIsNew(true) }} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20">
                    <Plus className="w-4 h-4" /> Nueva Plantilla
                </Button>
            </div>

            {layouts.length === 0 && (
                <Card className="bg-zinc-900 border-zinc-800 text-center p-12">
                    <LayoutDashboard className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                    <p className="text-zinc-400">No hay plantillas. Crea la primera usando el botón de arriba.</p>
                </Card>
            )}

            <div className="grid gap-4">
                {layouts.map(layout => (
                    <Card key={layout.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                        <CardHeader>
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-indigo-500/10 rounded-lg">
                                        <LayoutDashboard className="w-5 h-5 text-indigo-400" />
                                    </div>
                                    <div>
                                        <CardTitle className="text-white">{layout.nombre}</CardTitle>
                                        {layout.descripcion && <CardDescription className="text-zinc-400 mt-0.5">{layout.descripcion}</CardDescription>}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setEditing(layout)} className="gap-1.5 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800">
                                        <PenSquare className="w-3.5 h-3.5" /> Editar
                                    </Button>
                                    {isAdmin && (
                                        <Button size="sm" variant="outline" onClick={() => handleDelete(layout.id)} className="border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                <div>
                                    <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">Columnas ({(layout.columnas || []).length})</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(layout.columnas || []).map((c: any) => (
                                            <span key={c.id} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">{c.label}</span>
                                        ))}
                                    </div>
                                </div>
                                {(layout.tarjetas || []).length > 0 && (
                                    <div>
                                        <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">Tarjetas ({layout.tarjetas.length})</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {layout.tarjetas.map((t: any) => (
                                                <span key={t.id} className="text-xs bg-indigo-500/10 text-indigo-300 px-2 py-1 rounded border border-indigo-500/20">{t.label}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    )
}
