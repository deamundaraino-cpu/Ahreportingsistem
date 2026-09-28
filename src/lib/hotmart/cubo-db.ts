/**
 * Cubo de ventas de Hotmart (día × campaña) para las pestañas del dashboard.
 *
 * Lee `public.hotmart_ventas`, resuelve cada venta a su campaña con el MISMO
 * resolver que los leads y el BI (`campaign-resolver`, una vez por tupla UTM) y
 * cuenta lo que aporta cada venta con `aporteDeVenta` —la definición única de
 * `metricas.ts`—. La codificación y el plegado son puros y viven en
 * `dashboard/hotmart-cubo.ts`; aquí solo está la entrada/salida.
 *
 * La tupla UTM de una venta es la que trajo Hotmart o la heredada del lead del
 * mismo comprador (migración 089, `atribucion_metodo`): las dos se escriben en
 * las mismas columnas `utm_*`, así que aquí no hay que distinguirlas.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { fetchAllRows } from '@/lib/supabase-paginate';
import { COLUMNAS_APORTE } from './metricas';
import { loadResolver, resolveRtmClienteId, SIN_CAMPANA } from '@/lib/report-utm/campaign-resolver';
import type { UtmRecord } from '@/lib/report-utm/campaign-resolver';
import { idsPorNombre } from '@/lib/report-utm/lead-answers-db';
import { construirCuboHotmart, cuboHotmartVacio } from '@/lib/dashboard/hotmart-cubo';
import type { FilaVentaCubo, HotmartCuboLite } from '@/lib/dashboard/hotmart-cubo';
import type { ConversorMoneda } from '@/lib/moneda-reporte';

/** Columnas UTM con las que el resolver cruza una venta con su campaña. */
export const COLUMNAS_UTM_CUBO = [
  'utm_source',
  'utm_id',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

/** `id` va siempre: `fetchAllRows` pagina por keyset sobre él. */
const SELECT_CUBO = ['id', ...COLUMNAS_APORTE, ...COLUMNAS_UTM_CUBO].join(',');

// ── Caché de módulo ───────────────────────────────────────────────────
// Mismo TTL que el cubo de respuestas y el resolver: el dashboard interno y el
// espejo público piden lo mismo, y los tres dependen de que el worker no haya
// sincronizado nada nuevo.
const CUBO_TTL_MS = 60_000;
const cache = new Map<string, { ds: HotmartCuboLite; ts: number }>();

function podar(now: number): void {
  for (const [k, v] of cache) if (now - v.ts > CUBO_TTL_MS) cache.delete(k);
}

/**
 * Carga el cubo de ventas de un cliente del reporting para un rango de fechas de
 * venta (`fecha_venta`, que ya es el día Colombia: se compara como texto, sin
 * aritmética de zonas).
 *
 * Nunca lanza. Si algo falla devuelve un cubo vacío marcado `incompleto`, que el
 * navegador NO adjunta a las filas (las fórmulas `hm_*` salen «—» en vez de 0).
 * Por eso la paginación va en modo estricto: una página perdida daría un cubo a
 * medias con pinta de completo.
 *
 * `clientePublicoId` es `public.clientes.id`. El puente al cliente report_utm (del
 * que cuelgan el índice de campañas y los overrides) se resuelve aquí dentro.
 */
export async function cargarCuboHotmart(
  db: any,
  clientePublicoId: string,
  desde: string,
  hasta: string,
  conv: Pick<ConversorMoneda, 'moneda' | 'convertir'>
): Promise<HotmartCuboLite> {
  if (!clientePublicoId) return cuboHotmartVacio(conv.moneda);

  const key = `${clientePublicoId}|${desde}|${hasta}|${conv.moneda}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts <= CUBO_TTL_MS) return hit.ds;

  try {
    const filas = (await fetchAllRows(
      () =>
        db
          .from('hotmart_ventas')
          .select(SELECT_CUBO)
          .eq('cliente_id', clientePublicoId)
          .gte('fecha_venta', desde)
          .lte('fecha_venta', hasta),
      1000,
      200000,
      { estricto: true }
    )) as FilaVentaCubo[];

    // Sin ventas no se construye el índice de campañas: es la parte cara y no
    // hay nada que resolver.
    let campanaDe: (tupla: UtmRecord) => string = () => SIN_CAMPANA;
    let idDeCampana: (label: string) => string | null = () => null;
    if (filas.length > 0) {
      const rtmId = await resolveRtmClienteId(clientePublicoId);
      const resolver = rtmId ? await loadResolver(rtmId, desde, hasta).catch(() => null) : null;
      if (resolver) {
        const ids = idsPorNombre(resolver);
        // Sin cruce, `campaignOf` devuelve el `utm_campaign` crudo: cada UTM
        // huérfano es su propia fila, igual que en el cubo de respuestas y en
        // el BI. Sin resolver (cliente sin enlazar) no se puede afirmar nada y
        // todo va a `(sin campaña)`.
        campanaDe = (tupla) => resolver.campaignOf(tupla).label;
        idDeCampana = (label) => ids.get(label) ?? null;
      }
    }

    const ds = construirCuboHotmart(filas, {
      campanaDe,
      idDeCampana,
      convertir: conv.convertir,
      moneda: conv.moneda,
    });

    podar(now);
    cache.set(key, { ds, ts: now });
    return ds;
  } catch (err) {
    console.error('[hotmart-cubo] no se pudo cargar el cubo de ventas:', err);
    return { ...cuboHotmartVacio(conv.moneda), incompleto: true };
  }
}
