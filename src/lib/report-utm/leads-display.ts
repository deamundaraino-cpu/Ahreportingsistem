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
