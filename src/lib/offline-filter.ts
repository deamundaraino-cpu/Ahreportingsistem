import type { SheetFilterSpec } from './layout-types';
import {
  columnasPorcentajeDeFila,
  resumenOfflineVacio,
  sumarFilaOffline,
} from './dashboard/merge-metrics';

const OPERADORES_NUMERICOS = new Set(['greater_than', 'less_than', 'greater_equal', 'less_equal']);

/** Operadores desconocidos ya avisados en consola (uno por operador, no por fila). */
const operadoresAvisados = new Set<string>();

/**
 * ¿La fila de `conversiones_offline` pasa el filtro de Sheet de una tarjeta?
 *
 * Dos reglas que antes fallaban hacia «sí» y ahora fallan hacia «no»
 * (auditoría del 2026-09-28):
 *
 *   · Una celda VACÍA no entra en una comparación numérica. `Number('')` es 0,
 *     así que «menor que 5» contaba todas las filas sin el dato como si valieran
 *     cero. Tampoco entra un valor o un umbral que no sea número.
 *   · Un operador desconocido (un layout guardado con uno que ya no existe, o
 *     una errata) EXCLUYE la fila. Antes la dejaba pasar, y la tarjeta mostraba
 *     el total sin filtrar con apariencia de filtrado. Se avisa una vez.
 */
export function offlineRowMatchesFilter(row: any, filter: SheetFilterSpec): boolean {
  if (!filter || !filter.field) return true;

  let colVal: any = '';
  if (filter.field === 'tipo') {
    colVal = row.tipo;
  } else if (filter.field === 'fuente') {
    colVal = row.fuente;
  } else if (filter.field === 'notas') {
    colVal = row.notas;
  } else {
    // Buscar en custom fields
    const customFieldKey = filter.field.startsWith('sheet_')
      ? filter.field.replace('sheet_', '')
      : filter.field;
    colVal = row.custom_fields?.[customFieldKey] ?? '';
  }

  const valStr = String(colVal ?? '')
    .toLowerCase()
    .trim();
  const filterVal = filter.value;
  const operator = filter.operator;

  if (operator === 'equals') {
    return typeof filterVal === 'string' && valStr === filterVal.toLowerCase().trim();
  }
  if (operator === 'not_equals') {
    return typeof filterVal === 'string' && valStr !== filterVal.toLowerCase().trim();
  }
  if (operator === 'includes') {
    return typeof filterVal === 'string' && valStr.includes(filterVal.toLowerCase().trim());
  }
  if (operator === 'excludes') {
    return typeof filterVal === 'string' && !valStr.includes(filterVal.toLowerCase().trim());
  }
  if (operator === 'any_of') {
    return (
      Array.isArray(filterVal) && filterVal.some((v) => valStr === String(v).toLowerCase().trim())
    );
  }
  if (operator === 'none_of') {
    return (
      Array.isArray(filterVal) && !filterVal.some((v) => valStr === String(v).toLowerCase().trim())
    );
  }

  if (OPERADORES_NUMERICOS.has(operator)) {
    // Vacío no es 0: una fila sin el dato no cumple ninguna comparación.
    if (valStr === '') return false;
    const umbralStr = String(filterVal ?? '').trim();
    if (umbralStr === '') return false;
    const n = Number(colVal);
    const fnVal = Number(umbralStr);
    if (!Number.isFinite(n) || !Number.isFinite(fnVal)) return false;
    if (operator === 'greater_than') return n > fnVal;
    if (operator === 'less_than') return n < fnVal;
    if (operator === 'greater_equal') return n >= fnVal;
    return n <= fnVal; // less_equal
  }

  if (!operadoresAvisados.has(String(operator))) {
    operadoresAvisados.add(String(operator));
    console.warn(
      `[offline-filter] operador desconocido «${String(operator)}» en el filtro de Sheet: se excluyen las filas.`
    );
  }
  return false;
}

export function enrichOfflineRow(row: any, filter: SheetFilterSpec | undefined): any {
  if (!filter) return row;
  const offlineRows = Array.isArray(row.offline_rows) ? row.offline_rows : [];
  const matching = offlineRows.filter((r: any) => offlineRowMatchesFilter(r, filter));

  // Mismo agregado que el merge del día (`sumarFilaOffline`): las columnas de
  // porcentaje se promedian ponderadas por cantidad, no se suman.
  const porcentaje = columnasPorcentajeDeFila(row);
  const resumen = resumenOfflineVacio();
  for (const r of matching) sumarFilaOffline(resumen, r, porcentaje);

  const base = { ...row, ...resumen };

  // Resetear campos sheet_ que no tengan coincidencias en la selección filtrada
  Object.keys(row).forEach((k) => {
    if (k.startsWith('sheet_') && resumen[k] === undefined) {
      base[k] = 0;
    }
  });

  return base;
}
