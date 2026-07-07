'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Pencil, Trash2, GripVertical, Copy, Plus } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { BiWidget, BiFilters, CalculatedField } from './BiTypes'
import { BiWidgetCard } from './BiWidgetCard'

// Prefijo de los ids droppable de contenedor (compartido con BiReportCanvas).
export const CONTAINER_PREFIX = 'container:'

const SECTION_GRID: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
}

interface Props {
    section: BiWidget
    filters: BiFilters
    editMode?: boolean
    forceExpand?: boolean
    calculatedFields?: CalculatedField[]
    onEditSection?: (section: BiWidget) => void
    onDeleteSection?: (id: string) => void
    onDuplicateSection?: (section: BiWidget) => void
    onToggleCollapse?: (id: string) => void
    onAddWidget?: (sectionId: string) => void
    // Callbacks de los widgets hijos (idénticos a los del canvas)
    onEditWidget?: (widget: BiWidget) => void
    onDeleteWidget?: (id: string) => void
    onDuplicateWidget?: (widget: BiWidget) => void
    onDrill?: (dimension: string, value: string) => void
    onSetFilter?: (dimension: string, value: string | null) => void
    onSetDateRange?: (from: string, to: string) => void
}

export function BiSectionContainer({
    section, filters, editMode, forceExpand, calculatedFields,
    onEditSection, onDeleteSection, onDuplicateSection, onToggleCollapse, onAddWidget,
    onEditWidget, onDeleteWidget, onDuplicateWidget, onDrill, onSetFilter, onSetDateRange,
}: Props) {
    const [confirming, setConfirming] = useState(false)
    const collapsed = !!section.config.collapsed && !forceExpand
    const columns = section.config.columns ?? 4
    const accent = section.config.accent
    const children = section.children ?? []

    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: section.id, disabled: !editMode })

    // Zona droppable interna: recibe widgets arrastrados desde otras secciones/raíz.
    const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${CONTAINER_PREFIX}${section.id}` })

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
            className={`col-span-1 sm:col-span-2 lg:col-span-4 relative group/section rounded-2xl border border-border bg-muted/20 ${
                isDragging ? 'ring-2 ring-emerald-500/50' : ''
            }`}
        >
            {/* Cabecera de la sección */}
            <div
                className="flex items-center gap-2 px-4 py-3 border-b border-border rounded-t-2xl"
                style={accent ? { borderLeft: `4px solid ${accent}` } : undefined}
            >
                <button
                    onClick={() => onToggleCollapse?.(section.id)}
                    className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title={collapsed ? 'Expandir' : 'Colapsar'}
                >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <h3 className="flex-1 text-sm font-semibold text-foreground truncate" style={accent ? { color: accent } : undefined}>
                    {section.title}
                </h3>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                    {children.length} {children.length === 1 ? 'widget' : 'widgets'}
                </span>

                {editMode && (
                    <div className="flex items-center gap-1 opacity-0 group-hover/section:opacity-100 transition-opacity">
                        <button
                            onClick={() => onAddWidget?.(section.id)}
                            title="Agregar widget a esta sección"
                            className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-emerald-600 hover:bg-accent transition-colors shadow-sm"
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                            onClick={() => onEditSection?.(section)}
                            title="Editar sección"
                            className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                            onClick={() => onDuplicateSection?.(section)}
                            title="Duplicar sección"
                            className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
                        >
                            <Copy className="h-3.5 w-3.5" />
                        </button>
                        {!confirming ? (
                            <button
                                onClick={() => setConfirming(true)}
                                title="Eliminar sección"
                                className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shadow-sm"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        ) : (
                            <button
                                onClick={() => { onDeleteSection?.(section.id); setConfirming(false) }}
                                className="px-2 py-1 rounded-lg bg-red-500 text-white text-[10px] font-medium shadow-sm"
                            >
                                Eliminar sección
                            </button>
                        )}
                        <button
                            {...attributes}
                            {...listeners}
                            title="Arrastrar sección"
                            className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing shadow-sm touch-none"
                        >
                            <GripVertical className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
            </div>

            {/* Cuerpo: grid interno de widgets */}
            {!collapsed && (
                <div
                    ref={setDropRef}
                    className={`p-4 ${isOver && editMode ? 'bg-emerald-500/5 rounded-b-2xl' : ''}`}
                >
                    {children.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                            {editMode ? 'Sección vacía · usa + para agregar un widget o arrastra uno aquí' : 'Sección vacía'}
                        </div>
                    ) : (
                        <SortableContext items={children.map(c => c.id)} strategy={rectSortingStrategy}>
                            <div className={`grid ${SECTION_GRID[columns] ?? SECTION_GRID[4]} gap-4 auto-rows-[minmax(0,auto)]`}>
                                {children.map(child => (
                                    <BiWidgetCard
                                        key={child.id}
                                        widget={child}
                                        filters={filters}
                                        editMode={editMode}
                                        calculatedFields={calculatedFields}
                                        onEdit={onEditWidget}
                                        onDelete={onDeleteWidget}
                                        onDuplicate={onDuplicateWidget}
                                        onDrill={onDrill}
                                        onSetFilter={onSetFilter}
                                        onSetDateRange={onSetDateRange}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    )}
                </div>
            )}
        </div>
    )
}
