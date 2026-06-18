'use client'

import { useState, useEffect } from 'react'
import { X, Plus, Search } from 'lucide-react'
import type { BiWidget, WidgetType, WidgetConfig, CalculatedField, ConditionalRule } from './BiTypes'
import type { BiMetric, BiDimension } from '@/lib/report-utm/bi-metadata'
import { METRIC_META, DIMENSION_META } from '@/lib/report-utm/bi-metadata'
import { HelpTip } from './HelpTip'

interface Props {
    widget?: BiWidget | null
    calculatedFields?: CalculatedField[]
    onSave: (widget: BiWidget) => void
    onClose: () => void
}

const WIDGET_TYPES: { value: WidgetType; label: string; desc: string }[] = [
    { value: 'scorecard', label: 'Scorecard', desc: 'KPI único' },
    { value: 'line',      label: 'Línea',     desc: 'Tendencia' },
    { value: 'area',      label: 'Área',      desc: 'Tendencia rellena' },
    { value: 'bar',       label: 'Barras',    desc: 'Comparación' },
    { value: 'combo',     label: 'Combo',     desc: 'Apilado/mixto' },
    { value: 'pie',       label: 'Donut',     desc: 'Distribución' },
    { value: 'scatter',   label: 'Dispersión', desc: 'Correlación' },
    { value: 'table',     label: 'Tabla',     desc: 'Detalle + sort' },
    { value: 'funnel',    label: 'Embudo',    desc: 'Conversión' },
    { value: 'slicer',    label: 'Slicer',    desc: 'Filtro interactivo' },
]

const ALL_METRICS = Object.entries(METRIC_META).map(([k, v]) => ({ value: k as BiMetric, label: v.label }))
const ALL_DIMS    = Object.entries(DIMENSION_META).map(([k, v]) => ({ value: k as BiDimension, label: v.label }))

const COLOR_OPTIONS = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#f97316', '#ec4899']

function genId(): string {
    return Math.random().toString(36).slice(2, 10)
}

export function BiWidgetEditor({ widget, calculatedFields = [], onSave, onClose }: Props) {
    const [type,   setType]   = useState<WidgetType>(widget?.type ?? 'scorecard')
    const [title,  setTitle]  = useState(widget?.title ?? '')
    const [metric, setMetric] = useState(widget?.config?.metric ?? 'leads_count')
    const [dim,    setDim]    = useState<BiDimension>(widget?.config?.dimension ?? 'utm_source')
    const [dim2,   setDim2]   = useState<BiDimension>(widget?.config?.dimension2 ?? 'none')
    const [grouping, setGrouping] = useState<'day' | 'week' | 'month'>(widget?.config?.date_grouping ?? 'day')
    const [colSpan, setColSpan] = useState(widget?.w ?? 2)
    const [rowSpan, setRowSpan] = useState(widget?.h ?? 1)
    const [limit, setLimit]   = useState(widget?.config?.limit ?? 15)
    const [sort, setSort]     = useState<'asc' | 'desc'>(widget?.config?.sort ?? 'desc')
    const [compare, setCompare] = useState(!!widget?.config?.compare_period)
    const [color, setColor]   = useState(widget?.config?.color ?? COLOR_OPTIONS[0])
    const [showTotals, setShowTotals] = useState(widget?.config?.show_totals !== false)
    const [conditional, setConditional] = useState<ConditionalRule[]>(widget?.config?.conditional ?? [])
    const [slicerMode, setSlicerMode] = useState<'dropdown' | 'list' | 'daterange'>(widget?.config?.slicer_mode ?? 'dropdown')
    const [metricSearch, setMetricSearch] = useState('')

    // Métricas disponibles = base + campos calculados (estos solo en tablas)
    const calcAsMetrics = calculatedFields.map(c => ({ value: c.name, label: `∑ ${c.name}` }))
    const metricOptions = (type === 'table' ? [...ALL_METRICS, ...calcAsMetrics] : ALL_METRICS)
        .filter(m => !metricSearch || m.label.toLowerCase().includes(metricSearch.toLowerCase()))

    const isChart = ['line', 'area', 'bar', 'combo', 'pie', 'scatter'].includes(type)
    const supportsDim2 = ['bar', 'combo', 'area', 'line'].includes(type)

    // Columnas de tabla (multi-columna): el config.metric guarda la lista separada por coma.
    const tableCols = String(metric).split(',').map(s => s.trim()).filter(Boolean)
    function toggleTableCol(col: string) {
        const next = tableCols.includes(col)
            ? tableCols.filter(c => c !== col)
            : [...tableCols, col]
        setMetric(next.join(','))
    }

    useEffect(() => {
        if (!title) {
            const m = METRIC_META[metric as BiMetric]?.label ?? metric
            const d = DIMENSION_META[dim]?.label ?? dim
            setTitle(type === 'funnel' ? 'Funnel de Conversión' : type === 'scorecard' ? m : `${m} por ${d}`)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, metric, dim])

    function handleSave() {
        if (!title.trim()) return
        const config: WidgetConfig = {}
        if (type === 'slicer') {
            config.dimension = dim === 'date' ? 'utm_source' : dim
            config.slicer_mode = slicerMode
        } else if (type !== 'funnel') {
            // Tablas: lista de columnas. Otros widgets: una sola métrica.
            config.metric = type === 'table' ? tableCols.join(',') : tableCols[0] ?? 'leads_count'
            if (type !== 'scorecard') {
                config.dimension = dim
                if (dim === 'date') config.date_grouping = grouping
                if (supportsDim2 && dim2 !== 'none') config.dimension2 = dim2
                config.limit = limit
                config.sort = sort
                if (isChart) config.color = color
            }
            if (type === 'scorecard') config.compare_period = compare
            if (type === 'table') {
                config.show_totals = showTotals
                if (conditional.length) config.conditional = conditional
            }
        }
        onSave({
            id:    widget?.id ?? genId(),
            type,
            title: title.trim(),
            w:     colSpan,
            h:     rowSpan,
            config,
        })
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <p className="text-sm font-semibold text-foreground">
                        {widget ? 'Editar widget' : 'Agregar widget'}
                    </p>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                    {/* Widget type */}
                    <div>
                        <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-2">
                            Tipo de widget
                            <HelpTip text="Scorecard = un número (KPI). Línea/Área = tendencia en el tiempo. Barras = comparar valores. Combo = barras apiladas. Donut = proporción. Dispersión = correlación. Tabla = detalle con columnas. Embudo = conversión etapa por etapa." />
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {WIDGET_TYPES.map(t => (
                                <button
                                    key={t.value}
                                    onClick={() => setType(t.value)}
                                    className={`p-2.5 rounded-xl border text-left transition-all text-xs ${
                                        type === t.value
                                            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-medium'
                                            : 'border-border bg-muted/30 text-muted-foreground hover:border-border hover:bg-accent'
                                    }`}
                                >
                                    <div className="font-semibold">{t.label}</div>
                                    <div className="text-[10px] opacity-70 mt-0.5 leading-tight">{t.desc}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Título</label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="Nombre del widget"
                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                    </div>

                    {/* Slicer config */}
                    {type === 'slicer' && (
                        <>
                            <div>
                                <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                    Modo del slicer
                                    <HelpTip text="Dropdown = elige un valor. Lista = marca varios valores (multi-selección). Rango de fechas = controla las fechas del informe." />
                                </label>
                                <select
                                    value={slicerMode}
                                    onChange={e => setSlicerMode(e.target.value as 'dropdown' | 'list' | 'daterange')}
                                    className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                >
                                    <option value="dropdown">Dropdown (un valor)</option>
                                    <option value="list">Lista (varios valores)</option>
                                    <option value="daterange">Rango de fechas</option>
                                </select>
                            </div>
                            {slicerMode !== 'daterange' && (
                                <div>
                                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                        Dimensión a filtrar
                                        <HelpTip text="El campo por el que filtra este slicer (ej. Source, Campaña, País). Afecta a todos los widgets del informe." />
                                    </label>
                                    <select
                                        value={dim}
                                        onChange={e => setDim(e.target.value as BiDimension)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {ALL_DIMS.filter(d => d.value !== 'none' && d.value !== 'date').map(d => (
                                            <option key={d.value} value={d.value}>{d.label}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </>
                    )}

                    {/* Metric + Dimension (not for funnel/slicer) */}
                    {type !== 'funnel' && type !== 'slicer' && (
                        <>
                            <div>
                                <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                    Métrica
                                    <HelpTip text="El valor que se mide. Ej: Leads (cantidad), Revenue (ingresos), CPL (costo por lead), ROAS (retorno sobre inversión). Los campos con ∑ son tus campos calculados." />
                                </label>
                                {/* Buscador de campos */}
                                <div className="relative mb-1.5">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                    <input
                                        type="text"
                                        value={metricSearch}
                                        onChange={e => setMetricSearch(e.target.value)}
                                        placeholder="Buscar campo…"
                                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    />
                                </div>
                                {type === 'table' ? (
                                    <>
                                        {/* Selector multi-columna */}
                                        <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-muted/30 divide-y divide-border">
                                            {metricOptions.map(m => {
                                                const checked = tableCols.includes(m.value)
                                                const order = tableCols.indexOf(m.value)
                                                return (
                                                    <label key={m.value} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent transition-colors">
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            onChange={() => toggleTableCol(m.value)}
                                                            className="h-3.5 w-3.5 rounded accent-emerald-500"
                                                        />
                                                        <span className="text-xs text-foreground flex-1">{m.label}</span>
                                                        {checked && (
                                                            <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                                                                col {order + 1}
                                                            </span>
                                                        )}
                                                    </label>
                                                )
                                            })}
                                        </div>
                                        <p className="text-[10px] text-muted-foreground mt-1">
                                            {tableCols.length === 0
                                                ? 'Selecciona al menos una columna.'
                                                : `${tableCols.length} columna${tableCols.length > 1 ? 's' : ''} · se muestran en el orden marcado`}
                                        </p>
                                    </>
                                ) : (
                                    <select
                                        value={metric}
                                        onChange={e => setMetric(e.target.value)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {metricOptions.map(m => (
                                            <option key={m.value} value={m.value}>{m.label}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            {type !== 'scorecard' && (
                                <div>
                                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                        Dimensión
                                        <HelpTip text="Cómo se agrupan los datos. Ej: por Source muestra una fila/barra por cada utm_source; por Fecha muestra la evolución en el tiempo; por Campaña compara campañas." />
                                    </label>
                                    <select
                                        value={dim}
                                        onChange={e => setDim(e.target.value as BiDimension)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {ALL_DIMS.filter(d => d.value !== 'none').map(d => (
                                            <option key={d.value} value={d.value}>{d.label}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {supportsDim2 && (
                                <div>
                                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                        Dimensión secundaria <span className="text-muted-foreground/50">(apilado)</span>
                                        <HelpTip text="Divide cada barra/línea en sub-series. Ej: dimensión Campaña + secundaria Source = cada campaña apilada por su origen de tráfico. Déjala en 'Ninguna' para un gráfico simple." />
                                    </label>
                                    <select
                                        value={dim2}
                                        onChange={e => setDim2(e.target.value as BiDimension)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        <option value="none">Ninguna</option>
                                        {ALL_DIMS.filter(d => d.value !== 'none' && d.value !== 'campaign' && d.value !== dim).map(d => (
                                            <option key={d.value} value={d.value}>{d.label}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {dim === 'date' && type !== 'scorecard' && (
                                <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">Agrupación de fecha</label>
                                    <select
                                        value={grouping}
                                        onChange={e => setGrouping(e.target.value as 'day' | 'week' | 'month')}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        <option value="day">Por día</option>
                                        <option value="week">Por semana</option>
                                        <option value="month">Por mes</option>
                                    </select>
                                </div>
                            )}

                            {/* Top-N + orden (charts no-scorecard) */}
                            {isChart && (
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                            Top-N
                                            <HelpTip text="Cuántos resultados mostrar como máximo. Ej: Top-N = 10 muestra solo los 10 mayores (o menores, según el orden)." />
                                        </label>
                                        <input
                                            type="number" min={1} max={50} value={limit}
                                            onChange={e => setLimit(Math.max(1, Math.min(50, parseInt(e.target.value) || 15)))}
                                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-muted-foreground mb-1">Orden</label>
                                        <select
                                            value={sort}
                                            onChange={e => setSort(e.target.value as 'asc' | 'desc')}
                                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                        >
                                            <option value="desc">Mayor a menor</option>
                                            <option value="asc">Menor a mayor</option>
                                        </select>
                                    </div>
                                </div>
                            )}

                            {/* Color (charts) */}
                            {isChart && type !== 'pie' && dim2 === 'none' && (
                                <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-2">Color</label>
                                    <div className="flex gap-2 flex-wrap">
                                        {COLOR_OPTIONS.map(c => (
                                            <button
                                                key={c}
                                                onClick={() => setColor(c)}
                                                style={{ background: c }}
                                                className={`h-6 w-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-offset-card ring-foreground scale-110' : ''}`}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Comparación (scorecard) */}
                            {type === 'scorecard' && (
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}
                                        className="h-4 w-4 rounded accent-emerald-500" />
                                    <span className="text-xs font-medium text-foreground">Comparar vs período anterior</span>
                                    <HelpTip text="Muestra el % de cambio respecto al período inmediatamente anterior del mismo largo. Ej: si filtras últimos 7 días, compara con los 7 días previos. Flecha verde = subió, roja = bajó." />
                                </label>
                            )}

                            {/* Totales (tabla) */}
                            {type === 'table' && (
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={showTotals} onChange={e => setShowTotals(e.target.checked)}
                                        className="h-4 w-4 rounded accent-emerald-500" />
                                    <span className="text-xs font-medium text-foreground">Mostrar fila de totales</span>
                                    <HelpTip text="Agrega una fila al pie que suma las columnas (leads, ventas, revenue, gasto). Los ratios como CPL y ROAS se recalculan sobre esos totales, no se promedian." />
                                </label>
                            )}

                            {/* Formato condicional (tabla) */}
                            {type === 'table' && (
                                <div className="rounded-xl border border-border p-3 space-y-2">
                                    <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                                        Formato condicional
                                        <HelpTip text="Pinta una celda de color cuando cumple una condición. Ej: métrica 'roas' > 2 en verde resalta las campañas rentables; 'cpl' > 50 en rojo marca leads caros. Usa el nombre interno de la métrica (roas, cpl, revenue…)." />
                                    </p>
                                    {conditional.map((rule, i) => (
                                        <div key={i} className="flex items-center gap-1.5">
                                            <input
                                                type="text" value={rule.metric}
                                                onChange={e => setConditional(c => c.map((r, idx) => idx === i ? { ...r, metric: e.target.value } : r))}
                                                placeholder="métrica"
                                                className="w-24 px-2 py-1 text-[11px] font-mono rounded bg-muted border border-border text-foreground"
                                            />
                                            <select
                                                value={rule.op}
                                                onChange={e => setConditional(c => c.map((r, idx) => idx === i ? { ...r, op: e.target.value as 'gt' | 'lt' } : r))}
                                                className="px-1 py-1 text-[11px] rounded bg-muted border border-border text-foreground"
                                            >
                                                <option value="gt">&gt;</option>
                                                <option value="lt">&lt;</option>
                                            </select>
                                            <input
                                                type="number" value={rule.value}
                                                onChange={e => setConditional(c => c.map((r, idx) => idx === i ? { ...r, value: parseFloat(e.target.value) || 0 } : r))}
                                                className="w-16 px-2 py-1 text-[11px] font-mono rounded bg-muted border border-border text-foreground"
                                            />
                                            <select
                                                value={rule.color}
                                                onChange={e => setConditional(c => c.map((r, idx) => idx === i ? { ...r, color: e.target.value as ConditionalRule['color'] } : r))}
                                                className="px-1 py-1 text-[11px] rounded bg-muted border border-border text-foreground"
                                            >
                                                <option value="green">Verde</option>
                                                <option value="red">Rojo</option>
                                                <option value="amber">Ámbar</option>
                                            </select>
                                            <button onClick={() => setConditional(c => c.filter((_, idx) => idx !== i))} className="p-1 text-muted-foreground hover:text-red-500">
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        onClick={() => setConditional(c => [...c, { metric: 'roas', op: 'gt', value: 2, color: 'green' }])}
                                        className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                    >
                                        <Plus className="h-3 w-3" /> Agregar regla
                                    </button>
                                </div>
                            )}
                        </>
                    )}

                    {/* Tamaño */}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-2">
                                Ancho
                                <HelpTip text="Cuántas columnas ocupa el widget en la grilla (de 4). ¼ = angosto (ideal para scorecards), Full = ancho completo (ideal para tablas y tendencias)." />
                            </label>
                            <div className="flex gap-1">
                                {[1, 2, 3, 4].map(n => (
                                    <button
                                        key={n}
                                        onClick={() => setColSpan(n)}
                                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                            colSpan === n
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {['¼', '½', '¾', 'Full'][n - 1]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-2">Alto</label>
                            <div className="flex gap-1">
                                {[1, 2, 3].map(n => (
                                    <button
                                        key={n}
                                        onClick={() => setRowSpan(n)}
                                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                            rowSpan === n
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {['1x', '2x', '3x'][n - 1]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!title.trim() || (type === 'table' && tableCols.length === 0)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-50"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        {widget ? 'Guardar cambios' : 'Agregar widget'}
                    </button>
                </div>
            </div>
        </div>
    )
}
