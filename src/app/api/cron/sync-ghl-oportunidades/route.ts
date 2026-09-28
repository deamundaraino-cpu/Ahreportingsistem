import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createClient as createSSRClient } from '@/utils/supabase/server';
import type { GhlIntegrationRow } from '@/lib/report-utm/ghl-leads';
import {
  syncGhlOportunidadesForCliente,
  type GhlOportunidadesSyncSummary,
} from '@/lib/report-utm/ghl-oportunidades';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel Hobby corta a 60s. Cada cliente se autolimita y la pasada siguiente
// retoma lo que quede: las ventas ya guardadas no se reescriben.
export const maxDuration = 60;

/**
 * Sync de respaldo de las VENTAS de GoHighLevel → report_utm.sales_events.
 *
 *   GET  /api/cron/sync-ghl-oportunidades            (todas las integraciones activas)
 *   POST /api/cron/sync-ghl-oportunidades?clienteId= (trigger manual de un cliente)
 *
 * Red de seguridad del webhook de venta: registra las oportunidades ganadas de
 * los últimos 90 días que falten y revierte las que dejaron de estar ganadas.
 * Mismo patrón y misma protección (CRON_SECRET) que /api/cron/sync-ghl-leads.
 * Necesita el scope `opportunities.readonly` en el PIT de la location.
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
    .select('id, cliente_id, access_token_encrypted, config, status')
    .eq('tipo', 'gohighlevel')
    .eq('status', 'active');
  if (onlyClienteId) intQuery = intQuery.eq('cliente_id', onlyClienteId);

  const { data: integrations, error: intError } = await intQuery;
  if (intError) {
    return NextResponse.json({ error: 'Failed to list integrations' }, { status: 500 });
  }

  // Presupuesto global: el que no entra hoy entra en la próxima corrida.
  const startedAt = Date.now();
  const CRON_BUDGET_MS = 45_000;

  const results: Array<{ clienteId: string } & GhlOportunidadesSyncSummary> = [];
  let skipped = 0;
  for (const integration of (integrations ?? []) as GhlIntegrationRow[]) {
    const restante = CRON_BUDGET_MS - (Date.now() - startedAt);
    if (restante < 5_000) {
      skipped++;
      continue;
    }
    const summary = await syncGhlOportunidadesForCliente(supabase, integration, {
      budgetMs: Math.min(restante, 40_000),
    });
    results.push({ clienteId: integration.cliente_id, ...summary });
  }

  return NextResponse.json({
    ok: true,
    clientes: results.length,
    skipped,
    registradas: results.reduce((s, r) => s + r.registradas, 0),
    revertidas: results.reduce((s, r) => s + r.revertidas, 0),
    results,
  });
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
