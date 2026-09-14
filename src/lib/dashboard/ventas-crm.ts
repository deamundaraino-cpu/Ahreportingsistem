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
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { colombiaDateOf, colombiaRangeBounds } from '@/lib/colombia-date';

export const CLAVE_CRM_VENTAS = 'crm_ventas';
export const CLAVE_CRM_REVENUE = 'crm_revenue';

export type VentasCrmDia = { ventas: number; importe: number };

/** Agrega por día Colombia. Puro. */
export function agruparVentasCrm(
  filas: Array<{ sale_timestamp?: string | null; received_at?: string | null; amount?: unknown }>
): Map<string, VentasCrmDia> {
  const out = new Map<string, VentasCrmDia>();
  for (const f of filas) {
    const ts = f.sale_timestamp ?? f.received_at;
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

/** Lee las ventas aprobadas del CRM del cliente del reporting en el rango. */
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

  let q = rtm
    .from('sales_events')
    .select('sale_timestamp, received_at, amount')
    .eq('cliente_id', rtmId)
    .eq('platform', 'gohighlevel')
    .eq('status', 'approved');
  if (desde !== 'all') {
    const b = colombiaRangeBounds(desde, hasta);
    q = q.gte('sale_timestamp', b.gte).lt('sale_timestamp', b.lt);
  }
  const { data, error } = await q.limit(10_000);
  if (error) return new Map();
  return agruparVentasCrm(data ?? []);
}
