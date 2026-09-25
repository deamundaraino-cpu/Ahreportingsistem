// ════════════════════════════════════════════════════════════════
// Qué aporta UNA venta de Hotmart a las métricas `hm_*`
// ════════════════════════════════════════════════════════════════
//
// Es la ÚNICA definición. La usan el motor del BI (`queryHotmartDirect` y el
// pivot de `bi-query.ts`) y el cubo de las pestañas (`cubo-db.ts`). Si cada uno
// decidiera por su cuenta qué es una «compra» o qué cuenta como cobrado, la
// misma fórmula (`meta_spend / hm_compras`) daría un número distinto en un
// informe y en una pestaña, y nadie sabría cuál creer.
//
// ── Ventas frente a compras ─────────────────────────────────────
// `hm_ventas` cuenta TRANSACCIONES cobradas: el bump y el upsell de un mismo
// comprador son ventas aparte. Para Cris tributario (jul-ago 2026) son 88 = 53
// principales + 34 bumps + 1 upsell. Dividir el gasto entre 88 da un CPA ~40 %
// más bajo que lo que de verdad cuesta conseguir un comprador.
//
// `hm_compras` cuenta PEDIDOS: una venta cobrada que no cuelga de otra. Se
// define por exclusión y no como `tipo = 'principal'` para que no caiga a 0 en
// un cliente sin embudo configurado (ahí todo es `sin_clasificar`):
//   · no es bump, upsell, downsell ni suscripción (tipo),
//   · no es order bump (lo dice Hotmart, aunque el mapa de ofertas falle),
//   · no tiene transacción padre.
// Con el embudo configurado coincide con el número de principales (53).
// Las suscripciones se excluyen porque sus cobros recurrentes llegan como
// transacciones nuevas y no son compradores nuevos.

import { ESTADOS_COBRADOS, ESTADOS_DEVUELTOS, type EstadoVenta } from './tipos';

/** Columnas de `hotmart_ventas` que necesita `aporteDeVenta`. */
export const COLUMNAS_APORTE = [
  'fecha_venta',
  'estado',
  'tipo',
  'es_order_bump',
  'parent_transaction_id',
  'neto_productor_usd',
  'bruto_usd',
] as const;

export interface FilaAporte {
  fecha_venta?: string | null;
  estado?: string | null;
  tipo?: string | null;
  es_order_bump?: boolean | null;
  parent_transaction_id?: string | null;
  neto_productor_usd?: number | string | null;
  bruto_usd?: number | string | null;
}

/** Las medidas aditivas `hm_*`. Las derivadas (ROAS, CPA…) salen de estas. */
export interface AporteHotmart {
  hm_ventas: number;
  hm_compras: number;
  hm_bumps: number;
  hm_neto: number;
  hm_bruto: number;
  hm_reembolsos: number;
  hm_neto_reembolsado: number;
  /** Neto y bruto SIN convertir a la moneda de reporte: en dólares. */
  hm_neto_usd: number;
  hm_bruto_usd: number;
}

export const CLAVES_APORTE: readonly (keyof AporteHotmart)[] = [
  'hm_ventas',
  'hm_compras',
  'hm_bumps',
  'hm_neto',
  'hm_bruto',
  'hm_reembolsos',
  'hm_neto_reembolsado',
  'hm_neto_usd',
  'hm_bruto_usd',
] as const;

/** Las claves de importe (se convierten a la moneda de reporte). */
export const CLAVES_APORTE_DINERO: readonly (keyof AporteHotmart)[] = [
  'hm_neto',
  'hm_bruto',
  'hm_neto_reembolsado',
] as const;

export function aporteVacio(): AporteHotmart {
  return {
    hm_ventas: 0,
    hm_compras: 0,
    hm_bumps: 0,
    hm_neto: 0,
    hm_bruto: 0,
    hm_reembolsos: 0,
    hm_neto_reembolsado: 0,
    hm_neto_usd: 0,
    hm_bruto_usd: 0,
  };
}

const TIPOS_NO_COMPRA = new Set(['bump', 'upsell', 'downsell', 'suscripcion']);

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function esCobrada(estado: unknown): boolean {
  return ESTADOS_COBRADOS.includes(String(estado ?? '') as EstadoVenta);
}

export function esDevuelta(estado: unknown): boolean {
  return ESTADOS_DEVUELTOS.includes(String(estado ?? '') as EstadoVenta);
}

/** ¿Es un pedido nuevo (y no un añadido a otro)? Ver la cabecera. */
export function esCompra(fila: FilaAporte): boolean {
  return (
    esCobrada(fila.estado) &&
    !TIPOS_NO_COMPRA.has(String(fila.tipo ?? '')) &&
    fila.es_order_bump !== true &&
    !fila.parent_transaction_id
  );
}

/** ¿Es un order bump cobrado? Base de `hm_tasa_bump`. */
export function esBump(fila: FilaAporte): boolean {
  return esCobrada(fila.estado) && (fila.tipo === 'bump' || fila.es_order_bump === true);
}

/**
 * Lo que aporta una venta. `convertir(usd, fecha)` pasa dólares a la moneda de
 * reporte con la tasa del día de ESA venta (identidad si el cliente reporta en
 * USD). Pendientes, canceladas y expiradas no aportan nada: aún no son dinero.
 *
 * El reembolso se imputa a la fecha de la VENTA, no a la del reembolso: es lo
 * que hace que el retorno de una campaña refleje lo que de verdad dejó.
 */
export function aporteDeVenta(
  fila: FilaAporte,
  convertir: (usd: number, fecha: string) => number = (usd) => usd
): AporteHotmart {
  const a = aporteVacio();
  const fecha = String(fila.fecha_venta ?? '');
  const netoUsd = num(fila.neto_productor_usd);
  const brutoUsd = num(fila.bruto_usd);

  if (esDevuelta(fila.estado)) {
    a.hm_reembolsos = 1;
    a.hm_neto_reembolsado = convertir(netoUsd, fecha);
    return a;
  }
  if (!esCobrada(fila.estado)) return a;

  a.hm_ventas = 1;
  a.hm_compras = esCompra(fila) ? 1 : 0;
  a.hm_bumps = esBump(fila) ? 1 : 0;
  a.hm_neto = convertir(netoUsd, fecha);
  a.hm_bruto = convertir(brutoUsd, fecha);
  a.hm_neto_usd = netoUsd;
  a.hm_bruto_usd = brutoUsd;
  return a;
}

/** Suma `b` sobre `a` (muta y devuelve `a`). */
export function sumarAporte(a: AporteHotmart, b: AporteHotmart): AporteHotmart {
  for (const k of CLAVES_APORTE) a[k] += b[k];
  return a;
}

/**
 * Las derivadas, con una sola definición de cada denominador.
 *
 * `null` cuando falta una de las partes (no 0): un ROAS de 0 con gasto y sin
 * ventas se lee como «no se recuperó nada», cuando puede ser que no haya datos.
 *
 * La tasa de reembolso divide entre lo facturado ANTES de devolver
 * (neto + reembolsado): `hm_neto` ya excluye lo reembolsado, y dividir solo
 * entre él daba 100 % cuando se devolvía la mitad.
 */
export function derivadasHotmart(
  a: Pick<
    AporteHotmart,
    'hm_ventas' | 'hm_compras' | 'hm_bumps' | 'hm_neto' | 'hm_neto_reembolsado'
  >,
  gasto: number,
  leads?: number
): {
  hm_roas: number | null;
  hm_cpa: number | null;
  hm_cpa_compra: number | null;
  hm_ticket_medio: number | null;
  hm_ticket_compra: number | null;
  hm_tasa_reembolso: number | null;
  hm_tasa_bump: number | null;
  hm_conversion: number | null;
} {
  const base = a.hm_neto + a.hm_neto_reembolsado;
  return {
    hm_roas: gasto > 0 && a.hm_neto > 0 ? a.hm_neto / gasto : null,
    hm_cpa: gasto > 0 && a.hm_ventas > 0 ? gasto / a.hm_ventas : null,
    hm_cpa_compra: gasto > 0 && a.hm_compras > 0 ? gasto / a.hm_compras : null,
    hm_ticket_medio: a.hm_ventas > 0 ? a.hm_neto / a.hm_ventas : null,
    hm_ticket_compra: a.hm_compras > 0 ? a.hm_neto / a.hm_compras : null,
    hm_tasa_reembolso: base > 0 ? (a.hm_neto_reembolsado / base) * 100 : null,
    hm_tasa_bump: a.hm_compras > 0 ? (a.hm_bumps / a.hm_compras) * 100 : null,
    hm_conversion: leads !== undefined && leads > 0 ? (a.hm_compras / leads) * 100 : null,
  };
}
