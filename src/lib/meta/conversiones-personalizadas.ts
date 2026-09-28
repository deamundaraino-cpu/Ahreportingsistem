/**
 * Conversiones personalizadas de Meta: vocabulario y reglas puras.
 *
 * Meta reporta dos cosas distintas que aquí se tratan igual:
 *
 *   - Conversión personalizada (CC): una regla creada en Events Manager
 *     («PageView con URL que contiene /gracias»). Llega como
 *     `offsite_conversion.custom.<id>` y SOLO en el array `actions`: el campo
 *     `conversions` no la trae. Leer solo `conversions` (lo de antes) perdía
 *     todas las CC sin avisar — verificado contra la API en 2026-09.
 *   - Evento personalizado del píxel: `fbq('trackCustom', 'LEAD_X')`. Llega como
 *     `offsite_conversion.fb_pixel_custom.LEAD_X` en `conversions`; en `actions`
 *     solo aparece el agregado sin sufijo, que no sirve.
 *
 * La clave estable es el sufijo en minúsculas: es lo que ya guardan los widgets
 * (`metacc:<clave>`) y las fórmulas (`meta_custom_<clave>`), así que no cambia.
 *
 * Sin `server-only` ni Supabase: lo usan el worker, las acciones, los scripts y
 * los tests.
 */

export const PREFIJO_CC = 'offsite_conversion.custom.';
export const PREFIJO_EVENTO = 'offsite_conversion.fb_pixel_custom.';

export type OrigenConversion = 'cc' | 'evento';

export const TIPOS_CONVERSION = ['lead', 'registro', 'agenda', 'compra', 'otro'] as const;
export type TipoConversion = (typeof TIPOS_CONVERSION)[number];

export const ETIQUETA_TIPO: Record<TipoConversion, string> = {
  lead: 'Lead',
  registro: 'Registro',
  agenda: 'Agenda',
  compra: 'Compra',
  otro: 'Otro',
};

/** Días sin actividad a partir de los cuales una conversión se considera antigua. */
export const DIAS_ANTIGUA = 90;

export interface AccionPersonalizada {
  /** Clave estable (sufijo en minúsculas). */
  key: string;
  origen: OrigenConversion;
  /** Sufijo tal cual lo manda Meta (conserva mayúsculas: LEAD_DOCENCIAU). */
  original: string;
}

/** Interpreta un `action_type`. `null` si no es una conversión personalizada. */
export function claveDeAccion(actionType: unknown): AccionPersonalizada | null {
  const t = typeof actionType === 'string' ? actionType : '';
  for (const [prefijo, origen] of [
    [PREFIJO_CC, 'cc'],
    [PREFIJO_EVENTO, 'evento'],
  ] as const) {
    if (!t.startsWith(prefijo)) continue;
    const original = t.slice(prefijo.length).trim();
    if (!original) return null;
    return { key: original.toLowerCase(), origen, original };
  }
  return null;
}

export interface ConversionesExtraidas {
  valores: Record<string, number>;
  nombres: Record<string, { origen: OrigenConversion; original: string }>;
}

function sumarArray(arr: unknown, into: ConversionesExtraidas): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(arr)) return out;
  for (const a of arr) {
    const acc = claveDeAccion(a?.action_type);
    if (!acc) continue;
    const v = Number.parseInt(String(a?.value ?? '0'), 10) || 0;
    // Variantes de mayúsculas del mismo evento: son disparos distintos → suman.
    out[acc.key] = (out[acc.key] ?? 0) + v;
    if (!into.nombres[acc.key])
      into.nombres[acc.key] = { origen: acc.origen, original: acc.original };
  }
  return out;
}

/**
 * Conteos por clave a partir de `actions` y `conversions` de un insight.
 *
 * Entre los dos arrays se toma el MÁXIMO por clave, nunca la suma: si Meta
 * reportara la misma conversión en ambos, es el mismo evento contado dos veces
 * (criterio de `META_ACTION_FAMILIES` en el worker).
 */
export function extraerConversionesPersonalizadas(
  actions: unknown,
  conversions: unknown
): ConversionesExtraidas {
  const res: ConversionesExtraidas = { valores: {}, nombres: {} };
  const a = sumarArray(actions, res);
  const c = sumarArray(conversions, res);
  for (const k of new Set([...Object.keys(a), ...Object.keys(c)])) {
    res.valores[k] = Math.max(a[k] ?? 0, c[k] ?? 0);
  }
  return res;
}

/** Nombre que se muestra: el manual gana; luego el de Meta; luego la clave. */
export function etiquetaEfectiva(c: {
  label_manual?: string | null;
  nombre_meta?: string | null;
  key: string;
}): string {
  const manual = c.label_manual?.trim();
  if (manual) return manual;
  const meta = c.nombre_meta?.trim();
  if (meta) return meta;
  return c.key;
}

const TIPO_POR_EVENTO: Record<string, TipoConversion> = {
  LEAD: 'lead',
  COMPLETE_REGISTRATION: 'registro',
  SCHEDULE: 'agenda',
  PURCHASE: 'compra',
};

/**
 * Tipo sugerido al descubrir una conversión. Solo se usa al insertarla: después
 * lo decide el usuario y el sync no lo toca.
 */
export function inferirTipo(
  customEventType: string | null | undefined,
  nombre: string | null | undefined
): TipoConversion {
  const porEvento = customEventType ? TIPO_POR_EVENTO[customEventType.toUpperCase()] : undefined;
  if (porEvento) return porEvento;
  const n = (nombre ?? '').toLowerCase();
  if (/(compra|purchase|venta|pago|order|upsell)/.test(n)) return 'compra';
  if (/(agenda|reuni|meeting|cita|schedul|llamada)/.test(n)) return 'agenda';
  if (/(registr|inscri|signup|sign_up)/.test(n)) return 'registro';
  if (/lead/.test(n)) return 'lead';
  return 'otro';
}

/** Clave apta para identificadores de fórmula (`[a-z0-9_]`). */
export function claveSaneada(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** ¿La clave sirve tal cual dentro de una fórmula (`meta_custom_<clave>`)? */
export function claveValidaEnFormula(key: string): boolean {
  return /^[a-z0-9_]+$/.test(key);
}

/** Alias para campos calculados del BI: `mcc__<clave saneada>`. */
export const PREFIJO_ALIAS_CC = 'mcc__';
export function aliasFormulaCc(key: string): string {
  return `${PREFIJO_ALIAS_CC}${claveSaneada(key)}`;
}

/**
 * Resuelve la parte `<x>` de un alias `mcc__<x>` a una clave del catálogo:
 * coincidencia exacta primero; si no, la única clave cuya versión saneada
 * coincide. Ambigua o desconocida → `null`.
 */
export function resolverClaveCc(ref: string, claves: readonly string[]): string | null {
  if (claves.includes(ref)) return ref;
  const candidatas = claves.filter((k) => claveSaneada(k) === ref);
  return candidatas.length === 1 ? candidatas[0] : null;
}

/**
 * Eventos del píxel que usa la regla de una CC (`{"event":{"eq":"Lead"}}`).
 * Sirve para avisar de doble conteo al marcar una CC y su evento como resultado.
 */
export function eventosDeRegla(rule: unknown): string[] {
  let r: unknown = rule;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return [];
    }
  }
  const out = new Set<string>();
  const visitar = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visitar);
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === 'event' && v && typeof v === 'object') {
        const eq = (v as Record<string, unknown>).eq;
        if (typeof eq === 'string') out.add(eq);
      } else visitar(v);
    }
  };
  visitar(r);
  return Array.from(out);
}

/**
 * Parejas de conversiones marcadas como resultado que se contarían dos veces:
 * una CC cuya regla se basa en un evento personalizado también marcado.
 */
export function dobleConteo(
  filas: Array<{
    conversion_key: string;
    origen?: string | null;
    regla?: unknown;
    es_resultado?: boolean | null;
    label?: string | null;
  }>
): Array<{ cc: string; evento: string }> {
  const marcadas = filas.filter((f) => f.es_resultado);
  const eventos = new Set(
    marcadas.filter((f) => f.origen === 'evento').map((f) => f.conversion_key)
  );
  const out: Array<{ cc: string; evento: string }> = [];
  for (const f of marcadas) {
    if (f.origen !== 'cc') continue;
    for (const ev of eventosDeRegla(f.regla)) {
      if (eventos.has(ev.toLowerCase()))
        out.push({ cc: f.conversion_key, evento: ev.toLowerCase() });
    }
  }
  return out;
}

/** ¿Tuvo actividad dentro de la ventana de `DIAS_ANTIGUA` días hasta `hoy`? */
export function conversionActiva(
  ultimaActividad: string | null | undefined,
  hoy: string,
  dias = DIAS_ANTIGUA
): boolean {
  if (!ultimaActividad) return false;
  const limite = new Date(`${hoy}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - dias);
  return ultimaActividad >= limite.toISOString().slice(0, 10);
}
