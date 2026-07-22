'use server';

import { createAdminClient, createClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';

async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from('user_profiles').select('role').eq('id', user.id).single();
  return ['superadmin', 'admin'].includes(data?.role ?? '');
}

export type SyncPanelData = {
  cola: Record<string, number>;
  jobs: any[];
  runs: any[];
  clientes: Array<{ id: string; nombre: string }>;
  periodosCerrados: any[];
};

/** Todo lo que muestra el panel de sincronización, en una sola pasada. */
export async function getSyncPanelData(): Promise<SyncPanelData> {
  const supabase = await createAdminClient();

  const [jobsRes, runsRes, clientesRes, cerradosRes] = await Promise.all([
    supabase
      .from('sync_jobs')
      .select('id, tipo, cliente_id, fecha_inicio, fecha_fin, estado, prioridad, intentos, max_intentos, last_error, triggered_by, updated_at')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('sync_runs')
      .select('id, tipo, cliente_id, fecha_inicio, fecha_fin, started_at, duracion_ms, estado, filas_escritas, filas_saltadas, error, ejecutor')
      .order('started_at', { ascending: false })
      .limit(60),
    supabase.from('clientes').select('id, nombre').order('nombre'),
    supabase
      .from('periodos_cerrados')
      .select('cliente_id, periodo, cerrado_at')
      .order('periodo', { ascending: false })
      .limit(50),
  ]);

  const jobs = jobsRes.data ?? [];
  const cola: Record<string, number> = { pending: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  for (const j of jobs) cola[j.estado] = (cola[j.estado] ?? 0) + 1;

  return {
    cola,
    jobs,
    runs: runsRes.data ?? [],
    clientes: clientesRes.data ?? [],
    periodosCerrados: cerradosRes.data ?? [],
  };
}

/** Devuelve un job fallido a la cola. */
export async function retrySyncJob(jobId: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('sync_jobs')
    .update({ estado: 'pending', intentos: 0, last_error: null, locked_at: null, locked_by: null })
    .eq('id', jobId);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}

export async function cancelSyncJob(jobId: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('sync_jobs')
    .update({ estado: 'cancelled', locked_at: null, locked_by: null })
    .eq('id', jobId);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}

/** Encola un rango manualmente desde el panel. */
export async function enqueueSyncRange(clienteId: string | null, start: string, end: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const secret = process.env.CRON_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!secret || !appUrl) return { error: 'CRON_SECRET o NEXT_PUBLIC_APP_URL sin configurar' };

  const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/worker/enqueue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tipo: 'metricas',
      cliente_id: clienteId,
      start,
      end,
      prioridad: 2,
      triggered_by: 'admin_panel',
    }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
  revalidatePath('/admin/sync');
  return { success: true, encolados: data?.encolados ?? 0 };
}

/**
 * Reabre un período congelado. El snapshot se conserva: si la re-sincronización
 * sale mal, los datos originales siguen en `metricas_snapshots`.
 */
export async function reabrirPeriodo(clienteId: string, periodo: string) {
  if (!(await requireAdmin())) return { error: 'No autorizado' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('periodos_cerrados')
    .delete()
    .eq('cliente_id', clienteId)
    .eq('periodo', periodo);
  if (error) return { error: error.message };
  revalidatePath('/admin/sync');
  return { success: true };
}
