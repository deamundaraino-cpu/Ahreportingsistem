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

  revalidatePath('/report-utm/leads');
  return { ok: true, n: limpios.length };
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

  revalidatePath(`/report-utm/clientes/${clienteId}`);
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
      revalidatePath('/report-utm/leads');
      revalidatePath(`/report-utm/clientes/${clienteId}`);
    }
    return { ok: true, resultado };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
