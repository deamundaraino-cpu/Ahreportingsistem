import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createClient as createSSRClient } from '@/utils/supabase/server';
import { syncMetaLeadsForCliente, type MetaLeadsSyncSummary } from '@/lib/report-utm/meta-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polling de Meta Lead Ads → report_utm.lead_events.
 *
 *   GET  /api/cron/sync-meta-leads            (cron, todos los clientes activos)
 *   POST /api/cron/sync-meta-leads?clienteId= (trigger manual / backfill de un cliente)
 *
 * Es la red de seguridad del webhook + el backfill histórico (~90 días que
 * Meta conserva). La dedup por external_id evita duplicar leads que el webhook
 * ya haya insertado. Protegido por CRON_SECRET (mismo patrón que /api/worker).
 */

async function run(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  let supabase: SupabaseClient;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  } else {
    supabase = await createSSRClient();
  }
  const db = supabase.schema('report_utm');

  const onlyClienteId = new URL(request.url).searchParams.get('clienteId');

  let intQuery = db
    .from('integrations')
    .select('id, cliente_id, config, status, last_sync_at')
    .eq('tipo', 'meta_lead_ads')
    // También las que están en `error`: `syncMetaLeadsForCliente` limpia la caché
    // de formularios al fallar precisamente para redescubrir en la próxima
    // corrida, pero el cron solo recogía las activas, así que una integración
    // que fallaba una vez (un token de Página vencido) no se reintentaba nunca.
    .in('status', ['active', 'error'])
    // La más atrasada primero: con el presupuesto agotado, los que se saltan
    // van rotando en vez de ser siempre los últimos de la lista.
    .order('last_sync_at', { ascending: true, nullsFirst: true });
  if (onlyClienteId) intQuery = intQuery.eq('cliente_id', onlyClienteId);

  const { data: integrations, error: intError } = await intQuery;
  if (intError) {
    return NextResponse.json({ error: 'Failed to list integrations' }, { status: 500 });
  }

  // Presupuesto global: cada cliente ya se autolimita; esto evita que muchos
  // clientes en backfill alarguen la corrida sin techo. Los que queden se
  // procesan en la próxima corrida (cursor intacto; el webhook cubre el realtime).
  const startedAt = Date.now();
  // Corto a propósito: con 250_000 el checkpoint nunca disparaba y quien
  // llama abortaba la petición a mitad de un cliente.
  const CRON_BUDGET_MS = 45_000;

  const results: Array<{ clienteId: string } & MetaLeadsSyncSummary> = [];
  let skipped = 0;
  for (const integration of integrations ?? []) {
    if (Date.now() - startedAt > CRON_BUDGET_MS) {
      skipped++;
      continue;
    }
    const summary = await syncMetaLeadsForCliente(supabase, integration);
    results.push({ clienteId: integration.cliente_id, ...summary });
  }

  const totalImported = results.reduce((s, r) => s + (r.imported ?? 0), 0);
  return NextResponse.json({
    ok: true,
    clientes: results.length,
    skipped,
    imported: totalImported,
    results,
  });
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
