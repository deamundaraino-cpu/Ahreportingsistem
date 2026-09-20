'use server';

import { revalidatePath } from 'next/cache';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import { esMonedaReporte, _limpiarCacheMoneda } from '@/lib/moneda-reporte';

/**
 * Guarda la moneda de reporte del cliente en su espejo UTM
 * (`report_utm.clientes.config.moneda_reporte`). Ver `lib/moneda-reporte.ts` para
 * por qué vive ahí y no en `config_api`.
 */
export async function guardarMonedaReporteAction(
  rtmClienteId: string,
  moneda: string
): Promise<{ ok: boolean; error?: string }> {
  const { ok } = await checkWriteRole();
  if (!ok) return { ok: false, error: 'No tienes permisos para cambiar la moneda.' };
  if (!esMonedaReporte(moneda)) return { ok: false, error: `Moneda no admitida: ${moneda}` };

  const db = await reportUtmAdminClient();
  const { data: actual, error: e1 } = await db
    .from('clientes')
    .select('config, public_cliente_id')
    .eq('id', rtmClienteId)
    .maybeSingle();
  if (e1) return { ok: false, error: e1.message };
  if (!actual) return { ok: false, error: 'El cliente no existe.' };

  const config = { ...((actual.config ?? {}) as Record<string, unknown>) };
  config.moneda_reporte = moneda.toUpperCase();
  const { error } = await db.from('clientes').update({ config }).eq('id', rtmClienteId);
  if (error) return { ok: false, error: error.message };

  // El cambio se ve al instante en informes y dashboard, sin esperar al TTL.
  _limpiarCacheMoneda();
  revalidatePath('/admin/settings/[id]', 'page');
  if (actual.public_cliente_id) {
    revalidatePath(`/admin/settings/${actual.public_cliente_id}`);
    revalidatePath(`/dashboard/${actual.public_cliente_id}`);
  }
  return { ok: true };
}
