// ════════════════════════════════════════════════════════════════
// Job de GA4: desglose por fuente/medio/campaña y eventos clave
// ════════════════════════════════════════════════════════════════
//
// Va aparte del job `metricas` por lo mismo que Hotmart: el GA4 de `metricas`
// pide día a día (hasta 5 peticiones por fecha) y arrastra las guardas del
// resto de plataformas. Este pide por ventanas de un mes, pagina, y deja el
// error en `ga4_estado` en vez de en un log que nadie mira.
//
// Uso: /api/worker/ga4?cliente_id=…&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Sin `cliente_id` recorre todos los clientes con `ga_property_id`.
// La respuesta habla el idioma del runner (`results`, `debugLogs`,
// `filas_escritas`, `partial`, `resumeFrom`).

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { addDaysISO, colombiaToday, hoyCliente } from '@/lib/colombia-date';
import { conDeadline } from '@/lib/rate-limit';
import { sincronizarGa4Cliente } from '@/lib/integrations/ga4-desglose';

export const maxDuration = 60;

/** Margen dentro del límite de 60 s. */
const PRESUPUESTO_MS = 45_000;

type Resultado = Record<string, unknown> & { status: 'ok' | 'error' | 'skipped_budget' };

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  const arranque = Date.now();
  return conDeadline(arranque + PRESUPUESTO_MS, () => procesar(request, arranque));
}

async function procesar(request: Request, arranque: number) {
  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get('cliente_id');
  const hastaParam = searchParams.get('hasta');
  const desdeParam = searchParams.get('desde');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase no configurado' }, { status: 500 });
  }
  const db = createClient(url, key);

  let q = db.from('clientes').select('id, nombre, config_api');
  if (clienteId) q = q.eq('id', clienteId);
  const { data: clientes, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const conGa = (clientes ?? []).filter(
    (c) => !!String((c.config_api as Record<string, unknown> | null)?.ga_property_id ?? '').trim()
  );
  // Deja margen para escribir: una ventana son 2 peticiones + 1 RPC.
  const hayTiempo = () => Date.now() - arranque < PRESUPUESTO_MS - 8_000;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const results: Resultado[] = [];
  let filasEscritas = 0;
  let partial = false;
  let resumeFrom: string | null = null;

  for (const cliente of conGa) {
    if (!hayTiempo()) {
      results.push({ cliente: cliente.nombre, status: 'skipped_budget' });
      partial = true;
      continue;
    }
    const hoy = hoyCliente(cliente.config_api);
    const hasta = hastaParam ?? hoy;
    const desde = desdeParam ?? addDaysISO(hasta, -3);
    try {
      const r = await sincronizarGa4Cliente(db, cliente, desde, hasta, { hayTiempo, hoy, log });
      filasEscritas += r.sesiones + r.eventos;
      // Solo un job de UN cliente sabe reanudar (como Hotmart).
      if (clienteId && r.partial && r.resumeFrom) {
        partial = true;
        resumeFrom = r.resumeFrom;
      }
      results.push({
        cliente: cliente.nombre,
        status: r.ok ? 'ok' : 'error',
        desde,
        hasta,
        ...r,
      });
    } catch (e: unknown) {
      results.push({
        cliente: cliente.nombre,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const exitos = results.filter((r) => r.status === 'ok').length;
  const errores = results.filter((r) => r.status === 'error').map((r) => String(r.error ?? ''));

  return NextResponse.json({
    ok: conGa.length === 0 || exitos > 0,
    errores,
    desde: desdeParam,
    hasta: hastaParam ?? colombiaToday(),
    clientes: conGa.length,
    procesados: results.length,
    ms: Date.now() - arranque,
    filas_escritas: filasEscritas,
    partial,
    resumeFrom,
    results,
    debugLogs: logs.slice(-200),
  });
}
