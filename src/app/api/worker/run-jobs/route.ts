import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { runJobs } from '@/lib/sync/runner';
import { queueStats } from '@/lib/sync/queue';
import { ensurePlanDiario } from '@/lib/sync/planner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Inerte en Docker/Dokploy (no hay límite de plataforma); se conserva por si se
 * vuelve a desplegar en Vercel. El techo real de este endpoint lo fija
 * `RUNJOBS_BUDGET_MS`, más abajo.
 */
export const maxDuration = 60;

/**
 * Número de entorno con default, tolerando basura en la variable.
 */
function envMs(nombre: string, porDefecto: number): number {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

/**
 * Drena la cola `sync_jobs`.
 *
 * Es el ejecutor de RESPALDO: el principal es `sync-worker/` en el VPS, que no
 * tiene límite de tiempo. Este endpoint existe para que la sincronización siga
 * funcionando si el VPS está caído o aún no se ha desplegado, y para dar
 * respuesta inmediata cuando alguien pulsa "Sincronizar" en el dashboard.
 *
 *   GET|POST /api/worker/run-jobs   (Bearer CRON_SECRET)
 */
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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_APP_URL requerido para invocar los endpoints de sync' },
      { status: 500 }
    );
  }

  // Respaldo de planning: si el VPS no encoló el plan de esta franja, lo hace
  // este drenador antes de drenar. Best-effort: un fallo aquí no debe impedir
  // que se procese lo que ya haya en la cola.
  let plan: Awaited<ReturnType<typeof ensurePlanDiario>> | { error: string } | null = null;
  try {
    plan = await ensurePlanDiario(db);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[run-jobs] ensurePlanDiario falló', msg);
    plan = { error: msg };
  }

  const result = await runJobs(db, {
    appUrl,
    cronSecret: process.env.CRON_SECRET ?? '',
    workerId: `app-${Math.random().toString(36).slice(2, 8)}`,
    ejecutor: 'app',
    /**
     * `budgetMs` es el techo REAL del ciclo: el runner acota el timeout de cada
     * llamada a lo que quede de presupuesto, así que el budget no puede
     * convertirse en budget+timeout.
     *
     * Estuvo en 50 s para caber en los 60 s de Vercel Hobby, y ese techo era la
     * causa del error más frecuente del sistema: el runner abortaba jobs sanos
     * por falta de presupuesto propio y a los 3 abortos los pintaba de rojo.
     * En un contenedor no existe tal límite, así que el default sube a 4 min.
     * Ajustable por si el proxy de delante corta antes.
     */
    budgetMs: envMs('RUNJOBS_BUDGET_MS', 240_000),
    /**
     * Lease: pasado este tiempo otro ejecutor puede reclamar el job. Debe
     * superar al `budgetMs` — si vence mientras el job aún corre, un segundo
     * ejecutor lo toma en paralelo y ambos se pisan los datos del cliente.
     */
    leaseSeconds: envMs('RUNJOBS_LEASE_SECONDS', 300),
    requestTimeoutMs: envMs('RUNJOBS_REQUEST_TIMEOUT_MS', 120_000),
  });

  return NextResponse.json({ ok: true, plan, ...result, cola: await queueStats(db) });
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}
