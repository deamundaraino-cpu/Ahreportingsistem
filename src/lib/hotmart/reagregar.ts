// ════════════════════════════════════════════════════════════════
// Reagregar `metricas_diarias` desde `hotmart_ventas`, fecha a fecha
// ════════════════════════════════════════════════════════════════
//
// `agregarDesdeHotmartVentas` solo se llamaba DESPUÉS de una descarga de la API
// (`worker/route.ts` → `fetchHotmart`). Todo lo que cambiaba la tabla por otro
// camino se quedaba sin reflejar en el dashboard:
//
//   • `reclasificarRango` (asignar una oferta en la UI) reescribía `tipo` y
//     `tab_id`, pero `ventas_principal/bump/…` seguían con la foto vieja.
//   • `reconciliarReembolsos` marcaba el reembolso en la tabla y devolvía las
//     `fechas` a reagregar… que nadie usaba.
//   • El webhook escribe en vivo, pero el dashboard esperaba a la siguiente
//     corrida del worker.
//   • Una venta aprobada días después de su orden cambia de `fecha_venta`: el
//     día viejo conservaba su conteo y el nuevo no se reagregaba (doble conteo).
//
// Resultado: el dashboard (`metricas_diarias`) y el BI (`hotmart_ventas`)
// divergían. Esto cierra el círculo: quien toca la tabla, reagrega las fechas.
//
// Qué NO toca:
//   • Los meses de `periodos_cerrados`: ya se entregaron en un informe.
//   • Los campos de GA4 que conviven en `hotmart_funnel_data` (visitas a la
//     página de upsell, pagos iniciados, sesiones de landing): se conservan.
//   • `sync_hash`: lo gestiona el worker. Cambiar solo las columnas de Hotmart
//     hace que el hash deje de coincidir y la próxima corrida reescriba la fila
//     completa, que es lo correcto.

import { agregarDesdeHotmartVentas, type DesgloseFunnel, type RegistroHotmart } from './sync';
import { cargarFunnels } from './persistencia';
import type { FunnelHotmart } from './clasificador';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

type FunnelData = {
  by_tab?: Record<string, Partial<DesgloseFunnel> & Record<string, any>>;
  extras?: unknown;
  affiliates?: unknown;
  [k: string]: unknown;
};

/**
 * Funde el desglose NUEVO de Hotmart con los campos de GA4 del JSON guardado.
 *
 * `hotmart_funnel_data` mezcla dos fuentes por pestaña: las ventas (Hotmart) y
 * las páginas vistas (GA4). Reagregar solo Hotmart no puede poner a cero lo que
 * midió GA4. Pura: la prueban las comprobaciones.
 */
export function fusionarFunnelData(
  previo: FunnelData | null | undefined,
  registro: Pick<
    RegistroHotmart,
    'by_tab' | 'extras' | 'affiliate_net' | 'affiliate_count' | 'coproducer_net'
  >
): FunnelData {
  const byTabPrevio = previo?.by_tab ?? {};
  const by_tab: Record<string, DesgloseFunnel> = {};
  for (const [tabId, nuevo] of Object.entries(registro.by_tab)) {
    const viejo = byTabPrevio[tabId] ?? {};
    by_tab[tabId] = {
      ...nuevo,
      upsell: {
        ...nuevo.upsell,
        page_visits: Number((viejo.upsell as any)?.page_visits ?? nuevo.upsell.page_visits ?? 0),
      },
      pagos_iniciados: Number(viejo.pagos_iniciados ?? nuevo.pagos_iniciados ?? 0),
      landing_sessions: Number(viejo.landing_sessions ?? nuevo.landing_sessions ?? 0),
    };
  }
  return {
    ...(previo ?? {}),
    by_tab,
    extras: registro.extras,
    affiliates: {
      affiliate_net: registro.affiliate_net,
      affiliate_count: registro.affiliate_count,
      coproducer_net: registro.coproducer_net,
    },
  };
}

/** Las columnas de Hotmart de `metricas_diarias` para un registro diario. */
export function columnasHotmart(r: RegistroHotmart): Record<string, number> {
  return {
    ventas_principal: r.principal,
    ventas_bump: r.bump,
    ventas_upsell: r.upsell,
    ventas_downsell: r.downsell,
    ventas_principal_count: r.principal_count,
    ventas_bump_count: r.bump_count,
    ventas_upsell_count: r.upsell_count,
    ventas_downsell_count: r.downsell_count,
    ventas_principal_bruto: r.principal_bruto,
    ventas_bump_bruto: r.bump_bruto,
    ventas_upsell_bruto: r.upsell_bruto,
    ventas_downsell_bruto: r.downsell_bruto,
    // Imputados a la fecha de la VENTA, no a la del reembolso.
    ventas_reembolsado: r.reembolsado,
    ventas_reembolsado_count: r.reembolsado_count,
  };
}

export type ResultadoReagregar = {
  reagregadas: string[];
  /** Fechas de meses congelados: no se tocan. */
  cerradas: string[];
  errores: string[];
};

/**
 * Reagrega las fechas dadas de un cliente (id de `public.clientes`).
 *
 * Nunca lanza: un fallo aquí no debe tumbar el webhook ni el job que lo llama;
 * se devuelve en `errores` y el siguiente sync del worker lo corrige igual.
 */
export async function reagregarFechasHotmart(
  db: Db,
  clientePublicoId: string,
  fechas: Iterable<string>,
  opts: { funnels?: FunnelHotmart[]; log?: (msg: string) => void } = {}
): Promise<ResultadoReagregar> {
  const log = opts.log ?? (() => {});
  const unicas = Array.from(new Set(Array.from(fechas).filter(Boolean))).sort();
  const res: ResultadoReagregar = { reagregadas: [], cerradas: [], errores: [] };
  if (unicas.length === 0) return res;

  try {
    const { data: cerradosRows } = await db
      .from('periodos_cerrados')
      .select('periodo')
      .eq('cliente_id', clientePublicoId);
    const cerrados = new Set<string>(
      (cerradosRows ?? []).map((r: any) => String(r.periodo).slice(0, 7))
    );

    const funnels = opts.funnels ?? (await cargarFunnels(db, clientePublicoId));

    const abiertas = unicas.filter((f) => {
      if (cerrados.has(f.slice(0, 7))) {
        res.cerradas.push(f);
        return false;
      }
      return true;
    });
    if (abiertas.length === 0) return res;

    const { data: previas } = await db
      .from('metricas_diarias')
      .select('fecha, hotmart_funnel_data, source_synced_at')
      .eq('cliente_id', clientePublicoId)
      .in('fecha', abiertas);
    const previaPorFecha = new Map<string, any>((previas ?? []).map((r: any) => [r.fecha, r]));

    for (const fecha of abiertas) {
      try {
        const registro = await agregarDesdeHotmartVentas(db, clientePublicoId, fecha, funnels);
        const previa = previaPorFecha.get(fecha);
        const sourceSynced =
          previa?.source_synced_at && typeof previa.source_synced_at === 'object'
            ? { ...previa.source_synced_at }
            : {};
        sourceSynced.hotmart = new Date().toISOString();

        const { error } = await db.from('metricas_diarias').upsert(
          {
            cliente_id: clientePublicoId,
            fecha,
            ...columnasHotmart(registro),
            hotmart_funnel_data: fusionarFunnelData(previa?.hotmart_funnel_data, registro),
            source_synced_at: sourceSynced,
          },
          { onConflict: 'cliente_id,fecha' }
        );
        if (error) throw new Error(error.message);
        res.reagregadas.push(fecha);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.errores.push(`${fecha}: ${msg}`);
      }
    }
  } catch (e) {
    res.errores.push(e instanceof Error ? e.message : String(e));
  }

  if (res.reagregadas.length > 0 || res.errores.length > 0) {
    log(
      `[Hotmart] Reagregadas ${res.reagregadas.length} fecha(s)` +
        (res.cerradas.length ? `, ${res.cerradas.length} en meses congelados` : '') +
        (res.errores.length ? `, ${res.errores.length} con error: ${res.errores[0]}` : '')
    );
  }
  return res;
}
