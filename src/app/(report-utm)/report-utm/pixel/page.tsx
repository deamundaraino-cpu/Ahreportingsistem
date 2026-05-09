import { headers } from 'next/headers'
import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente } from '@/lib/report-utm/types'
import { PixelSnippet } from '@/components/report-utm/PixelSnippet'
import { Activity, Code2, Filter, MousePointerClick, Eye, ExternalLink } from 'lucide-react'

export const dynamic = 'force-dynamic'

type SearchParams = { clienteId?: string }

type PixelEvent = {
    id: string
    cliente_id: string
    event_type: string
    event_name: string | null
    visitor_id: string | null
    page_url: string | null
    referrer: string | null
    utm_source: string | null
    utm_campaign: string | null
    click_id: string | null
    user_agent: string | null
    ip_country: string | null
    created_at: string
}

export default async function PixelPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const sp = await searchParams
    const supabase = await reportUtmClient()

    const { data: clientes } = await supabase
        .from('clientes')
        .select('id, nombre, slug, status')
        .order('nombre')

    const clientesList = (clientes ?? []) as Array<
        Pick<ReportUtmCliente, 'id' | 'nombre' | 'slug' | 'status'>
    >

    let eventsQuery = supabase
        .from('pixel_events')
        .select('id, cliente_id, event_type, event_name, visitor_id, page_url, referrer, utm_source, utm_campaign, click_id, user_agent, ip_country, created_at')
        .order('created_at', { ascending: false })
        .limit(50)

    if (sp.clienteId) eventsQuery = eventsQuery.eq('cliente_id', sp.clienteId)

    const { data: events, error } = await eventsQuery
    const eventsList = (events ?? []) as PixelEvent[]

    const clienteName = new Map<string, string>(clientesList.map((c) => [c.id, c.nombre]))

    // Stats agrupadas
    const stats = eventsList.reduce(
        (acc, e) => {
            acc.total += 1
            if (e.event_type === 'pageview') acc.pageviews += 1
            else if (e.event_type === 'click') acc.clicks += 1
            else if (e.event_type === 'custom') acc.custom += 1
            if (e.visitor_id) acc.visitors.add(e.visitor_id)
            return acc
        },
        { total: 0, pageviews: 0, clicks: 0, custom: 0, visitors: new Set<string>() },
    )

    const hdrs = await headers()
    const proto = hdrs.get('x-forwarded-proto') ?? 'http'
    const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'localhost:3000'
    const origin = `${proto}://${host}`

    const selectedCliente = clientesList.find((c) => c.id === sp.clienteId)

    return (
        <div className="space-y-6">
            <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                    Report-UTM · Fase 3
                </p>
                <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-1">
                    Pixel & Eventos
                </h1>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    Pixel JavaScript propio servido desde el mismo dominio. Captura pageviews y eventos custom
                    con cookies first-touch / last-touch (90d) para atribución cross-session.
                </p>
            </div>

            {/* Selector cliente */}
            <form
                method="GET"
                className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-zinc-400" />
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        Elegí un cliente para ver el snippet de instalación
                    </p>
                </div>
                <div className="flex gap-2 items-end">
                    <select
                        name="clienteId"
                        defaultValue={sp.clienteId ?? ''}
                        className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
                    >
                        <option value="">Todos los clientes (eventos)</option>
                        {clientesList.map((c) => (
                            <option key={c.id} value={c.id}>{c.nombre}</option>
                        ))}
                    </select>
                    <button
                        type="submit"
                        className="px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm"
                        style={{ background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)' }}
                    >
                        Aplicar
                    </button>
                </div>
            </form>

            {/* Snippet de instalación */}
            {selectedCliente ? (
                <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <Code2 className="h-4 w-4 text-emerald-500" />
                        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            Snippet de instalación · {selectedCliente.nombre}
                        </h2>
                    </div>
                    <PixelSnippet origin={origin} clienteSlug={selectedCliente.slug} />
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 space-y-1">
                        <p>
                            <strong>Pageview:</strong> automático al cargar.
                        </p>
                        <p>
                            <strong>Eventos custom:</strong>{' '}
                            <code className="font-mono px-1 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04]">
                                rutm(&apos;track&apos;, &apos;lead&apos;, {'{'} plan: &apos;pro&apos; {'}'})
                            </code>
                        </p>
                        <p>
                            <strong>Pixel JS:</strong>{' '}
                            <a
                                href="/report-utm-pixel.js"
                                className="text-emerald-600 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
                            >
                                /report-utm-pixel.js <ExternalLink className="h-3 w-3" />
                            </a>
                        </p>
                    </div>
                </div>
            ) : (
                <div className="rounded-2xl border border-dashed border-zinc-200 dark:border-white/[0.06] bg-zinc-50/50 dark:bg-white/[0.02] p-6">
                    <p className="text-xs text-zinc-500 dark:text-zinc-500">
                        Elegí un cliente arriba para ver su snippet de instalación.
                    </p>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Stat label="Eventos (50 últimos)" value={stats.total} icon={Activity} />
                <Stat label="Pageviews" value={stats.pageviews} icon={Eye} />
                <Stat label="Clicks" value={stats.clicks} icon={MousePointerClick} />
                <Stat label="Visitors únicos" value={stats.visitors.size} icon={Activity} />
            </div>

            {error && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <p className="text-[11px] font-mono text-amber-800 dark:text-amber-300">{error.message}</p>
                </div>
            )}

            {/* Stream de eventos */}
            <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 overflow-hidden">
                <div className="px-6 py-4 border-b border-zinc-200 dark:border-white/[0.06]">
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Eventos recientes (50)
                    </h2>
                </div>
                {eventsList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-zinc-50 dark:bg-white/[0.02]">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                                    <th className="px-4 py-3">Hora</th>
                                    <th className="px-4 py-3">Cliente</th>
                                    <th className="px-4 py-3">Tipo</th>
                                    <th className="px-4 py-3">Página</th>
                                    <th className="px-4 py-3">UTM / Click</th>
                                    <th className="px-4 py-3">Visitor</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.04]">
                                {eventsList.map((e) => (
                                    <tr key={e.id} className="hover:bg-zinc-50 dark:hover:bg-white/[0.02]">
                                        <td className="px-4 py-3 text-[11px] text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                                            {new Date(e.created_at).toLocaleTimeString()}
                                        </td>
                                        <td className="px-4 py-3 text-xs">
                                            <Link
                                                href={`/report-utm/clientes/${e.cliente_id}`}
                                                className="text-emerald-600 dark:text-emerald-400 hover:underline"
                                            >
                                                {clienteName.get(e.cliente_id) ?? e.cliente_id.slice(0, 8)}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3">
                                            <EventTypeBadge type={e.event_type} name={e.event_name} />
                                        </td>
                                        <td className="px-4 py-3 max-w-xs">
                                            <p className="text-[11px] text-zinc-700 dark:text-zinc-300 truncate" title={e.page_url ?? ''}>
                                                {e.page_url ?? '—'}
                                            </p>
                                            {e.referrer && (
                                                <p className="text-[10px] text-zinc-500 dark:text-zinc-500 truncate" title={e.referrer}>
                                                    ← {e.referrer}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-[11px] font-mono">
                                            {e.utm_source && (
                                                <p className="text-emerald-600 dark:text-emerald-400">
                                                    {e.utm_source}
                                                    {e.utm_campaign ? ` / ${e.utm_campaign}` : ''}
                                                </p>
                                            )}
                                            {e.click_id && (
                                                <p className="text-zinc-500 dark:text-zinc-500 truncate max-w-[12ch]" title={e.click_id}>
                                                    {e.click_id}
                                                </p>
                                            )}
                                            {!e.utm_source && !e.click_id && (
                                                <span className="text-zinc-400 dark:text-zinc-600">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-[10px] font-mono text-zinc-500 dark:text-zinc-500">
                                            {e.visitor_id ? e.visitor_id.slice(0, 8) : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-12 text-center">
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-white/[0.04] mb-3">
                            <Activity className="h-5 w-5 text-zinc-400" />
                        </div>
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            Sin eventos del pixel todavía
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                            Instalá el snippet en el sitio del cliente para empezar a capturar pageviews.
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}

function Stat({
    label,
    value,
    icon: Icon,
}: {
    label: string
    value: number | string
    icon: typeof Activity
}) {
    return (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-4">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-500">{label}</p>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                    <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
            </div>
            <p className="mt-2 text-2xl font-bold text-zinc-900 dark:text-zinc-50">{value}</p>
        </div>
    )
}

function EventTypeBadge({ type, name }: { type: string; name: string | null }) {
    const cls =
        type === 'pageview'
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
            : type === 'click'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            : 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400'
    return (
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}>
            {type}
            {name ? ` · ${name}` : ''}
        </span>
    )
}
