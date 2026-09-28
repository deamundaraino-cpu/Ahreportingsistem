// ── Fila «Total» de la tabla del BI ─────────────────────────────────────
//
// Puro y sin imports de servidor: lo usa `TableWidget` (cliente) y lo prueba
// `scripts/verify-bi-tabla-totales.ts`.
//
// Por qué salió del componente (auditoría del 2026-09-28): la tabla calculaba
// los ratios del Total (CPL, ROAS, CTR…) sobre sus bases SUMADAS, pero solo
// pedía al motor las columnas visibles. Una tabla de «campaña × CPL» no traía ni
// gasto ni leads, así que el Total dividía 0 entre 0 y pintaba «$0,00». Y un
// denominador en 0 también daba 0 en vez de «—». Ahora:
//
//   · las bases de cada ratio visible se piden aparte, ocultas
//     (`basesOcultasDeRatios`), igual que ya se hacía con los campos calculados;
//   · si una base no llegó (el motor la anula bajo un filtro no atribuible al
//     gasto, o una fuente no respondió), el Total de ese ratio es «—»;
//   · un denominador en 0 es «—», nunca 0;
//   · las derivadas de Hotmart usan `derivadasHotmart`, la misma definición que
//     el motor, para que el Total de la tabla y el KPI no difieran.

import {
  METRIC_META,
  isAdditiveMetric,
  isFieldMetric,
  parseFieldMetric,
  isOfflineFieldMetric,
  parseOfflineFieldMetric,
  isSheetToken,
  isLeadSegMetric,
  isLeadAnsMetric,
  basesAditivasDeFormula,
  evaluateExpression,
  round2,
  type BiMetric,
} from './bi-metadata';
import { derivadasHotmart } from '@/lib/hotmart/metricas';
import { BASES_DERIVADAS_GA4, GA4_DERIVADAS, derivadasGa4 } from '@/lib/ga4/metricas';

type Fila = Record<string, unknown>;
type Bases = Record<string, number>;

/** Un ratio del catálogo: qué bases aditivas necesita y cómo se recalcula. */
interface RatioDeTotal {
  bases: string[];
  calc: (b: Bases) => number | null;
}

/** a ÷ b, o null si el denominador es 0 (sin dato, no «cero»). */
const div = (a: number, b: number): number | null => (b !== 0 ? a / b : null);
const pct = (a: number, b: number): number | null => {
  const r = div(a, b);
  return r === null ? null : r * 100;
};

/** Las derivadas de Hotmart sobre las bases sumadas (misma definición que el motor). */
function hm(b: Bases) {
  return derivadasHotmart(
    {
      hm_ventas: b.hm_ventas ?? 0,
      hm_compras: b.hm_compras ?? 0,
      hm_bumps: b.hm_bumps ?? 0,
      hm_neto: b.hm_neto ?? 0,
      hm_neto_reembolsado: b.hm_neto_reembolsado ?? 0,
    },
    b.spend ?? 0,
    b.leads_count
  );
}

/**
 * Ratios del catálogo que tienen Total. Los que NO están aquí ni son aditivos
 * quedan en «—»: la frecuencia (su alcance son personas únicas, que no se suman
 * entre filas) y la tasa de cambio (un promedio de días, no de filas).
 */
export const RATIOS_DE_TOTAL: Record<string, RatioDeTotal> = {
  cpl: { bases: ['spend', 'leads_count'], calc: (b) => div(b.spend, b.leads_count) },
  cpa: { bases: ['spend', 'sales_count'], calc: (b) => div(b.spend, b.sales_count) },
  roas: { bases: ['revenue', 'spend'], calc: (b) => div(b.revenue, b.spend) },
  conversion_rate: {
    bases: ['sales_count', 'leads_count'],
    calc: (b) => pct(b.sales_count, b.leads_count),
  },
  cpc: { bases: ['spend', 'clicks'], calc: (b) => div(b.spend, b.clicks) },
  cpm: {
    bases: ['spend', 'impressions'],
    calc: (b) => {
      const r = div(b.spend, b.impressions);
      return r === null ? null : r * 1000;
    },
  },
  ctr: { bases: ['clicks', 'impressions'], calc: (b) => pct(b.clicks, b.impressions) },
  hotmart_roas: {
    bases: ['hotmart_revenue', 'spend'],
    calc: (b) => div(b.hotmart_revenue, b.spend),
  },
  hotmart_cpa: { bases: ['spend', 'hotmart_sales'], calc: (b) => div(b.spend, b.hotmart_sales) },
  hotmart_roi: {
    bases: ['hotmart_revenue', 'spend'],
    calc: (b) => pct(b.hotmart_revenue - b.spend, b.spend),
  },
  hm_roas: { bases: ['hm_neto', 'spend'], calc: (b) => hm(b).hm_roas },
  hm_cpa: { bases: ['spend', 'hm_ventas'], calc: (b) => hm(b).hm_cpa },
  hm_cpa_compra: { bases: ['spend', 'hm_compras'], calc: (b) => hm(b).hm_cpa_compra },
  hm_ticket_medio: { bases: ['hm_neto', 'hm_ventas'], calc: (b) => hm(b).hm_ticket_medio },
  hm_ticket_compra: { bases: ['hm_neto', 'hm_compras'], calc: (b) => hm(b).hm_ticket_compra },
  hm_tasa_reembolso: {
    bases: ['hm_neto', 'hm_neto_reembolsado'],
    calc: (b) => hm(b).hm_tasa_reembolso,
  },
  hm_tasa_bump: { bases: ['hm_bumps', 'hm_compras'], calc: (b) => hm(b).hm_tasa_bump },
  hm_conversion: { bases: ['hm_compras', 'leads_count'], calc: (b) => hm(b).hm_conversion },
  // GA4 por campaña: `derivadasGa4`, la misma definición que el motor.
  ...Object.fromEntries(
    GA4_DERIVADAS.map((k) => [
      k,
      { bases: BASES_DERIVADAS_GA4[k], calc: (b: Bases) => ga4(b)[k] } satisfies RatioDeTotal,
    ])
  ),
};

/** Las derivadas de GA4 por campaña sobre las bases sumadas. */
function ga4(b: Bases) {
  return derivadasGa4(
    {
      ga4_sesiones: b.ga4_sesiones ?? 0,
      ga4_sesiones_interaccion: b.ga4_sesiones_interaccion ?? 0,
      ga4_eventos_clave: b.ga4_eventos_clave ?? 0,
      ga4_ingresos: b.ga4_ingresos ?? 0,
    },
    b.spend ?? 0,
    b.leads_count ?? 0
  );
}

/**
 * Tasas de GA4: promedio ponderado por sesiones, como el motor
 * (`_ga_bounce_wsum / ga_sessions`). La tasa de cada fila ya viene en su unidad
 * final (% o segundos), así que basta con ponderarla por las sesiones de la fila.
 */
const PONDERADAS_POR_SESIONES = new Set(['ga_bounce_rate', 'ga_avg_session_duration']);

/**
 * Bases que la tabla tiene que pedir aunque no sean columnas visibles, para
 * poder totalizar sus ratios. Sin repetir las que ya son columna.
 */
export function basesOcultasDeRatios(colKeys: string[]): string[] {
  const out = new Set<string>();
  for (const k of colKeys) {
    for (const b of RATIOS_DE_TOTAL[k]?.bases ?? []) out.add(b);
    if (PONDERADAS_POR_SESIONES.has(k)) out.add('ga_sessions');
  }
  return [...out].filter((b) => !colKeys.includes(b));
}

/** Valor numérico de una celda, o null si la fila no lo trae. */
function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface EntradaTotales {
  /** Filas visibles (ya pasadas por los filtros por valor). */
  rows: Fila[];
  /** Columnas de la tabla, en orden. */
  colKeys: string[];
  /** Campos calculados usados como columna. */
  calculados?: { name: string; expression: string }[];
}

/**
 * Valores de la fila Total, por columna.
 *
 * Una clave AUSENTE significa «esta columna no tiene total» (la tabla pinta
 * «—»); una clave con `null`, «tiene total pero no se puede calcular» (falta una
 * base o el denominador es 0), que también se pinta «—».
 */
export function calcularTotalesTabla({
  rows,
  colKeys,
  calculados = [],
}: EntradaTotales): Record<string, number | null> {
  const t: Record<string, number | null> = {};

  /** Suma de una clave, o null si ninguna fila la trae (no llegó del motor). */
  const suma = (key: string): number | null => {
    let s = 0;
    let alguna = false;
    for (const r of rows) {
      const n = numero(r[key]);
      if (n === null) continue;
      s += n;
      alguna = true;
    }
    return alguna ? s : null;
  };
  const sumaRedondeada = (key: string): number | null => {
    const s = suma(key);
    return s === null ? null : round2(s);
  };

  const calcMap = new Map(calculados.map((c) => [c.name, c]));

  for (const key of colKeys) {
    // Métricas del catálogo.
    if (METRIC_META[key as BiMetric]) {
      if (isAdditiveMetric(key)) {
        t[key] = sumaRedondeada(key);
        continue;
      }
      const ratio = RATIOS_DE_TOTAL[key];
      if (ratio) {
        const bases: Bases = {};
        let completas = true;
        for (const b of ratio.bases) {
          const s = suma(b);
          if (s === null) {
            completas = false;
            break;
          }
          bases[b] = s;
        }
        const v = completas ? ratio.calc(bases) : null;
        t[key] = v !== null && Number.isFinite(v) ? round2(v) : null;
        continue;
      }
      if (PONDERADAS_POR_SESIONES.has(key)) {
        let num = 0;
        let den = 0;
        for (const r of rows) {
          const tasa = numero(r[key]);
          const ses = numero(r.ga_sessions);
          if (tasa === null || ses === null || ses <= 0) continue;
          num += tasa * ses;
          den += ses;
        }
        t[key] = den > 0 ? round2(num / den) : null;
        continue;
      }
      // Frecuencia, tasa de cambio…: sin total.
      continue;
    }

    // Métricas de campo de formulario: solo suma y recuento son aditivas.
    if (isFieldMetric(key)) {
      const agg = parseFieldMetric(key)?.agg;
      if (agg === 'sum' || agg === 'count') t[key] = sumaRedondeada(key);
      continue;
    }
    // Columnas de Sheet offline: conteos e importes suman; los porcentajes no.
    if (isOfflineFieldMetric(key)) {
      if (parseOfflineFieldMetric(key)?.type !== 'percentage') t[key] = sumaRedondeada(key);
      continue;
    }
    // Campos de Sheet: solo conteos y sumas (un promedio o un extremo sumados
    // fila a fila darían un número inventado).
    if (isSheetToken(key)) {
      if (isAdditiveMetric(key)) t[key] = sumaRedondeada(key);
      continue;
    }
    // Segmentos y respuestas: conteos de contactos, siempre suman.
    if (isLeadSegMetric(key) || isLeadAnsMetric(key)) {
      t[key] = sumaRedondeada(key);
      continue;
    }
    // Campos calculados sobre bases aditivas: la fórmula aplicada a los totales
    // (el CPL total es gasto total ÷ leads totales, no la suma de los CPL).
    const calc = calcMap.get(key);
    if (calc) {
      const bases = basesAditivasDeFormula(calc.expression);
      if (!bases) continue;
      const valores: Record<string, number> = {};
      let completas = true;
      for (const [id, token] of bases) {
        const s = suma(token);
        if (s === null) {
          completas = false;
          break;
        }
        valores[id] = s;
      }
      const v = completas ? evaluateExpression(calc.expression, valores) : null;
      t[key] = v !== null && Number.isFinite(v) ? v : null;
    }
  }

  return t;
}

/**
 * Rótulo de la fila Total. Si el Top-N recortó filas (llegaron tantas como el
 * límite) o un filtro por valor ocultó alguna, el total es SOLO de lo que se ve:
 * decirlo evita que se lea como el total del periodo.
 */
export function rotuloFilaTotal(opts: {
  filasRecibidas: number;
  filasVisibles: number;
  limite: number;
}): string {
  const recortada = opts.limite > 0 && opts.filasRecibidas >= opts.limite;
  const filtrada = opts.filasVisibles < opts.filasRecibidas;
  return recortada || filtrada ? 'Total (filas visibles)' : 'Total';
}
