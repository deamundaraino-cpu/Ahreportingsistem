/**
 * Conversiones personalizadas de Meta en el BI de Report-UTM (`metacc:<clave>`).
 *
 * Vive fuera de `bi-query.ts` a propósito: es un lector acotado que se suma al
 * resultado ya fusionado, sin tocar el motor de gasto (que tiene sus propias
 * reglas de nivel y deduplicación). Lee lo que el worker ya guarda:
 *
 *   metricas_diarias.meta_campaigns[].custom_conversions = { <clave>: n, … }
 *
 * Qué se desglosa: total, fecha y campaña real. Es lo que el dato permite sin
 * inventar — el nivel campaña es el que Meta reporta sin solaparse; conjunto y
 * anuncio suman más que la campaña por la deduplicación de atribución.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminClient } from '@/utils/supabase/server';
import { resolvePublicClienteId } from '../campaign-resolver';
import { parseMetaCcMetric } from '../bi-metadata';

export type ClaveDeFila = (fecha: string, campana: string) => string | null;

/**
 * Suma cada conversión pedida por la clave de fila que dé `claveDe`. Puro: se
 * comprueba sin Postgres.
 */
export function agregarMetaCustomConv(
  filas: Array<{ fecha?: string; meta_campaigns?: any[] | null }>,
  tokens: string[],
  claveDe: ClaveDeFila
): Map<string, Record<string, number>> {
  const claves = tokens
    .map((t) => ({ token: t, key: parseMetaCcMetric(t) }))
    .filter((x): x is { token: string; key: string } => Boolean(x.key));
  const out = new Map<string, Record<string, number>>();
  if (claves.length === 0) return out;

  for (const fila of filas) {
    const fecha = String(fila.fecha ?? '');
    for (const c of fila.meta_campaigns ?? []) {
      const cc = c?.custom_conversions;
      if (!cc || typeof cc !== 'object') continue;
      const dim = claveDe(fecha, String(c.name ?? c.campaign_name ?? '(sin nombre)'));
      if (dim === null) continue;
      let acc = out.get(dim);
      if (!acc) {
        acc = {};
        for (const { token } of claves) acc[token] = 0;
        out.set(dim, acc);
      }
      for (const { token, key } of claves) acc[token] += Number(cc[key] ?? 0) || 0;
    }
  }
  return out;
}

/** Lee `meta_campaigns` del cliente y agrega. */
export async function queryMetaCustomConv(
  rtmClienteId: string | undefined,
  dateFrom: string,
  dateTo: string,
  tokens: string[],
  claveDe: ClaveDeFila
): Promise<Map<string, Record<string, number>>> {
  if (!rtmClienteId || tokens.length === 0) return new Map();
  const publicId = await resolvePublicClienteId(rtmClienteId);
  if (!publicId) return new Map();
  const db = await createAdminClient();
  const { data, error } = await db
    .from('metricas_diarias')
    .select('fecha, meta_campaigns')
    .eq('cliente_id', publicId)
    .gte('fecha', dateFrom)
    .lte('fecha', dateTo)
    .limit(5000);
  if (error || !data) return new Map();
  return agregarMetaCustomConv(data as any[], tokens, claveDe);
}

/**
 * Añade los valores a las filas del resultado, por su `dimension_value`
 * (`null` = total). Una clave que el resto de fuentes no produjo se añade como
 * fila propia: si no, esas conversiones desaparecerían del informe.
 */
export function aplicarMetaCustomConv<T extends { dimension_value: string | null }>(
  filas: T[],
  datos: Map<string, Record<string, number>>,
  tokens: string[]
): T[] {
  const out: T[] = filas.map((f) => {
    const valores = datos.get(f.dimension_value ?? 'total');
    const extra: Record<string, number> = {};
    for (const t of tokens) extra[t] = valores?.[t] ?? 0;
    return { ...f, ...extra } as T;
  });
  const presentes = new Set(filas.map((f) => f.dimension_value ?? 'total'));
  for (const [dim, valores] of datos) {
    if (presentes.has(dim)) continue;
    out.push({ dimension_value: dim === 'total' ? null : dim, ...valores } as unknown as T);
  }
  return out;
}
