'use server';

import { revalidatePath } from 'next/cache';
import { reportUtmClient } from '@/lib/report-utm/client';
import { createAdminClient } from '@/utils/supabase/server';
import { checkWriteRole, getUserRole } from '@/lib/report-utm/auth';
import {
  asegurarEspejoUtm,
  eliminarClienteUtm,
  resumenBorradoUtm,
} from '@/lib/clientes/ciclo-de-vida';

// Los clientes se CREAN en el reporting (/admin/settings), que crea aquí su
// espejo enlazado. El alta manual que había en esta pantalla solo producía
// huérfanos —clientes sin gasto con el que cruzar— y se retiró el 2026-09-12.

/** Borrar clientes y crear espejos en bloque: solo administradores. */
const ROLES_ADMIN = new Set(['superadmin', 'admin']);

function revalidar(id?: string) {
  revalidatePath('/report-utm/clientes');
  revalidatePath('/report-utm');
  revalidatePath('/admin/settings');
  revalidatePath('/dashboard');
  if (id) revalidatePath(`/report-utm/clientes/${id}`);
}

/** Archivar oculta el cliente de listados y selectores en los dos lados. */
export async function updateClienteStatusAction(
  id: string,
  status: 'active' | 'paused' | 'archived'
) {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para cambiar el estado.' };

  const supabase = await reportUtmClient();
  const { error } = await supabase.from('clientes').update({ status }).eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidar(id);
  revalidatePath('/dashboard');
  return { ok: true };
}

/**
 * Actualiza el branding del cliente (logo + color de acento) que usa la vista
 * pública de los informes BI. Se guarda en el JSONB `config` (merge, para no
 * pisar otras claves como `currency`).
 */
export async function updateClienteBrandingAction(
  id: string,
  branding: { logo_url?: string; accent?: string }
) {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para editar el branding.' };

  const supabase = await reportUtmClient();
  const { data: current } = await supabase
    .from('clientes')
    .select('config')
    .eq('id', id)
    .maybeSingle();
  const config = (current?.config ?? {}) as Record<string, unknown>;

  const nextConfig: Record<string, unknown> = { ...config };
  // Cadena vacía → borra la clave (permite quitar logo/acento).
  if (branding.logo_url !== undefined) {
    if (branding.logo_url.trim()) nextConfig.logo_url = branding.logo_url.trim();
    else delete nextConfig.logo_url;
  }
  if (branding.accent !== undefined) {
    if (branding.accent.trim()) nextConfig.accent = branding.accent.trim();
    else delete nextConfig.accent;
  }

  const { error } = await supabase.from('clientes').update({ config: nextConfig }).eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/report-utm/clientes/${id}`);
  return { ok: true };
}

/** Lo que se perdería al borrar, para el diálogo de confirmación. */
export async function resumenBorradoClienteAction(id: string) {
  const role = await getUserRole();
  if (!role || !ROLES_ADMIN.has(role)) {
    return { ok: false, error: 'Solo un administrador puede eliminar clientes.' };
  }
  const resumen = await resumenBorradoUtm(await createAdminClient(), id);
  if (!resumen) return { ok: false, error: 'El cliente no existe.' };
  return { ok: true, resumen };
}

/**
 * Elimina un cliente. Si está enlazado al reporting, se elimina en LOS DOS lados
 * —es el mismo cliente—; si es un huérfano, solo aquí.
 *
 * Antes solo borraba esta fila y el listado lo recreaba en el siguiente render
 * desde el reporting: el borrado era imposible desde este lado.
 */
export async function deleteClienteAction(id: string) {
  const role = await getUserRole();
  if (!role || !ROLES_ADMIN.has(role)) {
    return { ok: false, error: 'Solo un administrador puede eliminar clientes.' };
  }

  // Con todos sus datos, y en los dos lados si está enlazado.
  const r = await eliminarClienteUtm(await createAdminClient(), id);
  if (!r.ok) return { ok: false, error: r.error };

  revalidar();
  return { ok: true, avisos: r.avisos };
}

/**
 * Enlaza un cliente huérfano con uno del reporting. Es lo que faltaba para
 * rescatar un cliente que perdió el enlace: sin él, cinco de sus siete fuentes
 * devuelven cero en silencio y no había ninguna UI para arreglarlo.
 */
export async function enlazarClienteAction(id: string, publicClienteId: string) {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para enlazar clientes.' };
  if (!publicClienteId) return { ok: false, error: 'Elige un cliente del reporting.' };

  const admin = await createAdminClient();
  const rtm = admin.schema('report_utm');
  // Un cliente del reporting tiene UN espejo: si ya lo tiene, enlazar otro
  // duplicaría sus leads en los informes.
  const { data: ocupado } = await rtm
    .from('clientes')
    .select('id, nombre')
    .eq('public_cliente_id', publicClienteId)
    .neq('id', id)
    .limit(1);
  if (ocupado && ocupado.length > 0) {
    return {
      ok: false,
      error: `Ese cliente del reporting ya está enlazado con «${ocupado[0].nombre}».`,
    };
  }

  const { error } = await rtm
    .from('clientes')
    .update({ public_cliente_id: publicClienteId })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidar(id);
  return { ok: true };
}

/**
 * Crea el espejo de los clientes del reporting que aún no lo tienen. Ya NO se
 * ejecuta al abrir la página —así fue como resucitaban los clientes borrados—:
 * es un botón explícito, y el alta en el reporting ya crea el espejo sola.
 * Crea clientes en bloque, así que es solo para administradores.
 */
export async function syncPlatformClientesAction() {
  const role = await getUserRole();
  if (!role || !ROLES_ADMIN.has(role)) {
    return { ok: false, created: 0, error: 'Solo un administrador puede sincronizar clientes.' };
  }

  const admin = await createAdminClient();
  const { data: publicClientes } = await admin
    .from('clientes')
    .select('id, nombre')
    .order('created_at', { ascending: false });

  let created = 0;
  for (const pc of (publicClientes ?? []) as { id: string; nombre: string }[]) {
    const r = await asegurarEspejoUtm(admin, pc.id, pc.nombre);
    if (r.creado) created++;
  }

  if (created > 0) revalidar();
  return { ok: true, created };
}
