// ── Alcance de campañas de un cliente (cuentas publicitarias compartidas) ──
//
// «Somos rentable» y «Sur Profundo» comparten la cuenta de Meta a propósito. El
// dashboard recortaba cada pestaña con su filtro, pero el motor del BI y el índice
// del resolver no sabían de quién es cada campaña: cada cliente sumaba el gasto de
// la cuenta entera y solo sus propios leads. La auditoría del 2026-09-28 midió
// «gasto con leads» del 26 % y del 49 %, y un CPL total inflado en los dos.
//
// `config_api.alcance_campanas` dice qué campañas son del cliente. Es texto libre
// separado por comas, como las keywords del dashboard:
//   · «Somos, SR»      → la campaña es del cliente si su nombre contiene alguno;
//   · «-Sur Profundo»  → un término con «-» delante EXCLUYE aunque otro incluya.
// Solo términos de exclusión = todo menos eso. Vacío = sin recorte (lo de antes).
//
// La comparación usa `normLabel`: sin mayúsculas, acentos ni diferencias entre
// «_», «-» y espacio, igual que el cruce de nombres.

import { createAdminClient } from '@/utils/supabase/server';
import { normLabel } from './bi-metadata';

export interface AlcanceCampanas {
  incluir: string[];
  excluir: string[];
}

/** (Puro) Interpreta el texto de la ficha. `null` = el cliente no recorta. */
export function parsearAlcance(raw: unknown): AlcanceCampanas | null {
  if (typeof raw !== 'string') return null;
  const incluir: string[] = [];
  const excluir: string[] = [];
  for (const parte of raw.split(',')) {
    const t = parte.trim();
    if (!t) continue;
    if (t.startsWith('-')) {
      const n = normLabel(t.slice(1));
      if (n) excluir.push(n);
    } else {
      const n = normLabel(t);
      if (n) incluir.push(n);
    }
  }
  if (incluir.length === 0 && excluir.length === 0) return null;
  return { incluir, excluir };
}

/** (Puro) ¿La campaña de este nombre es del cliente? */
export function campanaEnAlcance(nombre: string, alcance: AlcanceCampanas | null): boolean {
  if (!alcance) return true;
  const n = normLabel(nombre ?? '');
  if (alcance.excluir.some((t) => n.includes(t))) return false;
  if (alcance.incluir.length === 0) return true;
  return alcance.incluir.some((t) => n.includes(t));
}

/** (Puro) Predicado listo para los filtros por nombre del motor. */
export function predicadoAlcance(alcance: AlcanceCampanas | null): ((n: string) => boolean) | null {
  if (!alcance) return null;
  return (n: string) => campanaEnAlcance(n, alcance);
}

const TTL_MS = 60_000;
const cache = new Map<string, { value: AlcanceCampanas | null; ts: number }>();

/**
 * Alcance del cliente del reporting (`public.clientes.id`). Un error de lectura
 * NO se cachea y devuelve `null` (sin recorte): mejor el comportamiento de antes
 * durante un fallo que un informe en cero.
 */
export async function cargarAlcanceCampanas(
  publicClienteId: string
): Promise<AlcanceCampanas | null> {
  const ahora = Date.now();
  const hit = cache.get(publicClienteId);
  if (hit && ahora - hit.ts <= TTL_MS) return hit.value;
  const db = await createAdminClient();
  const { data, error } = await db
    .from('clientes')
    .select('config_api')
    .eq('id', publicClienteId)
    .maybeSingle();
  if (error) return null;
  const value = parsearAlcance(
    (data?.config_api as Record<string, unknown> | null)?.alcance_campanas
  );
  if (cache.size > 500) cache.clear();
  cache.set(publicClienteId, { value, ts: ahora });
  return value;
}
