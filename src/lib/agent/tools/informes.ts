import 'server-only';

/**
 * Informes BI.
 *
 * Dos cosas que el endpoint HTTP existente no hace y aquí sí:
 *
 *   · El `layout` se VALIDA. `POST /api/report-utm/bi/reports` comprueba
 *     únicamente que venga un nombre, así que un layout mal formado se guarda
 *     sin protestar y falla al dibujarse. Con un modelo generándolos, eso
 *     pasaría a menudo.
 *
 *   · Los widgets se añaden de uno en uno. Pedirle al modelo que regenere un
 *     layout de veinte widgets cada vez que hay que retocar uno es frágil y
 *     caro; añadir y quitar piezas sueltas es más fiable.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ApiError } from '@/lib/error-handler';
import { metricCrossesDimension } from '@/lib/report-utm/bi-metadata';
import type { AnyAgentTool } from '../types';
import { exigirCliente } from '../registry';

/**
 * Tipos de widget admitidos, espejando `BiTypes.ts`.
 *
 * Se declara aquí en zod porque el proyecto solo tenía tipos de TypeScript, que
 * desaparecen al compilar y no validan nada en ejecución.
 */
const TIPOS_WIDGET = [
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

const configWidget = z
  .object({
    metric: z.string().optional(),
    formula: z.string().optional(),
    dimension: z.string().optional(),
    dimension2: z.string().optional(),
    date_grouping: z.string().optional(),
    metrics: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    sort: z.enum(['asc', 'desc']).optional(),
    compare_period: z.boolean().optional(),
    color: z.string().optional(),
    text: z.string().optional(),
    heading_level: z.number().int().min(1).max(4).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    show_totals: z.boolean().optional(),
    variant: z.string().optional(),
  })
  .loose();

const widgetSchema = z.object({
  id: z.string().optional(),
  type: z.enum(TIPOS_WIDGET),
  title: z.string().optional(),
  w: z.number().int().min(1).max(4).optional(),
  h: z.number().int().min(1).max(3).optional(),
  config: configWidget.optional(),
});

type Widget = z.infer<typeof widgetSchema>;

/**
 * Rechaza los widgets que darían cero siempre.
 *
 * `metricCrossesDimension` sabe qué métricas pueden desglosarse por qué
 * dimensiones. Sin esta comprobación se generan tarjetas que se ven bien y
 * muestran un cero permanente — el error que ya tuvieron las plantillas
 * iniciales.
 */
function validarCruce(w: Widget): string | null {
  const metrica = w.config?.metric;
  const dimension = w.config?.dimension;
  if (!metrica || !dimension || dimension === 'none') return null;
  if (!metricCrossesDimension(metrica, dimension)) {
    return `La métrica "${metrica}" no se puede desglosar por "${dimension}": ese widget mostraría 0 siempre.`;
  }
  return null;
}

function nuevoId(): string {
  return randomBytes(8).toString('hex');
}

const clienteIdSchema = z.string().uuid();

const listReports: AnyAgentTool = {
  name: 'list_reports',
  domain: 'informes',
  description:
    'Informes BI existentes y plantillas disponibles. Las plantillas (`is_template`) sirven de ' +
    'punto de partida para crear un informe nuevo sin montarlo desde cero.',
  input: z.object({
    client_id: clienteIdSchema.optional(),
    solo_plantillas: z.boolean().optional(),
  }),
  scopes: ['read:reports'],
  handler: async (input: { client_id?: string; solo_plantillas?: boolean }, ctx) => {
    let q = ctx.db
      .from('bi_reports')
      .select('id, nombre, descripcion, cliente_id, is_template, public_token, updated_at')
      .order('updated_at', { ascending: false })
      .limit(60);

    if (input.client_id) {
      exigirCliente(ctx, input.client_id);
      q = q.eq('cliente_id', input.client_id);
    }
    if (input.solo_plantillas) q = q.eq('is_template', true);

    const { data, error } = await q;
    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer los informes: ${error.message}`,
        500
      );
    }

    const filas = (data ?? []) as { is_template: boolean | null }[];
    return {
      informes: filas.filter((r) => !r.is_template),
      plantillas: filas.filter((r) => r.is_template),
    };
  },
};

const getReport: AnyAgentTool = {
  name: 'get_report',
  domain: 'informes',
  description: 'Un informe con su layout completo, para poder revisarlo o modificarlo.',
  input: z.object({ report_id: z.string().uuid() }),
  scopes: ['read:reports'],
  handler: async (input: { report_id: string }, ctx) => {
    const { data, error } = await ctx.db
      .from('bi_reports')
      .select('*')
      .eq('id', input.report_id)
      .maybeSingle();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el informe: ${error.message}`, 500);
    }
    if (!data) throw new ApiError('NOT_FOUND', `No existe el informe ${input.report_id}.`, 404);
    if (data.cliente_id) exigirCliente(ctx, data.cliente_id as string);

    return { informe: data };
  },
};

const createReport: AnyAgentTool = {
  name: 'create_report',
  domain: 'informes',
  description:
    'Crea un informe BI. Puedes partir de una plantilla (`source_report_id`, de list_reports) o ' +
    'construir el layout widget a widget. Si vas a montarlo desde cero, es más fiable crearlo ' +
    'vacío y luego ir añadiendo widgets con add_report_widget. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    nombre: z.string().min(2),
    client_id: clienteIdSchema.optional(),
    descripcion: z.string().optional(),
    source_report_id: z.string().uuid().optional().describe('Plantilla de la que copiar.'),
    layout: z.array(widgetSchema).optional(),
  }),
  scopes: ['write:reports'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { nombre: string; layout?: unknown[] }) =>
      `Crear el informe "${i.nombre}"${i.layout?.length ? ` con ${i.layout.length} widgets` : ''}`,
  },
  handler: async (
    input: {
      nombre: string;
      client_id?: string;
      descripcion?: string;
      source_report_id?: string;
      layout?: Widget[];
    },
    ctx
  ) => {
    if (input.client_id) exigirCliente(ctx, input.client_id);

    let layout: Widget[] = input.layout ?? [];
    let filters: Record<string, unknown> = {};
    let calculated: unknown[] = [];

    if (input.source_report_id) {
      const { data: origen } = await ctx.db
        .from('bi_reports')
        .select('layout, filters, calculated_fields')
        .eq('id', input.source_report_id)
        .maybeSingle();

      if (!origen) {
        throw new ApiError('NOT_FOUND', `No existe la plantilla ${input.source_report_id}.`, 404);
      }
      layout = (origen.layout ?? []) as Widget[];
      calculated = (origen.calculated_fields ?? []) as unknown[];
      // El cliente y las fechas heredadas se descartan: pertenecen al informe
      // de origen, no al nuevo.
      const heredados = { ...((origen.filters ?? {}) as Record<string, unknown>) };
      delete heredados.cliente_id;
      delete heredados.date_from;
      delete heredados.date_to;
      filters = heredados;
    }

    const problemas = layout.map(validarCruce).filter(Boolean) as string[];
    if (problemas.length > 0) {
      throw new ApiError('VALIDATION_ERROR', problemas.join(' '), 400);
    }

    const conIds = layout.map((w) => ({ ...w, id: w.id ?? nuevoId() }));

    const { data, error } = await ctx.db
      .from('bi_reports')
      .insert({
        nombre: input.nombre,
        descripcion: input.descripcion ?? null,
        cliente_id: input.client_id ?? null,
        layout: conIds,
        filters,
        calculated_fields: calculated,
        is_template: false,
        created_by: ctx.userId,
      })
      .select('id, nombre, cliente_id')
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo crear el informe: ${error.message}`, 500);
    }

    const fila = data as { id: string; nombre: string };
    return {
      informe: fila,
      url: `/report-utm/informes/${fila.id}`,
      widgets: conIds.length,
    };
  },
};

const addReportWidget: AnyAgentTool = {
  name: 'add_report_widget',
  domain: 'informes',
  description:
    'Añade un widget a un informe. Rechaza los que mostrarían 0 siempre porque la métrica no se ' +
    'puede desglosar por la dimensión pedida. Requiere aprobación de una persona.',
  input: z.object({
    report_id: z.string().uuid(),
    widget: widgetSchema,
    posicion: z.number().int().min(0).optional().describe('Por defecto, al final.'),
  }),
  scopes: ['write:reports'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { widget: Widget }) =>
      `Añadir un widget ${i.widget.type}${i.widget.title ? ` ("${i.widget.title}")` : ''}`,
  },
  handler: async (input: { report_id: string; widget: Widget; posicion?: number }, ctx) => {
    const problema = validarCruce(input.widget);
    if (problema) throw new ApiError('VALIDATION_ERROR', problema, 400);

    const { data: informe, error: errLeer } = await ctx.db
      .from('bi_reports')
      .select('id, layout, cliente_id')
      .eq('id', input.report_id)
      .maybeSingle();

    if (errLeer) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el informe: ${errLeer.message}`, 500);
    }
    if (!informe) throw new ApiError('NOT_FOUND', `No existe el informe ${input.report_id}.`, 404);
    if (informe.cliente_id) exigirCliente(ctx, informe.cliente_id as string);

    const layout = [...((informe.layout ?? []) as Widget[])];
    const widget = { ...input.widget, id: input.widget.id ?? nuevoId() };
    const pos = input.posicion ?? layout.length;
    layout.splice(Math.min(pos, layout.length), 0, widget);

    const { error } = await ctx.db
      .from('bi_reports')
      .update({ layout, updated_at: new Date().toISOString() })
      .eq('id', input.report_id);

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo guardar el widget: ${error.message}`, 500);
    }
    return { widget_id: widget.id, total_widgets: layout.length };
  },
};

const removeReportWidget: AnyAgentTool = {
  name: 'remove_report_widget',
  domain: 'informes',
  description: 'Quita un widget de un informe. Requiere aprobación de una persona.',
  input: z.object({ report_id: z.string().uuid(), widget_id: z.string() }),
  scopes: ['write:reports'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { widget_id: string }) => `Quitar el widget ${i.widget_id}`,
  },
  handler: async (input: { report_id: string; widget_id: string }, ctx) => {
    const { data: informe } = await ctx.db
      .from('bi_reports')
      .select('layout, cliente_id')
      .eq('id', input.report_id)
      .maybeSingle();

    if (!informe) throw new ApiError('NOT_FOUND', `No existe el informe ${input.report_id}.`, 404);
    if (informe.cliente_id) exigirCliente(ctx, informe.cliente_id as string);

    const layout = ((informe.layout ?? []) as Widget[]).filter((w) => w.id !== input.widget_id);

    const { error } = await ctx.db
      .from('bi_reports')
      .update({ layout, updated_at: new Date().toISOString() })
      .eq('id', input.report_id);

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo quitar el widget: ${error.message}`, 500);
    }
    return { total_widgets: layout.length };
  },
};

const shareReport: AnyAgentTool = {
  name: 'share_report',
  domain: 'informes',
  description:
    'Genera un enlace público para un informe. Cualquiera con el enlace puede verlo, así que ' +
    'es una acción de riesgo alto. Requiere aprobación de un administrador.',
  input: z.object({ report_id: z.string().uuid() }),
  scopes: ['write:reports'],
  minLevel: 'admin',
  mutation: {
    risk: 'high',
    summarize: (i: { report_id: string }) =>
      `Publicar el informe ${i.report_id} en un enlace accesible sin contraseña`,
  },
  handler: async (input: { report_id: string }, ctx) => {
    const { data: informe } = await ctx.db
      .from('bi_reports')
      .select('id, public_token, cliente_id')
      .eq('id', input.report_id)
      .maybeSingle();

    if (!informe) throw new ApiError('NOT_FOUND', `No existe el informe ${input.report_id}.`, 404);
    if (informe.cliente_id) exigirCliente(ctx, informe.cliente_id as string);

    const token = (informe.public_token as string | null) ?? randomBytes(16).toString('hex');

    if (!informe.public_token) {
      const { error } = await ctx.db
        .from('bi_reports')
        .update({ public_token: token })
        .eq('id', input.report_id);
      if (error) {
        throw new ApiError('DATABASE_ERROR', `No se pudo compartir: ${error.message}`, 500);
      }
    }

    const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
    return {
      url: `${base}/report/bi/${token}`,
      ya_estaba_compartido: Boolean(informe.public_token),
    };
  },
};

export const toolsInformes: AnyAgentTool[] = [
  listReports,
  getReport,
  createReport,
  addReportWidget,
  removeReportWidget,
  shareReport,
];
