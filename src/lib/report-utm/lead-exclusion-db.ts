/**
 * Reclasificación del histórico con la regla de exclusión de un cliente.
 *
 * La regla (`lead-exclusion.ts`) decide lead a lead; esto la pasa por todos los
 * leads que ya estaban en la base. Lo usa el botón «Previsualizar / Aplicar al
 * histórico» de la ficha del cliente.
 *
 * ── Qué toca y qué no ───────────────────────────────────────────────────
 * Solo filas que decidió la MÁQUINA (`excluido_por IS NULL`). Si una persona
 * excluyó o re-incluyó un lead a mano, esa decisión manda y la regla no la pisa.
 *
 * Dentro de eso, en las dos direcciones:
 *   · excluye lo que la regla ahora deja fuera;
 *   · re-incluye lo que la regla excluyó ANTES y ya no (por ejemplo, porque se
 *     quitó una condición). Sin esto, afinar la regla solo podría excluir más,
 *     nunca corregir un exceso.
 *
 * ── Por qué lee TODAS las filas del cliente ─────────────────────────────
 * Los duplicados («cuenta el primero») dependen de los leads anteriores,
 * incluidos los que alguien re-incluyó a mano: esos cuentan y ocupan su email.
 * Por eso se leen también las filas manuales, aunque nunca se escriban.
 *
 * El cálculo (`clasificarLeads`) es puro y se comprueba en
 * `scripts/verify-lead-exclusion.ts`; aquí solo se lee y se escribe.
 */

import { fetchAllRows } from '@/lib/supabase-paginate';
import {
  ID_DUPLICADO,
  MOTIVOS_AUTOMATICOS,
  columnasParaRegla,
  evaluarExclusion,
  type MotivoExclusion,
  type ReglaExclusion,
} from './lead-exclusion';
import { clavesContacto, reglaExcluyeDuplicados } from './lead-duplicados';

/** Un lead de muestra para que la previsualización se pueda comprobar a ojo. */
export type EjemploLead = {
  nombre: string | null;
  email: string | null;
  fecha: string | null;
  formulario: string | null;
};

/** Lo que atrapa cada condición (o `__sin_atribucion` / `__duplicado`). */
export type ConteoCondicion = {
  /** Leads decididos por la máquina que esta condición deja fuera. */
  total: number;
  /** De ellos, los que hoy cuentan y pasarían a excluidos. */
  nuevos: number;
  ejemplos: EjemploLead[];
};

export type ResultadoReclasificacion = {
  /** Leads del cliente que decidió la máquina (los que la regla puede tocar). */
  revisados: number;
  /** Por motivo, cuántos pasan a excluidos (o cambian de motivo). */
  aExcluir: Partial<Record<MotivoExclusion, number>>;
  /** Por condición, qué atrapa. Clave = `CondicionRegla.id`. */
  porCondicion: Record<string, ConteoCondicion>;
  /** Cuántos excluidos por la regla vuelven a contar. */
  aReincluir: number;
  /** Excluidos que ya estaban bien y no cambian. */
  yaExcluidos: number;
  aplicado: boolean;
};

/** Lo que `clasificarLeads` decide; los ids solo los usa quien escribe. */
export type Clasificacion = Omit<ResultadoReclasificacion, 'aplicado'> & {
  idsPorMotivo: Map<MotivoExclusion, string[]>;
  idsReincluir: string[];
};

const TANDA = 500;
const EJEMPLOS = 5;

function texto(v: unknown): string | null {
  return v === null || v === undefined || String(v).trim() === '' ? null : String(v);
}

/**
 * Decide, para cada lead decidido por la máquina, si cuenta y por qué no.
 *
 * `filas` en cualquier orden: se recorren por `created_at` (y `id` para
 * desempatar), porque de eso depende cuál es «el primero» de un duplicado.
 */
export function clasificarLeads(
  filas: Array<Record<string, unknown>>,
  regla: ReglaExclusion
): Clasificacion {
  const orden = [...filas].sort((a, b) => {
    const fa = String(a.created_at ?? '');
    const fb = String(b.created_at ?? '');
    if (fa !== fb) return fa < fb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });

  const conDuplicados = reglaExcluyeDuplicados(regla);
  const vistos = new Set<string>();
  const idsPorMotivo = new Map<MotivoExclusion, string[]>();
  const idsReincluir: string[] = [];
  const porCondicion: Record<string, ConteoCondicion> = {};
  let revisados = 0;
  let yaExcluidos = 0;

  for (const f of orden) {
    const estaExcluido = f.excluido === true;

    // Decisión humana: no se toca. Si cuenta, ocupa su contacto.
    if (f.excluido_por !== null && f.excluido_por !== undefined) {
      if (!estaExcluido && conDuplicados) for (const k of clavesContacto(f)) vistos.add(k);
      continue;
    }
    revisados++;

    let decision = evaluarExclusion(f, regla);
    if (!decision && conDuplicados) {
      const ks = clavesContacto(f);
      if (ks.some((k) => vistos.has(k))) {
        decision = { motivo: 'duplicado', condicionId: ID_DUPLICADO };
      }
    }

    if (!decision) {
      if (conDuplicados) for (const k of clavesContacto(f)) vistos.add(k);
      if (estaExcluido && MOTIVOS_AUTOMATICOS.includes(f.excluido_motivo as MotivoExclusion)) {
        idsReincluir.push(String(f.id));
      }
      continue;
    }

    const c = (porCondicion[decision.condicionId] ??= { total: 0, nuevos: 0, ejemplos: [] });
    c.total++;
    if (!estaExcluido) c.nuevos++;
    if (c.ejemplos.length < EJEMPLOS) {
      c.ejemplos.push({
        nombre: texto(f.lead_name),
        email: texto(f.lead_email),
        fecha: texto(f.created_at),
        formulario: texto(f.form_name),
      });
    }

    if (estaExcluido && f.excluido_motivo === decision.motivo) {
      yaExcluidos++;
      continue;
    }
    const ids = idsPorMotivo.get(decision.motivo) ?? [];
    ids.push(String(f.id));
    idsPorMotivo.set(decision.motivo, ids);
  }

  const aExcluir: Partial<Record<MotivoExclusion, number>> = {};
  for (const [m, ids] of idsPorMotivo) aExcluir[m] = ids.length;

  return {
    revisados,
    aExcluir,
    porCondicion,
    aReincluir: idsReincluir.length,
    yaExcluidos,
    idsPorMotivo,
    idsReincluir,
  };
}

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
  const columnas = [
    'id',
    'created_at',
    'excluido',
    'excluido_motivo',
    'excluido_por',
    ...columnasParaRegla(regla),
  ].join(',');

  // Estricto: un recorrido a medias daría una previsualización con pinta de
  // completa y, al aplicar, re-incluiría o excluiría solo una parte.
  const filas = (await fetchAllRows(
    () => rtm.from('lead_events').select(columnas).eq('cliente_id', clienteId),
    1000,
    opts.maxFilas ?? 200_000,
    { estricto: true }
  )) as Array<Record<string, unknown>>;

  const { idsPorMotivo, idsReincluir, ...resultado } = clasificarLeads(filas, regla);

  if (opts.aplicar) {
    const ahora = new Date().toISOString();
    for (const [motivo, ids] of idsPorMotivo) {
      for (let i = 0; i < ids.length; i += TANDA) {
        const { error } = await rtm
          .from('lead_events')
          .update({ excluido: true, excluido_motivo: motivo, excluido_at: ahora })
          .in('id', ids.slice(i, i + TANDA))
          .is('excluido_por', null);
        if (error) throw new Error(`No se pudo marcar la tanda: ${error.message}`);
      }
    }
    for (let i = 0; i < idsReincluir.length; i += TANDA) {
      const { error } = await rtm
        .from('lead_events')
        .update({ excluido: false, excluido_motivo: null, excluido_at: null })
        .in('id', idsReincluir.slice(i, i + TANDA))
        .is('excluido_por', null);
      if (error) throw new Error(`No se pudo re-incluir la tanda: ${error.message}`);
    }
  }

  return { ...resultado, aplicado: opts.aplicar };
}
