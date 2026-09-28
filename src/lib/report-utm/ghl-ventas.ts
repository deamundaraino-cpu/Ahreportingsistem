import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchContactById,
  fetchOpportunityById,
  type GhlContact,
  type GhlOportunidad,
} from './ghl-client';
import {
  credencialesDe,
  deriveUtmsUltimoToque,
  idsDeContactoUltimoToque,
  normalizeContactFields,
  type GhlIntegrationRow,
} from './ghl-leads';
import { columnasCruceLead } from './lead-ids';
import {
  atribucionDesdeLead,
  elegirUltimoLeadVenta,
  esVentaGanada,
  esVentaRevertida,
  instanteVentaGhl,
  saleTimestampEstable,
  vacioEsGanadaDe,
  ESTADO_VENTA_REVERTIDA,
  LOOKBACK_VENTA_DIAS,
  TOLERANCIA_VENTA_MS,
  type ClaveContactoVenta,
  type FuenteFechaVenta,
  type LeadVentaCandidato,
} from './ghl-ventas-atribucion';
import { normalizarEmail, tel9 } from '@/lib/hotmart/atribucion';
import { monedaDeClienteUtm } from '@/lib/moneda-reporte';

// Compatibilidad: `esVentaGanada` vivía aquí y lo importan las comprobaciones.
export { esVentaGanada, esVentaRevertida } from './ghl-ventas-atribucion';

/**
 * Ventas del CRM de GoHighLevel → `report_utm.sales_events`.
 *
 * Los clientes que venden por asesoría (Cris Tributario) cierran en el embudo de
 * GHL, no en una pasarela. Hasta el 2026-09-12 esa venta había que cargarla a
 * mano en el dashboard, y `sales_events` estaba vacía en producción, así que el
 * ROAS, el CPA y la tasa de conversión de esos clientes salían en blanco.
 *
 * Dos caminos, un solo código (`guardarVentaGhl`):
 *   · Webhook → el Workflow de GHL («Opportunity Status Changed», o el cambio a
 *     la etapa que el cliente use como venta). El payload es un AVISO.
 *   · Sync de respaldo → `ghl-oportunidades.ts` recorre las ganadas de los
 *     últimos 90 días por si un webhook se perdió, y revierte las que dejaron
 *     de estar ganadas.
 *
 * ── Atribución: el último lead antes de la venta ────────────────
 * La venta hereda la tupla UTM y los IDs de anuncio del último lead del mismo
 * contacto anterior al cierre (reglas en `ghl-ventas-atribucion.ts`). Sin lead,
 * el último toque del contacto (`lastAttributionSource`) como bloque.
 *
 * ── Fechas ──────────────────────────────────────────────────────
 * `sale_timestamp` y `created_at` = instante del CIERRE (el cambio a ganada de
 * la oportunidad), nunca la hora de llegada del webhook: el BI fecha las ventas
 * por `created_at`, y una venta cargada por el sync de respaldo días después
 * caería en el día equivocado. Un reenvío conserva la fecha ya guardada.
 */

type Db = ReturnType<SupabaseClient['schema']>;

/** Prefijo de `platform_sale_id`: una oportunidad = una venta, aunque GHL reenvíe. */
export const GHL_VENTA_PREFIX = 'ghl-opp:';
export const GHL_PLATFORM = 'gohighlevel';

type FechasOportunidad = {
  lastStatusChangeAt?: string;
  lastStageChangeAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

export type GhlVentaPayload = {
  contact_id?: string;
  contactId?: string;
  contact?: { id?: string; email?: string; phone?: string; name?: string };
  opportunity_id?: string;
  opportunityId?: string;
  opportunity?: {
    id?: string;
    name?: string;
    status?: string;
    monetary_value?: number | string;
    monetaryValue?: number | string;
    pipeline_stage?: string;
  } & FechasOportunidad;
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
  /** Datos estándar del contacto que GHL añade al payload de un Workflow. */
  email?: string;
  phone?: string;
  full_name?: string;
  lastStatusChangeAt?: string;
  lastStageChangeAt?: string;
  location?: { id?: string };
  locationId?: string;
  /** `sync_oportunidades` cuando la fila la creó el sync de respaldo. */
  origen?: string;
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

export type VentaGhlLeida = {
  contactId: string | null;
  oportunidadId: string | null;
  importe: number | null;
  estado: string | null;
  nombre: string | null;
  /** Email/teléfono del contacto si el Workflow los manda (cruce con leads sin releer). */
  email: string | null;
  telefono: string | null;
  /** Fechas de la oportunidad que traiga el payload, si las trae. */
  fechas: FuenteFechaVenta;
};

/** Datos de la venta según cómo lo haya montado el Workflow. Puro. */
export function leerVentaGhl(p: GhlVentaPayload): VentaGhlLeida {
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
    email: txt(p.email ?? p.contact?.email),
    telefono: txt(p.phone ?? p.contact?.phone),
    fechas: {
      lastStatusChangeAt: o.lastStatusChangeAt ?? p.lastStatusChangeAt ?? null,
      lastStageChangeAt: o.lastStageChangeAt ?? p.lastStageChangeAt ?? null,
      updatedAt: o.updatedAt ?? null,
      createdAt: o.createdAt ?? null,
    },
  };
}

/** `platform_sale_id` de la venta. */
export function idVentaGhl(venta: Pick<VentaGhlLeida, 'oportunidadId' | 'contactId'>): string {
  return `${GHL_VENTA_PREFIX}${venta.oportunidadId ?? `contacto:${venta.contactId}`}`;
}

export type ResultadoVentaGhl = {
  guardada: boolean;
  motivo?: string;
  id?: string;
  /** La venta existía y se marcó como revertida (`canceled`). */
  revertida?: boolean;
  /** De dónde salió la atribución: `lead:<vía>`, `ultimo_toque` o `ninguna`. */
  atribucion?: string;
};

// ── Leads del contacto ────────────────────────────────────────────────

const COLS_LEAD = [
  'id',
  'created_at',
  'external_id',
  'lead_email',
  'lead_phone',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'click_id',
] as const;

/** Escapa los comodines de LIKE: un `_` en un email es un carácter, no «cualquiera». */
function escaparLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Leads candidatos del contacto: por `external_id`, por email y por teléfono, en
 * tres consultas pequeñas (acotadas por cliente y ventana). El filtro de la base
 * es AMPLIO a propósito (`ilike`, dígitos intercalados para el teléfono) porque
 * los teléfonos llegan con cualquier formato; la coincidencia EXACTA la decide
 * `elegirUltimoLeadVenta` con la normalización de Hotmart.
 */
async function buscarLeadsDeContacto(
  db: Db,
  clienteId: string,
  clave: ClaveContactoVenta,
  instanteMs: number
): Promise<LeadVentaCandidato[]> {
  const cols = (await columnasCruceLead(db, COLS_LEAD)).join(',');
  const desde = new Date(instanteMs - LOOKBACK_VENTA_DIAS * 86_400_000).toISOString();
  const hasta = new Date(instanteMs + TOLERANCIA_VENTA_MS).toISOString();
  const base = () =>
    db
      .from('lead_events')
      .select(cols)
      .eq('cliente_id', clienteId)
      .gte('created_at', desde)
      .lte('created_at', hasta)
      .order('created_at', { ascending: false })
      .limit(50);

  const consultas: PromiseLike<{ data: unknown; error: { message: string } | null }>[] = [];
  if (clave.contactId) consultas.push(base().eq('external_id', `ghl:${clave.contactId}`));
  const email = normalizarEmail(clave.email);
  if (email) consultas.push(base().ilike('lead_email', `%${escaparLike(email)}%`));
  const tel = tel9(clave.telefono);
  if (tel) consultas.push(base().ilike('lead_phone', `%${tel.split('').join('%')}`));

  const porId = new Map<string, LeadVentaCandidato>();
  for (const r of await Promise.all(consultas)) {
    if (r.error) {
      console.error('[ghl venta] no se pudieron leer los leads del contacto', r.error.message);
      continue;
    }
    for (const l of (r.data ?? []) as LeadVentaCandidato[]) porId.set(l.id, l);
  }
  return Array.from(porId.values());
}

const SIN_ATRIBUCION = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  utm_id: null,
  ad_campaign_id: null,
  ad_set_id: null,
  ad_id: null,
  click_id: null,
  attribution_method: 'none',
};

// ── Escritura ─────────────────────────────────────────────────────────

/**
 * Marca como revertida (`canceled`) la venta de una oportunidad que dejó de
 * estar ganada. Solo toca filas `approved`: revertir dos veces no hace nada.
 */
export async function revertirVentaGhl(
  db: Db,
  clienteId: string,
  platformSaleId: string
): Promise<{ revertida: boolean; error?: string }> {
  const { data, error } = await db
    .from('sales_events')
    .update({ status: ESTADO_VENTA_REVERTIDA, processed_at: new Date().toISOString() })
    .eq('cliente_id', clienteId)
    .eq('platform', GHL_PLATFORM)
    .eq('platform_sale_id', platformSaleId)
    .eq('status', 'approved')
    .select('id');
  if (error) return { revertida: false, error: error.message };
  return { revertida: (data ?? []).length > 0 };
}

/**
 * Guarda (o actualiza) una venta ganada. Camino ÚNICO del webhook y del sync.
 *
 * Idempotente por `(cliente_id, platform, platform_sale_id)`. Se lee la fila
 * antes de escribir para que un reenvío no mueva `sale_timestamp` ni
 * `created_at`; si dos escritores chocan en el INSERT (23505), el perdedor
 * actualiza.
 */
export async function guardarVentaGhl(
  supabase: SupabaseClient,
  integration: GhlIntegrationRow,
  venta: VentaGhlLeida,
  opts: { rawPayload: Record<string, unknown>; oportunidad?: GhlOportunidad | null }
): Promise<ResultadoVentaGhl> {
  const db: Db = supabase.schema('report_utm');
  const clienteId = integration.cliente_id;
  const platformSaleId = idVentaGhl(venta);
  const ahora = new Date().toISOString();

  const { data: existente } = await db
    .from('sales_events')
    .select('id, sale_timestamp')
    .eq('cliente_id', clienteId)
    .eq('platform', GHL_PLATFORM)
    .eq('platform_sale_id', platformSaleId)
    .maybeSingle();
  const previa = existente as { id: string; sale_timestamp: string | null } | null;

  const { cred } = credencialesDe(integration);

  // La oportunidad solo se relee si hace falta la fecha del cierre: el payload
  // estándar de un Workflow no la trae. Sin el scope `opportunities.readonly`
  // falla y la venta cae a la hora de llegada, como antes.
  let oportunidad = opts.oportunidad ?? null;
  const fechaEnPayload = instanteVentaGhl(venta.estado, [venta.fechas]);
  if (!oportunidad && !previa?.sale_timestamp && !fechaEnPayload && cred && venta.oportunidadId) {
    oportunidad = await fetchOpportunityById(venta.oportunidadId, cred).catch(() => null);
  }
  const saleTimestamp = saleTimestampEstable(
    previa?.sale_timestamp,
    instanteVentaGhl(venta.estado, [venta.fechas, oportunidad]),
    ahora
  );

  // El contacto se relee siempre que se pueda: da el email/teléfono para el
  // cruce con los leads, el último toque de respaldo y los datos del cliente.
  const contactId = venta.contactId ?? txt(oportunidad?.contactId);
  let contacto: GhlContact | null = null;
  if (contactId && cred) {
    contacto = await fetchContactById(contactId, cred).catch(() => null);
  }

  const clave: ClaveContactoVenta = {
    contactId,
    email: txt(contacto?.email) ?? venta.email ?? txt(oportunidad?.contact?.email),
    telefono: txt(contacto?.phone) ?? venta.telefono ?? txt(oportunidad?.contact?.phone),
  };
  const candidatos = await buscarLeadsDeContacto(db, clienteId, clave, Date.parse(saleTimestamp));
  const elegido = elegirUltimoLeadVenta(clave, Date.parse(saleTimestamp), candidatos);

  let atribucion: Record<string, unknown>;
  let origenAtribucion: string;
  if (elegido) {
    atribucion = atribucionDesdeLead(elegido.lead);
    origenAtribucion = `lead:${elegido.via}`;
  } else if (contacto) {
    const u = deriveUtmsUltimoToque(contacto);
    const ids = idsDeContactoUltimoToque(contacto);
    atribucion = {
      utm_source: u.utm_source,
      utm_medium: u.utm_medium,
      utm_campaign: u.utm_campaign,
      utm_content: u.utm_content,
      utm_term: u.utm_term,
      utm_id: u.utm_id,
      ad_campaign_id: ids.campaign_id,
      ad_set_id: ids.adset_id,
      ad_id: ids.ad_id,
      click_id: u.click_id,
      attribution_method: u.attribution_method,
    };
    origenAtribucion = 'ultimo_toque';
  } else {
    atribucion = { ...SIN_ATRIBUCION };
    origenAtribucion = 'ninguna';
  }

  let cliente: Record<string, unknown> = {};
  if (contacto) {
    const c = normalizeContactFields(contacto, new Map());
    cliente = {
      customer_name: c.lead_name,
      customer_email: c.lead_email,
      customer_phone: c.lead_phone,
      customer_country: txt(contacto.country),
      customer_id: `ghl:${contacto.id}`,
    };
  } else if (contactId) {
    cliente = {
      customer_name: txt(oportunidad?.contact?.name),
      customer_email: clave.email,
      customer_phone: clave.telefono,
      customer_id: `ghl:${contactId}`,
    };
  }

  const moneda = await monedaDeClienteUtm(supabase, clienteId);
  const fila = {
    cliente_id: clienteId,
    platform: GHL_PLATFORM,
    platform_sale_id: platformSaleId,
    // Sin importe en la oportunidad la venta cuenta como unidad con valor 0:
    // «una venta cerrada» es el dato que el PM pidió, el valor es un extra.
    amount: venta.importe ?? numero(oportunidad?.monetaryValue) ?? 0,
    // El importe de la oportunidad lo escribe el cliente en su CRM, en su moneda.
    currency: moneda,
    status: 'approved',
    product_name: venta.nombre ?? txt(oportunidad?.name) ?? 'Venta CRM',
    transaction_type: 'principal',
    processed_at: ahora,
    raw_payload: opts.rawPayload,
    attribution_resolved_at: ahora,
    ...atribucion,
    ...cliente,
  };

  const actualizar = async (id: string): Promise<ResultadoVentaGhl> => {
    // Sin `sale_timestamp`, `created_at` ni `received_at`: la fecha es la del
    // primer registro, un reenvío no la mueve.
    const { error } = await db.from('sales_events').update(fila).eq('id', id);
    if (error) return { guardada: false, motivo: error.message };
    return { guardada: true, id, atribucion: origenAtribucion };
  };

  if (previa?.id) return actualizar(previa.id);

  const { data, error } = await db
    .from('sales_events')
    .insert({
      ...fila,
      sale_timestamp: saleTimestamp,
      // El BI fecha las ventas por `created_at`: debe ser el día del cierre.
      created_at: saleTimestamp,
      received_at: ahora,
    })
    .select('id')
    .single();
  if (!error)
    return { guardada: true, id: data?.id as string | undefined, atribucion: origenAtribucion };
  if ((error as { code?: string }).code !== '23505')
    return { guardada: false, motivo: error.message };

  // Carrera con otro escritor (webhook reenviado, sync): ya existe, se actualiza.
  const { data: otra } = await db
    .from('sales_events')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('platform', GHL_PLATFORM)
    .eq('platform_sale_id', platformSaleId)
    .maybeSingle();
  if (!otra?.id) return { guardada: false, motivo: error.message };
  return actualizar(otra.id as string);
}

/**
 * Camino del webhook. Ganada → se guarda; perdida/abandonada/abierta → si ya
 * era una venta, se revierte. Sin estado cuenta como ganada salvo que la
 * integración diga `config.ventas_estado_vacio_es_ganada = false`.
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

  if (esVentaRevertida(venta.estado)) {
    const r = await revertirVentaGhl(
      supabase.schema('report_utm'),
      integration.cliente_id,
      idVentaGhl(venta)
    );
    if (r.error) return { guardada: false, motivo: r.error };
    return {
      guardada: false,
      revertida: r.revertida,
      motivo: r.revertida
        ? `La oportunidad pasó a «${venta.estado}»: la venta se marcó como ${ESTADO_VENTA_REVERTIDA}.`
        : `La oportunidad está en «${venta.estado}», no ganada.`,
    };
  }

  if (!esVentaGanada(venta.estado, vacioEsGanadaDe(integration.config))) {
    return {
      guardada: false,
      motivo: venta.estado
        ? `La oportunidad está en «${venta.estado}», no ganada.`
        : 'El webhook no trae estado y la integración no cuenta el estado vacío como venta.',
    };
  }

  return guardarVentaGhl(supabase, integration, venta, {
    rawPayload: payload as unknown as Record<string, unknown>,
  });
}
