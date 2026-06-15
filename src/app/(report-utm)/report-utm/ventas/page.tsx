import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente, ReportUtmSalesEvent } from '@/lib/report-utm/types'
import { ShoppingBag, ExternalLink, Filter } from 'lucide-react'
import { AttributionBadge } from '@/components/report-utm/AttributionBadge'
import { StatusBadge } from '@/components/report-utm/StatusBadge'
import { formatCurrency, formatDateTime } from '@/lib/report-utm/formatters'

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
                    <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
                        Ventas
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Eventos de venta crudos recibidos por webhook. {total.toLocaleString()} eventos
                        {sp.clienteId ? ' (filtrados)' : ' totales'}.
                    </p>
                </div>
            </div>

            {/* Filtros */}
            <form
                method="GET"
                className="rounded-2xl border border-border bg-card p-4"
            >
                <div className="flex items-center gap-2 mb-3">
                    <Filter className="h-4 w-4 text-muted-foreground" />
                    <p className="text-xs font-medium text-muted-foreground">Filtros</p>
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
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors"
                    >
                        Limpiar
                    </Link>
                    <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-white shadow-sm nav-active-emerald"
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
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                {ventasList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/60">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                            <tbody className="divide-y divide-border">
                                {ventasList.map((s) => (
                                    <tr key={s.id} className="hover:bg-accent">
                                        <td className="px-6 py-3 text-xs text-muted-foreground whitespace-nowrap">
                                            {formatDateTime(s.sale_timestamp)}
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
                                            <p className="text-xs font-medium text-foreground">
                                                {s.customer_name ?? '—'}
                                            </p>
                                            {s.customer_email && (
                                                <p className="text-[11px] text-muted-foreground">
                                                    {s.customer_email}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-xs text-muted-foreground">
                                            {s.product_name ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                                            {s.utm_source ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-xs font-mono text-muted-foreground">
                                            {s.utm_campaign ?? '—'}
                                        </td>
                                        <td className="px-6 py-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                                            {s.transaction_type ?? 'principal'}
                                        </td>
                                        <td className="px-6 py-3">
                                            <StatusBadge status={s.status} />
                                        </td>
                                        <td className="px-6 py-3">
                                            <AttributionBadge method={s.attribution_method} />
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs font-mono font-semibold text-foreground whitespace-nowrap tabular-nums">
                                            {formatCurrency(s.amount, s.currency)}
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
                        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-3">
                            <ShoppingBag className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium text-foreground/90">
                            Sin ventas {Object.keys(sp).length > 0 ? 'con esos filtros' : 'todavía'}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                            Configurá el webhook Hotmart en el detalle del cliente para empezar a recibir eventos.
                        </p>
                    </div>
                )}

                {totalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-border text-xs text-muted-foreground">
                        <span>Página {page} de {totalPages}</span>
                        <div className="flex gap-2">
                            {page > 1 && (
                                <Link
                                    href={buildHref({ page: String(page - 1) })}
                                    className="px-2 py-1 rounded hover:bg-accent"
                                >
                                    ← Anterior
                                </Link>
                            )}
                            {page < totalPages && (
                                <Link
                                    href={buildHref({ page: String(page + 1) })}
                                    className="px-2 py-1 rounded hover:bg-accent"
                                >
                                    Siguiente →
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {ventasList.length > 0 && (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    <ExternalLink className="h-3 w-3" />
                    El campo <code className="font-mono px-1 py-0.5 rounded bg-muted">raw_payload</code> guarda el JSON original completo recibido del webhook.
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
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</span>
            <select
                name={name}
                defaultValue={defaultValue}
                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
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
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</span>
            <input
                type={type}
                name={name}
                defaultValue={defaultValue}
                placeholder={placeholder}
                className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-colors"
            />
        </label>
    )
}

