'use client'

// Input de expresión con buscador de métricas.
//
// Escribir una fórmula obligaba a saberse de memoria la clave interna de cada
// métrica (`hotmart_revenue`, `initiates_checkout`…), que no se parece a la
// etiqueta que ve el usuario. Este componente añade un buscador que inserta la
// clave en la posición del cursor, igual que el editor de layouts del dashboard.

import { useRef, useState } from 'react'
import { Search, Plus, X } from 'lucide-react'
import { METRIC_META, humanizeFieldKey, fieldMetricAlias } from '@/lib/report-utm/bi-metadata'
import type { BiMetric, FormFieldMeta } from '@/lib/report-utm/bi-metadata'

interface Props {
    value: string
    onChange: (v: string) => void
    /** Campos de formulario del cliente, para ofrecer sus alias f_sum__/f_avg__. */
    formFields?: FormFieldMeta[]
    placeholder?: string
}

interface MetricOption { key: string; label: string }

/** Agrupa el catálogo por origen, para que la lista sea navegable. */
function buildGroups(formFields: FormFieldMeta[]): { title: string; items: MetricOption[] }[] {
    const of = (keys: string[]): MetricOption[] =>
        keys.filter(k => METRIC_META[k as BiMetric])
            .map(k => ({ key: k, label: METRIC_META[k as BiMetric].label }))

    const nucleo = of([
        'leads_count', 'sales_count', 'revenue', 'spend', 'meta_spend', 'tiktok_spend',
        'clicks', 'impressions', 'cpl', 'cpa', 'roas', 'conversion_rate', 'cpc', 'cpm',
    ])
    const hotmart = of([
        'hotmart_revenue', 'hotmart_sales', 'hotmart_roas', 'hotmart_cpa', 'hotmart_roi',
        'hotmart_pagos_iniciados', 'ventas_principal', 'ventas_bump', 'ventas_upsell',
        'ventas_principal_count', 'ventas_bump_count', 'ventas_upsell_count',
        'ventas_principal_bruto', 'ventas_bump_bruto', 'ventas_upsell_bruto', 'ventas_cerradas',
    ])
    const ga = of(['ga_sessions', 'ga_bounce_rate', 'ga_avg_session_duration'])
    const offline = of(['offline_leads', 'offline_ventas', 'offline_revenue', 'offline_total'])
    const subs = of(['subs_active', 'subs_delayed', 'subs_canceled', 'subs_total', 'subs_mrr'])

    // El resto (métricas de campaña de Meta y TikTok) se agrupa por descarte.
    const used = new Set([...nucleo, ...hotmart, ...ga, ...offline, ...subs].map(m => m.key))
    const campana = (Object.keys(METRIC_META) as BiMetric[])
        .filter(k => !used.has(k))
        .map(k => ({ key: k, label: METRIC_META[k].label }))

    const campos: MetricOption[] = formFields
        .filter(f => f.type === 'number')
        .flatMap(f => ([
            { key: fieldMetricAlias('sum', f.key), label: `Suma de ${humanizeFieldKey(f.label)}` },
            { key: fieldMetricAlias('avg', f.key), label: `Promedio de ${humanizeFieldKey(f.label)}` },
        ]))
        .filter(o => !!o.key) as MetricOption[]

    return [
        { title: 'Núcleo', items: nucleo },
        { title: 'Campaña (Meta / TikTok)', items: campana },
        { title: 'Hotmart', items: hotmart },
        { title: 'Google Analytics', items: ga },
        { title: 'Offline', items: offline },
        { title: 'Suscripciones', items: subs },
        { title: 'Campos del formulario', items: campos },
    ].filter(g => g.items.length > 0)
}

export function BiFormulaInput({ value, onChange, formFields = [], placeholder }: Props) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [open, setOpen] = useState(false)
    const [search, setSearch] = useState('')

    const groups = buildGroups(formFields)
    const q = search.trim().toLowerCase()
    const filtered = q
        ? groups
            .map(g => ({ ...g, items: g.items.filter(i => i.label.toLowerCase().includes(q) || i.key.includes(q)) }))
            .filter(g => g.items.length > 0)
        : groups

    /** Inserta la clave donde está el cursor (o al final si el input perdió el foco). */
    function insert(key: string) {
        const el = inputRef.current
        const pos = el?.selectionStart ?? value.length
        const before = value.slice(0, pos)
        const after = value.slice(pos)
        // Espacio de cortesía si se pega justo después de un operador o texto.
        const sep = before && !/[\s(+\-*/]$/.test(before) ? ' ' : ''
        const next = `${before}${sep}${key}${after}`
        onChange(next)
        setOpen(false)
        setSearch('')
        requestAnimationFrame(() => {
            el?.focus()
            const caret = before.length + sep.length + key.length
            el?.setSelectionRange(caret, caret)
        })
    }

    return (
        <div className="relative">
            <div className="flex items-center gap-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder ?? 'revenue / sales_count'}
                    className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    title="Insertar métrica"
                    className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
                        open
                            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : 'border-border bg-muted text-muted-foreground hover:bg-accent'
                    }`}
                >
                    <Plus className="h-3 w-3" />
                    Métrica
                </button>
            </div>

            {open && (
                <div className="absolute z-20 mt-1 w-full rounded-xl border border-border bg-card shadow-xl overflow-hidden">
                    <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border">
                        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <input
                            autoFocus
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Buscar métrica…"
                            className="flex-1 bg-transparent text-xs text-foreground focus:outline-none"
                        />
                        <button
                            type="button"
                            onClick={() => { setOpen(false); setSearch('') }}
                            className="p-0.5 rounded text-muted-foreground hover:text-foreground"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                        {filtered.length === 0 ? (
                            <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">Sin coincidencias</p>
                        ) : filtered.map(g => (
                            <div key={g.title}>
                                <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40">
                                    {g.title}
                                </p>
                                {g.items.map(i => (
                                    <button
                                        key={i.key}
                                        type="button"
                                        onClick={() => insert(i.key)}
                                        className="w-full flex items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-accent transition-colors"
                                    >
                                        <span className="text-[11px] text-foreground truncate">{i.label}</span>
                                        <code className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 shrink-0">{i.key}</code>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
