'use client'

import { useState, useEffect } from 'react'
import { Filter, RefreshCw, Tag, ChevronDown, X, Lock } from 'lucide-react'
import type { BiFilters } from './BiTypes'
import { UTM_FILTER_KEYS, UTM_FILTER_LABELS, FILTER_OPS, parseFilterValue, encodeFilterValue } from '@/lib/report-utm/bi-metadata'
import type { FilterOp } from '@/lib/report-utm/bi-metadata'
import { HelpTip } from './HelpTip'

interface Cliente {
    id: string
    nombre: string
}

interface Props {
    initialFilters: BiFilters
    onChange: (filters: BiFilters) => void
    /** Si true, el selector de cliente queda bloqueado (no editable por el lector). */
    clienteLocked?: boolean
    /** Notifica cuando se cambia el cliente (solo en modo edición) para reasignar el informe. */
    onClienteChange?: (id: string) => void
}

function toISODate(d: Date): string {
    return d.toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
    return toISODate(new Date(Date.now() - n * 86400_000))
}

const PRESETS = [
    { label: '7d',  days: 7 },
    { label: '14d', days: 14 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
]

export function BiGlobalFilters({ initialFilters, onChange, clienteLocked, onClienteChange }: Props) {
    const [clientes, setClientes] = useState<Cliente[]>([])
    const [clienteId, setClienteId] = useState(initialFilters.cliente_id ?? '')
    const [dateFrom, setDateFrom]   = useState(initialFilters.date_from ?? daysAgo(30))
    const [dateTo, setDateTo]       = useState(initialFilters.date_to ?? toISODate(new Date()))
    const [activePreset, setActivePreset] = useState<number | null>(30)

    // Filtros UTM como variables globales del reporte (valor + operador)
    const [utm, setUtm] = useState<Record<string, string>>(() => {
        const init: Record<string, string> = {}
        for (const k of UTM_FILTER_KEYS) if (initialFilters[k]) init[k] = parseFilterValue(initialFilters[k] as string).value
        return init
    })
    const [utmOps, setUtmOps] = useState<Record<string, FilterOp>>(() => {
        const init: Record<string, FilterOp> = {}
        for (const k of UTM_FILTER_KEYS) if (initialFilters[k]) init[k] = parseFilterValue(initialFilters[k] as string).op
        return init
    })
    const [showUtm, setShowUtm] = useState(() => Object.keys(
        UTM_FILTER_KEYS.reduce((acc, k) => initialFilters[k] ? { ...acc, [k]: true } : acc, {})
    ).length > 0)

    const activeUtmCount = Object.values(utm).filter(v => v && v.trim()).length

    useEffect(() => {
        fetch('/api/report-utm/clientes')
            .then(r => r.json())
            .then(json => setClientes(json.data ?? []))
            .catch(() => {})
    }, [])

    function buildFilters(): BiFilters {
        const f: BiFilters = {
            cliente_id: clienteId || undefined,
            date_from:  dateFrom,
            date_to:    dateTo,
        }
        for (const k of UTM_FILTER_KEYS) {
            const v = utm[k]
            if (v && v.trim()) f[k] = encodeFilterValue(utmOps[k] ?? 'eq', v.trim())
        }
        return f
    }

    function applyPreset(days: number) {
        const from = daysAgo(days)
        const to   = toISODate(new Date())
        setDateFrom(from)
        setDateTo(to)
        setActivePreset(days)
        onChange({ ...buildFilters(), date_from: from, date_to: to })
    }

    function handleApply() {
        setActivePreset(null)
        onChange(buildFilters())
    }

    function setUtmValue(key: string, value: string) {
        setUtm(prev => ({ ...prev, [key]: value }))
    }

    function setUtmOp(key: string, op: FilterOp) {
        setUtmOps(prev => ({ ...prev, [key]: op }))
    }

    function clearUtm() {
        setUtm({})
        setUtmOps({})
    }

    return (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Filtros globales</span>
                <HelpTip text="Estos filtros afectan a TODOS los widgets del informe a la vez. Elige cliente y rango de fechas, o usa los atajos 7d/14d/30d/90d. Pulsa Aplicar para refrescar." />
                <div className="flex-1" />
                <div className="flex gap-1">
                    {PRESETS.map(p => (
                        <button
                            key={p.days}
                            onClick={() => applyPreset(p.days)}
                            className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                                activePreset === p.days
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                            }`}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                    <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1">
                        Cliente
                        {clienteLocked && <Lock className="h-2.5 w-2.5 text-emerald-500" />}
                    </label>
                    {clienteLocked ? (
                        <div className="w-full px-3 py-2 text-xs rounded-lg bg-muted/60 border border-border text-foreground flex items-center gap-1.5 cursor-not-allowed">
                            <Lock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="truncate">{clientes.find(c => c.id === clienteId)?.nombre ?? (clienteId ? 'Cliente fijo' : 'Todos')}</span>
                        </div>
                    ) : (
                        <select
                            value={clienteId}
                            onChange={e => {
                                const val = e.target.value
                                setClienteId(val)
                                onClienteChange?.(val)
                                // aplicar de inmediato (incluye el resto de filtros vigentes)
                                onChange({ ...buildFilters(), cliente_id: val || undefined })
                            }}
                            className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        >
                            <option value="">Todos</option>
                            {clientes.map(c => (
                                <option key={c.id} value={c.id}>{c.nombre}</option>
                            ))}
                        </select>
                    )}
                    {!clienteLocked && onClienteChange && (
                        <p className="text-[9px] text-emerald-600 dark:text-emerald-400 mt-1">Queda fijo al informe</p>
                    )}
                </div>

                <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Desde</label>
                    <input
                        type="date"
                        value={dateFrom}
                        max={dateTo || undefined}
                        onChange={e => {
                            const val = e.target.value
                            if (!val) return
                            setDateFrom(val)
                            setActivePreset(null)
                            onChange({ ...buildFilters(), date_from: val })
                        }}
                        className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                </div>

                <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Hasta</label>
                    <input
                        type="date"
                        value={dateTo}
                        min={dateFrom || undefined}
                        onChange={e => {
                            const val = e.target.value
                            if (!val) return
                            setDateTo(val)
                            setActivePreset(null)
                            onChange({ ...buildFilters(), date_to: val })
                        }}
                        className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                </div>

                <div className="flex items-end">
                    <button
                        onClick={handleApply}
                        className="flex items-center gap-1.5 w-full px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald justify-center"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Aplicar
                    </button>
                </div>
            </div>

            {/* Toggle filtros UTM (variables) */}
            <div className="border-t border-border pt-3">
                <button
                    onClick={() => setShowUtm(v => !v)}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                    <Tag className="h-3.5 w-3.5" />
                    Variables UTM
                    <HelpTip text="Recorta todo el informe por valores UTM. Elige el operador: = igual, ≠ distinto, ∋ contiene, ∌ no contiene, ⊢ empieza, ⊣ termina. Ej: Campaña ∋ 'verano' deja solo campañas que contienen esa palabra. En = puedes poner varios valores separados por coma." />
                    {activeUtmCount > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-semibold">
                            {activeUtmCount}
                        </span>
                    )}
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showUtm ? 'rotate-180' : ''}`} />
                </button>

                {showUtm && (
                    <div className="mt-3 space-y-3">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                            {UTM_FILTER_KEYS.map(key => (
                                <div key={key}>
                                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                                        {UTM_FILTER_LABELS[key]}
                                    </label>
                                    <div className="flex gap-1">
                                        <select
                                            value={utmOps[key] ?? 'eq'}
                                            onChange={e => setUtmOp(key, e.target.value as FilterOp)}
                                            title="Operador"
                                            className="px-1 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                        >
                                            {FILTER_OPS.map(o => (
                                                <option key={o.value} value={o.value} title={o.label}>{o.short}</option>
                                            ))}
                                        </select>
                                        <input
                                            type="text"
                                            value={utm[key] ?? ''}
                                            onChange={e => setUtmValue(key, e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && handleApply()}
                                            placeholder="cualquiera"
                                            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleApply}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald"
                            >
                                <RefreshCw className="h-3 w-3" />
                                Aplicar variables
                            </button>
                            {activeUtmCount > 0 && (
                                <button
                                    onClick={() => { clearUtm(); onChange({ cliente_id: clienteId || undefined, date_from: dateFrom, date_to: dateTo }) }}
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:bg-accent transition-colors"
                                >
                                    <X className="h-3 w-3" />
                                    Limpiar
                                </button>
                            )}
                            <p className="text-[10px] text-muted-foreground ml-auto">
                                Recorta todos los widgets. Elige el operador a la izquierda de cada campo.
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
