import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createClient as createSSRClient } from '@/utils/supabase/server';
import {
  objetivosTikTokLeads,
  syncTikTokLeadsForCliente,
  type TikTokLeadsSyncSummary,
} from '@/lib/report-utm/tiktok-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polling de TikTok Lead Generation → report_utm.lead_events.
 *
 *   GET  /api/cron/sync-tiktok-leads            (todos los clientes con el flag)
 *   POST /api/cron/sync-tiktok-leads?clienteId= (un cliente de report_utm: manual / backfill)
 *
 * No hay webhook de TikTok configurado: este polling es la única vía. Se activa
 * por cuenta con `tiktok_leads: true` en `config_api.tiktok_accounts[]` y crea
 * la integración `tiktok_lead_ads` la primera vez (ver `objetivosTikTokLeads`).
 * La dedup por external_id (`tiktok:<lead_id>`) hace idempotente cada corrida.
 * Protegido por CRON_SECRET (mismo patrón que /api/cron/sync-meta-leads).
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

  const onlyClienteId = new URL(request.url).searchParams.get('clienteId');
  const { objetivos, error } = await objetivosTikTokLeads(supabase, {
    reportClienteId: onlyClienteId,
  });
  if (error) {
    return NextResponse.json(
      { error: `No se pudieron listar los clientes con TikTok Leads: ${error}` },
      { status: 500 }
    );
  }

  // Presupuesto global por corrida. Cada formulario de TikTok es una tarea
  // asíncrona (crear → sondear → descargar) y el cursor y el `form_offset` son
  // reanudables, así que se avanza por tandas sin perder nada: cada cliente recibe lo
  // que quede y se autolimita; los que no entren van primero en la próxima
  // corrida (se ordenan por `last_sync_at`).
  const startedAt = Date.now();
  const CRON_BUDGET_MS = 45_000;

  const results: Array<{ clienteId: string } & TikTokLeadsSyncSummary> = [];
  let skipped = 0;
  for (const { integration, cuentas } of objetivos) {
    const restante = CRON_BUDGET_MS - (Date.now() - startedAt);
    if (restante < 8_000) {
      skipped++;
      continue;
    }
    const summary = await syncTikTokLeadsForCliente(supabase, integration, cuentas, {
      budgetMs: Math.min(restante, Number(process.env.TIKTOK_LEADS_BUDGET_MS) || 40_000),
    });
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
