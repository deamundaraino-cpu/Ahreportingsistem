// Fuente `cuenta` — columnas escalares de `public.metricas_diarias`.
//
// GA4, Hotmart y las métricas manuales comparten grano (`cliente_id, fecha`),
// tabla y columna de cliente, así que son UNA fuente con tres grupos de
// presentación, no tres fuentes. Separarlas triplicaría la consulta para una
// distinción cosmética — que es justo el error que cometía `MetricGroup` en el
// otro sentido: usaba el grupo para decidir semántica.
//
// `joinAxes: ['date']` es toda la explicación de por qué estas métricas caen en
// la fila "(total)" en cuanto agrupas por campaña o por cualquier dimensión de
// lead: la tabla está preagregada por día y cliente, y no tiene eje de entidad.
// Antes eso se escribía a mano como `breakdown: 'total'` en 20 métricas.

import type { DataSource } from '../registry-types'
import { measure, derived, money } from '../field-builders'

const S = 'cuenta'

export const CUENTA_SOURCE: DataSource = {
    id: S,
    label: 'Cuenta (por día)',
    location: { kind: 'table', schema: 'public', table: 'metricas_diarias' },
    clientKey: { scope: 'public', via: 'public_cliente_id' },
    grainKind: 'daily',
    grain: ['cliente_id', 'fecha'],
    joinAxes: ['date'],
    dateColumn: 'fecha',
    dateType: 'date',
    fields: [
        // ── GA4 ──────────────────────────────────────────────────────────
        measure(S, 'ga_sessions', 'Sesiones (GA4)',
            'Visitas al sitio web medidas por Google Analytics.', 'ga4'),
        // Tasas NO aditivas: se promedian ponderadas por sesiones. Sin el peso,
        // un promedio de promedios da un número que no cuadra con ningún día.
        measure(S, 'ga_bounce_rate', 'Tasa de rebote (GA4)',
            'Porcentaje de visitas que se fueron sin interactuar con el sitio. Cuanto MÁS BAJO, mejor.', 'ga4',
            { format: 'percent', agg: 'weighted_avg', weightBy: 'cuenta.ga_sessions', direction: 'down' }),
        measure(S, 'ga_avg_session_duration', 'Duración sesión GA4 (s)',
            'Cuánto dura, en promedio, una visita al sitio. Es un dato del sitio entero: no se puede repartir por campaña.', 'ga4',
            { agg: 'weighted_avg', weightBy: 'cuenta.ga_sessions' }),

        // ── Hotmart ──────────────────────────────────────────────────────
        // OJO: se calcula desde GA4 (payment_page_views), no desde la API de
        // Hotmart. El nombre viene del dashboard clásico y se conserva, pero el
        // texto de ayuda lo dice para que nadie lo cruce con la pasarela.
        measure(S, 'hotmart_pagos_iniciados', 'Pagos iniciados (Hotmart)',
            'Veces que alguien llegó a la página de pago. Se mide con Google Analytics, no con Hotmart, y es del sitio entero: no se reparte por campaña.', 'hotmart'),

        money(S, 'ventas_principal', 'Ventas principal (neto)', 'Facturación neta del producto principal.', 'hotmart'),
        money(S, 'ventas_bump', 'Ventas bump (neto)', 'Facturación neta de los productos bump (añadidos en el checkout).', 'hotmart'),
        money(S, 'ventas_upsell', 'Ventas upsell (neto)', 'Facturación neta de los upsells (ofertas posteriores a la compra).', 'hotmart'),
        measure(S, 'ventas_principal_count', 'Ventas principal (#)', 'Cantidad de ventas del producto principal.', 'hotmart'),
        measure(S, 'ventas_bump_count', 'Ventas bump (#)', 'Cantidad de ventas de productos bump.', 'hotmart'),
        measure(S, 'ventas_upsell_count', 'Ventas upsell (#)', 'Cantidad de ventas de upsell.', 'hotmart'),
        money(S, 'ventas_principal_bruto', 'Ventas principal (bruto)', 'Facturación del producto principal antes de comisiones.', 'hotmart'),
        money(S, 'ventas_bump_bruto', 'Ventas bump (bruto)', 'Facturación de los bump antes de comisiones.', 'hotmart'),
        money(S, 'ventas_upsell_bruto', 'Ventas upsell (bruto)', 'Facturación de los upsell antes de comisiones.', 'hotmart'),

        // `ventas_cerradas` TIENE columna propia en la tabla, pero el worker
        // nunca la escribe: el número real que carga el equipo vive dentro del
        // JSONB `metricas_manuales`. Leerla de la columna daba siempre 0.
        // Grupo `hotmart` y no `manual` para no mover el catálogo de sitio en
        // este cambio: es donde está hoy en `METRIC_META`, y el script de
        // verificación compara grupo por grupo. Reagruparla es una decisión de
        // producto aparte.
        measure(S, 'ventas_cerradas', 'Ventas cerradas (#)',
            'Ventas cerradas que carga el equipo a mano en el dashboard.', 'hotmart',
            { column: 'metricas_manuales->>VENTAS_CERRADAS' }),

        // ── Derivadas de Hotmart ─────────────────────────────────────────
        // Alternativa real a roas/cpa/revenue para clientes que venden por
        // Hotmart sin webhook de ventas configurado (sales_events vacía).
        money(S, 'hotmart_revenue_calc', 'Facturación Hotmart (neto)',
            'Dinero facturado en Hotmart en el período (neto de comisiones).', 'hotmart',
            { formula: 'cuenta.ventas_principal + cuenta.ventas_bump + cuenta.ventas_upsell', agg: 'sum' }),
        measure(S, 'hotmart_sales_calc', 'Ventas Hotmart (total)',
            'Cantidad de ventas de Hotmart en el período (principal + bump + upsell).', 'hotmart',
            { formula: 'cuenta.ventas_principal_count + cuenta.ventas_bump_count + cuenta.ventas_upsell_count', agg: 'sum' }),

        // Exigen que AMBAS partes sean > 0. Sin eso, un cliente sin Hotmart veía
        // ROAS 0 y ROI −100%, que se lee como "se perdió todo lo invertido".
        derived(S, 'hotmart_roas', 'ROAS (Hotmart)',
            'Retorno de la inversión usando la facturación de Hotmart: por cada $1 invertido en anuncios, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. Se calcula sobre el total del período, sin atribuir a una campaña concreta.',
            'hotmart', 'cuenta.hotmart_revenue_calc / ads.spend',
            { format: 'ratio', nullUnless: ['ads.spend', 'cuenta.hotmart_revenue_calc'], goal: 'roas_min' }),
        derived(S, 'hotmart_cpa', 'CPA (Hotmart)',
            'Cuánto costó, en promedio, cada venta de Hotmart. Cuanto MÁS BAJO, mejor. Se calcula sobre el total del período, sin atribuir a una campaña concreta.',
            'hotmart', 'ads.spend / cuenta.hotmart_sales_calc',
            { format: 'currency', nullUnless: ['ads.spend', 'cuenta.hotmart_sales_calc'], direction: 'down', goal: 'cpa_max' }),
        derived(S, 'hotmart_roi', 'ROI % (Hotmart)',
            'Ganancia sobre la inversión publicitaria: (facturación Hotmart − inversión) ÷ inversión. Un 100% significa que se recuperó el doble de lo invertido. Cuanto MÁS ALTO, mejor.',
            'hotmart', '(cuenta.hotmart_revenue_calc - ads.spend) / ads.spend',
            { format: 'percent', nullUnless: ['ads.spend', 'cuenta.hotmart_revenue_calc'] }),
    ],
}
