'use client'

import { useState, useCallback } from 'react'
import { Plus, Save, Pencil, Check, X, FileDown, Share2, Calculator } from 'lucide-react'
import { BiShareModal } from './BiShareModal'
import { BiCalcFieldsModal } from './BiCalcFieldsModal'
import { HelpTip } from './HelpTip'
import type { CalculatedField } from './BiTypes'
import type { AdvancedFilter } from '@/lib/report-utm/bi-metadata'
import {
    isFieldDim, fieldDimLabel,
    ADVANCED_FILTER_KEY, parseAdvancedFilter, serializeAdvancedFilter, advancedFilterHasConditions,
} from '@/lib/report-utm/bi-metadata'
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core'
import {
    SortableContext,
    arrayMove,
    rectSortingStrategy,
} from '@dnd-kit/sortable'
import type { BiWidget, BiFilters, BiReport } from './BiTypes'
import { BiWidgetCard }   from './BiWidgetCard'
import { BiWidgetEditor } from './BiWidgetEditor'
import { BiGlobalFilters } from './BiGlobalFilters'
import { exportReportPdf } from './exportPdf'

interface Props {
    report: BiReport
    readonly?: boolean
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

export function BiReportCanvas({ report: initialReport, readonly }: Props) {
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
    const [saving, setSaving] = useState(false)
    const [saved,  setSaved]  = useState(false)
    const [dirty,  setDirty]  = useState(false)
    const [exporting, setExporting] = useState(false)
    const [shareOpen, setShareOpen] = useState(false)
    const [calcOpen, setCalcOpen]   = useState(false)

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
    )

    const handleSaveWidget = useCallback((w: BiWidget) => {
        setReport(prev => {
            const exists = prev.layout.find(x => x.id === w.id)
            const layout = exists
                ? prev.layout.map(x => x.id === w.id ? w : x)
                : [...prev.layout, w]
            return { ...prev, layout }
        })
        setDirty(true)
        setEditorOpen(false)
        setEditingWidget(null)
    }, [])

    const handleDeleteWidget = useCallback((id: string) => {
        setReport(prev => ({ ...prev, layout: prev.layout.filter(w => w.id !== id) }))
        setDirty(true)
    }, [])

    const handleDuplicateWidget = useCallback((w: BiWidget) => {
        setReport(prev => {
            const idx = prev.layout.findIndex(x => x.id === w.id)
            const copy: BiWidget = { ...w, id: genId(), title: `${w.title} (copia)` }
            const layout = [...prev.layout]
            layout.splice(idx + 1, 0, copy)
            return { ...prev, layout }
        })
        setDirty(true)
    }, [])

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        setReport(prev => {
            const oldIndex = prev.layout.findIndex(w => w.id === active.id)
            const newIndex = prev.layout.findIndex(w => w.id === over.id)
            if (oldIndex < 0 || newIndex < 0) return prev
            return { ...prev, layout: arrayMove(prev.layout, oldIndex, newIndex) }
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

    async function handleExportPdf() {
        setExporting(true)
        try {
            await exportReportPdf('bi-canvas-grid', report.nombre)
        } finally {
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
        ([k, v]) => v && (k.startsWith('utm_') || k === 'ip_country' || k === 'form_plugin' || k === 'attribution_method' || isFieldDim(k))
    )
    const drillLabel = (k: string) => fieldDimLabel(k) ?? k.replace('utm_', '')

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
                        {editMode ? (
                            <>
                                <button
                                    onClick={() => {
                                        setEditorOpen(true)
                                        setEditingWidget(null)
                                    }}
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

            {/* Canvas grid */}
            {report.layout.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-16 text-center">
                    <p className="text-sm font-medium text-foreground mb-1">Canvas vacío</p>
                    <p className="text-xs text-muted-foreground mb-4">Activa el modo edición y agrega widgets.</p>
                    {!readonly && (
                        <button
                            onClick={() => { setEditMode(true); setEditorOpen(true) }}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Agregar primer widget
                        </button>
                    )}
                </div>
            ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={report.layout.map(w => w.id)} strategy={rectSortingStrategy}>
                        <div id="bi-canvas-grid" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(0,auto)]">
                            {report.layout.map(widget => (
                                <BiWidgetCard
                                    key={widget.id}
                                    widget={widget}
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
                            ))}
                        </div>
                    </SortableContext>
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
                    onSave={handleSaveWidget}
                    onClose={() => { setEditorOpen(false); setEditingWidget(null) }}
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
