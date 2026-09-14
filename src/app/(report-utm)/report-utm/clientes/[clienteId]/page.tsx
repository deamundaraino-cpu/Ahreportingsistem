import { notFound } from 'next/navigation';
import Link from 'next/link';
import { reportUtmClient } from '@/lib/report-utm/client';
import type { ReportUtmCliente, ReportUtmSalesEvent } from '@/lib/report-utm/types';
import { BiClienteBrandingCard } from '@/components/report-utm/BiClienteBrandingCard';
import { BiClienteGoalsCard } from '@/components/report-utm/BiClienteGoalsCard';
import { LeadCamposCard } from '@/components/report-utm/LeadCamposCard';
import { FiltroAtribucionCard } from '@/components/report-utm/FiltroAtribucionCard';
import { ConexionesCliente } from '@/components/report-utm/ConexionesCliente';
import { MonedaReporteCard } from '@/components/report-utm/MonedaReporteCard';
import { leerMonedaReporte, ultimasTasasGuardadas } from '@/lib/moneda-reporte';
import { createAdminClient } from '@/utils/supabase/server';
import { columnaExcluidoDisponible, leerRegla } from '@/lib/report-utm/lead-exclusion';
import type { ClienteGoals } from '@/lib/report-utm/bi-metadata';
import {
  ArrowLeft,
  ShoppingBag,
  DollarSign,
  TrendingUp,
  ExternalLink,
  PlugZap,
  CircleCheck,
  CircleAlert,
  CirclePause,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

const NOMBRE_INTEGRACION: Record<string, string> = {
  hotmart: 'Hotmart (webhook)',
  meta: 'Meta CAPI',
  google: 'Google Ads',
  s2s: 'Formulario web (S2S)',
  meta_lead_ads: 'Meta Lead Ads',
  gohighlevel: 'GoHighLevel',
};

export default async function ClienteDetailPage({
  params,
}: {
  params: Promise<{ clienteId: string }>;
}) {
  const { clienteId } = await params;
  const supabase = await reportUtmClient();

  const [
    { data: cliente },
    { data: integraciones },
    { data: ventas },
    { count: totalCount },
    { data: aggregate },
  ] = await Promise.all([
    supabase.from('clientes').select('*').eq('id', clienteId).single<ReportUtmCliente>(),
    supabase
      .from('integrations')
      .select('tipo, status, last_error, last_sync_at')
      .eq('cliente_id', clienteId)
      .order('tipo'),
    supabase
      .from('sales_events')
      .select(
        'id, sale_timestamp, amount, currency, status, customer_name, customer_email, utm_source, utm_campaign, product_name, transaction_type, platform_sale_id, attribution_method'
      )
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
  ]);

  if (!cliente) notFound();

  const totalRevenue = (aggregate ?? []).reduce(
    (sum, r) => sum + Number((r as { amount: number }).amount ?? 0),
    0
  );
  const approvedCount = (aggregate ?? []).length;
  const aov = approvedCount > 0 ? totalRevenue / approvedCount : 0;

  const ventasList = (ventas ?? []) as Array<
    Pick<
      ReportUtmSalesEvent,
      | 'id'
      | 'sale_timestamp'
      | 'amount'
      | 'currency'
      | 'status'
      | 'customer_name'
      | 'customer_email'
      | 'utm_source'
      | 'utm_campaign'
      | 'product_name'
      | 'transaction_type'
      | 'platform_sale_id'
    >
  >;

  const integs = (integraciones ?? []) as Array<{
    tipo: string;
    status: string;
    last_error: string | null;
    last_sync_at: string | null;
  }>;

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
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{cliente.nombre}</h1>
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

      {/* Conexiones: un solo lugar. Con el cliente enlazado al reporting, se
          configuran en su ficha de Ajustes (junto a Meta, GA4, Hotmart y TikTok);
          aquí queda el estado. Un cliente sin enlace no tiene esa ficha, así que
          sus conexiones siguen aquí para no dejarlo sin forma de gestionarlas. */}
      {cliente.public_cliente_id ? (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <PlugZap className="h-4 w-4 text-emerald-500" />
                <h2 className="text-sm font-semibold text-foreground">Conexiones</h2>
              </div>
              <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                Todas las conexiones de este cliente —Meta, formularios instantáneos, GoHighLevel,
                Hotmart, GA4, TikTok y Sheets— se configuran en un solo lugar: su ficha de ajustes.
              </p>
            </div>
            <Link
              href={`/admin/settings/${cliente.public_cliente_id}#conexiones`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white nav-active-emerald"
            >
              Configurar conexiones <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          {integs.length > 0 ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {integs.map((i) => (
                <li
                  key={i.tipo}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs"
                >
                  {i.last_error ? (
                    <CircleAlert className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  ) : i.status === 'active' ? (
                    <CircleCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <CirclePause className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-medium text-foreground">
                    {NOMBRE_INTEGRACION[i.tipo] ?? i.tipo}
                  </span>
                  <span className="text-muted-foreground">
                    · {i.status === 'active' ? 'activa' : 'pausada'}
                  </span>
                  {i.last_error && (
                    <span
                      className="ml-auto truncate text-amber-600 dark:text-amber-400"
                      title={i.last_error}
                    >
                      {i.last_error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Sin conexiones de captación todavía.</p>
          )}
        </div>
      ) : (
        <ConexionesCliente rtmClienteId={cliente.id} publicClienteId={null} />
      )}

      {/* Moneda de reporte: Hotmart en la moneda del cliente (reunión del 2026-09-08) */}
      <MonedaReporteCard
        rtmClienteId={cliente.id}
        inicial={leerMonedaReporte(cliente.config)}
        // `fx_rates` vive en `public`: el cliente de esta página es de report_utm.
        ultimasTasas={await ultimasTasasGuardadas(await createAdminClient())}
      />

      {/* Qué leads cuentan: regla de exclusión (reunión del 2026-09-08) */}
      <FiltroAtribucionCard
        clienteId={cliente.id}
        inicial={leerRegla(cliente.config)}
        migracionAplicada={await columnaExcluidoDisponible(supabase)}
      />

      {/* Campos de formulario convertidos en dimensiones de los informes */}
      <LeadCamposCard clienteId={cliente.id} />

      {/* Metas del cliente (semáforos de los scorecards en los informes) */}
      <BiClienteGoalsCard
        clienteId={cliente.id}
        initialGoals={(cliente.config?.goals ?? {}) as ClienteGoals}
      />

      {/* Branding de informes (logo + color para la vista pública del cliente) */}
      <BiClienteBrandingCard
        clienteId={cliente.id}
        initialLogoUrl={
          typeof cliente.config?.logo_url === 'string' ? cliente.config.logo_url : undefined
        }
        initialAccent={
          typeof cliente.config?.accent === 'string' ? cliente.config.accent : undefined
        }
      />

      {/* Recent sales */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Ventas recientes</h2>
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
                      {s.sale_timestamp ? new Date(s.sale_timestamp).toLocaleString() : '—'}
                    </td>
                    <td className="px-6 py-3">
                      <p className="text-xs font-medium text-foreground">
                        {s.customer_name ?? '—'}
                      </p>
                      {s.customer_email && (
                        <p className="text-[11px] text-muted-foreground">{s.customer_email}</p>
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
            Sin ventas recibidas todavía. Llegan por el webhook de Hotmart o por el de venta de
            GoHighLevel.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof ShoppingBag;
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
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'approved'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
      : status === 'pending'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
        : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400';
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}
    >
      {status}
    </span>
  );
}
