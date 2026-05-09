import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente, ReportUtmSalesEvent } from '@/lib/report-utm/types'
import { ShoppingBag, ExternalLink, Filter } from 'lucide-react'
import { AttributionBadge } from '@/components/report-utm/AttributionBadge'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

type SearchParams = {
    clienteId?: string
    status?: string
    utm_source?: string
    from?: string
    to?: string
    page?: string
}

export default async function VentasPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const sp = await searchParams
    const supabase = await reportUtmClient()

    const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
    const offset = (page - 1) * PAGE_SIZE

    // Clientes (para selector)
    const { data: clientes } = await supabase
        .from('clientes')
        .select('id, nombre, slug')
        .order('nombre')

    // Query ventas con filtros
    let query = supabase
        .from('sales_events')
        .select(
            'id, cliente_id, sale_timestamp, amount, currency, status, customer_name, customer_email, utm_source, utm_medium, utm_campaign, product_name, transaction_type, platform_sale_id, platform, attribution_method',
            { count: 'exact' },
        )

    if (sp.clienteId) query = query.eq('cliente_id', sp.clienteId)
    if (sp.status) query = query.eq('status', sp.status)
    if (sp.utm_source) query = query.eq('utm_source', sp.utm_source)
    if (sp.from) query = query.gte('sale_timestamp', sp.from)
    if (sp.to) query = query.lte('sale_timestamp', sp.to)

    const { data: ventas, count, error } = await query
        .order('sale_timestamp', { ascending: false, nullsFirst: false })
        .range(offset, offset + PAGE_SIZE - 1)

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    // Map cliente_id → nombre para mostrar en cada fila
    const clienteName = new Map<string, string>(
        (clientes ?? []).map((c) => [c.id as string, (c as { nombre: string }).nombre]),
    )

    const ventasList = (ventas ?? []) as Array<
        Pick<ReportUtmSalesEvent,
            'id' | 'cliente_id' | 'sale_timestamp' | 'amount' | 'currency' | 'status' |
            'customer_name' | 'customer_email' | 'utm_source' | 'utm_medium' | 'utm_campaign' |
            'product_name' | 'transaction_type' | 'platform_sale_id' | 'platform'
        > & { attribution_method: string | null }
    >

    const buildHref = (overrides: Partial<SearchParams>) => {
        const params = new URLSearchParams()
        const merged = { ...sp, ...overrides }
        for (const [k, v] of Object.entries(merged)) {
            if (v) params.set(k, String(v))
        }
        const qs = params.toString()
        return `/report-utm/ventas${qs ? `?${qs}` : ''}`
    }

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        Report-UTM · Fase 1
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-1">
                        Ventas
                    </h1>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                        Eventos de venta crudos recibidos por webhook. {total.toLocaleString()} eventos
                        {sp.clienteId ? ' (filtrados)' : ' totales'}.
                    </p>
                </div>
            </div>

            {/* Filtros */}
            <form
                method="GET"
                className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-zinc-400" />
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Filtros</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                    <SelectField label="Cliente" name="clienteId" defaultValue={sp.clienteId ?? ''}>
                        <option value="">Todos</option>
                        {(clientes ?? []).map((c) => (
                            <option key={c.id as string} value={c.id as string}>
                                {(c as ReportUtmCliente).nombre}
                            </option>
                        ))}
                    </SelectField>
                    <SelectField label="Status" name="status" defaultValue={sp.status ?? ''}>
                        <option value="">Todos</option>
                        <option value="approved">Approved</option>
                        <option value="pending">Pending</option>
                        <option value="refunded">Refunded</option>
                        <option value="chargeback">Chargeback</option>
                    </SelectField>
                    <InputField label="UTM source" name="utm_source" defaultValue={sp.utm_source ?? ''} placeholder="FB, GG, …" />
                    <InputField label="Desde" name="from" type="date" defaultValue={sp.from ?? ''} />
                    <InputField label="Hasta" name="to" type="date" defaultValue={sp.to ?? ''} />
                </div>
                <div className="flex justify-end gap-2 mt-3">
                    <Link
                        href="/report-utm/ventas"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/[0.04] transition-colors"
                    >
                        Limpiar
                    </Link>
                    <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-white shadow-sm"
                        style={{ background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)' }}
                    >
                        Aplicar
                    </button>
                </div>
            </form>

            {error && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                    <p className="text-[11px] font-mono text-amber-800 dark:text-amber-300">{error.message}</p>
                </div>
            )}

            {/* Tabla */}
            <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 overflow-hidden">
                {ventasList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-zinc-50 dark:bg-white/[0.02]">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                                    <th className="px-6 py-3">Fecha</th>
                                    <th className="px-6 py-3">Cliente</th>
                                    <th className="px-6 py-3">Comprador</th>
                                    <th className="px-6 py-3">Producto</th>
                                    <th className="px-6 py-3">Source</th>
                                    <th className="px-6 py-3">Campaign</th>
                                    <th className="px-6 py-3">Tipo</th>
                                    <th className="px-6 py-3">Status</th>
                                    <th className="px-6 py-3">Atribución</th>
                                    <th className="px-6 py-3 text-right">Monto</th>
                                    <th className="px-6 py-3"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.04]">
                                {ventasList.map((s) => (
                                    <tr key={s.id} className="hover:bg-zinc-50 dark:hover:bg-white/[0.02]">
                                        <td className="px-6 py-3 text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                                            {s.sale_timestamp
                                                ? new Date(s.sale_timestamp).toLocaleString()
                                                : '—'}
                                        </td>
                                        <td className="px-6 py-3">
                                            <Link
                                                href={`/report-utm/clientes/${s.cliente_id}`}
                                                className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                            >
                                                {clienteName.get(s.cliente_id) ?? s.cliente_id.slice(0, 8)}
                                            </Link>
                                        </td>
                                        <td className="px-6 py-3">
                                            <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                                                {s.customer_name ?? '—'}
                                            </p>
                                            {s.customer_email && (
                                                <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                                                    {s.customer_email}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                                            {s.product_name ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                                            {s.utm_source ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                                            {s.utm_campaign ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                                            {s.transaction_type ?? 'principal'}
                                        </td>
                                        <td className="px-6 py-3">
                                            <StatusPill status={s.status} />
                                        </td>
                                        <td className="px-6 py-3">
                                            <AttributionBadge method={s.attribution_method} />
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                                            {s.currency} {Number(s.amount).toFixed(2)}
                                        </td>
                                        <td className="px-6 py-3 text-right">
                                            <Link
                                                href={`/report-utm/ventas/${s.id}`}
                                                className="text-emerald-600 dark:text-emerald-400 hover:underline text-[11px] font-medium"
                                            >
                                                detalle →
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-16 text-center">
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-white/[0.04] mb-3">
                            <ShoppingBag className="h-5 w-5 text-zinc-400" />
                        </div>
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            Sin ventas {Object.keys(sp).length > 0 ? 'con esos filtros' : 'todavía'}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                            Configurá el webhook Hotmart en el detalle del cliente para empezar a recibir eventos.
                        </p>
                    </div>
                )}

                {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-zinc-100 dark:border-white/[0.04] text-xs text-zinc-500 dark:text-zinc-500">
                        <span>Página {page} de {totalPages}</span>
                        <div className="flex gap-2">
                            {page > 1 && (
                                <Link
                                    href={buildHref({ page: String(page - 1) })}
                                    className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/[0.04]"
                                >
                                    ← Anterior
                                </Link>
                            )}
                            {page < totalPages && (
                                <Link
                                    href={buildHref({ page: String(page + 1) })}
                                    className="px-2 py-1 rounded hover:bg-zinc-100 dark:hover:bg-white/[0.04]"
                                >
                                    Siguiente →
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {ventasList.length > 0 && (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-500 flex items-center gap-1.5">
                    <ExternalLink className="h-3 w-3" />
                    El campo <code className="font-mono px-1 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04]">raw_payload</code> guarda el JSON original completo recibido del webhook.
                </p>
            )}
        </div>
    )
}

function SelectField({
    label,
    name,
    defaultValue,
    children,
}: {
    label: string
    name: string
    defaultValue: string
    children: React.ReactNode
}) {
    return (
        <label className="block">
            <span className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">{label}</span>
            <select
                name={name}
                defaultValue={defaultValue}
                className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
            >
                {children}
            </select>
        </label>
    )
}

function InputField({
    label,
    name,
    defaultValue,
    placeholder,
    type = 'text',
}: {
    label: string
    name: string
    defaultValue: string
    placeholder?: string
    type?: string
}) {
    return (
        <label className="block">
            <span className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">{label}</span>
            <input
                type={type}
                name={name}
                defaultValue={defaultValue}
                placeholder={placeholder}
                className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-50 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
            />
        </label>
    )
}

function StatusPill({ status }: { status: string }) {
    const cls =
        status === 'approved'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            : status === 'pending'
            ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
    return (
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}>
            {status}
        </span>
    )
}
