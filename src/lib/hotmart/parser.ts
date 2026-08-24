// ════════════════════════════════════════════════════════════════
// El ÚNICO parser de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Antes había dos lecturas del mismo dato que no coincidían en nada:
//
//   • `src/lib/report-utm/hotmart-parser.ts` leía el webhook y buscaba
//     `purchase.is_bump` / `purchase.is_upsell` — claves que NO EXISTEN en el
//     payload 2.0.0 de Hotmart. Resultado: `transaction_type` era SIEMPRE
//     'principal', y la dimensión "Tipo de transacción" del BI no distinguía
//     nada. Los campos reales son `purchase.order_bump.is_order_bump` y
//     `purchase.offer.code`.
//
//   • `src/app/api/worker/route.ts:1616-1886` leía la API y se quedaba solo con
//     `{transaction, price.value, price.currency_code}`, tirando comprador,
//     oferta, método de pago, país y UTMs.
//
// Los dos producen ahora el mismo `VentaHotmart`. Lo que el webhook sabe y la
// API no (UTMs) queda `null` en el camino de la API, y al revés con las
// comisiones — pero la FORMA es idéntica, así que el `ON CONFLICT` de
// `hotmart_ventas` puede fusionarlos por transacción.

import { colombiaDateOf } from '../colombia-date';
import { clasificarEvento, estadoDeEvento, estadoDeStatusApi } from './eventos';
import type {
  EstadoVenta,
  HotmartCompra,
  HotmartComision,
  HotmartComprador,
  HotmartProducto,
  HotmartWebhook,
  ItemComisiones,
  ItemHistorial,
  ResultadoParseo,
  VentaHotmart,
} from './tipos';

type AnyObj = Record<string, unknown>;

function texto(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function numero(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Instante de Hotmart → ISO.
 *
 * Hotmart manda epoch en MILISEGUNDOS en el webhook 2.0.0 y en algunos campos
 * de la API. También aparecen strings ISO en checkouts personalizados. Se
 * distingue por magnitud: un epoch en segundos de una fecha real cabe en 10
 * dígitos, uno en milisegundos necesita 13.
 */
export function instanteISO(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return instanteISO(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/**
 * Suma las comisiones de una fuente concreta. `null` si no hay ninguna.
 *
 * Acepta las dos formas en que Hotmart anida el importe: plana en el webhook
 * (`{value, currency_value}`) y bajo `commission` en `sales/commissions`. Leer
 * solo una devolvía 0 para la otra, sin ningún aviso.
 */
function comisionDe(
  comisiones: HotmartComision[] | undefined,
  fuente: string
): { valor: number; moneda: string | null } | null {
  if (!Array.isArray(comisiones)) return null;
  const propias = comisiones.filter(
    (c) =>
      String(c?.source ?? '')
        .trim()
        .toUpperCase() === fuente
  );
  if (propias.length === 0) return null;
  let valor = 0;
  let moneda: string | null = null;
  for (const c of propias) {
    valor += numero(c.commission?.value) ?? numero(c.value) ?? 0;
    moneda =
      moneda ??
      texto(c.commission?.currency_code) ??
      texto(c.commission?.currency_value) ??
      texto(c.currency_value) ??
      texto(c.currency_code);
  }
  return { valor, moneda };
}

/**
 * Extrae UTMs y parámetros de origen.
 *
 * Hotmart los reparte por cuatro sitios distintos según cómo esté montado el
 * checkout, y `purchase.origin` (la ubicación canónica en 2.0.0) es justo la
 * que el parser viejo NO miraba.
 *
 * Diferencia importante frente al parser anterior: `sck`, `src` y `xcod` se
 * guardan TAMBIÉN en columnas propias. Antes solo se usaban como relleno de
 * `utm_content`/`utm_source`/`click_id`, así que era imposible distinguir un UTM
 * real de un parámetro de Hotmart.
 */
function extraerOrigen(compra: HotmartCompra | undefined, datos: AnyObj) {
  const origin = (compra?.origin ?? {}) as AnyObj;
  const tracking = (compra?.tracking ?? {}) as AnyObj;
  const custom = (compra?.customData ?? compra?.custom_data ?? {}) as AnyObj;
  const compraObj = (compra ?? {}) as AnyObj;

  const buscar = (...claves: string[]): string | null => {
    for (const k of claves) {
      const v =
        texto(custom[k]) ??
        texto(tracking[k]) ??
        texto(origin[k]) ??
        texto(compraObj[k]) ??
        texto(datos[k]);
      if (v) return v;
    }
    return null;
  };

  const src = buscar('src');
  const sck = buscar('sck', 'source_sck');
  const xcod = buscar('xcod');

  return {
    utm_source: buscar('utm_source') ?? src,
    utm_medium: buscar('utm_medium'),
    utm_campaign: buscar('utm_campaign'),
    utm_content: buscar('utm_content') ?? sck,
    utm_term: buscar('utm_term'),
    utm_id: buscar('utm_id'),
    click_id: buscar('fbclid', 'gclid', 'ttclid', 'click_id') ?? xcod,
    src,
    sck,
    xcod,
  };
}

/** Datos del comprador. */
function extraerComprador(buyer: HotmartComprador | undefined) {
  return {
    comprador_nombre: texto(buyer?.name),
    comprador_email: texto(buyer?.email),
    // El parser viejo caía a `buyer.document` cuando no había teléfono, y ese
    // valor se enviaba a Meta CAPI hasheado COMO TELÉFONO. Un CPF/CC nunca
    // matchea con un teléfono: solo degradaba la calidad del evento. El
    // documento tiene ahora su propia columna.
    comprador_telefono: texto(buyer?.checkout_phone) ?? texto(buyer?.phone),
    comprador_doc: texto(buyer?.document),
    comprador_pais:
      texto(buyer?.address?.country_iso) ?? texto(buyer?.address?.country) ?? texto(buyer?.country),
  };
}

function extraerProducto(producto: HotmartProducto | undefined) {
  return {
    producto_id: texto(producto?.id) ?? texto(producto?.ucode),
    producto_nombre: texto(producto?.name),
  };
}

/** Cabecera común: identidad, fechas y clasificación por defecto. */
function base(
  compra: HotmartCompra,
  estado: EstadoVenta,
  eventoTs: string,
  origen: VentaHotmart['origen']
): Pick<
  VentaHotmart,
  | 'transaction_id'
  | 'parent_transaction_id'
  | 'fecha_venta'
  | 'aprobada_at'
  | 'orden_at'
  | 'estado'
  | 'evento_ts'
  | 'reembolsada_at'
  | 'tipo'
  | 'clasificacion_origen'
  | 'tab_id'
  | 'oferta_codigo'
  | 'es_order_bump'
  | 'pago_tipo'
  | 'pago_cuotas'
  | 'checkout_pais'
  | 'origen'
> | null {
  const transaction_id = texto(compra.transaction);
  if (!transaction_id) return null;

  const aprobada_at = instanteISO(compra.approved_date);
  const orden_at = instanteISO(compra.order_date) ?? instanteISO(compra.date);

  // El día Colombia se materializa AQUÍ, una sola vez. Es lo que acaba con las
  // tres definiciones de fecha de venta que competían en el módulo
  // (`created_at`, `sale_timestamp`, `sale_timestamp ?? received_at`).
  const fecha_venta = colombiaDateOf(aprobada_at ?? orden_at ?? eventoTs);

  const esDevuelta = estado === 'reembolsada' || estado === 'chargeback';

  return {
    transaction_id,
    parent_transaction_id:
      texto(compra.parent_purchase_transaction) ??
      texto(compra.order_bump?.parent_purchase_transaction),
    fecha_venta,
    aprobada_at,
    orden_at,
    estado,
    evento_ts: eventoTs,
    reembolsada_at: esDevuelta ? eventoTs : null,
    tipo: 'sin_clasificar',
    clasificacion_origen: 'sin_clasificar',
    tab_id: null,
    oferta_codigo: texto(compra.offer?.code) ?? texto(compra.offer?.key),
    es_order_bump: compra.order_bump?.is_order_bump === true,
    pago_tipo: texto(compra.payment?.type) ?? texto(compra.payment?.method),
    pago_cuotas: numero(compra.payment?.installments_number),
    checkout_pais: texto(compra.checkout_country?.iso) ?? texto(compra.checkout_country?.name),
    origen,
  };
}

// ────────────────────────────────────────────────────────────────
// Webhook
// ────────────────────────────────────────────────────────────────

/**
 * Parsea un payload del webhook 2.0.0.
 *
 * Devuelve `no_venta` (no un error) para los eventos de suscripción y de Club:
 * son legítimos, simplemente no tienen `data.purchase`. Que el webhook responda
 * 200 a esos evita que la tarjeta de integración se quede en rojo para siempre.
 */
export function parsearWebhook(payload: unknown, ahora: Date = new Date()): ResultadoParseo {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, motivo: 'ilegible', detalle: 'El payload no es un objeto' };
  }

  const wh = payload as HotmartWebhook & AnyObj;
  const nombreEvento = texto(wh.event) ?? texto((wh as AnyObj).event_type) ?? '';

  const clase = clasificarEvento(nombreEvento);
  if (clase === 'no_venta') {
    return { ok: false, motivo: 'no_venta', evento: nombreEvento };
  }
  if (clase === 'desconocido') {
    // NO se cuenta como venta. El fallback `?? 'approved'` del parser viejo
    // convertía cualquier evento nuevo de Hotmart en facturación inventada.
    return {
      ok: false,
      motivo: 'no_venta',
      evento: nombreEvento || '(sin nombre de evento)',
    };
  }

  const datos = (wh.data ?? (wh as AnyObj).event_data ?? {}) as AnyObj;
  const compra = (datos.purchase ?? (wh as AnyObj).purchase) as HotmartCompra | undefined;
  if (!compra || typeof compra !== 'object') {
    return { ok: false, motivo: 'ilegible', detalle: 'No se encontró data.purchase' };
  }

  const estado = estadoDeEvento(nombreEvento);
  if (!estado) {
    return { ok: false, motivo: 'ilegible', detalle: `Evento sin estado: ${nombreEvento}` };
  }

  const eventoTs =
    instanteISO(wh.creation_date) ??
    instanteISO(compra.approved_date) ??
    instanteISO(compra.order_date) ??
    ahora.toISOString();

  const cabecera = base(compra, estado, eventoTs, 'webhook');
  if (!cabecera) {
    return { ok: false, motivo: 'ilegible', detalle: 'No se encontró transaction id' };
  }

  const precio = compra.price ?? compra.full_price;
  const productor = comisionDe(
    compra.commissions ?? (datos.commissions as HotmartComision[]),
    'PRODUCER'
  );
  const afiliado = comisionDe(
    compra.commissions ?? (datos.commissions as HotmartComision[]),
    'AFFILIATE'
  );
  const coproductor = comisionDe(
    compra.commissions ?? (datos.commissions as HotmartComision[]),
    'COPRODUCER'
  );

  const venta: VentaHotmart = {
    ...cabecera,
    ...extraerProducto(datos.product as HotmartProducto),
    ...extraerComprador(datos.buyer as HotmartComprador),
    ...extraerOrigen(compra, datos),

    moneda: texto(precio?.currency_value) ?? texto(precio?.currency_code),
    bruto: numero(precio?.value) ?? 0,
    // La conversión a USD la hace `moneda.ts` en lote: necesita conocer todas
    // las divisas antes de pedir tasas, para no hacer una llamada por venta.
    bruto_usd: null,
    neto_productor_usd: null,
    neto_afiliado_usd: null,
    neto_coproductor_usd: null,
    usd_rate: null,

    raw_payload: payload,
  };

  // Los importes de comisión en moneda original viajan aparte hasta que
  // `convertirLote` los resuelva. Se anexan sin ensuciar el tipo canónico.
  comisionesPendientes.set(venta, {
    productor: productor?.valor ?? null,
    afiliado: afiliado?.valor ?? null,
    coproductor: coproductor?.valor ?? null,
    moneda: productor?.moneda ?? venta.moneda,
  });

  return { ok: true, venta };
}

// ────────────────────────────────────────────────────────────────
// API REST
// ────────────────────────────────────────────────────────────────

/**
 * Comisiones en moneda original, a la espera de conversión.
 *
 * Es un `WeakMap` y no columnas del tipo porque `VentaHotmart` describe lo que
 * se GUARDA (ya en USD). Los importes crudos solo viven entre el parseo y la
 * conversión, y el WeakMap los deja marcharse con la venta.
 */
export type ComisionesCrudas = {
  productor: number | null;
  afiliado: number | null;
  coproductor: number | null;
  moneda: string | null;
};
export const comisionesPendientes = new WeakMap<VentaHotmart, ComisionesCrudas>();

/**
 * Parsea un item de `sales/history`, opcionalmente enriquecido con su fila de
 * `sales/commissions`.
 *
 * Frente al worker actual, aquí se retiene el item COMPLETO: de él salen
 * `offer.code`, `order_bump`, método de pago, país de checkout y comprador, que
 * hoy se descartan en `worker/route.ts:1677-1684`.
 */
export function parsearApi(
  item: ItemHistorial,
  comisiones?: ItemComisiones,
  opts: { origen?: VentaHotmart['origen']; ahora?: Date } = {}
): ResultadoParseo {
  const compra = item?.purchase;
  if (!compra || typeof compra !== 'object') {
    return { ok: false, motivo: 'ilegible', detalle: 'El item no trae purchase' };
  }

  // La API usa el vocabulario de la plataforma, no nombres de evento. Sin este
  // mapa aparte se repetiría el bug de indexar un mapa con las claves del otro.
  const estado = estadoDeStatusApi(compra.status) ?? 'aprobada';

  const eventoTs =
    instanteISO(compra.approved_date) ??
    instanteISO(compra.order_date) ??
    instanteISO(compra.date) ??
    (opts.ahora ?? new Date()).toISOString();

  const cabecera = base(compra, estado, eventoTs, opts.origen ?? 'api');
  if (!cabecera) {
    return { ok: false, motivo: 'ilegible', detalle: 'No se encontró transaction id' };
  }

  const precio = compra.price ?? compra.full_price;
  const lista = comisiones?.commissions ?? compra.commissions;
  const productor = comisionDe(lista, 'PRODUCER');
  const afiliado = comisionDe(lista, 'AFFILIATE');
  const coproductor = comisionDe(lista, 'COPRODUCER');

  const venta: VentaHotmart = {
    ...cabecera,
    ...extraerProducto(item.product ?? comisiones?.product),
    ...extraerComprador(item.buyer),
    ...extraerOrigen(compra, {}),

    moneda: texto(precio?.currency_value) ?? texto(precio?.currency_code),
    bruto: numero(precio?.value) ?? 0,
    bruto_usd: null,
    neto_productor_usd: null,
    neto_afiliado_usd: null,
    neto_coproductor_usd: null,
    usd_rate: null,

    // La API no da payload de evento: el crudo del webhook es el que sirve
    // para depurar, y guardar aquí una copia del item duplicaría espacio.
    raw_payload: null,
  };

  comisionesPendientes.set(venta, {
    productor: productor?.valor ?? null,
    afiliado: afiliado?.valor ?? null,
    coproductor: coproductor?.valor ?? null,
    moneda: productor?.moneda ?? venta.moneda,
  });

  return { ok: true, venta };
}
