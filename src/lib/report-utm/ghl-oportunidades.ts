import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchOpportunityById, searchOpportunitiesPaged, type GhlOportunidad } from './ghl-client';
import { credencialesDe, type GhlIntegrationRow } from './ghl-leads';
import {
  GHL_PLATFORM,
  GHL_VENTA_PREFIX,
  guardarVentaGhl,
  leerVentaGhl,
  revertirVentaGhl,
  type GhlVentaPayload,
} from './ghl-ventas';
import { debeRevertirPorSync, instanteVentaGhl } from './ghl-ventas-atribucion';
import { fetchAllRows } from '@/lib/supabase-paginate';

/**
 * Sync de RESPALDO de las ventas de GoHighLevel (oportunidades ganadas).
 *
 * El webhook de venta es el camino principal, pero un Workflow desactivado, un
 * reintento agotado o un despliegue a mitad de envío pierden la venta en
 * silencio, y `sales_events` no tiene otra fuente. Esto repasa las oportunidades
 * `won` de los últimos 90 días y:
 *
 *   1. Registra las que falten (o re-aprueba las que estaban revertidas) por el
 *      MISMO camino que el webhook (`guardarVentaGhl`): misma atribución, misma
 *      fecha estable.
 *   2. Revierte (`canceled`) las ventas guardadas cuya oportunidad ya no está
 *      ganada. Cada una se confirma con `GET /opportunities/{id}` antes de
 *      tocarla: no basta con «no salió en el listado», que puede estar cortado
 *      por presupuesto de tiempo.
 *
 * Las ventas que ya están `approved` NO se reescriben: el webhook las dejó bien
 * y reescribirlas cada día solo gastaría llamadas a la API.
 *
 * Limitación: solo ve oportunidades con estado `won`. Un cliente cuyo Workflow
 * dispara por ETAPA sin marcar la oportunidad como ganada no tiene respaldo (y
 * sus ventas nunca se revierten por seguir `open`, ver `debeRevertirPorSync`).
 */

const VENTANA_DIAS = 90;
/**
 * El listado viene ordenado por CREACIÓN descendente. Una oportunidad ganada
 * ayer pudo crearse hace meses, así que no se corta al salir de los 90 días,
 * sino al pasar de este margen de creación.
 */
const CREACION_MAX_DIAS = 365;

export type GhlOportunidadesSyncSummary = {
  revisadas: number;
  ganadasEnVentana: number;
  registradas: number;
  revertidas: number;
  errores: number;
  parcial: boolean;
  error?: string;
};

/** Payload sintético con la forma del webhook: `leerVentaGhl` lo entiende igual. */
export function payloadDeOportunidad(o: GhlOportunidad): GhlVentaPayload {
  return {
    origen: 'sync_oportunidades',
    contactId: o.contactId ?? o.contact?.id ?? undefined,
    opportunity: {
      id: o.id,
      name: o.name ?? undefined,
      status: o.status ?? undefined,
      monetaryValue: o.monetaryValue ?? undefined,
      lastStatusChangeAt: o.lastStatusChangeAt ?? undefined,
      lastStageChangeAt: o.lastStageChangeAt ?? undefined,
      updatedAt: o.updatedAt ?? undefined,
      createdAt: o.createdAt ?? undefined,
    },
    email: o.contact?.email ?? undefined,
    phone: o.contact?.phone ?? undefined,
  };
}

export async function syncGhlOportunidadesForCliente(
  supabase: SupabaseClient,
  integration: GhlIntegrationRow,
  opts?: { budgetMs?: number }
): Promise<GhlOportunidadesSyncSummary> {
  const resumen: GhlOportunidadesSyncSummary = {
    revisadas: 0,
    ganadasEnVentana: 0,
    registradas: 0,
    revertidas: 0,
    errores: 0,
    parcial: false,
  };
  const { cred, error: credError } = credencialesDe(integration);
  if (!cred) return { ...resumen, error: credError };

  const db = supabase.schema('report_utm');
  const clienteId = integration.cliente_id;
  const inicio = Date.now();
  const budget = opts?.budgetMs ?? (Number(process.env.GHL_VENTAS_BUDGET_MS) || 40_000);
  const desdeVentaMs = inicio - VENTANA_DIAS * 86_400_000;
  const desdeCreacionMs = inicio - CREACION_MAX_DIAS * 86_400_000;
  const sinTiempo = () => Date.now() - inicio > budget;

  try {
    // Ventas ya guardadas en la ventana (paginado: `fetchAllRows` necesita `id`).
    const guardadas = (await fetchAllRows(() =>
      db
        .from('sales_events')
        .select('id, platform_sale_id, status, raw_payload')
        .eq('cliente_id', clienteId)
        .eq('platform', GHL_PLATFORM)
        .gte('sale_timestamp', new Date(desdeVentaMs).toISOString())
    )) as Array<{
      id: string;
      platform_sale_id: string;
      status: string | null;
      raw_payload: GhlVentaPayload | null;
    }>;
    const porId = new Map(guardadas.map((g) => [g.platform_sale_id, g]));

    // 1) Ganadas en GHL → registrar lo que falte.
    const ganadas = new Set<string>();
    // Que el listado quede incompleto (margen de creación, tope de páginas) no
    // pone en riesgo el paso 2: cada reversión se confirma una por una.
    await searchOpportunitiesPaged(cred, 'won', async (pagina) => {
      for (const o of pagina) {
        resumen.revisadas++;
        const instante = instanteVentaGhl('won', [o]);
        if (!instante || Date.parse(instante) < desdeVentaMs) continue;
        resumen.ganadasEnVentana++;
        const pid = `${GHL_VENTA_PREFIX}${o.id}`;
        ganadas.add(pid);
        if (porId.get(pid)?.status === 'approved') continue;
        if (sinTiempo()) {
          resumen.parcial = true;
          return false;
        }
        const payload = payloadDeOportunidad(o);
        const r = await guardarVentaGhl(supabase, integration, leerVentaGhl(payload), {
          rawPayload: payload as unknown as Record<string, unknown>,
          oportunidad: o,
        });
        if (r.guardada) resumen.registradas++;
        else {
          resumen.errores++;
          console.error('[ghl oportunidades] no se pudo guardar', {
            clienteId,
            id: o.id,
            motivo: r.motivo,
          });
        }
      }
      // Toda la página se creó antes del margen: las siguientes, más antiguas aún.
      const masReciente = Math.max(...pagina.map((o) => Date.parse(o.createdAt ?? '') || 0));
      if (masReciente > 0 && masReciente < desdeCreacionMs) return false;
      if (sinTiempo()) {
        resumen.parcial = true;
        return false;
      }
      return true;
    });
    // 2) Guardadas que ya no salen como ganadas → confirmar y revertir.
    for (const g of guardadas) {
      if (g.status !== 'approved' || ganadas.has(g.platform_sale_id)) continue;
      if (!g.platform_sale_id.startsWith(GHL_VENTA_PREFIX)) continue;
      const oppId = g.platform_sale_id.slice(GHL_VENTA_PREFIX.length);
      // `contacto:<id>`: venta sin oportunidad, no hay nada que consultar.
      if (oppId.startsWith('contacto:')) continue;
      if (sinTiempo()) {
        resumen.parcial = true;
        break;
      }
      let actual: GhlOportunidad | null;
      try {
        actual = await fetchOpportunityById(oppId, cred);
      } catch (e) {
        // Un error de red o de permisos no decide nada: se reintenta mañana.
        resumen.errores++;
        console.error(
          '[ghl oportunidades] no se pudo releer',
          oppId,
          e instanceof Error ? e.message : e
        );
        continue;
      }
      const registrado = g.raw_payload ? leerVentaGhl(g.raw_payload).estado : null;
      const estadoActual = actual ? (actual.status ?? '').toLowerCase() || 'open' : null;
      if (!debeRevertirPorSync(registrado, estadoActual)) continue;
      const r = await revertirVentaGhl(db, clienteId, g.platform_sale_id);
      if (r.revertida) resumen.revertidas++;
      if (r.error) resumen.errores++;
    }

    return resumen;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...resumen, error: msg };
  }
}
