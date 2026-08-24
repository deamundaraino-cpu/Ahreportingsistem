/**
 * Adaptador: `VentaHotmart` → la forma que espera el módulo report-utm.
 *
 * Este archivo ERA el parser. Su lógica se ha ido entera a `src/lib/hotmart/`
 * para que exista UN solo parser compartido por el webhook y por la API — antes
 * había dos lecturas del mismo payload que no coincidían en nada.
 *
 * Lo que queda es la traducción a `ParsedHotmartEvent`, que siguen consumiendo
 * `attribution-resolver`, `outbound-emitter`, `sale-notifications` y `meta-capi`
 * sin enterarse del cambio.
 *
 * Tres bugs que desaparecen con la mudanza:
 *   • `transaction_type` era SIEMPRE 'principal' (buscaba `purchase.is_bump` e
 *     `is_upsell`, claves inexistentes en el payload 2.0.0 de Hotmart).
 *   • Un evento desconocido se guardaba como venta APROBADA (`?? 'approved'`).
 *   • `customer_phone` caía a `buyer.document`, y ese documento se enviaba
 *     hasheado a Meta CAPI como teléfono.
 */

import { parsearWebhook } from '@/lib/hotmart/parser';
import type { EstadoVenta, VentaHotmart } from '@/lib/hotmart/tipos';

export type EstadoLegacy = 'approved' | 'pending' | 'refunded' | 'chargeback';

export type ParsedHotmartEvent = {
  platform_sale_id: string;
  amount: number;
  currency: string;
  status: EstadoLegacy;
  sale_timestamp: string | null;
  transaction_type: string | null;
  product_id: string | null;
  product_name: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_country: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
  click_id: string | null;
};

/**
 * `sales_events.status` solo conoce cuatro valores. `hotmart_ventas` guarda el
 * estado exacto (siete), así que aquí solo se pierde granularidad para la tabla
 * heredada, no información.
 */
const ESTADO_LEGACY: Readonly<Record<EstadoVenta, EstadoLegacy>> = {
  aprobada: 'approved',
  completa: 'approved',
  pendiente: 'pending',
  // Nunca se llegó a cobrar: es lo más cercano a "sin resolver", y contarlo
  // como reembolso inflaría la tasa de devoluciones.
  expirada: 'pending',
  reembolsada: 'refunded',
  cancelada: 'refunded',
  chargeback: 'chargeback',
};

/** Traduce una venta ya parseada a la forma heredada. */
export function aEventoLegacy(venta: VentaHotmart): ParsedHotmartEvent {
  return {
    platform_sale_id: venta.transaction_id,
    amount: venta.bruto,
    currency: venta.moneda ?? 'BRL',
    status: ESTADO_LEGACY[venta.estado],
    sale_timestamp: venta.aprobada_at ?? venta.orden_at ?? venta.evento_ts,
    transaction_type: venta.tipo === 'sin_clasificar' ? null : venta.tipo,
    product_id: venta.producto_id,
    product_name: venta.producto_nombre,
    customer_name: venta.comprador_nombre,
    customer_email: venta.comprador_email,
    customer_phone: venta.comprador_telefono,
    customer_country: venta.comprador_pais ?? venta.checkout_pais,
    utm_source: venta.utm_source,
    utm_medium: venta.utm_medium,
    utm_campaign: venta.utm_campaign,
    utm_content: venta.utm_content,
    utm_term: venta.utm_term,
    utm_id: venta.utm_id,
    click_id: venta.click_id,
  };
}

/**
 * Compatibilidad con el llamador antiguo.
 *
 * Diferencia importante de comportamiento: los eventos que NO son ventas
 * (suscripciones, Hotmart Club) devuelven `{ ignorado }` en vez de `{ error }`.
 * Antes producían un 422 y escribían `last_error` en la integración, lo que
 * dejaba la tarjeta de la UI en rojo permanente aunque la ingesta de ventas
 * funcionara perfectamente.
 */
export function parseHotmartPayload(
  payload: unknown
): ParsedHotmartEvent | { ignorado: string } | { error: string } {
  const r = parsearWebhook(payload);
  if (r.ok) return aEventoLegacy(r.venta);
  if (r.motivo === 'no_venta') return { ignorado: r.evento };
  return { error: r.detalle };
}
