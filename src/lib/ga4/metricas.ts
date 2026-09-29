// ════════════════════════════════════════════════════════════════
// GA4 por campaña: medidas base y derivadas, en UN solo sitio
// ════════════════════════════════════════════════════════════════
//
// El motor del BI emite cada métrica dos veces (en la fila y en `baseValues`
// para los campos calculados) y la tabla recalcula los ratios de su fila Total.
// Con Hotmart eso llegó a dar tasas distintas en cada sitio; aquí la definición
// de cada ratio y de su null vive una vez y la usan los tres.
//
// Sin dependencias: lo prueba `verify-ga4-desglose.ts` sin base de datos.

/** Medidas físicas de `ga4_sesiones_diarias`, ya sumadas para una fila. */
export interface AporteGa4 {
  ga4_sesiones: number;
  ga4_sesiones_interaccion: number;
  ga4_eventos_clave: number;
  ga4_ingresos: number;
}

export const GA4_MEDIDAS = [
  'ga4_sesiones',
  'ga4_sesiones_interaccion',
  'ga4_eventos_clave',
  'ga4_ingresos',
] as const;

export const GA4_DERIVADAS = [
  'ga4_tasa_interaccion',
  'ga4_tasa_rebote',
  'ga4_tasa_evento_clave',
  'ga4_coste_sesion',
  'ga4_coste_evento_clave',
  'ga4_tasa_sesion_lead',
  'ga4_roas',
] as const;

/** Todas las métricas fijas de la fuente `ga4`. */
export const GA4_METRICAS = [...GA4_MEDIDAS, ...GA4_DERIVADAS] as const;

/** Derivadas que necesitan el GASTO como operando. */
export const GA4_CON_GASTO = ['ga4_coste_sesion', 'ga4_coste_evento_clave', 'ga4_roas'] as const;
/** Derivadas que necesitan los LEADS como operando. */
export const GA4_CON_LEADS = ['ga4_tasa_sesion_lead'] as const;

export function aporteVacioGa4(): AporteGa4 {
  return { ga4_sesiones: 0, ga4_sesiones_interaccion: 0, ga4_eventos_clave: 0, ga4_ingresos: 0 };
}

export function sumarAporteGa4(acc: AporteGa4, a: Partial<AporteGa4>): AporteGa4 {
  acc.ga4_sesiones += Number(a.ga4_sesiones ?? 0) || 0;
  acc.ga4_sesiones_interaccion += Number(a.ga4_sesiones_interaccion ?? 0) || 0;
  acc.ga4_eventos_clave += Number(a.ga4_eventos_clave ?? 0) || 0;
  acc.ga4_ingresos += Number(a.ga4_ingresos ?? 0) || 0;
  return acc;
}

export type DerivadasGa4 = Record<(typeof GA4_DERIVADAS)[number], number | null>;

/**
 * Ratios de GA4. Sin denominador el valor es DESCONOCIDO (null), no 0: un 0 se
 * leería como «ninguna sesión interactuó» o «no costó nada». Los porcentajes se
 * emiten en 0-100, como el resto del BI.
 *
 * La tasa de rebote es la de GA4 (1 − sesiones con interacción ÷ sesiones), no
 * la columna antigua `ga_bounce_rate`: se deriva de dos sumas, así que agrega
 * bien por campaña, por fecha y en la fila Total sin ponderar nada.
 */
export function derivadasGa4(a: AporteGa4, gasto: number, leads: number): DerivadasGa4 {
  const s = a.ga4_sesiones;
  return {
    ga4_tasa_interaccion: s > 0 ? (a.ga4_sesiones_interaccion / s) * 100 : null,
    ga4_tasa_rebote: s > 0 ? ((s - a.ga4_sesiones_interaccion) / s) * 100 : null,
    ga4_tasa_evento_clave: s > 0 ? (a.ga4_eventos_clave / s) * 100 : null,
    ga4_coste_sesion: gasto > 0 && s > 0 ? gasto / s : null,
    ga4_coste_evento_clave:
      gasto > 0 && a.ga4_eventos_clave > 0 ? gasto / a.ga4_eventos_clave : null,
    ga4_tasa_sesion_lead: s > 0 ? (leads / s) * 100 : null,
    ga4_roas: gasto > 0 && a.ga4_ingresos > 0 ? a.ga4_ingresos / gasto : null,
  };
}

/** Operandos de cada derivada, para reconstruir la fila Total de una tabla. */
export const BASES_DERIVADAS_GA4: Readonly<Record<(typeof GA4_DERIVADAS)[number], string[]>> = {
  ga4_tasa_interaccion: ['ga4_sesiones', 'ga4_sesiones_interaccion'],
  ga4_tasa_rebote: ['ga4_sesiones', 'ga4_sesiones_interaccion'],
  ga4_tasa_evento_clave: ['ga4_sesiones', 'ga4_eventos_clave'],
  ga4_coste_sesion: ['spend', 'ga4_sesiones'],
  ga4_coste_evento_clave: ['spend', 'ga4_eventos_clave'],
  ga4_tasa_sesion_lead: ['leads_count', 'ga4_sesiones'],
  ga4_roas: ['ga4_ingresos', 'spend'],
};

/** Estado de GA4 de un cliente, lo que el motor necesita para decidir null. */
export interface EstadoGa4Lite {
  /** ¿El cliente tiene una propiedad configurada? */
  configurado: boolean;
  /** ¿El desglose se ha sincronizado alguna vez? */
  sincronizado: boolean;
  cubiertoDesde: string | null;
  cubiertoHasta: string | null;
  moneda: string | null;
  zonaHoraria: string | null;
  umbral: boolean;
  filaOtros: boolean;
  /** Eventos clave conocidos → última fecha con actividad. */
  eventos: Record<string, string>;
  /**
   * Páginas (migración 100): ¿se sincronizaron alguna vez y desde cuándo? Van
   * aparte porque la migración 100 puede no estar aplicada aunque la 097 sí.
   */
  paginasSincronizado?: boolean;
  paginasCubiertoDesde?: string | null;
}

/**
 * ¿Hay que emitir null en vez de números? Sin propiedad o sin una sola
 * sincronización correcta, un 0 diría «no hubo sesiones», que es falso.
 */
export function ga4SinDatos(estado: EstadoGa4Lite | null): boolean {
  return !estado || !estado.configurado || !estado.sincronizado;
}

/** Lo mismo para las tablas por página (landing y vistas). */
export function ga4PaginasSinDatos(estado: EstadoGa4Lite | null): boolean {
  return !estado || !estado.configurado || !estado.paginasSincronizado;
}

/** Métricas de GA4 que solo existen por página (`ga4_landing_diarios` / vistas). */
export const GA4_METRICAS_PAGINA = ['ga4_visitantes', 'ga4_vistas'] as const;
