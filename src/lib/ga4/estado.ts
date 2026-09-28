// Estado de GA4 de un cliente para el motor del BI: ¿tiene propiedad?, ¿se ha
// sincronizado el desglose?, cobertura, moneda y catálogo de eventos clave.
//
// Es lo que decide si una celda de GA4 vale un número o «—». Antes un cliente
// sin GA4 mostraba 0 sesiones, que se lee como «nadie visitó el sitio».
//
// Cacheado 60 s por cliente, como `cargarAlcanceCampanas`. Un error de lectura
// (p. ej. la migración 097 sin aplicar) no se cachea: se devuelve el estado sin
// sincronizar y las celdas del desglose salen «—».

import { createAdminClient } from '@/utils/supabase/server';
import type { EstadoGa4Lite } from './metricas';

const TTL_MS = 60_000;
const cache = new Map<string, { value: EstadoGa4Lite; ts: number }>();

export async function cargarEstadoGa4(publicClienteId: string): Promise<EstadoGa4Lite> {
  const ahora = Date.now();
  const hit = cache.get(publicClienteId);
  if (hit && ahora - hit.ts <= TTL_MS) return hit.value;

  const db = await createAdminClient();
  const [{ data: cli, error: e1 }, { data: est, error: e2 }] = await Promise.all([
    db.from('clientes').select('config_api').eq('id', publicClienteId).maybeSingle(),
    db
      .from('ga4_estado')
      .select(
        'ultimo_ok_at, cubierto_desde, cubierto_hasta, moneda, zona_horaria, umbral, fila_otros, eventos'
      )
      .eq('cliente_id', publicClienteId)
      .maybeSingle(),
  ]);

  const configurado = !!String(
    (cli?.config_api as Record<string, unknown> | null)?.ga_property_id ?? ''
  ).trim();
  const e = (est ?? null) as Record<string, unknown> | null;
  const value: EstadoGa4Lite = {
    configurado,
    sincronizado: !!e?.ultimo_ok_at,
    cubiertoDesde: (e?.cubierto_desde as string | null) ?? null,
    cubiertoHasta: (e?.cubierto_hasta as string | null) ?? null,
    moneda: (e?.moneda as string | null) ?? null,
    zonaHoraria: (e?.zona_horaria as string | null) ?? null,
    umbral: !!e?.umbral,
    filaOtros: !!e?.fila_otros,
    eventos:
      e?.eventos && typeof e.eventos === 'object' ? (e.eventos as Record<string, string>) : {},
  };
  if (!e1 && !e2) {
    if (cache.size > 500) cache.clear();
    cache.set(publicClienteId, { value, ts: ahora });
  }
  return value;
}
