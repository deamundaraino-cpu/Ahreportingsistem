// ════════════════════════════════════════════════════════════════
// Zona horaria por cliente — infraestructura, DESACTIVADA por defecto
// ════════════════════════════════════════════════════════════════
//
// Todo el sistema agrupa los días en hora Colombia (UTC-5 fijo,
// `colombia-date.ts`). La auditoría de Hotmart (2026-09-25) encontró que para
// Cris tributario eso no coincide con su cuenta de Meta, que está en
// `America/Santiago` (UTC-4 en invierno, UTC-3 en verano): las ventas entre las
// 22:00 y las 24:00 de Chile caen en el día siguiente respecto al gasto.
//
// Por qué esto NO se activa todavía, y no solo para Hotmart:
//   · Los leads se agrupan en SQL con `AT TIME ZONE 'America/Bogota'`
//     (`bi_leads_por_dia`, `bi_respuestas_por_dia`…). Cambiar solo las ventas
//     desalinearía ventas y leads del mismo día, que es peor que el desfase
//     actual de 1-2 horas con Meta.
//   · `hotmart_ventas.fecha_venta` se materializa al escribir: activarlo exige
//     recalcular el histórico y reagregar `metricas_diarias`.
// Activarlo es un cambio de TODO el módulo a la vez (leads, ventas, gasto), con
// su migración de datos. Mientras tanto, estas funciones son puras, probadas
// (`verify-hotmart-atribucion.ts`) y sin consumidores.

export const ZONA_POR_DEFECTO = 'America/Bogota';

/** ¿`Intl` conoce esta zona? */
export function zonaValida(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zona del cliente (`config.zona_horaria`), o Colombia si no tiene o no es válida. */
export function zonaHorariaDeCliente(config: unknown): string {
  const tz = (config as { zona_horaria?: unknown } | null)?.zona_horaria;
  return zonaValida(tz) ? tz : ZONA_POR_DEFECTO;
}

/** Desfase de la zona en ese instante, en minutos (UTC-3 → -180). */
function desfaseMin(tz: string, instante: number): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instante));
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value ?? 0);
  const comoUtc = Date.UTC(
    v('year'),
    v('month') - 1,
    v('day'),
    v('hour'),
    v('minute'),
    v('second')
  );
  return Math.round((comoUtc - Math.floor(instante / 1000) * 1000) / 60_000);
}

/** Día de calendario (YYYY-MM-DD) de un instante en la zona dada. */
export function diaEnZona(instante: string | number | Date, tz: string): string {
  const d = instante instanceof Date ? instante : new Date(instante);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Instante UTC (ms) de la medianoche local de `fecha` en la zona. */
function medianoche(fecha: string, tz: string): number {
  const [y, m, d] = fecha.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  // Dos pasadas: la segunda corrige el día en que cambia el horario de verano.
  let t = utc - desfaseMin(tz, utc) * 60_000;
  t = utc - desfaseMin(tz, t) * 60_000;
  return t;
}

/**
 * Ventana [inicio, fin] en epoch ms de un día local, como la que pide la API
 * de Hotmart. Equivale a `ventanaDiaColombia` con `tz = 'America/Bogota'`.
 */
export function ventanaDiaEnZona(fecha: string, tz: string): { inicio: number; fin: number } {
  const [y, m, d] = fecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { inicio: medianoche(fecha, tz), fin: medianoche(siguiente, tz) - 1 };
}
