import Link from 'next/link'
import { notFound } from 'next/navigation'
import { reportUtmClient } from '@/lib/report-utm/client'
import { AttributionBadge } from '@/components/report-utm/AttributionBadge'
import { ArrowLeft, Send, ShoppingBag, MousePointerClick, Eye, AlertCircle } from 'lucide-react'

export const dynamic = 'force-dynamic'

type Touch = {
    source: string | null
    medium: string | null
    campaign: string | null
    content: string | null
    term: string | null
    click_id: string | null
    referrer: string | null
    page_url: string | null
    ts: string
}

type Sale = {
    id: string
    cliente_id: string
    platform: string
    platform_sale_id: string
    amount: number | string
    currency: string
    status: string
    transaction_type: string | null
    product_name: string | null
    customer_name: string | null
    customer_email: string | null
    customer_phone: string | null
    customer_country: string | null
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    click_id: string | null
    visitor_id: string | null
    first_touch: Touch | null
    last_touch: Touch | null
    attribution_method: string | null
    attribution_resolved_at: string | null
    sale_timestamp: string | null
    received_at: string
}

export default async function SaleDetailPage({
    params,
}: {
    params: Promise<{ saleId: string }>
}) {
    const { saleId } = await params
    const supabase = await reportUtmClient()

    const { data: sale } = await supabase
        .from('sales_events')
        .select('*')
        .eq('id', saleId)
        .maybeSingle<Sale>()

    if (!sale) notFound()

    // Cargar journey: si tenemos visitor_id, traer pixel_events de ese visitor
    let journey: Array<{
        id: string
        event_type: string
        event_name: string | null
        page_url: string | null
        utm_source: string | null
        utm_campaign: string | null
        click_id: string | null
        created_at: string
    }> = []

    if (sale.visitor_id) {
        const { data: events } = await supabase
            .from('pixel_events')
            .select('id, event_type, event_name, page_url, utm_source, utm_campaign, click_id, created_at')
            .eq('cliente_id', sale.cliente_id)
            .eq('visitor_id', sale.visitor_id)
            .order('created_at', { ascending: true })
            .limit(100)
        journey = (events ?? []) as typeof journey
    }

    const { data: cliente } = await supabase
        .from('clientes')
        .select('id, nombre')
        .eq('id', sale.cliente_id)
        .single()

    // Deliveries de outbound webhooks asociadas a esta venta
    const { data: deliveries } = await supabase
        .from('outbound_deliveries')
        .select('id, event_type, response_status, error, duration_ms, created_at, webhook_id')
        .eq('sale_event_id', saleId)
        .order('created_at', { ascending: false })

    return (
        <div className="space-y-6">
            <div>
                <Link
                    href="/report-utm/ventas"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Ventas
                </Link>
                <div className="flex items-end justify-between gap-4 flex-wrap mt-2">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            {sale.customer_name ?? 'Venta sin nombre'}
                        </h1>
                        <p className="text-xs text-muted-foreground mt-1 font-mono">
                            {sale.platform} · {sale.platform_sale_id} · {sale.id.slice(0, 8)}
                        </p>
                    </div>
                    <AttributionBadge method={sale.attribution_method} />
                </div>
            </div>

            {/* Resumen */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-foreground">Venta</h2>
                    <KV label="Monto" value={`${sale.currency} ${Number(sale.amount).toFixed(2)}`} bold />
                    <KV label="Status" value={sale.status} />
                    <KV label="Tipo" value={sale.transaction_type ?? 'principal'} />
                    <KV label="Producto" value={sale.product_name ?? '—'} />
                    <KV
                        label="Fecha"
                        value={
                            sale.sale_timestamp
                                ? new Date(sale.sale_timestamp).toLocaleString()
                                : new Date(sale.received_at).toLocaleString()
                        }
                    />
                    <KV label="Cliente" value={cliente?.nombre ?? sale.cliente_id} />
                </div>

                <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-foreground">Comprador</h2>
                    <KV label="Nombre" value={sale.customer_name ?? '—'} />
                    <KV label="Email" value={sale.customer_email ?? '—'} mono />
                    <KV label="Teléfono" value={sale.customer_phone ?? '—'} mono />
                    <KV label="País" value={sale.customer_country ?? '—'} />
                </div>
            </div>

            {/* First & Last Touch */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <TouchCard label="First-touch" touch={sale.first_touch} accent="emerald" />
                {/* `last_touch` se guarda NULL cuando coincide con el first (ver
                    dedupTouches en attribution-resolver): NULL significa "el mismo". */}
                <TouchCard label="Last-touch" touch={sale.last_touch ?? sale.first_touch} accent="violet" />
            </div>

            {/* Visitor journey */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">
                        Journey del visitor
                    </h2>
                    {sale.visitor_id ? (
                        <p className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                            visitor_id: {sale.visitor_id}
                        </p>
                    ) : (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                            Sin visitor_id resuelto — no hay cruce con pixel_events.
                        </p>
                    )}
                </div>
                {journey.length > 0 ? (
                    <ol className="relative px-6 py-5 space-y-4">
                        <div className="absolute left-9 top-7 bottom-7 w-px bg-muted" />
                        {journey.map((e, i) => {
                            const Icon =
                                e.event_type === 'pageview'
                                    ? Eye
                                    : e.event_type === 'click'
                                    ? MousePointerClick
                                    : Send
                            return (
                                <li key={e.id} className="relative flex gap-4">
                                    <div
                                        className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background ${
                                            e.event_type === 'click'
                                                ? 'bg-emerald-500'
                                                : e.event_type === 'pageview'
                                                ? 'bg-blue-500'
                                                : 'bg-violet-500'
                                        }`}
                                    >
                                        <Icon className="h-3.5 w-3.5 text-white" />
                                    </div>
                                    <div className="flex-1 min-w-0 pt-0.5">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                                #{i + 1} · {e.event_type}
                                                {e.event_name ? ` · ${e.event_name}` : ''}
                                            </span>
                                            <span className="text-[10px] text-muted-foreground/70">
                                                {new Date(e.created_at).toLocaleString()}
                                            </span>
                                        </div>
                                        {e.page_url && (
                                            <p className="text-xs text-foreground/90 mt-0.5 truncate">
                                                {e.page_url}
                                            </p>
                                        )}
                                        {(e.utm_source || e.click_id) && (
                                            <p className="text-[11px] font-mono mt-1">
                                                {e.utm_source && (
                                                    <span className="text-emerald-600 dark:text-emerald-400">
                                                        {e.utm_source}
                                                        {e.utm_campaign ? ` / ${e.utm_campaign}` : ''}
                                                    </span>
                                                )}
                                                {e.click_id && (
                                                    <span className="text-muted-foreground ml-2">
                                                        click_id: {e.click_id.slice(0, 20)}…
                                                    </span>
                                                )}
                                            </p>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                        <li className="relative flex gap-4">
                            <div className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-amber-500">
                                <ShoppingBag className="h-3.5 w-3.5 text-white" />
                            </div>
                            <div className="flex-1 pt-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                                    venta · {sale.currency} {Number(sale.amount).toFixed(2)}
                                </span>
                                <p className="text-xs text-foreground/90 mt-0.5">
                                    {sale.product_name ?? sale.platform}
                                </p>
                            </div>
                        </li>
                    </ol>
                ) : (
                    <div className="px-6 py-8 text-center text-xs text-muted-foreground">
                        Sin eventos del pixel cruzados con esta venta.
                    </div>
                )}
            </div>

            {/* Deliveries */}
            {deliveries && deliveries.length > 0 && (
                <div className="rounded-2xl border border-border bg-card overflow-hidden">
                    <div className="px-6 py-4 border-b border-border">
                        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                            <Send className="h-4 w-4 text-violet-500" />
                            Outbound webhooks emitidos
                        </h2>
                    </div>
                    <table className="w-full">
                        <thead className="bg-muted/60">
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                <th className="px-4 py-2">Hora</th>
                                <th className="px-4 py-2">Evento</th>
                                <th className="px-4 py-2">Status</th>
                                <th className="px-4 py-2 text-right">Duración</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {(deliveries as Array<{
                                id: string
                                event_type: string
                                response_status: number | null
                                error: string | null
                                duration_ms: number | null
                                created_at: string
                            }>).map((d) => {
                                const ok = d.response_status && d.response_status >= 200 && d.response_status < 300
                                return (
                                    <tr key={d.id}>
                                        <td className="px-4 py-2 text-[11px] text-muted-foreground">
                                            {new Date(d.created_at).toLocaleTimeString()}
                                        </td>
                                        <td className="px-4 py-2 text-xs font-mono text-violet-600 dark:text-violet-400">
                                            {d.event_type}
                                        </td>
                                        <td className="px-4 py-2 text-xs">
                                            <span
                                                className={`font-mono ${
                                                    ok
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : 'text-red-600 dark:text-red-400'
                                                }`}
                                            >
                                                {d.response_status ?? 'fail'}
                                            </span>
                                            {d.error && (
                                                <p className="text-[10px] text-red-500 truncate max-w-[20ch]" title={d.error}>
                                                    <AlertCircle className="h-2.5 w-2.5 inline mr-0.5" />
                                                    {d.error}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-2 text-right text-[11px] text-muted-foreground font-mono">
                                            {d.duration_ms != null ? `${d.duration_ms}ms` : '—'}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function KV({ label, value, mono, bold }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-4">
            <span className="text-[11px] text-muted-foreground">{label}</span>
            <span
                className={`text-xs text-right text-foreground ${
                    mono ? 'font-mono' : ''
                } ${bold ? 'font-bold text-base' : ''}`}
            >
                {value}
            </span>
        </div>
    )
}

function TouchCard({
    label,
    touch,
    accent,
}: {
    label: string
    touch: Touch | null
    accent: 'emerald' | 'violet'
}) {
    const cls = accent === 'emerald'
        ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10'
        : 'text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-500/10'
    return (
        <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
                <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${cls}`}
                >
                    {label}
                </span>
                {touch?.ts && (
                    <span className="text-[10px] text-muted-foreground">
                        {new Date(touch.ts).toLocaleString()}
                    </span>
                )}
            </div>
            {touch ? (
                <div className="space-y-1.5 text-xs">
                    <KV label="source" value={touch.source ?? '—'} mono />
                    <KV label="medium" value={touch.medium ?? '—'} mono />
                    <KV label="campaign" value={touch.campaign ?? '—'} mono />
                    <KV label="content" value={touch.content ?? '—'} mono />
                    {touch.click_id && <KV label="click_id" value={touch.click_id.slice(0, 24) + '…'} mono />}
                    {touch.referrer && (
                        <KV label="referrer" value={touch.referrer.slice(0, 30)} mono />
                    )}
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">Sin datos.</p>
            )}
        </div>
    )
}
