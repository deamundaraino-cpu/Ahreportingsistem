// Frescura de los datos del cliente de un informe BI, leída en el servidor.
//
// El BI no tenía ninguna señal de «última sincronización»: un pipeline caído
// dejaba el informe con datos viejos y con la misma cara de siempre. El
// dashboard ya tenía el semáforo (`SyncFreshnessBadge`); aquí se le da la misma
// fuente —`getDataFreshness`, sobre `metricas_diarias` y `sync_runs`— al visor
// de informes y a sus enlaces públicos.
//
// Se lee en la página de servidor y viaja ya hecha: el enlace público NO llama a
// la acción desde el navegador (sería exponer al visitante una acción con el id
// del cliente) y NO recibe el texto del último error, que es interno.

import { getDataFreshness } from '@/app/(app)/dashboard/_actions';
import { resolvePublicClienteId } from '@/lib/report-utm/campaign-resolver';
import type { FrescuraDatos } from '@/app/(app)/dashboard/components/SyncFreshnessBadge';

/**
 * Id del cliente del dashboard (`public.clientes`) que corresponde al cliente
 * report_utm de un informe, o null si no está enlazado.
 */
export async function clienteDashboardDeInforme(
  rtmClienteId: string | null | undefined
): Promise<string | null> {
  if (!rtmClienteId) return null;
  return resolvePublicClienteId(rtmClienteId).catch(() => null);
}

/**
 * Frescura para una vista PÚBLICA: solo la hora de la última sincronización, si
 * es parcial y si el último intento falló (sin su mensaje). Null si el informe
 * no tiene cliente enlazado o la lectura falla: el semáforo es observabilidad y
 * no debe romper el informe.
 */
export async function frescuraPublicaDeInforme(
  rtmClienteId: string | null | undefined
): Promise<FrescuraDatos | null> {
  try {
    const publicId = await clienteDashboardDeInforme(rtmClienteId);
    if (!publicId) return null;
    const res = await getDataFreshness(publicId);
    if (res.error) return null;
    return {
      data: res.data
        ? { synced_at: res.data.synced_at ?? null, is_partial: res.data.is_partial ?? null }
        : null,
      lastRun: res.lastRun ? { estado: res.lastRun.estado ?? null } : null,
    };
  } catch {
    return null;
  }
}
