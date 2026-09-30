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
//   • { reconciliar }     → reescanea la ventana buscando reembolsos, barre las
//                           aprobaciones tardías y atribuye por lead lo que
//                           quedó sin campaña.
//
// La reconciliación es un modo aparte porque `sales/history` filtra por FECHA DE
// COMPRA, no de cambio de estado: un reembolso de hoy sobre una compra de hace
// un mes no aparece al pedir hoy. Sin esta pasada, una venta devuelta contaba
// como facturación para siempre.
//
// Los tres modos REAGREGAN `metricas_diarias` en las fechas que cambian. Antes
// solo tocaban `hotmart_ventas` y el dashboard seguía con la foto vieja.
//
// La respuesta habla el idioma del runner (`results`, `debugLogs`,
// `filas_escritas`, `partial`): antes devolvía `resultados`/`logs` y el
// historial de `sync_runs` marcaba 0 filas escritas en todas las corridas.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { addDaysISO, colombiaToday } from '@/lib/colombia-date';
import { conDeadline } from '@/lib/rate-limit';
import { backfillRango } from '@/lib/hotmart/backfill';
import { hotmartConectado, obtenerToken } from '@/lib/hotmart/cliente';
import { cargarFunnels } from '@/lib/hotmart/persistencia';
import { reagregarFechasHotmart } from '@/lib/hotmart/reagregar';
import { reatribuirGuardadas } from '@/lib/hotmart/atribucion-db';
import { columnas089Disponibles } from '@/lib/hotmart/esquema';
import {
  barrerAprobacionesTardias,
  reclasificarRango,
  reconciliarReembolsos,
} from '@/lib/hotmart/sync';

/** Presupuesto por petición: al agotarse se persiste lo hecho. */
const PRESUPUESTO_MS = 45_000;
/** Ventana del barrido diario de atribución por lead. */
const DIAS_REATRIBUIR = 30;

type Resultado = Record<string, unknown> & { status: 'ok' | 'error' | 'skipped_budget' };

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const arranque = Date.now();
  // El plazo de reintentos es de ESTA petición. Con el global de antes, el que
  // dejaba `/api/worker` caducado dejaba a este job sin reintentos.
  return conDeadline(arranque + PRESUPUESTO_MS, () => procesar(request, arranque));
}

async function procesar(request: Request, arranque: number) {
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
  const hayTiempo = () => Date.now() - arranque < PRESUPUESTO_MS;
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
  };
  const results: Resultado[] = [];
  let filasEscritas = 0;
  let partial = false;
  let resumeFrom: string | null = null;

  const releerConfig = (id: string) => async () =>
    (await db.from('clientes').select('config_api').eq('id', id).maybeSingle()).data?.config_api;

  const tokenDe = async (cliente: { id: string; config_api: unknown }) => {
    const auth = await obtenerToken(cliente.config_api as never, {
      releer: releerConfig(cliente.id),
    });
    if (auth.token && auth.parche) {
      await db.rpc('fusionar_config_api', { p_cliente_id: cliente.id, p_parche: auth.parche });
    }
    return auth;
  };

  for (const cliente of conHotmart) {
    if (!hayTiempo()) {
      results.push({ cliente: cliente.nombre, modo, status: 'skipped_budget' });
      partial = true;
      continue;
    }

    try {
      if (modo === 'reclasificar') {
        // Sin API: solo reescribe la clasificación de lo ya guardado.
        const funnels = await cargarFunnels(db, cliente.id);
        const r = await reclasificarRango(db, cliente.id, desde, hasta, funnels);
        const re = await reagregarFechasHotmart(db, cliente.id, r.fechas, { funnels, log });
        filasEscritas += r.cambiadas;
        results.push({
          cliente: cliente.nombre,
          modo,
          status: re.errores.length > 0 ? 'error' : 'ok',
          ...r,
          reagregadas: re.reagregadas.length,
          ...(re.errores.length > 0 && { error: re.errores.join(' | ') }),
        });
        continue;
      }

      if (modo === 'reconciliar') {
        const auth = await tokenDe(cliente);
        if (!auth.token) {
          results.push({ cliente: cliente.nombre, modo, status: 'error', error: auth.motivo });
          continue;
        }
        const funnels = await cargarFunnels(db, cliente.id);
        const r = await reconciliarReembolsos(db, cliente.id, auth.token, 90, log);
        const fechas = new Set(r.fechas);

        const barrido = hayTiempo()
          ? await barrerAprobacionesTardias(db, cliente.id, auth.token, funnels, 3, log)
          : null;
        for (const f of barrido?.fechasTocadas ?? []) fechas.add(f);

        // Leads que llegaron después de la venta: se reintenta atribuir lo
        // reciente que sigue sin campaña. Sin la 089 no hay dónde guardarlo.
        // No hace falta reagregar: la atribución no cambia los totales diarios,
        // y el cubo por campaña de las pestañas se lee directamente de la tabla.
        let atribuidas = 0;
        if (hayTiempo() && (await columnas089Disponibles(db))) {
          const inf = await reatribuirGuardadas(db, cliente.id, {
            desde: addDaysISO(colombiaToday(), -DIAS_REATRIBUIR),
            hasta: colombiaToday(),
            aplicar: true,
            log,
          });
          atribuidas = inf.escritas;
        }

        const re = await reagregarFechasHotmart(db, cliente.id, fechas, { funnels, log });
        filasEscritas += r.actualizadas + (barrido?.escritas ?? 0) + atribuidas;
        const incompleto = !r.completo || (barrido !== null && !barrido.completo);
        results.push({
          cliente: cliente.nombre,
          modo,
          status: re.errores.length > 0 ? 'error' : 'ok',
          ...r,
          barrido: barrido && { ventas: barrido.ventas, escritas: barrido.escritas },
          atribuidas,
          reagregadas: re.reagregadas.length,
          ...(incompleto && { incompleto: true }),
          ...(re.errores.length > 0 && { error: re.errores.join(' | ') }),
        });
        continue;
      }

      // Hacia delante: si el presupuesto lo corta, el runner reencola
      // `resumeFrom → fecha_fin` sin repetir lo ya hecho.
      const r = await backfillRango(db, cliente, desde, hasta, {
        hayTiempo,
        log,
        releer: releerConfig(cliente.id),
        adelante: true,
      });
      filasEscritas += r.escritas;
      if (r.fechasTocadas.length > 0) {
        await reagregarFechasHotmart(db, cliente.id, r.fechasTocadas, { log });
      }
      const tope = hasta > colombiaToday() ? colombiaToday() : hasta;
      // Solo un job de UN cliente sabe reanudar: con varios, `resumeFrom` no
      // diría de quién es el tramo pendiente.
      if (clienteId && !r.error && r.ultimoDia && r.ultimoDia < tope) {
        partial = true;
        resumeFrom = addDaysISO(r.ultimoDia, 1);
      }
      results.push({
        cliente: cliente.nombre,
        modo: 'backfill',
        status: r.error ? 'error' : 'ok',
        ...r,
      });
    } catch (e: unknown) {
      results.push({
        cliente: cliente.nombre,
        modo,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const exitos = results.filter((r) => r.status === 'ok').length;
  const errores = results.filter((r) => r.status === 'error').map((r) => String(r.error ?? ''));

  return NextResponse.json({
    // Sin ningún cliente bueno, el runner debe ver el fallo: antes devolvía
    // `ok: true` aunque todos hubieran fallado y la cola se veía verde.
    ok: conHotmart.length === 0 || exitos > 0,
    errores,
    modo,
    desde,
    hasta,
    clientes: conHotmart.length,
    procesados: results.length,
    ms: Date.now() - arranque,
    filas_escritas: filasEscritas,
    partial,
    resumeFrom,
    results,
    debugLogs: logs.slice(-200),
  });
}
