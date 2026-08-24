// Fuente `sales` — `report_utm.sales_events`, una fila por venta.
//
// Estado en producción (jul 2026): la tabla está VACÍA para todos los clientes
// porque faltan los webhooks de venta. Por eso `roas`/`cpa`/`revenue` salen 0 y
// existen las alternativas `cuenta.hotmart_*`, que leen la facturación agregada
// de `metricas_diarias`. Con el invariante nuevo ("cero ≠ desconocido") esto
// pasa a reportarse como `not_configured` en vez de mostrarse como un 0.
//
// `product_name`, `transaction_type` y `customer_country` solo existen aquí: al
// agrupar por ellas la consulta de leads se omite entera. Antes era el conjunto
// `SALES_ONLY_DIMS` en bi-query.ts; ahora sale del eje `sales_column`.

import type { DataSource } from '../registry-types';
import { measure, derived, dimension, money } from '../field-builders';

const S = 'sales';

export const SALES_SOURCE: DataSource = {
  id: S,
  label: 'Ventas',
  location: { kind: 'table', schema: 'report_utm', table: 'sales_events' },
  clientKey: { scope: 'report_utm' },
  grainKind: 'row',
  grain: ['id'],
  joinAxes: ['date', 'platform', 'campaign', 'adset', 'ad', 'lead_column', 'sales_column'],
  dateColumn: 'created_at',
  dateType: 'timestamptz',
  fields: [
    measure(S, 'count', 'Ventas', 'Cantidad de ventas registradas en el período.', 'ventas', {
      agg: 'count',
      column: 'id',
      recommended: true,
      funnelStage: 100,
    }),
    money(S, 'revenue', 'Revenue', 'Dinero total facturado por las ventas del período.', 'ventas', {
      column: 'amount',
      recommended: true,
    }),

    derived(
      S,
      'cpa',
      'CPA',
      'Costo por Adquisición: cuánto cuesta, en promedio, conseguir una venta. Cuanto MÁS BAJO, mejor.',
      'ventas',
      'ads.spend / sales.count',
      {
        format: 'currency',
        nullUnless: ['sales.count'],
        recommended: true,
        direction: 'down',
        goal: 'cpa_max',
      }
    ),
    derived(
      S,
      'roas',
      'ROAS',
      'Retorno de la inversión publicitaria: por cada $1 invertido, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. Un ROAS de 3x significa que se facturó el triple de lo invertido.',
      'ventas',
      'sales.revenue / ads.spend',
      { format: 'ratio', nullUnless: ['ads.spend'], recommended: true, goal: 'roas_min' }
    ),

    // ── Dimensiones exclusivas de ventas ─────────────────────────────
    dimension(S, 'product_name', 'Producto (venta)', 'sales_column', 'ventas'),
    dimension(S, 'transaction_type', 'Tipo de transacción', 'sales_column', 'ventas'),
    dimension(S, 'customer_country', 'País del cliente', 'sales_column', 'ventas'),
    // `platform` necesitaba un override a posteriori en `querySalesDirect`
    // porque es columna propia de sales_events, no un UTM.
    dimension(S, 'platform', 'Plataforma', 'platform', 'ventas'),
  ],
};
