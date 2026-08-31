'use server';

/**
 * Perfil del cliente para el agente.
 *
 * Archivo aparte de `_actions.ts` (1300 líneas, 40 exports) a propósito: el
 * perfil vive en su propia tabla, no en `config_api`, y mezclarlo allí invitaría
 * a acabar guardándolo dentro del blob de configuración.
 */

import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/utils/supabase/server';
import { getSesionActual } from '@/lib/auth-session';
import { flagsConexion } from '@/lib/cliente-seguro';

type Resultado = { success: true } | { error: string };

export type PerfilIA = {
  configurado: boolean;
  descripcion: string | null;
  productos: string | null;
  alcance_medicion: string | null;
  fuentes_activas: string[];
  fuentes_ausentes: string[];
  instrucciones: string | null;
  /** Deducidas de las integraciones, para usarlas de punto de partida. */
  deducidas_activas: string[];
  deducidas_ausentes: string[];
  feedback: { id: string; texto: string }[];
};

async function exigirSesion(): Promise<string | null> {
  const s = await getSesionActual();
  if (!s.userId) return null;
  // Un `viewer` no configura nada.
  return ['superadmin', 'admin', 'trafficker'].includes(s.role) ? s.userId : null;
}

export async function leerPerfilIA(clienteId: string): Promise<PerfilIA> {
  const db = await createAdminClient();

  const [perfilRes, clienteRes, feedbackRes] = await Promise.all([
    db.from('cliente_perfiles').select('*').eq('cliente_id', clienteId).maybeSingle(),
    db.from('clientes').select('config_api').eq('id', clienteId).maybeSingle(),
    db
      .from('agent_feedback')
      .select('id, texto')
      .eq('cliente_id', clienteId)
      .eq('activo', true)
      .order('created_at', { ascending: false }),
  ]);

  // Lo que las integraciones dicen hoy. Sirve de borrador cuando nadie ha
  // rellenado el perfil todavía.
  const conexiones = flagsConexion(clienteRes.data?.config_api);
  const deducidasActivas = Object.entries(conexiones)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const deducidasAusentes = Object.entries(conexiones)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const p = perfilRes.data as Record<string, unknown> | null;

  return {
    configurado: p !== null,
    descripcion: (p?.descripcion ?? null) as string | null,
    productos: (p?.productos ?? null) as string | null,
    alcance_medicion: (p?.alcance_medicion ?? null) as string | null,
    fuentes_activas: (p?.fuentes_activas ?? []) as string[],
    fuentes_ausentes: (p?.fuentes_ausentes ?? []) as string[],
    instrucciones: (p?.instrucciones ?? null) as string | null,
    deducidas_activas: deducidasActivas,
    deducidas_ausentes: deducidasAusentes,
    feedback: (feedbackRes.data ?? []) as { id: string; texto: string }[],
  };
}

export async function guardarPerfilIA(
  clienteId: string,
  campos: {
    descripcion: string | null;
    productos: string | null;
    alcance_medicion: string | null;
    instrucciones: string | null;
    fuentes_activas: string[];
    fuentes_ausentes: string[];
  }
): Promise<Resultado> {
  const userId = await exigirSesion();
  if (!userId) return { error: 'No tienes permiso para editar este perfil.' };

  const db = await createAdminClient();
  const { error } = await db.from('cliente_perfiles').upsert(
    {
      cliente_id: clienteId,
      ...campos,
      actualizado_por: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'cliente_id' }
  );

  if (error) return { error: error.message };
  revalidatePath(`/admin/settings/${clienteId}`);
  return { success: true };
}

/**
 * Desactiva una corrección sin borrarla.
 *
 * Se conserva la fila para que quede constancia de qué se le dijo al agente y
 * cuándo: es la diferencia entre un aprendizaje auditable y una caja negra.
 */
export async function desactivarFeedback(id: string): Promise<Resultado> {
  const userId = await exigirSesion();
  if (!userId) return { error: 'No tienes permiso.' };

  const db = await createAdminClient();
  const { error } = await db.from('agent_feedback').update({ activo: false }).eq('id', id);
  if (error) return { error: error.message };
  return { success: true };
}
