/**
 * Reclasificación del histórico con la regla de exclusión de un cliente.
 *
 * La regla (`lead-exclusion.ts`) decide lead a lead; esto la pasa por todos los
 * leads que ya estaban en la base. Lo usan el botón «Aplicar al histórico» de la
 * ficha del cliente y `scripts/reclasificar-leads-atribucion.ts`, así que los dos
 * reclasifican exactamente igual.
 *
 * ── Qué toca y qué no ───────────────────────────────────────────────────
 * Solo filas que decidió la MÁQUINA (`excluido_por IS NULL`). Si una persona
 * excluyó o re-incluyó un lead a mano, esa decisión manda y la regla no la pisa.
 *
 * Dentro de eso, en las dos direcciones:
 *   · excluye lo que la regla ahora deja fuera;
 *   · re-incluye lo que la regla excluyó ANTES y ya no (por ejemplo, porque se
 *     quitó una fuente de la lista). Sin esto, afinar la regla solo podría
 *     excluir más, nunca corregir un exceso.
 */

import { fetchAllRows } from '@/lib/supabase-paginate';
import {
  MOTIVOS_AUTOMATICOS,
  motivoExclusion,
  type MotivoExclusion,
  type ReglaExclusion,
} from './lead-exclusion';

export type ResultadoReclasificacion = {
  /** Leads del cliente que decidió la máquina (los que la regla puede tocar). */
  revisados: number;
  /** Por motivo, cuántos pasan a excluidos. */
  aExcluir: Partial<Record<MotivoExclusion, number>>;
  /** Cuántos excluidos por la regla vuelven a contar. */
  aReincluir: number;
  /** Excluidos que ya estaban bien y no cambian. */
  yaExcluidos: number;
  aplicado: boolean;
};

const TANDA = 500;

/**
 * @param rtm cliente Supabase ya en el esquema `report_utm` (service role).
 * @param aplicar `false` = solo cuenta (previsualización), no escribe nada.
 */
export async function reclasificarLeadsCliente(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rtm: any,
  clienteId: string,
  regla: ReglaExclusion,
  opts: { aplicar: boolean; maxFilas?: number }
): Promise<ResultadoReclasificacion> {
  const filas = (await fetchAllRows(
    () =>
      rtm
        .from('lead_events')
        .select(
          'id,utm_id,utm_campaign,utm_content,utm_term,utm_source,click_id,form_name,excluido,excluido_motivo'
        )
        .eq('cliente_id', clienteId)
        .is('excluido_por', null),
    1000,
    opts.maxFilas ?? 200_000
  )) as Array<Record<string, unknown>>;

  const porMotivo = new Map<MotivoExclusion, string[]>();
  const reincluir: string[] = [];
  let yaExcluidos = 0;

  for (const f of filas) {
    const motivo = motivoExclusion(f, regla);
    const estaExcluido = f.excluido === true;
    if (motivo) {
      if (estaExcluido && f.excluido_motivo === motivo) {
        yaExcluidos++;
        continue;
      }
      const ids = porMotivo.get(motivo) ?? [];
      ids.push(String(f.id));
      porMotivo.set(motivo, ids);
    } else if (
      estaExcluido &&
      MOTIVOS_AUTOMATICOS.includes(String(f.excluido_motivo) as MotivoExclusion)
    ) {
      reincluir.push(String(f.id));
    }
  }

  const aExcluir: Partial<Record<MotivoExclusion, number>> = {};
  for (const [m, ids] of porMotivo) aExcluir[m] = ids.length;

  if (opts.aplicar) {
    const ahora = new Date().toISOString();
    for (const [motivo, ids] of porMotivo) {
      for (let i = 0; i < ids.length; i += TANDA) {
        const { error } = await rtm
          .from('lead_events')
          .update({ excluido: true, excluido_motivo: motivo, excluido_at: ahora })
          .in('id', ids.slice(i, i + TANDA))
          .is('excluido_por', null);
        if (error) throw new Error(`No se pudo marcar la tanda: ${error.message}`);
      }
    }
    for (let i = 0; i < reincluir.length; i += TANDA) {
      const { error } = await rtm
        .from('lead_events')
        .update({ excluido: false, excluido_motivo: null, excluido_at: null })
        .in('id', reincluir.slice(i, i + TANDA))
        .is('excluido_por', null);
      if (error) throw new Error(`No se pudo re-incluir la tanda: ${error.message}`);
    }
  }

  return {
    revisados: filas.length,
    aExcluir,
    aReincluir: reincluir.length,
    yaExcluidos,
    aplicado: opts.aplicar,
  };
}
