import 'server-only';

/**
 * Qué cliente es el de un informe, y quién puede verlo.
 *
 * Hay dos tablas de clientes: `public.clientes` (reporting) y
 * `report_utm.clientes` (atribución), unidas por `public_cliente_id`. Un
 * informe BI apunta a la SEGUNDA (`bi_reports.cliente_id` tiene FK a
 * `report_utm.clientes` desde la migración 080), mientras que todas las demás
 * herramientas del agente —y `ctx.allowedClientIds`— hablan de la PRIMERA.
 *
 * Las herramientas de informes mezclaban las dos: `create_report` guardaba el id
 * público (choca con la FK), y `exigirCliente` comparaba el id de report_utm
 * de un informe contra la lista de ids públicos, así que a quien no era admin
 * cualquier informe le daba «no encontrado».
 *
 * La regla ahora: hacia fuera, `client_id` es SIEMPRE el id público (el que
 * devuelve `list_clients`); la traducción ocurre aquí y en ningún otro sitio.
 */

import { ApiError } from '@/lib/error-handler';
import type { AgentContext } from '../../types';
import { exigirCliente, puedeVerCliente } from '../../registry';

/** Una fila de `bi_reports`, con lo que usan las herramientas. */
export type FilaInforme = {
  id: string;
  nombre: string;
  descripcion: string | null;
  cliente_id: string | null;
  layout: unknown;
  filters: unknown;
  calculated_fields: unknown;
  is_template: boolean | null;
  created_by: string | null;
  public_token: string | null;
  updated_at: string | null;
};

export const COLUMNAS_INFORME =
  'id, nombre, descripcion, cliente_id, layout, filters, calculated_fields, is_template, created_by, public_token, updated_at';

/**
 * Id de `report_utm.clientes` para un cliente público.
 *
 * Comprueba antes que el contexto pueda ver ese cliente: es la entrada por la
 * que llega un `client_id` escrito por el modelo.
 */
export async function rtmDesdePublico(
  ctx: AgentContext,
  publicId: string
): Promise<{ rtmId: string; avisos: string[] }> {
  exigirCliente(ctx, publicId);
  const { data, error } = await ctx.db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .order('created_at', { ascending: true })
    .limit(2);
  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo resolver el cliente: ${error.message}`, 500);
  }
  const filas = (data ?? []) as Array<{ id: string }>;
  if (filas.length === 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `El cliente ${publicId} no tiene espejo en Report-UTM, así que no puede tener informes BI. ` +
        'Se crea al darlo de alta desde el panel.',
      400
    );
  }
  const avisos =
    filas.length > 1
      ? [
          `El cliente ${publicId} tiene más de un espejo en Report-UTM; se usa el más antiguo (${filas[0].id}).`,
        ]
      : [];
  return { rtmId: filas[0].id, avisos };
}

/** Ids públicos de varios clientes de report_utm (null si no están enlazados). */
export async function publicosDeRtm(
  ctx: AgentContext,
  rtmIds: string[]
): Promise<Map<string, string | null>> {
  const unicos = [...new Set(rtmIds.filter(Boolean))];
  const out = new Map<string, string | null>();
  if (unicos.length === 0) return out;
  const { data, error } = await ctx.db
    .schema('report_utm')
    .from('clientes')
    .select('id, public_cliente_id')
    .in('id', unicos);
  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo resolver el cliente: ${error.message}`, 500);
  }
  for (const id of unicos) out.set(id, null);
  for (const r of (data ?? []) as Array<{ id: string; public_cliente_id: string | null }>) {
    out.set(r.id, r.public_cliente_id ?? null);
  }
  return out;
}

/** ¿Es una plantilla del sistema? Esas no se editan nunca: se duplican. */
export function esPlantillaDeSistema(f: Pick<FilaInforme, 'is_template' | 'created_by'>): boolean {
  return Boolean(f.is_template) && !f.created_by;
}

/**
 * Comprueba que el contexto puede leer (o escribir) un informe y devuelve el id
 * público de su cliente.
 *
 *   · Sin cliente (plantillas, informes sin asignar): cualquiera lee. Escribe
 *     quien lo creó o un admin; una plantilla del sistema no la escribe nadie.
 *   · Cliente sin enlace al público: solo quien ve todos los clientes.
 *   · Si no, la regla de siempre: el cliente tiene que ser visible.
 *
 * Un informe ajeno responde «no existe», no «prohibido»: distinguirlos revelaría
 * qué hay en la cuenta.
 */
export async function exigirInformeVisible(
  ctx: AgentContext,
  fila: Pick<FilaInforme, 'id' | 'cliente_id' | 'is_template' | 'created_by'>,
  modo: 'leer' | 'escribir'
): Promise<{ publicId: string | null }> {
  if (!fila.cliente_id) {
    if (modo === 'leer') return { publicId: null };
    if (esPlantillaDeSistema(fila)) {
      throw new ApiError(
        'UNAUTHORIZED',
        'Las plantillas del sistema no se modifican. Duplícala con duplicate_report y edita la copia.',
        403
      );
    }
    if (ctx.allowedClientIds === 'all' || fila.created_by === ctx.userId) {
      return { publicId: null };
    }
    throw new ApiError('NOT_FOUND', `No existe el informe ${fila.id}.`, 404);
  }

  const publicId = (await publicosDeRtm(ctx, [fila.cliente_id])).get(fila.cliente_id) ?? null;
  if (!publicId) {
    if (ctx.allowedClientIds === 'all') return { publicId: null };
    throw new ApiError('NOT_FOUND', `No existe el informe ${fila.id}.`, 404);
  }
  if (!puedeVerCliente(ctx, publicId)) {
    throw new ApiError('NOT_FOUND', `No existe el informe ${fila.id}.`, 404);
  }
  return { publicId };
}

/** Lee un informe y comprueba el acceso. Lanza NOT_FOUND si no puede verlo. */
export async function leerInforme(
  ctx: AgentContext,
  reportId: string,
  modo: 'leer' | 'escribir'
): Promise<FilaInforme & { publicId: string | null }> {
  const { data, error } = await ctx.db
    .from('bi_reports')
    .select(COLUMNAS_INFORME)
    .eq('id', reportId)
    .maybeSingle();
  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo leer el informe: ${error.message}`, 500);
  }
  if (!data) throw new ApiError('NOT_FOUND', `No existe el informe ${reportId}.`, 404);
  const fila = data as FilaInforme;
  const { publicId } = await exigirInformeVisible(ctx, fila, modo);
  return { ...fila, publicId };
}

/**
 * Ids de report_utm de los clientes que el contexto puede ver, para filtrar un
 * listado. `null` = sin filtro (ve todos).
 */
export async function rtmVisibles(ctx: AgentContext): Promise<string[] | null> {
  if (ctx.allowedClientIds === 'all') return null;
  if (ctx.allowedClientIds.length === 0) return [];
  const { data, error } = await ctx.db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .in('public_cliente_id', ctx.allowedClientIds);
  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudieron leer los clientes: ${error.message}`, 500);
  }
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}
