'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { BarChart2, PlusCircle, LayoutTemplate, Clock, ArrowRight, Lock, Search, X, ChevronDown } from 'lucide-react'
import { formatDate } from '@/lib/report-utm/formatters'
import { HelpTip } from '@/components/report-utm/bi/HelpTip'
import { ReportActions } from './ReportActions'

export type Report = {
    id: string
    nombre: string
    descripcion?: string | null
    updated_at: string
    cliente_id?: string | null
}

type Sort = 'recent' | 'name'

interface Props {
    /** Informes personalizados (con cliente). */
    custom: Report[]
    /** Plantillas del sistema y propias. */
    templates: Report[]
    /** Plantillas que el usuario puede editar/borrar (id set). */
    editableTemplateIds: string[]
    clientes: { id: string; nombre: string }[]
    /** Filtro de cliente preseleccionado (deep link `?cliente=` desde el dashboard). */
    initialClienteId?: string
}

export function InformesBrowser({ custom, templates, editableTemplateIds, clientes, initialClienteId = '' }: Props) {
    const [query, setQuery] = useState('')
    const [clienteId, setClienteId] = useState<string>(initialClienteId)
    const [sort, setSort] = useState<Sort>('recent')
    const [showTemplates, setShowTemplates] = useState(true)

    const clienteMap = useMemo(
        () => new Map(clientes.map((c) => [c.id, c.nombre])),
        [clientes],
    )
    const editable = useMemo(() => new Set(editableTemplateIds), [editableTemplateIds])

    /** Sólo clientes que tienen al menos un informe, con su conteo. */
    const clienteOptions = useMemo(() => {
        const counts = new Map<string, number>()
        for (const r of custom) {
            if (r.cliente_id) counts.set(r.cliente_id, (counts.get(r.cliente_id) ?? 0) + 1)
        }
        // Un deep link puede apuntar a un cliente que aún no tiene informes: se añade con
        // conteo 0 para que el select y el chip reflejen el filtro en vez de quedar vacíos.
        if (initialClienteId && clienteMap.has(initialClienteId) && !counts.has(initialClienteId)) {
            counts.set(initialClienteId, 0)
        }
        return [...counts.entries()]
            .map(([id, count]) => ({ id, nombre: clienteMap.get(id) ?? 'Cliente', count }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
    }, [custom, clienteMap, initialClienteId])

    const apply = (list: Report[], matchCliente: boolean) => {
        const q = query.trim().toLowerCase()
        const out = list.filter((r) => {
            if (matchCliente && clienteId && r.cliente_id !== clienteId) return false
            if (!q) return true
            return (
                r.nombre.toLowerCase().includes(q) ||
                (r.descripcion ?? '').toLowerCase().includes(q)
            )
        })
        return out.sort((a, b) =>
            sort === 'name'
                ? a.nombre.localeCompare(b.nombre)
                : b.updated_at.localeCompare(a.updated_at),
        )
    }

    const visibleCustom = apply(custom, true)
    // Con un cliente seleccionado las plantillas no aplican (son globales).
    const visibleTemplates = clienteId ? [] : apply(templates, false)

    const filtering = Boolean(query.trim() || clienteId)

    return (
        <div className="space-y-8">
            {/* Toolbar: búsqueda + filtro por cliente + orden */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Buscar informe por nombre o descripción…"
                        className="w-full pl-9 pr-9 py-2.5 text-sm rounded-xl bg-card border border-border text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:bg-accent transition-colors"
                            title="Limpiar"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>

                <select
                    value={clienteId}
                    onChange={(e) => setClienteId(e.target.value)}
                    className="px-3 py-2.5 text-sm rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                    <option value="">Todos los clientes</option>
                    {clienteOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.nombre} ({c.count})
                        </option>
                    ))}
                </select>

                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as Sort)}
                    className="px-3 py-2.5 text-sm rounded-xl bg-card border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                    <option value="recent">Más recientes</option>
                    <option value="name">Nombre (A-Z)</option>
                </select>

                {filtering && (
                    <button
                        onClick={() => { setQuery(''); setClienteId('') }}
                        className="px-3 py-2.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                        Limpiar filtros
                    </button>
                )}
            </div>

            {/* Chips rápidos por cliente */}
            {clienteOptions.length > 1 && (
                <div className="flex flex-wrap gap-2 -mt-4">
                    <FilterChip active={!clienteId} onClick={() => setClienteId('')} label="Todos" count={custom.length} />
                    {clienteOptions.map((c) => (
                        <FilterChip
                            key={c.id}
                            active={clienteId === c.id}
                            onClick={() => setClienteId(clienteId === c.id ? '' : c.id)}
                            label={c.nombre}
                            count={c.count}
                        />
                    ))}
                </div>
            )}

            {/* Mis informes — primero */}
            <section>
                <div className="flex items-center gap-2 mb-4">
                    <BarChart2 className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Mis informes</h2>
                    <HelpTip text="Tus informes personalizados. Crea uno con 'Nuevo Informe', agrega widgets en modo edición y compártelos con un link público cuando estén listos." />
                    <span className="px-1.5 py-0.5 rounded-md bg-muted text-[10px] font-mono text-muted-foreground">
                        {visibleCustom.length}
                    </span>
                </div>
                {visibleCustom.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                        {visibleCustom.map((r) => (
                            <ReportCard
                                key={r.id}
                                report={r}
                                clienteName={r.cliente_id ? clienteMap.get(r.cliente_id) : undefined}
                                showActions
                            />
                        ))}
                    </div>
                ) : filtering ? (
                    <EmptyState
                        title="Sin resultados"
                        subtitle="Ningún informe coincide con los filtros aplicados."
                    />
                ) : (
                    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-12 text-center">
                        <BarChart2 className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">Sin informes personalizados</p>
                        <p className="text-xs text-muted-foreground mb-4">
                            Crea tu primer informe o usa una plantilla del sistema.
                        </p>
                        <Link
                            href="/report-utm/informes/nuevo"
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                        >
                            <PlusCircle className="h-3.5 w-3.5" />
                            Crear informe
                        </Link>
                    </div>
                )}
            </section>

            {/* Plantillas — segundo y colapsable */}
            <section>
                <button
                    onClick={() => setShowTemplates((v) => !v)}
                    className="flex items-center gap-2 mb-4 group/hdr"
                >
                    <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Plantillas</h2>
                    <span className="px-1.5 py-0.5 rounded-md bg-muted text-[10px] font-mono text-muted-foreground">
                        {visibleTemplates.length}
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${showTemplates ? '' : '-rotate-90'}`}
                    />
                </button>
                {showTemplates && (
                    clienteId ? (
                        <p className="text-xs text-muted-foreground">
                            Las plantillas son globales: quita el filtro de cliente para verlas.
                        </p>
                    ) : visibleTemplates.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                            {visibleTemplates.map((r) => (
                                <ReportCard key={r.id} report={r} isTemplate showActions={editable.has(r.id)} />
                            ))}
                        </div>
                    ) : (
                        <EmptyState title="Sin plantillas" subtitle="Ninguna plantilla coincide con la búsqueda." />
                    )
                )}
            </section>
        </div>
    )
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                active
                    ? 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
        >
            {label}
            <span className="font-mono opacity-60">{count}</span>
        </button>
    )
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-8 text-center">
            <p className="text-sm font-medium text-foreground mb-1">{title}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
    )
}

function ReportCard({ report, isTemplate, clienteName, showActions }: { report: Report; isTemplate?: boolean; clienteName?: string; showActions?: boolean }) {
    return (
        <div className="relative group">
            {showActions && (
                <ReportActions report={report} className="absolute top-3 right-3 z-10" />
            )}
            <Link
                href={`/report-utm/informes/${report.id}`}
                className="rounded-2xl border border-border bg-card p-5 hover:border-emerald-500/40 hover:shadow-sm transition-all duration-200 flex flex-col gap-3"
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10 flex-shrink-0">
                        <BarChart2 className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    {isTemplate ? (
                        <span className="px-1.5 py-0.5 rounded-md bg-muted text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                            plantilla
                        </span>
                    ) : clienteName ? (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 text-[9px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            <Lock className="h-2.5 w-2.5" />
                            {clienteName}
                        </span>
                    ) : null}
                </div>

                <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors line-clamp-1">
                        {report.nombre}
                    </p>
                    {report.descripcion && (
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                            {report.descripcion}
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(report.updated_at)}
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-emerald-500 transition-colors" />
                </div>
            </Link>
        </div>
    )
}
