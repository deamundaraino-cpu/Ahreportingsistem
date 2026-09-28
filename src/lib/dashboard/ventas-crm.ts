/**
 * Ventas del CRM (GoHighLevel) en el dashboard clásico.
 *
 * El webhook de venta de GHL escribe en `report_utm.sales_events`, que el BI de
 * Report-UTM ya lee. El PM pidió que la venta se vea TAMBIÉN en el reporting
 * (reunión del 2026-09-08): aquí se agregan por día Colombia y se inyectan en las
 * filas de `metricas_diarias` como dos claves numéricas, `crm_ventas` y
 * `crm_revenue`. El motor de fórmulas toma cualquier clave numérica de la fila,
 * así que funcionan en tarjetas, columnas y fórmulas (`meta_spend / crm_ventas`)
 * sin tocarlo.
 *
 * Es aditivo: con cero ventas del CRM las filas no cambian.
 *
 * ── Mismo criterio que el BI (2026-09-28) ───────────────────────
 * Antes contaba solo `platform = 'gohighlevel'`, fechaba por `sale_timestamp`
 * y cortaba en 10.000 filas sin avisar, mientras el BI (`queryReportUtmSales` de
 * `bi-query.ts`) cuenta TODA plataforma que no sea Hotmart, fecha por
 * `created_at` y pagina. Un mismo cliente enseñaba dos cifras de ventas según la
 * pantalla. Ahora es el criterio del BI: `status = 'approved'`,
 * `platform <> 'hotmart'` (Hotmart se cuenta en su propia fuente, convertida y
 * con reembolsos), día Colombia de `created_at` y paginación por keyset. Las
 * ventas de GHL guardan `created_at` = instante del cierre (`ghl-ventas.ts`), así
 * que fechar por él no las mueve de día.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { colombiaDateOf, colombiaRangeBounds, colombiaToday } from '@/lib/colombia-date';
import { fetchAllRows } from '@/lib/supabase-paginate';

/** Suelo del rango «todo»: el mismo `2020-01-01` que usa el resto del dashboard. */
const INICIO_TODO = '2020-01-01';

export const CLAVE_CRM_VENTAS = 'crm_ventas';
export const CLAVE_CRM_REVENUE = 'crm_revenue';

export type VentasCrmDia = { ventas: number; importe: number };

/**
 * Agrega por día Colombia de `created_at`, el campo con el que fecha el BI.
 * `sale_timestamp`/`received_at` quedan de respaldo para filas sin él. Puro.
 */
export function agruparVentasCrm(
  filas: Array<{
    created_at?: string | null;
    sale_timestamp?: string | null;
    received_at?: string | null;
    amount?: unknown;
  }>
): Map<string, VentasCrmDia> {
  const out = new Map<string, VentasCrmDia>();
  for (const f of filas) {
    const ts = f.created_at ?? f.sale_timestamp ?? f.received_at;
    if (!ts) continue;
    const dia = colombiaDateOf(new Date(ts));
    const cur = out.get(dia) ?? { ventas: 0, importe: 0 };
    cur.ventas += 1;
    cur.importe += Number(f.amount ?? 0) || 0;
    out.set(dia, cur);
  }
  return out;
}

/**
 * Añade `crm_ventas` y `crm_revenue` a cada fila por su `fecha`. Un día con
 * ventas del CRM pero sin fila de métricas (sin gasto ni sync) se añade como
 * fila propia: si no, esas ventas desaparecerían del total.
 */
export function inyectarVentasCrm<T extends Record<string, any>>(
  filas: T[],
  porDia: Map<string, VentasCrmDia>
): T[] {
  if (porDia.size === 0) return filas;
  const vistos = new Set<string>();
  const out = filas.map((f) => {
    const dia = String(f.fecha ?? '').slice(0, 10);
    const v = porDia.get(dia);
    if (!v) return f;
    vistos.add(dia);
    return { ...f, [CLAVE_CRM_VENTAS]: v.ventas, [CLAVE_CRM_REVENUE]: v.importe };
  });
  for (const [dia, v] of porDia) {
    if (vistos.has(dia)) continue;
    out.push({ fecha: dia, [CLAVE_CRM_VENTAS]: v.ventas, [CLAVE_CRM_REVENUE]: v.importe } as any);
  }
  return out.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}

/**
 * Lee las ventas aprobadas de `sales_events` (todo menos Hotmart) del cliente
 * del reporting en el rango. `desde = 'all'` se acota a [2020-01-01, hasta].
 */
export async function cargarVentasCrmPorDia(
  db: any,
  publicId: string,
  desde: string,
  hasta: string
): Promise<Map<string, VentasCrmDia>> {
  const rtm = db.schema('report_utm');
  const { data: espejo } = await rtm
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .limit(1);
  const rtmId = espejo?.[0]?.id as string | undefined;
  if (!rtmId) return new Map();

  const esFecha = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const inicio = desde === 'all' || !esFecha(desde) ? INICIO_TODO : desde;
  const fin = esFecha(hasta) ? hasta : colombiaToday();
  const b = colombiaRangeBounds(inicio, fin);

  // Estricto: un recuento parcial con pinta de definitivo es peor que nada, y
  // quien llama ya convierte el fallo en «sin ventas del CRM».
  const data = await fetchAllRows(
    () =>
      rtm
        .from('sales_events')
        .select('id, created_at, amount')
        .eq('cliente_id', rtmId)
        .neq('platform', 'hotmart')
        .eq('status', 'approved')
        .gte('created_at', b.gte)
        .lt('created_at', b.lt),
    1000,
    200_000,
    { estricto: true }
  );
  return agruparVentasCrm(data as Array<{ created_at?: string | null; amount?: unknown }>);
}
