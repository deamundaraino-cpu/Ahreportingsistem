// ── Filtros de un widget: construcción de params y firma de dependencias ──
//
// Los cinco widgets con datos (scorecard, gráfica, tabla, embudo, resumen)
// repetían literalmente el mismo bloque: cuatro `append*Filters` para montar la
// URL y cinco `*Signature` dentro del array de dependencias del efecto. Eran ~10
// imports idénticos copiados cinco veces, y bastaba olvidar uno en un widget
// nuevo para que dejara de refrescarse al cambiar un filtro del informe.
//
// El efecto en sí NO se centraliza a propósito: cada widget consulta un endpoint
// distinto (compare, pivot, funnel, multi-métrica) y maneja una forma de
// respuesta distinta. Lo común es exactamente esto: qué filtros viajan y cuándo
// hay que volver a pedir.

import type { BiFilters, WidgetConfig } from './BiTypes';
import {
  appendUtmFilters,
  utmFilterSignature,
  appendFieldFilters,
  fieldFilterSignature,
  appendDimFilters,
  dimFilterSignature,
  appendAdvancedFilter,
  advancedFilterSignature,
  widgetAdvancedSignature,
  withCampaignFilter,
} from '@/lib/report-utm/bi-metadata';

/** Filtro avanzado efectivo de un widget: el suyo + su filtro rápido de campaña. */
export function widgetAdvanced(config: WidgetConfig) {
  return withCampaignFilter(config.advanced_filter, config.campaign_filter);
}

/**
 * Añade a la query TODOS los filtros que afectan a un widget: los UTM del
 * informe, los de campo de formulario, los de dimensión y el filtro avanzado
 * (informe + widget, fusionados en Y).
 */
export function appendWidgetFilters(
  params: URLSearchParams,
  filters: BiFilters,
  config: WidgetConfig
): void {
  appendUtmFilters(params, filters);
  appendFieldFilters(params, filters);
  appendDimFilters(params, filters);
  appendAdvancedFilter(params, filters, widgetAdvanced(config));
}

/**
 * Firma estable de todo lo que debe disparar una recarga del widget. Se usa como
 * una sola entrada del array de dependencias del efecto, en lugar de cinco
 * expresiones sueltas que era fácil desemparejar.
 */
export function widgetFilterSignature(filters: BiFilters, config: WidgetConfig): string {
  return [
    filters.cliente_id ?? '',
    filters.date_from ?? '',
    filters.date_to ?? '',
    utmFilterSignature(filters),
    fieldFilterSignature(filters),
    dimFilterSignature(filters),
    advancedFilterSignature(filters),
    widgetAdvancedSignature(widgetAdvanced(config)),
  ].join('¦');
}
