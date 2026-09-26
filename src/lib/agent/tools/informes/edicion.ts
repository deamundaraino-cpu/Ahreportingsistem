import 'server-only';

/**
 * Herramientas que crean y editan informes.
 *
 * Son escrituras DIRECTAS (`approval: 'directa'`): se aplican al momento, se
 * auditan y cada una guarda antes el estado anterior del informe para poder
 * deshacerla con `restore_report_revision`. Con aprobación por paso no se podía
 * terminar un informe: `create_report` devolvía «pendiente» sin id al que
 * añadir widgets, y las propuestas solo se aprobaban por WhatsApp.
 *
 * Lo que sale del informe hacia fuera —publicar el enlace, borrarlo, cambiarle
 * el cliente— sigue pasando por aprobación (ver `ciclo.ts`).
 *
 * Cada widget se valida contra el catálogo antes de guardarse: tipo y tamaño,
 * que las métricas y dimensiones existan (también las propias del cliente),
 * que la fórmula se entienda y que la métrica se pueda desglosar por la
 * dimensión. Un widget que mostraría 0 siempre no se guarda.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import {
  ADVANCED_FILTER_KEY,
  METRIC_META,
  isDimensionFilterKey,
  parseAdvancedFilter,
  serializeAdvancedFilter,
} from '@/lib/report-utm/bi-metadata';
import type { BiWidget, CalculatedField } from '@/components/report-utm/bi/BiTypes';
import type { AgentContext, AnyAgentTool } from '../../types';
import { leerInforme, rtmDesdePublico } from './clientes-bi';
import {
  avisosDeClaves,
  configWidget,
  normalizarWidget,
  nuevoId,
  widgetBase,
  widgetSchema,
  type WidgetEntrada,
} from './esquema';
import {
  buscarWidget,
  idsEnUso,
  insertarWidget,
  layoutDe,
  moverWidget,
  quitarWidget,
  reemplazarWidget,
  todosLosWidgets,
} from './layout';
import { escribirConRevision } from './revisiones';
import { validarCampoCalculado, validarWidget } from './validacion';
import {
  aplicado,
  calcDe,
  catalogoParaValidar,
  clientIdSchema,
  exigirValido,
  fechaSchema,
  filtersDe,
  reportIdSchema,
  urlInforme,
  usaCamposDinamicos,
} from './comun';

const ESCRITURA = {
  domain: 'informes' as const,
  scopes: ['write:reports' as const],
  minLevel: 'operador' as const,
};

const periodoSchema = z
  .object({ date_from: fechaSchema, date_to: fechaSchema })
  .describe('Periodo por defecto del informe (quien lo abre puede cambiarlo).');

/**
 * Valida widgets en el contexto de un informe: sus campos calculados y, si
 * usan campos propios del cliente, su catálogo. Lanza con todos los errores
 * juntos; devuelve los avisos.
 */
async function validarEnInforme(
  ctx: AgentContext,
  destino: { rtmId: string | null; publicId: string | null },
  widgets: BiWidget[],
  calc: CalculatedField[]
): Promise<string[]> {
  const avisos: string[] = [];
  const { cat, avisos: avCat } = usaCamposDinamicos(
    widgets,
    calc.map((c) => c.expression)
  )
    ? await catalogoParaValidar(ctx, destino.rtmId, destino.publicId)
    : { cat: undefined, avisos: [] as string[] };
  avisos.push(...avCat);
  const errores: string[] = [];
  for (const w of widgets) {
    const v = validarWidget(w, calc, cat);
    errores.push(...v.errores);
    avisos.push(...v.avisos, ...avisosDeClaves(w));
  }
  exigirValido({ errores, avisos });
  return avisos;
}

/** Ids nuevos para los widgets que no traen uno o lo traen repetido. */
function conIdsUnicos(widgets: BiWidget[], ocupados = new Set<string>()): BiWidget[] {
  const fijar = (w: BiWidget): BiWidget => {
    const id = !w.id || ocupados.has(w.id) ? nuevoId() : w.id;
    ocupados.add(id);
    return { ...w, id, ...(w.children ? { children: w.children.map(fijar) } : {}) };
  };
  return widgets.map(fijar);
}

// ── create_report ────────────────────────────────────────────────────────

const createReport: AnyAgentTool = {
  ...ESCRITURA,
  name: 'create_report',
  description:
    'Crea un informe BI y devuelve su id al momento. Puedes partir de una plantilla ' +
    '(`source_report_id`, de list_reports) o pasar el `layout` completo; lo más fiable es crearlo ' +
    'vacío (o desde plantilla) y añadir widgets con add_report_widget comprobándolos con ' +
    'preview_widget. `client_id` es el de list_clients. Se aplica sin aprobación.',
  input: z.object({
    nombre: z.string().min(2).max(120),
    client_id: clientIdSchema.optional(),
    descripcion: z.string().max(500).optional(),
    source_report_id: reportIdSchema.optional().describe('Plantilla o informe del que partir.'),
    layout: z.array(widgetSchema).max(60).optional(),
    periodo: periodoSchema.optional(),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { nombre: string; layout?: unknown[] }) =>
      `Crear el informe "${i.nombre}"${i.layout?.length ? ` con ${i.layout.length} widgets` : ''}`,
  },
  handler: async (
    input: {
      nombre: string;
      client_id?: string;
      descripcion?: string;
      source_report_id?: string;
      layout?: WidgetEntrada[];
      periodo?: { date_from: string; date_to: string };
    },
    ctx
  ) => {
    if (input.source_report_id && input.layout?.length) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Pasa `source_report_id` o `layout`, no los dos: el layout de la plantilla se copia entero.',
        400
      );
    }
    const avisos: string[] = [];
    let rtmId: string | null = null;
    if (input.client_id) {
      const r = await rtmDesdePublico(ctx, input.client_id);
      rtmId = r.rtmId;
      avisos.push(...r.avisos);
    }

    let layout: BiWidget[] = (input.layout ?? []).map(normalizarWidget);
    let filters: Record<string, string | undefined> = {};
    let calc: CalculatedField[] = [];

    if (input.source_report_id) {
      const origen = await leerInforme(ctx, input.source_report_id, 'leer');
      layout = layoutDe(origen.layout);
      calc = calcDe(origen.calculated_fields);
      // El cliente y las fechas heredadas pertenecen al informe de origen.
      const heredados = filtersDe(origen.filters);
      delete heredados.cliente_id;
      delete heredados.date_from;
      delete heredados.date_to;
      filters = heredados;
      // Lo que traiga mal la plantilla se avisa, pero no impide copiarla.
      try {
        avisos.push(
          ...(await validarEnInforme(
            ctx,
            { rtmId, publicId: input.client_id ?? null },
            layout,
            calc
          ))
        );
      } catch (e) {
        avisos.push(`La plantilla tiene widgets con problemas: ${(e as Error).message}`);
      }
    } else if (layout.length) {
      avisos.push(
        ...(await validarEnInforme(ctx, { rtmId, publicId: input.client_id ?? null }, layout, calc))
      );
    }

    if (input.periodo) {
      if (input.periodo.date_from > input.periodo.date_to) {
        throw new ApiError('VALIDATION_ERROR', 'date_from va después de date_to.', 400);
      }
      filters.date_from = input.periodo.date_from;
      filters.date_to = input.periodo.date_to;
    }

    layout = conIdsUnicos(layout);
    const { data, error } = await ctx.db
      .from('bi_reports')
      .insert({
        nombre: input.nombre,
        descripcion: input.descripcion ?? null,
        cliente_id: rtmId,
        layout,
        filters,
        calculated_fields: calc,
        is_template: false,
        created_by: ctx.userId,
      })
      .select('id, nombre')
      .single();
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo crear el informe: ${error.message}`, 500);
    }
    const fila = data as { id: string; nombre: string };
    return aplicado(
      {
        informe: { id: fila.id, nombre: fila.nombre, client_id: input.client_id ?? null },
        url: urlInforme(fila.id),
        widgets: todosLosWidgets(layout).length,
        siguiente_paso:
          'Añade widgets con add_report_widget; compruébalos antes con preview_widget. Para quitar el informe entero, delete_report (requiere aprobación).',
      },
      { avisos }
    );
  },
};

// ── update_report ────────────────────────────────────────────────────────

const updateReport: AnyAgentTool = {
  ...ESCRITURA,
  name: 'update_report',
  description:
    'Cambia el nombre, la descripción, el periodo por defecto o los filtros de un informe. ' +
    '`filtros` se fusiona con los que ya tiene (un valor null quita ese filtro); las claves ' +
    'válidas son dimensiones de filtro (utm_*, ip_country, form_name, leadfield:<clave>…). ' +
    'Para cambiar el cliente usa set_report_client. Se aplica sin aprobación y se puede deshacer.',
  input: z.object({
    report_id: reportIdSchema,
    nombre: z.string().min(2).max(120).optional(),
    descripcion: z.string().max(500).nullable().optional(),
    periodo: periodoSchema.nullable().optional().describe('null quita el periodo guardado.'),
    filtros: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe('Filtros de dimensión {clave: valor}; null quita uno.'),
    filtro_avanzado: configWidget.shape.advanced_filter
      .unwrap()
      .nullable()
      .optional()
      .describe('Filtro Y-de-O de todo el informe; null lo quita.'),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { report_id: string }) => `Editar los datos del informe ${i.report_id}`,
  },
  handler: async (
    input: {
      report_id: string;
      nombre?: string;
      descripcion?: string | null;
      periodo?: { date_from: string; date_to: string } | null;
      filtros?: Record<string, string | null>;
      filtro_avanzado?: { groups: unknown[] } | null;
    },
    ctx
  ) => {
    const { report_id, ...cambiosPedidos } = input;
    if (Object.values(cambiosPedidos).every((v) => v === undefined)) {
      throw new ApiError('VALIDATION_ERROR', 'No hay nada que cambiar.', 400);
    }
    const f = await leerInforme(ctx, report_id, 'escribir');
    const cambios: Record<string, unknown> = {};
    if (input.nombre !== undefined) cambios.nombre = input.nombre;
    if (input.descripcion !== undefined) cambios.descripcion = input.descripcion;

    const filters = filtersDe(f.filters);
    let tocaFiltros = false;
    if (input.periodo !== undefined) {
      tocaFiltros = true;
      if (input.periodo === null) {
        delete filters.date_from;
        delete filters.date_to;
      } else {
        if (input.periodo.date_from > input.periodo.date_to) {
          throw new ApiError('VALIDATION_ERROR', 'date_from va después de date_to.', 400);
        }
        filters.date_from = input.periodo.date_from;
        filters.date_to = input.periodo.date_to;
      }
    }
    if (input.filtros) {
      const malas = Object.keys(input.filtros).filter((k) => !isDimensionFilterKey(k));
      if (malas.length) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `No son claves de filtro: ${malas.join(', ')}. Valen utm_*, ip_country, form_name, ` +
            'form_plugin, attribution_method, platform, field:<clave> y leadfield:<clave>.',
          400
        );
      }
      tocaFiltros = true;
      for (const [k, v] of Object.entries(input.filtros)) {
        if (v === null || v === '') delete filters[k];
        else filters[k] = v;
      }
    }
    if (input.filtro_avanzado !== undefined) {
      tocaFiltros = true;
      if (input.filtro_avanzado === null) delete filters[ADVANCED_FILTER_KEY];
      else {
        const adv = parseAdvancedFilter(input.filtro_avanzado);
        const campos = adv.groups.flatMap((g) => g.conditions.map((c) => c.field));
        const malos = campos.filter((c) => !isDimensionFilterKey(c));
        if (malos.length) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `El filtro avanzado usa campos que no se pueden filtrar: ${malos.join(', ')}.`,
            400
          );
        }
        filters[ADVANCED_FILTER_KEY] = serializeAdvancedFilter(adv);
      }
    }
    if (tocaFiltros) cambios.filters = filters;

    const r = await escribirConRevision(ctx, f, cambios);
    return aplicado(
      {
        informe_id: f.id,
        cambiado: Object.keys(cambios),
        filtros: tocaFiltros ? filters : undefined,
      },
      { revisionId: r.revisionId, avisos: r.avisos }
    );
  },
};

// ── add_report_widget ────────────────────────────────────────────────────

const addReportWidget: AnyAgentTool = {
  ...ESCRITURA,
  name: 'add_report_widget',
  description:
    'Añade un widget a un informe, al final o en `posicion`, en el primer nivel o dentro de una ' +
    'sección (`seccion_id`). Se valida antes de guardar: rechaza métricas o dimensiones que no ' +
    'existen y los cruces que mostrarían 0 siempre. Usa los ids de list_report_fields y, si ' +
    'dudas, pruébalo antes con preview_widget. Se aplica sin aprobación y se puede deshacer.',
  input: z.object({
    report_id: reportIdSchema,
    widget: widgetSchema,
    seccion_id: z.string().optional().describe('Id de una sección del informe (de get_report).'),
    posicion: z.number().int().min(0).optional().describe('Por defecto, al final.'),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { widget: WidgetEntrada }) =>
      `Añadir un widget ${i.widget.type}${i.widget.title ? ` ("${i.widget.title}")` : ''}`,
  },
  handler: async (
    input: { report_id: string; widget: WidgetEntrada; seccion_id?: string; posicion?: number },
    ctx
  ) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const layout = layoutDe(f.layout);
    const [widget] = conIdsUnicos([normalizarWidget(input.widget)], idsEnUso(layout));
    const avisos = await validarEnInforme(
      ctx,
      { rtmId: f.cliente_id, publicId: f.publicId },
      [widget],
      calcDe(f.calculated_fields)
    );
    const nuevo = insertarWidget(layout, widget, {
      seccionId: input.seccion_id,
      posicion: input.posicion,
    });
    const r = await escribirConRevision(ctx, f, { layout: nuevo });
    return aplicado(
      { widget_id: widget.id, total_widgets: todosLosWidgets(nuevo).length },
      { revisionId: r.revisionId, avisos: [...avisos, ...r.avisos] }
    );
  },
};

// ── update_report_widget ─────────────────────────────────────────────────

const updateReportWidget: AnyAgentTool = {
  ...ESCRITURA,
  name: 'update_report_widget',
  description:
    'Modifica un widget existente sin rehacerlo: cambia título, tipo, tamaño o claves sueltas de ' +
    'su config (`cambios.config`, un valor null borra esa clave), y/o lo mueve (`mover`: a otra ' +
    'posición, dentro de una sección o fuera con seccion_id null). El widget resultante se valida ' +
    'entero. Se aplica sin aprobación y se puede deshacer.',
  input: z.object({
    report_id: reportIdSchema,
    widget_id: z.string().min(1).describe('Id del widget (de get_report).'),
    cambios: z
      .object({
        title: z.string().max(200).optional(),
        type: widgetBase.shape.type.optional(),
        w: widgetBase.shape.w,
        h: widgetBase.shape.h,
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Claves de config a cambiar; null borra la clave.'),
      })
      .optional(),
    mover: z
      .object({
        seccion_id: z.string().nullable().describe('Sección destino; null = primer nivel.'),
        posicion: z.number().int().min(0).optional(),
      })
      .optional(),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { widget_id: string }) => `Modificar el widget ${i.widget_id}`,
  },
  handler: async (
    input: {
      report_id: string;
      widget_id: string;
      cambios?: {
        title?: string;
        type?: BiWidget['type'];
        w?: number;
        h?: number;
        config?: Record<string, unknown>;
      };
      mover?: { seccion_id: string | null; posicion?: number };
    },
    ctx
  ) => {
    if (!input.cambios && !input.mover) {
      throw new ApiError('VALIDATION_ERROR', 'Pasa `cambios`, `mover` o los dos.', 400);
    }
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    let layout = layoutDe(f.layout);
    const u = buscarWidget(layout, input.widget_id);
    if (!u) throw new ApiError('NOT_FOUND', `No hay ningún widget ${input.widget_id}.`, 404);

    const avisos: string[] = [];
    if (input.cambios) {
      const actual = u.widget;
      const config: Record<string, unknown> = { ...(actual.config ?? {}) };
      for (const [k, v] of Object.entries(input.cambios.config ?? {})) {
        if (v === null) delete config[k];
        else config[k] = v;
      }
      const candidato = {
        id: actual.id,
        type: input.cambios.type ?? actual.type,
        title: input.cambios.title ?? actual.title,
        w: input.cambios.w ?? actual.w,
        h: input.cambios.h ?? actual.h,
        config,
        ...(actual.children ? { children: actual.children } : {}),
      };
      if (actual.type === 'section' && candidato.type !== 'section' && actual.children?.length) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Esa sección tiene widgets dentro: sácalos o quítalos antes de cambiarle el tipo.',
          400
        );
      }
      const parsed = widgetSchema.safeParse(candidato);
      if (!parsed.success) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `El widget resultante no es válido: ${z.prettifyError(parsed.error)}`,
          400
        );
      }
      const nuevo = normalizarWidget(parsed.data);
      // Los hijos de una sección no cambian aquí: se conservan tal cual.
      if (nuevo.type === 'section') nuevo.children = actual.children ?? [];
      avisos.push(
        ...(await validarEnInforme(
          ctx,
          { rtmId: f.cliente_id, publicId: f.publicId },
          [{ ...nuevo, children: [] }],
          calcDe(f.calculated_fields)
        ))
      );
      layout = reemplazarWidget(layout, actual.id, nuevo);
    }
    if (input.mover) {
      layout = moverWidget(layout, input.widget_id, {
        seccionId: input.mover.seccion_id,
        posicion: input.mover.posicion,
      });
    }

    const r = await escribirConRevision(ctx, f, { layout });
    return aplicado(
      { widget_id: input.widget_id, widget: buscarWidget(layout, input.widget_id)?.widget },
      { revisionId: r.revisionId, avisos: [...avisos, ...r.avisos] }
    );
  },
};

// ── remove_report_widget ─────────────────────────────────────────────────

const removeReportWidget: AnyAgentTool = {
  ...ESCRITURA,
  name: 'remove_report_widget',
  description:
    'Quita un widget de un informe, esté en el primer nivel o dentro de una sección. Quitar una ' +
    'sección quita también lo que contiene. Da error si el widget no existe. Se aplica sin ' +
    'aprobación y se puede deshacer.',
  input: z.object({ report_id: reportIdSchema, widget_id: z.string().min(1) }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { widget_id: string }) => `Quitar el widget ${i.widget_id}`,
  },
  handler: async (input: { report_id: string; widget_id: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const layout = layoutDe(f.layout);
    const u = buscarWidget(layout, input.widget_id);
    const nuevo = quitarWidget(layout, input.widget_id);
    const r = await escribirConRevision(ctx, f, { layout: nuevo });
    return aplicado(
      {
        quitado: input.widget_id,
        ...(u?.widget.type === 'section'
          ? { con_su_contenido: (u.widget.children ?? []).length }
          : {}),
        total_widgets: todosLosWidgets(nuevo).length,
      },
      { revisionId: r.revisionId, avisos: r.avisos }
    );
  },
};

// ── Campos calculados ────────────────────────────────────────────────────

/** Tokens de columna de un widget que nombran exactamente `nombre`. */
function usaCampo(w: BiWidget, nombre: string): boolean {
  const cfg = w.config ?? {};
  return String(cfg.metric ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(nombre);
}

/** Renombra un campo calculado en las columnas de los widgets que lo usan. */
function renombrarEnLayout(layout: BiWidget[], de: string, a: string): BiWidget[] {
  const cambiar = (w: BiWidget): BiWidget => {
    const cfg = w.config ?? {};
    const tocado = usaCampo(w, de)
      ? {
          ...w,
          config: {
            ...cfg,
            metric: String(cfg.metric)
              .split(',')
              .map((s) => (s.trim() === de ? a : s.trim()))
              .join(','),
          },
        }
      : w;
    return tocado.children ? { ...tocado, children: tocado.children.map(cambiar) } : tocado;
  };
  return layout.map(cambiar);
}

const upsertCalculatedField: AnyAgentTool = {
  ...ESCRITURA,
  name: 'upsert_calculated_field',
  description:
    'Crea o actualiza un campo calculado del informe (una fórmula reutilizable en varios widgets, ' +
    'p. ej. "CPL calificado" = "spend / lseg__calificados"). Se usa poniendo su `nombre` como ' +
    'métrica de un widget o columna de una tabla. Con `nombre_anterior` lo renombra y actualiza ' +
    'los widgets que lo usan. La fórmula se valida. Se aplica sin aprobación y se puede deshacer.',
  input: z.object({
    report_id: reportIdSchema,
    nombre: z.string().min(1).max(80),
    expresion: z.string().min(1).max(500).describe('Fórmula con ids de métricas y alias.'),
    formato: z.enum(['number', 'currency', 'percent', 'ratio']).optional(),
    decimales: z.number().int().min(0).max(4).optional(),
    nombre_anterior: z.string().optional().describe('Para renombrar un campo existente.'),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { nombre: string; expresion: string }) =>
      `Guardar el campo calculado "${i.nombre}" = ${i.expresion}`,
  },
  handler: async (
    input: {
      report_id: string;
      nombre: string;
      expresion: string;
      formato?: CalculatedField['format'];
      decimales?: number;
      nombre_anterior?: string;
    },
    ctx
  ) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const calc = calcDe(f.calculated_fields);
    const nombre = input.nombre.trim();
    if (nombre in METRIC_META) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `"${nombre}" ya es una métrica del catálogo: elige otro nombre.`,
        400
      );
    }
    const avisos: string[] = [];
    const { cat, avisos: avCat } = usaCamposDinamicos([], [input.expresion])
      ? await catalogoParaValidar(ctx, f.cliente_id, f.publicId)
      : { cat: undefined, avisos: [] as string[] };
    avisos.push(...avCat);
    const v = validarCampoCalculado({ name: nombre, expression: input.expresion }, cat);
    exigirValido(v);
    avisos.push(...v.avisos);

    const previo = input.nombre_anterior?.trim();
    if (previo && !calc.some((c) => c.name === previo)) {
      throw new ApiError('NOT_FOUND', `No hay ningún campo calculado "${previo}".`, 404);
    }
    if (previo && previo !== nombre && calc.some((c) => c.name === nombre)) {
      throw new ApiError('VALIDATION_ERROR', `Ya existe un campo calculado "${nombre}".`, 400);
    }
    const buscado = previo ?? nombre;
    const existente = calc.find((c) => c.name === buscado);
    const campo: CalculatedField = {
      id: existente?.id ?? nuevoId(),
      name: nombre,
      expression: input.expresion.trim(),
    };
    const formato = input.formato ?? existente?.format;
    const decimales = input.decimales ?? existente?.decimals;
    if (formato) campo.format = formato;
    if (decimales !== undefined) campo.decimals = decimales;
    const nuevos = existente ? calc.map((c) => (c.name === buscado ? campo : c)) : [...calc, campo];

    const cambios: Record<string, unknown> = { calculated_fields: nuevos };
    let renombrados = 0;
    if (previo && previo !== nombre) {
      const layout = layoutDe(f.layout);
      renombrados = todosLosWidgets(layout).filter((w) => usaCampo(w, previo)).length;
      cambios.layout = renombrarEnLayout(layout, previo, nombre);
    }
    const r = await escribirConRevision(ctx, f, cambios);
    return aplicado(
      {
        campo,
        accion: existente ? 'actualizado' : 'creado',
        ...(renombrados ? { widgets_actualizados: renombrados } : {}),
        como_usarlo: `Pon "${nombre}" en config.metric de un scorecard o gráfica, o como columna de una tabla.`,
      },
      { revisionId: r.revisionId, avisos: [...avisos, ...r.avisos] }
    );
  },
};

const removeCalculatedField: AnyAgentTool = {
  ...ESCRITURA,
  name: 'remove_calculated_field',
  description:
    'Borra un campo calculado del informe. Se niega si algún widget lo usa y dice cuáles, para ' +
    'que no queden columnas vacías. Se aplica sin aprobación y se puede deshacer.',
  input: z.object({ report_id: reportIdSchema, nombre: z.string().min(1) }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { nombre: string }) => `Borrar el campo calculado "${i.nombre}"`,
  },
  handler: async (input: { report_id: string; nombre: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const calc = calcDe(f.calculated_fields);
    if (!calc.some((c) => c.name === input.nombre)) {
      throw new ApiError('NOT_FOUND', `No hay ningún campo calculado "${input.nombre}".`, 404);
    }
    const usan = todosLosWidgets(layoutDe(f.layout)).filter((w) => usaCampo(w, input.nombre));
    if (usan.length) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Lo usan ${usan.length} widget(s): ${usan
          .map((w) => `${w.id}${w.title ? ` ("${w.title}")` : ''}`)
          .join(', ')}. Quítalo de ellos primero con update_report_widget.`,
        400
      );
    }
    const r = await escribirConRevision(ctx, f, {
      calculated_fields: calc.filter((c) => c.name !== input.nombre),
    });
    return aplicado({ borrado: input.nombre }, { revisionId: r.revisionId, avisos: r.avisos });
  },
};

export const toolsEdicionInformes: AnyAgentTool[] = [
  createReport,
  updateReport,
  addReportWidget,
  updateReportWidget,
  removeReportWidget,
  upsertCalculatedField,
  removeCalculatedField,
];
