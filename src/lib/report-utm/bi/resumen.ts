// Frases del widget «Resumen» del BI, a partir de los totales del período.
//
// Puro y sin React: vive fuera del componente para poder probarlo
// (`verify-moneda-y-ventas.ts`) sin cargar el contexto de cliente.

import { isLowerBetter } from '@/lib/report-utm/bi-metadata';
import { formatearMoneda } from '@/lib/moneda-reporte';

// Métricas que alimentan el resumen. Se piden todas de una vez con
// comparación de período, y luego se redactan las frases con las que existan.
export const SUMMARY_METRICS = [
  'spend',
  'leads_count',
  'cpl',
  'sales_count',
  'revenue',
  'roas',
] as const;

export type Totals = Partial<Record<(typeof SUMMARY_METRICS)[number], number>>;

/** «$1.234» en dólares; «CLP 233.487» si el cliente reporta en otra moneda. */
function money(n: number, moneda: string = 'USD'): string {
  const m = String(moneda || 'USD').toUpperCase();
  if (m === 'USD') {
    return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  return formatearMoneda(n, m, { decimales: 0 });
}

function count(n: number): string {
  return Math.round(n).toLocaleString('es-AR');
}

/** Variación relativa en %, o null si no es comparable. */
function pctChange(cur: number, prev: number): number | null {
  if (!Number.isFinite(prev) || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** "un 12% mejor" / "un 8% peor" según el sentido de la métrica. */
function comparePhrase(metric: string, cur: number, prev: number): string {
  const delta = pctChange(cur, prev);
  if (delta === null || Math.abs(delta) < 1) return 'en línea con el período anterior';
  const better = isLowerBetter(metric) ? delta < 0 : delta > 0;
  return `un ${Math.abs(delta).toFixed(0)}% ${better ? 'mejor' : 'peor'} que el período anterior`;
}

/** Redacta el resumen en lenguaje simple a partir de los totales. */
export function buildSummarySentences(cur: Totals, prev: Totals, moneda = 'USD'): string[] {
  const out: string[] = [];

  const spend = cur.spend ?? 0;
  const leads = cur.leads_count ?? 0;
  const cpl = cur.cpl ?? 0;

  if (spend > 0 || leads > 0) {
    let s = `Se invirtieron ${money(spend, moneda)} en publicidad y se consiguieron ${count(leads)} contactos`;
    if (cpl > 0) s += ` a un costo promedio de ${money(cpl, moneda)} cada uno`;
    s += '.';
    out.push(s);
  }

  if (cpl > 0 && (prev.cpl ?? 0) > 0) {
    out.push(`El costo por contacto fue ${comparePhrase('cpl', cpl, prev.cpl ?? 0)}.`);
  } else if (leads > 0 && (prev.leads_count ?? 0) > 0) {
    out.push(
      `La captación de contactos fue ${comparePhrase('leads_count', leads, prev.leads_count ?? 0)}.`
    );
  }

  const sales = cur.sales_count ?? 0;
  const revenue = cur.revenue ?? 0;
  const roas = cur.roas ?? 0;
  if (sales > 0 || revenue > 0) {
    let s = `Se registraron ${count(sales)} ventas por ${money(revenue, moneda)}`;
    if (roas > 0) s += `, un retorno de ${roas.toFixed(2)}x sobre lo invertido`;
    s += '.';
    out.push(s);
    if (roas > 0 && (prev.roas ?? 0) > 0) {
      out.push(`El retorno de la inversión fue ${comparePhrase('roas', roas, prev.roas ?? 0)}.`);
    }
  }

  if (out.length === 0)
    out.push('Todavía no hay datos suficientes en este período para generar un resumen.');
  return out;
}
