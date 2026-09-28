/**
 * Detección de preguntas en los leads de un cliente, con UNA ventana y UNA caché.
 *
 * Antes cada pantalla escaneaba por su cuenta y con su propia ventana: el alta
 * de campos y el selector del dashboard miraban 365 días, el editor del BI 90, y
 * cada apertura repetía el escaneo de hasta 30.000 leads (auditoría del
 * 2026-09-26). Ahora todos los que necesitan «qué preguntas y qué respuestas
 * hay» pasan por aquí: la pantalla de Leads, la activación de un clic y el
 * selector de preguntas del dashboard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { detectarCamposDeLeads } from '@/lib/report-utm/lead-campos-db';
import type { ClaveDetectada } from '@/lib/report-utm/lead-campos';
import { colombiaToday, addDaysISO } from '@/lib/colombia-date';

/** Ventana de descubrimiento de preguntas, para todas las pantallas. */
export const VENTANA_DESCUBRIMIENTO_DIAS = 365;

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { ts: number; r: { claves: ClaveDetectada[]; leads: number } }>();

export async function detectarPreguntas(
  db: any,
  rtmClienteId: string,
  opts?: { incluirIgnoradas?: boolean; refrescar?: boolean }
): Promise<{ claves: ClaveDetectada[]; leads: number }> {
  const key = `${rtmClienteId}|${opts?.incluirIgnoradas ? 'todas' : 'ofrecibles'}`;
  const hit = cache.get(key);
  if (!opts?.refrescar && hit && Date.now() - hit.ts <= TTL_MS) return hit.r;
  const hasta = colombiaToday();
  const desde = addDaysISO(hasta, -(VENTANA_DESCUBRIMIENTO_DIAS - 1));
  const r = await detectarCamposDeLeads(db, rtmClienteId, {
    dateFrom: desde,
    dateTo: hasta,
    incluirIgnoradas: opts?.incluirIgnoradas,
  });
  if (cache.size > 200) cache.clear();
  cache.set(key, { ts: Date.now(), r });
  return r;
}
