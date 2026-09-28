/**
 * Lectura del catálogo de conversiones personalizadas de un cliente, tal como
 * la necesitan los selectores (editor BI, agente, reportes clásicos).
 *
 * Un solo lector para que «activa» signifique lo mismo en todas partes: con
 * actividad en los últimos 90 días y sin archivar. Sin la migración 096 solo
 * existen `label` y `last_seen`: se cae a ellas y nada está marcado.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { aliasFormulaCc, conversionActiva } from './conversiones-personalizadas';
import { colombiaToday } from '@/lib/colombia-date';

export interface ConversionCatalogo {
  key: string;
  label: string;
  field_id: string;
  alias: string;
  tipo: string;
  es_resultado: boolean;
  archivada: boolean;
  ultima_actividad: string | null;
  activa: boolean;
}

export async function leerCatalogoConversiones(
  db: any,
  publicId: string,
  hoy: string = colombiaToday()
): Promise<ConversionCatalogo[]> {
  const completo = await db
    .from('meta_conversiones_catalogo')
    .select(
      'conversion_key, label, field_id, last_seen, tipo, es_resultado, archivada, ultima_actividad'
    )
    .eq('cliente_id', publicId)
    .order('label');
  let filas: any[] = completo.data ?? [];
  if (completo.error) {
    const antiguo = await db
      .from('meta_conversiones_catalogo')
      .select('conversion_key, label, field_id, last_seen')
      .eq('cliente_id', publicId)
      .order('label');
    if (antiguo.error) throw new Error(antiguo.error.message);
    filas = antiguo.data ?? [];
  }
  const vistas = new Set<string>();
  const out: ConversionCatalogo[] = [];
  for (const r of filas) {
    if (!r?.conversion_key || vistas.has(r.conversion_key)) continue;
    vistas.add(r.conversion_key);
    const ultima = r.ultima_actividad ?? r.last_seen ?? null;
    const archivada = Boolean(r.archivada);
    out.push({
      key: r.conversion_key,
      label: r.label || r.conversion_key,
      field_id: r.field_id || `meta_custom_${r.conversion_key}`,
      alias: aliasFormulaCc(r.conversion_key),
      tipo: r.tipo ?? 'otro',
      es_resultado: Boolean(r.es_resultado),
      archivada,
      ultima_actividad: ultima,
      activa: !archivada && conversionActiva(ultima, hoy),
    });
  }
  return out;
}
