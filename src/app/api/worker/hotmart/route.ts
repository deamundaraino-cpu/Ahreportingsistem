// ════════════════════════════════════════════════════════════════
// Job de Hotmart: backfill, reclasificación y reconciliación
// ════════════════════════════════════════════════════════════════
//
// Hasta ahora Hotmart se sincronizaba DENTRO del job `metricas`, junto a Meta,
// TikTok y GA4. Eso hacía imposible re-pedir solo Hotmart, y sobre todo
// reclasificar el histórico sin volver a llamar a las cuatro plataformas.
//
// Tres modos, según `params`:
//   • (por defecto)       → backfill del rango.
//   • { reclasificar }    → reescribe tipo/tab_id LEYENDO la tabla. Cero
//                           peticiones a la API. Es lo que se encola cuando
//                           alguien asigna una oferta en la UI.
//   • { reconciliar }     → reescanea la ventana buscando reembolsos.
//
// La reconciliación es un modo aparte porque `sales/history` filtra por FECHA DE
// COMPRA, no de cambio de estado: un reembolso de hoy sobre una compra de hace
// un mes no aparece al pedir hoy. Sin esta pasada, una venta devuelta contaba
// como facturación para siempre.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { addDaysISO, colombiaToday } from '@/lib/colombia-date';
import { backfillRango } from '@/lib/hotmart/backfill';
import { hotmartConectado, obtenerToken } from '@/lib/hotmart/cliente';
import { cargarFunnels } from '@/lib/hotmart/persistencia';
import { reclasificarRango, reconciliarReembolsos } from '@/lib/hotmart/sync';

export const maxDuration = 60;

/** Margen dentro del límite de 60 s: al agotarse se persiste lo hecho. */
const PRESUPUESTO_MS = 45_000;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const clienteId = searchParams.get('cliente_id');
  const hasta = searchParams.get('hasta') ?? colombiaToday();
  const desde = searchParams.get('desde') ?? addDaysISO(hasta, -30);
  const modo = searchParams.get('modo') ?? 'backfill';

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

  const conHotmart = (clientes ?? []).filter((c) => hotmartConectado(c.config_api));
  const arranque = Date.now();
  const hayTiempo = () => Date.now() - arranque < PRESUPUESTO_MS;
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
  };
  const resultados: Record<string, unknown>[] = [];

  for (const cliente of conHotmart) {
    if (!hayTiempo()) break;

    try {
      if (modo === 'reclasificar') {
        // Sin API: solo reescribe la clasificación de lo ya guardado.
        const funnels = await cargarFunnels(db, cliente.id);
        const r = await reclasificarRango(db, cliente.id, desde, hasta, funnels);
        resultados.push({ cliente: cliente.nombre, modo, ...r });
        continue;
      }

      if (modo === 'reconciliar') {
        const auth = await obtenerToken(cliente.config_api);
        if (!auth.token) {
          resultados.push({ cliente: cliente.nombre, modo, error: auth.motivo });
          continue;
        }
        if (auth.parche) {
          await db.rpc('fusionar_config_api', {
            p_cliente_id: cliente.id,
            p_parche: auth.parche,
          });
        }
        const r = await reconciliarReembolsos(db, cliente.id, auth.token, 90, log);
        resultados.push({ cliente: cliente.nombre, modo, ...r });
        continue;
      }

      const r = await backfillRango(db, cliente, desde, hasta, { hayTiempo, log });
      resultados.push({ cliente: cliente.nombre, modo: 'backfill', ...r });
    } catch (e: unknown) {
      resultados.push({
        cliente: cliente.nombre,
        modo,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    modo,
    desde,
    hasta,
    clientes: conHotmart.length,
    procesados: resultados.length,
    ms: Date.now() - arranque,
    resultados,
    logs: logs.slice(-50),
  });
}
