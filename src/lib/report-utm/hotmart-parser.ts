/**
 * Adaptador: `VentaHotmart` → la forma que espera el módulo report-utm.
 *
 * Este archivo ERA el parser. Su lógica se ha ido entera a `src/lib/hotmart/`
 * para que exista UN solo parser compartido por el webhook y por la API — antes
 * había dos lecturas del mismo payload que no coincidían en nada.
 *
 * Lo que queda es la traducción a `ParsedHotmartEvent`, que siguen consumiendo
 * `attribution-resolver`, `outbound-emitter`, `sale-notifications` y `meta-capi`
 * sin enterarse del cambio, y las decisiones PURAS del webhook (qué se espeja,
 * qué se notifica) para que las comprobaciones las puedan probar sin base.
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
import type { OutboundEventType } from './outbound-emitter';

export type EstadoLegacy = 'approved' | 'pending' | 'refunded' | 'chargeback' | 'canceled';

export type ParsedHotmartEvent = {
  platform_sale_id: string;
  amount: number;
  /** `null` si Hotmart no la mandó: no se inventa BRL (ver `aEventoLegacy`). */
  currency: string | null;
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
 * `sales_events.status` conoce cinco valores. `hotmart_ventas` guarda el estado
 * exacto (siete), así que aquí solo se pierde granularidad para la tabla
 * heredada, no información.
 *
 * `cancelada` era 'refunded': un pedido que nunca se cobró contaba como
 * reembolso, inflaba la tasa de devoluciones y mandaba «Venta reembolsada».
 * `sales_events.status` no tiene CHECK (verificado el 2026-09-25), así que el
 * valor nuevo entra sin migración.
 */
const ESTADO_LEGACY: Readonly<Record<EstadoVenta, EstadoLegacy>> = {
  aprobada: 'approved',
  // Mismo valor que `aprobada`: la deduplicación de avisos impide que el
  // PURCHASE_COMPLETE mande una segunda «Venta aprobada».
  completa: 'approved',
  pendiente: 'pending',
  // Nunca se llegó a cobrar: es lo más cercano a "sin resolver", y contarlo
  // como reembolso inflaría la tasa de devoluciones.
  expirada: 'pending',
  reembolsada: 'refunded',
  cancelada: 'canceled',
  chargeback: 'chargeback',
};

/** Traduce una venta ya parseada a la forma heredada. */
export function aEventoLegacy(venta: VentaHotmart): ParsedHotmartEvent {
  return {
    platform_sale_id: venta.transaction_id,
    amount: venta.bruto,
    // Sin divisa no hay valor: antes caía a 'BRL' y una venta en CLP o COP se
    // mandaba a Meta y a Google como reales brasileños.
    currency: venta.moneda ?? null,
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

// ────────────────────────────────────────────────────────────────
// Identificadores de clic EXPLÍCITOS
// ────────────────────────────────────────────────────────────────

type AnyObj = Record<string, unknown>;

function textoPlano(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

/**
 * `gclid` y `fbclid` SOLO si el payload los trae con ese nombre.
 *
 * `venta.click_id` es el primero que aparezca de fbclid/gclid/ttclid/click_id,
 * así que no dice de qué plataforma es: mandarlo a Google Ads como `gclid` o a
 * Meta como `fbc` subía un clic de otra red (y antes, hasta el `xcod`). Se
 * buscan en los mismos sitios y en el mismo orden que el parser.
 */
export function clickIdsExplicitos(payload: unknown): {
  gclid: string | null;
  fbclid: string | null;
} {
  const wh = (payload && typeof payload === 'object' ? payload : {}) as AnyObj;
  const datos = (wh.data ?? wh.event_data ?? {}) as AnyObj;
  const compra = (datos.purchase ?? wh.purchase ?? {}) as AnyObj;
  const fuentes = [
    (compra.customData ?? compra.custom_data ?? {}) as AnyObj,
    (compra.tracking ?? {}) as AnyObj,
    (compra.origin ?? {}) as AnyObj,
    compra,
    datos,
  ];
  const buscar = (clave: string): string | null => {
    for (const f of fuentes) {
      const v = f && typeof f === 'object' ? textoPlano(f[clave]) : null;
      if (v) return v;
    }
    return null;
  };
  return { gclid: buscar('gclid'), fbclid: buscar('fbclid') };
}

// ────────────────────────────────────────────────────────────────
// Decisiones del webhook (puras)
// ────────────────────────────────────────────────────────────────

/**
 * ¿Se espeja el evento en `sales_events`?
 *
 * Solo si `hotmart_ventas` lo aplicó como el más reciente (`escrita`). Un
 * reintento viejo o un evento que solo rellenó huecos NO puede pisar el status
 * de `sales_events` ni disparar avisos. Las dos excepciones conservan el
 * respaldo de siempre, para no perder el evento:
 *   · sin puente a `public.clientes` la venta no puede ir a `hotmart_ventas`;
 *   · si escribir en `hotmart_ventas` lanzó, no hay veredicto.
 *
 * `guardado`: el resultado de la RPC, o `null` si lanzó.
 */
export function decidirEspejo(a: {
  hayPuente: boolean;
  guardado: { escrita: boolean } | null;
}): boolean {
  if (!a.hayPuente) return true;
  if (!a.guardado) return true;
  return a.guardado.escrita;
}

/**
 * Estado por el que se avisa (notificación + webhooks salientes).
 *
 * `aprobada` y `completa` comparten 'cobrada': el PURCHASE_COMPLETE llega días
 * después del APPROVED y NO es otra venta. `null` = no hay nada que avisar.
 */
export type EstadoAviso = 'cobrada' | 'pendiente' | 'reembolsada' | 'chargeback';

const AVISO_POR_STATUS: Readonly<Record<EstadoLegacy, EstadoAviso | null>> = {
  approved: 'cobrada',
  pending: 'pendiente',
  refunded: 'reembolsada',
  chargeback: 'chargeback',
  // Sin tipo de webhook saliente ni notificación: un pedido cancelado no es
  // un reembolso, y avisar «Venta reembolsada» por él era el bug.
  canceled: null,
};

export function estadoAviso(status: string | null | undefined): EstadoAviso | null {
  if (!status) return null;
  return AVISO_POR_STATUS[status as EstadoLegacy] ?? null;
}

/** Tipo de webhook saliente de cada status. `canceled` no tiene. */
export function tipoSaliente(status: EstadoLegacy): OutboundEventType | null {
  const mapa: Record<EstadoLegacy, OutboundEventType | null> = {
    approved: 'sale.approved',
    pending: 'sale.pending',
    refunded: 'sale.refunded',
    chargeback: 'sale.chargeback',
    canceled: null,
  };
  return mapa[status];
}

export type DecisionAviso =
  | { accion: 'nada'; motivo: 'sin_aviso' | 'ya_avisado' }
  /**
   * Reclamar `hotmart_ventas.notificado_estado`; solo avisa quien gana.
   * `soloAnotar`: el estado previo de `sales_events` ya lo avisó, así que se
   * reclama para dejarlo anotado pero no se avisa aunque se gane.
   */
  | { accion: 'reclamar'; estado: EstadoAviso; soloAnotar: boolean }
  | { accion: 'avisar'; estado: EstadoAviso };

/**
 * Deduplicación de avisos. Hotmart reintenta, y cada reintento mandaba otra
 * «Venta aprobada» y otro webhook saliente.
 *
 *   modo 'reclamo'       (089 aplicada y fila en `hotmart_ventas`): se decide
 *                        con un UPDATE condicional atómico sobre
 *                        `notificado_estado`. Dos reintentos simultáneos no
 *                        pueden ganar los dos.
 *   modo 'estado_previo' (sin 089, sin puente o con la escritura fallida): se
 *                        compara con el `sales_events.status` leído ANTES del
 *                        upsert. No es atómico, pero corta los reintentos, que
 *                        llegan espaciados.
 *
 * El modo 'reclamo' también mira el estado previo: una venta avisada ANTES de
 * aplicar la 089 tiene `notificado_estado` a NULL, y su PURCHASE_COMPLETE
 * ganaría el reclamo y mandaría una segunda «Venta aprobada».
 */
export function decidirAviso(a: {
  status: EstadoLegacy;
  modo: 'reclamo' | 'estado_previo';
  /** `sales_events.status` antes del upsert. */
  estadoPrevio?: string | null;
}): DecisionAviso {
  const estado = estadoAviso(a.status);
  if (!estado) return { accion: 'nada', motivo: 'sin_aviso' };
  const yaAvisado = estadoAviso(a.estadoPrevio) === estado;
  if (a.modo === 'reclamo') return { accion: 'reclamar', estado, soloAnotar: yaAvisado };
  if (yaAvisado) return { accion: 'nada', motivo: 'ya_avisado' };
  return { accion: 'avisar', estado };
}
