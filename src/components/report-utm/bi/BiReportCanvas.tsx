'use client'

import { useState, useCallback } from 'react'
import { Plus, Save, Pencil, Check, X, FileDown, Share2, Calculator, Clock, Info, LayoutTemplate } from 'lucide-react'
import { BiShareModal } from './BiShareModal'
import { BiScheduleModal } from './BiScheduleModal'
import type { BiSchedule } from './BiTypes'
import { BiCalcFieldsModal } from './BiCalcFieldsModal'
import { HelpTip } from './HelpTip'
import type { CalculatedField } from './BiTypes'
import type { AdvancedFilter } from '@/lib/report-utm/bi-metadata'
import {
    isFieldDim, fieldDimLabel,
    ADVANCED_FILTER_KEY, parseAdvancedFilter, serializeAdvancedFilter, advancedFilterHasConditions,
    hasNonAttributableFilter,
} from '@/lib/report-utm/bi-metadata'
import {
    DndContext,
    DragOverlay,
    closestCorners,
    PointerSensor,
    useSensor,
    useSensors,
    useDroppable,
    type DragStartEvent,
    type DragOverEvent,
    type DragEndEvent,
} from '@dnd-kit/core'
import {
    SortableContext,
    arrayMove,
    rectSortingStrategy,
} from '@dnd-kit/sortable'
import type { BiWidget, BiFilters, BiReport } from './BiTypes'
import { BiWidgetCard }   from './BiWidgetCard'
import { BiSectionContainer, CONTAINER_PREFIX } from './BiSectionContainer'
import { BiWidgetEditor } from './BiWidgetEditor'
import { BiGlobalFilters } from './BiGlobalFilters'
import { exportReportPdf } from './exportPdf'

// ── Helpers de árbol de 2 niveles (raíz + secciones) ──────────────────
// El layout es un array plano de bloques; un bloque 'section' contiene
// widgets en `children`. Un "contenedor" es la raíz (ROOT) o una sección.
const ROOT = '__root__'

/** Contenedor que aloja el id dado (widget o sección). */
function findContainerId(layout: BiWidget[], id: string): string | null {
    if (layout.some(w => w.id === id)) return ROOT
    for (const w of layout) {
        if (w.type === 'section' && (w.children ?? []).some(c => c.id === id)) return w.id
    }
    return null
}

/** Un `over.id` puede ser un droppable de contenedor o un item. */
function resolveOverContainer(layout: BiWidget[], overId: string): string | null {
    if (overId === `${CONTAINER_PREFIX}${ROOT}`) return ROOT
    if (overId.startsWith(CONTAINER_PREFIX)) return overId.slice(CONTAINER_PREFIX.length)
    return findContainerId(layout, overId)
}

function itemsOf(layout: BiWidget[], containerId: string): BiWidget[] {
    if (containerId === ROOT) return layout
    return layout.find(w => w.id === containerId)?.children ?? []
}

function withItems(layout: BiWidget[], containerId: string, items: BiWidget[]): BiWidget[] {
    if (containerId === ROOT) return items
    return layout.map(w => w.id === containerId ? { ...w, children: items } : w)
}

/** Devuelve el bloque con ese id, esté en la raíz o dentro de una sección. */
function findWidget(layout: BiWidget[], id: string): BiWidget | undefined {
    const top = layout.find(w => w.id === id)
    if (top) return top
    for (const w of layout) {
        if (w.type === 'section') {
            const child = (w.children ?? []).find(c => c.id === id)
            if (child) return child
        }
    }
    return undefined
}

/** Grid raíz: también es zona droppable (para sacar widgets de una sección). */
function RootDroppable({ children }: { children: React.ReactNode }) {
    const { setNodeRef } = useDroppable({ id: `${CONTAINER_PREFIX}${ROOT}` })
    return (
        <div
            ref={setNodeRef}
            id="bi-canvas-grid"
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(0,auto)]"
        >
            {children}
        </div>
    )
}

interface Props {
    report: BiReport
    readonly?: boolean
    /**
     * Rango de fechas congelado (link de una entrega del historial). Fija los
     * filtros de fecha al período entregado y bloquea el selector, de modo que
     * "Semana 2 de Julio 2026" siempre muestre lo mismo.
     */
    lockedDates?: { from: string; to: string }
}

// Fecha de calendario LOCAL (mismo criterio que el preset "Este mes" de los filtros)
function isoLocal(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function startOfMonth(): string {
    const n = new Date()
    return isoLocal(new Date(n.getFullYear(), n.getMonth(), 1))
}

function genId(): string {
    return Math.random().toString(36).slice(2, 10)
}

export function BiReportCanvas({ report: initialReport, readonly, lockedDates }: Props) {
    const [report, setReport] = useState<BiReport>(initialReport)
    const [filters, setFilters] = useState<BiFilters>(() => {
        // El filtro avanzado guardado vive bajo la clave reservada __adv; se
        // maneja aparte (estado advancedFilter), no como filtro plano.
        const base = { ...(initialReport.filters ?? {}) }
        delete base[ADVANCED_FILTER_KEY]
        return {
            date_from: startOfMonth(),
            date_to:   isoLocal(new Date()),
            ...base,
            ...(initialReport.cliente_id ? { cliente_id: initialReport.cliente_id } : {}),
            // El período de una entrega manda sobre los filtros guardados.
            ...(lockedDates ? { date_from: lockedDates.from, date_to: lockedDates.to } : {}),
        }
    })
    // Filtro avanzado (Y de O), inicializado desde lo persistido en el informe.
    const [advancedFilter, setAdvancedFilter] = useState<AdvancedFilter>(
        () => parseAdvancedFilter(initialReport.filters?.[ADVANCED_FILTER_KEY])
    )
    const [savingAdv, setSavingAdv] = useState(false)
    const [advSaved, setAdvSaved]   = useState(false)
    const [editMode,   setEditMode]   = useState(false)
    const [editorOpen, setEditorOpen] = useState(false)
    const [editingWidget, setEditingWidget] = useState<BiWidget | null>(null)
    // Contenedor destino al crear un widget nuevo: ROOT o el id de una sección.
    const [addTarget, setAddTarget] = useState<string>(ROOT)
    // Bloque que se está arrastrando (para el DragOverlay).
    const [activeId, setActiveId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saved,  setSaved]  = useState(false)
    const [dirty,  setDirty]  = useState(false)
    const [exporting, setExporting] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const [scheduleOpen, setScheduleOpen] = useState(false)
    const [calcOpen, setCalcOpen]   = useState(false)
    const [savingTemplate, setSavingTemplate] = useState(false)
    const [templateSaved, setTemplateSaved]   = useState(false)
    // Fuerza expandir todas las secciones (para capturar el PDF completo).
    const [forceExpandAll, setForceExpandAll] = useState(false)

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
    )

    // Guarda un widget: si existe (en raíz o en una sección) lo reemplaza donde
    // esté; si es nuevo, lo inserta en el contenedor destino (addTarget).
    const handleSaveWidget = useCallback((w: BiWidget) => {
        setReport(prev => {
            const container = findContainerId(prev.layout, w.id)
            let layout: BiWidget[]
            if (container) {
                // Reemplazo in-place preservando children en secciones editadas.
                layout = withItems(prev.layout, container, itemsOf(prev.layout, container).map(x => x.id === w.id ? w : x))
            } else {
                // Nuevo: al contenedor destino (una sección va siempre a la raíz).
                const target = w.type === 'section' ? ROOT : addTarget
                layout = withItems(prev.layout, target, [...itemsOf(prev.layout, target), w])
            }
            return { ...prev, layout }
        })
        setDirty(true)
        setEditorOpen(false)
        setEditingWidget(null)
        setAddTarget(ROOT)
    }, [addTarget])

    const handleDeleteWidget = useCallback((id: string) => {
        setReport(prev => {
            const container = findContainerId(prev.layout, id)
            if (!container) return prev
            return { ...prev, layout: withItems(prev.layout, container, itemsOf(prev.layout, container).filter(w => w.id !== id)) }
        })
        setDirty(true)
    }, [])

    const handleDuplicateWidget = useCallback((w: BiWidget) => {
        setReport(prev => {
            const container = findContainerId(prev.layout, w.id)
            if (!container) return prev
            const items = itemsOf(prev.layout, container)
            const idx = items.findIndex(x => x.id === w.id)
            const copy: BiWidget = {
                ...w,
                id: genId(),
                title: `${w.title} (copia)`,
                children: w.children?.map(c => ({ ...c, id: genId() })),
            }
            const next = [...items]
            next.splice(idx + 1, 0, copy)
            return { ...prev, layout: withItems(prev.layout, container, next) }
        })
        setDirty(true)
    }, [])

    // Colapsar/expandir una sección (persistente).
    const handleToggleCollapse = useCallback((id: string) => {
        setReport(prev => ({
            ...prev,
            layout: prev.layout.map(w =>
                w.id === id && w.type === 'section'
                    ? { ...w, config: { ...w.config, collapsed: !w.config.collapsed } }
                    : w
            ),
        }))
        setDirty(true)
    }, [])

    // Abrir el editor apuntando a un contenedor destino (raíz o sección).
    const handleAddWidget = useCallback((target: string) => {
        setAddTarget(target)
        setEditingWidget(null)
        setEditorOpen(true)
    }, [])

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveId(String(event.active.id))
    }, [])

    // Mueve un widget entre contenedores (sección↔sección, sección↔raíz) en vivo.
    const handleDragOver = useCallback((event: DragOverEvent) => {
        const { active, over } = event
        if (!over) return
        const activeId = String(active.id)
        const overId = String(over.id)
        setReport(prev => {
            const from = findContainerId(prev.layout, activeId)
            const to = resolveOverContainer(prev.layout, overId)
            if (!from || !to || from === to) return prev
            const moving = itemsOf(prev.layout, from).find(w => w.id === activeId)
            if (!moving) return prev
            // No se permiten secciones anidadas: una sección sólo vive en la raíz.
            if (moving.type === 'section' && to !== ROOT) return prev
            let layout = withItems(prev.layout, from, itemsOf(prev.layout, from).filter(w => w.id !== activeId))
            const overItems = itemsOf(layout, to)
            const overIdx = overItems.findIndex(w => w.id === overId)
            const insertIdx = overIdx >= 0 ? overIdx : overItems.length
            layout = withItems(layout, to, [...overItems.slice(0, insertIdx), moving, ...overItems.slice(insertIdx)])
            return { ...prev, layout }
        })
    }, [])

    // Reordena dentro del mismo contenedor (el cruce ya lo resolvió onDragOver).
    const handleDragEnd = useCallback((event: DragEndEvent) => {
        setActiveId(null)
        const { active, over } = event
        if (!over || active.id === over.id) return
        setReport(prev => {
            const container = findContainerId(prev.layout, String(active.id))
            const overContainer = resolveOverContainer(prev.layout, String(over.id))
            if (!container || container !== overContainer) return prev
            const items = itemsOf(prev.layout, container)
            const oldIndex = items.findIndex(w => w.id === active.id)
            const newIndex = items.findIndex(w => w.id === over.id)
            if (oldIndex < 0 || newIndex < 0) return prev
            return { ...prev, layout: withItems(prev.layout, container, arrayMove(items, oldIndex, newIndex)) }
        })
        setDirty(true)
    }, [])

    // Drill-down: clic en una barra/segmento filtra todo el reporte por ese valor
    const handleDrill = useCallback((dimension: string, value: string) => {
        setFilters(prev => {
            const next = { ...prev }
            if (next[dimension] === value) delete next[dimension] // toggle off
            else next[dimension] = value
            return next
        })
    }, [])

    // Slicer: setea (o limpia) un filtro de dimensión sobre todo el reporte
    const handleSetFilter = useCallback((dimension: string, value: string | null) => {
        setFilters(prev => {
            const next = { ...prev }
            if (value === null || value === '') delete next[dimension]
            else next[dimension] = value
            return next
        })
    }, [])

    // Slicer de rango: actualiza fechas globales
    const handleSetDateRange = useCallback((from: string, to: string) => {
        setFilters(prev => ({ ...prev, date_from: from, date_to: to }))
    }, [])

    // Reasignar el cliente fijo del informe (solo en modo edición)
    const handleAssignCliente = useCallback((id: string) => {
        setReport(prev => ({ ...prev, cliente_id: id || null }))
        setDirty(true)
    }, [])

    async function handleSaveReport() {
        setSaving(true)
        try {
            await fetch(`/api/report-utm/bi/reports/${report.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layout: report.layout, cliente_id: report.cliente_id ?? null }),
            })
            setSaved(true)
            setDirty(false)
            setTimeout(() => setSaved(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    /** Convierte este informe en una plantilla reutilizable (sin cliente ni fechas). */
    async function handleSaveAsTemplate() {
        const nombre = window.prompt('Nombre de la plantilla:', `${report.nombre} (plantilla)`)
        if (!nombre?.trim()) return
        setSavingTemplate(true)
        try {
            const res = await fetch('/api/report-utm/bi/reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: nombre.trim(),
                    descripcion: report.descripcion ?? null,
                    source_report_id: report.id,
                    is_template: true,
                    cliente_id: null,
                }),
            })
            if (!res.ok) {
                const json = await res.json().catch(() => ({}))
                window.alert(json?.error ?? 'No se pudo crear la plantilla.')
                return
            }
            setTemplateSaved(true)
            setTimeout(() => setTemplateSaved(false), 2500)
        } finally {
            setSavingTemplate(false)
        }
    }

    async function handleExportPdf() {
        setExporting(true)
        // Expande todas las secciones para que el PDF capture su contenido.
        const hadCollapsed = report.layout.some(w => w.type === 'section' && w.config.collapsed)
        if (hadCollapsed) {
            setForceExpandAll(true)
            // Espera dos frames a que el DOM refleje las secciones expandidas.
            await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        }
        try {
            await exportReportPdf('bi-canvas-grid', report.nombre)
        } finally {
            setForceExpandAll(false)
            setExporting(false)
        }
    }

    async function handleSaveCalcFields(fields: CalculatedField[]) {
        setReport(prev => ({ ...prev, calculated_fields: fields }))
        await fetch(`/api/report-utm/bi/reports/${report.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calculated_fields: fields }),
        })
        setCalcOpen(false)
    }

    // Guarda el filtro avanzado (Y de O) dentro de report.filters['__adv'].
    async function handleSaveAdvancedFilter() {
        setSavingAdv(true)
        try {
            const nextFilters = { ...(report.filters ?? {}), [ADVANCED_FILTER_KEY]: serializeAdvancedFilter(advancedFilter) }
            setReport(prev => ({ ...prev, filters: nextFilters }))
            await fetch(`/api/report-utm/bi/reports/${report.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filters: nextFilters }),
            })
            setAdvSaved(true)
            setTimeout(() => setAdvSaved(false), 2000)
        } finally {
            setSavingAdv(false)
        }
    }

    // Filtros que reciben los widgets: los planos + el filtro avanzado serializado.
    const widgetFilters: BiFilters = {
        ...filters,
        [ADVANCED_FILTER_KEY]: advancedFilterHasConditions(advancedFilter)
            ? serializeAdvancedFilter(advancedFilter)
            : undefined,
    }

    const activeDrills = Object.entries(filters).filter(
        ([k, v]) => v && (k.startsWith('utm_') || k === 'ip_country' || k === 'form_name' || k === 'form_plugin' || k === 'attribution_method' || k === 'platform' || isFieldDim(k))
    )
    const drillLabel = (k: string) => fieldDimLabel(k) ?? k.replace('utm_', '')

    // El gasto (metricas_diarias) no se puede atribuir a filtros de país/formulario/
    // campo/plataforma → bajo esos filtros el gasto y sus ratios se muestran en 0.
    const spendNotAttributable = hasNonAttributableFilter(filters, advancedFilter)

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="flex items-center gap-1.5 text-2xl font-bold tracking-tight text-foreground">
                        {report.nombre}
                        {!readonly && (
                            <HelpTip
                                size={16}
                                text="PDF: descarga el informe. Compartir: genera un link público de solo lectura. Editar: activa el modo edición para agregar, mover y configurar widgets."
                            />
                        )}
                    </h1>
                    {report.descripcion && (
                        <p className="mt-0.5 text-sm text-muted-foreground">{report.descripcion}</p>
                    )}
                </div>
                {!readonly && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleExportPdf}
                            disabled={exporting}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                        >
                            <FileDown className="h-3.5 w-3.5" />
                            {exporting ? 'Generando…' : 'PDF'}
                        </button>
                        <button
                            onClick={() => setShareOpen(true)}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                        >
                            <Share2 className="h-3.5 w-3.5" />
                            Compartir
                        </button>
                        <button
                            onClick={() => setScheduleOpen(true)}
                            title="Programar envío automático"
                            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors relative"
                        >
                            <Clock className="h-3.5 w-3.5" />
                            Programar
                            {report.schedule?.enabled && (
                                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-card" />
                            )}
                        </button>
                        {editMode ? (
                            <>
                                <button
                                    onClick={() => handleAddWidget(ROOT)}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Widget
                                </button>
                                <button
                                    onClick={() => setCalcOpen(true)}
                                    title="Campos calculados"
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                                >
                                    <Calculator className="h-3.5 w-3.5" />
                                    Campos
                                </button>
                                <button
                                    onClick={handleSaveAsTemplate}
                                    disabled={savingTemplate}
                                    title="Guardar este informe como plantilla reutilizable"
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                                >
                                    {templateSaved ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <LayoutTemplate className="h-3.5 w-3.5" />}
                                    {savingTemplate ? 'Creando…' : templateSaved ? 'Plantilla creada' : 'Plantilla'}
                                </button>
                                <button
                                    onClick={handleSaveReport}
                                    disabled={saving}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-white nav-active-emerald relative"
                                >
                                    {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                                    {saving ? 'Guardando…' : saved ? 'Guardado' : 'Guardar'}
                                    {dirty && !saving && !saved && (
                                        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-400 border-2 border-card" />
                                    )}
                                </button>
                                <button
                                    onClick={() => setEditMode(false)}
                                    className="p-2 rounded-xl text-xs font-medium bg-muted text-muted-foreground hover:bg-accent transition-colors"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => setEditMode(true)}
                                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                                Editar
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Hint de modo edición */}
            {editMode && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center gap-2 flex-wrap">
                    <Pencil className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                        <strong>Modo edición:</strong> pasa el cursor sobre un widget para editarlo, duplicarlo o eliminarlo.
                        Arrástralo desde el ícono <span className="font-mono">⠿</span> para reordenar. No olvides <strong>Guardar</strong> al terminar.
                    </span>
                </div>
            )}

            {/* Global filters */}
            <BiGlobalFilters
                initialFilters={filters}
                onChange={(f) => setFilters(f)}
                datesLocked={!!lockedDates}
                clienteLocked={readonly || (!editMode && !!report.cliente_id)}
                onClienteChange={editMode ? handleAssignCliente : undefined}
                advancedFilter={advancedFilter}
                onAdvancedChange={setAdvancedFilter}
                onAdvancedSave={handleSaveAdvancedFilter}
                savingAdvanced={savingAdv}
                advancedSaved={advSaved}
                readonly={readonly}
            />

            {/* Drill-down chips */}
            {activeDrills.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Filtrando por:
                        <HelpTip text="Haz clic en una barra o porción de un gráfico para filtrar todo el informe por ese valor (drill-down). Haz clic de nuevo en el chip para quitar el filtro." />
                    </span>
                    {activeDrills.map(([k, v]) => (
                        <button
                            key={k}
                            onClick={() => handleDrill(k, v as string)}
                            className="flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium hover:bg-emerald-500/25 transition-colors"
                        >
                            {drillLabel(k)}: {v}
                            <X className="h-3 w-3" />
                        </button>
                    ))}
                </div>
            )}

            {/* Aviso: gasto no atribuible al filtro activo */}
            {spendNotAttributable && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                        El gasto de anuncios no puede atribuirse a filtros de país, formulario o campo del lead,
                        por lo que el gasto y sus métricas derivadas (CPL, CPA, ROAS) se muestran en 0 mientras
                        este filtro esté activo. Los leads y ventas sí quedan filtrados.
                    </span>
                </div>
            )}

            {/* Canvas grid */}
            {report.layout.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-16 text-center">
                    <p className="text-sm font-medium text-foreground mb-1">Canvas vacío</p>
                    <p className="text-xs text-muted-foreground mb-4">Activa el modo edición y agrega widgets.</p>
                    {!readonly && (
                        <button
                            onClick={() => { setEditMode(true); handleAddWidget(ROOT) }}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Agregar primer widget
                        </button>
                    )}
                </div>
            ) : (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    onDragCancel={() => setActiveId(null)}
                >
                    <SortableContext items={report.layout.map(w => w.id)} strategy={rectSortingStrategy}>
                        <RootDroppable>
                            {report.layout.map(block =>
                                block.type === 'section' ? (
                                    <BiSectionContainer
                                        key={block.id}
                                        section={block}
                                        filters={widgetFilters}
                                        editMode={editMode}
                                        forceExpand={forceExpandAll}
                                        calculatedFields={report.calculated_fields ?? []}
                                        onEditSection={s => { setEditingWidget(s); setEditorOpen(true) }}
                                        onDeleteSection={handleDeleteWidget}
                                        onDuplicateSection={handleDuplicateWidget}
                                        onToggleCollapse={handleToggleCollapse}
                                        onAddWidget={handleAddWidget}
                                        onEditWidget={w => { setEditingWidget(w); setEditorOpen(true) }}
                                        onDeleteWidget={handleDeleteWidget}
                                        onDuplicateWidget={handleDuplicateWidget}
                                        onDrill={handleDrill}
                                        onSetFilter={handleSetFilter}
                                        onSetDateRange={handleSetDateRange}
                                    />
                                ) : (
                                    <BiWidgetCard
                                        key={block.id}
                                        widget={block}
                                        filters={widgetFilters}
                                        editMode={editMode}
                                        calculatedFields={report.calculated_fields ?? []}
                                        onEdit={w => { setEditingWidget(w); setEditorOpen(true) }}
                                        onDelete={handleDeleteWidget}
                                        onDuplicate={handleDuplicateWidget}
                                        onDrill={handleDrill}
                                        onSetFilter={handleSetFilter}
                                        onSetDateRange={handleSetDateRange}
                                    />
                                )
                            )}
                        </RootDroppable>
                    </SortableContext>
                    <DragOverlay>
                        {activeId ? (
                            <div className="rounded-2xl border border-emerald-500/50 bg-card px-4 py-3 shadow-xl text-sm font-medium text-foreground">
                                {findWidget(report.layout, activeId)?.title || 'Bloque'}
                            </div>
                        ) : null}
                    </DragOverlay>
                </DndContext>
            )}

            {/* Widget editor modal */}
            {editorOpen && (
                <BiWidgetEditor
                    widget={editingWidget}
                    calculatedFields={report.calculated_fields ?? []}
                    clienteId={filters.cliente_id}
                    dateFrom={filters.date_from}
                    dateTo={filters.date_to}
                    allowSection={addTarget === ROOT}
                    onSave={handleSaveWidget}
                    onClose={() => { setEditorOpen(false); setEditingWidget(null); setAddTarget(ROOT) }}
                />
            )}

            {/* Share modal */}
            {shareOpen && (
                <BiShareModal
                    reportId={report.id}
                    initialToken={report.public_token ?? null}
                    onClose={() => setShareOpen(false)}
                />
            )}

            {/* Schedule modal */}
            {scheduleOpen && (
                <BiScheduleModal
                    reportId={report.id}
                    initial={report.schedule}
                    onSaved={(schedule: BiSchedule) => setReport(prev => ({ ...prev, schedule }))}
                    onClose={() => setScheduleOpen(false)}
                />
            )}

            {/* Calculated fields manager */}
            {calcOpen && (
                <BiCalcFieldsModal
                    fields={report.calculated_fields ?? []}
                    clienteId={filters.cliente_id}
                    dateFrom={filters.date_from}
                    dateTo={filters.date_to}
                    onSave={handleSaveCalcFields}
                    onClose={() => setCalcOpen(false)}
                />
            )}
        </div>
    )
}
