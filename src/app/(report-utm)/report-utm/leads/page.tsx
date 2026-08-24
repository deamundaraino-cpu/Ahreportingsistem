import Link from 'next/link';
import { reportUtmClient } from '@/lib/report-utm/client';
import type { ReportUtmLeadEvent } from '@/lib/report-utm/types';
import {
  UserCheck,
  Filter,
  ChevronLeft,
  ChevronRight,
  Download,
  Megaphone,
  Film,
  Radio,
} from 'lucide-react';
import { LeadsView } from '@/components/report-utm/LeadsView';
import { PLUGIN_LABELS, dec } from '@/lib/report-utm/leads-display';
import { colombiaRangeBounds } from '@/lib/colombia-date';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const STATS_CAP = 5000; // tope de filas para los agregados de las tarjetas

type SearchParams = {
  clienteId?: string;
  utm_source?: string;
  utm_campaign?: string;
  utm_content?: string;
  form_plugin?: string;
  from?: string;
  to?: string;
  page?: string;
};

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const supabase = await reportUtmClient();

  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Clientes para el selector
  const { data: clientes } = await supabase
    .from('clientes')
    .select('id, nombre, slug')
    .order('nombre');

  // Página actual de leads
  let leadsQuery = supabase.from('lead_events').select(
    // Sin `first_touch`/`last_touch`: LeadsView no los pinta y son las dos
    // columnas más pesadas de la tabla (~836 B por fila).
    'id, cliente_id, form_name, form_id, form_plugin, lead_name, lead_email, lead_phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, visitor_id, page_url, ip_country, attribution_method, raw_fields, source, created_at',
    { count: 'exact' }
  );
  if (sp.clienteId) leadsQuery = leadsQuery.eq('cliente_id', sp.clienteId);
  if (sp.form_plugin) leadsQuery = leadsQuery.eq('form_plugin', sp.form_plugin);
  if (sp.utm_source) leadsQuery = leadsQuery.ilike('utm_source', `%${sp.utm_source}%`);
  if (sp.utm_campaign) leadsQuery = leadsQuery.ilike('utm_campaign', `%${sp.utm_campaign}%`);
  if (sp.utm_content) leadsQuery = leadsQuery.ilike('utm_content', `%${sp.utm_content}%`);
  // Día calendario Colombia, igual que el motor del BI: si esta página usara
  // otra ventana, su total y el del informe no cuadrarían y parecería un bug.
  if (sp.from)
    leadsQuery = leadsQuery.gte('created_at', colombiaRangeBounds(sp.from, sp.to ?? sp.from).gte);
  if (sp.to)
    leadsQuery = leadsQuery.lt('created_at', colombiaRangeBounds(sp.from ?? sp.to, sp.to).lt);

  const { data: leads, count } = await leadsQuery
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // Agregados para las tarjetas resumen (sobre todo el set filtrado, con tope)
  let statsQuery = supabase.from('lead_events').select('utm_source, utm_campaign, utm_content');
  if (sp.clienteId) statsQuery = statsQuery.eq('cliente_id', sp.clienteId);
  if (sp.form_plugin) statsQuery = statsQuery.eq('form_plugin', sp.form_plugin);
  if (sp.utm_source) statsQuery = statsQuery.ilike('utm_source', `%${sp.utm_source}%`);
  if (sp.utm_campaign) statsQuery = statsQuery.ilike('utm_campaign', `%${sp.utm_campaign}%`);
  if (sp.utm_content) statsQuery = statsQuery.ilike('utm_content', `%${sp.utm_content}%`);
  // Día calendario Colombia, igual que el motor del BI: si esta página usara
  // otra ventana, su total y el del informe no cuadrarían y parecería un bug.
  if (sp.from)
    statsQuery = statsQuery.gte('created_at', colombiaRangeBounds(sp.from, sp.to ?? sp.from).gte);
  if (sp.to)
    statsQuery = statsQuery.lt('created_at', colombiaRangeBounds(sp.from ?? sp.to, sp.to).lt);

  const { data: statsRows } = await statsQuery.limit(STATS_CAP);
  const stats = computeStats((statsRows as StatsRow[]) ?? []);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clienteMap: Record<string, string> = Object.fromEntries(
    (clientes ?? []).map((c) => [c.id, c.nombre])
  );

  const buildUrl = (params: Record<string, string | undefined>) => {
    const base: Record<string, string> = {};
    if (sp.clienteId) base.clienteId = sp.clienteId;
    if (sp.utm_source) base.utm_source = sp.utm_source;
    if (sp.utm_campaign) base.utm_campaign = sp.utm_campaign;
    if (sp.utm_content) base.utm_content = sp.utm_content;
    if (sp.form_plugin) base.form_plugin = sp.form_plugin;
    if (sp.from) base.from = sp.from;
    if (sp.to) base.to = sp.to;
    const merged = { ...base, ...params };
    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join('&');
    return `/report-utm/leads${qs ? '?' + qs : ''}`;
  };

  // Mismos filtros para la exportación CSV
  const exportQs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== 'page') exportQs.set(k, v);
  }
  const exportUrl = `/api/report-utm/leads/export${exportQs.toString() ? '?' + exportQs : ''}`;

  const hasFilters = Boolean(
    sp.clienteId ||
    sp.utm_source ||
    sp.utm_campaign ||
    sp.utm_content ||
    sp.form_plugin ||
    sp.from ||
    sp.to
  );

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
            {total.toLocaleString()} registros · Página {page} de {totalPages}
          </p>
        </div>
        {total > 0 && (
          <a
            href={exportUrl}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Exportar CSV
          </a>
        )}
      </div>

      {/* Tarjetas resumen */}
      {total > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<UserCheck className="h-4 w-4" />}
            label="Total leads"
            value={total.toLocaleString()}
            hint={
              statsRows && statsRows.length >= STATS_CAP ? `Resumen sobre ${STATS_CAP}` : undefined
            }
          />
          <StatCard
            icon={<Radio className="h-4 w-4" />}
            label="Fuente principal"
            value={stats.topSource?.[0] ?? '—'}
            hint={
              stats.topSource
                ? `${stats.topSource[1]} leads · ${stats.sourceCount} fuentes`
                : undefined
            }
          />
          <StatCard
            icon={<Megaphone className="h-4 w-4" />}
            label="Campañas"
            value={String(stats.campaignCount)}
            hint={stats.topCampaign ? `Top: ${truncate(stats.topCampaign[0], 28)}` : undefined}
          />
          <StatCard
            icon={<Film className="h-4 w-4" />}
            label="Creativo top"
            value={stats.topContent ? truncate(stats.topContent[0], 18) : '—'}
            hint={
              stats.topContent
                ? `${stats.topContent[1]} leads · ${stats.contentCount} creativos`
                : undefined
            }
          />
        </div>
      )}

      {/* Filtros */}
      <form method="get" className="flex flex-wrap gap-3 items-end">
        <FilterSelect name="clienteId" label="Cliente" defaultValue={sp.clienteId ?? ''}>
          <option value="">Todos</option>
          {(clientes ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect name="form_plugin" label="Plugin" defaultValue={sp.form_plugin ?? ''}>
          <option value="">Todos</option>
          {Object.entries(PLUGIN_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </FilterSelect>
        <FilterInput
          name="utm_source"
          label="UTM Source"
          defaultValue={sp.utm_source ?? ''}
          placeholder="instagram"
        />
        <FilterInput
          name="utm_campaign"
          label="Campaña"
          defaultValue={sp.utm_campaign ?? ''}
          placeholder="contiene…"
          wide
        />
        <FilterInput
          name="utm_content"
          label="Creativo"
          defaultValue={sp.utm_content ?? ''}
          placeholder="contiene…"
        />
        <FilterInput name="from" label="Desde" defaultValue={sp.from ?? ''} type="date" />
        <FilterInput name="to" label="Hasta" defaultValue={sp.to ?? ''} type="date" />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
        >
          <Filter className="h-3 w-3" />
          Filtrar
        </button>
        {hasFilters && (
          <Link
            href="/report-utm/leads"
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent transition-colors"
          >
            Limpiar
          </Link>
        )}
      </form>

      {/* Lista de leads: tabla o tarjetas (selector del usuario) */}
      {(leads ?? []).length > 0 ? (
        <LeadsView leads={leads as ReportUtmLeadEvent[]} clienteMap={clienteMap} />
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-6 py-16 text-center">
            <UserCheck className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">Sin leads todavía</p>
            <p className="text-xs text-muted-foreground mt-1">
              {hasFilters
                ? 'No hay leads que coincidan con los filtros.'
                : 'Configurá el plugin WordPress con el S2S Token para capturar envíos de formularios.'}
            </p>
          </div>
        </div>
      )}

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
  );
}

// ─────────────────────────────────────────────────────────────
// Agregados
// ─────────────────────────────────────────────────────────────

type StatsRow = {
  utm_source: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
};

function computeStats(rows: StatsRow[]) {
  const src = new Map<string, number>();
  const camp = new Map<string, number>();
  const cont = new Map<string, number>();
  for (const r of rows) {
    if (r.utm_source) src.set(dec(r.utm_source), (src.get(dec(r.utm_source)) ?? 0) + 1);
    if (r.utm_campaign) camp.set(dec(r.utm_campaign), (camp.get(dec(r.utm_campaign)) ?? 0) + 1);
    if (r.utm_content) cont.set(dec(r.utm_content), (cont.get(dec(r.utm_content)) ?? 0) + 1);
  }
  const top = (m: Map<string, number>): [string, number] | null => {
    let best: [string, number] | null = null;
    for (const e of m.entries()) if (!best || e[1] > best[1]) best = e;
    return best;
  };
  return {
    topSource: top(src),
    sourceCount: src.size,
    topCampaign: top(camp),
    campaignCount: camp.size,
    topContent: top(cont),
    contentCount: cont.size,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─────────────────────────────────────────────────────────────
// Subcomponentes
// ─────────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
        <span className="text-emerald-600 dark:text-emerald-400">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-lg font-bold text-foreground truncate" title={value}>
        {value}
      </p>
      {hint && (
        <p className="text-[10px] text-muted-foreground mt-0.5 truncate" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

function FilterSelect({
  name,
  label,
  defaultValue,
  children,
}: {
  name: string;
  label: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</label>
      <select
        name={name}
        defaultValue={defaultValue}
        className="px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
      >
        {children}
      </select>
    </div>
  );
}

function FilterInput({
  name,
  label,
  defaultValue,
  placeholder,
  type = 'text',
  wide,
}: {
  name: string;
  label: string;
  defaultValue: string;
  placeholder?: string;
  type?: string;
  wide?: boolean;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={`${wide ? 'w-44' : 'w-32'} px-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40`}
      />
    </div>
  );
}
