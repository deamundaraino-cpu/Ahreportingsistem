'use server';

import { revalidatePath } from 'next/cache';
import { reportUtmClient } from '@/lib/report-utm/client';
import { createAdminClient } from '@/utils/supabase/server';
import { checkWriteRole } from '@/lib/report-utm/auth';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function createClienteAction(formData: FormData) {
  const nombre = String(formData.get('nombre') ?? '').trim();
  const descripcion = String(formData.get('descripcion') ?? '').trim() || null;
  const color = String(formData.get('color') ?? 'emerald').trim();
  const slugInput = String(formData.get('slug') ?? '').trim();

  if (!nombre) {
    return { ok: false, error: 'El nombre es obligatorio' };
  }

  const slug = slugify(slugInput || nombre);
  if (!slug) {
    return { ok: false, error: 'Slug inválido' };
  }

  const supabase = await reportUtmClient();
  const { error } = await supabase.from('clientes').insert({
    nombre,
    slug,
    descripcion,
    color,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/report-utm/clientes');
  revalidatePath('/report-utm');
  return { ok: true };
}

export async function updateClienteStatusAction(
  id: string,
  status: 'active' | 'paused' | 'archived'
) {
  const supabase = await reportUtmClient();
  const { error } = await supabase.from('clientes').update({ status }).eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/report-utm/clientes');
  revalidatePath(`/report-utm/clientes/${id}`);
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

export async function deleteClienteAction(id: string) {
  const supabase = await reportUtmClient();
  const { error } = await supabase.from('clientes').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/report-utm/clientes');
  revalidatePath('/report-utm');
  return { ok: true };
}

export async function syncPlatformClientesAction() {
  const admin = await createAdminClient();
  const supabase = await reportUtmClient();

  const [{ data: publicClientes }, { data: linkedClientes }] = await Promise.all([
    admin.from('clientes').select('id, nombre').order('created_at', { ascending: false }),
    supabase.from('clientes').select('public_cliente_id').not('public_cliente_id', 'is', null),
  ]);

  if (!publicClientes?.length) return { ok: true, created: 0 };

  const linkedIds = new Set(
    (linkedClientes ?? []).map((r: { public_cliente_id: string }) => r.public_cliente_id)
  );
  const toCreate = publicClientes.filter((c: { id: string }) => !linkedIds.has(c.id));

  if (!toCreate.length) return { ok: true, created: 0 };

  let created = 0;
  for (const pc of toCreate as { id: string; nombre: string }[]) {
    const baseSlug = slugify(pc.nombre);
    const slug = baseSlug || `cliente-${pc.id.slice(0, 8)}`;
    const { error } = await supabase.from('clientes').insert({
      nombre: pc.nombre,
      slug,
      public_cliente_id: pc.id,
      color: 'emerald',
      status: 'active',
    });
    if (!error) created++;
  }

  if (created > 0) {
    revalidatePath('/report-utm/clientes');
    revalidatePath('/report-utm');
  }

  return { ok: true, created };
}
