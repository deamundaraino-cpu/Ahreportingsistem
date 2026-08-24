// Join genérico de los resultados de las fuentes.
//
// ── Qué sustituye ────────────────────────────────────────────────────────
// `mergeResults` en `bi-query.ts`: 12 parámetros posicionales y, por cada clave
// del resultado, un `Array.prototype.find()` sobre CADA uno de los 5 arrays de
// fuente. En una tabla de 500 filas con 6 fuentes eso son hasta 3.000 barridos
// lineales sobre arrays de la misma longitud — O(claves × filas). Aquí cada
// fuente entrega un Map y el join es O(filas).
//
// ── Semántica: outer join con hueco, no con cero ─────────────────────────
// Si una fuente no tiene fila para una clave, el campo queda `null`, no 0. Es
// la regla que hace que un informe se pueda leer: un 0 significa "medimos y
// salió cero"; un hueco significa "esta fuente no tiene nada aquí". Es también
// lo que documenta Master Metrics en voz alta ("celda en blanco, sin afectar a
// las demás columnas") y lo que ya hace `lib/fx.ts` con las tasas de cambio.
//
// Client-safe: solo tipos.

import type { MeasureField } from './registry-types';
import type { ResolvedRegistry } from './registry';
import type { QueryPlan } from './plan';
import type { RowValues } from './derive';

/** Clave del total cuando no hay dimensión de agrupación. */
export const TOTAL_KEY = '(total)';

export interface SourceStats {
  rowsRead: number;
  /** La fuente devolvió tantas filas como el tope: puede faltar información. */
  truncated: boolean;
  ms: number;
}

export interface SourceResult {
  sourceId: string;
  /** clave de agrupación → id de medida → valor. */
  byKey: Map<string, Record<string, number | null>>;
  /**
   * Claves que no resolvieron contra una entidad real de reporting (el
   * `nocross` actual): UTMs que no cruzaron con ninguna campaña.
   */
  unmatchedKeys?: Set<string>;
  /**
   * Numerador y denominador por separado para los promedios ponderados. Sin
   * esto un promedio se agrega como promedio de promedios: tres días de 30, 32
   * y 28 darían 90 en vez de 30. Es la misma razón por la que
   * `sheet_campo_valores_diarios` guarda `suma` y `n_num` en columnas aparte.
   */
  weighted?: Map<string, Record<string, { sum: number; weight: number }>>;
  stats: SourceStats;
}

export interface JoinedRow {
  /** Valor de la dimensión, o `(total)`. */
  key: string;
  values: RowValues;
  /** La clave no cruzó con una entidad real. */
  unmatched?: boolean;
}

/**
 * Une los resultados por su clave. Outer join: la unión de todas las claves.
 *
 * El orden de salida es el de aparición —primera fuente primero—, que el
 * llamador reordena después. Para la dimensión `date` eso importa: ordenar por
 * VALOR dejaba las gráficas de evolución con los días descolocados (bug
 * corregido en la auditoría de jul 2026), así que la serie temporal se ordena
 * cronológicamente aparte.
 */
export function joinResults(
  reg: ResolvedRegistry,
  plan: QueryPlan,
  results: SourceResult[]
): JoinedRow[] {
  const claves: string[] = [];
  const vistas = new Set<string>();
  const anotar = (k: string) => {
    if (!vistas.has(k)) {
      vistas.add(k);
      claves.push(k);
    }
  };
  for (const r of results) {
    for (const k of r.byKey.keys()) anotar(k);
    // También las de `weighted`: una fuente puede aportar SOLO promedios
    // ponderados (una consulta de únicamente `ga_bounce_rate`), y entonces
    // `byKey` viene vacío. Sin esto la consulta no devolvía ninguna fila.
    for (const k of r.weighted?.keys() ?? []) anotar(k);
  }

  // Todas las medidas físicas del plan: hay que emitirlas incluso cuando la
  // fuente no trajo su clave, para que el hueco quede explícito.
  const fisicas: MeasureField[] = [];
  for (const req of plan.requests) fisicas.push(...req.measures);

  const noCruzadas = new Set<string>();
  for (const r of results) {
    for (const k of r.unmatchedKeys ?? []) noCruzadas.add(k);
  }

  return claves.map((key) => {
    const values: RowValues = {};

    // Arranca con hueco explícito en TODA medida del plan.
    for (const m of fisicas) values[m.id] = null;

    for (const r of results) {
      const fila = r.byKey.get(key);
      if (fila) {
        for (const [id, v] of Object.entries(fila)) {
          values[id] = v;
        }
      }
      // Promedio ponderado: se resuelve aquí, con sus dos acumuladores.
      const w = r.weighted?.get(key);
      if (w) {
        for (const [id, { sum, weight }] of Object.entries(w)) {
          values[id] = weight > 0 ? sum / weight : null;
        }
      }
    }

    // Las fuentes que quedaron fuera del plan se marcan como desconocidas,
    // nunca como cero.
    for (const id of Object.keys(plan.unavailable)) values[id] = null;

    const row: JoinedRow = { key, values };
    if (noCruzadas.has(key)) row.unmatched = true;
    return row;
  });
}

/**
 * Suma la fila de totales de una tabla.
 *
 * Solo suma las medidas aditivas: los ratios se RECALCULAN sobre los totales de
 * sus operandos (de ahí que `applyDerived` se ejecute también sobre esta fila) y
 * `reach` se excluye porque cuenta personas únicas.
 *
 * Un `null` no cuenta como 0 para decidir si hay total: si ninguna fila tenía
 * valor, el total también es hueco.
 */
export function totalsRow(
  reg: ResolvedRegistry,
  rows: JoinedRow[],
  measureIds: string[]
): RowValues {
  const out: RowValues = {};
  for (const id of measureIds) {
    const m = reg.measure(id);
    if (!m) continue;
    // Aditiva = suma de sumas. Lo demás lo recalcula `applyDerived`.
    const aditiva = !m.dedup && !m.formula && (m.agg === 'sum' || m.agg === 'count');
    if (!aditiva) {
      out[id] = null;
      continue;
    }
    let acc = 0;
    let hubo = false;
    for (const r of rows) {
      const v = r.values[id];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        acc += v;
        hubo = true;
      }
    }
    out[id] = hubo ? acc : null;
  }
  return out;
}
