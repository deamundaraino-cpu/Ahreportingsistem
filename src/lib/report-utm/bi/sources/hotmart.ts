// Fuente `hotmart` — `public.hotmart_ventas`, una fila por transacción.
//
// ── Por qué es una fuente NUEVA y no un reapuntado de `sales` ────
//  1. `sales` cuelga de `report_utm.clientes`; esta tabla vive en `public` y
//     necesita el puente `public_cliente_id`. Son claves de cliente distintas.
//  2. `sales_events` sigue sirviendo a Cartpanda y Shopify: reapuntarla los
//     dejaría fuera.
//  3. Reapuntar cambiaría el significado de `sales.revenue` en informes ya
//     guardados y ya entregados por enlace público.
//  4. Aquí se pueden declarar bruto, neto y reembolsos por separado; el `amount`
//     único de `sales_events` no lo permite.
//
// ── Lo que esta fuente DESBLOQUEA ───────────────────────────────
// `joinAxes` incluye `campaign`, así que el gasto de `ads` cruza con las ventas
// de Hotmart POR CAMPAÑA. Hoy eso es imposible: `cuenta.ventas_principal/bump/
// upsell` tiene `joinAxes: ['date']` y por eso nunca se reparte — el propio
// texto de ayuda de esas métricas dice "sin atribuir a una campaña concreta".
//
// ── Lo que SIGUE siendo imposible, y conviene decirlo aquí ──────
// CPA y ROAS **por producto**. `ads.joinAxes` no tiene `sales_column`
// (`sources/ads.ts:27`) porque ni `metricas_diarias` ni `ads_daily` tienen eje
// de producto, y no lo tendrán: la plataforma de anuncios no sabe qué producto
// se vendió. El camino honesto es producto DENTRO de campaña.
//
// ── La fecha ────────────────────────────────────────────────────
// `fecha_venta` es un DATE ya convertido a día Colombia al escribir. Por eso
// `dateType: 'date'` y no `timestamptz`: aquí se acaban las tres definiciones de
// "fecha de venta" que competían en el módulo (`created_at` en el motor,
// `sale_timestamp` en la UI, `sale_timestamp ?? received_at` en la agregación
// horaria) y que nunca daban el mismo número.

import type { DataSource } from '../registry-types';
import { measure, derived, dimension, money } from '../field-builders';

const S = 'hotmart';

export const HOTMART_SOURCE: DataSource = {
  id: S,
  label: 'Ventas Hotmart',
  location: { kind: 'table', schema: 'public', table: 'hotmart_ventas' },
  clientKey: { scope: 'public', via: 'public_cliente_id' },
  grainKind: 'row',
  grain: ['id'],
  joinAxes: ['date', 'platform', 'campaign', 'adset', 'ad', 'sales_column'],
  dateColumn: 'fecha_venta',
  dateType: 'date',
  fields: [
    // ── Medidas físicas ──────────────────────────────────────────────
    measure(
      S,
      'ventas',
      'Ventas Hotmart (#)',
      'Cantidad de ventas cobradas de Hotmart en el período. No incluye las reembolsadas ni las pendientes de pago.',
      'hotmart',
      { agg: 'count', column: 'id', recommended: true, funnelStage: 100 }
    ),
    money(
      S,
      'revenue_neto',
      'Facturación Hotmart (neto)',
      'Dinero que realmente llega a la cuenta: la comisión del productor, ya descontada la tarifa de Hotmart. Convertido a dólares.',
      'hotmart',
      { column: 'neto_productor_usd', recommended: true }
    ),
    money(
      S,
      'revenue_bruto',
      'Facturación Hotmart (bruto)',
      'Precio pagado por el comprador antes de comisiones, convertido a dólares.',
      'hotmart',
      { column: 'bruto_usd' }
    ),
    measure(
      S,
      'reembolsos',
      'Reembolsos (#)',
      'Cantidad de ventas del período que acabaron reembolsadas o en contracargo. Se cuentan en la fecha de la VENTA, no en la del reembolso.',
      'hotmart',
      { agg: 'sum', column: 'reembolsos', direction: 'down' }
    ),
    money(
      S,
      'revenue_reembolsado',
      'Facturación reembolsada',
      'Dinero neto de las ventas del período que acabaron devueltas. Se imputa a la fecha de la venta original para que el retorno de la campaña refleje lo que de verdad dejó.',
      'hotmart',
      { column: 'revenue_reembolsado', direction: 'down' }
    ),

    // ── Derivadas ────────────────────────────────────────────────────
    derived(
      S,
      'tasa_reembolso',
      'Tasa de reembolso',
      'Qué porcentaje de la facturación acabó devuelta. Cuanto MÁS BAJO, mejor.',
      'hotmart',
      'hotmart.revenue_reembolsado / hotmart.revenue_neto',
      { format: 'percent', nullUnless: ['hotmart.revenue_neto'], direction: 'down' }
    ),
    derived(
      S,
      'roas',
      'ROAS (Hotmart real)',
      'Retorno de la inversión publicitaria con las ventas atribuidas a cada campaña: por cada $1 invertido, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. A diferencia del ROAS de cuenta, este SÍ se reparte por campaña.',
      'hotmart',
      'hotmart.revenue_neto / ads.spend',
      // Exige AMBAS partes: con gasto > 0 y facturación 0, un ROAS de 0 se
      // lee como "no se recuperó nada", cuando puede ser que no haya datos.
      {
        format: 'ratio',
        nullUnless: ['ads.spend', 'hotmart.revenue_neto'],
        recommended: true,
        goal: 'roas_min',
      }
    ),
    derived(
      S,
      'cpa',
      'CPA (Hotmart real)',
      'Cuánto costó, en promedio, cada venta de Hotmart atribuida a la campaña. Cuanto MÁS BAJO, mejor.',
      'hotmart',
      'ads.spend / hotmart.ventas',
      {
        format: 'currency',
        nullUnless: ['ads.spend', 'hotmart.ventas'],
        recommended: true,
        direction: 'down',
        goal: 'cpa_max',
      }
    ),
    derived(
      S,
      'ticket_medio',
      'Ticket medio',
      'Facturación neta dividida entre el número de ventas: cuánto deja, en promedio, cada compra.',
      'hotmart',
      'hotmart.revenue_neto / hotmart.ventas',
      { format: 'currency', nullUnless: ['hotmart.ventas'] }
    ),

    // ── Dimensiones exclusivas de ventas ─────────────────────────────
    // Eje `sales_column`: al agrupar por ellas, las fuentes que no lo
    // declaran (el gasto entre ellas) quedan fuera con motivo explícito, en
    // vez de mezclar un total global con un desglose.
    dimension(S, 'tipo', 'Tipo de venta (Hotmart)', 'sales_column', 'hotmart'),
    dimension(S, 'oferta', 'Oferta (Hotmart)', 'sales_column', 'hotmart', {
      column: 'oferta_codigo',
      highCardinality: true,
    }),
    dimension(S, 'producto', 'Producto (Hotmart)', 'sales_column', 'hotmart', {
      column: 'producto_nombre',
    }),
    dimension(S, 'pais', 'País (Hotmart)', 'sales_column', 'hotmart', { column: 'comprador_pais' }),
    dimension(S, 'metodo_pago', 'Método de pago', 'sales_column', 'hotmart', {
      column: 'pago_tipo',
    }),
  ],
};
