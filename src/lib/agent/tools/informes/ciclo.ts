import 'server-only';

/**
 * Ciclo de vida de un informe: duplicar, guardar como plantilla, publicar,
 * retirar el enlace, borrar, cambiar de cliente y restaurar una revisión.
 *
 * La frontera de la aprobación está aquí:
 *
 *   · DIRECTAS (se aplican al momento): duplicar, guardar como plantilla,
 *     retirar el enlace público (cierra, no abre) y restaurar una revisión.
 *   · CON APROBACIÓN de un admin: publicar un enlace (lo ve cualquiera que lo
 *     tenga), borrar y cambiar el cliente (el informe pasa a mostrar datos de
 *     otra cuenta). Su `precheck` comprueba acceso y existencia al PROPONER, con
 *     los permisos de quien pide: antes el modelo oía «pendiente» para una
 *     acción que luego fallaba al aprobarla.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import { randomBytes } from 'node:crypto';
import type { BiWidget } from '@/components/report-utm/bi/BiTypes';
import type { AgentContext, AnyAgentTool } from '../../types';
import {
  COLUMNAS_INFORME,
  exigirInformeVisible,
  leerInforme,
  rtmDesdePublico,
  type FilaInforme,
} from './clientes-bi';
import { layoutDe, todosLosWidgets } from './layout';
import { escribirConRevision, guardarRevision, leerRevision } from './revisiones';
import {
  aplicado,
  calcDe,
  clientIdSchema,
  filtersDe,
  reportIdSchema,
  urlInforme,
  urlPublica,
} from './comun';

const ESCRITURA = {
  domain: 'informes' as const,
  scopes: ['write:reports' as const],
};

/** Tokens que solo tienen sentido para un cliente concreto. */
const PREFIJOS_DEL_CLIENTE = [
  'leadfield:',
  'leadseg:',
  'leadans:',
  'offfield:',
  'metacc:',
  'ga4ev:',
  'sheetdim:',
  'sheetagg:',
  'sheetview:',
  'field:',
  'fieldagg:',
];
const ALIAS_DEL_CLIENTE =
  /\b(lf__|lseg__|off__|sf__|sv__|ga4ev__|f_(sum|avg|min|max|count)__)[a-z0-9_]+/i;

/** Avisa de los widgets que dependen de campos propios del cliente de origen. */
function avisoCamposDelCliente(layout: BiWidget[], calc: { expression: string }[]): string | null {
  const usan = todosLosWidgets(layout).filter((w) => {
    const c = w.config ?? {};
    const tokens = [
      ...String(c.metric ?? '').split(','),
      ...(c.metrics ?? []).map(String),
      String(c.dimension ?? ''),
      String(c.dimension2 ?? ''),
    ].map((t) => t.trim());
    return (
      tokens.some((t) => PREFIJOS_DEL_CLIENTE.some((p) => t.startsWith(p))) ||
      ALIAS_DEL_CLIENTE.test(c.formula ?? '')
    );
  });
  const calcDelCliente = calc.some((c) => ALIAS_DEL_CLIENTE.test(c.expression));
  if (!usan.length && !calcDelCliente) return null;
  return (
    `${usan.length} widget(s)${calcDelCliente ? ' y algún campo calculado' : ''} usan campos propios ` +
    'del cliente de origen (preguntas de formulario, Sheets…): en otro cliente saldrán vacíos si ' +
    'no tiene los mismos campos.'
  );
}

async function insertarInforme(
  ctx: AgentContext,
  fila: {
    nombre: string;
    descripcion: string | null;
    cliente_id: string | null;
    layout: unknown;
    filters: unknown;
    calculated_fields: unknown;
    is_template: boolean;
  }
): Promise<{ id: string; nombre: string }> {
  const { data, error } = await ctx.db
    .from('bi_reports')
    .insert({ ...fila, created_by: ctx.userId })
    .select('id, nombre')
    .single();
  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo crear el informe: ${error.message}`, 500);
  }
  return data as { id: string; nombre: string };
}

// ── duplicate_report ─────────────────────────────────────────────────────

const duplicateReport: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'operador',
  name: 'duplicate_report',
  description:
    'Copia un informe (o una plantilla) con sus widgets, filtros y campos calculados. Con ' +
    '`client_id` la copia es para otro cliente; sin él, para el mismo. Útil para montar el mismo ' +
    'informe a varios clientes o para editar una plantilla del sistema. Se aplica sin aprobación.',
  input: z.object({
    report_id: reportIdSchema,
    nombre: z.string().min(2).max(120).optional().describe('Por defecto, "<nombre> (copia)".'),
    client_id: clientIdSchema.optional(),
  }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { report_id: string }) => `Duplicar el informe ${i.report_id}`,
  },
  handler: async (input: { report_id: string; nombre?: string; client_id?: string }, ctx) => {
    const origen = await leerInforme(ctx, input.report_id, 'leer');
    const avisos: string[] = [];
    let clienteId = origen.is_template ? null : origen.cliente_id;
    let publicId = origen.is_template ? null : origen.publicId;
    const filters = filtersDe(origen.filters);
    if (input.client_id) {
      const r = await rtmDesdePublico(ctx, input.client_id);
      avisos.push(...r.avisos);
      if (r.rtmId !== origen.cliente_id) {
        const aviso = avisoCamposDelCliente(
          layoutDe(origen.layout),
          calcDe(origen.calculated_fields)
        );
        if (aviso && origen.cliente_id) avisos.push(aviso);
      }
      clienteId = r.rtmId;
      publicId = input.client_id;
    }
    delete filters.cliente_id;
    const nuevo = await insertarInforme(ctx, {
      nombre: input.nombre ?? `${origen.nombre} (copia)`,
      descripcion: origen.descripcion,
      cliente_id: clienteId,
      layout: layoutDe(origen.layout),
      filters,
      calculated_fields: calcDe(origen.calculated_fields),
      is_template: false,
    });
    return aplicado(
      {
        informe: { id: nuevo.id, nombre: nuevo.nombre, client_id: publicId },
        url: urlInforme(nuevo.id),
      },
      { avisos }
    );
  },
};

// ── save_as_template ─────────────────────────────────────────────────────

const saveAsTemplate: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'operador',
  name: 'save_as_template',
  description:
    'Guarda una copia de un informe como plantilla reutilizable (sin cliente ni fechas), para ' +
    'crear después informes iguales con create_report + source_report_id. El informe original no ' +
    'cambia. Avisa si usa campos propios de su cliente. Se aplica sin aprobación.',
  input: z.object({ report_id: reportIdSchema, nombre: z.string().min(2).max(120) }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { nombre: string }) => `Guardar la plantilla "${i.nombre}"`,
  },
  handler: async (input: { report_id: string; nombre: string }, ctx) => {
    const origen = await leerInforme(ctx, input.report_id, 'leer');
    const filters = filtersDe(origen.filters);
    delete filters.cliente_id;
    delete filters.date_from;
    delete filters.date_to;
    const layout = layoutDe(origen.layout);
    const calc = calcDe(origen.calculated_fields);
    const aviso = avisoCamposDelCliente(layout, calc);
    const nuevo = await insertarInforme(ctx, {
      nombre: input.nombre,
      descripcion: origen.descripcion,
      cliente_id: null,
      layout,
      filters,
      calculated_fields: calc,
      is_template: true,
    });
    return aplicado(
      { plantilla: { id: nuevo.id, nombre: nuevo.nombre }, url: urlInforme(nuevo.id) },
      { avisos: aviso ? [aviso] : [] }
    );
  },
};

// ── unshare_report ───────────────────────────────────────────────────────

const unshareReport: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'operador',
  name: 'unshare_report',
  description:
    'Retira el enlace público de un informe: deja de verse sin sesión al momento. Cierra un ' +
    'acceso, no lo abre, así que se aplica sin aprobación. Volver a publicarlo (share_report) ' +
    'genera un enlace nuevo y sí requiere aprobación.',
  input: z.object({ report_id: reportIdSchema }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { report_id: string }) => `Retirar el enlace público del informe ${i.report_id}`,
  },
  handler: async (input: { report_id: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    if (!f.public_token) return aplicado({ informe_id: f.id, ya_no_estaba_compartido: true });
    const { error } = await ctx.db.from('bi_reports').update({ public_token: null }).eq('id', f.id);
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo retirar el enlace: ${error.message}`, 500);
    }
    return aplicado({ informe_id: f.id, enlace_retirado: true });
  },
};

// ── restore_report_revision ──────────────────────────────────────────────

const restoreReportRevision: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'operador',
  name: 'restore_report_revision',
  description:
    'Deshace cambios: devuelve un informe al estado de una revisión (de list_report_revisions o ' +
    'del `revision_id` que devuelve cada edición). Si el informe se borró, lo recrea. Restaurar ' +
    'guarda a su vez una revisión, así que también se puede deshacer. No vuelve a publicar un ' +
    'enlace retirado. Se aplica sin aprobación.',
  input: z.object({ revision_id: z.string().uuid() }),
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { revision_id: string }) => `Restaurar la revisión ${i.revision_id}`,
  },
  handler: async (input: { revision_id: string }, ctx) => {
    const rev = await leerRevision(ctx, input.revision_id);
    const s = rev.snapshot;
    // Hay que poder escribir en el cliente al que se VUELVE.
    await exigirInformeVisible(
      ctx,
      {
        id: rev.report_id,
        cliente_id: s.cliente_id,
        is_template: s.is_template,
        created_by: rev.created_by,
      },
      'escribir'
    );
    const campos = {
      nombre: s.nombre,
      descripcion: s.descripcion,
      cliente_id: s.cliente_id,
      layout: s.layout,
      filters: s.filters,
      calculated_fields: s.calculated_fields,
      is_template: s.is_template,
    };

    const { data: actual } = await ctx.db
      .from('bi_reports')
      .select(COLUMNAS_INFORME)
      .eq('id', rev.report_id)
      .maybeSingle();

    if (actual) {
      // Y en el estado actual (puede haber cambiado de cliente desde entonces).
      await exigirInformeVisible(ctx, actual as FilaInforme, 'escribir');
      const r = await escribirConRevision(ctx, actual as FilaInforme, campos);
      return aplicado(
        { informe_id: rev.report_id, restaurado_a: rev.created_at, url: urlInforme(rev.report_id) },
        { revisionId: r.revisionId, avisos: r.avisos }
      );
    }

    const { error } = await ctx.db
      .from('bi_reports')
      .insert({ id: rev.report_id, ...campos, created_by: rev.created_by ?? ctx.userId });
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo recrear el informe: ${error.message}`, 500);
    }
    return aplicado({
      informe_id: rev.report_id,
      recreado: true,
      restaurado_a: rev.created_at,
      url: urlInforme(rev.report_id),
      nota: 'El enlace público y el historial de envíos del informe borrado no se recuperan.',
    });
  },
};

// ── share_report (aprobación) ────────────────────────────────────────────

const shareReport: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'admin',
  name: 'share_report',
  description:
    'Genera un enlace público para un informe. Cualquiera con el enlace puede verlo, así que ' +
    'es una acción de riesgo alto. Requiere aprobación de un administrador.',
  input: z.object({ report_id: reportIdSchema }),
  mutation: {
    risk: 'high',
    summarize: (i: { report_id: string }) =>
      `Publicar el informe ${i.report_id} en un enlace accesible sin contraseña`,
    precheck: async (i: { report_id: string }, ctx) => {
      await leerInforme(ctx, i.report_id, 'escribir');
    },
  },
  handler: async (input: { report_id: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const token = f.public_token ?? randomBytes(16).toString('hex');
    if (!f.public_token) {
      const { error } = await ctx.db
        .from('bi_reports')
        .update({ public_token: token })
        .eq('id', f.id);
      if (error) {
        throw new ApiError('DATABASE_ERROR', `No se pudo compartir: ${error.message}`, 500);
      }
    }
    return { url: urlPublica(token), ya_estaba_compartido: Boolean(f.public_token) };
  },
};

// ── delete_report (aprobación) ───────────────────────────────────────────

const deleteReport: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'admin',
  name: 'delete_report',
  description:
    'Borra un informe. Guarda antes una revisión, así que se puede recrear con ' +
    'restore_report_revision, pero el enlace público y el historial de envíos se pierden. ' +
    'Requiere aprobación de un administrador. Las plantillas del sistema no se borran.',
  input: z.object({ report_id: reportIdSchema }),
  mutation: {
    risk: 'high',
    summarize: (i: { report_id: string }) => `Borrar el informe ${i.report_id}`,
    precheck: async (i: { report_id: string }, ctx) => {
      await leerInforme(ctx, i.report_id, 'escribir');
    },
  },
  handler: async (input: { report_id: string }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const rev = await guardarRevision(ctx, f);
    if (!rev.revisionId) {
      throw new ApiError(
        'INVALID_CONFIG',
        `No se borra sin poder deshacerlo. ${rev.aviso ?? ''}`.trim(),
        503
      );
    }
    const { error } = await ctx.db.from('bi_reports').delete().eq('id', f.id);
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo borrar el informe: ${error.message}`, 500);
    }
    return aplicado(
      {
        borrado: f.id,
        nombre: f.nombre,
        nota: 'El enlace público y el historial de envíos no se recuperan al restaurar.',
      },
      { revisionId: rev.revisionId }
    );
  },
};

// ── set_report_client (aprobación) ───────────────────────────────────────

const setReportClient: AnyAgentTool = {
  ...ESCRITURA,
  minLevel: 'admin',
  name: 'set_report_client',
  description:
    'Cambia el cliente de un informe (o lo deja sin cliente con null). El informe pasa a mostrar ' +
    'los datos de otra cuenta —también en su enlace público, si lo tiene—, así que es una acción ' +
    'de riesgo alto: requiere aprobación de un administrador.',
  input: z.object({
    report_id: reportIdSchema,
    client_id: clientIdSchema.nullable().describe('Cliente nuevo; null lo deja sin cliente.'),
  }),
  mutation: {
    risk: 'high',
    summarize: (i: { report_id: string; client_id: string | null }) =>
      `Cambiar el cliente del informe ${i.report_id} a ${i.client_id ?? '(ninguno)'}`,
    precheck: async (i: { report_id: string; client_id: string | null }, ctx) => {
      await leerInforme(ctx, i.report_id, 'escribir');
      if (i.client_id) await rtmDesdePublico(ctx, i.client_id);
    },
  },
  handler: async (input: { report_id: string; client_id: string | null }, ctx) => {
    const f = await leerInforme(ctx, input.report_id, 'escribir');
    const avisos: string[] = [];
    let rtmId: string | null = null;
    if (input.client_id) {
      const r = await rtmDesdePublico(ctx, input.client_id);
      rtmId = r.rtmId;
      avisos.push(...r.avisos);
    }
    if (rtmId === f.cliente_id) return aplicado({ informe_id: f.id, sin_cambios: true });
    const aviso = f.cliente_id
      ? avisoCamposDelCliente(layoutDe(f.layout), calcDe(f.calculated_fields))
      : null;
    if (aviso) avisos.push(aviso);
    if (f.public_token) {
      avisos.push(
        'El informe tiene enlace público: desde ahora ese enlace muestra el cliente nuevo.'
      );
    }
    const filters = filtersDe(f.filters);
    delete filters.cliente_id;
    const r = await escribirConRevision(ctx, f, { cliente_id: rtmId, filters });
    return aplicado(
      { informe_id: f.id, client_id: input.client_id },
      { revisionId: r.revisionId, avisos: [...avisos, ...r.avisos] }
    );
  },
};

export const toolsCicloInformes: AnyAgentTool[] = [
  duplicateReport,
  saveAsTemplate,
  unshareReport,
  restoreReportRevision,
  shareReport,
  deleteReport,
  setReportClient,
];
