// ════════════════════════════════════════════════════════════════
// Atribución de ventas de Hotmart heredando la UTM del lead (puro)
// ════════════════════════════════════════════════════════════════
//
// Una venta sin tupla UTM propia cae en «(sin campaña)» en todos los informes.
// Cuando el comprador pasó antes por un formulario, su lead SÍ trae la tupla:
// se hereda la del ÚLTIMO lead del mismo email (o, si no hay, del mismo
// teléfono) anterior a la compra. Last-touch, porque es lo que hace el resto
// del módulo con los leads.
//
// Reglas, en orden:
//   1. El tracking de Hotmart siempre gana: una venta con campaña o ID de
//      anuncio propios no se toca (la 089 lo garantiza también en la base).
//   2. Los principales van primero. Un bump/upsell/downsell hereda la tupla de
//      SU compra principal (`padre`): es la misma decisión de compra, y así
//      campaña, pedido y añadidos cuentan en el mismo sitio.
//   3. Sin padre con tupla, el añadido busca su propio lead.
//
// La normalización tiene un espejo en SQL (`hotmart_leads_para_atribucion`,
// migración 089): email en minúsculas y sin espacios; teléfono = últimos 9
// dígitos, solo si tiene al menos 8. Si divergen, el cruce falla en silencio.

import type { AtribucionMetodo, VentaHotmart } from './tipos';

export const LOOKBACK_DIAS = 180;
/** Tolerancia de reloj: el lead puede llegar segundos después del checkout. */
const TOLERANCIA_MS = 5 * 60_000;
/** Ventana para emparejar un añadido con su principal cuando falta el padre. */
const VENTANA_PADRE_MS = 30 * 60_000;

export function normalizarEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.includes('@') ? e : null;
}

export function tel9(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = String(v).replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-9) : null;
}

/** Lead candidato, tal como lo devuelve `hotmart_leads_para_atribucion`. */
export type LeadCandidato = {
  id: string;
  created_at: string;
  email_norm: string | null;
  tel9: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
};

/** Lo que la atribución necesita de una venta. `VentaHotmart` lo cumple. */
export type VentaAtribuible = Pick<
  VentaHotmart,
  | 'transaction_id'
  | 'parent_transaction_id'
  | 'es_order_bump'
  | 'tipo'
  | 'comprador_email'
  | 'comprador_telefono'
  | 'orden_at'
  | 'aprobada_at'
  | 'fecha_venta'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_content'
  | 'utm_term'
  | 'utm_id'
  | 'atribucion_metodo'
  | 'atribucion_lead_id'
  | 'atribucion_at'
>;

const CAMPOS_TUPLA = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
] as const;

/** ¿La venta ya trae atribución propia de Hotmart? */
export function esTracking(v: VentaAtribuible): boolean {
  if (v.atribucion_metodo === 'tracking') return true;
  if (v.atribucion_metodo) return false;
  return Boolean(v.utm_campaign || v.utm_id);
}

/** ¿Tiene alguna tupla con campaña (propia o heredada)? */
function tieneTupla(v: VentaAtribuible): boolean {
  return Boolean(v.utm_campaign || v.utm_id);
}

export function esAnadido(v: VentaAtribuible): boolean {
  return (
    v.es_order_bump === true ||
    v.tipo === 'bump' ||
    v.tipo === 'upsell' ||
    v.tipo === 'downsell' ||
    Boolean(v.parent_transaction_id)
  );
}

/** Instante de la compra: orden, si no aprobación, si no el final de su día. */
export function instanteCompra(v: VentaAtribuible): number {
  const iso = v.orden_at ?? v.aprobada_at ?? `${v.fecha_venta}T23:59:59.999-05:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * El último lead anterior a la compra, primero por email y luego por teléfono.
 * `null` si ninguno cae en la ventana.
 */
export function elegirLead(
  venta: VentaAtribuible,
  candidatos: LeadCandidato[],
  lookbackDias = LOOKBACK_DIAS
): { lead: LeadCandidato; metodo: 'lead_email' | 'lead_telefono' } | null {
  const t = instanteCompra(venta);
  const desde = t - lookbackDias * 86_400_000;
  const hasta = t + TOLERANCIA_MS;
  const enVentana = (l: LeadCandidato) => {
    const c = Date.parse(l.created_at);
    return !Number.isNaN(c) && c >= desde && c <= hasta && Boolean(l.utm_campaign || l.utm_id);
  };
  const ultimo = (ls: LeadCandidato[]) =>
    ls.reduce<LeadCandidato | null>(
      (mejor, l) => (!mejor || Date.parse(l.created_at) > Date.parse(mejor.created_at) ? l : mejor),
      null
    );

  const email = normalizarEmail(venta.comprador_email);
  if (email) {
    const l = ultimo(candidatos.filter((c) => c.email_norm === email && enVentana(c)));
    if (l) return { lead: l, metodo: 'lead_email' };
  }
  const tel = tel9(venta.comprador_telefono);
  if (tel) {
    const l = ultimo(candidatos.filter((c) => c.tel9 === tel && enVentana(c)));
    if (l) return { lead: l, metodo: 'lead_telefono' };
  }
  return null;
}

/** Copia la tupla de `fuente` a `venta`, como bloque. Muta. */
function aplicarTupla(
  venta: VentaAtribuible,
  fuente: Pick<LeadCandidato, (typeof CAMPOS_TUPLA)[number]>,
  metodo: AtribucionMetodo,
  leadId: string | null,
  ahoraIso: string
): void {
  for (const c of CAMPOS_TUPLA) venta[c] = fuente[c] ?? null;
  venta.atribucion_metodo = metodo;
  venta.atribucion_lead_id = leadId;
  venta.atribucion_at = ahoraIso;
}

/**
 * Atribuye un lote. Muta las ventas que consigue atribuir y devuelve cuántas.
 *
 * `padresExternos`: principales que no vienen en el lote (un bump sincronizado
 * hoy cuyo principal se guardó ayer). Solo se leen, nunca se modifican.
 */
export function atribuirLotePuro(
  ventas: VentaAtribuible[],
  candidatos: LeadCandidato[],
  padresExternos: VentaAtribuible[] = [],
  ahora: Date = new Date()
): { atribuidas: number; porMetodo: Record<AtribucionMetodo, number> } {
  const ahoraIso = ahora.toISOString();
  const porMetodo: Record<AtribucionMetodo, number> = {
    tracking: 0,
    lead_email: 0,
    lead_telefono: 0,
    padre: 0,
  };
  let atribuidas = 0;

  // Las de tracking se cuentan (ya están atribuidas) y se marcan si no lo
  // estaban: así la 089 sabe que esa tupla no se puede pisar.
  for (const v of ventas) {
    if (esTracking(v)) {
      if (!v.atribucion_metodo) v.atribucion_metodo = 'tracking';
      porMetodo.tracking++;
    }
  }

  const principales = ventas.filter((v) => !esAnadido(v));
  const anadidos = ventas.filter((v) => esAnadido(v));

  for (const v of principales) {
    if (esTracking(v) || v.atribucion_metodo) continue;
    const r = elegirLead(v, candidatos);
    if (!r) continue;
    aplicarTupla(v, r.lead, r.metodo, r.lead.id, ahoraIso);
    porMetodo[r.metodo]++;
    atribuidas++;
  }

  const posiblesPadres = [...principales, ...padresExternos.filter((p) => !esAnadido(p))];
  const porTx = new Map(posiblesPadres.map((p) => [p.transaction_id, p]));

  for (const v of anadidos) {
    if (esTracking(v) || v.atribucion_metodo) continue;

    let padre = v.parent_transaction_id ? porTx.get(v.parent_transaction_id) : undefined;
    if (!padre) {
      // La API no trae `parent_purchase_transaction`: se empareja por
      // comprador y cercanía en el tiempo (el bump se cobra en el mismo
      // checkout que el principal).
      const email = normalizarEmail(v.comprador_email);
      const t = instanteCompra(v);
      if (email) {
        padre = posiblesPadres
          .filter(
            (p) =>
              normalizarEmail(p.comprador_email) === email &&
              Math.abs(instanteCompra(p) - t) <= VENTANA_PADRE_MS
          )
          .sort((a, b) => Math.abs(instanteCompra(a) - t) - Math.abs(instanteCompra(b) - t))[0];
      }
    }

    if (padre && tieneTupla(padre)) {
      aplicarTupla(v, padre, 'padre', padre.atribucion_lead_id ?? null, ahoraIso);
      porMetodo.padre++;
      atribuidas++;
      continue;
    }

    const r = elegirLead(v, candidatos);
    if (!r) continue;
    aplicarTupla(v, r.lead, r.metodo, r.lead.id, ahoraIso);
    porMetodo[r.metodo]++;
    atribuidas++;
  }

  return { atribuidas, porMetodo };
}
