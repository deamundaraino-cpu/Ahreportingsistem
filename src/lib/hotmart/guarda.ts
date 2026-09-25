// ════════════════════════════════════════════════════════════════
// Guarda de Hotmart del worker: ¿escribir el registro del día o preservar?
// ════════════════════════════════════════════════════════════════
//
// La guarda vivía inline en `worker/route.ts` y tenía tres agujeros:
//
//   1. «Cero» era `ventas_count === 0`, sin mirar los reembolsos. Un día cuyo
//      ÚNICO pedido se reembolsó daba 0 cobradas y la guarda lo tomaba por un
//      fallo: omitía los campos de Hotmart en ESA corrida y en todas las
//      siguientes, así que la facturación reembolsada se quedaba para siempre.
//   2. La fila previa solo traía `ventas_principal_count`: los conteos de bump,
//      upsell y downsell de la caída relativa eran siempre 0.
//   3. Cuando una aprobación movía `fecha_venta` a otro día, el día viejo
//      agregaba a 0 y la guarda conservaba su conteo: la venta contaba DOS veces.
//
// El fondo del asunto: la guarda existe para protegerse de una API que falla a
// medias. Pero desde la 065 la verdad está en `hotmart_ventas`, y la agregación
// ya no depende de si la descarga de HOY vino completa (si no vino, `apiSuccess`
// es false y no se agrega). Para las fechas que la tabla CUBRE, el cero de la
// tabla es un cero de verdad. La guarda de cero/caída solo tiene sentido para
// fechas ANTERIORES a la primera fila de la tabla: los datos heredados del
// worker viejo, que la tabla no conoce.

import type { RegistroHotmart } from './sync';

/** Fila previa de `metricas_diarias` (solo las columnas de Hotmart que mira la guarda). */
export type FilaPreviaHotmart = {
  ventas_principal?: number | string | null;
  ventas_bump?: number | string | null;
  ventas_upsell?: number | string | null;
  ventas_downsell?: number | string | null;
  ventas_principal_count?: number | string | null;
  ventas_bump_count?: number | string | null;
  ventas_upsell_count?: number | string | null;
  ventas_downsell_count?: number | string | null;
  ventas_reembolsado?: number | string | null;
  ventas_reembolsado_count?: number | string | null;
} | null;

const n = (v: unknown) => Number(v ?? 0) || 0;

/** ¿La fila previa tenía algo de Hotmart? Incluye downsell y reembolsos. */
export function tieneDatosHotmart(prev: FilaPreviaHotmart): boolean {
  if (!prev) return false;
  return (
    n(prev.ventas_principal) > 0 ||
    n(prev.ventas_bump) > 0 ||
    n(prev.ventas_upsell) > 0 ||
    n(prev.ventas_downsell) > 0 ||
    n(prev.ventas_principal_count) > 0 ||
    n(prev.ventas_bump_count) > 0 ||
    n(prev.ventas_upsell_count) > 0 ||
    n(prev.ventas_downsell_count) > 0 ||
    n(prev.ventas_reembolsado_count) > 0
  );
}

/** Transacciones del registro que cuentan como «hubo algo»: cobradas + devueltas. */
export function transaccionesDelRegistro(
  r: Pick<RegistroHotmart, 'ventas_count' | 'reembolsado_count'>
): number {
  return r.ventas_count + r.reembolsado_count;
}

export type DecisionGuarda = {
  /** true = omitir los campos de Hotmart del upsert (preservar lo que hay). */
  preservar: boolean;
  motivo: null | 'zero_vs_previous' | 'caida_relativa';
  ventasPrevias: number;
  ventasAhora: number;
};

/**
 * Decide si el registro de Hotmart de un día se escribe o se preserva lo previo.
 *
 * `tablaCubreFecha`: la fecha es igual o posterior a la primera `fecha_venta`
 * del cliente en `hotmart_ventas`. Para esas fechas la tabla manda.
 * El fallo de la API (`apiSuccess === false`) lo decide el worker aparte.
 */
export function decidirGuardaHotmart(
  prev: FilaPreviaHotmart,
  registro: Pick<RegistroHotmart, 'ventas_count' | 'reembolsado_count'>,
  tablaCubreFecha: boolean
): DecisionGuarda {
  const ventasPrevias =
    n(prev?.ventas_principal_count) +
    n(prev?.ventas_bump_count) +
    n(prev?.ventas_upsell_count) +
    n(prev?.ventas_downsell_count) +
    n(prev?.ventas_reembolsado_count);
  const ventasAhora = transaccionesDelRegistro(registro);
  const base = { ventasPrevias, ventasAhora };

  if (tablaCubreFecha) return { preservar: false, motivo: null, ...base };

  if (ventasAhora === 0 && tieneDatosHotmart(prev)) {
    return { preservar: true, motivo: 'zero_vs_previous', ...base };
  }
  if (ventasPrevias >= 5 && ventasAhora < ventasPrevias * 0.6) {
    return { preservar: true, motivo: 'caida_relativa', ...base };
  }
  return { preservar: false, motivo: null, ...base };
}
