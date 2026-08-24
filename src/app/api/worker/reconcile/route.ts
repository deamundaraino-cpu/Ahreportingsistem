import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { metaFetch, tiktokFetch, setRetryDeadline } from '@/lib/rate-limit';
import {
  construirResumen,
  normalizarFilas,
  type AccountDaySpend,
  type Plataforma,
} from '@/lib/sync/reconcile';
import { enqueueJob } from '@/lib/sync/queue';
import { colombiaToday } from '@/lib/date-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Reconcilia el gasto publicitario guardado contra el que reporta la plataforma.
 *
 * Por qué hace falta
 * ─────────────────
 * El dashboard suma `meta_campaigns[].spend` / `tiktok_campaigns[].spend`
 * filtrado por keyword, no las columnas agregadas. Si un array quedó incompleto
 * (paginación de Meta truncada antes del fix de 2026-06-23, o una página que
 * falló a mitad), ese día muestra $0 aunque sí hubo gasto — y como la fila
 * "tiene datos", el worker no la vuelve a pedir. Así se perdieron ~$90k de un
 * cliente en 3 días.
 *
 * Estrategia: UNA llamada a nivel de cuenta/anunciante por día (1 fila/día,
 * baratísimo) da el gasto real. Se compara con lo guardado y, con `heal=1`, se
 * reencolan SOLO los días divergentes agrupados en rangos contiguos.
 *
 *   Meta   → level=account, fields=spend, time_increment=1
 *   TikTok → data_level=AUCTION_ADVERTISER, dimensions=[stat_time_day]
 *
 *   GET|POST /api/worker/reconcile?client_id=<uuid>&start=&end=&heal=1&platforms=meta,tiktok
 *
 * Sin `heal` es de solo lectura: devuelve el informe para inspeccionarlo.
 */

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0';
/** Backstop de paginación: 1 fila por día, así que 20 páginas sobran de largo. */
const MAX_PAGES = 20;

type MetaAccount = { account_id: string; token: string };
type TikTokAccount = { advertiser_id: string; token: string };

function resolveMetaAccounts(config: any): MetaAccount[] {
  if (Array.isArray(config?.meta_accounts) && config.meta_accounts.length > 0) {
    return config.meta_accounts
      .filter((a: any) => a.account_id)
      .map((a: any) => ({ account_id: a.account_id, token: a.token || config.meta_token || '' }));
  }
  if (config?.meta_token && config?.meta_account_id) {
    return [{ account_id: config.meta_account_id, token: config.meta_token }];
  }
  return [];
}

function resolveTikTokAccounts(config: any): TikTokAccount[] {
  if (Array.isArray(config?.tiktok_accounts) && config.tiktok_accounts.length > 0) {
    return config.tiktok_accounts
      .filter((a: any) => a.advertiser_id)
      .map((a: any) => ({
        advertiser_id: a.advertiser_id,
        token: a.access_token || config.tiktok_access_token || '',
      }));
  }
  if (config?.tiktok_access_token && config?.tiktok_advertiser_id) {
    return [{ advertiser_id: config.tiktok_advertiser_id, token: config.tiktok_access_token }];
  }
  return [];
}

/** Gasto diario a nivel de cuenta para el rango. Suma varias cuentas por día. */
async function fetchAccountSpend(
  accounts: MetaAccount[],
  start: string,
  end: string,
  log: (m: string) => void
): Promise<{ dias: AccountDaySpend[]; ok: boolean }> {
  const porFecha = new Map<string, number>();
  let ok = true;

  for (const { account_id, token } of accounts) {
    const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`;
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${actId}/insights`);
    url.searchParams.append('access_token', token);
    url.searchParams.append('time_range', JSON.stringify({ since: start, until: end }));
    url.searchParams.append('time_increment', '1');
    url.searchParams.append('fields', 'spend');
    url.searchParams.append('level', 'account');
    url.searchParams.append('limit', '500');

    let next: string | null = url.toString();
    let pages = 0;
    try {
      while (next && pages < MAX_PAGES) {
        pages++;
        const res = await metaFetch(next);
        const data = await res.json();
        if (data?.error) {
          log(`[reconcile] ${actId} error de API: ${JSON.stringify(data.error)}`);
          ok = false;
          break;
        }
        for (const row of data?.data ?? []) {
          const day = row.date_start;
          if (!day) continue;
          porFecha.set(day, (porFecha.get(day) ?? 0) + (parseFloat(row.spend || '0') || 0));
        }
        next = data?.paging?.next ?? null;
      }
    } catch (e: any) {
      log(`[reconcile] ${actId} excepción: ${e?.message ?? e}`);
      ok = false;
    }
  }

  const dias = Array.from(porFecha.entries())
    .map(([fecha, spend]) => ({ fecha, spend }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { dias, ok };
}

/**
 * Gasto diario a nivel de ANUNCIANTE en TikTok.
 *
 * `AUCTION_ADVERTISER` agrega por cuenta igual que `level=account` en Meta, así
 * que sirve de fuente de verdad frente a la suma por campaña.
 */
async function fetchAdvertiserSpend(
  accounts: TikTokAccount[],
  start: string,
  end: string,
  log: (m: string) => void
): Promise<{ dias: AccountDaySpend[]; ok: boolean }> {
  const porFecha = new Map<string, number>();
  let ok = true;

  for (const { advertiser_id, token } of accounts) {
    const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
    url.searchParams.append('advertiser_id', advertiser_id);
    url.searchParams.append('report_type', 'BASIC');
    url.searchParams.append('data_level', 'AUCTION_ADVERTISER');
    url.searchParams.append('dimensions', JSON.stringify(['stat_time_day']));
    url.searchParams.append('metrics', JSON.stringify(['spend']));
    url.searchParams.append('start_date', start);
    url.searchParams.append('end_date', end);

    let page = 1;
    let totalPage = 1;
    try {
      do {
        const u = new URL(url.toString());
        u.searchParams.set('page', String(page));
        u.searchParams.set('page_size', String(1000));
        const res = await tiktokFetch(u.toString(), { headers: { 'Access-Token': token } });
        const json = await res.json();
        // TikTok responde 200 con `code` distinto de 0 en los errores.
        if (json?.code !== 0 || !json?.data) {
          log(
            `[reconcile] TikTok ${advertiser_id} error: ${json?.message ?? JSON.stringify(json)}`
          );
          ok = false;
          break;
        }
        for (const row of json.data.list ?? []) {
          const day = String(row?.dimensions?.stat_time_day ?? '').slice(0, 10);
          if (!day) continue;
          porFecha.set(
            day,
            (porFecha.get(day) ?? 0) + (parseFloat(row?.metrics?.spend || '0') || 0)
          );
        }
        totalPage = json.data.page_info?.total_page || 1;
        page++;
      } while (page <= totalPage && page <= MAX_PAGES);
    } catch (e: any) {
      log(`[reconcile] TikTok ${advertiser_id} excepción: ${e?.message ?? e}`);
      ok = false;
    }
  }

  const dias = Array.from(porFecha.entries())
    .map(([fecha, spend]) => ({ fecha, spend }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { dias, ok };
}

async function run(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY requerido' }, { status: 500 });
  }
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const startedAt = Date.now();
  setRetryDeadline(startedAt + 45_000);

  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get('client_id');
  const heal = searchParams.get('heal') === '1' || searchParams.get('heal') === 'true';

  // Por defecto se auditan ambas plataformas; `platforms=meta` acota.
  const platformsParam = searchParams.get('platforms');
  const plataformasPedidas: Plataforma[] = platformsParam
    ? (platformsParam
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p === 'meta' || p === 'tiktok') as Plataforma[])
    : ['meta', 'tiktok'];

  // Por defecto, los últimos 120 días: cubre con margen la era del bug de
  // paginación (anterior al 2026-06-23) sin barrer todo el histórico.
  const hoy = colombiaToday();
  const dias = Number(searchParams.get('dias')) || 120;
  const end = searchParams.get('end') ?? hoy;
  const start =
    searchParams.get('start') ??
    new Date(Date.parse(`${end}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);

  const debugLogs: string[] = [];
  const log = (m: string) => {
    console.log(m);
    debugLogs.push(m);
  };

  let query = db.from('clientes').select('id, nombre, config_api');
  if (clienteId) query = query.eq('id', clienteId);
  const { data: clientes, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const informes: any[] = [];
  let jobsEncolados = 0;

  for (const cliente of clientes ?? []) {
    const cuentas: Record<Plataforma, number> = {
      meta: resolveMetaAccounts(cliente.config_api).length,
      tiktok: resolveTikTokAccounts(cliente.config_api).length,
    };
    const plataformas = plataformasPedidas.filter((p) => cuentas[p] > 0);
    if (plataformas.length === 0) continue;

    // El presupuesto de Vercel Hobby (60s) obliga a cortar limpio: los
    // clientes no revisados quedan para la siguiente corrida.
    if (Date.now() - startedAt > 45_000) {
      log(`[reconcile] presupuesto agotado — ${cliente.nombre} y siguientes quedan pendientes`);
      break;
    }

    // Una fila de metricas_diarias sirve para las dos plataformas.
    const { data: rows } = await db
      .from('metricas_diarias')
      .select('fecha, meta_spend, meta_campaigns, tiktok_spend, tiktok_campaigns')
      .eq('cliente_id', cliente.id)
      .gte('fecha', start)
      .lte('fecha', end);

    const porPlataforma: Record<string, any> = {};
    let encoladosCliente = 0;
    let faltanteCliente = 0;

    for (const plataforma of plataformas) {
      const { dias: accountDays, ok } =
        plataforma === 'meta'
          ? await fetchAccountSpend(resolveMetaAccounts(cliente.config_api), start, end, log)
          : await fetchAdvertiserSpend(resolveTikTokAccounts(cliente.config_api), start, end, log);

      if (!ok && accountDays.length === 0) {
        porPlataforma[plataforma] = { error: 'No se pudo leer el gasto de la cuenta' };
        continue;
      }

      const resumen = construirResumen(accountDays, normalizarFilas(rows ?? [], plataforma));

      // El día en curso siempre diverge (la plataforma va en vivo, la BD es
      // del último sync): excluirlo evita reparaciones inútiles.
      const reparables = resumen.rangosAReparar.filter((r) => r.start < hoy);
      faltanteCliente += resumen.totales.faltanteEnDashboard;

      if (heal) {
        for (const rango of reparables) {
          const job = await enqueueJob(db, {
            tipo: 'metricas',
            clienteId: cliente.id,
            start: rango.start,
            end: rango.end > hoy ? hoy : rango.end,
            // Acotar a la plataforma afectada evita re-pedir Hotmart y
            // GA4 día por día, que es lo que hacía prohibitivo reparar
            // rangos largos.
            params: { force: true, platforms: plataforma },
            prioridad: 2,
            triggeredBy: `reconcile:${plataforma}`,
          });
          if (job) {
            encoladosCliente++;
            jobsEncolados++;
          }
        }
      }

      porPlataforma[plataforma] = {
        totales: resumen.totales,
        dias_revisados: resumen.dias.length,
        dias_problematicos: resumen.problematicos.length,
        detalle: resumen.problematicos.slice(0, 60),
        rangos_a_reparar: reparables,
      };
    }

    informes.push({
      cliente_id: cliente.id,
      cliente: cliente.nombre,
      rango: { start, end },
      plataformas: porPlataforma,
      faltante_en_dashboard: Number(faltanteCliente.toFixed(2)),
      jobs_encolados: encoladosCliente,
    });
  }

  const faltanteTotal = informes.reduce((s, i) => s + (i.faltante_en_dashboard ?? 0), 0);

  return NextResponse.json({
    ok: true,
    rango: { start, end },
    heal,
    clientes_revisados: informes.length,
    faltante_total_en_dashboard: Number(faltanteTotal.toFixed(2)),
    jobs_encolados: jobsEncolados,
    informes,
    debugLogs,
  });
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}
