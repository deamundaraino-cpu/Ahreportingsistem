/**
 * Fecha de calendario en hora Colombia, sin dependencias.
 *
 * Vive aparte de `date-utils.ts` a propósito: el worker self-hosted
 * (`sync-worker/`) compila `src/lib/sync/queue.ts` con su propio tsconfig y no
 * tiene `date-fns` instalado. Estos helpers son aritmética de strings, así que
 * los pueden compartir la app y el worker sin arrastrar la librería.
 *
 * Colombia = America/Bogota = UTC-5 fijo (no usa horario de verano), así que el
 * desfase nunca cambia y basta con desplazar el instante y leer sus componentes
 * UTC.
 */

export const COLOMBIA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ════════════════════════════════════════════════════════════════════════
// Zona del cliente (activada el 2026-09-28)
// ════════════════════════════════════════════════════════════════════════
//
// Los helpers de abajo se llaman «colombia*» porque durante meses todo el
// sistema agrupó en día de Colombia. Pero el gasto de Meta llega en el día de la
// CUENTA, y cinco de los seis clientes tienen la cuenta en Chile (UTC-3/-4): las
// ventas y los leads entre las 22:00 y las 24:00 de Chile caían en el día
// siguiente respecto a su gasto.
//
// Ahora, dentro de la consulta de un cliente, estos helpers usan SU zona. Quién
// la aporta: `zona-activa.ts` (servidor), que la guarda en un contexto de la
// petición y se registra aquí. Fuera de ese contexto —el worker, el navegador, el
// planificador— no hay proveedor y todo sigue en Colombia, como siempre.
//
// Sin imports a propósito: este archivo lo compila también el `sync-worker`
// con su propio tsconfig, y `Intl` es del propio runtime.

const ZONA_COLOMBIA = 'America/Bogota';
let proveedorZona: (() => string | null) | null = null;
let zonaDeConfig: ((config: unknown) => string | null) | null = null;

/** Lo llama `zona-activa.ts` al cargarse. No lo uses desde otro sitio. */
export function registrarProveedorZona(
  fn: () => string | null,
  deConfig?: (config: unknown) => string | null
): void {
  proveedorZona = fn;
  if (deConfig) zonaDeConfig = deConfig;
}

/** La zona de la consulta en curso, o null si es Colombia (el camino rápido). */
function zonaVigente(): string | null {
  const z = proveedorZona?.() ?? null;
  return z && z !== ZONA_COLOMBIA ? z : null;
}

/** Día de calendario (yyyy-MM-dd) de un instante en una zona IANA. */
function diaEn(t: number, zona: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

/** Desfase de la zona en ese instante, en minutos (UTC-3 → -180). */
function desfaseEn(zona: string, t: number): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const v = (k: string) => Number(partes.find((p) => p.type === k)?.value ?? 0);
  const comoUtc = Date.UTC(
    v('year'),
    v('month') - 1,
    v('day'),
    v('hour'),
    v('minute'),
    v('second')
  );
  return Math.round((comoUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

/** Instante ISO (UTC) de la medianoche local de `fecha` en la zona. */
function medianocheEn(fecha: string, zona: string): string {
  const utc = Date.parse(`${fecha}T00:00:00Z`);
  // Dos pasadas: la segunda corrige el día en que cambia el horario de verano.
  let t = utc - desfaseEn(zona, utc) * 60_000;
  t = utc - desfaseEn(zona, t) * 60_000;
  return new Date(t).toISOString();
}

/** Fecha de "hoy" en hora Colombia (yyyy-MM-dd). */
export function colombiaToday(now: Date = new Date()): string {
  const zona = zonaVigente();
  if (zona) return diaEn(now.getTime(), zona);
  return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * «Hoy» para mostrar los datos de un cliente (yyyy-MM-dd).
 *
 * Punto ÚNICO por el que pasan los rangos por defecto de las vistas de un
 * cliente (dashboard interno, `/report/[clientId]`, espejo público). Con su
 * `config_api` se usa la zona del cliente (`zona-horaria.ts`, registrada por
 * `zona-activa.ts`); sin ella, la de la consulta en curso o la de Colombia.
 */
export function hoyCliente(config?: unknown, now: Date = new Date()): string {
  // Con la config a mano (páginas del cliente fuera de una consulta), su zona.
  const zona = config !== undefined ? (zonaDeConfig?.(config) ?? null) : null;
  if (zona && zona !== ZONA_COLOMBIA) return diaEn(now.getTime(), zona);
  return colombiaToday(now);
}

/**
 * Rango por defecto de las vistas de un cliente: los últimos `dias` días
 * INCLUSIVE hasta hoy (30 → hoy y los 29 anteriores), igual que el preset
 * «Últimos 30 días» del selector para que el botón lo reconozca.
 */
export function rangoPorDefectoCliente(
  dias = 30,
  config?: unknown,
  now: Date = new Date()
): { from: string; to: string } {
  const hoy = hoyCliente(config, now);
  return { from: addDaysISO(hoy, -(dias - 1)), to: hoy };
}

/** Fecha de "ayer" en hora Colombia (yyyy-MM-dd). */
export function colombiaYesterday(now: Date = new Date()): string {
  const zona = zonaVigente();
  if (zona) return addDaysISO(diaEn(now.getTime(), zona), -1);
  return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Recorta un rango [start, end] contra HOY en hora Colombia.
 *
 * Ningún día futuro existe todavía en Meta/TikTok/Hotmart/GA4: pedirlo solo
 * genera filas vacías o un job condenado a fallar. Mirar un rango que termina en
 * el futuro sí es legítimo (la ventana completa de un lanzamiento, por ejemplo),
 * así que el recorte se aplica al SINCRONIZAR, nunca a lo que se visualiza.
 *
 * Devuelve `null` si el rango entero está en el futuro (no hay nada que pedir).
 * Un rango con fechas mal formadas se devuelve intacto: validarlo es tarea de
 * quien lo consume.
 */
export function clampRangeToToday(
  start: string,
  end: string,
  today: string = colombiaToday()
): { start: string; end: string; clamped: boolean } | null {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return { start, end, clamped: false };
  if (start > today) return null;
  if (end <= today) return { start, end, clamped: false };
  return { start, end: today, clamped: true };
}

// ════════════════════════════════════════════════════════════════════════
// Consultas sobre columnas `timestamptz` (created_at de leads y ventas)
// ════════════════════════════════════════════════════════════════════════
//
// ── El bug que resuelven estos dos helpers ───────────────────────────────
// El módulo tenía dos errores distintos, los dos por la misma causa: tratar un
// instante como si fuera una fecha de calendario.
//
//  1. AGRUPAR — `String(created_at).slice(0, 10)` toma los 10 primeros
//     caracteres del ISO, que es el día **UTC**. El gasto, en cambio, se agrupa
//     por `metricas_diarias.fecha`, un DATE que el worker escribe en día
//     Colombia. Resultado: un lead de las 20:00 en Colombia es 01:00 UTC del día
//     siguiente y se comparaba contra el gasto del día equivocado.
//
//  2. RECORTAR — `.gte('created_at', dateFrom + 'T00:00:00')` manda un literal
//     SIN zona a una columna `timestamptz`. Postgres lo interpreta en la zona
//     del servidor (UTC), así que «desde el 1 de julio» significaba en realidad
//     «desde las 19:00 del 30 de junio, hora Colombia».
//
// Medido en julio 2026: **26,9% de los leads** (9.021 de 33.531) caían en un día
// distinto al correcto, con días desviados hasta ±349 leads, y 266 leads cruzaban
// incluso el borde del mes.
//
// Colombia es UTC-5 FIJO (no hay horario de verano), así que basta con desplazar
// el instante o anclar el literal con `-05:00`. Nada de esto necesita `date-fns`,
// por lo que el worker self-hosted lo puede compartir.

/** Desplazamiento fijo de Colombia en formato ISO. */
export const COLOMBIA_UTC_OFFSET = '-05:00';

/**
 * Día de calendario en hora Colombia de un instante (`timestamptz`).
 *
 * Es el reemplazo de `String(created_at).slice(0, 10)`. Acepta lo que devuelve
 * PostgREST (`2026-07-15T23:30:00+00:00`, `2026-07-15T23:30:00Z`, …) y también un
 * `yyyy-MM-dd` suelto, que se devuelve intacto: una fecha de calendario ya no
 * tiene hora que convertir, y convertirla la retrasaría un día.
 */
export function colombiaDateOf(instant: string | Date | null | undefined): string {
  if (!instant) return '';
  if (typeof instant === 'string') {
    // Ya es una fecha de calendario: no lleva hora, no hay nada que mover.
    if (ISO_DATE.test(instant)) return instant;
    const t = Date.parse(instant);
    if (Number.isNaN(t)) return instant.slice(0, 10);
    const zona = zonaVigente();
    if (zona) return diaEn(t, zona);
    return new Date(t - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
  }
  const zona = zonaVigente();
  if (zona) return diaEn(instant.getTime(), zona);
  return new Date(instant.getTime() - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Fecha y hora en Colombia de un instante, como `yyyy-MM-dd HH:mm`.
 *
 * Es `colombiaDateOf` con la hora pegada. Existe por el CSV de leads: imprimía el
 * ISO crudo, o sea el instante UTC, así que un lead de las 20:00 salía fechado el
 * día siguiente. Quien abre ese CSV lee fechas de Colombia en todas partes menos
 * ahí, y no tiene forma de saberlo.
 *
 * Un `yyyy-MM-dd` suelto se devuelve intacto, igual que en `colombiaDateOf`: no
 * tiene hora que convertir y convertirlo lo retrasaría un día.
 */
export function colombiaDateTimeOf(instant: string | Date | null | undefined): string {
  if (!instant) return '';
  if (typeof instant === 'string' && ISO_DATE.test(instant)) return instant;
  const t = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  if (Number.isNaN(t)) return typeof instant === 'string' ? instant : '';
  const zona = zonaVigente();
  if (zona) {
    return new Date(t + desfaseEn(zona, t) * 60_000).toISOString().slice(0, 16).replace('T', ' ');
  }
  return new Date(t - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Límites de un rango de días de Colombia, listos para comparar contra una
 * columna `timestamptz`.
 *
 * El límite superior es EXCLUSIVO (`< día siguiente a las 00:00`) en vez del
 * `<= 23:59:59` que se usaba: con `23:59:59` se perdía cualquier fila caída en
 * ese último segundo, y con microsegundos eso ocurre de verdad.
 *
 * Se devuelven con el desplazamiento explícito para que Postgres no tenga que
 * suponer la zona.
 *
 *   colombiaRangeBounds('2026-07-01', '2026-07-31')
 *   → { gte: '2026-07-01T00:00:00-05:00', lt: '2026-08-01T00:00:00-05:00' }
 */
export function colombiaRangeBounds(dateFrom: string, dateTo: string): { gte: string; lt: string } {
  const siguiente = addDaysISO(dateTo, 1);
  const zona = zonaVigente();
  if (zona && ISO_DATE.test(dateFrom) && ISO_DATE.test(siguiente)) {
    return { gte: medianocheEn(dateFrom, zona), lt: medianocheEn(siguiente, zona) };
  }
  return {
    gte: `${dateFrom}T00:00:00${COLOMBIA_UTC_OFFSET}`,
    lt: `${siguiente}T00:00:00${COLOMBIA_UTC_OFFSET}`,
  };
}

/** Suma días a un `yyyy-MM-dd`. Aritmética pura, sin zonas de por medio. */
export function addDaysISO(date: string, days: number): string {
  if (!ISO_DATE.test(date)) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
