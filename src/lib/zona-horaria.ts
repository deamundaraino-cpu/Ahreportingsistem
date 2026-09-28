// ════════════════════════════════════════════════════════════════
// Zona horaria por cliente — ACTIVADA el 2026-09-28
// ════════════════════════════════════════════════════════════════
//
// Todo el sistema agrupaba los días en hora Colombia (UTC-5 fijo,
// `colombia-date.ts`). La auditoría de Hotmart (2026-09-25) encontró que para
// Cris tributario eso no coincide con su cuenta de Meta, que está en
// `America/Santiago` (UTC-4 en invierno, UTC-3 en verano): las ventas entre las
// 22:00 y las 24:00 de Chile caían en el día siguiente respecto al gasto. Y no
// era solo Cris: cinco de los seis clientes reportan en CLP.
//
// El gasto no se toca: Meta y TikTok ya lo devuelven en el día de la CUENTA. Lo
// que cambia es cómo se cortan en días los LEADS y las VENTAS, que son instantes:
//   · la zona del cliente sale de aquí (`zonaHorariaDeCliente`): la escrita a
//     mano en la ficha, o la de su cuenta de Meta, o la de TikTok, o Colombia;
//   · `zona-activa.ts` la pone en el contexto de cada consulta de un cliente, y
//     los helpers de `colombia-date.ts` y las RPC por día (migración 095) la usan.
// `hotmart_ventas.fecha_venta` se materializa al escribir: el histórico se
// recalcula con `scripts/recalcular-fecha-venta-hotmart.ts`.

export const ZONA_POR_DEFECTO = 'America/Bogota';

/** Zonas que se ofrecen al dar de alta un cliente. Cualquier otra IANA se escribe en la ficha. */
export const ZONAS_HABITUALES: ReadonlyArray<{ zona: string; etiqueta: string }> = [
  { zona: 'America/Bogota', etiqueta: 'Colombia (Bogotá)' },
  { zona: 'America/Santiago', etiqueta: 'Chile (Santiago)' },
  { zona: 'America/Mexico_City', etiqueta: 'México (CDMX)' },
  { zona: 'America/Lima', etiqueta: 'Perú (Lima)' },
  { zona: 'America/Argentina/Buenos_Aires', etiqueta: 'Argentina (Buenos Aires)' },
  { zona: 'America/Sao_Paulo', etiqueta: 'Brasil (São Paulo)' },
  { zona: 'America/Guayaquil', etiqueta: 'Ecuador (Guayaquil)' },
  { zona: 'America/Caracas', etiqueta: 'Venezuela (Caracas)' },
  { zona: 'America/Panama', etiqueta: 'Panamá' },
  { zona: 'America/New_York', etiqueta: 'EE. UU. (Nueva York)' },
  { zona: 'Europe/Madrid', etiqueta: 'España (Madrid)' },
];

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

/**
 * Zona del cliente, por orden:
 *   1. `config_api.zona_horaria`: la escrita a mano en la ficha (manda);
 *   2. la de su cuenta de Meta (`meta_estado_cuentas[*].zona`, que guarda el
 *      vigilante de cuentas): es la zona en la que Meta corta el GASTO, así que
 *      alinea leads y ventas con él. Con varias cuentas en zonas distintas, la
 *      más frecuente (y la avisa `zonasDeCuentas`);
 *   3. la de su cuenta de TikTok (`tiktok_cuentas_info[*].timezone`);
 *   4. Colombia.
 */
export function zonaHorariaDeCliente(config: unknown): string {
  const c = (config ?? {}) as Record<string, unknown>;
  if (zonaValida(c.zona_horaria)) return c.zona_horaria;
  const [primera] = zonasDeCuentas(c);
  return primera ?? ZONA_POR_DEFECTO;
}

/** Zonas válidas de las cuentas del cliente, de la más a la menos frecuente. */
export function zonasDeCuentas(config: unknown): string[] {
  const c = (config ?? {}) as Record<string, unknown>;
  const cuenta = new Map<string, number>();
  const sumar = (z: unknown) => {
    if (zonaValida(z)) cuenta.set(z, (cuenta.get(z) ?? 0) + 1);
  };
  for (const e of Object.values((c.meta_estado_cuentas ?? {}) as Record<string, unknown>)) {
    sumar((e as { zona?: unknown } | null)?.zona);
  }
  if (cuenta.size === 0) {
    for (const e of Object.values((c.tiktok_cuentas_info ?? {}) as Record<string, unknown>)) {
      sumar((e as { timezone?: unknown } | null)?.timezone);
    }
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([z]) => z);
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
