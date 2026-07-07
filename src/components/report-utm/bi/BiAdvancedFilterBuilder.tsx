'use client'

import { X, Plus } from 'lucide-react'
import type { AdvancedFilter, FilterCondition, FilterOp } from '@/lib/report-utm/bi-metadata'
import { FILTER_OPS } from '@/lib/report-utm/bi-metadata'

interface Props {
    /** Filtro avanzado controlado (grupos en Y, condiciones en O). */
    value: AdvancedFilter
    onChange: (af: AdvancedFilter) => void
    /** Opciones de campo (base + campos de formulario del cliente). */
    fieldOptions: { value: string; label: string }[]
}

/**
 * Constructor autónomo del árbol de filtro "Y de O" (grupos unidos por Y, cada
 * grupo con condiciones unidas por O). Mismo look & feel que el constructor de
 * los filtros del informe (BiGlobalFilters), pero reutilizable de forma aislada
 * (p. ej. para filtros a nivel de widget). No incluye "Guardar" ni "Limpiar":
 * el estado se persiste con quien lo contenga.
 */
export function BiAdvancedFilterBuilder({ value, onChange, fieldOptions }: Props) {
    const groups = value.groups ?? []
    const emit = (next: AdvancedFilter['groups']) => onChange({ groups: next })

    function addGroup() {
        emit([...groups, { conditions: [{ field: 'utm_source', op: 'eq', value: '' }] }])
    }
    function addCondition(gi: number) {
        emit(groups.map((g, i) => i === gi
            ? { conditions: [...g.conditions, { field: 'utm_source', op: 'eq', value: '' }] }
            : g))
    }
    function setCondition(gi: number, ci: number, patch: Partial<FilterCondition>) {
        emit(groups.map((g, i) => i === gi
            ? { conditions: g.conditions.map((c, j) => j === ci ? { ...c, ...patch } : c) }
            : g))
    }
    function removeCondition(gi: number, ci: number) {
        const next = groups
            .map((g, i) => i === gi ? { conditions: g.conditions.filter((_, j) => j !== ci) } : g)
            .filter(g => g.conditions.length > 0)
        emit(next)
    }
    function removeGroup(gi: number) {
        emit(groups.filter((_, i) => i !== gi))
    }

    return (
        <div className="space-y-2">
            {groups.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                    Sin condiciones. Agrega un grupo para empezar a filtrar este widget.
                </p>
            )}

            {groups.map((g, gi) => (
                <div key={gi}>
                    {gi > 0 && (
                        <div className="flex items-center gap-2 my-1.5">
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold tracking-wider">Y</span>
                            <div className="flex-1 h-px bg-border" />
                        </div>
                    )}
                    <div className="rounded-xl border border-border bg-muted/20 p-2.5 space-y-1.5">
                        {g.conditions.map((c, ci) => (
                            <div key={ci} className="flex items-center gap-1.5 flex-wrap">
                                {ci > 0 && (
                                    <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 w-4 text-center">O</span>
                                )}
                                {ci === 0 && <span className="w-4" />}
                                <select
                                    value={c.field}
                                    onChange={e => setCondition(gi, ci, { field: e.target.value })}
                                    className="px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 max-w-[150px]"
                                >
                                    {fieldOptions.map(o => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>
                                <select
                                    value={c.op}
                                    title="Operador"
                                    onChange={e => setCondition(gi, ci, { op: e.target.value as FilterOp })}
                                    className="px-1.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                >
                                    {FILTER_OPS.map(o => (
                                        <option key={o.value} value={o.value} title={o.label}>{o.short}</option>
                                    ))}
                                </select>
                                <input
                                    type="text"
                                    value={c.value}
                                    onChange={e => setCondition(gi, ci, { value: e.target.value })}
                                    placeholder="valor (coma = varios)"
                                    className="flex-1 min-w-[120px] px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                />
                                <button
                                    type="button"
                                    onClick={() => removeCondition(gi, ci)}
                                    title="Quitar condición"
                                    className="p-1 text-muted-foreground hover:text-red-500"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ))}
                        <div className="flex items-center gap-3 pl-5 pt-0.5">
                            <button
                                type="button"
                                onClick={() => addCondition(gi)}
                                className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                            >
                                <Plus className="h-3 w-3" /> Condición (O)
                            </button>
                            <button
                                type="button"
                                onClick={() => removeGroup(gi)}
                                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-red-500"
                            >
                                <X className="h-3 w-3" /> Eliminar grupo
                            </button>
                        </div>
                    </div>
                </div>
            ))}

            <div className="pt-1">
                <button
                    type="button"
                    onClick={addGroup}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                >
                    <Plus className="h-3 w-3" /> Agregar grupo (Y)
                </button>
            </div>
        </div>
    )
}
