import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { enqueueRange, enqueueJob, queueStats, type SyncJobTipo } from '@/lib/sync/queue';
import {
  planDiario,
  planIntradia,
  planCierreMes,
  planReconciliacion,
  planHotmartReconciliacion,
  limpiarHistorial,
  PRIORIDAD,
} from '@/lib/sync/planner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Planner de la cola: crea los jobs, no los ejecuta.
 *
 *   POST /api/worker/enqueue?plan=diario         → plan del día (sustituye a los crons)
 *   POST /api/worker/enqueue?plan=intradia       → solo el día en curso
 *   POST /api/worker/enqueue?plan=cierre_mes     → re-descarga final + congelado
 *   POST /api/worker/enqueue?plan=reconciliacion → audita el gasto de Meta y repara días incompletos
 *   POST /api/worker/enqueue  body: { tipo, cliente_id?, start, end, params?, prioridad? }
 *
 * Protegido por CRON_SECRET. Lo llama el scheduler del VPS (o GitHub Actions
 * como respaldo), y el dashboard para el sync manual.
 */
export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY requerido' }, { status: 500 });
  }
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const plan = new URL(request.url).searchParams.get('plan');

  try {
    if (plan === 'diario') {
      const res = await planDiario(db);
      await limpiarHistorial(db);
      return NextResponse.json({ ok: true, plan, ...res, cola: await queueStats(db) });
    }
    if (plan === 'intradia') {
      const res = await planIntradia(db);
      return NextResponse.json({ ok: true, plan, ...res, cola: await queueStats(db) });
    }
    if (plan === 'cierre_mes') {
      const periodo = new URL(request.url).searchParams.get('periodo') ?? undefined;
      const res = await planCierreMes(db, periodo);
      return NextResponse.json({ ok: true, plan, ...res, cola: await queueStats(db) });
    }
    if (plan === 'reconciliacion') {
      const dias = Number(new URL(request.url).searchParams.get('dias')) || undefined;
      const res = await planReconciliacion(db, { dias });
      // La reconciliación semanal aprovecha para buscar reembolsos de
      // Hotmart: la API filtra por fecha de COMPRA, así que una devolución
      // sobre una venta antigua no aparece en el sync diario y la venta
      // contaría como facturación para siempre.
      const hm = await planHotmartReconciliacion(db);
      return NextResponse.json({
        ok: true,
        plan,
        encolados: res.encolados + hm.encolados,
        detalle: { ...res.detalle, ...hm.detalle },
        cola: await queueStats(db),
      });
    }

    // Encolado explícito de un rango concreto.
    const body = (await request.json().catch(() => ({}))) as {
      tipo?: SyncJobTipo;
      cliente_id?: string;
      start?: string;
      end?: string;
      params?: Record<string, any>;
      prioridad?: number;
      triggered_by?: string;
      chunk_days?: number;
    };
    if (!body.tipo) {
      return NextResponse.json(
        { error: 'Falta `tipo` (o usa ?plan=diario|intradia|cierre_mes)' },
        { status: 400 }
      );
    }

    if (body.start && body.end) {
      const creados = await enqueueRange(db, {
        tipo: body.tipo,
        clienteId: body.cliente_id ?? null,
        start: body.start,
        end: body.end,
        params: body.params,
        prioridad: body.prioridad ?? PRIORIDAD.manual,
        triggeredBy: body.triggered_by ?? 'manual',
        chunkDays: body.chunk_days,
      });
      return NextResponse.json({ ok: true, encolados: creados, cola: await queueStats(db) });
    }

    const job = await enqueueJob(db, {
      tipo: body.tipo,
      clienteId: body.cliente_id ?? null,
      start: body.start ?? null,
      end: body.end ?? null,
      params: body.params,
      prioridad: body.prioridad ?? PRIORIDAD.manual,
      triggeredBy: body.triggered_by ?? 'manual',
    });
    return NextResponse.json({
      ok: true,
      encolados: job ? 1 : 0,
      duplicado: !job,
      cola: await queueStats(db),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
