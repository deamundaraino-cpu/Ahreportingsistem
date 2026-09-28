/**
 * Formula Engine — evaluates simple arithmetic formulas against a metric row.
 * Supports: +, -, *, / and references to raw DB columns.
 * Returns null on division by zero, when a denominator has no data, or when every
 * referenced value is missing (ver «Aritmética con dato faltante», más abajo).
 */
import { filterCampaignList, type AnyCampaignFilter } from './campaign-filter';
import { CLAVE_TASA_CAMBIO, decimalesDe } from './moneda-reporte';

// All available fields from metricas_diarias that formulas can reference.
export const FIELD_MAP: Record<string, string> = {
  // ── Meta: Entrega ────────────────────────────────────────────────────────
  meta_spend: 'meta_spend',
  meta_impressions: 'meta_impressions',
  meta_reach: 'meta_reach',
  meta_frequency: 'meta_frequency',
  meta_clicks: 'meta_clicks',
  meta_link_clicks: 'meta_link_clicks',

  // ── Meta: Métricas calculadas (resueltas como macros) ─────────────────
  meta_cpc: 'meta_cpc',
  meta_cpc_link: 'meta_cpc_link',
  meta_cpm: 'meta_cpm',
  meta_ctr: 'meta_ctr',
  meta_ctr_link: 'meta_ctr_link',

  // ── Meta: Eventos estándar de píxel ──────────────────────────────────
  meta_leads: 'meta_leads',
  meta_leads_form: 'meta_leads_form',
  meta_cpl: 'meta_cpl',
  meta_purchases: 'meta_purchases',
  meta_cpp: 'meta_cpp',
  meta_roas: 'meta_roas',
  meta_adds_to_cart: 'meta_adds_to_cart',
  meta_cost_per_add_to_cart: 'meta_cost_per_add_to_cart',
  meta_initiates_checkout: 'meta_initiates_checkout',
  meta_cost_per_initiate_checkout: 'meta_cost_per_initiate_checkout',
  meta_landing_page_views: 'meta_landing_page_views',
  meta_cost_per_landing_page_view: 'meta_cost_per_landing_page_view',
  meta_complete_registration: 'meta_complete_registration',
  meta_cost_per_complete_registration: 'meta_cost_per_complete_registration',
  meta_view_content: 'meta_view_content',
  meta_cost_per_view_content: 'meta_cost_per_view_content',
  meta_search: 'meta_search',
  meta_add_to_wishlist: 'meta_add_to_wishlist',
  meta_contact: 'meta_contact',
  meta_cost_per_contact: 'meta_cost_per_contact',
  meta_schedule: 'meta_schedule',
  meta_cost_per_schedule: 'meta_cost_per_schedule',
  meta_start_trial: 'meta_start_trial',
  meta_submit_application: 'meta_submit_application',
  meta_subscribe: 'meta_subscribe',
  meta_find_location: 'meta_find_location',
  meta_customize_product: 'meta_customize_product',
  meta_donate: 'meta_donate',

  // ── Meta: Video ───────────────────────────────────────────────────────
  meta_video_views: 'meta_video_views',
  meta_video_3s_views: 'meta_video_3s_views',
  meta_video_thruplay: 'meta_video_thruplay',
  meta_cost_per_thruplay: 'meta_cost_per_thruplay',

  // ── Meta: Engagement ─────────────────────────────────────────────────
  meta_page_engagement: 'meta_page_engagement',
  meta_post_engagement: 'meta_post_engagement',
  meta_post_reactions: 'meta_post_reactions',
  meta_post_shares: 'meta_post_shares',
  meta_post_saves: 'meta_post_saves',
  meta_post_comments: 'meta_post_comments',

  // ── Meta: Mensajería ─────────────────────────────────────────────────
  meta_messaging_conversations_started: 'meta_messaging_conversations_started',
  meta_cost_per_messaging_conversation: 'meta_cost_per_messaging_conversation',

  // ── Meta: Resultados de objetivo ─────────────────────────────────────
  meta_results: 'meta_results',
  meta_cost_per_result: 'meta_cost_per_result',

  // ── Google Analytics 4 ───────────────────────────────────────────────
  ga_sessions: 'ga_sessions',
  ga_bounce_rate: 'ga_bounce_rate',
  ga_avg_session_duration: 'ga_avg_session_duration',

  // ── TikTok Ads ────────────────────────────────────────────────────────
  tiktok_spend: 'tiktok_spend',
  tiktok_impressions: 'tiktok_impressions',
  tiktok_clicks: 'tiktok_clicks',
  tiktok_conversions: 'tiktok_conversions',
  tiktok_cpc: 'tiktok_cpc',
  tiktok_cpm: 'tiktok_cpm',
  tiktok_ctr: 'tiktok_ctr',
  tiktok_cpa: 'tiktok_cpa',

  // ── Hotmart ───────────────────────────────────────────────────────────
  // `hotmart_clics_link` se retiró: estaba en el catálogo y aquí, pero NUNCA
  // tuvo columna ni escritor, así que valía 0 siempre. Una métrica que solo
  // puede mostrar cero es peor que ninguna.
  hotmart_pagos_iniciados: 'hotmart_pagos_iniciados',

  // ── Ventas (totales globales — suma de todos los funnels + extras) ───
  ventas_principal: 'ventas_principal',
  ventas_bump: 'ventas_bump',
  ventas_upsell: 'ventas_upsell',
  ventas_downsell: 'ventas_downsell',
  ventas_principal_count: 'ventas_principal_count',
  ventas_bump_count: 'ventas_bump_count',
  ventas_upsell_count: 'ventas_upsell_count',
  ventas_downsell_count: 'ventas_downsell_count',
  ventas_principal_bruto: 'ventas_principal_bruto',
  ventas_bump_bruto: 'ventas_bump_bruto',
  ventas_upsell_bruto: 'ventas_upsell_bruto',
  ventas_downsell_bruto: 'ventas_downsell_bruto',
  // Neto de las ventas de ESE día que acabaron devueltas. Se imputa a la fecha
  // de la venta, no a la del reembolso.
  ventas_reembolsado: 'ventas_reembolsado',
  ventas_reembolsado_count: 'ventas_reembolsado_count',
  ventas_cerradas: 'ventas_cerradas',

  // ── Funnel actual (inyectado por DashboardClient desde hotmart_funnel_data.by_tab[activeTabId]) ──
  funnel_principal_count: 'funnel_principal_count',
  funnel_principal_neto: 'funnel_principal_neto',
  funnel_principal_bruto: 'funnel_principal_bruto',
  // Precio público del tab (configurado en USD), ya en la moneda de reporte y
  // PROMEDIADO entre días, no sumado (ver `PROMEDIOS_DE_FILA`).
  funnel_principal_price: 'funnel_principal_price',
  funnel_bump_count: 'funnel_bump_count',
  funnel_bump_neto: 'funnel_bump_neto',
  funnel_bump_bruto: 'funnel_bump_bruto',
  funnel_upsell_count: 'funnel_upsell_count',
  funnel_upsell_neto: 'funnel_upsell_neto',
  funnel_upsell_bruto: 'funnel_upsell_bruto',
  funnel_upsell_visits: 'funnel_upsell_visits',
  funnel_downsell_count: 'funnel_downsell_count',
  funnel_downsell_neto: 'funnel_downsell_neto',
  funnel_downsell_bruto: 'funnel_downsell_bruto',
  funnel_pagos_iniciados: 'funnel_pagos_iniciados',

  // ── Manual ────────────────────────────────────────────────────────────
  leads_registrados: 'leads_registrados',

  // ── Google Sheets Leads ──────────────────────────────────────────────
  leads_totales: 'leads_totales',
  leads_calificados: 'leads_calificados',
  leads_no_calificados: 'leads_no_calificados',
  tasa_calificacion: 'tasa_calificacion',

  // ── Conversiones Offline (Google Sheets) ─────────────────────────────
  offline_leads: 'offline_leads', // leads que no pasaron por píxel
  offline_ventas: 'offline_ventas', // ventas cerradas offline
  offline_revenue: 'offline_revenue', // revenue reportado en el sheet
  offline_total: 'offline_total', // suma de todas las cantidades offline

  // ── Moneda de reporte (lib/moneda-reporte.ts) ────────────────────────
  // Tasa del día: unidades de la moneda del cliente por 1 USD. En un rango es
  // el PROMEDIO de las tasas diarias (ver `reagregarNoAditivas`), nunca la suma.
  tasa_cambio: 'tasa_cambio',
  // Facturación de Hotmart SIN convertir: en dólares, al lado de la convertida.
  ventas_principal_usd: 'ventas_principal_usd',
  ventas_bump_usd: 'ventas_bump_usd',
  ventas_upsell_usd: 'ventas_upsell_usd',
  ventas_downsell_usd: 'ventas_downsell_usd',
  ventas_principal_bruto_usd: 'ventas_principal_bruto_usd',
  ventas_bump_bruto_usd: 'ventas_bump_bruto_usd',
  ventas_upsell_bruto_usd: 'ventas_upsell_bruto_usd',
  ventas_downsell_bruto_usd: 'ventas_downsell_bruto_usd',
  ventas_reembolsado_usd: 'ventas_reembolsado_usd',
};

// Complex metrics that should be resolved dynamically (as formulas)
// to ensure perfect aggregation (e.g. not summing CPCs, but dividing total spend by total clicks).
export const MACRO_MAP: Record<string, string> = {
  meta_cpc: 'meta_spend / meta_clicks',
  meta_cpc_link: 'meta_spend / meta_link_clicks',
  meta_cpm: '(meta_spend / meta_impressions) * 1000',
  meta_ctr: '(meta_clicks / meta_impressions) * 100',
  meta_ctr_link: '(meta_link_clicks / meta_impressions) * 100',
  meta_cpl: 'meta_spend / meta_leads',
  meta_cpl_form: 'meta_spend / meta_leads_form',
  meta_cpp: 'meta_spend / meta_purchases',
  meta_cost_per_add_to_cart: 'meta_spend / meta_adds_to_cart',
  meta_cost_per_initiate_checkout: 'meta_spend / meta_initiates_checkout',
  meta_cost_per_landing_page_view: 'meta_spend / meta_landing_page_views',
  meta_cost_per_complete_registration: 'meta_spend / meta_complete_registration',
  meta_cost_per_view_content: 'meta_spend / meta_view_content',
  meta_cost_per_contact: 'meta_spend / meta_contact',
  meta_cost_per_schedule: 'meta_spend / meta_schedule',
  meta_cost_per_thruplay: 'meta_spend / meta_video_thruplay',
  meta_cost_per_messaging_conversation: 'meta_spend / meta_messaging_conversations_started',
  meta_cost_per_result: 'meta_spend / meta_results',
  // Incluye el DOWNSELL, como `total_roas` (auditoría del 2026-09-25): sin él,
  // un cliente con downsell veía un ROAS de Meta más bajo que el real.
  meta_roas: '(ventas_principal + ventas_bump + ventas_upsell + ventas_downsell) / meta_spend',

  // ── TikTok: macros derivadas ─────────────────────────────────────────
  tiktok_cpc: 'tiktok_spend / tiktok_clicks',
  tiktok_cpm: '(tiktok_spend / tiktok_impressions) * 1000',
  tiktok_ctr: '(tiktok_clicks / tiktok_impressions) * 100',
  tiktok_cpa: 'tiktok_spend / tiktok_conversions',

  // ── Funnel: macros derivadas (replicando estructura del Excel) ──────
  // Bruta = precio público fijo × nº ventas principal (19 USD × 5 = 95).
  // Requiere que el tab tenga principal_price_usd configurado; si no, devuelve 0.
  funnel_facturacion_bruta: 'funnel_principal_price * funnel_principal_count',
  // Neta = suma de comisiones reales que llegan a la cuenta. Incluye el
  // DOWNSELL, que hasta ahora no existía en ninguna parte del repositorio.
  funnel_facturacion_neta:
    'funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto + funnel_downsell_neto',
  funnel_roas:
    '(funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto + funnel_downsell_neto) / meta_spend',
  funnel_roi:
    '((funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto + funnel_downsell_neto) - meta_spend) / meta_spend',
  funnel_dinero_bolsa:
    '(funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto + funnel_downsell_neto) - meta_spend',
  funnel_costo_compra: 'meta_spend / funnel_principal_count',
  funnel_pct_pagos_compras: '(funnel_principal_count / funnel_pagos_iniciados) * 100',
  funnel_pct_conversion: '(funnel_principal_count / meta_link_clicks) * 100',
  funnel_pct_conv_order: '(funnel_bump_count / funnel_principal_count) * 100',
  funnel_pct_conv_upsell: '(funnel_upsell_count / funnel_upsell_visits) * 100',
  // Un downsell se ofrece a quien RECHAZÓ el upsell: el denominador natural es
  // el mismo tráfico de la página de upsell.
  funnel_pct_conv_downsell: '(funnel_downsell_count / funnel_upsell_visits) * 100',
  funnel_costo_pago: 'meta_spend / funnel_pagos_iniciados',
  funnel_pct_visitas_pagos: '(funnel_pagos_iniciados / ga_sessions) * 100',
  funnel_costo_visita: 'meta_spend / ga_sessions',
  funnel_pct_clics_visitas: '(ga_sessions / meta_link_clicks) * 100',

  // ── Conversiones Offline: macros derivadas ──────────────────────────
  // CPA real: gasto de Meta dividido entre ventas cerradas offline
  offline_cpa: 'meta_spend / offline_ventas',
  // Close rate: ventas offline / (leads de Meta + leads offline)
  offline_close_rate: '(offline_ventas / (meta_leads + offline_leads)) * 100',
  // ROAS real usando revenue del sheet
  offline_roas: 'offline_revenue / meta_spend',
  // Total leads combinando píxel + offline
  total_leads: 'meta_leads + offline_leads',
  // CPL real (usando leads totales pixel + offline)
  total_cpl: 'meta_spend / (meta_leads + offline_leads)',

  // ── Panel General: macros derivadas usando totales globales ─────────
  //
  // OJO con el denominador: las métricas `total_*` usan `total_spend`
  // (Meta + TikTok), no solo `meta_spend`. Antes `total_roas` era idéntica a
  // `meta_roas`, así que un cliente que invertía en las dos plataformas veía un
  // "ROAS total" inflado: el numerador incluía ventas traídas por TikTok, pero
  // el denominador ignoraba lo que costó TikTok.
  //
  // Las `total_*` incluyen ahora el DOWNSELL. Era un hueco real: el concepto no
  // existía en ninguna parte del repositorio, así que un downsell se contaba
  // como venta principal o se caía a `extras[]` y desaparecía del total.
  total_spend: 'meta_spend + tiktok_spend',
  total_facturacion_neta: 'ventas_principal + ventas_bump + ventas_upsell + ventas_downsell',
  // `total_facturacion_bruta` era `ventas_principal_bruto` A SECAS, ignorando
  // `ventas_bump_bruto` y `ventas_upsell_bruto` — dos columnas que la migración
  // 010 creó y que el worker SÍ escribe desde entonces. El bruto que veía el
  // cliente se quedaba corto en todo el importe de sus bumps y upsells.
  total_facturacion_bruta:
    'ventas_principal_bruto + ventas_bump_bruto + ventas_upsell_bruto + ventas_downsell_bruto',
  total_roas:
    '(ventas_principal + ventas_bump + ventas_upsell + ventas_downsell) / (meta_spend + tiktok_spend)',
  total_roi:
    '((ventas_principal + ventas_bump + ventas_upsell + ventas_downsell) - (meta_spend + tiktok_spend)) / (meta_spend + tiktok_spend)',
  total_dinero_bolsa:
    '(ventas_principal + ventas_bump + ventas_upsell + ventas_downsell) - (meta_spend + tiktok_spend)',
  total_costo_compra: '(meta_spend + tiktok_spend) / ventas_principal_count',

  // ── Reembolsos ──────────────────────────────────────────────────────
  // Antes NO existían: la API se pedía filtrada a APPROVED+COMPLETE, así que
  // una venta devuelta contaba como facturación para siempre.
  //
  // Auditoría del 2026-09-25: `ventas_*` YA excluye las ventas devueltas
  // (`agregarDesdeHotmartVentas` solo suma las cobradas; lo devuelto va aparte a
  // `ventas_reembolsado`). Restar `ventas_reembolsado` aquí lo descontaba DOS
  // veces. La «neta real» es por tanto la neta; se conserva el id para no romper
  // un layout que la tuviera.
  total_facturacion_neta_real: 'ventas_principal + ventas_bump + ventas_upsell + ventas_downsell',
  // Mismo motivo: el denominador tiene que ser lo facturado ANTES de devolver
  // (neto cobrado + reembolsado), o devolver la mitad daba 100 %. Y en
  // porcentaje (× 100), que es como lo formatea el catálogo; ningún layout
  // guardado la usaba (inventario del 2026-09-25), así que nada la multiplicaba
  // ya a mano. Misma definición que `hm_tasa_reembolso`.
  total_tasa_reembolso:
    '(ventas_reembolsado / (ventas_principal + ventas_bump + ventas_upsell + ventas_downsell + ventas_reembolsado)) * 100',

  // ── Moneda de reporte: totales en dólares, sin convertir ────────────
  total_facturacion_neta_usd:
    'ventas_principal_usd + ventas_bump_usd + ventas_upsell_usd + ventas_downsell_usd',
  total_facturacion_bruta_usd:
    'ventas_principal_bruto_usd + ventas_bump_bruto_usd + ventas_upsell_bruto_usd + ventas_downsell_bruto_usd',

  // ── Hotmart por campaña (`hm_*`): las derivadas del BI ──────────────
  // Mismas definiciones que `derivadasHotmart` (hotmart/metricas.ts), para que
  // `hm_cpa` diga lo mismo en una pestaña y en un informe. Las claves base las
  // pone el cubo de ventas (`dashboard/hotmart-cubo.ts`) y siguen el filtro de
  // campañas de la pestaña; el gasto es el de las dos plataformas, recortado por
  // el mismo filtro. Todas empiezan por `hm_`: es lo que hace que el servidor
  // sepa que tiene que cargar el cubo (`formulaUsaHotmart`).
  //
  // Una diferencia con el BI: aquí un ROAS con gasto y 0 ventas da 0 (con Hotmart
  // conectado, 0 ventas es un dato), allí «—». Sin Hotmart conectado las claves
  // `hm_*` no existen en la fila y la fórmula ya da null.
  hm_roas: 'hm_neto / (meta_spend + tiktok_spend)',
  // Por TRANSACCIÓN cobrada: bumps y upsells cuentan aparte. Para el costo de
  // conseguir un comprador, `hm_cpa_compra`.
  hm_cpa: '(meta_spend + tiktok_spend) / hm_ventas',
  hm_cpa_compra: '(meta_spend + tiktok_spend) / hm_compras',
  hm_ticket_medio: 'hm_neto / hm_ventas',
  hm_ticket_compra: 'hm_neto / hm_compras',
  // Sobre lo facturado ANTES de devolver: `hm_neto` ya excluye lo reembolsado.
  hm_tasa_reembolso: '(hm_neto_reembolsado / (hm_neto + hm_neto_reembolsado)) * 100',
  hm_tasa_bump: '(hm_bumps / hm_compras) * 100',
};

/**
 * Métricas de fila que son un PROMEDIO y no un total: el motor las reagrega como
 * Σ`__num` / Σ`__den` (ver `reagregarNoAditivas`).
 *
 * `funnel_principal_price` es el precio público del principal, configurado en la
 * pestaña. Se inyecta en CADA fila (en la moneda de reporte, con la tasa del
 * día), así que sumarlo daba precio × días, y `funnel_facturacion_bruta` de un
 * mes salía treinta veces el precio por las compras.
 */
export const PROMEDIOS_DE_FILA: ReadonlySet<string> = new Set([
  CLAVE_TASA_CAMBIO,
  'funnel_principal_price',
]);

// ── Semantic Aliases ─────────────────────────────────────────────────────────
// High-level metric names that can be mapped to different data sources per layout.
// The Layout Builder UI reads this catalog to render dropdowns.
export const SEMANTIC_ALIASES: Record<
  string,
  { label: string; defaultSource: string; options: { value: string; label: string }[] }
> = {
  $visitas: {
    label: 'Visitas / Sesiones',
    defaultSource: 'ga_sessions',
    options: [
      { value: 'ga_sessions', label: 'GA4 — Sessions' },
      { value: 'meta_landing_page_views', label: 'Meta — Landing Page Views' },
      { value: 'meta_link_clicks', label: 'Meta — Clics en enlace' },
    ],
  },
  $pagos_iniciados: {
    label: 'Pagos Iniciados',
    defaultSource: 'hotmart_pagos_iniciados',
    options: [
      { value: 'hotmart_pagos_iniciados', label: 'Hotmart — Checkouts' },
      { value: 'meta_initiates_checkout', label: 'Meta — Initiate Checkout' },
      { value: 'meta_adds_to_cart', label: 'Meta — Add to Cart' },
    ],
  },
  $conversiones: {
    label: 'Conversiones',
    defaultSource: 'meta_purchases',
    options: [
      { value: 'meta_purchases', label: 'Meta — Purchases' },
      { value: 'meta_leads', label: 'Meta — Leads' },
      { value: 'meta_complete_registration', label: 'Meta — Registros Completados' },
    ],
  },
  $facturacion_principal: {
    label: 'Facturación Principal',
    defaultSource: 'ventas_principal',
    options: [{ value: 'ventas_principal', label: 'Hotmart — Ventas Principal' }],
  },
  $facturacion_bump: {
    label: 'Facturación Bump',
    defaultSource: 'ventas_bump',
    options: [{ value: 'ventas_bump', label: 'Hotmart — Ventas Bump' }],
  },
  $facturacion_upsell: {
    label: 'Facturación Upsell',
    defaultSource: 'ventas_upsell',
    options: [{ value: 'ventas_upsell', label: 'Hotmart — Ventas Upsell' }],
  },

  // ── Aliases del Funnel actual (resueltos según la pestaña activa) ────
  // Estos campos los inyecta DashboardClient en cada row leyendo
  // hotmart_funnel_data.by_tab[activeTabId]. En tabs sin funnel quedan en 0.
  '$funnel.principal_count': {
    label: 'Funnel — Compras (Principal)',
    defaultSource: 'funnel_principal_count',
    options: [{ value: 'funnel_principal_count', label: 'Funnel — # Ventas Principal' }],
  },
  '$funnel.principal_neto': {
    label: 'Funnel — Neto Principal',
    defaultSource: 'funnel_principal_neto',
    options: [
      { value: 'funnel_principal_neto', label: 'Funnel — Neto Principal (moneda del cliente)' },
    ],
  },
  '$funnel.principal_bruto': {
    label: 'Funnel — Bruto Principal',
    defaultSource: 'funnel_principal_bruto',
    options: [
      { value: 'funnel_principal_bruto', label: 'Funnel — Bruto Principal (moneda del cliente)' },
    ],
  },
  '$funnel.bump_count': {
    label: 'Funnel — # Order Bumps',
    defaultSource: 'funnel_bump_count',
    options: [{ value: 'funnel_bump_count', label: 'Funnel — # Order Bumps' }],
  },
  '$funnel.bump_neto': {
    label: 'Funnel — Neto Order Bump',
    defaultSource: 'funnel_bump_neto',
    options: [
      { value: 'funnel_bump_neto', label: 'Funnel — Neto Order Bump (moneda del cliente)' },
    ],
  },
  '$funnel.upsell_count': {
    label: 'Funnel — # Upsells',
    defaultSource: 'funnel_upsell_count',
    options: [{ value: 'funnel_upsell_count', label: 'Funnel — # Upsells' }],
  },
  '$funnel.upsell_neto': {
    label: 'Funnel — Neto Upsell',
    defaultSource: 'funnel_upsell_neto',
    options: [{ value: 'funnel_upsell_neto', label: 'Funnel — Neto Upsell (moneda del cliente)' }],
  },
  '$funnel.upsell_visits': {
    label: 'Funnel — Visitas Pág. Upsell',
    defaultSource: 'funnel_upsell_visits',
    options: [{ value: 'funnel_upsell_visits', label: 'GA4 — Visitas pág. upsell' }],
  },
  '$funnel.pagos_iniciados': {
    label: 'Funnel — Pagos Iniciados (GA4)',
    defaultSource: 'funnel_pagos_iniciados',
    options: [{ value: 'funnel_pagos_iniciados', label: 'GA4 — Visitas pág. de pago' }],
  },
  '$funnel.facturacion_neta': {
    label: 'Funnel — Facturación Neta',
    defaultSource: 'funnel_facturacion_neta',
    options: [
      { value: 'funnel_facturacion_neta', label: 'Funnel — Neto (Principal + Bump + Upsell)' },
    ],
  },
  '$funnel.facturacion_bruta': {
    label: 'Funnel — Facturación Bruta',
    defaultSource: 'funnel_facturacion_bruta',
    options: [{ value: 'funnel_facturacion_bruta', label: 'Funnel — Precio × Ventas Principal' }],
  },
  '$funnel.roas': {
    label: 'Funnel — ROAS',
    defaultSource: 'funnel_roas',
    options: [{ value: 'funnel_roas', label: 'Funnel — Neto / Spend' }],
  },
  '$funnel.roi': {
    label: 'Funnel — ROI',
    defaultSource: 'funnel_roi',
    options: [{ value: 'funnel_roi', label: 'Funnel — (Neto - Spend) / Spend' }],
  },
  '$funnel.dinero_bolsa': {
    label: 'Funnel — Dinero en la Bolsa',
    defaultSource: 'funnel_dinero_bolsa',
    options: [{ value: 'funnel_dinero_bolsa', label: 'Funnel — Neto - Spend' }],
  },
};

/**
 * Resolves semantic aliases ($visitas, $pagos_iniciados, etc.) to their
 * concrete database field names using the layout's source_mapping.
 * Falls back to the alias's default source if no mapping is found.
 */
export function resolveAliases(formula: string, mapping: Record<string, string> = {}): string {
  let expr = formula;
  // Sort by length descending so longer aliases ($funnel.facturacion_neta) replace before shorter prefixes
  const sortedAliases = Object.entries(SEMANTIC_ALIASES).sort(([a], [b]) => b.length - a.length);
  for (const [alias, config] of sortedAliases) {
    const replacement = mapping[alias] || config.defaultSource;
    expr = expr.replaceAll(alias, replacement);
  }
  return expr;
}

/**
 * Resolves semantic aliases with automatic platform fallback.
 * If the selected source requires a platform not in availablePlatforms,
 * falls back to the best available Meta alternative.
 *
 * Examples:
 *   $visitas → ga_sessions (if GA4 configured) or meta_landing_page_views (if not)
 *   $pagos_iniciados → hotmart_pagos_iniciados (if Hotmart configured) or meta_initiates_checkout (if not)
 */
export function resolveAliasesWithFallback(
  formula: string,
  mapping: Record<string, string> = {},
  availablePlatforms: Set<string> = new Set(['meta'])
): string {
  let expr = formula;
  const sortedAliases = Object.entries(SEMANTIC_ALIASES).sort(([a], [b]) => b.length - a.length);
  for (const [alias, config] of sortedAliases) {
    let selected = mapping[alias] || config.defaultSource;

    // Fallback: if selected source requires unavailable platform, use Meta alternative
    if (selected.startsWith('ga_') && !availablePlatforms.has('ga4')) {
      const metaAlt = config.options.find((o) => o.value.startsWith('meta_'));
      if (metaAlt) selected = metaAlt.value;
    } else if (selected.startsWith('hotmart_') && !availablePlatforms.has('hotmart')) {
      const metaAlt = config.options.find((o) => o.value.startsWith('meta_'));
      if (metaAlt) selected = metaAlt.value;
    } else if (selected.startsWith('ventas_') && !availablePlatforms.has('hotmart')) {
      // ventas_* fields come from Hotmart — no Meta equivalent for revenue. Se dejan
      // tal cual: sin Hotmart conectado su 0 cuenta como «sin dato»
      // (`plataformaAusente`), así que un ROAS da null («—») y no 0.
    }

    expr = expr.replaceAll(alias, selected);
  }
  return expr;
}

/**
 * Recursively expands macros and custom metrics in a formula.
 * Detects circular references to avoid infinite loops.
 */
function expandFormulaRecursive(
  formula: string,
  macroMap: Record<string, string>,
  path: string[] = []
): string {
  let expr = formula.trim();

  // Resolve full-match macros first (e.g. "meta_cpc")
  if (macroMap[expr] && !path.includes(expr)) {
    return expandFormulaRecursive(macroMap[expr], macroMap, [...path, expr]);
  }

  // Replace all occurrences of macros within the formula
  // We sort keys by length descending to avoid partial replacements (e.g. meta_cpc vs meta_cpc_link)
  const sortedKeys = Object.keys(macroMap).sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    if (expr.includes(key)) {
      const regex = new RegExp(`\\b${key}\\b`, 'g');
      if (regex.test(expr)) {
        if (path.includes(key)) {
          // Circular reference detected
          return '0';
        }
        const replacement = macroMap[key];
        const expanded = expandFormulaRecursive(replacement, macroMap, [...path, key]);
        expr = expr.replaceAll(regex, `(${expanded})`);
      }
    }
  }
  return expr;
}

// ── Aritmética con «dato faltante» ─────────────────────────────────────────
//
// Hasta el 2026-09-28 un campo sin dato valía 0, así que un ROAS sin Hotmart
// conectado salía «0.00x» (0 ÷ gasto) donde el BI y la doc 09 dicen «—». El
// evaluador arrastra ahora, junto al número, de dónde sale:
//
//   · `const`    — un literal de la fórmula (el `* 100` de un porcentaje).
//   · `dato`     — al menos un campo con valor real (0 incluido: 0 leads es 0).
//   · `faltante` — solo campos sin dato (el marcador `M` en la expresión).
//
// Reglas, pensadas para no romper las fórmulas donde el 0 es legítimo:
//
//   · `a + b`, `a − b`, `a × b`: faltante solo si LOS DOS lados lo son. Un
//     `meta_spend + tiktok_spend` sin TikTok sigue siendo el gasto de Meta.
//     Un literal no «rescata» a un faltante: `(x / y) * 100` sigue faltante.
//   · `a ÷ b`: si el DENOMINADOR es faltante, la fórmula entera es null (dividir
//     entre algo que no se midió no da un número). Si el numerador es faltante,
//     el cociente también (ROAS sin ventas medibles = «—», no 0).
//   · Resultado faltante → null («—»).

/** Marcador de campo sin dato dentro de la expresión saneada. */
const MARCA_FALTANTE = 'M';
/**
 * Prefijo del valor de un campo CON dato (`D12.5`). Sin él, el número de un
 * campo sería indistinguible de un literal de la fórmula, y `gasto + M` se
 * leería como «constante + faltante» = faltante.
 */
const MARCA_DATO = 'D';

type Procedencia = 'const' | 'dato' | 'faltante';
interface Valor {
  n: number;
  p: Procedencia;
}

/** Procedencia de `a op b` para + − ×. */
function combinar(a: Procedencia, b: Procedencia): Procedencia {
  if (a === 'const') return b;
  if (b === 'const') return a;
  return a === 'faltante' && b === 'faltante' ? 'faltante' : 'dato';
}

/** Señal interna: un denominador sin dato anula la fórmula entera. */
class DenominadorFaltante extends Error {}

/**
 * Safely evaluates a pure arithmetic expression (digits, spaces, + - * / . ( ),
 * the missing-value marker `M` and the field-value prefix `D`).
 * Replaces `new Function`/`eval`, which are blocked by the production CSP
 * (script-src has no 'unsafe-eval'). The caller MUST sanitize the input to the
 * allowed character set before calling this. Recursive-descent parser with
 * standard precedence and unary +/-. Returns NaN on malformed input and null
 * when the result is not measurable (see the rules above).
 */
function safeEvalArithmetic(input: string): number | null {
  const s = input;
  let i = 0;
  const skipWs = () => {
    while (i < s.length && s[i] === ' ') i++;
  };

  const parseExpression = (): Valor => {
    let left = parseTerm();
    skipWs();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++];
      const right = parseTerm();
      left = {
        n: op === '+' ? left.n + right.n : left.n - right.n,
        p: combinar(left.p, right.p),
      };
      skipWs();
    }
    return left;
  };
  const parseTerm = (): Valor => {
    let left = parseFactor();
    skipWs();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++];
      const right = parseFactor();
      if (op === '*') {
        left = { n: left.n * right.n, p: combinar(left.p, right.p) };
      } else {
        if (right.p === 'faltante') throw new DenominadorFaltante();
        left = {
          n: left.n / right.n,
          p: left.p === 'faltante' ? 'faltante' : combinar(left.p, right.p),
        };
      }
      skipWs();
    }
    return left;
  };
  const parseFactor = (): Valor => {
    skipWs();
    if (s[i] === '+') {
      i++;
      return parseFactor();
    }
    if (s[i] === '-') {
      i++;
      const v = parseFactor();
      return { n: -v.n, p: v.p };
    }
    if (s[i] === '(') {
      i++;
      const val = parseExpression();
      skipWs();
      if (s[i] === ')') i++;
      return val;
    }
    if (s[i] === MARCA_FALTANTE) {
      i++;
      return { n: 0, p: 'faltante' };
    }
    if (s[i] === MARCA_DATO) {
      i++;
      let signo = 1;
      if (s[i] === '-') {
        signo = -1;
        i++;
      }
      const inicio = i;
      while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) i++;
      if (i === inicio) return { n: NaN, p: 'dato' };
      return { n: signo * parseFloat(s.slice(inicio, i)), p: 'dato' };
    }
    const start = i;
    while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) i++;
    if (i === start) return { n: NaN, p: 'const' };
    return { n: parseFloat(s.slice(start, i)), p: 'const' };
  };

  let result: Valor;
  try {
    result = parseExpression();
  } catch (e) {
    if (e instanceof DenominadorFaltante) return null;
    throw e;
  }
  skipWs();
  // Trailing unparsed characters → malformed
  if (i !== s.length) return NaN;
  if (result.p === 'faltante') return null;
  return result.n;
}

/**
 * Un número como texto SIN notación exponencial.
 *
 * `String(1e-7)` es `"1e-7"`, y la `e` no pasa la validación de caracteres
 * seguros: la fórmula entera devolvía null. Pasaba con cualquier valor muy
 * pequeño (una tasa invertida, un ratio de microcéntimos) o enorme.
 */
export function numeroSinExponente(v: number): string {
  const s = String(v);
  if (!/e/i.test(s)) return s;
  if (Math.abs(v) < 1) {
    // 20 decimales: por debajo de 1e-20 el valor ya no mueve ninguna cifra que
    // se muestre. Los ceros de cola se recortan para no alargar la expresión.
    return v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }
  // ≥ 1e21: `toFixed` también usa exponente; BigInt da los dígitos enteros.
  return BigInt(Math.round(v)).toString();
}

/**
 * Plataformas de las que dependen columnas de `metricas_diarias` que existen
 * (con DEFAULT 0) aunque el cliente no tenga la integración. Sin la plataforma,
 * su 0 no es «cero ventas» sino «no se mide»: cuenta como faltante. Un valor
 * distinto de 0 se respeta siempre (es un dato, venga de donde venga).
 *
 * `hm_*` NO está: lo pone el cubo de ventas solo cuando existe, y ahí 0 ventas
 * sí es un dato. Tampoco `meta_*`: Meta es la plataforma base de todo cliente.
 */
const PREFIJOS_DE_PLATAFORMA: [string, string][] = [
  ['ventas_', 'hotmart'],
  ['hotmart_', 'hotmart'],
  ['funnel_', 'hotmart'],
  ['ga_', 'ga4'],
  ['tiktok_', 'tiktok'],
];

function plataformaAusente(field: string, availablePlatforms: Set<string> | undefined): boolean {
  if (!availablePlatforms) return false;
  for (const [prefijo, plataforma] of PREFIJOS_DE_PLATAFORMA) {
    if (field.startsWith(prefijo)) return !availablePlatforms.has(plataforma);
  }
  return false;
}

/**
 * Evaluates a formula string against a metric row object.
 * Returns the numeric result or null if calculation isn't possible.
 */
// ── Caché de expansión de fórmulas ──────────────────────────────────────────
//
// La primera mitad de `evaluateFormula` —resolver alias y expandir macros de
// forma recursiva— NO depende de la fila: solo de la fórmula y de los mapas de
// configuración. Sin embargo se ejecutaba una vez por fila y por columna, y
// además reconstruía `{ ...MACRO_MAP, ...customMetrics }` con spread en cada
// llamada. En una tabla de ~2.000 filas × 7 columnas eso son 14.000 expansiones
// recursivas idénticas por render.
//
// La clave no puede ser `JSON.stringify` de los mapas (volveríamos a pagar por
// fila), así que se identifica cada objeto de configuración por identidad, con
// un id perezoso en un WeakMap. Los llamadores pasan las mismas referencias
// durante un render, que es justo el caso que interesa acelerar.

/** Defaults estables: si fuesen `{}` inline, cada llamada crearía un objeto
 *  nuevo, con id nuevo, y el caché no acertaría nunca. */
const MAPA_VACIO: Record<string, string> = Object.freeze({}) as Record<string, string>;
const CONTEXTO_VACIO: Record<string, number> = Object.freeze({}) as Record<string, number>;

let _idSeq = 0;
const _objIds = new WeakMap<object, number>();
function idDeObjeto(o: object | undefined | null): number {
  if (!o) return 0;
  let id = _objIds.get(o);
  if (id === undefined) {
    id = ++_idSeq;
    _objIds.set(o, id);
  }
  return id;
}

const EXPR_CACHE_MAX = 5_000;
const _exprCache = new Map<string, string>();

function expandirExpresion(
  formula: string,
  sourceMapping: Record<string, string>,
  availablePlatforms: Set<string> | undefined,
  customMetrics: Record<string, string>
): string {
  const clave = `${formula}|${idDeObjeto(sourceMapping)}|${idDeObjeto(availablePlatforms)}|${idDeObjeto(customMetrics)}`;
  const cacheado = _exprCache.get(clave);
  if (cacheado !== undefined) return cacheado;

  let expr = availablePlatforms
    ? resolveAliasesWithFallback(formula, sourceMapping, availablePlatforms)
    : resolveAliases(formula, sourceMapping);
  expr = expandFormulaRecursive(expr, { ...MACRO_MAP, ...customMetrics });

  // Techo simple para que un proceso de larga vida (el worker) no acumule.
  if (_exprCache.size >= EXPR_CACHE_MAX) _exprCache.clear();
  _exprCache.set(clave, expr);
  return expr;
}

/** Vacía el caché de expansión. Solo lo necesitan los tests. */
export function limpiarCacheDeFormulas(): void {
  _exprCache.clear();
}

/**
 * Texto que sustituye a un campo en la expresión: su número (sin exponente) o
 * el marcador de faltante.
 *
 * Faltante = el contexto no lo da y la fila lo trae como `null`/no numérico, o
 * es una columna de una plataforma que el cliente no tiene y vale 0. Un campo
 * del catálogo que la fila simplemente NO trae sigue valiendo 0: las filas de
 * un día sin conversiones offline no llevan `offline_*`, y ahí 0 es el dato.
 */
function valorDeCampo(
  field: string,
  row: Record<string, any>,
  context: Record<string, number>,
  availablePlatforms: Set<string> | undefined
): string {
  if (context[field] !== undefined) return MARCA_DATO + numeroSinExponente(context[field]);
  const crudo = row[field];
  if (crudo === undefined) {
    return plataformaAusente(field, availablePlatforms) ? MARCA_FALTANTE : `${MARCA_DATO}0`;
  }
  const n = crudo === null || crudo === '' ? NaN : parseFloat(crudo);
  if (!Number.isFinite(n)) return MARCA_FALTANTE;
  if (n === 0 && plataformaAusente(field, availablePlatforms)) return MARCA_FALTANTE;
  return MARCA_DATO + numeroSinExponente(n);
}

export function evaluateFormula(
  formula: string,
  row: Record<string, any>,
  context: Record<string, number> = CONTEXTO_VACIO,
  sourceMapping: Record<string, string> = MAPA_VACIO,
  availablePlatforms?: Set<string>,
  customMetrics: Record<string, string> = MAPA_VACIO
): number | null {
  if (formula === 'fecha') return null; // fecha is handled separately

  try {
    let expr = expandirExpresion(formula, sourceMapping, availablePlatforms, customMetrics);

    // Replace all known field names with numeric values from the row
    const allFields = { ...FIELD_MAP };

    // Add dynamic meta_custom fields and manual metrics found in the row
    Object.keys(row).forEach((k) => {
      if (
        k !== 'fecha' &&
        k !== 'meta_campaigns' &&
        k !== 'metricas_manuales' &&
        typeof row[k] === 'number'
      ) {
        allFields[k] = k;
      } else if (k.startsWith('meta_custom_')) {
        allFields[k] = k;
      }
    });

    // Add context variables so they can override or provide values for the formula
    Object.keys(context).forEach((k) => {
      allFields[k] = k;
    });

    for (const [field] of Object.entries(allFields)) {
      // Use word boundary-safe replacement to avoid partial matches
      const regex = new RegExp(`\\b${field}\\b`, 'g');
      if (!regex.test(expr)) continue;
      regex.lastIndex = 0;
      expr = expr.replaceAll(regex, valorDeCampo(field, row, context, availablePlatforms));
    }

    // Replace any remaining meta_custom_* identifiers with 0
    // (custom conversions referenced in formulas but absent from the row default to 0)
    expr = expr.replace(/\bmeta_custom_\w+\b/g, `${MARCA_DATO}0`);

    // Only allow safe characters: digits, operators, spaces, parentheses, dots
    // and the value markers (`M` faltante, `D` dato; ver `safeEvalArithmetic`).
    if (!/^[\d\s\+\-\*\/\.\(\)MD]+$/.test(expr)) return null;

    // Evaluate WITHOUT eval/new Function — the production CSP (script-src sin
    // 'unsafe-eval') bloquea new Function y haría que toda métrica calculada
    // devolviera null ("–"). safeEvalArithmetic parsea la expresión saneada.
    const result = safeEvalArithmetic(expr);
    if (result === null || !isFinite(result) || isNaN(result)) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Aggregates a formula over multiple rows by summing numerator and denominator separately.
/**
 * Aggregates a formula over multiple rows.
 * By computing sums of all raw fields first, we ensure that ratios (like CPC = sum(spend)/sum(clicks))
 * are calculated correctly, rather than averaging percentages.
 */
export function aggregateFormula(
  formula: string,
  rows: Record<string, any>[],
  context: Record<string, number> = CONTEXTO_VACIO,
  sourceMapping: Record<string, string> = MAPA_VACIO,
  availablePlatforms?: Set<string>,
  customMetrics: Record<string, string> = MAPA_VACIO
): number | null {
  if (rows.length === 0 && Object.keys(context).length === 0) return null;

  // Accumulate all known fields into a single total row
  const totalRow: Record<string, number | null> = {};

  // Collect all unique fields from FIELD_MAP and all rows (for dynamic custom fields)
  const allKnownFields = new Set(Object.keys(FIELD_MAP));
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (
        k !== 'fecha' &&
        k !== 'meta_campaigns' &&
        k !== 'metricas_manuales' &&
        typeof r[k] === 'number'
      ) {
        allKnownFields.add(k);
      } else if (k.startsWith('meta_custom_')) {
        allKnownFields.add(k);
      }
    });
  });

  for (const field of allKnownFields) {
    // Se suman los valores que hay. Si NINGUNA fila trae un número y alguna lo
    // trae como `null`, el total es `null` (faltante, ver `valorDeCampo`): el
    // rango entero no tiene ese dato, y sumarlo como 0 lo afirmaría.
    let suma = 0;
    let conNumero = false;
    let conNulo = false;
    for (const r of rows) {
      const crudo = r[field];
      if (crudo === undefined) continue;
      const n = crudo === null || crudo === '' ? NaN : parseFloat(crudo);
      if (Number.isFinite(n)) {
        suma += n;
        conNumero = true;
      } else {
        conNulo = true;
      }
    }
    totalRow[field] = !conNumero && conNulo ? null : suma;
  }

  // Sumar no vale para promedios ni extremos: se recalculan sobre sus sumandos.
  reagregarNoAditivas(totalRow, rows);

  // Evaluate the formula once exactly on the aggregated totals
  return evaluateFormula(
    formula,
    totalRow,
    context,
    sourceMapping,
    availablePlatforms,
    customMetrics
  );
}

/**
 * Reescribe en `totalRow` las métricas que NO se pueden sumar entre días.
 *
 * El bucle de arriba suma toda clave numérica, que es correcto para conteos e
 * importes pero no para un promedio (30, 32, 28 → 90 en vez de 30). Los campos
 * de Sheet resuelven esto llevando sus sumandos dentro de la propia fila
 * (`sf_x__num` / `sf_x__den`, o `__min` / `__max`), así que aquí basta con
 * detectarlos por el nombre y recalcular. Igual las columnas de porcentaje de
 * las conversiones offline (`sheet_x__num` / `sheet_x__den`, ponderadas por la
 * cantidad de la fila; ver `agruparOfflinePorFecha`).
 *
 * Hasta el 2026-09-28 `meta_frequency`, `ga_bounce_rate`,
 * `ga_avg_session_duration` y `tasa_calificacion` se quedaban SUMADAS (la
 * frecuencia de 30 días era la suma de 30 frecuencias diarias). Se había dejado
 * así para no mover cifras publicadas; el usuario decidió corregirlas y avisar a
 * los clientes. Ahora se recalculan como en el BI (`bi-query.ts`):
 *
 *   · frecuencia = impresiones ÷ alcance. El alcance sigue siendo la SUMA de los
 *     alcances diarios (las personas únicas del rango no se pueden reconstruir
 *     desde filas diarias), igual que en el BI;
 *   · rebote y duración media = promedio ponderado por `ga_sessions`;
 *   · tasa de calificación = calificados ÷ totales × 100.
 *
 * Sin base (alcance 0, sesiones 0) el valor queda `null`: «—», no 0.
 */
export function reagregarNoAditivas(
  totalRow: Record<string, number | null>,
  rows: Record<string, unknown>[]
): void {
  const esCampoDeSheet = (base: string) => base.startsWith('sf_') || base.startsWith('sv_');
  const esPromedio = (base: string) =>
    esCampoDeSheet(base) || base.startsWith('sheet_') || PROMEDIOS_DE_FILA.has(base);

  for (const clave of Object.keys(totalRow)) {
    // Promedio: Σnumerador / Σdenominador, correcto a cualquier grano.
    if (clave.endsWith('__den')) {
      const base = clave.slice(0, -'__den'.length);
      if (!esPromedio(base)) continue;
      const den = totalRow[clave] ?? 0;
      totalRow[base] = den > 0 ? (totalRow[base + '__num'] ?? 0) / den : 0;
      continue;
    }

    // Extremos: se pliegan sobre las filas, no se suman.
    const esMin = clave.endsWith('__min');
    if (esMin || clave.endsWith('__max')) {
      const base = clave.slice(0, -'__min'.length);
      if (!esCampoDeSheet(base)) continue;
      // Solo las filas que TIENEN el dato: un día sin valor no debe
      // arrastrar el mínimo a 0.
      const vals = rows.map((r) => Number(r[clave])).filter((n) => Number.isFinite(n));
      totalRow[base] = vals.length > 0 ? (esMin ? Math.min(...vals) : Math.max(...vals)) : 0;
    }
  }

  reagregarTasasDeFila(totalRow, rows);
}

/** Número de una celda, o null si no trae uno. */
function numeroDe(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Frecuencia, tasas de GA4 y tasa de calificación sobre un total (ver
 * `reagregarNoAditivas`). Exportada aparte para quien suma filas por su cuenta
 * (la consolidación del ranking) y necesita el mismo recálculo.
 */
export function reagregarTasasDeFila(
  totalRow: Record<string, number | null>,
  rows: Record<string, unknown>[]
): void {
  if ('meta_frequency' in totalRow) {
    const reach = totalRow.meta_reach ?? 0;
    totalRow.meta_frequency = reach > 0 ? (totalRow.meta_impressions ?? 0) / reach : null;
  }

  // Ponderadas por sesiones: se acumula tasa × sesiones de CADA fila; sumar la
  // tasa y multiplicar después daría otro número.
  for (const clave of ['ga_bounce_rate', 'ga_avg_session_duration'] as const) {
    if (!(clave in totalRow)) continue;
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const tasa = numeroDe(r[clave]);
      const sesiones = numeroDe(r.ga_sessions);
      if (tasa === null || sesiones === null || sesiones <= 0) continue;
      num += tasa * sesiones;
      den += sesiones;
    }
    totalRow[clave] = den > 0 ? num / den : null;
  }

  if ('tasa_calificacion' in totalRow) {
    const totales = totalRow.leads_totales ?? 0;
    totalRow.tasa_calificacion =
      totales > 0 ? ((totalRow.leads_calificados ?? 0) / totales) * 100 : null;
  }
}

/**
 * Returns a copy of a metrics row with tiktok_spend/impressions/clicks/conversions
 * derived by summing only the campaigns that match BOTH the given advertiser_id
 * (account scope) AND an optional keyword/group/spec filter (campaign-name scope).
 *
 * Ambos predicados se aplican sobre la misma lista `tiktok_campaigns` antes de
 * sumar, evitando recalcular dos veces. Cuando no hay accountId ni filtro la fila
 * se devuelve sin cambios.
 */
export function filterRowByTikTokAccount(
  row: Record<string, any>,
  accountId: string | undefined,
  filter?: AnyCampaignFilter,
  campaignGroups?: any[]
): Record<string, any> {
  const hasFilter = filter !== undefined && filter !== '';
  if (!accountId && !hasFilter) return row;
  // Sin desglose por campaña no se puede recortar: preservar el tiktok_spend
  // almacenado (ya filtrado por el keyword de la pestaña) en vez de ponerlo en 0
  // — mismo criterio que enrichTikTokRow para filas antiguas sin array.
  if (!Array.isArray(row.tiktok_campaigns)) return row;
  const campaigns: any[] = row.tiktok_campaigns;
  let filtered = accountId ? campaigns.filter((c) => c.account_id === accountId) : campaigns;
  if (hasFilter) filtered = filterCampaignList(filtered, filter, campaignGroups);
  return {
    ...row,
    tiktok_spend: filtered.reduce((s, c) => s + (parseFloat(c.spend ?? 0) || 0), 0),
    tiktok_impressions: filtered.reduce((s, c) => s + (parseInt(c.impressions ?? 0) || 0), 0),
    tiktok_clicks: filtered.reduce((s, c) => s + (parseInt(c.clicks ?? 0) || 0), 0),
    tiktok_conversions: filtered.reduce((s, c) => s + (parseInt(c.conversions ?? 0) || 0), 0),
  };
}

/**
 * Formats a numeric result based on column definition.
 */
export function formatValue(
  value: number | null,
  opts: { prefix?: string; suffix?: string; decimals?: number; moneda?: string | null }
): string {
  if (value === null) return '-';
  let { prefix = '', decimals = 2 } = opts;
  const { suffix = '' } = opts;
  // «$» es el marcador de «importe» del bloque. Con el cliente reportando en
  // otra moneda se pinta su código y sus decimales («CLP 233.487»); en dólares,
  // exactamente igual que siempre. Un prefijo `USD ` (gemelas sin convertir) no
  // se toca.
  //
  // En otra moneda, además, con los separadores del BI (es-AR, «CLP 233.487»,
  // igual que `formatearMoneda`): la misma cifra no debe leerse distinta en un
  // informe y en una pestaña. En dólares no cambia nada.
  const moneda = String(opts.moneda || 'USD').toUpperCase();
  let locale = 'en-US';
  if (prefix === '$' && moneda !== 'USD') {
    prefix = `${moneda} `;
    decimals = decimalesDe(moneda);
    locale = 'es-AR';
  }
  const formatted = value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${prefix}${formatted}${suffix}`;
}
