import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente, ReportUtmLeadEvent } from '@/lib/report-utm/types'
import { UserCheck, Filter, ChevronLeft, ChevronRight } from 'lucide-react'
import { AttributionBadge } from '@/components/report-utm/AttributionBadge'
import { formatDateTime } from '@/lib/report-utm/formatters'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

type SearchParams = {
    clienteId?: string
    utm_source?: string
    form_plugin?: string
    from?: string
    to?: string
    page?: string
}

export default async function LeadsPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const sp = await searchParams
    const supabase = await reportUtmClient()

    const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
    const offset = (page - 1) * PAGE_SIZE

    // Clientes para el selector
    const { data: clientes } = await supabase
        .from('clientes')
        .select('id, nombre, slug')
        .order('nombre')

    // Query leads con filtros
    let query = supabase
        .from('lead_events')
        .select(
            'id, cliente_id, form_name, form_id, form_plugin, lead_name, lead_email, lead_phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, visitor_id, page_url, ip_country, attribution_method, first_touch, last_touch, raw_fields, source, created_at',
            { count: 'exact' },
        )

    if (sp.clienteId) query = query.eq('cliente_id', sp.clienteId)
    if (sp.utm_source) query = query.eq('utm_source', sp.utm_source)
    if (sp.form_plugin) query = query.eq('form_plugin', sp.form_plugin)
    if (sp.from) query = query.gte('created_at', sp.from)
    if (sp.to) query = query.lte('created_at', sp.to)

    const { data: leads, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const clienteMap = Object.fromEntries(
        (clientes ?? []).map((c) => [c.id, c]),
    )

    const buildUrl = (params: Record<string, string | undefined>) => {
        const base: Record<string, string> = {}
        if (sp.clienteId) base.clienteId = sp.clienteId
        if (sp.utm_source) base.utm_source = sp.utm_source
        if (sp.form_plugin) base.form_plugin = sp.form_plugin
        if (sp.from) base.from = sp.from
        if (sp.to) base.to = sp.to
        const merged = { ...base, ...params }
        const qs = Object.entries(merged)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
            .join('&')
        return `/report-utm/leads${qs ? '?' + qs : ''}`
    }

    const PLUGIN_LABELS: Record<string, string> = {
        elementor: 'Elementor Pro',
        cf7: 'Contact Form 7',
        gravity_forms: 'Gravity Forms',
        wpforms: 'WPForms',
        s2s: 'S2S / Manual',
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                            <UserCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <h1 className="text-2xl font-bold text-foreground">Leads</h1>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {total.toLocaleString()} registros · Page {page} de {totalPages}
                    </p>
                </div>
            </div>

            {/* Filtros */}
            <form method="get" className="flex flex-wrap gap-3 items-end">
                <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Cliente
                    </label>
                    <select
                        name="clienteId"
                        defaultValue={sp.clienteId ?? ''}
                        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    >
                        <option value="">Todos</option>
                        {(clientes ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.nombre}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Plugin
                    </label>
                    <select
                        name="form_plugin"
                        defaultValue={sp.form_plugin ?? ''}
                        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    >
                        <option value="">Todos</option>
                        {Object.entries(PLUGIN_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        UTM Source
                    </label>
                    <input
                        type="text"
                        name="utm_source"
                        defaultValue={sp.utm_source ?? ''}
                        placeholder="facebook"
                        className="w-32 px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                </div>
                <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Desde
                    </label>
                    <input
                        type="date"
                        name="from"
                        defaultValue={sp.from ?? ''}
                        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                </div>
                <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                        Hasta
                    </label>
                    <input
                        type="date"
                        name="to"
                        defaultValue={sp.to ?? ''}
                        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    />
                </div>
                <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                    <Filter className="h-3 w-3" />
                    Filtrar
                </button>
                {(sp.clienteId || sp.utm_source || sp.form_plugin || sp.from || sp.to) && (
                    <Link
                        href="/report-utm/leads"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent transition-colors"
                    >
                        Limpiar
                    </Link>
                )}
            </form>

            {/* Tabla */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                {(leads ?? []).length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/60">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <th className="px-4 py-3">Fecha</th>
                                    <th className="px-4 py-3">Lead</th>
                                    <th className="px-4 py-3">Formulario</th>
                                    <th className="px-4 py-3">Cliente</th>
                                    <th className="px-4 py-3">UTM Source</th>
                                    <th className="px-4 py-3">UTM Campaign</th>
                                    <th className="px-4 py-3">Atribución</th>
                                    <th className="px-4 py-3">Click ID</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {(leads as ReportUtmLeadEvent[]).map((lead) => (
                                    <LeadRow
                                        key={lead.id}
                                        lead={lead}
                                        clienteNombre={clienteMap[lead.cliente_id]?.nombre ?? lead.cliente_id}
                                        pluginLabels={PLUGIN_LABELS}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-16 text-center">
                        <UserCheck className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground">Sin leads todavía</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            Configurá el plugin WordPress con el S2S Token para capturar envíos de formularios.
                        </p>
                    </div>
                )}
            </div>

            {/* Paginación */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between gap-4">
                    <p className="text-xs text-muted-foreground">
                        Mostrando {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {total.toLocaleString()}
                    </p>
                    <div className="flex items-center gap-2">
                        {page > 1 && (
                            <Link
                                href={buildUrl({ page: String(page - 1) })}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:bg-accent transition-colors"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                                Anterior
                            </Link>
                        )}
                        <span className="text-xs text-muted-foreground">
                            {page} / {totalPages}
                        </span>
                        {page < totalPages && (
                            <Link
                                href={buildUrl({ page: String(page + 1) })}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:bg-accent transition-colors"
                            >
                                Siguiente
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

function LeadRow({
    lead,
    clienteNombre,
    pluginLabels,
}: {
    lead: ReportUtmLeadEvent
    clienteNombre: string
    pluginLabels: Record<string, string>
}) {
    const hasRawFields = lead.raw_fields && Object.keys(lead.raw_fields).length > 0

    return (
        <>
            <tr className="hover:bg-accent/50 group">
                <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTime(lead.created_at)}
                </td>
                <td className="px-4 py-3">
                    <div className="space-y-0.5">
                        {lead.lead_name && (
                            <p className="text-xs font-medium text-foreground">{lead.lead_name}</p>
                        )}
                        {lead.lead_email && (
                            <p className="text-[11px] text-muted-foreground font-mono">{lead.lead_email}</p>
                        )}
                        {lead.lead_phone && (
                            <p className="text-[11px] text-muted-foreground">{lead.lead_phone}</p>
                        )}
                        {!lead.lead_name && !lead.lead_email && !lead.lead_phone && (
                            <p className="text-[11px] text-muted-foreground italic">Sin datos de contacto</p>
                        )}
                    </div>
                </td>
                <td className="px-4 py-3">
                    {lead.form_name && (
                        <p className="text-xs font-medium text-foreground">{lead.form_name}</p>
                    )}
                    {lead.form_plugin && (
                        <p className="text-[10px] text-muted-foreground">
                            {pluginLabels[lead.form_plugin] ?? lead.form_plugin}
                        </p>
                    )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                    {clienteNombre}
                </td>
                <td className="px-4 py-3">
                    {lead.utm_source && (
                        <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                            {lead.utm_source}
                        </span>
                    )}
                    {lead.utm_medium && (
                        <span className="text-[10px] text-muted-foreground block">
                            {lead.utm_medium}
                        </span>
                    )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                    {lead.utm_campaign ?? '—'}
                </td>
                <td className="px-4 py-3">
                    <AttributionBadge method={lead.attribution_method ?? 'none'} />
                </td>
                <td className="px-4 py-3 text-[10px] font-mono text-muted-foreground max-w-[120px] truncate">
                    {lead.click_id ?? '—'}
                </td>
            </tr>
            {/* Fila de detalle expandida con raw_fields */}
            {hasRawFields && (
                <tr className="bg-muted/30">
                    <td colSpan={8} className="px-4 py-2">
                        <details className="text-[11px]">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
                                Ver campos del formulario ({Object.keys(lead.raw_fields!).length} campos)
                            </summary>
                            <div className="mt-2 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                                {Object.entries(lead.raw_fields!).map(([key, val]) => (
                                    <div key={key} className="bg-card rounded-lg border border-border px-2 py-1.5">
                                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide truncate">
                                            {key}
                                        </p>
                                        <p className="text-xs text-foreground truncate">
                                            {String(val) || '—'}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </details>
                    </td>
                </tr>
            )}
        </>
    )
}
