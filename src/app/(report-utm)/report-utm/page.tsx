import Link from 'next/link';
import { reportUtmClient } from '@/lib/report-utm/client';
import type { ReportUtmCliente } from '@/lib/report-utm/types';
import { Users, ShoppingBag, Link2, Activity, ArrowRight } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function ReportUtmOverview() {
  const supabase = await reportUtmClient();

  // eslint-disable-next-line react-hooks/purity -- Server Component asíncrono: se evalúa una vez por request
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [
    { data: clientes, error },
    { count: totalEvents },
    { data: revenue7d },
    { data: linksAgg },
  ] = await Promise.all([
    supabase
      .from('clientes')
      .select('id, nombre, slug, status, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('sales_events').select('id', { count: 'exact', head: true }),
    supabase
      .from('sales_events')
      .select('amount')
      .eq('status', 'approved')
      .gte('received_at', sevenDaysAgo),
    supabase.from('tracking_links').select('clicks_count', { count: 'exact' }),
  ]);

  const totalClientes = clientes?.length ?? 0;
  const eventsCount = totalEvents ?? 0;
  const revenueLast7d = (revenue7d ?? []).reduce(
    (s, r) => s + Number((r as { amount: number }).amount ?? 0),
    0
  );
  const totalLinks = linksAgg?.length ?? 0;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
          Workspace · Tracking
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">Report-UTM</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          Panel separado del reporting principal. Tracking de ventas evento-a-evento, atribución por
          UTM, tracking links cortos y pixel propio. Mismos clientes pueden o no estar en ambos
          workspaces.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            <strong>Schema no expuesto.</strong> Asegurate de:
          </p>
          <ol className="mt-2 ml-4 list-decimal text-xs text-amber-700 dark:text-amber-400 space-y-1">
            <li>
              Correr la migration <code>012_report_utm_schema.sql</code> en Supabase.
            </li>
            <li>
              Agregar <code>report_utm</code> en Supabase Studio → Settings → API → Exposed schemas.
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-500 font-mono">
            {error.message}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Clientes" value={totalClientes} icon={Users} accent="emerald" />
        <StatCard
          label="Ventas trackeadas"
          value={eventsCount.toLocaleString()}
          icon={ShoppingBag}
          accent="violet"
        />
        <StatCard
          label="Revenue (7d)"
          value={`$${revenueLast7d.toFixed(0)}`}
          icon={Activity}
          accent="emerald"
          hint="aprobado"
        />
        <StatCard
          label="Tracking links"
          value={totalLinks}
          icon={Link2}
          accent="violet"
          hint={totalLinks === 0 ? 'Fase 3' : undefined}
        />
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-foreground">Clientes recientes</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Clientes propios del módulo (separados del reporting principal)
            </p>
          </div>
          <Link
            href="/report-utm/clientes"
            className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            Ver todos <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {clientes && clientes.length > 0 ? (
          <ul className="divide-y divide-border">
            {(clientes as ReportUtmCliente[]).map((c) => (
              <li key={c.id}>
                <Link
                  href={`/report-utm/clientes/${c.id}`}
                  className="flex items-center justify-between px-6 py-4 hover:bg-accent transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{c.nombre}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">{c.slug}</p>
                  </div>
                  <StatusPill status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">Aún no hay clientes en el módulo.</p>
            <Link
              href="/report-utm/clientes"
              className="inline-flex items-center gap-1.5 mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
            >
              Crear el primero <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-muted/40 p-6">
        <h3 className="text-sm font-semibold text-foreground">Roadmap del módulo</h3>
        <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
          <li className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            <strong>Fase 0 — Esqueleto.</strong> Schema + clientes propios + navegación. (en curso)
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/30" />
            <strong>Fase 1 — Ingesta.</strong> Webhook Hotmart con HMAC, dedup, sales_events.
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/30" />
            <strong>Fase 2 — Dashboard UTM.</strong> Métricas, charts, atribución.
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/30" />
            <strong>Fase 3 — Tracking links + Pixel.</strong> Links cortos, pixel JS, atribución
            multi-touch.
          </li>
        </ul>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: string | number;
  icon: typeof Users;
  accent: 'emerald' | 'violet';
  hint?: string;
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-500 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10'
      : 'text-violet-500 dark:text-violet-400 bg-violet-50 dark:bg-violet-500/10';

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${accentClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value}</p>
      {hint && (
        <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
      : status === 'paused'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}
    >
      {status}
    </span>
  );
}
