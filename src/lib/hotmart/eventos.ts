// ════════════════════════════════════════════════════════════════
// Catálogo de eventos de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Dos bugs vivían en el mapa anterior (`hotmart-parser.ts:114`):
//
//   const status = STATUS_MAP[eventName] ?? STATUS_MAP[purchaseStatus] ?? 'approved'
//
//   1. El fallback `?? 'approved'`. Cualquier evento que Hotmart añadiera y que
//      trajera un objeto `purchase` se guardaba como VENTA APROBADA. El número
//      sube, parece plausible, y nadie se entera.
//   2. El término del medio era código muerto: `purchase.status` vale
//      "APPROVED"/"REFUNDED", mientras el mapa está indexado por NOMBRE DE
//      EVENTO ("PURCHASE_APPROVED"). Nunca coincidía.
//
// Aquí un evento desconocido devuelve `desconocido` y NO se cuenta. Y los
// eventos que no son ventas (suscripciones, Hotmart Club) se reconocen
// explícitamente: antes devolvían 422 y escribían `last_error` en la
// integración, dejando la tarjeta de la UI en rojo permanente aunque la ingesta
// de ventas funcionase perfectamente.

import type { EstadoVenta } from './tipos'

/** Nombre de evento → estado normalizado. Solo eventos que SON una venta. */
export const ESTADO_POR_EVENTO: Readonly<Record<string, EstadoVenta>> = {
    PURCHASE_APPROVED: 'aprobada',
    PURCHASE_COMPLETE: 'completa',
    PURCHASE_BILLET_PRINTED: 'pendiente',
    PURCHASE_PROTEST: 'pendiente',
    PURCHASE_DELAYED: 'pendiente',
    PURCHASE_WAITING_PAYMENT: 'pendiente',
    PURCHASE_OUT_OF_SHOPPING_CART: 'pendiente',
    PURCHASE_REFUNDED: 'reembolsada',
    PURCHASE_CHARGEBACK: 'chargeback',
    PURCHASE_CANCELED: 'cancelada',
    PURCHASE_EXPIRED: 'expirada',
}

/**
 * Eventos legítimos de Hotmart que NO son una venta.
 *
 * No traen `data.purchase`, así que el parser viejo los rechazaba con 422. Se
 * responden con 200 y se ignoran: que Hotmart deje de reintentarlos es lo
 * correcto, y la integración no debe marcarse como rota por ellos.
 */
export const EVENTOS_NO_VENTA: ReadonlySet<string> = new Set([
    'SUBSCRIPTION_CANCELLATION',
    'SWITCH_PLAN',
    'UPDATE_SUBSCRIPTION_CHARGE_DATE',
    'CLUB_FIRST_ACCESS',
    'CLUB_MODULE_COMPLETED',
])

/**
 * Estado de la transacción tal y como lo devuelve la API REST (no el webhook).
 *
 * `sales/history` trae `purchase.status` con el vocabulario de la plataforma.
 * Es un mapa DISTINTO al de eventos justamente para no repetir el bug de
 * indexar uno con las claves del otro.
 */
export const ESTADO_POR_STATUS_API: Readonly<Record<string, EstadoVenta>> = {
    APPROVED: 'aprobada',
    COMPLETE: 'completa',
    BILLET_PRINTED: 'pendiente',
    WAITING_PAYMENT: 'pendiente',
    UNDER_ANALISYS: 'pendiente',
    UNDER_ANALYSIS: 'pendiente',
    PROTESTED: 'pendiente',
    DELAYED: 'pendiente',
    REFUNDED: 'reembolsada',
    CHARGEBACK: 'chargeback',
    CANCELLED: 'cancelada',
    CANCELED: 'cancelada',
    EXPIRED: 'expirada',
    STARTED: 'pendiente',
    DLOCAL_ANALYSIS: 'pendiente',
}

export type ClaseEvento = 'venta' | 'no_venta' | 'desconocido'

/** Clasifica un nombre de evento. Un evento nuevo de Hotmart es `desconocido`. */
export function clasificarEvento(nombre: string | null | undefined): ClaseEvento {
    if (!nombre) return 'desconocido'
    const n = nombre.trim().toUpperCase()
    if (ESTADO_POR_EVENTO[n]) return 'venta'
    if (EVENTOS_NO_VENTA.has(n)) return 'no_venta'
    return 'desconocido'
}

/** Estado de un evento de venta. `null` si el evento no es una venta conocida. */
export function estadoDeEvento(nombre: string | null | undefined): EstadoVenta | null {
    if (!nombre) return null
    return ESTADO_POR_EVENTO[nombre.trim().toUpperCase()] ?? null
}

/** Estado de un `purchase.status` de la API REST. `null` si no se reconoce. */
export function estadoDeStatusApi(status: string | null | undefined): EstadoVenta | null {
    if (!status) return null
    return ESTADO_POR_STATUS_API[status.trim().toUpperCase()] ?? null
}
