/** Etiquetas legibles para cada plugin de formulario. */
export const PLUGIN_LABELS: Record<string, string> = {
  elementor: 'Elementor Pro',
  cf7: 'Contact Form 7',
  gravity_forms: 'Gravity Forms',
  wpforms: 'WPForms',
  s2s: 'S2S / Manual',
  meta_lead_ads: 'Meta Lead Ads',
  gohighlevel: 'GoHighLevel (CRM)',
};

/**
 * Etiqueta de cada campo filtrable. Una sola copia: la usan los controles del
 * formulario y los chips de filtros activos, que si no se llamarían distinto.
 */
export const ETIQUETAS_CAMPO: Record<string, string> = {
  utm_source: 'UTM Source',
  utm_medium: 'Medio',
  utm_campaign: 'Campaña',
  utm_content: 'Creativo',
  utm_term: 'Término',
  utm_id: 'UTM ID',
  ip_country: 'País',
  form_name: 'Formulario',
  form_plugin: 'Origen',
  attribution_method: 'Atribución',
  clienteId: 'Cliente',
  q: 'Búsqueda',
  from: 'Desde',
  to: 'Hasta',
};

/** Decodifica percent-encoding solo si el valor todavía viene codificado. */
export function dec(v: string | null | undefined): string {
  if (!v) return '';
  if (!/%[0-9A-Fa-f]{2}/.test(v)) return v;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v;
  }
}
