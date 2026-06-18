import { notFound } from 'next/navigation'
import Link from 'next/link'
import { headers } from 'next/headers'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente, ReportUtmIntegration, ReportUtmSalesEvent } from '@/lib/report-utm/types'
import { HotmartIntegrationCard } from '@/components/report-utm/HotmartIntegrationCard'
import { CartPandaIntegrationCard } from '@/components/report-utm/CartPandaIntegrationCard'
import { ShopifyIntegrationCard } from '@/components/report-utm/ShopifyIntegrationCard'
import { GoogleAdsCard } from '@/components/report-utm/GoogleAdsCard'
import { MetaCAPICard } from '@/components/report-utm/MetaCAPICard'
import { MetaLeadsCard } from '@/components/report-utm/MetaLeadsCard'
import { S2SIntegrationCard } from '@/components/report-utm/S2SIntegrationCard'
import { OutboundWebhooksCard } from '@/components/report-utm/OutboundWebhooksCard'
import { createClient } from '@/utils/supabase/server'
import { ArrowLeft, ShoppingBag, DollarSign, TrendingUp, ExternalLink } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ClienteDetailPage({
    params,
}: {
    params: Promise<{ clienteId: string }>
}) {
    const { clienteId } = await params
    const supabase = await reportUtmClient()

    const [{ data: cliente }, { data: hotmart }, { data: cartpanda }, { data: shopify }, { data: metaIntegration }, { data: googleIntegration }, { data: s2s }, { data: metaLeads }, { data: ventas }, { count: totalCount }, { data: aggregate }, { data: outbound }] =
        await Promise.all([
            supabase.from('clientes').select('*').eq('id', clienteId).single<ReportUtmCliente>(),
            supabase
                .from('integrations')
                .select('*')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'hotmart')
                .maybeSingle<ReportUtmIntegration>(),
            supabase
                .from('integrations')
                .select('id, cliente_id, webhook_secret, status, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'cartpanda')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'cliente_id' | 'webhook_secret' | 'status' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('integrations')
                .select('id, cliente_id, webhook_secret, config, status, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'shopify')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'cliente_id' | 'webhook_secret' | 'config' | 'status' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('integrations')
                .select('id, status, config, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'meta')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'status' | 'config' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('integrations')
                .select('id, status, config, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'google')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'status' | 'config' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('integrations')
                .select('id, cliente_id, status, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 's2s')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'cliente_id' | 'status' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('integrations')
                .select('id, status, config, last_sync_at, last_error')
                .eq('cliente_id', clienteId)
                .eq('tipo', 'meta_lead_ads')
                .maybeSingle<Pick<ReportUtmIntegration, 'id' | 'status' | 'config' | 'last_sync_at' | 'last_error'>>(),
            supabase
                .from('sales_events')
                .select('id, sale_timestamp, amount, currency, status, customer_name, customer_email, utm_source, utm_campaign, product_name, transaction_type, platform_sale_id, attribution_method')
                .eq('cliente_id', clienteId)
                .order('sale_timestamp', { ascending: false, nullsFirst: false })
                .limit(10),
            supabase
                .from('sales_events')
                .select('id', { count: 'exact', head: true })
                .eq('cliente_id', clienteId),
            supabase
                .from('sales_events')
                .select('amount, status')
                .eq('cliente_id', clienteId)
                .eq('status', 'approved'),
            supabase
                .from('outbound_webhooks')
                .select('id, nombre, url, event_types, enabled, last_fired_at, last_status, last_error, success_count, failure_count')
                .eq('cliente_id', clienteId)
                .order('created_at', { ascending: false }),
        ])

    if (!cliente) notFound()

    // ¿El cliente tiene Meta conectado? (token + cuenta en public.clientes.config_api)
    let metaConnected = false
    if (cliente.public_cliente_id) {
        const base = await createClient()
        const { data: pub } = await base
            .from('clientes')
            .select('config_api')
            .eq('id', cliente.public_cliente_id)
            .maybeSingle()
        const cfg = (pub?.config_api ?? {}) as Record<string, unknown>
        const metaAccounts = cfg.meta_accounts
        const hasAccounts = Array.isArray(metaAccounts) &&
            (metaAccounts as Array<Record<string, unknown>>).some((a) => a?.account_id && (a.token || cfg.meta_token))
        const hasLegacy = Boolean(cfg.meta_token && cfg.meta_account_id)
        metaConnected = hasAccounts || hasLegacy
    }

    const totalRevenue =
        (aggregate ?? []).reduce((sum, r) => sum + Number((r as { amount: number }).amount ?? 0), 0)
    const approvedCount = (aggregate ?? []).length
    const aov = approvedCount > 0 ? totalRevenue / approvedCount : 0

    // Origin para construir URL del webhook (server-side)
    const hdrs = await headers()
    const proto = hdrs.get('x-forwarded-proto') ?? 'http'
    const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'localhost:3000'
    const webhookOrigin = `${proto}://${host}`

    const ventasList = (ventas ?? []) as Array<Pick<ReportUtmSalesEvent,
        'id' | 'sale_timestamp' | 'amount' | 'currency' | 'status' | 'customer_name' |
        'customer_email' | 'utm_source' | 'utm_campaign' | 'product_name' | 'transaction_type' | 'platform_sale_id'
    >>

    return (
        <div className="space-y-8">
            <div>
                <Link
                    href="/report-utm/clientes"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Clientes
                </Link>
                <div className="flex items-end justify-between gap-4 flex-wrap mt-2">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            {cliente.nombre}
                        </h1>
                        <p className="text-xs font-mono text-muted-foreground mt-1">
                            {cliente.slug} · {cliente.id}
                        </p>
                    </div>
                    <Link
                        href={`/report-utm/ventas?clienteId=${cliente.id}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                    >
                        Ver todas las ventas <ExternalLink className="h-3 w-3" />
                    </Link>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Stat label="Eventos totales" value={String(totalCount ?? 0)} icon={ShoppingBag} />
                <Stat
                    label="Revenue aprobado"
                    value={`${cliente.config?.currency ?? 'BRL'} ${totalRevenue.toFixed(2)}`}
                    icon={DollarSign}
                />
                <Stat label="Ticket promedio" value={`${aov.toFixed(2)}`} icon={TrendingUp} />
            </div>

            {/* Integrations */}
            <HotmartIntegrationCard
                clienteId={cliente.id}
                integration={hotmart}
                webhookOrigin={webhookOrigin}
            />

            <CartPandaIntegrationCard
                clienteId={cliente.id}
                integration={cartpanda ?? null}
                webhookOrigin={webhookOrigin}
            />

            <ShopifyIntegrationCard
                clienteId={cliente.id}
                integration={shopify ?? null}
                webhookOrigin={webhookOrigin}
            />

            <MetaCAPICard
                clienteId={cliente.id}
                integration={metaIntegration ?? null}
            />

            <MetaLeadsCard
                clienteId={cliente.id}
                integration={metaLeads ?? null}
                metaConnected={metaConnected}
            />

            <GoogleAdsCard
                clienteId={cliente.id}
                integration={googleIntegration ?? null}
            />

            <S2SIntegrationCard
                clienteId={cliente.id}
                integration={s2s ?? null}
            />

            {/* Outbound webhooks */}
            <OutboundWebhooksCard
                clienteId={cliente.id}
                webhooks={(outbound ?? []) as Parameters<typeof OutboundWebhooksCard>[0]['webhooks']}
            />

            {/* Recent sales */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border">
                    <h2 className="text-sm font-semibold text-foreground">
                        Ventas recientes
                    </h2>
                </div>
                {ventasList.length > 0 ? (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/60">
                                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    <th className="px-6 py-3">Fecha</th>
                                    <th className="px-6 py-3">Cliente</th>
                                    <th className="px-6 py-3">Producto</th>
                                    <th className="px-6 py-3">UTM</th>
                                    <th className="px-6 py-3">Tipo</th>
                                    <th className="px-6 py-3">Status</th>
                                    <th className="px-6 py-3 text-right">Monto</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {ventasList.map((s) => (
                                    <tr key={s.id} className="hover:bg-accent">
                                        <td className="px-6 py-3 text-xs text-muted-foreground">
                                            {s.sale_timestamp
                                                ? new Date(s.sale_timestamp).toLocaleString()
                                                : '—'}
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
                                        <td className="px-6 py-3 text-xs">
                                            <p className="font-mono text-emerald-600 dark:text-emerald-400">
                                                {s.utm_source ?? '—'}
                                            </p>
                                            {s.utm_campaign && (
                                                <p className="text-[11px] text-muted-foreground font-mono">
                                                    {s.utm_campaign}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-6 py-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                                            {s.transaction_type ?? 'principal'}
                                        </td>
                                        <td className="px-6 py-3">
                                            <StatusPill status={s.status} />
                                        </td>
                                        <td className="px-6 py-3 text-right text-xs font-semibold text-foreground">
                                            {s.currency} {Number(s.amount).toFixed(2)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                        Sin ventas recibidas todavía. Configurá el webhook arriba para empezar a recibir eventos.
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
    value: string
    icon: typeof ShoppingBag
}) {
    return (
        <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                    <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
            </div>
            <p className="mt-3 text-2xl font-bold text-foreground">{value}</p>
        </div>
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
