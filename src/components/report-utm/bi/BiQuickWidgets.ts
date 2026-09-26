// Scorecards preconfigurados para añadir de un clic.
//
// Montar un informe empezaba siempre por los mismos 4-5 KPIs, cada uno con el
// mismo recorrido por el editor. Estos presets los insertan ya configurados
// (con comparación vs período anterior activada).
//
// Las variantes Hotmart de ROAS/CPA/ROI están aquí a propósito: para los clientes
// que venden por Hotmart sin webhook de ventas, son las únicas que traen datos.

import type { BiWidget, CalculatedField } from './BiTypes';
import type { BiMetric } from '@/lib/report-utm/bi-metadata';
import { leadAnsAlias, makeLeadAnsMetric, makeLeadFieldDim } from '@/lib/report-utm/bi-metadata';

export interface QuickWidgetPreset {
  /** Etiqueta del menú. */
  label: string;
  metric: BiMetric;
  /** Título del widget insertado. */
  title: string;
}

export const QUICK_WIDGETS: QuickWidgetPreset[] = [
  { label: 'Gasto', metric: 'spend', title: 'Inversión publicitaria' },
  { label: 'Leads', metric: 'leads_count', title: 'Contactos generados' },
  { label: 'CPL', metric: 'cpl', title: 'Costo por contacto' },
  { label: 'ROAS (Hotmart)', metric: 'hotmart_roas', title: 'Retorno (ROAS)' },
  { label: 'CPA (Hotmart)', metric: 'hotmart_cpa', title: 'Costo por venta' },
  { label: 'ROI % (Hotmart)', metric: 'hotmart_roi', title: 'Retorno sobre inversión' },
  { label: 'Facturación', metric: 'hotmart_revenue', title: 'Facturación del período' },
  { label: 'Checkouts', metric: 'initiates_checkout', title: 'Pagos iniciados' },
  { label: 'CTR', metric: 'ctr', title: 'CTR' },
  { label: 'CPM', metric: 'cpm', title: 'CPM' },
];

/** Construye el widget listo para insertar en el layout. */
export function buildQuickWidget(preset: QuickWidgetPreset, id: string): BiWidget {
  return {
    id,
    type: 'scorecard',
    title: preset.title,
    w: 1,
    h: 1,
    config: { metric: preset.metric, compare_period: true },
  };
}

// ── Respuestas de un formulario, de un clic ──────────────────────────
// Para medir las respuestas de un desplegable había que saber que existían los
// segmentos, crearlos en la ficha del cliente, volver al informe y escribir
// `spend / lseg__…` a mano (auditoría del 2026-09-26). Este preset lo monta
// entero a partir de la PREGUNTA:
//
//   1. «Reparto»: una barra por respuesta con sus leads. Agrupa por la
//      pregunta, así que el gasto no aparece (no se reparte por respuesta).
//   2. «Por campaña»: una fila por campaña con inversión, leads, los leads de
//      cada respuesta y su CPL. Aquí las respuestas son MÉTRICAS, que no
//      recortan el ámbito: el gasto es el de la campaña entera y el CPL de una
//      respuesta es inversión ÷ sus leads.

/** Lo mínimo de una pregunta del catálogo que necesita el preset. */
export interface PreguntaParaPreset {
  clave: string;
  nombre: string;
  respuestas: { clave: string; nombre: string }[];
}

export function buildRespuestasPreset(
  pregunta: PreguntaParaPreset,
  genId: () => string,
  calculadosExistentes: CalculatedField[] = []
): { widgets: BiWidget[]; calculados: CalculatedField[] } {
  const nombres = new Set(calculadosExistentes.map((c) => c.name));
  const calculados: CalculatedField[] = [];
  const columnasCpl: string[] = [];
  for (const r of pregunta.respuestas) {
    const name = `CPL ${pregunta.nombre}: ${r.nombre}`;
    columnasCpl.push(name);
    if (nombres.has(name)) continue;
    calculados.push({
      id: genId(),
      name,
      expression: `spend / ${leadAnsAlias(pregunta.clave, r.clave)}`,
      format: 'currency',
    });
  }

  const reparto: BiWidget = {
    id: genId(),
    type: 'bar',
    title: `${pregunta.nombre}: reparto de respuestas`,
    w: 2,
    h: 1,
    config: {
      metric: 'leads_count',
      dimension: makeLeadFieldDim(pregunta.clave),
      limit: 30,
    },
  };

  // Columnas intercaladas: leads de la respuesta y, a su lado, su CPL.
  const columnas = [
    'spend',
    'leads_count',
    ...pregunta.respuestas.flatMap((r, i) => [
      makeLeadAnsMetric(pregunta.clave, r.clave),
      columnasCpl[i],
    ]),
  ];
  const porCampana: BiWidget = {
    id: genId(),
    type: 'table',
    title: `${pregunta.nombre} por campaña`,
    w: 4,
    h: 2,
    config: {
      metric: columnas.join(','),
      dimension: 'utm_campaign',
      limit: 50,
      show_totals: true,
    },
  };

  return { widgets: [reparto, porCampana], calculados };
}
