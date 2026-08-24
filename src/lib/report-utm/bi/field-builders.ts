// Constructores de campos. Existen para que la declaración de cada fuente se
// lea como una tabla y no como 70 objetos literales con las mismas 4 claves.
//
// Vive aparte de `registry.ts` porque los archivos de `sources/` lo importan y
// `registry.ts` importa `sources/`: en el mismo archivo habría ciclo.

import type {
  MeasureField,
  DimensionField,
  Fmt,
  Agg,
  FieldGroup,
  JoinAxis,
  DynamicRef,
} from './registry-types';

/** Opciones de una medida, sin lo que ya aporta el constructor. */
export type MeasureOpts = Partial<Omit<MeasureField, 'kind' | 'id' | 'label' | 'help' | 'group'>>;

/**
 * Medida. `id` se compone con el prefijo de la fuente para que el id canónico
 * nunca se escriba a mano en dos sitios.
 */
export function measure(
  source: string,
  id: string,
  label: string,
  help: string,
  group: FieldGroup,
  opts: MeasureOpts = {}
): MeasureField {
  return {
    kind: 'measure',
    id: `${source}.${id}`,
    label,
    help,
    group,
    format: opts.format ?? 'number',
    // Por defecto una medida se suma: es el caso de casi todos los eventos.
    agg: opts.agg ?? 'sum',
    // Por defecto la columna física se llama igual que el campo. Las que no,
    // lo declaran; las derivadas no tienen columna.
    ...(opts.formula ? {} : { column: opts.column ?? id }),
    ...opts,
  };
}

/**
 * Medida derivada de otras. No tiene columna: se calcula tras el join, una sola
 * vez, y su null lo decide `nullUnless`.
 */
export function derived(
  source: string,
  id: string,
  label: string,
  help: string,
  group: FieldGroup,
  formula: string,
  opts: MeasureOpts = {}
): MeasureField {
  return {
    kind: 'measure',
    id: `${source}.${id}`,
    label,
    help,
    group,
    format: opts.format ?? 'ratio',
    // Una derivada nunca se suma en la fila de totales: se recalcula sobre
    // los totales de sus operandos. `avg` es el marcador de "no aditiva".
    agg: 'avg',
    formula,
    ...opts,
  };
}

export type DimensionOpts = Partial<
  Omit<DimensionField, 'kind' | 'id' | 'label' | 'axis' | 'group'>
>;

export function dimension(
  source: string,
  id: string,
  label: string,
  axis: JoinAxis,
  group: FieldGroup,
  opts: DimensionOpts = {}
): DimensionField {
  return {
    kind: 'dimension',
    id: `${source}.${id}`,
    label,
    axis,
    group,
    column: opts.column ?? id,
    ...opts,
  };
}

/** Atajo para un evento de píxel: conteo aditivo, grupo `campana`. */
export function pixelEvent(
  source: string,
  id: string,
  label: string,
  help: string,
  opts: MeasureOpts = {}
): MeasureField {
  return measure(source, id, label, help, 'campana', { format: 'number', agg: 'sum', ...opts });
}

/** Atajo para un importe. */
export function money(
  source: string,
  id: string,
  label: string,
  help: string,
  group: FieldGroup,
  opts: MeasureOpts = {}
): MeasureField {
  return measure(source, id, label, help, group, { format: 'currency', ...opts });
}

export type { Fmt, Agg, DynamicRef };
