'use client'

import { useState } from 'react'
import { Pencil, Trash2, GripVertical, Copy, Filter } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { BiWidget, BiFilters, CalculatedField } from './BiTypes'
import type { AdvancedFilter } from '@/lib/report-utm/bi-metadata'
import { advancedFilterHasConditions, FILTERABLE_BASE_DIMS, FILTER_OPS, fieldDimLabel } from '@/lib/report-utm/bi-metadata'
import { ScorecardWidget } from './widgets/ScorecardWidget'
import { ChartWidget }     from './widgets/ChartWidget'
import { TableWidget }     from './widgets/TableWidget'
import { FunnelWidget }    from './widgets/FunnelWidget'
import { SlicerWidget }    from './widgets/SlicerWidget'
import { TextWidget }      from './widgets/TextWidget'

interface Props {
    widget: BiWidget
    filters: BiFilters
    editMode?: boolean
    calculatedFields?: CalculatedField[]
    onEdit?: (widget: BiWidget) => void
    onDelete?: (id: string) => void
    onDuplicate?: (widget: BiWidget) => void
    onDrill?: (dimension: string, value: string) => void
    onSetFilter?: (dimension: string, value: string | null) => void
    onSetDateRange?: (from: string, to: string) => void
}

const COL_SPAN: Record<number, string> = {
    1: 'col-span-1',
    2: 'col-span-1 sm:col-span-2',
    3: 'col-span-1 sm:col-span-2 lg:col-span-3',
    4: 'col-span-1 sm:col-span-2 lg:col-span-4',
}

const ROW_SPAN: Record<number, string> = {
    1: 'row-span-1',
    2: 'row-span-2',
    3: 'row-span-3',
}

const FILTER_OP_SHORT: Record<string, string> = Object.fromEntries(FILTER_OPS.map(o => [o.value, o.short]))
const FILTER_FIELD_LABEL: Record<string, string> = Object.fromEntries(FILTERABLE_BASE_DIMS.map(o => [o.value, o.label]))

/** Descripción compacta del filtro de un widget para el tooltip del badge. */
function describeWidgetFilter(af: AdvancedFilter): string {
    return (af.groups ?? [])
        .map(g => (g.conditions ?? [])
            .filter(c => c.field && c.value && c.value.trim())
            .map(c => `${FILTER_FIELD_LABEL[c.field] ?? fieldDimLabel(c.field) ?? c.field} ${FILTER_OP_SHORT[c.op] ?? c.op} ${c.value}`)
            .join(' O '))
        .filter(s => s)
        .map(s => `(${s})`)
        .join(' Y ')
}

export function BiWidgetCard({ widget, filters, editMode, calculatedFields, onEdit, onDelete, onDuplicate, onDrill, onSetFilter, onSetDateRange }: Props) {
    const [confirming, setConfirming] = useState(false)
    const colSpan = COL_SPAN[widget.w ?? 2] ?? COL_SPAN[2]
    const rowSpan = (widget.h ?? 1) > 1 ? (ROW_SPAN[widget.h ?? 1] ?? '') : ''

    const widgetFilter = widget.config?.advanced_filter
    const hasWidgetFilter = advancedFilterHasConditions(widgetFilter)

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: widget.id, disabled: !editMode })

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 50 : undefined,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${colSpan} ${rowSpan} relative group ${isDragging ? 'ring-2 ring-emerald-500/50 rounded-2xl' : ''}`}
        >
            {/* Indicador de filtro propio del widget (visible siempre) */}
            {hasWidgetFilter && (
                <div
                    title={`Filtro del widget: ${describeWidgetFilter(widgetFilter!)}`}
                    className="absolute top-2 left-2 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[9px] font-semibold shadow-sm pointer-events-auto"
                >
                    <Filter className="h-2.5 w-2.5" />
                    Filtrado
                </div>
            )}

            {/* Edit controls overlay */}
            {editMode && (
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={() => onEdit?.(widget)}
                        title="Editar"
                        className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={() => onDuplicate?.(widget)}
                        title="Duplicar"
                        className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
                    >
                        <Copy className="h-3.5 w-3.5" />
                    </button>
                    {!confirming ? (
                        <button
                            onClick={() => setConfirming(true)}
                            title="Eliminar"
                            className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shadow-sm"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    ) : (
                        <button
                            onClick={() => { onDelete?.(widget.id); setConfirming(false) }}
                            className="px-2 py-1 rounded-lg bg-red-500 text-white text-[10px] font-medium shadow-sm"
                        >
                            Eliminar
                        </button>
                    )}
                    <button
                        {...attributes}
                        {...listeners}
                        title="Arrastrar para reordenar"
                        className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing shadow-sm touch-none"
                    >
                        <GripVertical className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            <WidgetRenderer widget={widget} filters={filters} calculatedFields={calculatedFields} onDrill={onDrill} onSetFilter={onSetFilter} onSetDateRange={onSetDateRange} />
        </div>
    )
}

function WidgetRenderer({
    widget,
    filters,
    calculatedFields,
    onDrill,
    onSetFilter,
    onSetDateRange,
}: {
    widget: BiWidget
    filters: BiFilters
    calculatedFields?: CalculatedField[]
    onDrill?: (dimension: string, value: string) => void
    onSetFilter?: (dimension: string, value: string | null) => void
    onSetDateRange?: (from: string, to: string) => void
}) {
    switch (widget.type) {
        case 'scorecard':
            return <ScorecardWidget title={widget.title} config={widget.config} filters={filters} calculatedFields={calculatedFields} />
        case 'line':
        case 'area':
        case 'bar':
        case 'combo':
        case 'pie':
        case 'scatter':
            return <ChartWidget title={widget.title} type={widget.type} config={widget.config} filters={filters} calculatedFields={calculatedFields} onDrill={onDrill} />
        case 'table':
            return <TableWidget title={widget.title} config={widget.config} filters={filters} calculatedFields={calculatedFields} h={widget.h} />
        case 'funnel':
            return <FunnelWidget title={widget.title} config={widget.config} filters={filters} />
        case 'slicer':
            return <SlicerWidget title={widget.title} config={widget.config} filters={filters} onSetFilter={onSetFilter} onSetDateRange={onSetDateRange} />
        case 'heading':
        case 'text':
            return <TextWidget type={widget.type} title={widget.title} config={widget.config} />
        default:
            return (
                <div className="rounded-2xl border border-border bg-muted p-5 text-xs text-muted-foreground">
                    Widget desconocido: {widget.type}
                </div>
            )
    }
}
