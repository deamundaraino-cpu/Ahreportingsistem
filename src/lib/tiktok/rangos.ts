/**
 * Troceo de rangos de fechas para los informes de TikTok.
 *
 * `/report/integrated/get/` con `stat_time_day` como dimensión rechaza rangos de
 * más de 30 días (`code` ≠ 0, «The time range cannot exceed 30 days»). La
 * reconciliación pedía 120 días de una vez, TikTok respondía con error y el
 * informe salía «No se pudo leer el gasto de la cuenta» para todo cliente con
 * TikTok: la reconciliación de esta plataforma nunca llegó a funcionar.
 *
 * Puro y sin dependencias: lo importan la ruta de reconciliación y las
 * comprobaciones (`scripts/verify-tiktok-leads.ts`).
 */

/** Máximo de días (inclusivos) que acepta TikTok en un informe diario. */
export const TIKTOK_MAX_DIAS_INFORME = 30;

const DIA_MS = 86_400_000;

function aFecha(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parte [start, end] (YYYY-MM-DD, ambos inclusivos) en ventanas contiguas de
 * como mucho `maxDias` días. Devuelve [] si el rango es inválido o está al revés.
 */
export function trocearRangoDias(
  start: string,
  end: string,
  maxDias: number = TIKTOK_MAX_DIAS_INFORME
): Array<{ start: string; end: string }> {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  const paso = Math.max(1, Math.floor(maxDias));
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return [];
  const ventanas: Array<{ start: string; end: string }> = [];
  for (let ini = a; ini <= b; ini += paso * DIA_MS) {
    const fin = Math.min(ini + (paso - 1) * DIA_MS, b);
    ventanas.push({ start: aFecha(ini), end: aFecha(fin) });
  }
  return ventanas;
}
