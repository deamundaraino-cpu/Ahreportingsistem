/**
 * Rangos de fecha con nombre, resueltos en la zona del negocio (Colombia).
 *
 * Existían dos tablas de presets, ambas dentro de componentes de cliente y
 * discrepantes entre sí: la del dashboard usa la hora de Colombia y cuenta bien,
 * mientras que la de los filtros del módulo BI usa la hora del navegador y su
 * preset de "7 días" abarcaba ocho. Ninguna era importable desde el servidor.
 *
 * Este módulo fija la semántica correcta —la del dashboard— en un sitio al que
 * pueden llamar las herramientas del agente, el MCP y los crons. No depende de
 * React ni de `Intl`, así que también sirve al worker.
 *
 * Convención: los rangos son INCLUSIVOS en ambos extremos, y "últimos N días"
 * incluye hoy. `last_7_days` son siete días contando hoy, no ocho.
 */

import { colombiaToday, addDaysISO } from './date-utils';

export type PresetRango =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_14_days'
  | 'last_28_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month';

export type Rango = { from: string; to: string };

export const PRESETS: PresetRango[] = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_28_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
];

/** Etiquetas en español, para que el agente pueda decir de qué periodo habla. */
export const ETIQUETAS: Record<PresetRango, string> = {
  today: 'hoy',
  yesterday: 'ayer',
  last_7_days: 'últimos 7 días',
  last_14_days: 'últimos 14 días',
  last_28_days: 'últimos 28 días',
  last_30_days: 'últimos 30 días',
  last_90_days: 'últimos 90 días',
  this_week: 'esta semana',
  last_week: 'la semana pasada',
  this_month: 'este mes',
  last_month: 'el mes pasado',
};

/** Día de la semana (1 = lunes … 7 = domingo) de una fecha ISO, sin zona local. */
function diaSemanaIso(fecha: string): number {
  const d = new Date(fecha + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

function primerDiaDelMes(fecha: string): string {
  return fecha.slice(0, 8) + '01';
}

function ultimoDiaDelMes(fecha: string): string {
  const [y, m] = fecha.split('-').map(Number);
  // El día 0 del mes siguiente es el último del actual.
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Resuelve un preset a fechas concretas.
 *
 * `hoy` se puede inyectar para poder probarlo; por defecto es hoy en Colombia,
 * nunca la fecha del servidor, que en producción corre en UTC y adelantaría el
 * día cinco horas.
 */
export function resolverPreset(preset: PresetRango, hoy: string = colombiaToday()): Rango {
  switch (preset) {
    case 'today':
      return { from: hoy, to: hoy };

    case 'yesterday': {
      const ayer = addDaysISO(hoy, -1);
      return { from: ayer, to: ayer };
    }

    case 'last_7_days':
      return { from: addDaysISO(hoy, -6), to: hoy };
    case 'last_14_days':
      return { from: addDaysISO(hoy, -13), to: hoy };
    case 'last_28_days':
      return { from: addDaysISO(hoy, -27), to: hoy };
    case 'last_30_days':
      return { from: addDaysISO(hoy, -29), to: hoy };
    case 'last_90_days':
      return { from: addDaysISO(hoy, -89), to: hoy };

    case 'this_week': {
      const lunes = addDaysISO(hoy, -(diaSemanaIso(hoy) - 1));
      return { from: lunes, to: hoy };
    }

    case 'last_week': {
      const lunesEsta = addDaysISO(hoy, -(diaSemanaIso(hoy) - 1));
      const lunesPasada = addDaysISO(lunesEsta, -7);
      return { from: lunesPasada, to: addDaysISO(lunesEsta, -1) };
    }

    case 'this_month':
      return { from: primerDiaDelMes(hoy), to: hoy };

    case 'last_month': {
      const finMesPasado = addDaysISO(primerDiaDelMes(hoy), -1);
      return { from: primerDiaDelMes(finMesPasado), to: ultimoDiaDelMes(finMesPasado) };
    }
  }
}

export function esPreset(v: unknown): v is PresetRango {
  return typeof v === 'string' && (PRESETS as string[]).includes(v);
}

/**
 * Resuelve el periodo de una petición que puede venir como preset o como par de
 * fechas. Si no viene nada, `last_30_days`, que es el comportamiento que ya
 * tenía el MCP.
 */
export function resolverPeriodo(
  opts: { preset?: string; from?: string; to?: string },
  hoy: string = colombiaToday()
): Rango & { etiqueta: string } {
  if (opts.preset && esPreset(opts.preset)) {
    const r = resolverPreset(opts.preset, hoy);
    return { ...r, etiqueta: ETIQUETAS[opts.preset] };
  }
  if (opts.from && opts.to) {
    return { from: opts.from, to: opts.to, etiqueta: `${opts.from} → ${opts.to}` };
  }
  if (opts.from && !opts.to) {
    return { from: opts.from, to: hoy, etiqueta: `${opts.from} → ${hoy}` };
  }
  const r = resolverPreset('last_30_days', hoy);
  return { ...r, etiqueta: ETIQUETAS.last_30_days };
}
