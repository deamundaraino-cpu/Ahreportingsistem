import 'server-only';

/**
 * Esquema de un widget de informe, en zod.
 *
 * Espeja `components/report-utm/bi/BiTypes.ts`, que solo son tipos de
 * TypeScript y no validan nada en ejecución. La versión anterior se desviaba en
 * tres sitios que rompían el canvas: descartaba `children` (una sección creada
 * por el agente llegaba vacía), admitía `heading_level: 4` y `align: 'right'`
 * (que el canvas no pinta) y guardaba widgets sin `config`, con lo que
 * `w.config.collapsed` reventaba al abrir el informe.
 *
 * Las secciones tienen UN nivel de anidación, como en el canvas
 * (`BiReportCanvas` no deja soltar una sección dentro de otra). Se modela así, y
 * no con `z.lazy`, porque un esquema recursivo sale en JSON Schema con `$ref` y
 * algunos proveedores de OpenRouter lo interpretan mal.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { BiWidget } from '@/components/report-utm/bi/BiTypes';

export const TIPOS_WIDGET = [
  'scorecard',
  'line',
  'area',
  'bar',
  'combo',
  'pie',
  'scatter',
  'table',
  'funnel',
  'slicer',
  'section',
  'heading',
  'text',
  'summary',
] as const;

export type TipoWidget = (typeof TIPOS_WIDGET)[number];

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'Color en hexadecimal, p. ej. #2563eb.')
  .describe('Color en hexadecimal (#rrggbb).');

const formatoValor = z.enum(['number', 'currency', 'percent', 'ratio']);

export const configWidget = z
  .object({
    metric: z
      .string()
      .optional()
      .describe(
        'Id de métrica (de list_report_fields). En una tabla, varias separadas por comas; ' +
          'también admite el nombre de un campo calculado del informe.'
      ),
    formula: z
      .string()
      .optional()
      .describe('Fórmula propia del widget (p. ej. "spend / leads_count"). Manda sobre metric.'),
    formula_format: formatoValor.optional(),
    formula_decimals: z.number().int().min(0).max(4).optional(),
    dimension: z
      .string()
      .optional()
      .describe('Dimensión de desglose (utm_campaign, date, leadfield:<clave>…). "none" = total.'),
    dimension2: z.string().optional().describe('Dimensión secundaria (series apiladas).'),
    date_grouping: z.enum(['day', 'week', 'month']).optional(),
    metrics: z.array(z.string()).optional().describe('Etapas de un embudo, en orden.'),
    limit: z.number().int().min(1).max(500).optional(),
    sort: z.enum(['asc', 'desc']).optional(),
    compare_period: z.boolean().optional(),
    color: hex.optional(),
    conditional: z
      .array(
        z.object({
          metric: z.string(),
          op: z.enum(['gt', 'lt']),
          value: z.number(),
          color: z.enum(['green', 'red', 'amber']),
        })
      )
      .optional(),
    value_filters: z
      .array(
        z.object({
          metric: z.string(),
          op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between']),
          value: z.number(),
          value2: z.number().optional(),
        })
      )
      .optional(),
    advanced_filter: z
      .object({
        groups: z.array(
          z.object({
            conditions: z.array(
              z.object({
                field: z.string(),
                op: z.enum(['eq', 'neq', 'contains', 'ncontains', 'starts', 'ends']),
                value: z.string(),
              })
            ),
          })
        ),
      })
      .optional()
      .describe('Filtro del widget: grupos unidos por Y, condiciones de cada grupo por O.'),
    campaign_filter: z
      .object({
        op: z.enum(['eq', 'neq', 'contains', 'ncontains', 'starts', 'ends']),
        value: z.string(),
      })
      .optional(),
    show_totals: z.boolean().optional(),
    variant: z.enum(['default', 'threshold', 'progress']).optional(),
    threshold: z
      .object({
        greenOp: z.enum(['gte', 'lte']),
        green: z.number(),
        yellowOp: z.enum(['gte', 'lte']),
        yellow: z.number(),
      })
      .optional(),
    slicer_mode: z.enum(['dropdown', 'list', 'daterange']).optional(),
    source: z.enum(['leads', 'sales']).optional(),
    target: z.number().optional(),
    text: z.string().max(4000).optional(),
    heading_level: z.number().int().min(1).max(3).optional(),
    align: z.enum(['left', 'center']).optional(),
    collapsed: z.boolean().optional(),
    columns: z.number().int().min(1).max(4).optional(),
    accent: hex.optional(),
  })
  // Una clave desconocida se conserva y se avisa: un layout que sale de
  // get_report tiene que poder volver a entrar tal cual.
  .loose();

/** Claves que el canvas entiende. Lo demás viaja, pero se avisa. */
export const CLAVES_CONFIG: ReadonlySet<string> = new Set(Object.keys(configWidget.shape));

const campos = {
  id: z.string().min(1).max(64).optional().describe('Se genera si no se da.'),
  type: z.enum(TIPOS_WIDGET),
  title: z.string().max(200).optional(),
  w: z.number().int().min(1).max(4).optional().describe('Ancho en columnas (1-4).'),
  h: z.number().int().min(1).max(3).optional().describe('Alto en filas (1-3).'),
  config: configWidget.optional(),
};

/** Un widget sin hijos: lo que puede ir dentro de una sección. */
export const widgetBase = z.object(campos);

/** Un widget de primer nivel. Solo una `section` lleva `children`. */
export const widgetSchema = z
  .object({
    ...campos,
    children: z
      .array(widgetBase)
      .max(24)
      .optional()
      .describe('Solo en una sección: los widgets que contiene (sin secciones dentro).'),
  })
  .superRefine((w, ctx) => {
    if (w.children && w.type !== 'section') {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `Solo una 'section' puede contener widgets; este es '${w.type}'.`,
      });
    }
    if (w.children?.some((c) => c.type === 'section')) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: 'Una sección no puede contener otra sección.',
      });
    }
  });

export type WidgetEntrada = z.infer<typeof widgetSchema>;
export type WidgetBaseEntrada = z.infer<typeof widgetBase>;

export function nuevoId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Deja un widget en la forma exacta que espera el canvas: id, título y config
 * siempre presentes; `children` solo en secciones.
 */
export function normalizarWidget(w: WidgetEntrada | WidgetBaseEntrada): BiWidget {
  const hijos = 'children' in w ? w.children : undefined;
  const base: BiWidget = {
    id: w.id ?? nuevoId(),
    type: w.type,
    title: w.title ?? '',
    ...(w.w !== undefined ? { w: w.w } : {}),
    ...(w.h !== undefined ? { h: w.h } : {}),
    config: { ...(w.config ?? {}) } as BiWidget['config'],
  };
  if (w.type === 'section') base.children = (hijos ?? []).map((c) => normalizarWidget(c));
  return base;
}

/** Avisos por claves de config que el canvas no conoce. No bloquean. */
export function avisosDeClaves(w: BiWidget): string[] {
  const out: string[] = [];
  const revisar = (x: BiWidget) => {
    const raras = Object.keys(x.config ?? {}).filter((k) => !CLAVES_CONFIG.has(k));
    if (raras.length) {
      out.push(
        `El widget ${x.id} (${x.type}) lleva claves que el editor no usa: ${raras.join(', ')}.`
      );
    }
    for (const c of x.children ?? []) revisar(c);
  };
  revisar(w);
  return out;
}
