'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import {
  columnaExcluidoDisponible,
  leerRegla,
  type ReglaExclusion,
} from '@/lib/report-utm/lead-exclusion';
import {
  reclasificarLeadsCliente,
  type ResultadoReclasificacion,
} from '@/lib/report-utm/lead-exclusion-db';
import { leerFiltros, aplicarFiltrosLeads, hayFiltros } from '@/lib/report-utm/leads-filtros';

const SIN_MIGRACION =
  'La exclusión de leads necesita la migración 079 en la base (migrations/079_leads_excluidos_y_mapeo_por_nivel.sql).';

/** Tope por clic: la acción corre dentro de una petición HTTP. */
const MAX_IDS = 500;

async function usuarioActual(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * Excluye o re-incluye a mano una selección de leads.
 *
 * Una decisión humana lleva `excluido_por` = quien la tomó, y eso la protege: la
 * regla automática no vuelve a tocar esa fila al reclasificar.
 */
export async function marcarLeadsAction(
  ids: string[],
  excluir: boolean
): Promise<{ ok: boolean; n?: number; error?: string }> {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para excluir leads.' };

  const limpios = Array.from(new Set(ids.filter((x) => typeof x === 'string' && x)));
  if (limpios.length === 0) return { ok: true, n: 0 };
  if (limpios.length > MAX_IDS) {
    return { ok: false, error: `Como máximo ${MAX_IDS} leads por vez.` };
  }

  const db = await reportUtmAdminClient();
  if (!(await columnaExcluidoDisponible(db))) return { ok: false, error: SIN_MIGRACION };

  const quien = await usuarioActual();
  const ahora = new Date().toISOString();
  const patch = excluir
    ? { excluido: true, excluido_motivo: 'manual', excluido_at: ahora, excluido_por: quien }
    : { excluido: false, excluido_motivo: null, excluido_at: ahora, excluido_por: quien };

  const { error } = await db.from('lead_events').update(patch).in('id', limpios);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/leads');
  return { ok: true, n: limpios.length };
}

/**
 * Tope de la acción «todos los que coinciden».
 *
 * Es más alto que `MAX_IDS` porque ahí el límite lo pone el tamaño de la URL de
 * PostgREST, y aquí no hay lista de ids. Pero sigue habiendo un tope, y por dos
 * razones medidas, no por prudencia genérica:
 *
 *   · La acción corre dentro de una petición HTTP con `statement_timeout = 8 s`.
 *   · Un UPDATE deja una tupla muerta por fila en una tabla de 171 MB cuyo
 *     autovacuum ya hubo que retocar (migración 085). Marcar 50.000 leads de un
 *     clic genera 50.000 tuplas muertas de golpe.
 *
 * Por encima de esto, la herramienta correcta es la regla de exclusión del
 * cliente, que ya existe y reclasifica por lotes.
 */
const MAX_POR_FILTRO = 2000;
/** Tamaño de lote del UPDATE. El mismo orden que `MAX_IDS`. */
const LOTE = 500;

/**
 * Excluye o re-incluye TODOS los leads que coinciden con los filtros.
 *
 * Recibe los filtros, no una lista de ids: así la selección no está limitada a
 * la página de 25 que se ve. La consulta la construye `aplicarFiltrosLeads`,
 * igual que la página y el export — esta acción no arma filtros propios, y
 * `verify-leads-filtros.ts` lo comprueba leyendo este archivo.
 *
 * Exige `clienteId` por lo mismo que la página: sin él, los filtros caros leen
 * la tabla entera.
 */
export async function marcarLeadsPorFiltroAction(
  params: Record<string, string | string[] | undefined>,
  excluir: boolean
): Promise<{ ok: boolean; n?: number; error?: string }> {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para excluir leads.' };

  const f = leerFiltros(params);
  if (!f.clienteId) {
    return { ok: false, error: 'Elegí un cliente antes de marcar todos los que coinciden.' };
  }
  if (!hayFiltros(f)) {
    // Sin filtros esto marcaría TODOS los leads del cliente. Es casi siempre un
    // error, y deshacerlo a mano no es viable.
    return { ok: false, error: 'Poné al menos un filtro: así marcarías todos los leads.' };
  }

  const db = await reportUtmAdminClient();
  if (!(await columnaExcluidoDisponible(db))) return { ok: false, error: SIN_MIGRACION };

  const opciones = { conExclusion: true, conEstado: true };

  // Cuántos son, antes de tocar nada. Es el número que la UI ya enseñó, así que
  // si no cuadra es que algo cambió mientras tanto.
  const { count, error: eConteo } = await aplicarFiltrosLeads(
    db.from('lead_events').select('id', { count: 'exact', head: true }),
    f,
    opciones
  );
  if (eConteo) return { ok: false, error: eConteo.message };
  const total = count ?? 0;
  if (total === 0) return { ok: true, n: 0 };
  if (total > MAX_POR_FILTRO) {
    return {
      ok: false,
      error: `Son ${total.toLocaleString()} leads y el tope por vez es ${MAX_POR_FILTRO.toLocaleString()}. Afiná el filtro, o usá la regla de exclusión del cliente.`,
    };
  }

  const quien = await usuarioActual();
  const ahora = new Date().toISOString();
  const patch = excluir
    ? { excluido: true, excluido_motivo: 'manual', excluido_at: ahora, excluido_por: quien }
    : { excluido: false, excluido_motivo: null, excluido_at: ahora, excluido_por: quien };

  // Por lotes de ids y no con un UPDATE ... WHERE <filtros>: el filtro incluye
  // `excluido`, así que el primer lote cambia el conjunto bajo los pies del
  // siguiente. Con los ids leídos ANTES, el conjunto está congelado.
  const { data: filas, error: eIds } = await aplicarFiltrosLeads(
    db.from('lead_events').select('id'),
    f,
    opciones
  ).limit(MAX_POR_FILTRO);
  if (eIds) return { ok: false, error: eIds.message };

  const ids = (filas ?? []).map((r) => (r as { id: string }).id);
  let hechos = 0;
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const { error } = await db.from('lead_events').update(patch).in('id', lote);
    if (error) {
      // Se dice cuántos SÍ se marcaron: dejarlo en «falló» haría creer que no
      // se tocó nada, y hay que saber que el trabajo quedó a medias.
      return {
        ok: false,
        n: hechos,
        error: `${error.message} (se marcaron ${hechos} antes de fallar)`,
      };
    }
    hechos += lote.length;
  }

  revalidatePath('/leads');
  return { ok: true, n: hechos };
}

/** Guarda la regla de exclusión del cliente en `report_utm.clientes.config`. */
export async function guardarReglaExclusionAction(
  clienteId: string,
  regla: ReglaExclusion
): Promise<{ ok: boolean; error?: string }> {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para cambiar la regla.' };

  const db = await reportUtmAdminClient();
  const { data: actual, error: e1 } = await db
    .from('clientes')
    .select('config')
    .eq('id', clienteId)
    .maybeSingle();
  if (e1) return { ok: false, error: e1.message };

  // Se normaliza con el mismo lector que usa la ingesta: lo que se guarda es
  // exactamente lo que se aplicará, sin claves sueltas.
  const normalizada = leerRegla({ filtro_atribucion: regla });
  const config = { ...((actual?.config ?? {}) as Record<string, unknown>) };
  config.filtro_atribucion = normalizada;

  const { error } = await db.from('clientes').update({ config }).eq('id', clienteId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/admin/settings/[id]', 'page');
  return { ok: true };
}

/**
 * Pasa la regla guardada por todo el histórico del cliente.
 * `aplicar = false` solo cuenta: es la previsualización del botón.
 */
export async function reclasificarLeadsAction(
  clienteId: string,
  aplicar: boolean
): Promise<{ ok: boolean; resultado?: ResultadoReclasificacion; error?: string }> {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para reclasificar leads.' };

  const db = await reportUtmAdminClient();
  if (!(await columnaExcluidoDisponible(db))) return { ok: false, error: SIN_MIGRACION };

  const { data: cliente, error: e1 } = await db
    .from('clientes')
    .select('config')
    .eq('id', clienteId)
    .maybeSingle();
  if (e1) return { ok: false, error: e1.message };

  try {
    const resultado = await reclasificarLeadsCliente(db, clienteId, leerRegla(cliente?.config), {
      aplicar,
    });
    if (aplicar) {
      revalidatePath('/leads');
      revalidatePath('/admin/settings/[id]', 'page');
    }
    return { ok: true, resultado };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
