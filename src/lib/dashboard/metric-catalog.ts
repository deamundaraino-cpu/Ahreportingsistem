/**
 * Catálogo de métricas del dashboard clásico.
 *
 * Vive fuera del componente para poder comprobarlo desde `scripts/` sin montar
 * React: la lista y sus reglas de formato son lógica, no interfaz.
 * `LayoutConfigModal` lo reexporta, así que ningún import existente cambia.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { SheetCampoResumen, SheetVistaResumen } from '@/app/(app)/dashboard/_actions';
import { clavesDeCampo, claveSinRespuesta, claveSegmento } from './lead-answer-aggregation';
import { SUFIJO_NUM, SUFIJO_DEN, SUFIJO_MIN, SUFIJO_MAX } from '@/lib/sheets/campos';

const SUMANDOS_DE_SHEET = [SUFIJO_NUM, SUFIJO_DEN, SUFIJO_MIN, SUFIJO_MAX];

/**
 * ¿Es un sumando interno de un campo de Sheet, y por tanto no una métrica que se
 * pueda elegir?
 *
 * Los campos no aditivos llevan sus sumandos dentro de la fila (`sf_x__num`,
 * `sf_x__den`, `__min`, `__max`) para poder reagregarse a cualquier grano; no son
 * métricas.
 *
 * Se comprueba por PREFIJO y SUFIJO, no por la subcadena `__`. El selector usaba
 * `id.includes('__')` y eso escondía TODAS las métricas por respuesta
 * (`lf__<campo>__<respuesta>`), que son perfectamente elegibles. Además la guarda
 * genérica no protegía de nada: `buildAvailableMetrics` nunca ha emitido los
 * sumandos —construye `sf_<clave>` sin sufijo—, así que su único efecto real era
 * el daño colateral.
 */
export function esSumandoDeSheet(id: string): boolean {
  return (
    (id.startsWith('sf_') || id.startsWith('sv_')) && SUMANDOS_DE_SHEET.some((s) => id.endsWith(s))
  );
}

/** Lo mínimo que necesita el catálogo de una pregunta para ofrecer sus métricas. */
export interface LeadAnswerCampoResumen {
  clave: string;
  nombre: string;
  buckets: string[];
  /**
   * El catálogo no sabe qué respuestas produce esta pregunta: no tiene ningún
   * valor agrupado. Solo se puede ofrecer su `(sin respuesta)`… que sin las
   * demás sería el complemento de un conjunto invisible, así que no se ofrece
   * nada y la UI explica cómo arreglarlo. Se descubre añadiendo un bloque de
   * respuestas, o agrupando los valores en Report-UTM.
   */
  sinBuckets?: boolean;
  /**
   * Segmentos definidos sobre esta pregunta («Desde 2M»). Se ofrecen como
   * métrica INCLUSO si `sinBuckets`: un segmento lleva su propia lista de
   * buckets, que es exactamente lo que al catálogo le falta en ese caso.
   */
  segmentos?: { clave: string; nombre: string }[];
}

/**
 * Una métrica ofrecible en un selector. `format` solo lo traen las que lo
 * declaran (hoy, los campos de Sheet): sirve para prerrellenar el tipo del
 * bloque al insertarla.
 */
export interface MetricOption {
  id: string;
  label: string;
  format?: MetricType;
}

// ─── Available Metrics for Dropdown ──────────────────────────────────────────

export const AVAILABLE_METRICS: MetricOption[] = [
  // ── Meta · Entrega ────────────────────────────────────────────────────────
  { id: 'meta_spend', label: 'Meta: Gasto' },
  { id: 'meta_impressions', label: 'Meta: Impresiones' },
  { id: 'meta_reach', label: 'Meta: Alcance' },
  { id: 'meta_frequency', label: 'Meta: Frecuencia' },
  { id: 'meta_clicks', label: 'Meta: Clics (Todos)' },
  { id: 'meta_link_clicks', label: 'Meta: Clics en el enlace' },

  // ── Meta · Costos y Tasas ─────────────────────────────────────────────────
  { id: 'meta_cpm', label: 'Meta: CPM' },
  { id: 'meta_cpc', label: 'Meta: CPC (Todos)' },
  { id: 'meta_cpc_link', label: 'Meta: CPC (Enlace)' },
  { id: 'meta_ctr', label: 'Meta: CTR (Todos)' },
  { id: 'meta_ctr_link', label: 'Meta: CTR (Enlace)' },

  // ── Meta · Leads y Registro ───────────────────────────────────────────────
  { id: 'meta_leads', label: 'Meta: Leads (Pixel)' },
  { id: 'meta_cpl', label: 'Meta: Costo por Lead Pixel (CPL)' },
  { id: 'meta_leads_form', label: 'Meta: Clientes potenciales (Formulario)' },
  { id: 'meta_cpl_form', label: 'Meta: Costo por Lead Formulario' },
  { id: 'meta_complete_registration', label: 'Meta: Registros completados' },
  { id: 'meta_cost_per_complete_registration', label: 'Meta: Costo por Registro' },
  { id: 'meta_submit_application', label: 'Meta: Solicitudes enviadas' },
  { id: 'meta_start_trial', label: 'Meta: Trials iniciados' },
  { id: 'meta_subscribe', label: 'Meta: Suscripciones' },

  // ── Meta · Compras y Carrito ──────────────────────────────────────────────
  { id: 'meta_purchases', label: 'Meta: Compras' },
  { id: 'meta_cpp', label: 'Meta: Costo por Compra (CPP)' },
  { id: 'meta_roas', label: 'Meta: ROAS (solo inversión Meta)' },
  { id: 'meta_adds_to_cart', label: 'Meta: Añadir al carrito' },
  { id: 'meta_cost_per_add_to_cart', label: 'Meta: Costo por Add to Cart' },
  { id: 'meta_initiates_checkout', label: 'Meta: Inicio de pago (Checkout)' },
  { id: 'meta_cost_per_initiate_checkout', label: 'Meta: Costo por Checkout' },

  // ── Meta · Contenido y Navegación ────────────────────────────────────────
  { id: 'meta_landing_page_views', label: 'Meta: Vistas de Landing Page' },
  { id: 'meta_cost_per_landing_page_view', label: 'Meta: Costo por Vista LP' },
  { id: 'meta_view_content', label: 'Meta: Ver contenido (ViewContent)' },
  { id: 'meta_cost_per_view_content', label: 'Meta: Costo por ViewContent' },
  { id: 'meta_search', label: 'Meta: Búsquedas (Search)' },
  { id: 'meta_add_to_wishlist', label: 'Meta: Lista de deseos' },
  { id: 'meta_customize_product', label: 'Meta: Personalizar producto' },

  // ── Meta · Acciones locales y contacto ────────────────────────────────────
  { id: 'meta_contact', label: 'Meta: Contactos' },
  { id: 'meta_cost_per_contact', label: 'Meta: Costo por Contacto' },
  { id: 'meta_schedule', label: 'Meta: Citas agendadas' },
  { id: 'meta_cost_per_schedule', label: 'Meta: Costo por Cita' },
  { id: 'meta_find_location', label: 'Meta: Encontrar ubicación' },
  { id: 'meta_donate', label: 'Meta: Donaciones' },

  // ── Meta · Video ──────────────────────────────────────────────────────────
  { id: 'meta_video_views', label: 'Meta: Vistas de video' },
  { id: 'meta_video_3s_views', label: 'Meta: Vistas 3 segundos' },
  { id: 'meta_video_thruplay', label: 'Meta: ThruPlay' },
  { id: 'meta_cost_per_thruplay', label: 'Meta: Costo por ThruPlay' },

  // ── Meta · Engagement ─────────────────────────────────────────────────────
  { id: 'meta_page_engagement', label: 'Meta: Engagement de página' },
  { id: 'meta_post_engagement', label: 'Meta: Engagement de publicación' },
  { id: 'meta_post_reactions', label: 'Meta: Reacciones' },
  { id: 'meta_post_shares', label: 'Meta: Compartidos' },
  { id: 'meta_post_saves', label: 'Meta: Guardados' },
  { id: 'meta_post_comments', label: 'Meta: Comentarios' },

  // ── Meta · Mensajería ─────────────────────────────────────────────────────
  { id: 'meta_messaging_conversations_started', label: 'Meta: Conversaciones iniciadas' },
  { id: 'meta_cost_per_messaging_conversation', label: 'Meta: Costo por Conversación' },

  // ── Meta · Resultado de objetivo ─────────────────────────────────────────
  { id: 'meta_results', label: 'Meta: Resultados' },
  { id: 'meta_cost_per_result', label: 'Meta: Costo por Resultado' },

  // ── Hotmart ───────────────────────────────────────────────────────────────
  // `hotmart_clics_link` se retiró: estaba aquí y en el motor de fórmulas, pero
  // nunca tuvo columna ni escritor. Solo podía mostrar 0.
  { id: 'hotmart_pagos_iniciados', label: 'Hotmart: Pagos Iniciados' },

  // ── Ventas · Totales globales ─────────────────────────────────────────────
  { id: 'ventas_principal', label: 'Ventas: Neto Principal' },
  { id: 'ventas_bump', label: 'Ventas: Neto Bump' },
  { id: 'ventas_upsell', label: 'Ventas: Neto Upsell' },
  { id: 'ventas_downsell', label: 'Ventas: Neto Downsell' },
  { id: 'ventas_principal_bruto', label: 'Ventas: Bruto Principal' },
  { id: 'ventas_bump_bruto', label: 'Ventas: Bruto Bump' },
  { id: 'ventas_upsell_bruto', label: 'Ventas: Bruto Upsell' },
  { id: 'ventas_downsell_bruto', label: 'Ventas: Bruto Downsell' },
  { id: 'ventas_principal_count', label: 'Ventas: # Compras Principal' },
  { id: 'ventas_bump_count', label: 'Ventas: # Compras Bump' },
  { id: 'ventas_upsell_count', label: 'Ventas: # Compras Upsell' },
  { id: 'ventas_downsell_count', label: 'Ventas: # Compras Downsell' },
  { id: 'ventas_reembolsado', label: 'Ventas: Reembolsado' },
  { id: 'ventas_reembolsado_count', label: 'Ventas: # Reembolsos' },
  { id: 'total_facturacion_bruta', label: 'Ventas: Facturación Bruta Total' },
  { id: 'total_facturacion_neta', label: 'Ventas: Facturación Neta Total' },
  { id: 'total_facturacion_neta_real', label: 'Ventas: Facturación Neta Real (tras reembolsos)' },
  { id: 'total_tasa_reembolso', label: 'Ventas: Tasa de Reembolso', format: 'percent' },
  { id: 'total_spend', label: 'Ventas: Inversión Total (Meta + TikTok)' },
  { id: 'total_roas', label: 'Ventas: ROAS Total (Meta + TikTok)' },
  { id: 'total_roi', label: 'Ventas: ROI Total' },
  { id: 'total_dinero_bolsa', label: 'Ventas: Dinero en Bolsa Total' },
  { id: 'total_costo_compra', label: 'Ventas: Costo/Compra Total' },

  // ── Funnel Hotmart · Métricas por pestaña ─────────────────────────────────
  { id: 'funnel_principal_count', label: 'Funnel: # Compras Principal' },
  { id: 'funnel_principal_neto', label: 'Funnel: Neto Principal' },
  { id: 'funnel_principal_bruto', label: 'Funnel: Bruto Principal (API)' },
  { id: 'funnel_principal_price', label: 'Funnel: Precio Público Principal' },
  { id: 'funnel_bump_count', label: 'Funnel: # Order Bumps' },
  { id: 'funnel_bump_neto', label: 'Funnel: Neto Order Bump' },
  { id: 'funnel_bump_bruto', label: 'Funnel: Bruto Order Bump' },
  { id: 'funnel_upsell_count', label: 'Funnel: # Upsells' },
  { id: 'funnel_upsell_neto', label: 'Funnel: Neto Upsell' },
  { id: 'funnel_upsell_bruto', label: 'Funnel: Bruto Upsell' },
  { id: 'funnel_upsell_visits', label: 'Funnel: Visitas Pág. Upsell' },
  { id: 'funnel_downsell_count', label: 'Funnel: # Downsells' },
  { id: 'funnel_downsell_neto', label: 'Funnel: Neto Downsell' },
  { id: 'funnel_downsell_bruto', label: 'Funnel: Bruto Downsell' },
  { id: 'funnel_pagos_iniciados', label: 'Funnel: Pagos Iniciados (GA4)' },
  { id: 'funnel_facturacion_bruta', label: 'Funnel: Facturación Bruta' },
  { id: 'funnel_facturacion_neta', label: 'Funnel: Facturación Neta' },
  { id: 'funnel_roas', label: 'Funnel: ROAS' },
  { id: 'funnel_roi', label: 'Funnel: ROI' },
  { id: 'funnel_dinero_bolsa', label: 'Funnel: Dinero en Bolsa' },
  { id: 'funnel_costo_compra', label: 'Funnel: Costo/Compra' },
  { id: 'funnel_costo_visita', label: 'Funnel: Costo/Visita' },
  { id: 'funnel_costo_pago', label: 'Funnel: Costo/Pago Iniciado' },
  { id: 'funnel_pct_conversion', label: 'Funnel: % Conversión General' },
  { id: 'funnel_pct_clics_visitas', label: 'Funnel: % Clics→Visitas' },
  { id: 'funnel_pct_visitas_pagos', label: 'Funnel: % Visitas→Pagos' },
  { id: 'funnel_pct_pagos_compras', label: 'Funnel: % Pagos→Compras' },
  { id: 'funnel_pct_conv_order', label: 'Funnel: % Conv. Order Bump' },
  { id: 'funnel_pct_conv_upsell', label: 'Funnel: % Conv. Upsell' },
  { id: 'funnel_pct_conv_downsell', label: 'Funnel: % Conv. Downsell' },

  // ── Google Analytics 4 ────────────────────────────────────────────────────
  { id: 'ga_sessions', label: 'GA4: Sesiones' },
  { id: 'ga_bounce_rate', label: 'GA4: Tasa de Rebote' },
  { id: 'ga_avg_session_duration', label: 'GA4: Duración Media Sesión' },

  // ── TikTok Ads ────────────────────────────────────────────────────────────
  { id: 'tiktok_spend', label: 'TikTok: Gasto' },
  { id: 'tiktok_impressions', label: 'TikTok: Impresiones' },
  { id: 'tiktok_clicks', label: 'TikTok: Clics' },
  { id: 'tiktok_conversions', label: 'TikTok: Conversiones' },
  { id: 'tiktok_cpc', label: 'TikTok: CPC' },
  { id: 'tiktok_cpm', label: 'TikTok: CPM' },
  { id: 'tiktok_ctr', label: 'TikTok: CTR (%)' },
  { id: 'tiktok_cpa', label: 'TikTok: CPA' },

  // ── Manual ────────────────────────────────────────────────────────────────
  { id: 'leads_registrados', label: 'Leads Registrados (Manual)' },

  // ── Google Sheets · Leads ─────────────────────────────────────────────────
  { id: 'leads_totales', label: 'GSheets: Leads Totales' },
  { id: 'leads_calificados', label: 'GSheets: Leads Calificados' },
  { id: 'leads_no_calificados', label: 'GSheets: Leads No Calificados' },
  { id: 'tasa_calificacion', label: 'GSheets: Tasa de Calificación (%)' },

  // ── Report-UTM ────────────────────────────────────────────────────────────
  // Contactos reales del formulario (web + Meta Lead Ads unificados), no lo
  // que reporta el píxel. NO se suma con `meta_leads`: miden lo mismo desde
  // fuentes distintas y un lead puede estar en las dos.
  { id: 'utm_leads', label: 'UTM Report: Leads (contactos)' },
];

/** Build dynamic metric list merging static + catalog custom conversions */
/**
 * Métricas offline que DIVIDEN por `offline_ventas`.
 *
 * Si el Sheet no marca ninguna fila como `tipo = 'venta'` —lo habitual, porque
 * la configuración recomendada es «Tipo fijo → Todas son leads»— el divisor es
 * 0 permanente: la fórmula da Infinity, `evaluateFormula` devuelve null y la
 * tarjeta pinta «–». Ofrecerlas en el selector solo lleva a montar métricas que
 * nunca mostrarán un número, así que se ocultan hasta que haya ventas offline.
 */
const METRICAS_OFFLINE_POR_VENTA = new Set(['offline_cpa', 'offline_close_rate', 'offline_roas']);

/**
 * ¿Hay alguna conversión offline registrada como venta?
 *
 * Alimenta el `hayVentasOffline` de `buildAvailableMetrics`. El sync guarda el
 * tipo ya en minúsculas, pero se normaliza igual: sale de una hoja de cálculo.
 */
export function tieneVentasOffline(
  conversionesOfflineRaw: { tipo?: string | null }[] = []
): boolean {
  return conversionesOfflineRaw.some(
    (r) =>
      String(r?.tipo ?? '')
        .toLowerCase()
        .trim() === 'venta'
  );
}

export function buildAvailableMetrics(
  conversionesCatalogo: { conversion_key: string; label: string; field_id: string }[] = [],
  googleSheetsConversiones?: any[],
  sheetCampos: SheetCampoResumen[] = [],
  sheetVistas: SheetVistaResumen[] = [],
  /** ¿El cliente tiene alguna conversión offline con `tipo = 'venta'`? */
  hayVentasOffline = true,
  /**
   * Preguntas de formulario del cliente (`data.leadAnswers.campos`). Cada una
   * aporta una métrica por respuesta más su «(sin respuesta)», de modo que el
   * trafficker pueda usarlas en cualquier tarjeta, gráfica o columna y no solo
   * dentro del bloque de respuestas.
   */
  leadAnswerCampos: LeadAnswerCampoResumen[] = []
): MetricOption[] {
  const dynamic = (conversionesCatalogo || []).map((c) => ({
    id: c.field_id,
    label: `Meta: ${c.label}`,
  }));

  const offlineMetrics = [
    { id: 'offline_leads', label: 'Offline: Leads' },
    { id: 'offline_ventas', label: 'Offline: Ventas' },
    { id: 'offline_revenue', label: 'Offline: Revenue' },
    { id: 'offline_total', label: 'Offline: Total' },
    { id: 'offline_cpa', label: 'Offline: CPA Real' },
    { id: 'offline_close_rate', label: 'Offline: Close Rate (%)' },
    { id: 'offline_roas', label: 'Offline: ROAS Real' },
    { id: 'total_leads', label: 'Offline: Leads Totales' },
    { id: 'total_cpl', label: 'Offline: CPL Real' },
  ].filter((m) => hayVentasOffline || !METRICAS_OFFLINE_POR_VENTA.has(m.id));

  // Columnas adicionales de los Sheets. Se recorren TAMBIÉN las de cada pestaña:
  // la UI actual las escribe en `tabs[].custom_columns` y aquí solo se miraba el
  // `custom_columns` plano del formato anterior, así que las columnas de
  // cualquier config nueva no llegaban a aparecer en el selector.
  const sheetCustomMetrics: { id: string; label: string }[] = [];
  const vistas = new Set<string>();
  const absorbCols = (cols: Record<string, any> | undefined) => {
    for (const [sanitized, col] of Object.entries(cols ?? {})) {
      if (!col?.include || col.type === 'date' || col.type === 'text') continue;
      const id = `sheet_${sanitized}`;
      if (vistas.has(id)) continue;
      vistas.add(id);
      sheetCustomMetrics.push({ id, label: `GSheets: ${col.label || sanitized}` });
    }
  };
  if (Array.isArray(googleSheetsConversiones)) {
    for (const config of googleSheetsConversiones) {
      if (!config?.enabled) continue;
      absorbCols(config.custom_columns);
      for (const tab of config.tabs ?? []) {
        if (tab?.enabled === false) continue;
        absorbCols(tab.custom_columns);
      }
    }
  }

  // Campos de Sheet (módulo de campos): el nombre que puso el analista es el
  // que se ve, y la clave plana `sf_`/`sv_` es la variable de las fórmulas.
  // Son las únicas métricas que declaran su formato, así que al insertarlas se
  // puede prerrellenar el $ o el % en vez de dejarlo a la memoria.
  const formatos = buildMetricFormats(sheetCampos, sheetVistas);
  const camposMetrics = sheetCampos.map((c) => ({
    id: `sf_${c.clave}`,
    label: c.nombre,
    format: formatos[`sf_${c.clave}`],
  }));
  const vistasMetrics = sheetVistas.map((v) => ({
    id: `sv_${v.clave}`,
    label: v.nombre,
    format: formatos[`sv_${v.clave}`],
  }));

  // Respuestas de formulario (Report-UTM). Una métrica por respuesta, más el
  // «(sin respuesta)» que hace que la suma cierre con `utm_leads`.
  const respuestasMetrics: MetricOption[] = [];
  for (const campo of leadAnswerCampos) {
    // Un SEGMENTO sí se ofrece aunque el campo salga `sinBuckets`: lleva su
    // propia lista de buckets, que es justo lo que le falta al catálogo.
    for (const seg of campo.segmentos ?? []) {
      respuestasMetrics.push({
        id: claveSegmento(seg),
        label: `${campo.nombre}: ${seg.nombre}`,
      });
    }
    // Un campo del que no se conocen los buckets no aporta nada elegible:
    // ofrecer solo su `(sin respuesta)` sería ofrecer el complemento de un
    // conjunto que el analista no puede ver.
    if (campo.sinBuckets || campo.buckets.length === 0) continue;
    for (const { bucket, clave } of clavesDeCampo(campo)) {
      respuestasMetrics.push({ id: clave, label: `${campo.nombre}: ${bucket}` });
    }
    respuestasMetrics.push({
      id: claveSinRespuesta(campo),
      label: `${campo.nombre}: (sin respuesta)`,
    });
  }

  const existing = new Set(AVAILABLE_METRICS.map((m) => m.id));
  const extras = [
    ...dynamic,
    ...offlineMetrics,
    ...sheetCustomMetrics,
    ...camposMetrics,
    ...vistasMetrics,
    ...respuestasMetrics,
  ].filter((d) => !existing.has(d.id));

  return [...AVAILABLE_METRICS, ...extras];
}
// ─── Metric Type Selector ─────────────────────────────────────────────────────

export type MetricType = 'number' | 'currency' | 'percent';

export function getMetricType(prefix?: string, suffix?: string): MetricType {
  if (suffix === '%') return 'percent';
  if (prefix === '$') return 'currency';
  return 'number';
}

/** Traduce el tipo elegido a los `prefix`/`suffix`/`decimals` que guarda el bloque. */
export function applyMetricType(type: MetricType): {
  prefix: string;
  suffix: string;
  decimals: number;
} {
  if (type === 'currency') return { prefix: '$', suffix: '', decimals: 2 };
  if (type === 'percent') return { prefix: '', suffix: '%', decimals: 2 };
  return { prefix: '', suffix: '', decimals: 0 };
}

// ─── Formato declarado por métrica ────────────────────────────────────────────

export type MetricFormatMap = Record<string, MetricType>;

/**
 * Formato que le corresponde a cada métrica según su definición.
 *
 * Hoy solo lo declaran los campos de Sheet; el resto del catálogo no lleva
 * formato y lo elige el analista a mano. Sirve para prerrellenar el selector al
 * insertar la métrica, de modo que un campo de moneda salga con `$` sin tener
 * que acordarse.
 *
 * Misma regla que `sheetFieldFormat` en el BI, para que los dos no diverjan:
 * un conteo de filas es un número aunque la columna sea de dinero.
 */
export function buildMetricFormats(
  sheetCampos: SheetCampoResumen[] = [],
  sheetVistas: SheetVistaResumen[] = []
): MetricFormatMap {
  const out: MetricFormatMap = {};
  const formatoDe = (agregacion: string, formato: string): MetricType => {
    if (agregacion === 'count') return 'number';
    if (formato === 'currency') return 'currency';
    if (formato === 'percent') return 'percent';
    return 'number';
  };
  for (const c of sheetCampos) out[`sf_${c.clave}`] = formatoDe(c.agregacion, c.formato);
  for (const v of sheetVistas) out[`sv_${v.clave}`] = formatoDe(v.agregacion, v.formato);
  return out;
}
