/**
 * Parser tolerante para webhooks de CartPanda.
 * Acepta múltiples variantes del payload (v1, v2, estructura directa).
 */

export type ParsedCartPandaEvent = {
  platform_sale_id: string;
  amount: number;
  currency: string;
  status: 'approved' | 'pending' | 'refunded' | 'chargeback';
  sale_timestamp: string | null;
  transaction_type: string | null;
  product_id: string | null;
  product_name: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_country: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
  click_id: string | null;
};

type PayloadError = { error: string };

const STATUS_MAP: Record<string, ParsedCartPandaEvent['status']> = {
  'order.approved': 'approved',
  approved: 'approved',
  paid: 'approved',
  'order.paid': 'approved',
  'order.pending': 'pending',
  pending: 'pending',
  'order.waiting_payment': 'pending',
  waiting_payment: 'pending',
  'order.refunded': 'refunded',
  refunded: 'refunded',
  'order.cancelled': 'refunded',
  cancelled: 'refunded',
  'order.chargeback': 'chargeback',
  chargeback: 'chargeback',
};

function get(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key] ?? null;
  }
  return cur ?? null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export function parseCartPandaPayload(raw: unknown): ParsedCartPandaEvent | PayloadError {
  if (raw == null || typeof raw !== 'object') {
    return { error: 'Payload is not an object' };
  }

  // CartPanda puede enviar el evento en distintas ubicaciones:
  //   { event, data: { ... } }       ← formato principal
  //   { order: { ... } }             ← algunos webhooks legacy
  //   { ... }                         ← datos directamente en la raíz
  const eventName =
    asString(get(raw, 'event')) ?? asString(get(raw, 'type')) ?? asString(get(raw, 'status'));

  const data: unknown = get(raw, 'data') ?? get(raw, 'order') ?? raw;

  // Mapear status
  const rawStatus =
    asString(get(data, 'status')) ??
    asString(get(data, 'financial_status')) ??
    (eventName ? eventName : null);

  const status = rawStatus ? STATUS_MAP[rawStatus] : undefined;
  if (!status) {
    return { error: `Unknown status/event: ${rawStatus ?? '(none)'}` };
  }

  // ID de la orden
  const platform_sale_id =
    asString(get(data, 'id')) ??
    asString(get(data, 'order_id')) ??
    asString(get(data, 'transaction_id')) ??
    asString(get(raw, 'id'));

  if (!platform_sale_id) {
    return { error: 'Missing order ID' };
  }

  // Monto
  const amount =
    asNumber(get(data, 'total')) ??
    asNumber(get(data, 'amount')) ??
    asNumber(get(data, 'grand_total')) ??
    0;

  const currency = asString(get(data, 'currency')) ?? asString(get(data, 'currency_code')) ?? 'BRL';

  // Timestamp
  const sale_timestamp =
    asString(get(data, 'created_at')) ??
    asString(get(data, 'approved_at')) ??
    asString(get(data, 'paid_at')) ??
    null;

  // Cliente
  const customer = get(data, 'customer') ?? get(data, 'buyer') ?? data;
  const customer_name =
    asString(get(customer, 'name')) ??
    asString(get(customer, 'full_name')) ??
    ([asString(get(customer, 'first_name')), asString(get(customer, 'last_name'))]
      .filter(Boolean)
      .join(' ') ||
      null);
  const customer_email =
    asString(get(customer, 'email')) ?? asString(get(data, 'customer_email')) ?? null;
  const customer_phone =
    asString(get(customer, 'phone')) ?? asString(get(customer, 'cellphone')) ?? null;
  const customer_country =
    asString(get(customer, 'country')) ?? asString(get(customer, 'country_code')) ?? null;

  // Producto (primer ítem si es array)
  const productRaw =
    get(data, 'product') ??
    (() => {
      const items = get(data, 'items') ?? get(data, 'line_items');
      return Array.isArray(items) ? items[0] : items;
    })();

  const product_id = asString(get(productRaw, 'id')) ?? asString(get(productRaw, 'product_id'));
  const product_name = asString(get(productRaw, 'name')) ?? asString(get(productRaw, 'title'));

  // Tipo de transacción (order_bump, upsell, etc.)
  const transaction_type =
    asString(get(data, 'transaction_type')) ?? asString(get(data, 'type')) ?? 'principal';

  // UTMs — CartPanda los puede enviar en data.utm.* o data.tracking.* o data.*
  const utmSource =
    get(data, 'utm', 'utm_source') ??
    get(data, 'tracking', 'utm_source') ??
    get(data, 'utm_source');
  const utmMedium =
    get(data, 'utm', 'utm_medium') ??
    get(data, 'tracking', 'utm_medium') ??
    get(data, 'utm_medium');
  const utmCampaign =
    get(data, 'utm', 'utm_campaign') ??
    get(data, 'tracking', 'utm_campaign') ??
    get(data, 'utm_campaign');
  const utmContent =
    get(data, 'utm', 'utm_content') ??
    get(data, 'tracking', 'utm_content') ??
    get(data, 'utm_content');
  const utmTerm =
    get(data, 'utm', 'utm_term') ?? get(data, 'tracking', 'utm_term') ?? get(data, 'utm_term');
  const utmId =
    get(data, 'utm', 'utm_id') ?? get(data, 'tracking', 'utm_id') ?? get(data, 'utm_id');

  // Click IDs
  const click_id =
    asString(get(data, 'tracking', 'fbclid')) ??
    asString(get(data, 'utm', 'fbclid')) ??
    asString(get(data, 'fbclid')) ??
    asString(get(data, 'tracking', 'gclid')) ??
    asString(get(data, 'utm', 'gclid')) ??
    asString(get(data, 'gclid')) ??
    asString(get(data, 'tracking', 'ttclid')) ??
    asString(get(data, 'tracking', 'click_id')) ??
    null;

  return {
    platform_sale_id,
    amount,
    currency,
    status,
    sale_timestamp,
    transaction_type,
    product_id,
    product_name,
    customer_name,
    customer_email,
    customer_phone,
    customer_country,
    utm_source: asString(utmSource),
    utm_medium: asString(utmMedium),
    utm_campaign: asString(utmCampaign),
    utm_content: asString(utmContent),
    utm_term: asString(utmTerm),
    utm_id: asString(utmId),
    click_id,
  };
}
