import 'server-only';

/**
 * Revisiones de un informe: la red de seguridad de las escrituras directas.
 *
 * Editar un informe desde el agente se aplica al momento. A cambio, antes de
 * cada escritura se guarda el estado anterior en `bi_report_revisions`
 * (migración 092) y `restore_report_revision` lo devuelve. Restaurar también
 * guarda una revisión, así que deshacer se puede deshacer.
 *
 * Dos garantías más:
 *
 *   · Escritura condicionada (`updated_at` como versión). Si el informe cambió
 *     entre la lectura y la escritura —alguien lo guardó desde el canvas, u otra
 *     conversación lo tocó— la escritura se rechaza con CONFLICT en vez de pisar
 *     el cambio ajeno.
 *
 *   · Si la tabla todavía no existe (migración sin aplicar), las ediciones
 *     siguen funcionando y avisan de que no se podrán deshacer. Borrar, en
 *     cambio, se niega: sin revisión no hay vuelta atrás.
 */

import { ApiError, logger } from '@/lib/error-handler';
import type { AgentContext } from '../../types';
import type { FilaInforme } from './clientes-bi';

/** Máximo de revisiones que se conservan por informe. */
export const MAX_REVISIONES = 30;

/** Lo que se guarda: todo lo que una herramienta puede cambiar, sin el enlace público. */
export type Snapshot = {
  nombre: string;
  descripcion: string | null;
  cliente_id: string | null;
  layout: unknown;
  filters: unknown;
  calculated_fields: unknown;
  is_template: boolean;
};

export type Revision = {
  id: string;
  report_id: string;
  cliente_id: string | null;
  snapshot: Snapshot;
  motivo: string;
  resumen: string | null;
  created_by: string | null;
  created_at: string;
};

const TABLA_AUSENTE = ['PGRST205', '42P01'];

export const AVISO_SIN_HISTORIAL =
  'El historial de revisiones no está disponible (migración 092 sin aplicar): este cambio no se podrá deshacer con restore_report_revision.';

export function snapshotDe(f: FilaInforme): Snapshot {
  return {
    nombre: f.nombre,
    descripcion: f.descripcion ?? null,
    cliente_id: f.cliente_id ?? null,
    layout: f.layout ?? [],
    filters: f.filters ?? {},
    calculated_fields: f.calculated_fields ?? [],
    is_template: Boolean(f.is_template),
  };
}

/**
 * Guarda el estado actual de un informe antes de modificarlo.
 *
 * Nunca lanza: un fallo al guardar la revisión no debe impedir una edición
 * reversible por otros medios. Devuelve el aviso para que llegue al modelo.
 */
export async function guardarRevision(
  ctx: AgentContext,
  fila: FilaInforme
): Promise<{ revisionId: string | null; aviso?: string }> {
  try {
    const { data, error } = await ctx.db
      .from('bi_report_revisions')
      .insert({
        report_id: fila.id,
        cliente_id: fila.cliente_id ?? null,
        snapshot: snapshotDe(fila),
        motivo: ctx.operacion?.tool ?? 'desconocido',
        resumen: ctx.operacion?.resumen ?? null,
        created_by: ctx.userId,
        origin: ctx.origin,
        conversation_id: ctx.conversationId,
        token_id: ctx.tokenId,
      })
      .select('id')
      .single();
    if (error) {
      if (TABLA_AUSENTE.includes(error.code))
        return { revisionId: null, aviso: AVISO_SIN_HISTORIAL };
      logger.warn('No se pudo guardar la revisión del informe', { code: error.code });
      return {
        revisionId: null,
        aviso: `No se pudo guardar la revisión (${error.message}): este cambio no se podrá deshacer.`,
      };
    }
    const revisionId = (data as { id: string }).id;
    await podar(ctx, fila.id);
    return { revisionId };
  } catch (e) {
    return {
      revisionId: null,
      aviso: `No se pudo guardar la revisión (${(e as Error).message}): este cambio no se podrá deshacer.`,
    };
  }
}

/** Deja solo las últimas MAX_REVISIONES de un informe. Best-effort. */
async function podar(ctx: AgentContext, reportId: string): Promise<void> {
  try {
    const { data } = await ctx.db
      .from('bi_report_revisions')
      .select('id')
      .eq('report_id', reportId)
      .order('created_at', { ascending: false })
      .range(MAX_REVISIONES, MAX_REVISIONES + 100);
    const sobran = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (sobran.length) await ctx.db.from('bi_report_revisions').delete().in('id', sobran);
  } catch {
    // Podar es mantenimiento: si falla, se hará en la próxima escritura.
  }
}

/** Borra una revisión recién creada (cuando la escritura que protegía no se hizo). */
async function descartarRevision(ctx: AgentContext, revisionId: string | null): Promise<void> {
  if (!revisionId) return;
  try {
    await ctx.db.from('bi_report_revisions').delete().eq('id', revisionId);
  } catch {
    // Queda una revisión de más; no hace daño.
  }
}

/**
 * Aplica cambios a un informe guardando antes su revisión y solo si nadie lo
 * tocó desde que se leyó.
 */
export async function escribirConRevision(
  ctx: AgentContext,
  fila: FilaInforme,
  cambios: Record<string, unknown>
): Promise<{ revisionId: string | null; avisos: string[]; updatedAt: string }> {
  const rev = await guardarRevision(ctx, fila);
  const updatedAt = new Date().toISOString();

  let q = ctx.db
    .from('bi_reports')
    .update({ ...cambios, updated_at: updatedAt })
    .eq('id', fila.id);
  q = fila.updated_at ? q.eq('updated_at', fila.updated_at) : q.is('updated_at', null);
  const { data, error } = await q.select('id');

  if (error) {
    await descartarRevision(ctx, rev.revisionId);
    throw new ApiError('DATABASE_ERROR', `No se pudo guardar el informe: ${error.message}`, 500);
  }
  if (!data || (data as unknown[]).length === 0) {
    await descartarRevision(ctx, rev.revisionId);
    throw new ApiError(
      'CONFLICT',
      'El informe cambió mientras lo editabas (alguien lo guardó desde el canvas o desde otra ' +
        'conversación). Vuelve a leerlo con get_report y repite el cambio.',
      409
    );
  }
  return { revisionId: rev.revisionId, avisos: rev.aviso ? [rev.aviso] : [], updatedAt };
}

/** Revisiones de un informe, de la más reciente a la más antigua. */
export async function listarRevisiones(
  ctx: AgentContext,
  reportId: string,
  limite = 20
): Promise<Revision[]> {
  const { data, error } = await ctx.db
    .from('bi_report_revisions')
    .select('id, report_id, cliente_id, snapshot, motivo, resumen, created_by, created_at')
    .eq('report_id', reportId)
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) {
    if (TABLA_AUSENTE.includes(error.code)) {
      throw new ApiError('INVALID_CONFIG', AVISO_SIN_HISTORIAL, 503);
    }
    throw new ApiError('DATABASE_ERROR', `No se pudo leer el historial: ${error.message}`, 500);
  }
  return (data ?? []) as Revision[];
}

/** Una revisión por id. */
export async function leerRevision(ctx: AgentContext, revisionId: string): Promise<Revision> {
  const { data, error } = await ctx.db
    .from('bi_report_revisions')
    .select('id, report_id, cliente_id, snapshot, motivo, resumen, created_by, created_at')
    .eq('id', revisionId)
    .maybeSingle();
  if (error) {
    if (TABLA_AUSENTE.includes(error.code)) {
      throw new ApiError('INVALID_CONFIG', AVISO_SIN_HISTORIAL, 503);
    }
    throw new ApiError('DATABASE_ERROR', `No se pudo leer la revisión: ${error.message}`, 500);
  }
  if (!data) throw new ApiError('NOT_FOUND', `No existe la revisión ${revisionId}.`, 404);
  return data as Revision;
}
