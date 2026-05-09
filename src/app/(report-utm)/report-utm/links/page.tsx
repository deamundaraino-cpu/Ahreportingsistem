import { headers } from 'next/headers'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente, ReportUtmTrackingLink } from '@/lib/report-utm/types'
import { TrackingLinkRow } from '@/components/report-utm/TrackingLinkRow'
import { createTrackingLinkAction } from './_actions'
import { Link2, Plus, Filter } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

type SearchParams = { clienteId?: string }

export default async function LinksPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const sp = await searchParams
    const supabase = await reportUtmClient()

    const [{ data: clientes }, linksQuery] = await Promise.all([
        supabase.from('clientes').select('id, nombre, slug').order('nombre'),
        (async () => {
            let q = supabase
                .from('tracking_links')
                .select('id, cliente_id, slug, nombre, destination_url, utm_source, utm_campaign, clicks_count, enabled, last_click_at, created_at')
                .order('created_at', { ascending: false })
            if (sp.clienteId) q = q.eq('cliente_id', sp.clienteId)
            return q
        })(),
    ])

    const { data: links, error } = linksQuery
    const clientesList = (clientes ?? []) as Array<Pick<ReportUtmCliente, 'id' | 'nombre' | 'slug'>>
    const linksList = (links ?? []) as Array<
        Pick<ReportUtmTrackingLink,
            'id' | 'cliente_id' | 'slug' | 'nombre' | 'destination_url' | 'utm_source' |
            'utm_campaign' | 'clicks_count' | 'enabled' | 'last_click_at'
        >
    >

    const clienteName = new Map<string, string>(clientesList.map((c) => [c.id, c.nombre]))

    const totalClicks = linksList.reduce((s, l) => s + (l.clicks_count ?? 0), 0)

    const hdrs = await headers()
    const proto = hdrs.get('x-forwarded-proto') ?? 'http'
    const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'localhost:3000'
    const origin = `${proto}://${host}`

    return (
        <div className="space-y-6">
            <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                    Report-UTM · Fase 3
                </p>
                <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-1">
                    Tracking Links
                </h1>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {linksList.length} link{linksList.length === 1 ? '' : 's'} ·{' '}
                    {totalClicks.toLocaleString()} click{totalClicks === 1 ? '' : 's'} totales. Cada redirect
                    setea cookies de atribución first-touch / last-touch (90d).
                </p>
            </div>

            {/* Filtro */}
            <form
                method="GET"
                className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-zinc-400" />
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Filtrar por cliente</p>
                </div>
                <div className="flex gap-2 items-end">
                    <select
                        name="clienteId"
                        defaultValue={sp.clienteId ?? ''}
                        className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
                    >
                        <option value="">Todos los clientes</option>
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
                    <Link
                        href="/report-utm/links"
                        className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/[0.04] transition-colors"
                    >
                        Limpiar
                    </Link>
                </div>
            </form>

            {/* Form alta */}
            <form
                action={async (fd) => {
                    'use server'
                    await createTrackingLinkAction(fd)
                }}
                className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-6 space-y-4"
            >
                <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4 text-emerald-500" />
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Nuevo link</h2>
                </div>

                {clientesList.length === 0 ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                        Primero creá un cliente en{' '}
                        <Link href="/report-utm/clientes" className="underline">/report-utm/clientes</Link>
                    </p>
                ) : (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <Field label="Cliente" required>
                                <select
                                    name="cliente_id"
                                    required
                                    defaultValue={sp.clienteId ?? ''}
                                    className={INPUT_CLASS}
                                >
                                    <option value="" disabled>Elegir cliente…</option>
                                    {clientesList.map((c) => (
                                        <option key={c.id} value={c.id}>{c.nombre}</option>
                                    ))}
                                </select>
                            </Field>
                            <Field label="Nombre interno" required>
                                <input name="nombre" required placeholder="Promo agosto FB" className={INPUT_CLASS} />
                            </Field>
                            <Field label="URL destino" required colSpan>
                                <input
                                    name="destination_url"
                                    required
                                    type="url"
                                    placeholder="https://hotmart.com/..."
                                    className={INPUT_CLASS}
                                />
                            </Field>
                            <Field label="Slug (opcional)">
                                <input
                                    name="slug"
                                    placeholder="auto-generado"
                                    pattern="[a-z0-9-]{3,40}"
                                    className={INPUT_CLASS}
                                />
                            </Field>
                            <Field label="utm_source">
                                <input name="utm_source" placeholder="FB" className={INPUT_CLASS} />
                            </Field>
                            <Field label="utm_medium">
                                <input name="utm_medium" placeholder="cpc" className={INPUT_CLASS} />
                            </Field>
                            <Field label="utm_campaign">
                                <input name="utm_campaign" placeholder="promo_agosto" className={INPUT_CLASS} />
                            </Field>
                            <Field label="utm_content">
                                <input name="utm_content" placeholder="creative_a" className={INPUT_CLASS} />
                            </Field>
                            <Field label="utm_term">
                                <input name="utm_term" placeholder="" className={INPUT_CLASS} />
                            </Field>
                        </div>
                        <div className="flex justify-end">
                            <button
                                type="submit"
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white shadow-sm"
                                style={{ background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)' }}
                            >
                                <Plus className="h-4 w-4" />
                                Crear link
                            </button>
                        </div>
                    </>
                )}
            </form>

            {error && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <p className="text-[11px] font-mono text-amber-800 dark:text-amber-300">{error.message}</p>
                </div>
            )}

            {/* Tabla */}
            <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 overflow-hidden">
                {linksList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-zinc-50 dark:bg-white/[0.02]">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                                    <th className="px-4 py-3">Link</th>
                                    <th className="px-4 py-3">Slug → Destino</th>
                                    <th className="px-4 py-3">UTM</th>
                                    <th className="px-4 py-3 text-right">Clicks</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3 text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.04]">
                                {linksList.map((l) => (
                                    <TrackingLinkRow
                                        key={l.id}
                                        link={l as Parameters<typeof TrackingLinkRow>[0]['link']}
                                        origin={origin}
                                        clienteName={clienteName.get(l.cliente_id) ?? '—'}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-12 text-center">
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-white/[0.04] mb-3">
                            <Link2 className="h-5 w-5 text-zinc-400" />
                        </div>
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Sin tracking links</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                            Creá el primero arriba.
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}

const INPUT_CLASS =
    'w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-colors'

function Field({
    label,
    required,
    colSpan,
    children,
}: {
    label: string
    required?: boolean
    colSpan?: boolean
    children: React.ReactNode
}) {
    return (
        <label className={`block ${colSpan ? 'md:col-span-2' : ''}`}>
            <span className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                {label}
                {required && <span className="text-red-500"> *</span>}
            </span>
            {children}
        </label>
    )
}
