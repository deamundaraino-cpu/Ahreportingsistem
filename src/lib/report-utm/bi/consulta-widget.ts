// La consulta que dispara un widget, construida en el servidor.
//
// Cada widget de `components/report-utm/bi/widgets/*` arma su querystring
// dentro de un `useEffect`. La vista previa del agente (`preview_widget`) tiene
// que pedir EXACTAMENTE lo mismo, o validaría un widget distinto del que luego
// se dibuja. Esto reproduce esas reglas —fórmula bajo `__formula`, pivote solo
// para métricas que lo soportan, columnas de tabla separando campos
// calculados— y devuelve un `URLSearchParams` que pasa por el MISMO
// `parseBiQueryParams` + `dispatchBiQuery` que la ruta `/bi/query`.
//
// Es puro. Si cambia la forma en que un widget consulta, hay que tocar también
// esto; `scripts/verify-agent-informes.ts` fija los casos de cada tipo.

import { appendWidgetFilters } from '@/components/report-utm/bi/widgetQuery';
import {
  WIDGET_FORMULA_KEY,
  type BiFilters,
  type BiWidget,
  type CalculatedField,
  type WidgetConfig,
} from '@/components/report-utm/bi/BiTypes';
import { isFieldMetric, supportsPivot, unifiedTarget } from '@/lib/report-utm/bi-metadata';

export type ConsultaWidget =
  { params: URLSearchParams; metricas: string[] } | { sinDatos: true; motivo: string };

const TIPOS_CON_PIVOTE = new Set(['bar', 'combo', 'area', 'line']);
const TIPOS_GRAFICA = new Set(['line', 'area', 'bar', 'combo', 'pie', 'scatter']);

function contexto(params: URLSearchParams, filters: BiFilters, config: WidgetConfig) {
  if (filters.cliente_id) params.set('cliente_id', filters.cliente_id);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  appendWidgetFilters(params, filters, config);
}

/**
 * Parámetros de la consulta de un widget.
 *
 * `filters` son los del informe, con `cliente_id` = id de `report_utm.clientes`
 * (el mismo que el canvas pone en sus filtros).
 */
export function paramsDeWidget(
  widget: Pick<BiWidget, 'type' | 'config'>,
  filters: BiFilters,
  calculated: CalculatedField[] = []
): ConsultaWidget {
  const config = widget.config ?? {};
  const calcPorNombre = new Map(calculated.map((c) => [c.name, c]));
  const formula = config.formula?.trim();

  switch (widget.type) {
    case 'section':
    case 'heading':
    case 'text':
      return { sinDatos: true, motivo: `Un bloque '${widget.type}' no consulta datos.` };

    case 'summary':
      return {
        sinDatos: true,
        motivo: 'El resumen se compone en el navegador a partir de varias consultas.',
      };

    case 'scorecard': {
      const metric = formula ? WIDGET_FORMULA_KEY : String(config.metric ?? 'leads_count');
      const calcField = calcPorNombre.get(metric);
      const params = new URLSearchParams({ metrics: formula ? '' : metric, dimension: 'none' });
      if (formula) params.set(`calc[${WIDGET_FORMULA_KEY}]`, formula);
      if (config.compare_period) params.set('type', 'compare');
      contexto(params, filters, config);
      if (calcField) params.set(`calc[${calcField.name}]`, calcField.expression);
      return { params, metricas: [metric] };
    }

    case 'table': {
      const colKeys = String(config.metric ?? 'leads_count')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const dimension = String(config.dimension ?? 'utm_source');
      if (unifiedTarget(dimension) !== null && !filters.cliente_id) {
        return {
          sinDatos: true,
          motivo: 'Cruzar con las campañas necesita un cliente en el informe.',
        };
      }
      const usados = colKeys.filter((k) => calcPorNombre.has(k)).map((k) => calcPorNombre.get(k)!);
      const params = new URLSearchParams({
        metrics: colKeys.filter((k) => !calcPorNombre.has(k)).join(','),
        dimension,
        limit: String(config.limit ?? 100),
        sort: config.sort === 'asc' ? 'asc' : 'desc',
      });
      contexto(params, filters, config);
      for (const c of usados) params.set(`calc[${c.name}]`, c.expression);
      return { params, metricas: colKeys };
    }

    case 'funnel': {
      const params = new URLSearchParams({ type: 'funnel' });
      const etapas = Array.isArray(config.metrics) ? config.metrics : [];
      if (etapas.length) params.set('metrics', etapas.join(','));
      contexto(params, filters, config);
      return { params, metricas: etapas.map(String) };
    }

    case 'slicer': {
      if (config.slicer_mode === 'daterange') {
        return { sinDatos: true, motivo: 'Un selector de fechas no consulta datos.' };
      }
      const params = new URLSearchParams({
        type: 'valores',
        dimension: String(config.dimension ?? 'utm_source'),
      });
      if (config.source) params.set('source', config.source);
      contexto(params, filters, config);
      return { params, metricas: [] };
    }

    default: {
      if (!TIPOS_GRAFICA.has(widget.type)) {
        return { sinDatos: true, motivo: `Tipo de widget desconocido: '${widget.type}'.` };
      }
      const metric = formula ? WIDGET_FORMULA_KEY : String(config.metric ?? 'leads_count');
      const dimension = String(config.dimension ?? 'utm_source');
      const dimension2 =
        config.dimension2 && config.dimension2 !== 'none' ? String(config.dimension2) : undefined;
      if (dimension === 'campaign' && !filters.cliente_id) {
        return {
          sinDatos: true,
          motivo: 'El cruce por campaña necesita un cliente en el informe.',
        };
      }
      const calcField = calcPorNombre.get(metric);
      // Misma regla que ChartWidget: el pivote agrupa filas de leads/ventas, así
      // que no aplica a fórmulas, campos calculados ni métricas de campo.
      const usePivot =
        !formula &&
        !calcField &&
        !isFieldMetric(metric) &&
        supportsPivot(metric) &&
        !!dimension2 &&
        TIPOS_CON_PIVOTE.has(widget.type);
      const params = new URLSearchParams({
        metrics: formula ? '' : metric,
        dimension,
        date_grouping: config.date_grouping ?? 'day',
        limit: String(config.limit ?? 15),
        sort: config.sort ?? 'desc',
      });
      if (formula) params.set(`calc[${WIDGET_FORMULA_KEY}]`, formula);
      if (usePivot && dimension2) {
        params.set('type', 'pivot');
        params.set('dimension2', dimension2);
      }
      contexto(params, filters, config);
      if (calcField) params.set(`calc[${calcField.name}]`, calcField.expression);
      return { params, metricas: [metric] };
    }
  }
}
