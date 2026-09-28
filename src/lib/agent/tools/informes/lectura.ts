import 'server-only';

/**
 * Herramientas de informes que solo leen.
 *
 * `list_report_fields` y `preview_widget` son las que evitan que el modelo
 * adivine: la primera le da los ids válidos del cliente (métricas, dimensiones,
 * preguntas y respuestas de formulario, campos de Sheet) y la segunda ejecuta la
 * consulta del widget con el MISMO motor que el canvas, para que vea si sale 0
 * antes de guardarlo.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import { catalogoEstatico } from '@/lib/report-utm/bi/catalogo-estatico';
import { camposDinamicosCliente } from '@/lib/report-utm/bi/campos-cliente';
import { paramsDeWidget } from '@/lib/report-utm/bi/consulta-widget';
import { parseBiQueryParams } from '@/lib/report-utm/bi-query-params';
import { dispatchBiQuery } from '@/lib/report-utm/bi-dispatch';
import { explainSkipReason } from '@/lib/report-utm/bi/diagnostics';
import { metricCrossesDimension } from '@/lib/report-utm/bi-metadata';
import { resolverPeriodo } from '@/lib/date-presets';
import type { BiFilters, BiWidget } from '@/components/report-utm/bi/BiTypes';
import type { AnyAgentTool } from '../../types';
import {
  COLUMNAS_INFORME,
  exigirInformeVisible,
  leerInforme,
  publicosDeRtm,
  rtmDesdePublico,
  rtmVisibles,
  type FilaInforme,
} from './clientes-bi';
import { buscarWidget, layoutDe, todosLosWidgets } from './layout';
import { listarRevisiones } from './revisiones';
import { normalizarWidget, widgetSchema } from './esquema';
import { validarWidget } from './validacion';
import {
  calcDe,
  catalogoParaValidar,
  clientIdSchema,
  fechaSchema,
  filtersDe,
  reportIdSchema,
  urlInforme,
  urlPublica,
  usaCamposDinamicos,
} from './comun';

// ── list_reports ─────────────────────────────────────────────────────────

const listReports: AnyAgentTool = {
  name: 'list_reports',
  domain: 'informes',
  description:
    'Informes BI existentes y plantillas disponibles. Las plantillas (`es_plantilla`) sirven de ' +
    'punto de partida para crear un informe nuevo sin montarlo desde cero (create_report con ' +
    '`source_report_id`). Sin `client_id` lista los de todos los clientes que puedes ver.',
  input: z.object({
    client_id: clientIdSchema.optional(),
    solo_plantillas: z.boolean().optional(),
    buscar: z.string().min(2).max(80).optional().describe('Texto a buscar en el nombre.'),
  }),
  scopes: ['read:reports'],
  handler: async (
    input: { client_id?: string; solo_plantillas?: boolean; buscar?: string },
    ctx
  ) => {
    let q = ctx.db
      .from('bi_reports')
      .select('id, nombre, descripcion, cliente_id, is_template, public_token, updated_at')
      .order('updated_at', { ascending: false })
      .limit(60);

    if (input.client_id) {
      const { rtmId } = await rtmDesdePublico(ctx, input.client_id);
      q = q.eq('cliente_id', rtmId);
    } else {
      // Sin cliente se listaban los informes de TODOS los clientes. Ahora, los
      // de los clientes visibles más las plantillas y los que no tienen cliente.
      const visibles = await rtmVisibles(ctx);
      if (visibles !== null) {
        q =
          visibles.length > 0
            ? q.or(`cliente_id.is.null,cliente_id.in.(${visibles.join(',')})`)
            : q.is('cliente_id', null);
      }
    }
    if (input.solo_plantillas) q = q.eq('is_template', true);
    if (input.buscar) q = q.ilike('nombre', `%${input.buscar.replace(/[%_,()]/g, ' ')}%`);

    const { data, error } = await q;
    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer los informes: ${error.message}`,
        500
      );
    }

    const filas = (data ?? []) as Array<
      Pick<
        FilaInforme,
        | 'id'
        | 'nombre'
        | 'descripcion'
        | 'cliente_id'
        | 'is_template'
        | 'public_token'
        | 'updated_at'
      >
    >;
    const publicos = await publicosDeRtm(
      ctx,
      filas.map((f) => f.cliente_id ?? '')
    );
    const ficha = (f: (typeof filas)[number]) => ({
      id: f.id,
      nombre: f.nombre,
      descripcion: f.descripcion,
      client_id: f.cliente_id ? (publicos.get(f.cliente_id) ?? null) : null,
      es_plantilla: Boolean(f.is_template),
      compartido: Boolean(f.public_token),
      updated_at: f.updated_at,
    });
    return {
      informes: filas.filter((r) => !r.is_template).map(ficha),
      plantillas: filas.filter((r) => r.is_template).map(ficha),
    };
  },
};

// ── get_report ───────────────────────────────────────────────────────────

/** Una línea por widget: lo justo para ubicarse antes de pedir el layout entero. */
function indiceDeWidgets(layout: BiWidget[]) {
  return layout.flatMap((w) => {
    const fila = (x: BiWidget, seccion: string | null) => ({
      id: x.id,
      tipo: x.type,
      titulo: x.title,
      seccion_id: seccion,
      metrica: x.config?.formula ? `= ${x.config.formula}` : (x.config?.metric ?? null),
      dimension: x.config?.dimension ?? null,
    });
    return [fila(w, null), ...(w.children ?? []).map((c) => fila(c, w.id))];
  });
}

const getReport: AnyAgentTool = {
  name: 'get_report',
  domain: 'informes',
  description:
    'Un informe con su layout completo (widgets y secciones), sus filtros y sus campos ' +
    'calculados, para revisarlo o modificarlo. `indice` resume cada widget en una línea con su id, ' +
    'que es lo que piden update_report_widget, remove_report_widget y preview_widget.',
  input: z.object({ report_id: reportIdSchema }),
  scopes: ['read:reports'],
  handler: async (input: { report_id: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'leer');
    const layout = layoutDe(f.layout);
    return {
      informe: {
        id: f.id,
        nombre: f.nombre,
        descripcion: f.descripcion,
        client_id: f.publicId,
        es_plantilla: Boolean(f.is_template),
        updated_at: f.updated_at,
        url: urlInforme(f.id),
        enlace_publico: f.public_token ? urlPublica(f.public_token) : null,
        filtros: filtersDe(f.filters),
        campos_calculados: calcDe(f.calculated_fields),
        layout,
      },
      indice: indiceDeWidgets(layout),
    };
  },
};

// ── list_report_fields ───────────────────────────────────────────────────

const FUENTES = ['todas', 'fijas', 'formulario', 'sheet', 'offline', 'meta'] as const;

function coincide(buscar: string | undefined, ...textos: (string | null | undefined)[]): boolean {
  if (!buscar) return true;
  const b = buscar.toLowerCase();
  return textos.some((t) => (t ?? '').toLowerCase().includes(b));
}

const listReportFields: AnyAgentTool = {
  name: 'list_report_fields',
  domain: 'informes',
  description:
    'Qué métricas y dimensiones puede usar un widget para un cliente, con el id EXACTO que hay ' +
    'que poner en `config.metric` / `config.dimension`: las fijas (gasto, leads, CPL, Hotmart, ' +
    'GA4…) y las propias del cliente (preguntas y respuestas de formulario, segmentos, campos de ' +
    'Sheet, columnas offline, conversiones de Meta), con su alias para fórmulas. Úsala ANTES de ' +
    'crear o editar widgets: un id inventado se rechaza. Con `dimension` marca las métricas que no ' +
    'se pueden desglosar por ella.',
  input: z.object({
    client_id: clientIdSchema,
    fuente: z.enum(FUENTES).optional().describe('Por defecto, todas.'),
    buscar: z.string().min(2).max(80).optional().describe('Filtra por nombre o id.'),
    solo_recomendadas: z
      .boolean()
      .optional()
      .describe('Solo las métricas fijas recomendadas (por defecto sí). false = catálogo entero.'),
    dimension: z
      .string()
      .optional()
      .describe('Dimensión del widget: marca con cruza=false lo que mostraría 0.'),
    incluir_antiguas: z
      .boolean()
      .optional()
      .describe(
        'Conversiones de Meta sin actividad en 90 días o archivadas. Por defecto no se listan.'
      ),
  }),
  scopes: ['read:reports'],
  handler: async (
    input: {
      client_id: string;
      fuente?: (typeof FUENTES)[number];
      buscar?: string;
      solo_recomendadas?: boolean;
      dimension?: string;
      incluir_antiguas?: boolean;
    },
    ctx
  ) => {
    const { rtmId, avisos } = await rtmDesdePublico(ctx, input.client_id);
    const fuente = input.fuente ?? 'todas';
    const out: Record<string, unknown> = {};

    if (fuente === 'todas' || fuente === 'fijas') {
      const soloRec = input.solo_recomendadas !== false;
      const fuentes = catalogoEstatico(true);
      // `cruza` sale de la MISMA regla con la que add_report_widget valida
      // (`metricCrossesDimension`, la del editor): si no, esta lista diría
      // «vale» para algo que luego se rechaza.
      const dim = input.dimension && input.dimension !== 'none' ? input.dimension : null;
      const metricas = fuentes.flatMap((s) =>
        s.fields
          .filter((f) => f.kind === 'measure')
          .filter((f) => !soloRec || f.recommended || input.buscar)
          .filter((f) => coincide(input.buscar, f.id, f.label, f.group))
          .map((f) => ({
            id: f.id,
            nombre: f.label,
            fuente: s.label,
            formato: f.format ?? null,
            ...(dim && !metricCrossesDimension(f.id, dim) ? { cruza: false } : {}),
          }))
      );
      const dimensiones = new Map<string, { id: string; nombre: string }>();
      for (const s of fuentes) {
        for (const f of s.fields) {
          if (f.kind !== 'dimension' || !coincide(input.buscar, f.id, f.label)) continue;
          if (!dimensiones.has(f.id)) dimensiones.set(f.id, { id: f.id, nombre: f.label });
        }
      }
      out.metricas = metricas;
      out.dimensiones = [
        { id: 'none', nombre: 'Total (sin desglose)' },
        { id: 'date', nombre: 'Fecha (con date_grouping day/week/month)' },
        ...[...dimensiones.values()].filter((d) => d.id !== 'none' && d.id !== 'date'),
      ];
      if (soloRec && !input.buscar) {
        out.nota =
          'Solo las métricas recomendadas. Pasa solo_recomendadas=false o `buscar` para ver el catálogo entero.';
      }
    }

    if (fuente !== 'fijas') {
      const publicId = input.client_id;
      const d = await camposDinamicosCliente(ctx.db, rtmId, publicId);
      avisos.push(...d.avisos);
      if (fuente === 'todas' || fuente === 'formulario') {
        out.preguntas = d.preguntas
          .filter(
            (p) =>
              coincide(input.buscar, p.clave, p.nombre) ||
              p.respuestas.some((r) => coincide(input.buscar, r.nombre))
          )
          .map((p) => ({
            ...p,
            respuestas: p.respuestas,
          }));
        out.segmentos = d.segmentos.filter((s) => coincide(input.buscar, s.clave, s.nombre));
      }
      if (fuente === 'todas' || fuente === 'sheet') {
        out.sheet = {
          campos: d.sheet.campos.filter((c) => coincide(input.buscar, c.clave, c.nombre)),
          vistas: d.sheet.vistas.filter((v) => coincide(input.buscar, v.clave, v.nombre)),
        };
      }
      if (fuente === 'todas' || fuente === 'offline') {
        out.offline = d.offline.filter((o) => coincide(input.buscar, o.clave, o.nombre));
      }
      if (fuente === 'todas' || fuente === 'meta') {
        out.conversiones_meta = d.conversiones_meta.filter(
          (m) =>
            (m.activa || input.incluir_antiguas || input.buscar) &&
            coincide(input.buscar, m.clave, m.nombre)
        );
      }
    }

    out.como_usarlos =
      'metric/metrics: el `id` de una métrica o el `token` de una respuesta, segmento o campo. ' +
      'dimension: el `id` de una dimensión o la `dimension` de una pregunta/campo de Sheet. ' +
      'formula: combina `id` de métricas fijas y `alias_formula` (p. ej. "spend / lf__rango__2m_3m").';
    if (avisos.length) out.warnings = avisos;
    return out;
  },
};

// ── preview_widget ───────────────────────────────────────────────────────

const MAX_DIAS_PREVIEW = 180;
const MAX_FILAS_PREVIEW = 25;

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000) + 1;
}

/** Filas del resultado, sea cual sea la forma de la respuesta del motor. */
function filasDe(data: unknown): { filas: unknown[]; forma: string } {
  if (Array.isArray(data)) return { filas: data, forma: 'filas' };
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.current)) {
      return {
        filas: [
          { periodo: 'actual', ...(o.current[0] as object) },
          { periodo: 'anterior', ...((o.previous as unknown[])?.[0] as object) },
        ],
        forma: 'comparacion',
      };
    }
    if (Array.isArray(o.rows)) return { filas: o.rows, forma: 'pivote' };
    if (Array.isArray(o.stages)) return { filas: o.stages, forma: 'embudo' };
    if (Array.isArray(o.valores)) return { filas: o.valores, forma: 'valores' };
  }
  return { filas: [], forma: 'desconocida' };
}

/** ¿Todos los valores numéricos de las métricas pedidas son 0 o vacíos? */
function todoCero(filas: unknown[], metricas: string[]): boolean {
  if (filas.length === 0) return true;
  let vistos = 0;
  for (const f of filas) {
    if (!f || typeof f !== 'object') continue;
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k === 'dimension_value' || k === 'periodo' || k === 'dimension2_value') continue;
      if (metricas.length && !metricas.includes(k) && typeof v !== 'number') continue;
      if (typeof v === 'number') {
        vistos++;
        if (v !== 0) return false;
      }
    }
  }
  return vistos > 0;
}

const previewWidget: AnyAgentTool = {
  name: 'preview_widget',
  domain: 'informes',
  description:
    'Ejecuta la consulta de un widget con el mismo motor que el informe y devuelve las primeras ' +
    'filas, para comprobar que muestra datos ANTES de guardarlo (o para revisar uno existente). ' +
    'Pasa `report_id` + `widget_id` para uno guardado, `report_id` + `widget` para probar un ' +
    'borrador con los filtros y campos calculados de ese informe, o `client_id` + `widget` sin ' +
    'informe. Avisa si todo sale 0 y explica las métricas que no se pueden medir.',
  input: z.object({
    report_id: reportIdSchema.optional(),
    widget_id: z.string().optional().describe('Id de un widget guardado (de get_report).'),
    client_id: clientIdSchema.optional(),
    widget: widgetSchema.optional().describe('Widget a probar sin guardarlo.'),
    date_from: fechaSchema.optional(),
    date_to: fechaSchema.optional(),
  }),
  scopes: ['read:reports'],
  handler: async (
    input: {
      report_id?: string;
      widget_id?: string;
      client_id?: string;
      widget?: z.infer<typeof widgetSchema>;
      date_from?: string;
      date_to?: string;
    },
    ctx
  ) => {
    let widget: BiWidget | null = input.widget ? normalizarWidget(input.widget) : null;
    let filters: BiFilters = {};
    let calc = calcDe([]);
    let rtmId: string | null = null;
    let publicId: string | null = null;
    const avisos: string[] = [];

    if (input.report_id) {
      const f = await leerInforme(ctx, input.report_id, 'leer');
      filters = filtersDe(f.filters);
      calc = calcDe(f.calculated_fields);
      rtmId = f.cliente_id;
      publicId = f.publicId;
      if (!widget) {
        if (!input.widget_id) {
          throw new ApiError('VALIDATION_ERROR', 'Pasa `widget_id` o `widget`.', 400);
        }
        const u = buscarWidget(layoutDe(f.layout), input.widget_id);
        if (!u) {
          throw new ApiError('NOT_FOUND', `No hay ningún widget ${input.widget_id}.`, 404);
        }
        widget = u.widget;
      }
    } else if (!input.client_id || !widget) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Pasa `report_id` (+ `widget_id` o `widget`) o bien `client_id` + `widget`.',
        400
      );
    }

    if (input.client_id) {
      const r = await rtmDesdePublico(ctx, input.client_id);
      rtmId = r.rtmId;
      publicId = input.client_id;
      avisos.push(...r.avisos);
    }
    if (!rtmId) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'El informe no tiene cliente: pasa `client_id` para previsualizar con los datos de uno.',
        400
      );
    }

    // Periodo: el pedido, si no el del informe, si no los últimos 30 días.
    const porDefecto = resolverPeriodo({});
    const desde = input.date_from ?? filters.date_from ?? porDefecto.from;
    const hasta = input.date_to ?? filters.date_to ?? porDefecto.to;
    if (desde > hasta)
      throw new ApiError('VALIDATION_ERROR', 'date_from va después de date_to.', 400);
    if (diasEntre(desde, hasta) > MAX_DIAS_PREVIEW) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `La vista previa admite hasta ${MAX_DIAS_PREVIEW} días; acota date_from/date_to.`,
        400
      );
    }
    filters = { ...filters, cliente_id: rtmId, date_from: desde, date_to: hasta };

    // Primero la validación: si el widget está mal, eso es lo que hay que ver.
    const { cat, avisos: avCat } = usaCamposDinamicos(
      [widget],
      calc.map((c) => c.expression)
    )
      ? await catalogoParaValidar(ctx, rtmId, publicId)
      : { cat: undefined, avisos: [] as string[] };
    avisos.push(...avCat);
    const v = validarWidget(widget, calc, cat);
    avisos.push(...v.avisos);
    if (v.errores.length) {
      return { valido: false, errores: v.errores, ...(avisos.length ? { warnings: avisos } : {}) };
    }

    const periodo = { date_from: desde, date_to: hasta };
    const consultas = (widget.type === 'section' ? (widget.children ?? []) : [widget]).slice(0, 6);
    const resultados = [];
    for (const w of consultas) {
      const c = paramsDeWidget(w, filters, calc);
      if ('sinDatos' in c) {
        resultados.push({ widget_id: w.id, tipo: w.type, sin_datos: c.motivo });
        continue;
      }
      const res = await dispatchBiQuery(parseBiQueryParams(c.params));
      if (res.error) {
        resultados.push({ widget_id: w.id, tipo: w.type, error: res.error });
        continue;
      }
      const { filas, forma } = filasDe(res.data);
      const noDisponibles = Object.entries(res.meta?.unavailable ?? {}).map(([campo, motivo]) => ({
        campo,
        motivo: explainSkipReason(motivo),
      }));
      resultados.push({
        widget_id: w.id,
        tipo: w.type,
        forma,
        total_filas: filas.length,
        filas: filas.slice(0, MAX_FILAS_PREVIEW),
        todo_cero: forma === 'valores' ? filas.length === 0 : todoCero(filas, c.metricas),
        ...(noDisponibles.length ? { no_disponibles: noDisponibles } : {}),
        ...(res.meta?.moneda ? { moneda: res.meta.moneda } : {}),
      });
    }
    if (widget.type === 'section' && (widget.children?.length ?? 0) > consultas.length) {
      avisos.push(`Solo se previsualizan los primeros ${consultas.length} widgets de la sección.`);
    }

    return {
      valido: true,
      periodo,
      resultados,
      ...(avisos.length ? { warnings: [...new Set(avisos)] } : {}),
    };
  },
};

// ── list_report_revisions ────────────────────────────────────────────────

const listReportRevisions: AnyAgentTool = {
  name: 'list_report_revisions',
  domain: 'informes',
  description:
    'Historial de cambios de un informe hechos desde el agente: cada revisión es el estado ' +
    'ANTERIOR a una escritura, con la herramienta que la provocó. Sirve para deshacer con ' +
    'restore_report_revision, también un informe ya borrado.',
  input: z.object({ report_id: reportIdSchema }),
  scopes: ['read:reports'],
  handler: async (input: { report_id: string }, ctx) => {
    const revisiones = await listarRevisiones(ctx, input.report_id);

    // El informe puede haberse borrado: entonces el acceso se decide con el
    // cliente que guardaba la revisión más reciente.
    const { data } = await ctx.db
      .from('bi_reports')
      .select(COLUMNAS_INFORME)
      .eq('id', input.report_id)
      .maybeSingle();
    const existe = Boolean(data);
    if (data) {
      await exigirInformeVisible(ctx, data as FilaInforme, 'leer');
    } else if (revisiones[0]) {
      await exigirInformeVisible(
        ctx,
        {
          id: input.report_id,
          cliente_id: revisiones[0].snapshot.cliente_id,
          is_template: revisiones[0].snapshot.is_template,
          created_by: revisiones[0].created_by,
        },
        'leer'
      );
    } else {
      throw new ApiError('NOT_FOUND', `No existe el informe ${input.report_id}.`, 404);
    }

    return {
      informe_existe: existe,
      revisiones: revisiones.map((r) => ({
        revision_id: r.id,
        fecha: r.created_at,
        antes_de: r.motivo,
        resumen: r.resumen,
        nombre: r.snapshot.nombre,
        widgets: todosLosWidgets(layoutDe(r.snapshot.layout)).length,
      })),
    };
  },
};

export const toolsLecturaInformes: AnyAgentTool[] = [
  listReports,
  getReport,
  listReportFields,
  previewWidget,
  listReportRevisions,
];
