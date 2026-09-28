// ── Las métricas que se llaman "leads": un solo vocabulario ──────────
//
// El dashboard y los informes cuentan leads desde DOS sistemas distintos, y
// ambos los enseñaban como «Leads» a secas. En Invest Brokers (sep-2026) la
// pestaña decía 141 y el informe 153 para "el mismo mes"; parte era un recorte
// de fechas, pero el resto es que no miden lo mismo:
//
//   | Rótulo                       | Dashboard          | Informe (BI)   | Qué cuenta                               |
//   |------------------------------|--------------------|----------------|------------------------------------------|
//   | Leads Meta (atribuidos)      | `meta_leads_form`  | `leads_form`   | Acción `lead` que Meta atribuye al anuncio |
//   | Leads Meta (todas las acciones) | `meta_leads`    | —              | Máximo de la familia de acciones de lead |
//   | Leads recibidos (contactos)  | `utm_leads`        | `leads_count`  | Filas de `report_utm.lead_events`        |
//
// Meta fecha la conversión según su atribución (7 días clic / 1 día vista) y
// solo cuenta las que atribuye a un anuncio; `lead_events` fecha por el envío
// real. Día a día no cuadran y NO deben sumarse.
//
// Puro y sin dependencias: lo usan el catálogo del dashboard, el tooltip de las
// tarjetas y el glosario del BI. Si cada uno tuviera su texto, volverían a
// divergir.

export const ROTULO_LEADS_META = 'Leads Meta (atribuidos)';
export const ROTULO_LEADS_META_TODAS = 'Leads Meta (todas las acciones)';
export const ROTULO_LEADS_RECIBIDOS = 'Leads recibidos (contactos)';

export const DESCRIPCION_LEADS_META =
  'Conversiones de lead que Meta atribuye a sus anuncios (7 días tras el clic o 1 día tras la vista), con la fecha que asigna Meta. Puede no coincidir con los «Leads recibidos (contactos)»: son otra fuente y los mismos contactos pueden estar en ambas. No las sumes.';

export const DESCRIPCION_LEADS_META_TODAS =
  'Leads que reporta Meta tomando la mayor de sus acciones de lead (píxel, formularios nativos, omni…), con la fecha que asigna Meta. Puede no coincidir con los «Leads recibidos (contactos)».';

export const DESCRIPCION_LEADS_RECIBIDOS =
  'Formularios realmente recibidos (web y formularios de Meta), por fecha de envío. Es el conteo real de contactos: puede no coincidir con los «Leads Meta (atribuidos)», que son otra fuente, y los mismos contactos pueden estar en ambas. No las sumes.';

/** Fórmula del dashboard (alias exacto) → explicación de su fuente. */
const DESCRIPCION_POR_FORMULA: Record<string, string> = {
  meta_leads_form: DESCRIPCION_LEADS_META,
  meta_leads: DESCRIPCION_LEADS_META_TODAS,
  utm_leads: DESCRIPCION_LEADS_RECIBIDOS,
};

/**
 * Explicación de la fuente de una tarjeta del dashboard cuya fórmula es
 * EXACTAMENTE una métrica de leads; `null` para cualquier otra.
 *
 * Solo el alias suelto: en `meta_spend / meta_leads_form` el número ya no es un
 * conteo de leads y el texto confundiría más de lo que aclara.
 */
export function descripcionFuenteLead(formula: string | null | undefined): string | null {
  if (!formula) return null;
  return DESCRIPCION_POR_FORMULA[formula.trim()] ?? null;
}
