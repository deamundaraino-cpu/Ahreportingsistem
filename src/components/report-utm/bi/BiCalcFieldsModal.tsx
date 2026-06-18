'use client'

import { useState } from 'react'
import { X, Plus, Trash2, Calculator } from 'lucide-react'
import type { CalculatedField } from './BiTypes'
import { METRIC_META, evaluateExpression } from '@/lib/report-utm/bi-metadata'
import { HelpTip } from './HelpTip'

interface Props {
    fields: CalculatedField[]
    onSave: (fields: CalculatedField[]) => void
    onClose: () => void
}

function genId(): string {
    return Math.random().toString(36).slice(2, 10)
}

const BASE_METRICS = Object.keys(METRIC_META)

// Valores de ejemplo para previsualizar la fórmula
const SAMPLE: Record<string, number> = {
    leads_count: 100, sales_count: 12, revenue: 3600, spend: 900,
    clicks: 800, impressions: 40000, cpl: 9, cpa: 75, roas: 4, conversion_rate: 12, cpc: 1.12, cpm: 22.5,
}

export function BiCalcFieldsModal({ fields: initial, onSave, onClose }: Props) {
    const [fields, setFields] = useState<CalculatedField[]>(initial)
    const [name, setName] = useState('')
    const [expr, setExpr] = useState('')
    const [fmt, setFmt]   = useState<'number' | 'currency' | 'percent' | 'ratio'>('number')

    const preview = expr ? evaluateExpression(expr, SAMPLE) : null
    const validName = /^[a-z_][a-z0-9_]*$/i.test(name)
    const canAdd = validName && expr.trim() && preview !== null && !fields.some(f => f.name === name)

    function add() {
        if (!canAdd) return
        setFields(prev => [...prev, { id: genId(), name: name.trim(), expression: expr.trim(), format: fmt }])
        setName(''); setExpr(''); setFmt('number')
    }

    function remove(id: string) {
        setFields(prev => prev.filter(f => f.id !== id))
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Calculator className="h-4 w-4 text-emerald-500" />
                        <p className="text-sm font-semibold text-foreground">Campos calculados</p>
                        <HelpTip text="Crea tus propias métricas combinando las existentes con + - * / y paréntesis. Ej: 'revenue / sales_count' = ticket promedio. Luego las usas como columnas en las tablas (aparecen con ∑)." />
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                    {/* Lista existente */}
                    {fields.length > 0 && (
                        <div className="space-y-2">
                            {fields.map(f => (
                                <div key={f.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-muted/40 border border-border">
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold text-foreground truncate">{f.name}</p>
                                        <p className="text-[10px] font-mono text-muted-foreground truncate">{f.expression}</p>
                                    </div>
                                    <button onClick={() => remove(f.id)} className="p-1 rounded text-muted-foreground hover:text-red-500 transition-colors">
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Nuevo campo */}
                    <div className="rounded-xl border border-dashed border-border p-4 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Nombre (sin espacios)</label>
                                <input
                                    type="text" value={name} onChange={e => setName(e.target.value)}
                                    placeholder="ticket_promedio"
                                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Formato</label>
                                <select
                                    value={fmt} onChange={e => setFmt(e.target.value as typeof fmt)}
                                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                >
                                    <option value="number">Número</option>
                                    <option value="currency">Moneda</option>
                                    <option value="percent">Porcentaje</option>
                                    <option value="ratio">Ratio (x)</option>
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="block text-[10px] font-medium text-muted-foreground mb-1">Expresión</label>
                            <input
                                type="text" value={expr} onChange={e => setExpr(e.target.value)}
                                placeholder="revenue / sales_count"
                                className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                            />
                            <div className="flex items-center justify-between mt-1.5">
                                <p className="text-[10px] text-muted-foreground">
                                    Previsualización: {preview !== null ? <span className="font-mono text-emerald-600 dark:text-emerald-400">{preview}</span> : <span className="text-red-500">expresión inválida</span>}
                                </p>
                                <button
                                    onClick={add}
                                    disabled={!canAdd}
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald disabled:opacity-40"
                                >
                                    <Plus className="h-3 w-3" />
                                    Agregar
                                </button>
                            </div>
                        </div>
                        <details className="text-[10px] text-muted-foreground">
                            <summary className="cursor-pointer hover:text-foreground">Métricas disponibles</summary>
                            <p className="mt-1 font-mono leading-relaxed">{BASE_METRICS.join(', ')}</p>
                        </details>
                    </div>
                </div>

                <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors">
                        Cancelar
                    </button>
                    <button
                        onClick={() => onSave(fields)}
                        className="px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                    >
                        Guardar campos
                    </button>
                </div>
            </div>
        </div>
    )
}
