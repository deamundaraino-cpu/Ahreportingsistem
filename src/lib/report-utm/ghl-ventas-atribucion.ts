// ════════════════════════════════════════════════════════════════
// Ventas de GoHighLevel: atribución, fecha y estado (puro)
// ════════════════════════════════════════════════════════════════
//
// Todo lo que DECIDE algo sobre una venta del CRM vive aquí, sin base de datos
// ni red, para que `scripts/verify-ghl-ventas.ts` lo pruebe entero. La parte que
// lee y escribe está en `ghl-ventas.ts` (webhook) y `ghl-oportunidades.ts`
// (sync de respaldo), que comparten el mismo camino.
//
// ── Modelo de atribución: «último lead antes de la venta» ─────────
// Decisión del usuario (2026-09-28). La venta hereda, COMO BLOQUE, la tupla UTM
// y los IDs de anuncio del último `lead_events` del mismo cliente que sea del
// mismo contacto (external_id `ghl:<contactId>`, mismo email o mismo teléfono)
// y anterior a la venta. Antes se releía el contacto y `deriveUtms` mezclaba
// campo a campo primer y último toque: una venta podía salir con la campaña del
// primer anuncio y el `adId` del último, una combinación que no existió nunca.
//
// Se descartan los leads cuya ÚNICA señal de campaña es una macro sin rellenar
// (`{{campaign.name}}`, `__CID__`): heredar eso deja la venta en «(sin campaña)»
// igual, pero además tapa a un lead anterior que sí la tenía. Un lead sin ninguna
// señal (orgánico) SÍ cuenta: si el último toque fue orgánico, la venta lo es.
//
// Tampoco se filtran los leads `excluido`: la exclusión decide si un lead cuenta
// como captación (un duplicado, un contacto que ya existía), no si ese toque
// ocurrió. El contacto que vuelve por un anuncio y compra es justo el caso.
//
// La normalización de email y teléfono (últimos 9 dígitos) es la de
// `src/lib/hotmart/atribucion.ts`, importada tal cual para que ambos cruces
// fallen o acierten igual.

import { normalizarEmail, tel9 } from '@/lib/hotmart/atribucion';

/** Una venta de CRM puede cerrarse meses después del primer contacto. */
export const LOOKBACK_VENTA_DIAS = 365;
/** Tolerancia de reloj: el lead puede quedar sellado segundos después del cierre. */
export const TOLERANCIA_VENTA_MS = 5 * 60_000;

/** Valor de `sales_events.attribution_method` cuando la tupla viene de un lead. */
export const METODO_VENTA_LEAD = 'lead';

/**
 * Estado de `sales_events` para una venta que dejó de serlo (la oportunidad
 * volvió a abierta, se perdió o se borró). Es el mismo `canceled` que usa
 * Hotmart para un pedido nunca cobrado: el BI solo suma `approved`, así que la
 * venta sale de los totales sin borrarla (queda el rastro).
 */
export const ESTADO_VENTA_REVERTIDA = 'canceled';

export type LeadVentaCandidato = {
  id: string;
  created_at: string;
  external_id: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
  click_id?: string | null;
  /** Migración 082. Ausentes si la base aún no tiene las columnas. */
  campaign_id?: string | null;
  adset_id?: string | null;
  ad_id?: string | null;
};

/** Cómo reconocer al contacto de la venta entre los leads. */
export type ClaveContactoVenta = {
  contactId: string | null;
  email: string | null;
  telefono: string | null;
};

export type ViaCoincidencia = 'contacto' | 'email' | 'telefono';

// ── Macros sin rellenar ───────────────────────────────────────────────

/**
 * ¿El valor es una macro de Meta/TikTok sin sustituir? Mismo patrón que
 * `classifyInvalidUtm` de `campaign-data.ts` (no exportado; se duplica aquí
 * para no acoplar este módulo puro a ese, que importa el cliente de Supabase).
 */
export function esMacroSinRellenar(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  return /\{\{.*?\}\}|\{[a-z0-9_.]+\}|__[A-Z0-9_]+__|%[a-z0-9_]+%/i.test(s);
}

const SENALES_CAMPANA = ['utm_campaign', 'utm_id', 'campaign_id', 'adset_id', 'ad_id'] as const;

/**
 * ¿La única señal de campaña del lead es una macro? `false` si tiene alguna
 * señal real o si no tiene ninguna (orgánico).
 */
export function soloSenalMacro(lead: LeadVentaCandidato): boolean {
  const presentes = SENALES_CAMPANA.map((c) => lead[c]).filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== ''
  );
  return presentes.length > 0 && presentes.every(esMacroSinRellenar);
}

// ── Elección del lead ─────────────────────────────────────────────────

/** ¿Es un lead de este contacto? Devuelve por qué, o null. */
export function coincideConContacto(
  lead: LeadVentaCandidato,
  clave: ClaveContactoVenta
): ViaCoincidencia | null {
  if (clave.contactId && lead.external_id === `ghl:${clave.contactId}`) return 'contacto';
  const email = normalizarEmail(clave.email);
  if (email && normalizarEmail(lead.lead_email) === email) return 'email';
  const tel = tel9(clave.telefono);
  if (tel && tel9(lead.lead_phone) === tel) return 'telefono';
  return null;
}

/**
 * El último lead del contacto anterior a la venta (con la tolerancia de reloj
 * y dentro del lookback), o null. Entre coincidencias por contacto, email o
 * teléfono manda la FECHA, no la vía: es «el último lead», venga de donde venga.
 */
export function elegirUltimoLeadVenta(
  clave: ClaveContactoVenta,
  instanteVentaMs: number,
  candidatos: LeadVentaCandidato[],
  lookbackDias = LOOKBACK_VENTA_DIAS
): { lead: LeadVentaCandidato; via: ViaCoincidencia } | null {
  const hasta = instanteVentaMs + TOLERANCIA_VENTA_MS;
  const desde = instanteVentaMs - lookbackDias * 86_400_000;
  let mejor: { lead: LeadVentaCandidato; via: ViaCoincidencia; t: number } | null = null;
  for (const l of candidatos) {
    const t = Date.parse(l.created_at);
    if (Number.isNaN(t) || t > hasta || t < desde) continue;
    const via = coincideConContacto(l, clave);
    if (!via) continue;
    if (soloSenalMacro(l)) continue;
    if (!mejor || t > mejor.t) mejor = { lead: l, via, t };
  }
  return mejor ? { lead: mejor.lead, via: mejor.via } : null;
}

/** Columnas de `sales_events` que hereda la venta de su lead, como bloque. */
export function atribucionDesdeLead(lead: LeadVentaCandidato): Record<string, string | null> {
  return {
    utm_source: lead.utm_source ?? null,
    utm_medium: lead.utm_medium ?? null,
    utm_campaign: lead.utm_campaign ?? null,
    utm_content: lead.utm_content ?? null,
    utm_term: lead.utm_term ?? null,
    utm_id: lead.utm_id ?? null,
    // En `sales_events` estas columnas existen desde la 012 con otro nombre.
    ad_campaign_id: lead.campaign_id ?? null,
    ad_set_id: lead.adset_id ?? null,
    ad_id: lead.ad_id ?? null,
    click_id: lead.click_id ?? null,
    attribution_method: METODO_VENTA_LEAD,
  };
}

// ── Fecha de la venta ─────────────────────────────────────────────────

/** Lo que puede decir cuándo se cerró la venta (payload u oportunidad releída). */
export type FuenteFechaVenta = {
  lastStatusChangeAt?: string | null;
  lastStageChangeAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  dateAdded?: string | null;
} | null;

function isoValido(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Instante del cierre. Con estado `won`, el último cambio de ESTADO es el paso
 * a ganada; sin estado (el Workflow dispara por etapa), el último cambio de
 * ETAPA es el paso a la etapa de venta. Después, `updatedAt` y la creación.
 * Las fuentes van por prioridad (el payload antes que la oportunidad releída)
 * y, dentro de cada campo, se prueba en todas antes de bajar al siguiente.
 * `null` si nadie trae una fecha válida: quien llama usa la hora de llegada.
 */
export function instanteVentaGhl(
  estado: string | null,
  fuentes: FuenteFechaVenta[]
): string | null {
  const orden: Array<keyof NonNullable<FuenteFechaVenta>> = estado
    ? ['lastStatusChangeAt', 'lastStageChangeAt', 'updatedAt', 'createdAt', 'dateAdded']
    : ['lastStageChangeAt', 'lastStatusChangeAt', 'updatedAt', 'createdAt', 'dateAdded'];
  for (const campo of orden) {
    for (const f of fuentes) {
      const iso = isoValido(f?.[campo]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * `sale_timestamp` definitivo. Un reenvío del webhook (o el sync de respaldo)
 * NUNCA mueve la venta de día: si ya estaba guardada, manda la fecha guardada.
 */
export function saleTimestampEstable(
  existente: string | null | undefined,
  calculado: string | null,
  ahoraIso: string
): string {
  return isoValido(existente) ?? calculado ?? ahoraIso;
}

// ── Estado ────────────────────────────────────────────────────────────

const GANADA = new Set(['won', 'ganada', 'ganado']);
const REVERTIDA = new Set([
  'lost',
  'abandoned',
  'open',
  'perdida',
  'perdido',
  'abandonada',
  'abierta',
]);

/**
 * ¿Es una venta ganada? `won` siempre. Sin estado depende de la integración:
 * un Workflow que ya filtra por etapa no manda estado, y por compatibilidad
 * eso cuenta como venta salvo que `config.ventas_estado_vacio_es_ganada` sea
 * `false`.
 */
export function esVentaGanada(estado: string | null, vacioEsGanada = true): boolean {
  if (!estado) return vacioEsGanada;
  return GANADA.has(estado);
}

/** ¿El estado dice que la oportunidad NO es (o dejó de ser) una venta? */
export function esVentaRevertida(estado: string | null): boolean {
  return Boolean(estado && REVERTIDA.has(estado));
}

/** Lee el flag de la integración. Por defecto `true`, para no romper Workflows existentes. */
export function vacioEsGanadaDe(config: Record<string, unknown> | null | undefined): boolean {
  return (config ?? {}).ventas_estado_vacio_es_ganada !== false;
}

/**
 * Sync de respaldo: ¿hay que revertir una venta guardada al ver el estado
 * ACTUAL de su oportunidad? `estadoActual = null` significa que GHL ya no la
 * tiene (404: borrada).
 *
 *   · `won`                → no.
 *   · `lost` / `abandoned` → sí.
 *   · borrada              → sí.
 *   · `open`               → solo si la venta se registró con estado `won`
 *     explícito. Una venta que entró SIN estado (Workflow por etapa) sigue
 *     `open` en GHL toda su vida: revertirla borraría todas las de ese cliente.
 */
export function debeRevertirPorSync(
  estadoRegistrado: string | null,
  estadoActual: string | null
): boolean {
  if (estadoActual === null) return true;
  const actual = estadoActual.toLowerCase();
  if (GANADA.has(actual)) return false;
  if (actual === 'open' || actual === 'abierta') {
    return Boolean(estadoRegistrado && GANADA.has(estadoRegistrado));
  }
  return REVERTIDA.has(actual);
}
