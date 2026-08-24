/**
 * Enriquecimiento de las filas de `metricas_diarias` para el dashboard clásico.
 *
 * Es la ÚNICA definición de qué claves ve una fórmula, y la comparten los cuatro
 * caminos que producen filas: el dashboard interno, el espejo público por token,
 * el archivo de pestañas y el periodo anterior de los comparativos. Antes cada
 * uno tenía su propia copia (o ninguna), y por eso una tarjeta con un campo de
 * Sheet funcionaba en el dashboard y salía en blanco en el enlace público.
 *
 * Puro: sin Supabase ni `next/*`, para poder comprobarlo desde `scripts/`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Resumen de un día de `conversiones_offline` más sus filas crudas. */
export interface DiaOffline {
  summary: Record<string, number>;
  rows: any[];
}

/**
 * Agrupa las filas individuales de `conversiones_offline` por fecha.
 *
 * Produce `offline_leads` / `offline_ventas` / `offline_revenue` / `offline_total`
 * y aplana las columnas numéricas de `custom_fields` con el prefijo `sheet_`
 * (sistema anterior de "una columna = una métrica", que sigue vivo para los
 * layouts que ya lo usan).
 */
export function agruparOfflinePorFecha(rows: any[]): Map<string, DiaOffline> {
  const porFecha = new Map<string, DiaOffline>();

  for (const row of rows ?? []) {
    const dia = porFecha.get(row.fecha) ?? {
      summary: { offline_leads: 0, offline_ventas: 0, offline_revenue: 0, offline_total: 0 },
      rows: [] as any[],
    };

    const cantidad = row.cantidad || 0;
    const valor = Number(row.valor) || 0;
    if (row.tipo === 'lead') dia.summary.offline_leads += cantidad;
    if (row.tipo === 'venta') dia.summary.offline_ventas += cantidad;
    dia.summary.offline_revenue += valor;
    dia.summary.offline_total += cantidad;

    for (const [k, v] of Object.entries((row.custom_fields as Record<string, any>) || {})) {
      if (typeof v === 'number') {
        const key = `sheet_${k}`;
        dia.summary[key] = (dia.summary[key] ?? 0) + Number(v);
      }
    }

    dia.rows.push(row);
    porFecha.set(row.fecha, dia);
  }

  return porFecha;
}

export interface MergeInput {
  /** Filas de `metricas_diarias` del rango. */
  metricas: any[];
  /** Filas de `leads_diarios` (integración retirada en la migración 059). */
  leads: any[];
  offlinePorFecha: Map<string, DiaOffline>;
  /** `sf_<clave>` / `sv_<clave>` (+ sumandos) por fecha. */
  sheetPorFecha: Map<string, Record<string, number>>;
  /** Las 4 métricas de leads reconstruidas desde el campo de calidad migrado. */
  leadsLegacyPorFecha: Map<string, Record<string, number>>;
  /**
   * Adjuntar `offline_rows` a cada fila. Solo lo necesita el dashboard, que las
   * usa para los filtros de Sheet; en el archivo y en el periodo anterior sería
   * cargar decenas de miles de objetos para nada.
   */
  incluirFilasOffline?: boolean;
}

/**
 * Une métricas + leads + conversiones offline + campos de Sheet en las filas que
 * consumen las fórmulas.
 *
 * Añade **filas sintéticas** para las fechas que tienen datos de Sheet pero no
 * fila en `metricas_diarias`: un día con leads y sin inversión existe de verdad,
 * y omitirlo hacía que las tarjetas y la tabla mostraran de menos.
 *
 * NO las añade para las fechas que solo tienen `conversiones_offline`: eso sí
 * cambiaría cifras de dashboards que ya están en uso.
 */
export function mergeMetricasDelRango(input: MergeInput): any[] {
  const { metricas, leads, offlinePorFecha, sheetPorFecha, leadsLegacyPorFecha } = input;
  const incluirFilasOffline = input.incluirFilasOffline !== false;

  const leadsPorFecha = new Map((leads ?? []).map((l: any) => [l.date, l]));
  const vistas = new Set<string>();

  const enriquecer = (base: any, fecha: string) => {
    vistas.add(fecha);

    // El histórico de `leads_diarios` manda donde exista —son las cifras que el
    // cliente ya validó—; las fechas posteriores las cubre el campo de calidad
    // migrado, de modo que la serie no da un escalón el día del cambio.
    const legacy = leadsPorFecha.get(fecha);
    const leadsDelDia = legacy
      ? {
          leads_totales: legacy.leads_totales,
          leads_calificados: legacy.leads_calificados,
          leads_no_calificados: legacy.leads_no_calificados,
          tasa_calificacion: legacy.tasa_calificacion,
        }
      : (leadsLegacyPorFecha.get(fecha) ?? {});

    const offlineDia = offlinePorFecha.get(fecha);

    return {
      ...base,
      ...leadsDelDia,
      ...(offlineDia
        ? {
            ...offlineDia.summary,
            ...(incluirFilasOffline ? { offline_rows: offlineDia.rows } : {}),
          }
        : incluirFilasOffline
          ? { offline_rows: [] }
          : {}),
      ...(sheetPorFecha.get(fecha) ?? {}),
    };
  };

  const filas = (metricas ?? []).map((m: any) => enriquecer(m, m.fecha));

  // Fechas con datos de Sheet que no tienen fila de métricas.
  for (const fecha of sheetPorFecha.keys()) {
    if (vistas.has(fecha)) continue;
    filas.push(enriquecer({ fecha }, fecha));
  }

  return filas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}
