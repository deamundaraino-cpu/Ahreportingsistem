import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchContactById } from './ghl-client';
import {
  credencialesDe,
  deriveUtms,
  idsDeContacto,
  normalizeContactFields,
  type GhlIntegrationRow,
} from './ghl-leads';
import { monedaDeClienteUtm } from '@/lib/moneda-reporte';

/**
 * Ventas del CRM de GoHighLevel → `report_utm.sales_events`.
 *
 * Los clientes que venden por asesoría (Cris Tributario) cierran en el embudo de
 * GHL, no en una pasarela. Hasta el 2026-09-12 esa venta había que cargarla a
 * mano en el dashboard, y `sales_events` estaba vacía en producción, así que el
 * ROAS, el CPA y la tasa de conversión de esos clientes salían en blanco.
 *
 * El Workflow de GHL («Opportunity Status Changed → Won», o el cambio a la etapa
 * que el cliente use como venta) dispara un webhook. Igual que el de contactos,
 * el payload es un AVISO: se relee el contacto con el PIT para que la venta
 * lleve la MISMA atribución (UTMs, `utm_id`) que su lead, y así cruce con la
 * campaña que lo trajo.
 */

type Db = ReturnType<SupabaseClient['schema']>;

/** Prefijo de `platform_sale_id`: una oportunidad = una venta, aunque GHL reenvíe. */
export const GHL_VENTA_PREFIX = 'ghl-opp:';
export const GHL_PLATFORM = 'gohighlevel';

export type GhlVentaPayload = {
  contact_id?: string;
  contactId?: string;
  contact?: { id?: string };
  opportunity_id?: string;
  opportunityId?: string;
  opportunity?: {
    id?: string;
    name?: string;
    status?: string;
    monetary_value?: number | string;
    monetaryValue?: number | string;
    pipeline_stage?: string;
  };
  id?: string;
  status?: string;
  opportunity_status?: string;
  monetary_value?: number | string;
  monetaryValue?: number | string;
  lead_value?: number | string;
  opportunity_name?: string;
  pipeline_name?: string;
  pipeline_stage?: string;
  pipleline_stage?: string; // así lo escribe GHL en algunos Workflows
  location?: { id?: string };
  locationId?: string;
};

function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Importe escrito a mano en el CRM, en cualquier formato razonable.
 *
 * En pesos chilenos lo normal es «1.500.000»; en dólares, «1,500.50» o «1500.5».
 * Regla: si hay punto y coma, el ÚLTIMO es el decimal. Si hay un solo tipo de
 * separador, es de miles cuando se repite o cuando lleva exactamente 3 dígitos
 * detrás («1.500» = 1500); si no, es decimal («1500,5» = 1500.5).
 */
export function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const punto = s.lastIndexOf('.');
  const coma = s.lastIndexOf(',');
  if (punto >= 0 && coma >= 0) {
    const dec = punto > coma ? '.' : ',';
    const mil = dec === '.' ? ',' : '.';
    s = s.split(mil).join('').replace(dec, '.');
  } else if (punto >= 0 || coma >= 0) {
    const partes = s.split(punto >= 0 ? '.' : ',');
    const esMiles = partes.length > 2 || partes[partes.length - 1].length === 3;
    s = esMiles ? partes.join('') : partes.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Datos de la venta según cómo lo haya montado el Workflow. Puro. */
export function leerVentaGhl(p: GhlVentaPayload): {
  contactId: string | null;
  oportunidadId: string | null;
  importe: number | null;
  estado: string | null;
  nombre: string | null;
} {
  const o = p.opportunity ?? {};
  return {
    contactId: txt(p.contact_id ?? p.contactId ?? p.contact?.id),
    oportunidadId: txt(p.opportunity_id ?? p.opportunityId ?? o.id ?? p.id),
    importe: numero(
      o.monetary_value ?? o.monetaryValue ?? p.monetary_value ?? p.monetaryValue ?? p.lead_value
    ),
    estado: txt(o.status ?? p.status ?? p.opportunity_status)?.toLowerCase() ?? null,
    nombre: txt(
      o.name ?? p.opportunity_name ?? p.pipeline_stage ?? p.pipleline_stage ?? p.pipeline_name
    ),
  };
}

/**
 * ¿Es una venta ganada? Un Workflow puede dispararse en cualquier cambio de
 * estado; solo `won` (o sin estado, si el Workflow ya filtra por etapa) cuenta.
 * `lost` / `abandoned` / `open` NO son ventas.
 */
export function esVentaGanada(estado: string | null): boolean {
  if (!estado) return true;
  return estado === 'won' || estado === 'ganada' || estado === 'ganado';
}

export type ResultadoVentaGhl = { guardada: boolean; motivo?: string; id?: string };

/**
 * Registra (o actualiza) la venta de una oportunidad. Idempotente por
 * `(cliente_id, platform, platform_sale_id)`: el reenvío de GHL no la duplica.
 */
export async function registrarVentaGhl(
  supabase: SupabaseClient,
  integration: GhlIntegrationRow,
  payload: GhlVentaPayload
): Promise<ResultadoVentaGhl> {
  const venta = leerVentaGhl(payload);
  if (!venta.oportunidadId && !venta.contactId) {
    return { guardada: false, motivo: 'El webhook debe incluir opportunity_id o contact_id.' };
  }
  if (!esVentaGanada(venta.estado)) {
    return { guardada: false, motivo: `La oportunidad está en «${venta.estado}», no ganada.` };
  }

  const db: Db = supabase.schema('report_utm');
  const clienteId = integration.cliente_id;

  // Atribución: la del CONTACTO, releído con el PIT. Sin contacto la venta se
  // guarda igual (cuenta en totales), pero sin campaña.
  let utms: Record<string, unknown> = {};
  let cliente: Record<string, unknown> = {};
  if (venta.contactId) {
    const { cred } = credencialesDe(integration);
    if (cred) {
      const contacto = await fetchContactById(venta.contactId, cred).catch(() => null);
      if (contacto) {
        const u = deriveUtms(contacto);
        const ids = idsDeContacto(contacto);
        utms = {
          utm_source: u.utm_source,
          utm_medium: u.utm_medium,
          utm_campaign: u.utm_campaign,
          utm_content: u.utm_content,
          utm_term: u.utm_term,
          utm_id: u.utm_id,
          // Columnas de la migración 012 que nadie escribía: con ellas la venta
          // cruza por ID con el mismo anuncio que trajo al lead.
          ad_campaign_id: ids.campaign_id,
          ad_set_id: ids.adset_id,
          ad_id: ids.ad_id,
          click_id: u.click_id,
          attribution_method: u.attribution_method,
          attribution_resolved_at: new Date().toISOString(),
        };
        const c = normalizeContactFields(contacto, new Map());
        cliente = {
          customer_name: c.lead_name,
          customer_email: c.lead_email,
          customer_phone: c.lead_phone,
          customer_country: txt(contacto.country),
          customer_id: `ghl:${contacto.id}`,
        };
      }
    }
  }

  const moneda = await monedaDeClienteUtm(supabase, clienteId);
  const ahora = new Date().toISOString();
  const fila = {
    cliente_id: clienteId,
    platform: GHL_PLATFORM,
    platform_sale_id: `${GHL_VENTA_PREFIX}${venta.oportunidadId ?? `contacto:${venta.contactId}`}`,
    // Sin importe en la oportunidad la venta cuenta como unidad con valor 0:
    // «una venta cerrada» es el dato que el PM pidió, el valor es un extra.
    amount: venta.importe ?? 0,
    // El importe de la oportunidad lo escribe el cliente en su CRM, en su moneda.
    currency: moneda,
    status: 'approved',
    product_name: venta.nombre ?? 'Venta CRM',
    transaction_type: 'principal',
    sale_timestamp: ahora,
    received_at: ahora,
    processed_at: ahora,
    raw_payload: payload as unknown as Record<string, unknown>,
    ...utms,
    ...cliente,
  };

  const { data, error } = await db
    .from('sales_events')
    .upsert(fila, { onConflict: 'cliente_id,platform,platform_sale_id' })
    .select('id')
    .single();
  if (error) return { guardada: false, motivo: error.message };
  return { guardada: true, id: data?.id as string | undefined };
}
