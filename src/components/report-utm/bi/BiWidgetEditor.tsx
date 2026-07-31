'use client'

import { useState, useEffect } from 'react'
import { X, Plus, Search, AlertTriangle } from 'lucide-react'
import type { BiWidget, WidgetType, WidgetConfig, CalculatedField, ConditionalRule, ValueFilter, ScorecardVariant } from './BiTypes'
import type {
    BiMetric, BiDimension, ValueOp, FieldAgg, FormFieldMeta, OfflineFieldMeta,
    AdvancedFilter, FilterOp, SheetFieldMeta, SheetViewMeta, SheetCampoAgg, LeadFieldMeta,
} from '@/lib/report-utm/bi-metadata'
import {
    METRIC_META, DIMENSION_META, VALUE_OPS, FIELD_AGGS, FILTERABLE_BASE_DIMS, FILTER_OPS,
    makeFieldDim, makeFieldMetric, humanizeFieldKey, fieldDimLabel, fieldMetricLabel,
    makeOfflineFieldMetric, offlineFieldLabel,
    makeLeadFieldDim, leadFieldLabel,
    makeSheetDim, makeSheetMetric, makeSheetView, sheetFieldLabel, isSheetDim, isSheetToken,
    advancedFilterHasConditions, supportsPivot, PIVOT_METRICS,
    FUNNEL_STAGE_METRICS, DEFAULT_FUNNEL_STAGES, evaluateExpression,
    matchFilterConditionNorm, metricCrossesDimension,
    RECOMMENDED_METRICS, METRIC_GROUP_META, metricsOfGroup,
} from '@/lib/report-utm/bi-metadata'
import { normalizarClaveLead } from '@/lib/report-utm/lead-campos'
import { BiFormulaInput } from './BiFormulaInput'
import { HelpTip } from './HelpTip'
import { BiAdvancedFilterBuilder } from './BiAdvancedFilterBuilder'

interface Props {
    widget?: BiWidget | null
    calculatedFields?: CalculatedField[]
    /** Cliente vigente del informe (para descubrir sus campos de formulario). */
    clienteId?: string
    dateFrom?: string
    dateTo?: string
    /** Permite crear una sección (false al agregar dentro de otra sección). */
    allowSection?: boolean
    onSave: (widget: BiWidget) => void
    onClose: () => void
}

const FIELD_AGG_LABEL = Object.fromEntries(FIELD_AGGS.map(a => [a.value, a.label])) as Record<FieldAgg, string>
const AGGS_FOR = (t: 'number' | 'text'): FieldAgg[] =>
    t === 'number' ? ['sum', 'avg', 'min', 'max', 'count'] : ['count']

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

// Bloques de organización (sin datos): agrupar y comentar el informe.
const STRUCTURAL_TYPES: { value: WidgetType; label: string; desc: string }[] = [
    { value: 'section', label: 'Sección',  desc: 'Grupo colapsable' },
    { value: 'heading', label: 'Título',   desc: 'Encabezado divisor' },
    { value: 'text',    label: 'Texto',    desc: 'Comentario / nota' },
    { value: 'summary', label: 'Resumen',  desc: 'Resumen ejecutivo automático' },
]

const SCORECARD_VARIANTS: { value: ScorecardVariant; label: string }[] = [
    { value: 'default',   label: 'Estándar' },
    { value: 'threshold', label: 'Semáforo' },
    { value: 'progress',  label: 'Progreso' },
]

const ALL_METRICS = Object.entries(METRIC_META).map(([k, v]) => ({ value: k as BiMetric, label: v.label }))

/** Una opción del selector de métricas (catálogo fijo o token dinámico). */
interface MetricOpt { value: string; label: string }
/** Bloque con encabezado dentro del selector. */
interface MetricGroupUI { key: string; title: string; items: MetricOpt[] }
// `campaign` queda fuera: es un alias histórico de `utm_campaign` que el
// dispatcher normaliza. Ofrecer dos "Campaña" que hacen lo mismo era la causa de
// que la gente eligiera la que menos métricas soportaba.
const ALL_DIMS    = Object.entries(DIMENSION_META)
    .filter(([, v]) => !v.hidden)
    .map(([k, v]) => ({ value: k as BiDimension, label: v.label }))

const COLOR_OPTIONS = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#f97316', '#ec4899']

function genId(): string {
    return Math.random().toString(36).slice(2, 10)
}

export function BiWidgetEditor({ widget, calculatedFields = [], clienteId, dateFrom, dateTo, allowSection = true, onSave, onClose }: Props) {
    const [type,   setType]   = useState<WidgetType>(widget?.type ?? 'scorecard')
    const [title,  setTitle]  = useState(widget?.title ?? '')
    // Config de bloques estructurales / presentacionales.
    const [text,        setText]        = useState(widget?.config?.text ?? '')
    const [headingLevel, setHeadingLevel] = useState<1 | 2 | 3>(widget?.config?.heading_level ?? 2)
    const [align,       setAlign]       = useState<'left' | 'center'>(widget?.config?.align ?? 'left')
    const [columns,     setColumns]     = useState(widget?.config?.columns ?? 4)
    const [accent,      setAccent]      = useState(widget?.config?.accent ?? '')
    const [metric, setMetric] = useState<string>(String(widget?.config?.metric ?? 'leads_count'))
    const [dim,    setDim]    = useState<string>(widget?.config?.dimension ?? 'utm_source')
    const [dim2,   setDim2]   = useState<string>(widget?.config?.dimension2 ?? 'none')
    const [formFields, setFormFields] = useState<FormFieldMeta[]>([])
    const [leadFields, setLeadFields] = useState<LeadFieldMeta[]>([])
    const [offlineFields, setOfflineFields] = useState<OfflineFieldMeta[]>([])
    const [sheetFields, setSheetFields] = useState<SheetFieldMeta[]>([])
    const [sheetViews, setSheetViews] = useState<SheetViewMeta[]>([])
    const [grouping, setGrouping] = useState<'day' | 'week' | 'month'>(widget?.config?.date_grouping ?? 'day')
    const [colSpan, setColSpan] = useState(widget?.w ?? 2)
    const [rowSpan, setRowSpan] = useState(widget?.h ?? 1)
    const [limit, setLimit]   = useState(widget?.config?.limit ?? 15)
    const [sort, setSort]     = useState<'asc' | 'desc'>(widget?.config?.sort ?? 'desc')
    const [compare, setCompare] = useState(!!widget?.config?.compare_period)
    const [color, setColor]   = useState(widget?.config?.color ?? COLOR_OPTIONS[0])
    const [showTotals, setShowTotals] = useState(widget?.config?.show_totals !== false)
    const [conditional, setConditional] = useState<ConditionalRule[]>(widget?.config?.conditional ?? [])
    const [valueFilters, setValueFilters] = useState<ValueFilter[]>(widget?.config?.value_filters ?? [])
    const [advancedFilter, setAdvancedFilter] = useState<AdvancedFilter>(widget?.config?.advanced_filter ?? { groups: [] })
    const [slicerMode, setSlicerMode] = useState<'dropdown' | 'list' | 'daterange'>(widget?.config?.slicer_mode ?? 'dropdown')
    const [metricSearch, setMetricSearch] = useState('')
    // ¿Se muestra el catálogo entero o solo las recomendadas + los campos del cliente?
    const [showAllMetrics, setShowAllMetrics] = useState(false)
    // Etapas del embudo (config.metrics). Vacío = embudo por defecto.
    const [funnelStages, setFunnelStages] = useState<string[]>(
        Array.isArray(widget?.config?.metrics) && widget.config.metrics.length >= 2
            ? widget.config.metrics
            : [...DEFAULT_FUNNEL_STAGES]
    )
    // Métricas con datos reales para este cliente/rango (mapa métrica → bool).
    const [availability, setAvailability] = useState<Record<string, boolean> | null>(null)
    // Variante del scorecard + sus parámetros.
    const [variant, setVariant] = useState<ScorecardVariant>(widget?.config?.variant ?? 'default')
    const [thGreenOp, setThGreenOp]   = useState<'gte' | 'lte'>(widget?.config?.threshold?.greenOp ?? 'gte')
    const [thGreen, setThGreen]       = useState<string>(String(widget?.config?.threshold?.green ?? ''))
    const [thYellowOp, setThYellowOp] = useState<'gte' | 'lte'>(widget?.config?.threshold?.yellowOp ?? 'gte')
    const [thYellow, setThYellow]     = useState<string>(String(widget?.config?.threshold?.yellow ?? ''))
    const [target, setTarget]         = useState<string>(String(widget?.config?.target ?? ''))
    // Fórmula propia del widget (alternativa a elegir una métrica del catálogo).
    const [useFormula, setUseFormula] = useState(!!widget?.config?.formula)
    const [formula, setFormula] = useState(widget?.config?.formula ?? '')
    const [formulaFormat, setFormulaFormat] = useState<'number' | 'currency' | 'percent' | 'ratio'>(
        widget?.config?.formula_format ?? 'number'
    )
    const [formulaDecimals, setFormulaDecimals] = useState<string>(
        widget?.config?.formula_decimals === undefined ? '' : String(widget.config.formula_decimals)
    )
    // Filtro rápido por nombre de campaña (se traduce a una condición utm_campaign).
    const [campaignOp, setCampaignOp]       = useState<FilterOp>(widget?.config?.campaign_filter?.op ?? 'contains')
    const [campaignValue, setCampaignValue] = useState(widget?.config?.campaign_filter?.value ?? '')
    const [campaignOptions, setCampaignOptions] = useState<string[]>([])

    // Campos de formulario del cliente (raw_fields) → dimensiones + métricas.
    useEffect(() => {
        if (!clienteId) { setFormFields([]); return }
        const params = new URLSearchParams({ cliente_id: clienteId })
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo)   params.set('date_to', dateTo)
        let cancelled = false
        fetch(`/api/report-utm/bi/form-fields?${params}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setFormFields(json.data ?? []) })
            .catch(() => { if (!cancelled) setFormFields([]) })
        return () => { cancelled = true }
    }, [clienteId, dateFrom, dateTo])

    // Campos de lead del catálogo del cliente → dimensiones y filtros del BI.
    // Son los que unifican las claves equivalentes y las variantes de escritura,
    // así que van por delante de las claves crudas de `form-fields`.
    useEffect(() => {
        if (!clienteId) { setLeadFields([]); return }
        const params = new URLSearchParams({ cliente_id: clienteId })
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo)   params.set('date_to', dateTo)
        let cancelled = false
        fetch(`/api/report-utm/bi/lead-fields?${params}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setLeadFields(json.data ?? []) })
            .catch(() => { if (!cancelled) setLeadFields([]) })
        return () => { cancelled = true }
    }, [clienteId, dateFrom, dateTo])

    // Columnas adicionales de los Sheets offline del cliente → métricas del BI.
    useEffect(() => {
        if (!clienteId) { setOfflineFields([]); return }
        let cancelled = false
        fetch(`/api/report-utm/bi/offline-fields?cliente_id=${encodeURIComponent(clienteId)}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setOfflineFields(json.data ?? []) })
            .catch(() => { if (!cancelled) setOfflineFields([]) })
        return () => { cancelled = true }
    }, [clienteId])

    // Campos de Sheet del cliente → métricas, dimensiones y filtros del BI.
    useEffect(() => {
        if (!clienteId) { setSheetFields([]); setSheetViews([]); return }
        let cancelled = false
        fetch(`/api/report-utm/bi/sheet-fields?cliente_id=${encodeURIComponent(clienteId)}`)
            .then(r => r.json())
            .then(json => {
                if (cancelled) return
                setSheetFields(json.data?.fields ?? [])
                setSheetViews(json.data?.views ?? [])
            })
            .catch(() => { if (!cancelled) { setSheetFields([]); setSheetViews([]) } })
        return () => { cancelled = true }
    }, [clienteId])

    // Qué métricas tienen datos para este cliente y rango. Sirve para avisar antes
    // de configurar un widget que va a mostrar 0 (cliente sin ventas, sin TikTok…).
    useEffect(() => {
        const params = new URLSearchParams()
        if (clienteId) params.set('cliente_id', clienteId)
        if (dateFrom)  params.set('date_from', dateFrom)
        if (dateTo)    params.set('date_to', dateTo)
        let cancelled = false
        fetch(`/api/report-utm/bi/metrics-availability?${params}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setAvailability(json.data ?? null) })
            .catch(() => { if (!cancelled) setAvailability(null) })
        return () => { cancelled = true }
    }, [clienteId, dateFrom, dateTo])

    // Nombres de campaña del cliente, para autocompletar el filtro rápido.
    useEffect(() => {
        if (!clienteId) { setCampaignOptions([]); return }
        const params = new URLSearchParams({ type: 'distinct', dimension: 'utm_campaign', cliente_id: clienteId })
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo)   params.set('date_to', dateTo)
        let cancelled = false
        fetch(`/api/report-utm/bi/query?${params}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setCampaignOptions(Array.isArray(json.data) ? json.data : []) })
            .catch(() => { if (!cancelled) setCampaignOptions([]) })
        return () => { cancelled = true }
    }, [clienteId, dateFrom, dateTo])

    /**
     * ¿Esta métrica no trae datos en el rango? Solo se afirma para métricas del
     * catálogo base y con el mapa ya cargado: los campos calculados y de
     * formulario no se evalúan (y sin mapa no se marca nada).
     */
    const hasNoData = (m: string) =>
        !!availability && m in availability && availability[m] === false

    /**
     * ¿El filtro de campaña no coincide con ninguna campaña del cliente? Es la
     * causa silenciosa de widgets en 0: el gasto se recorta por nombre de campaña,
     * así que un texto que no matchea deja gasto y leads a cero sin explicación.
     */
    const campaignFilterMatchesNothing = (() => {
        const v = campaignValue.trim()
        if (!v || campaignOptions.length === 0) return false
        // Se compara con la MISMA normalización que usa el motor al recortar el
        // gasto (`matchFilterConditionNorm`). Con `toLowerCase` a secas este aviso
        // saltaba en falso: `promo_verano` sí cruza con la campaña "Promo Verano".
        return !campaignOptions.some(c => matchFilterConditionNorm(c, campaignOp, v))
    })()

    const isChart = ['line', 'area', 'bar', 'combo', 'pie', 'scatter'].includes(type)
    // El apilado (dimensión secundaria) agrupa filas de leads/ventas: solo puede
    // contar filas o sumar importes. Con gasto, alcance o GA4 devolvería un conteo
    // de filas sin sentido, así que solo se ofrece para las métricas que soporta.
    const dim2Supported = supportsPivot(String(metric))
    const supportsDim2 = ['bar', 'combo', 'area', 'line'].includes(type) && dim2Supported
    const isStructural = type === 'section' || type === 'heading' || type === 'text' || type === 'summary'

    // Opciones derivadas de los campos de formulario descubiertos.
    const fieldDimOptions = formFields.map(f => ({ value: makeFieldDim(f.key), label: humanizeFieldKey(f.label) }))
    // Campos del catálogo: un campo por pregunta, ya unificado. Se ofrecen antes
    // que las claves crudas porque son los que dan un conteo correcto cuando la
    // misma pregunta llega con dos nombres distintos.
    const leadFieldDimOptions = leadFields
        .filter(f => !f.alta_cardinalidad)
        .map(f => ({ value: makeLeadFieldDim(f.clave), label: f.nombre }))
    const fieldMetricOptions = formFields.flatMap(f =>
        AGGS_FOR(f.type).map(agg => ({
            value: makeFieldMetric(agg, f.key),
            label: `${FIELD_AGG_LABEL[agg]} · ${humanizeFieldKey(f.label)}`,
        }))
    )
    // ── Campos de Sheet ───────────────────────────────────────────────────
    // Un campo de alta cardinalidad (apuntado a un correo o un id) sigue
    // valiendo como métrica agregada, pero no como algo por lo que agrupar:
    // produciría un eje con miles de categorías.
    const sheetDimOptions = sheetFields
        .filter(f => f.rol !== 'metrica' && !f.alta_cardinalidad)
        .map(f => ({ value: makeSheetDim(f.clave), label: f.nombre }))

    // Se ofrece la agregación que definió el analista y, para los campos
    // numéricos, también el conteo de filas: son las dos lecturas naturales.
    const sheetMetricOptions = sheetFields.flatMap(f => {
        const aggs: SheetCampoAgg[] = f.agregacion === 'count' ? ['count'] : ['count', f.agregacion]
        return aggs.map(agg => ({
            value: makeSheetMetric(agg, f.clave),
            label: sheetFieldLabel(makeSheetMetric(agg, f.clave), sheetFields, sheetViews) ?? f.nombre,
        }))
    })

    const sheetViewOptions = sheetViews.map(v => ({
        value: makeSheetView(v.clave),
        label: v.nombre,
    }))

    // ── Dimensiones agrupadas ─────────────────────────────────────────────
    // Un campo de lead del catálogo (`leadfield:`) unifica varias claves crudas
    // de `raw_fields`. Ofrecer también esas claves crudas (`field:`) hacía que la
    // MISMA pregunta apareciera dos veces en el desplegable, con conteos
    // distintos, y quien elegía la cruda obtenía el desglose partido.
    // Aquí se ocultan las crudas que ya están cubiertas por un campo del catálogo;
    // las que nadie ha catalogado siguen disponibles en su propio bloque.
    const clavesCubiertas = new Set(leadFields.flatMap(f => f.claves_origen))
    const fieldDimOptionsSinCatalogar = formFields
        .filter(f => !clavesCubiertas.has(normalizarClaveLead(f.key)))
        .map(f => ({ value: makeFieldDim(f.key), label: humanizeFieldKey(f.label) }))

    const dimGroups: MetricGroupUI[] = [
        { key: 'generales', title: 'Generales', items: ALL_DIMS.map(d => ({ value: String(d.value), label: d.label })) },
        {
            key: 'cliente',
            title: 'Campos de este cliente',
            items: [
                ...leadFieldDimOptions.map(o => ({ ...o, label: `${o.label} · lead` })),
                ...sheetDimOptions.map(o => ({ ...o, label: `${o.label} · sheet` })),
            ],
        },
        {
            key: 'crudos',
            title: 'Campos sin catalogar',
            items: fieldDimOptionsSinCatalogar,
        },
    ].filter(g => g.items.length > 0)

    // Lista plana equivalente, para quien solo necesita el conjunto de opciones.
    const dimOptions: { value: string; label: string }[] = dimGroups.flatMap(g => g.items)
    // Campos filtrables (para el constructor de filtro del widget): dimensiones
    // base de filtro (UTMs, país, formulario…) + campos de formulario del cliente.
    const filterFieldOptions: { value: string; label: string }[] = [
        ...FILTERABLE_BASE_DIMS, ...leadFieldDimOptions, ...fieldDimOptions, ...sheetDimOptions,
    ]

    // Columnas adicionales de los Sheets offline → métricas "offfield:<clave>".
    const offlineMetricOptions = offlineFields.map(f => ({
        value: makeOfflineFieldMetric(f.type, f.key),
        label: `${f.label} (Sheet)`,
    }))

    // Etiquetas que resuelven también tokens de campo. Encadenar aquí
    // `sheetFieldLabel` es lo que hace que el nombre que el analista le puso al
    // campo aparezca en el selector, en los títulos y en las columnas de tabla.
    const resolveMetricLabel = (k: string) =>
        METRIC_META[k as BiMetric]?.label
        ?? fieldMetricLabel(k)
        ?? offlineFieldLabel(k, offlineFields)
        ?? sheetFieldLabel(k, sheetFields, sheetViews)
        ?? calculatedFields.find(c => c.name === k)?.name ?? k
    const resolveDimLabel = (d: string) =>
        DIMENSION_META[d as BiDimension]?.label
        ?? leadFieldLabel(d, leadFields)
        ?? fieldDimLabel(d)
        ?? sheetFieldLabel(d, sheetFields, sheetViews)
        ?? d

    // Métricas disponibles = base + campos calculados. Los campos calculados se
    // pueden usar en tablas, scorecards y gráficas (no en funnel/slicer).
    const calcAsMetrics = calculatedFields.map(c => ({ value: c.name, label: `∑ ${c.name}` }))
    const allowCalc = type === 'table' || type === 'scorecard' || isChart
    // La fórmula libre sustituye a UNA métrica, así que no aplica a la tabla
    // (multi-columna: ahí se usan los campos calculados del informe).
    const allowFormula = type === 'scorecard' || isChart

    // Columnas de tabla (multi-columna): el config.metric guarda la lista separada por coma.
    const tableCols = String(metric).split(',').map(s => s.trim()).filter(Boolean)
    function toggleTableCol(col: string) {
        const next = tableCols.includes(col)
            ? tableCols.filter(c => c !== col)
            : [...tableCols, col]
        setMetric(next.join(','))
    }

    const selectedMetrics = type === 'table' ? tableCols : [String(metric)]

    // ── Selector de métricas: curado por defecto, catálogo entero a un clic ──
    // Con 72 métricas fijas + las dinámicas del cliente en una lista plana,
    // encontrar "CPL" costaba más que calcularlo a mano. Por defecto se ven las
    // recomendadas y los campos propios del cliente; el resto queda agrupado por
    // origen tras "Ver todas". El buscador atraviesa siempre todos los grupos.
    const searchQ = metricSearch.trim().toLowerCase()
    const matchesSearch = (o: MetricOpt) => !searchQ || o.label.toLowerCase().includes(searchQ)
    const selectedSet = new Set(selectedMetrics.filter(Boolean))

    // Una métrica sin datos en el rango solo estorba en la lista. Se oculta, salvo
    // que la estés buscando por nombre o ya esté puesta en el widget: hacer
    // desaparecer del selector algo que el widget usa sería peor que el ruido.
    const isUseful = (o: MetricOpt) => !hasNoData(o.value) || !!searchQ || selectedSet.has(o.value)

    const opt = (m: BiMetric): MetricOpt => ({ value: m, label: METRIC_META[m].label })
    const recommended = RECOMMENDED_METRICS.map(opt)
    const recommendedSet = new Set(RECOMMENDED_METRICS as string[])

    /** Grupos del catálogo fijo, sin repetir las recomendadas. */
    const catalogGroups: MetricGroupUI[] = METRIC_GROUP_META.map(g => ({
        key: g.key,
        title: g.label,
        items: metricsOfGroup(g.key).filter(m => !recommendedSet.has(m)).map(opt),
    }))

    /** Grupos dinámicos: lo que este cliente concreto tiene configurado. */
    const dynamicGroups: MetricGroupUI[] = [
        { key: 'calc',       title: 'Campos calculados del informe', items: allowCalc ? calcAsMetrics : [] },
        { key: 'formfields', title: 'Campos de formulario',          items: allowCalc ? fieldMetricOptions : [] },
        { key: 'sheetviews', title: 'Vistas de Sheet',               items: sheetViewOptions },
        { key: 'sheet',      title: 'Campos de Sheet',               items: sheetMetricOptions },
        { key: 'offline',    title: 'Columnas de Sheet offline',     items: offlineMetricOptions },
    ]

    // Sin "ver todas" ni búsqueda, del catálogo fijo solo se muestran las
    // recomendadas más lo que el widget ya tenga elegido (para no perderlo de
    // vista al abrir un widget viejo que use una métrica del fondo del catálogo).
    const extrasEnUso = showAllMetrics || searchQ
        ? []
        : (Object.keys(METRIC_META) as BiMetric[])
            .filter(m => selectedSet.has(m) && !recommendedSet.has(m))
            .map(opt)

    const metricGroups: MetricGroupUI[] = [
        { key: 'recommended', title: 'Recomendadas', items: recommended },
        { key: 'inuse',       title: 'En uso en este widget', items: extrasEnUso },
        ...(showAllMetrics || searchQ ? catalogGroups : []),
        ...dynamicGroups,
    ]
        .map(g => ({ ...g, items: g.items.filter(matchesSearch).filter(isUseful) }))
        .filter(g => g.items.length > 0)

    /** Cuántas métricas del catálogo quedan escondidas tras "Ver todas". */
    const hiddenCount = showAllMetrics || searchQ
        ? 0
        : catalogGroups.reduce((n, g) => n + g.items.filter(isUseful).length, 0)

    // Métricas que NO se desglosan por la dimensión elegida: saldrían en la fila
    // total. Antes esto se deducía de `source === 'ads'`, que estaba mal asignado
    // en 56 de 72 métricas y disparaba el aviso sobre GA4, offline y suscripciones
    // incluso agrupando por fecha. Ahora lo declara cada métrica (`breakdown`).
    const noCrossMetrics = selectedMetrics.filter(m => m && !metricCrossesDimension(m, dim))
    const showAdDimWarning =
        type !== 'scorecard' && type !== 'funnel' && type !== 'slicer' &&
        dim !== 'none' && noCrossMetrics.length > 0

    // Un campo de Sheet vive en su propia tabla y no cruza con leads/ventas/gasto.
    // Los dos avisos que hacen falta:
    //   • métrica de Sheet agrupada por una dimensión de lead → caería en (total)
    //   • dimensión de Sheet con métricas de otra fuente → esas saldrían en cero
    const isCrossDim = dim !== 'none' && dim !== 'date' && !isSheetDim(dim)
    const showSheetMetricDimWarning =
        type !== 'scorecard' && type !== 'funnel' && type !== 'slicer' &&
        isCrossDim && selectedMetrics.some(isSheetToken)
    const sheetDimNoSheetMetric =
        isSheetDim(dim) && selectedMetrics.length > 0 && !selectedMetrics.some(isSheetToken)

    // Métricas que se pueden usar para filtrar filas por valor (las que el widget trae)
    const metricLabelOf = resolveMetricLabel
    const valueFilterChoices = (type === 'table'
        ? (tableCols.length ? tableCols : ALL_METRICS.map(m => String(m.value)))
        : [String(metric)]
    ).filter(Boolean)

    useEffect(() => {
        if (!title && !isStructural) {
            const m = resolveMetricLabel(String(metric))
            const d = resolveDimLabel(dim)
            setTitle(type === 'funnel' ? 'Funnel de Conversión' : type === 'scorecard' ? m : `${m} por ${d}`)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, metric, dim])

    function handleSave() {
        const id = widget?.id ?? genId()

        // Bloques estructurales / presentacionales: sin métrica ni dimensión.
        if (isStructural) {
            if (type === 'text') {
                onSave({ id, type, title: title.trim(), w: colSpan, h: rowSpan, config: { text, align } })
            } else if (type === 'summary') {
                // `text` vacío = resumen automático; con texto = redacción manual.
                onSave({ id, type, title: title.trim() || 'Resumen del período', w: colSpan, h: rowSpan, config: { text: text.trim() || undefined, accent: accent || undefined } })
            } else if (type === 'heading') {
                onSave({ id, type, title: title.trim() || 'Título', w: colSpan, h: rowSpan, config: { heading_level: headingLevel, align, accent: accent || undefined } })
            } else {
                // section: preserva los widgets contenidos al editar.
                onSave({ id, type, title: title.trim() || 'Sección', w: 4, h: 1, config: { columns, accent: accent || undefined, collapsed: widget?.config?.collapsed ?? false }, children: widget?.children ?? [] })
            }
            return
        }

        if (!title.trim()) return
        const config: WidgetConfig = {}
        if (type === 'slicer') {
            config.dimension = dim === 'date' ? 'utm_source' : dim
            config.slicer_mode = slicerMode
        } else if (type === 'funnel') {
            // Etapas en el orden elegido; con menos de 2 el servidor usa el embudo
            // por defecto (impresiones → clics → leads → ventas).
            if (funnelStages.length >= 2) config.metrics = funnelStages as BiMetric[]
        } else {
            // Tablas: lista de columnas. Otros widgets: una sola métrica.
            config.metric = type === 'table' ? tableCols.join(',') : tableCols[0] ?? 'leads_count'
            // Fórmula del widget: manda sobre la métrica elegida.
            if (allowFormula && useFormula && formula.trim()) {
                config.formula = formula.trim()
                config.formula_format = formulaFormat
                const d = formulaDecimals.trim()
                if (d !== '') config.formula_decimals = Math.max(0, Math.min(4, Number(d) || 0))
            }
            if (type !== 'scorecard') {
                config.dimension = dim
                if (dim === 'date') config.date_grouping = grouping
                if (supportsDim2 && dim2 !== 'none') config.dimension2 = dim2
                config.limit = limit
                config.sort = sort
                if (isChart) config.color = color
            }
            if (type === 'scorecard') {
                config.compare_period = compare
                // Solo se persiste lo que no es el default, para no engordar el layout.
                if (variant !== 'default') config.variant = variant
                if (variant === 'threshold') {
                    const g = Number(thGreen), y = Number(thYellow)
                    if (Number.isFinite(g) && Number.isFinite(y)) {
                        config.threshold = { greenOp: thGreenOp, green: g, yellowOp: thYellowOp, yellow: y }
                    }
                }
                if (variant === 'progress') {
                    const t = Number(target)
                    if (Number.isFinite(t) && t > 0) config.target = t
                }
            }
            if (type === 'table') {
                config.show_totals = showTotals
                if (conditional.length) config.conditional = conditional
                if (valueFilters.length) config.value_filters = valueFilters
            }
        }
        // Filtro propio del widget (Y de O): aplica a todos los widgets de datos.
        if (type !== 'slicer' && advancedFilterHasConditions(advancedFilter)) {
            config.advanced_filter = advancedFilter
        }
        // Filtro rápido por campaña: recorta gasto y leads solo en este widget.
        if (type !== 'slicer' && campaignValue.trim()) {
            config.campaign_filter = { op: campaignOp, value: campaignValue.trim() }
        }
        onSave({
            id,
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
            <div className="relative z-10 w-full max-w-3xl mx-4 rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <p className="text-sm font-semibold text-foreground">
                        {widget ? 'Editar widget' : 'Agregar widget'}
                    </p>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Dos columnas en pantallas anchas: la configuración de datos a la
                    izquierda y filtros/tamaño a la derecha, para no scrollear tanto. */}
                <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-4 items-start max-h-[80vh] overflow-y-auto">
                    {/* Widget type */}
                    <div className="md:col-span-2">
                        <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-2">
                            Tipo de widget
                            <HelpTip text="Scorecard = un número (KPI). Línea/Área = tendencia en el tiempo. Barras = comparar valores. Combo = barras apiladas. Donut = proporción. Dispersión = correlación. Tabla = detalle con columnas. Embudo = conversión etapa por etapa." />
                        </label>
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
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
                        {/* Bloques de organización */}
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mt-3 mb-2">Organización</p>
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                            {STRUCTURAL_TYPES.filter(t => t.value !== 'section' || allowSection).map(t => (
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
                    <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                            {type === 'text' ? 'Título (opcional)' : type === 'section' ? 'Nombre de la sección' : 'Título'}
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder={type === 'section' ? 'Ej. Resultados de Meta Ads' : type === 'heading' ? 'Ej. Rendimiento del mes' : 'Nombre del widget'}
                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                    </div>

                    {/* Config de bloques estructurales */}
                    {type === 'text' && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">Texto</label>
                            <textarea
                                value={text}
                                onChange={e => setText(e.target.value)}
                                rows={5}
                                placeholder={'Escribe tu comentario para el cliente…\n\nSoporta **negrita**, saltos de línea y\n- viñetas'}
                                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">Formato: <span className="font-mono">**negrita**</span>, línea nueva = párrafo, <span className="font-mono">- </span> = viñeta.</p>
                        </div>
                    )}
                    {type === 'summary' && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                                Texto del resumen <span className="text-muted-foreground/50">(opcional)</span>
                            </label>
                            <textarea
                                value={text}
                                onChange={e => setText(e.target.value)}
                                rows={5}
                                placeholder={'Déjalo vacío para generar el resumen automáticamente\ncon los datos del período (inversión, leads, CPL,\nventas, ROAS y comparación vs. el período anterior).'}
                                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Si escribes algo aquí, ese texto reemplaza al resumen automático — útil para
                                ajustar la lectura antes de enviar el informe al cliente.
                            </p>
                        </div>
                    )}
                    {type === 'heading' && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">Nivel del título</label>
                            <select
                                value={headingLevel}
                                onChange={e => setHeadingLevel(Number(e.target.value) as 1 | 2 | 3)}
                                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                            >
                                <option value={1}>H1 · Grande (con acento)</option>
                                <option value={2}>H2 · Mediano (con línea)</option>
                                <option value={3}>H3 · Pequeño</option>
                            </select>
                        </div>
                    )}
                    {type === 'section' && (
                        <div>
                            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                Columnas internas
                                <HelpTip text="Cuántas columnas usa la grilla dentro de la sección. 4 = igual que el informe; menos columnas = widgets más anchos." />
                            </label>
                            <div className="flex gap-1">
                                {[1, 2, 3, 4].map(n => (
                                    <button
                                        key={n}
                                        onClick={() => setColumns(n)}
                                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                            columns === n
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {n}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {(type === 'text' || type === 'heading') && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-2">Alineación</label>
                            <div className="flex gap-1">
                                {(['left', 'center'] as const).map(a => (
                                    <button
                                        key={a}
                                        onClick={() => setAlign(a)}
                                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                            align === a
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {a === 'left' ? 'Izquierda' : 'Centro'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {(type === 'section' || type === 'heading' || type === 'summary') && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground mb-2">Color de acento</label>
                            <div className="flex gap-2 flex-wrap items-center">
                                <button
                                    onClick={() => setAccent('')}
                                    className={`h-6 px-2 rounded-full text-[10px] border transition-all ${accent === '' ? 'border-foreground ring-2 ring-offset-2 ring-offset-card ring-foreground' : 'border-border text-muted-foreground'}`}
                                >
                                    Sin color
                                </button>
                                {COLOR_OPTIONS.map(c => (
                                    <button
                                        key={c}
                                        onClick={() => setAccent(c)}
                                        style={{ background: c }}
                                        className={`h-6 w-6 rounded-full transition-transform ${accent === c ? 'ring-2 ring-offset-2 ring-offset-card ring-foreground scale-110' : ''}`}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

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
                                        onChange={e => setDim(e.target.value)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {dimOptions.filter(d => d.value !== 'none' && d.value !== 'date').map(d => (
                                            <option key={d.value} value={d.value}>{d.label}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </>
                    )}

                    {/* Etapas del embudo */}
                    {type === 'funnel' && (
                        <div>
                            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                Etapas del embudo
                                <HelpTip text="Marca las etapas en el orden en que las quieres ver, de arriba (mayor volumen) a abajo. Entre cada par se calcula el % de conversión. Mínimo 2 etapas." />
                            </label>
                            <div className="max-h-44 overflow-y-auto rounded-lg border border-border bg-muted/30 divide-y divide-border">
                                {FUNNEL_STAGE_METRICS.map(m => {
                                    const checked = funnelStages.includes(m)
                                    const order = funnelStages.indexOf(m)
                                    return (
                                        <label key={m} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent transition-colors">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => setFunnelStages(prev =>
                                                    prev.includes(m) ? prev.filter(s => s !== m) : [...prev, m]
                                                )}
                                                className="h-3.5 w-3.5 rounded accent-emerald-500"
                                            />
                                            <span className="text-xs text-foreground flex-1">{METRIC_META[m].label}</span>
                                            {hasNoData(m) && (
                                                <span className="text-[9px] text-amber-600 dark:text-amber-400">sin datos</span>
                                            )}
                                            {checked && (
                                                <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                                                    {order + 1}
                                                </span>
                                            )}
                                        </label>
                                    )
                                })}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1">
                                {funnelStages.length < 2
                                    ? 'Marca al menos 2 etapas (si no, se usa el embudo por defecto).'
                                    : `${funnelStages.length} etapas · en el orden marcado`}
                            </p>
                        </div>
                    )}

                    {/* Metric + Dimension (not for funnel/slicer/estructurales) */}
                    {!isStructural && type !== 'funnel' && type !== 'slicer' && (
                        <>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                                        {useFormula && allowFormula ? 'Fórmula' : 'Métrica'}
                                        <HelpTip text="Métrica = un valor del catálogo (Leads, Gasto, ROAS…). Fórmula = tú la construyes cruzando métricas con + - * / y paréntesis, ej. 'meta_spend / ga_sessions' = costo por visita. Los campos con ∑ son campos calculados del informe." />
                                    </label>
                                    {allowFormula && (
                                        <div className="flex rounded-lg border border-border overflow-hidden">
                                            {([false, true] as const).map(f => (
                                                <button
                                                    key={String(f)}
                                                    onClick={() => setUseFormula(f)}
                                                    className={`px-2 py-1 text-[10px] font-medium transition-colors ${
                                                        useFormula === f
                                                            ? 'bg-emerald-500 text-white'
                                                            : 'bg-muted text-muted-foreground hover:bg-accent'
                                                    }`}
                                                >
                                                    {f ? 'Fórmula' : 'Métrica'}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Fórmula libre: cruza métricas de cualquier fuente */}
                                {allowFormula && useFormula && (
                                    <div className="space-y-2">
                                        <BiFormulaInput
                                            value={formula}
                                            onChange={setFormula}
                                            formFields={formFields}
                                            offlineFields={offlineFields}
                                            sheetFields={sheetFields}
                                            sheetViews={sheetViews}
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Formato</label>
                                                <select
                                                    value={formulaFormat}
                                                    onChange={e => setFormulaFormat(e.target.value as typeof formulaFormat)}
                                                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                                >
                                                    <option value="number">Número</option>
                                                    <option value="currency">Moneda</option>
                                                    <option value="percent">Porcentaje</option>
                                                    <option value="ratio">Ratio (x)</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Decimales</label>
                                                <input
                                                    type="number" min={0} max={4} value={formulaDecimals}
                                                    onChange={e => setFormulaDecimals(e.target.value)}
                                                    placeholder="auto"
                                                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                                />
                                            </div>
                                        </div>
                                        {formula.trim() && evaluateExpression(formula, {}) === null && (
                                            <p className="text-[10px] text-red-500">
                                                Expresión inválida: solo se admiten métricas, números y + − × ÷ ( ).
                                            </p>
                                        )}
                                    </div>
                                )}

                                {!(allowFormula && useFormula) && (
                                <>{/* Selector de métrica del catálogo */}
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
                                        {/* Selector multi-columna, agrupado por origen */}
                                        <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-muted/30">
                                            {metricGroups.map(g => (
                                                <div key={g.key}>
                                                    <div className="sticky top-0 z-10 px-3 py-1 bg-muted/95 backdrop-blur border-y border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                        {g.title}
                                                    </div>
                                                    <div className="divide-y divide-border">
                                                        {g.items.map(m => {
                                                            const checked = tableCols.includes(m.value)
                                                            const order = tableCols.indexOf(m.value)
                                                            const noCross = !metricCrossesDimension(m.value, dim)
                                                            return (
                                                                <label key={`${g.key}:${m.value}`} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent transition-colors">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={checked}
                                                                        onChange={() => toggleTableCol(m.value)}
                                                                        className="h-3.5 w-3.5 rounded accent-emerald-500"
                                                                    />
                                                                    <span className="text-xs text-foreground flex-1">{m.label}</span>
                                                                    {noCross && (
                                                                        <span
                                                                            title={`No se desglosa por ${resolveDimLabel(dim)}: saldría en la fila “(total)”.`}
                                                                            className="text-[9px] text-amber-600 dark:text-amber-400"
                                                                        >
                                                                            no cruza
                                                                        </span>
                                                                    )}
                                                                    {hasNoData(m.value) && (
                                                                        <span className="text-[9px] text-amber-600 dark:text-amber-400">sin datos</span>
                                                                    )}
                                                                    {checked && (
                                                                        <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                                                                            col {order + 1}
                                                                        </span>
                                                                    )}
                                                                </label>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="flex items-center justify-between gap-2 mt-1">
                                            <p className="text-[10px] text-muted-foreground">
                                                {tableCols.length === 0
                                                    ? 'Selecciona al menos una columna.'
                                                    : `${tableCols.length} columna${tableCols.length > 1 ? 's' : ''} · se muestran en el orden marcado`}
                                            </p>
                                            {hiddenCount > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setShowAllMetrics(true)}
                                                    className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline shrink-0"
                                                >
                                                    Ver todas ({hiddenCount} más)
                                                </button>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <select
                                            value={metric}
                                            onChange={e => setMetric(e.target.value)}
                                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                        >
                                            {metricGroups.map(g => (
                                                <optgroup key={g.key} label={g.title}>
                                                    {g.items.map(m => (
                                                        <option key={`${g.key}:${m.value}`} value={m.value}>
                                                            {m.label}
                                                            {!metricCrossesDimension(m.value, dim) ? ' · no cruza con esta dimensión' : ''}
                                                            {hasNoData(m.value) ? ' · sin datos en el rango' : ''}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            ))}
                                        </select>
                                        {hiddenCount > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => setShowAllMetrics(true)}
                                                className="mt-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                            >
                                                Ver todas las métricas ({hiddenCount} más)
                                            </button>
                                        )}
                                    </>
                                )}
                                {hasNoData(String(metric)) && (
                                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-3 py-2">
                                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                        <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                                            <strong>{resolveMetricLabel(String(metric))}</strong> no tiene datos para este cliente en el rango
                                            seleccionado: el widget mostrará 0. Puedes dejarlo configurado si esperas que la fuente empiece a alimentarse.
                                        </p>
                                    </div>
                                )}
                                </>
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
                                        onChange={e => setDim(e.target.value)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {dimGroups.map(g => (
                                            <optgroup key={g.key} label={g.title}>
                                                {g.items.filter(d => d.value !== 'none').map(d => (
                                                    <option key={`${g.key}:${d.value}`} value={d.value}>{d.label}</option>
                                                ))}
                                            </optgroup>
                                        ))}
                                    </select>
                                    {showAdDimWarning && (
                                        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-3 py-2">
                                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                                                <strong>{noCrossMetrics.map(resolveMetricLabel).join(', ')}</strong>{' '}
                                                {noCrossMetrics.length === 1 ? 'no se desglosa' : 'no se desglosan'} por{' '}
                                                <strong>{resolveDimLabel(dim)}</strong>: {noCrossMetrics.length === 1 ? 'caería' : 'caerían'} en la fila “(total)”.
                                                Usa <strong>Fecha</strong> para la evolución, o mide{' '}
                                                {noCrossMetrics.length === 1 ? 'esa métrica' : 'esas métricas'} en un scorecard aparte.
                                            </p>
                                        </div>
                                    )}
                                    {showSheetMetricDimWarning && (
                                        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-3 py-2">
                                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                                                Los campos de Sheet no se desglosan por <strong>{resolveDimLabel(dim)}</strong>: el Sheet no
                                                guarda a qué lead corresponde cada fila. Usa <strong>Fecha</strong> para la evolución, o el
                                                propio campo como dimensión para ver el reparto por sus valores.
                                            </p>
                                        </div>
                                    )}
                                    {sheetDimNoSheetMetric && (
                                        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-3 py-2">
                                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                                                Al agrupar por <strong>{resolveDimLabel(dim)}</strong> solo se pueden medir campos de Sheet.
                                                Las demás métricas saldrían en cero.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {['bar', 'combo', 'area', 'line'].includes(type) && !dim2Supported && (
                                <p className="text-[10px] text-muted-foreground leading-snug">
                                    El apilado por dimensión secundaria solo está disponible para{' '}
                                    {PIVOT_METRICS.map(m => METRIC_META[m].label).join(', ')} — son las únicas
                                    métricas que se pueden desglosar fila a fila.
                                </p>
                            )}

                            {supportsDim2 && (
                                <div>
                                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground mb-1">
                                        Dimensión secundaria <span className="text-muted-foreground/50">(apilado)</span>
                                        <HelpTip text="Divide cada barra/línea en sub-series. Ej: dimensión Campaña + secundaria Source = cada campaña apilada por su origen de tráfico. Déjala en 'Ninguna' para un gráfico simple." />
                                    </label>
                                    <select
                                        value={dim2}
                                        onChange={e => setDim2(e.target.value)}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        <option value="none">Ninguna</option>
                                        {dimOptions.filter(d => d.value !== 'none' && d.value !== 'campaign' && d.value !== dim).map(d => (
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

                            {/* Presentación del scorecard: semáforo / progreso */}
                            {type === 'scorecard' && (
                                <div className="rounded-xl border border-border p-3 space-y-2.5">
                                    <label className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                                        Presentación
                                        <HelpTip text="Estándar = solo el número. Semáforo = lo pinta de verde/ámbar/rojo según los umbrales que definas aquí. Progreso = barra de avance hacia un objetivo." />
                                    </label>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {SCORECARD_VARIANTS.map(v => (
                                            <button
                                                key={v.value}
                                                onClick={() => setVariant(v.value)}
                                                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                                                    variant === v.value
                                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                        : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                                }`}
                                            >
                                                {v.label}
                                            </button>
                                        ))}
                                    </div>

                                    {variant === 'threshold' && (
                                        <div className="space-y-1.5">
                                            {([
                                                { color: 'Verde', op: thGreenOp, setOp: setThGreenOp, val: thGreen, setVal: setThGreen },
                                                { color: 'Ámbar', op: thYellowOp, setOp: setThYellowOp, val: thYellow, setVal: setThYellow },
                                            ] as const).map(row => (
                                                <div key={row.color} className="flex items-center gap-1.5">
                                                    <span className="w-12 text-[11px] text-muted-foreground">{row.color}</span>
                                                    <select
                                                        value={row.op}
                                                        onChange={e => row.setOp(e.target.value as 'gte' | 'lte')}
                                                        className="px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                                    >
                                                        <option value="gte">≥</option>
                                                        <option value="lte">≤</option>
                                                    </select>
                                                    <input
                                                        type="number" value={row.val}
                                                        onChange={e => row.setVal(e.target.value)}
                                                        placeholder="valor"
                                                        className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                                    />
                                                </div>
                                            ))}
                                            <p className="text-[10px] text-muted-foreground">
                                                Si no cumple ninguno de los dos, se pinta en rojo.
                                            </p>
                                        </div>
                                    )}

                                    {variant === 'progress' && (
                                        <div>
                                            <label className="block text-[10px] font-medium text-muted-foreground mb-1">Objetivo del período</label>
                                            <input
                                                type="number" value={target}
                                                onChange={e => setTarget(e.target.value)}
                                                placeholder="ej. 500"
                                                className="w-full px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                            />
                                        </div>
                                    )}
                                </div>
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

                            {/* Filtros por valor (tabla y gráficas): ocultar filas que no cumplan */}
                            {(type === 'table' || isChart) && (
                                <div className="rounded-xl border border-border p-3 space-y-2">
                                    <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                                        Filtrar filas por valor
                                        <HelpTip text="Oculta las filas que no cumplan la condición. Ej: Gasto > 0 quita campañas sin gasto; CPL ≤ 50 deja solo leads baratos; Leads entre 10 y 100. Si hay varias, deben cumplirse todas (Y)." />
                                    </p>
                                    {valueFilters.map((f, i) => (
                                        <div key={i} className="flex items-center gap-1.5 flex-wrap">
                                            <select
                                                value={f.metric}
                                                onChange={e => setValueFilters(v => v.map((r, idx) => idx === i ? { ...r, metric: e.target.value } : r))}
                                                className="px-2 py-1 text-[11px] rounded bg-muted border border-border text-foreground max-w-[140px]"
                                            >
                                                {valueFilterChoices.map(k => <option key={k} value={k}>{metricLabelOf(k)}</option>)}
                                            </select>
                                            <select
                                                value={f.op}
                                                title="Operador"
                                                onChange={e => setValueFilters(v => v.map((r, idx) => idx === i ? { ...r, op: e.target.value as ValueOp } : r))}
                                                className="px-1 py-1 text-[11px] rounded bg-muted border border-border text-foreground"
                                            >
                                                {VALUE_OPS.map(o => <option key={o.value} value={o.value} title={o.label}>{o.short} {o.label}</option>)}
                                            </select>
                                            <input
                                                type="number" value={f.value}
                                                onChange={e => setValueFilters(v => v.map((r, idx) => idx === i ? { ...r, value: parseFloat(e.target.value) || 0 } : r))}
                                                className="w-16 px-2 py-1 text-[11px] font-mono rounded bg-muted border border-border text-foreground"
                                            />
                                            {f.op === 'between' && (
                                                <>
                                                    <span className="text-[10px] text-muted-foreground">y</span>
                                                    <input
                                                        type="number" value={f.value2 ?? 0}
                                                        onChange={e => setValueFilters(v => v.map((r, idx) => idx === i ? { ...r, value2: parseFloat(e.target.value) || 0 } : r))}
                                                        className="w-16 px-2 py-1 text-[11px] font-mono rounded bg-muted border border-border text-foreground"
                                                    />
                                                </>
                                            )}
                                            <button onClick={() => setValueFilters(v => v.filter((_, idx) => idx !== i))} className="p-1 text-muted-foreground hover:text-red-500">
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        onClick={() => setValueFilters(v => [...v, { metric: valueFilterChoices[0] ?? 'spend', op: 'gt', value: 0 }])}
                                        className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                    >
                                        <Plus className="h-3 w-3" /> Agregar filtro
                                    </button>
                                </div>
                            )}
                        </>
                    )}

                    {/* Filtro rápido por campaña: recorta gasto Y leads de este widget */}
                    {!isStructural && type !== 'slicer' && (
                        <div className="rounded-xl border border-border p-3 space-y-2">
                            <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                                Campaña
                                <HelpTip text="Limita este widget a las campañas cuyo nombre cumpla la condición. A diferencia de otros filtros, este SÍ recorta el gasto de anuncios (además de los leads), porque el nombre de campaña es el puente entre ambos." />
                            </p>
                            <div className="flex items-center gap-1.5">
                                <select
                                    value={campaignOp}
                                    onChange={e => setCampaignOp(e.target.value as FilterOp)}
                                    className="px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                >
                                    {FILTER_OPS.map(o => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                                <input
                                    type="text"
                                    list="bi-campaign-options"
                                    value={campaignValue}
                                    onChange={e => setCampaignValue(e.target.value)}
                                    placeholder="nombre de campaña…"
                                    className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                />
                                {campaignValue && (
                                    <button
                                        onClick={() => setCampaignValue('')}
                                        title="Quitar filtro de campaña"
                                        className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 transition-colors"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                            <datalist id="bi-campaign-options">
                                {campaignOptions.map(c => <option key={c} value={c} />)}
                            </datalist>
                            {!clienteId && (
                                <p className="text-[10px] text-muted-foreground">
                                    Selecciona un cliente para ver la lista de campañas.
                                </p>
                            )}
                            {campaignFilterMatchesNothing && (
                                <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/10 px-3 py-2">
                                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug">
                                        Ninguna campaña de este cliente cumple la condición, así que el widget
                                        mostrará <strong>0</strong> en gasto y leads. Revisa el texto o elige una de la lista.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Filtros del widget (Y de O): filtran SOLO este widget, en Y con los globales */}
                    {!isStructural && type !== 'slicer' && (
                        <div className="rounded-xl border border-border p-3 space-y-2">
                            <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                                Filtros del widget
                                <HelpTip text="Filtra SOLO este widget por variables (UTMs, país, formulario, campos…). Dentro de un grupo las condiciones se unen con O; los grupos entre sí con Y. Se combina (Y) con los filtros globales del informe. Ej: País contiene Colombia." />
                            </p>
                            {!clienteId && (
                                <p className="text-[10px] text-muted-foreground">
                                    Selecciona un cliente en los filtros globales para ver los campos de formulario.
                                </p>
                            )}
                            <BiAdvancedFilterBuilder
                                value={advancedFilter}
                                onChange={setAdvancedFilter}
                                fieldOptions={filterFieldOptions}
                            />
                        </div>
                    )}

                    {/* Tamaño (las secciones son siempre a lo ancho) */}
                    {type !== 'section' && (
                    <div className="md:col-span-2 grid grid-cols-2 gap-3">
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
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={(!isStructural && !title.trim()) || (type === 'table' && tableCols.length === 0)}
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
