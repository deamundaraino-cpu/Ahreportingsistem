import { headers } from 'next/headers'
import Link from 'next/link'
import { reportUtmClient, reportUtmAdminClient } from '@/lib/report-utm/client'
import { createClient } from '@/utils/supabase/server'
import type { ReportUtmCliente } from '@/lib/report-utm/types'
import { PixelSnippet } from '@/components/report-utm/PixelSnippet'
import { Activity, Code2, Filter, MousePointerClick, Eye, ExternalLink } from 'lucide-react'
import { formatTime } from '@/lib/report-utm/formatters'

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

    // Obtener S2S token para el cliente seleccionado (para snippet PHP).
    // Requiere admin client: la columna s2s_token puede estar restringida por RLS.
    // Solo lo leen usuarios con rol admin o trafficker.
    let s2sToken: string | null = null
    if (sp.clienteId) {
        const base = await createClient()
        const { data: { user } } = await base.auth.getUser()
        let canReadToken = false
        if (user) {
            const { data: profile } = await base
                .from('user_profiles')
                .select('role')
                .eq('id', user.id)
                .single()
            const role = profile?.role ?? null
            canReadToken = role === 'admin' || role === 'trafficker'
        }

        if (canReadToken) {
            const adminDb = await reportUtmAdminClient()
            const { data: s2sIntegration } = await adminDb
                .from('integrations')
                .select('s2s_token, status')
                .eq('cliente_id', sp.clienteId)
                .eq('tipo', 's2s')
                .maybeSingle()
            if (s2sIntegration?.status === 'active') {
                s2sToken = (s2sIntegration as { s2s_token: string | null }).s2s_token ?? null
            }
        }
    }

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
                <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
                    Pixel & Eventos
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Pixel JavaScript propio servido desde el mismo dominio. Captura pageviews y eventos custom
                    con cookies first-touch / last-touch (90d) para atribución cross-session.
                </p>
            </div>

            {/* Selector cliente */}
            <form
                method="GET"
                className="rounded-2xl border border-border bg-card p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <p className="text-xs font-medium text-muted-foreground">
                        Elegí un cliente para ver el snippet de instalación
                    </p>
                </div>
                <div className="flex gap-2 items-end">
                    <select
                        name="clienteId"
                        defaultValue={sp.clienteId ?? ''}
                        className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
                    >
                        <option value="">Todos los clientes (eventos)</option>
                        {clientesList.map((c) => (
                            <option key={c.id} value={c.id}>{c.nombre}</option>
                        ))}
                    </select>
                    <button
                        type="submit"
                        className="px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm nav-active-emerald"
                    >
                        Aplicar
                    </button>
                </div>
            </form>

            {/* Snippet de instalación */}
            {selectedCliente ? (
                <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <Code2 className="h-4 w-4 text-emerald-500" />
                        <h2 className="text-sm font-semibold text-foreground">
                            Snippet de instalación · {selectedCliente.nombre}
                        </h2>
                    </div>
                    <PixelSnippet origin={origin} clienteSlug={selectedCliente.slug} s2sToken={s2sToken} />
                    <div className="text-xs text-muted-foreground space-y-1">
                        <p>
                            <strong>Pageview:</strong> automático al cargar.
                        </p>
                        <p>
                            <strong>Eventos custom:</strong>{' '}
                            <code className="font-mono px-1 py-0.5 rounded bg-muted">
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
                <div className="rounded-2xl border border-dashed border-border bg-muted/40 p-6">
                    <p className="text-xs text-muted-foreground">
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
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">
                        Eventos recientes (50)
                    </h2>
                </div>
                {eventsList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/60">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <th className="px-4 py-3">Hora</th>
                                    <th className="px-4 py-3">Cliente</th>
                                    <th className="px-4 py-3">Tipo</th>
                                    <th className="px-4 py-3">Página</th>
                                    <th className="px-4 py-3">UTM / Click</th>
                                    <th className="px-4 py-3">Visitor</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {eventsList.map((e) => (
                                    <tr key={e.id} className="hover:bg-accent">
                                        <td className="px-4 py-3 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                                            {formatTime(e.created_at)}
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
                                            <p className="text-xs text-foreground/90 truncate" title={e.page_url ?? ''}>
                                                {e.page_url ?? '—'}
                                            </p>
                                            {e.referrer && (
                                                <p className="text-[10px] text-muted-foreground truncate" title={e.referrer}>
                                                    ← {e.referrer}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-xs font-mono">
                                            {e.utm_source && (
                                                <p className="text-emerald-600 dark:text-emerald-400">
                                                    {e.utm_source}
                                                    {e.utm_campaign ? ` / ${e.utm_campaign}` : ''}
                                                </p>
                                            )}
                                            {e.click_id && (
                                                <p className="text-muted-foreground truncate max-w-[12ch]" title={e.click_id}>
                                                    {e.click_id}
                                                </p>
                                            )}
                                            {!e.utm_source && !e.click_id && (
                                                <span className="text-muted-foreground/70">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-[10px] font-mono tabular-nums text-muted-foreground">
                                            {e.visitor_id ? e.visitor_id.slice(0, 8) : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-12 text-center">
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                            <Activity className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium text-foreground/90">
                            Sin eventos del pixel todavía
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
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
        <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                    <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
            </div>
            <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-foreground">{value}</p>
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
