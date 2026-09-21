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
  Search,
  AlertTriangle,
} from 'lucide-react';
import { LeadsView } from '@/components/report-utm/LeadsView';
import { PLUGIN_LABELS, dec } from '@/lib/report-utm/leads-display';
import {
  columnaExcluidoDisponible,
  MOTIVOS_EXCLUSION,
  type MotivoExclusion,
} from '@/lib/report-utm/lead-exclusion';
import { LeadsExclusionBar } from '@/components/report-utm/LeadsExclusionBar';
import { LeadsMotivosBar } from '@/components/report-utm/LeadsMotivosBar';
import {
  leerFiltros,
  aplicarFiltrosLeads,
  hayFiltros,
  urlLeads,
  urlExport,
  METODOS_ATRIBUCION,
  MIN_BUSQUEDA,
} from '@/lib/report-utm/leads-filtros';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

// PostgREST corta CUALQUIER respuesta en `db-max-rows` (~1000) sin importar el
// `.limit()` que se pida. Aquí ponía 5000, así que el aviso «Resumen sobre 5000»
// no se mostró nunca —1000 nunca llega a 5000— y las tarjetas se presentaban como
// si describieran todo el conjunto filtrado. El tope real ES este.
const STATS_CAP = 1000;

const MOTIVOS = Object.keys(MOTIVOS_EXCLUSION) as MotivoExclusion[];

const COLUMNAS_LEAD =
  // Sin `first_touch`/`last_touch`: los borró la migración 084.
  // Sin `form_id` ni `visitor_id`: no se pintan en ninguna vista de LeadsView, y
  // `visitor_id` está a NULL en el 100 % de las filas desde que la atribución dejó
  // de pasar por el píxel (ver attribution-resolver.ts).
  'id, cliente_id, form_name, form_plugin, lead_name, lead_email, lead_phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, page_url, ip_country, attribution_method, raw_fields, source, created_at';

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = leerFiltros(sp);
  const supabase = await reportUtmClient();
  const offset = (f.page - 1) * PAGE_SIZE;

  // Sin la migración 079 no hay marca que filtrar: la página se comporta como
  // antes y no ofrece pestañas ni acciones de exclusión. Se resuelve antes que
  // nada porque decide el `select` y los filtros de todo lo demás (está cacheado).
  const conExclusion = await columnaExcluidoDisponible(supabase);
  const opciones = { conExclusion, conEstado: true };

  const seleccion = conExclusion ? `${COLUMNAS_LEAD}, excluido, excluido_motivo` : COLUMNAS_LEAD;

  // Página actual de leads. El `count: 'exact'` lo calcula Postgres sobre el
  // conjunto filtrado entero, así que es independiente del `.range()`.
  const qPagina = aplicarFiltrosLeads(
    supabase.from('lead_events').select(seleccion, { count: 'exact' }),
    f,
    opciones
  )
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // Agregados de las tarjetas. Tres cambios respecto a lo que había:
  //
  //   · `.order()` — sin él, QUÉ 1000 filas llegaban lo decidía el plan (orden
  //     físico con seq scan, o sea las más ANTIGUAS). «Fuente principal» podía ser
  //     la de hace un año. Es el fallo que la migración 070 corrigió para el BI.
  //
  //   · SOLO con un cliente elegido. Y no es un capricho de producto: ordenar por
  //     `created_at` sin `cliente_id` no lo sirve ningún índice —los dos que hay
  //     empiezan por `cliente_id`—, así que Postgres tendría que leer las 93.000
  //     filas y ordenarlas en cada carga de /leads. Serían los mismos 171 MB
  //     contra 224 MB de caché que tumbaron la base el 2026-09-20. Con cliente,
  //     `idx_rutm_lead_events_cliente (cliente_id, created_at DESC)` lo da ya
  //     ordenado y la consulta se corta a las 1000 primeras.
  //     De paso, un «creativo top» que mezcla clientes tampoco significaba nada.
  //
  //   · con `?q=` tampoco: el desglose por UTM de una búsqueda por nombre no dice
  //     nada, y esto es un tercio de la carga de la página.
  const qStats =
    f.q || !f.clienteId
      ? null
      : aplicarFiltrosLeads(
          supabase.from('lead_events').select('utm_source, utm_campaign, utm_content'),
          f,
          opciones
        )
          .order('created_at', { ascending: false })
          .limit(STATS_CAP);

  // Excluidos con los mismos filtros, para la pestaña. `conEstado: false` deja
  // fuera la pestaña actual y el motivo. Usa el índice parcial de la 079.
  const qExcluidos = conExclusion
    ? aplicarFiltrosLeads(
        supabase.from('lead_events').select('id', { count: 'exact', head: true }),
        f,
        { conExclusion, conEstado: false }
      ).eq('excluido', true)
    : null;

  // Un conteo por motivo, solo en la pestaña que los enseña.
  const qMotivos =
    conExclusion && f.estado === 'excluidos'
      ? MOTIVOS.map((m) =>
          aplicarFiltrosLeads(
            supabase.from('lead_events').select('id', { count: 'exact', head: true }),
            f,
            { conExclusion, conEstado: false }
          )
            .eq('excluido', true)
            .eq('excluido_motivo', m)
        )
      : [];

  // En paralelo: eran cuatro `await` en cascada y la página no pintaba nada hasta
  // que terminaba la última. supabase-js no rechaza la promesa ante un error de
  // PostgREST (lo devuelve en `error`), así que `Promise.all` es seguro aquí.
  const [resClientes, resPagina, resStats, resExcluidos, resMotivos] = await Promise.all([
    supabase.from('clientes').select('id, nombre, slug').order('nombre'),
    qPagina,
    qStats,
    qExcluidos,
    Promise.all(qMotivos),
  ]);

  // La página ignoraba `error` en las cuatro consultas. Con el buscador eso se
  // vuelve peligroso: un 400 de PostgREST por una cadena `or` mal formada se vería
  // exactamente igual que «Sin leads todavía».
  const error =
    resPagina.error?.message ??
    resClientes.error?.message ??
    resStats?.error?.message ??
    resExcluidos?.error?.message ??
    resMotivos.find((r) => r.error)?.error?.message ??
    null;

  const clientes = resClientes.data ?? [];
  const leads = (resPagina.data ?? []) as unknown as ReportUtmLeadEvent[];
  const total = resPagina.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const excluidos = conExclusion ? (resExcluidos?.count ?? 0) : null;

  const statsRows = (resStats?.data ?? []) as StatsRow[];
  const stats = computeStats(statsRows);
  // Las tarjetas describen como mucho las últimas STATS_CAP filas. Cuando eso es
  // menos que el total hay que decirlo: antes se callaba.
  const pieResumen =
    statsRows.length > 0 && statsRows.length < total
      ? `sobre los últimos ${statsRows.length.toLocaleString()}`
      : undefined;
  // Por qué no hay desglose, cuando no lo hay. Decirlo es la diferencia entre
  // «no hay datos» y «no te los estoy calculando».
  const sinResumen = f.q
    ? 'no se resume una búsqueda'
    : !f.clienteId
      ? 'elegí un cliente para verlo'
      : undefined;
  const pie = (detalle: string) => [detalle, pieResumen].filter(Boolean).join(' · ');

  const conteosMotivo = Object.fromEntries(
    MOTIVOS.map((m, i) => [m, resMotivos[i]?.count ?? 0])
  ) as Record<MotivoExclusion, number>;

  const clienteMap: Record<string, string> = Object.fromEntries(
    clientes.map((c) => [c.id, c.nombre])
  );

  const filtrado = hayFiltros(f);

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
            {total.toLocaleString()} registros · Página {f.page} de {totalPages}
            {f.q && ` · buscando «${f.q}»`}
          </p>
        </div>
        {total > 0 && (
          <a
            href={urlExport(f)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Exportar CSV
          </a>
        )}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-red-700 dark:text-red-400">
                La consulta falló, así que esta lista está incompleta o vacía.
              </p>
              <p className="text-[11px] text-red-700/80 dark:text-red-400/80 mt-0.5 break-all">
                {error}
              </p>
            </div>
          </div>
        </div>
      )}

      <LeadsExclusionBar
        estado={f.estado}
        excluidos={excluidos}
        hrefDe={(e) =>
          urlLeads(f, {
            estado: e === 'incluidos' ? undefined : e,
            page: undefined,
            motivo: undefined,
          })
        }
      />

      {conExclusion && f.estado === 'excluidos' && (
        <LeadsMotivosBar
          conteos={conteosMotivo}
          activo={f.motivo}
          total={excluidos ?? 0}
          hrefDe={(m) => urlLeads(f, { motivo: m ?? undefined, page: undefined })}
          hrefRegla={f.clienteId ? `/admin/settings/${f.clienteId}` : null}
        />
      )}

      {/* Tarjetas resumen */}
      {total > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<UserCheck className="h-4 w-4" />}
            label={f.estado === 'excluidos' ? 'Leads excluidos' : 'Total leads'}
            value={total.toLocaleString()}
            hint="conteo exacto del filtro"
          />
          <StatCard
            icon={<Radio className="h-4 w-4" />}
            label="Fuente principal"
            value={stats.topSource?.[0] ?? '—'}
            hint={
              stats.topSource
                ? pie(`${stats.topSource[1]} leads · ${stats.sourceCount} fuentes`)
                : sinResumen
            }
          />
          <StatCard
            icon={<Megaphone className="h-4 w-4" />}
            label="Campañas"
            value={stats.campaignCount > 0 ? String(stats.campaignCount) : '—'}
            hint={
              stats.topCampaign ? pie(`Top: ${truncate(stats.topCampaign[0], 24)}`) : sinResumen
            }
          />
          <StatCard
            icon={<Film className="h-4 w-4" />}
            label="Creativo top"
            value={stats.topContent ? truncate(stats.topContent[0], 18) : '—'}
            hint={
              stats.topContent
                ? pie(`${stats.topContent[1]} leads · ${stats.contentCount} creativos`)
                : sinResumen
            }
          />
        </div>
      )}

      {/* Filtros */}
      <form method="get" className="space-y-3">
        {f.estado !== 'incluidos' && <input type="hidden" name="estado" value={f.estado} />}
        {f.motivo && <input type="hidden" name="motivo" value={f.motivo} />}

        <div className="flex flex-wrap gap-3 items-end">
          <div className="grow max-w-md">
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Buscar lead
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                name="q"
                defaultValue={f.qTexto ?? ''}
                placeholder="Nombre, email o teléfono (sin tildes)"
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
            </div>
            {f.qCorto && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                Escribí al menos {MIN_BUSQUEDA} caracteres: con menos no se busca y estarías viendo
                la lista completa.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <FilterSelect name="clienteId" label="Cliente" defaultValue={f.clienteId ?? ''}>
            <option value="">Todos</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </FilterSelect>
          {/* `form_plugin` es el eje completo de origen: para Elementor/CF7 guarda
              el plugin y para GoHighLevel/Meta guarda el mismo valor que `source`,
              así que un segundo desplegable solo produciría combinaciones vacías. */}
          <FilterSelect name="form_plugin" label="Origen" defaultValue={f.origen ?? ''}>
            <option value="">Todos</option>
            {Object.entries(PLUGIN_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            name="attribution_method"
            label="Atribución"
            defaultValue={f.attributionMethod ?? ''}
          >
            <option value="">Todas</option>
            {METODOS_ATRIBUCION.map((m) => (
              <option key={m} value={m}>
                {ETIQUETA_ATRIBUCION[m]}
              </option>
            ))}
          </FilterSelect>
          <FilterInput
            name="form_name"
            label="Formulario"
            defaultValue={f.formName ?? ''}
            placeholder="contiene…"
          />
          <FilterInput
            name="utm_source"
            label="UTM Source"
            defaultValue={f.utmSource ?? ''}
            placeholder="instagram"
          />
          <FilterInput
            name="utm_campaign"
            label="Campaña"
            defaultValue={f.utmCampaign ?? ''}
            placeholder="contiene…"
            wide
          />
          <FilterInput
            name="utm_content"
            label="Creativo"
            defaultValue={f.utmContent ?? ''}
            placeholder="contiene…"
          />
          <FilterInput name="from" label="Desde" defaultValue={f.from ?? ''} type="date" />
          <FilterInput name="to" label="Hasta" defaultValue={f.to ?? ''} type="date" />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            <Filter className="h-3 w-3" />
            Filtrar
          </button>
          {filtrado && (
            <Link
              href="/leads"
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground border border-border hover:bg-accent transition-colors"
            >
              Limpiar
            </Link>
          )}
        </div>
      </form>

      {/* Lista de leads: tabla o tarjetas (selector del usuario) */}
      {leads.length > 0 ? (
        <LeadsView leads={leads} clienteMap={clienteMap} puedeExcluir={conExclusion} />
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-6 py-16 text-center">
            <UserCheck className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">
              {error
                ? 'No se pudo cargar la lista'
                : f.q
                  ? `Ningún lead coincide con «${f.q}»`
                  : f.estado === 'excluidos'
                    ? 'Ningún lead excluido'
                    : 'Sin leads todavía'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {error
                ? 'El detalle del fallo está arriba.'
                : f.q
                  ? 'La búsqueda distingue tildes: probá sin ellas, o con un trozo más corto.'
                  : f.estado === 'excluidos'
                    ? 'Con estos filtros no hay leads fuera del conteo.'
                    : filtrado
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
            {f.page > 1 && (
              <Link
                href={urlLeads(f, { page: String(f.page - 1) })}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-muted-foreground hover:bg-accent transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Anterior
              </Link>
            )}
            <span className="text-xs text-muted-foreground">
              {f.page} / {totalPages}
            </span>
            {f.page < totalPages && (
              <Link
                href={urlLeads(f, { page: String(f.page + 1) })}
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

const ETIQUETA_ATRIBUCION: Record<(typeof METODOS_ATRIBUCION)[number], string> = {
  click_id: 'Click ID',
  visitor_cookie: 'Cookie de visitante',
  utm_only: 'Solo UTM',
  none: 'Sin atribuir',
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
