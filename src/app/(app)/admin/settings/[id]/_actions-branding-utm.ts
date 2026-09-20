'use server';

import { revalidatePath } from 'next/cache';
import { reportUtmClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';

/**
 * Branding del cliente (logo + color de acento) para la vista pública de los
 * informes BI. Vive en el JSONB `config` del cliente espejo de Report-UTM y se
 * guarda con merge, para no pisar otras claves como `currency` o `goals`.
 *
 * Antes estaba en la ficha de Report-UTM, junto a un alta y un
 * borrado que duplicaban los de `/admin/settings`. Al unificar las dos
 * interfaces esa pantalla desapareció y solo sobrevive esta acción, que es la
 * única que no tenía equivalente del lado del reporting.
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
    .select('config, public_cliente_id')
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

  const publicId = (current as { public_cliente_id?: string } | null)?.public_cliente_id;
  if (publicId) revalidatePath(`/admin/settings/${publicId}`);
  return { ok: true };
}
