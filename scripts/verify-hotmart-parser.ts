/**
 * Comprobaciones del parser único de Hotmart.
 *
 * Todo PURO: fixtures en memoria, sin BD ni red. Cada assert de aquí abajo
 * corresponde a un bug REAL que el parser anterior tenía en producción, no a un
 * caso hipotético. La lista de bugs está en la cabecera de cada sección.
 *
 *   npx tsx scripts/verify-hotmart-parser.ts
 */

import {
  parsearWebhook,
  parsearApi,
  instanteISO,
  comisionesPendientes,
} from '../src/lib/hotmart/parser';
import { clasificarEvento, estadoDeEvento, estadoDeStatusApi } from '../src/lib/hotmart/eventos';
import type { ItemComisiones, ItemHistorial, VentaHotmart } from '../src/lib/hotmart/tipos';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

const AHORA = new Date('2026-08-10T15:00:00.000Z');

/** Venta parseada, o `null` si el parseo no dio una venta. */
function venta(r: ReturnType<typeof parsearWebhook>): VentaHotmart | null {
  return r.ok ? r.venta : null;
}

// ── Fixtures ────────────────────────────────────────────────────
// Payload 2.0.0 real de Hotmart, recortado a lo que el parser lee.

function webhook(over: Record<string, unknown> = {}, compraOver: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    creation_date: 1786000000000,
    data: {
      product: { id: 1234567, ucode: 'abc-ucode', name: 'Camaradictos Pro' },
      buyer: {
        name: 'Ana Pérez',
        email: 'ana@ejemplo.com',
        checkout_phone: '573001112233',
        document: '1020304050',
        address: { country: 'Colombia', country_iso: 'CO' },
      },
      purchase: {
        transaction: 'HP123456789',
        status: 'APPROVED',
        approved_date: 1786000000000,
        order_date: 1785999000000,
        price: { value: 397, currency_value: 'BRL' },
        offer: { code: 'x7k2p9' },
        payment: { type: 'CREDIT_CARD', installments_number: 12 },
        checkout_country: { name: 'Colombia', iso: 'CO' },
        origin: { xcod: 'xc-1', sck: 'sck-1', src: 'src-1' },
        commissions: [
          { source: 'PRODUCER', value: 300, currency_value: 'BRL' },
          { source: 'AFFILIATE', value: 50, currency_value: 'BRL' },
        ],
        ...compraOver,
      },
    },
    ...over,
  };
}

// ════════════════════════════════════════════════════════════
seccion('Instantes: Hotmart manda epoch en milisegundos');
// ════════════════════════════════════════════════════════════
check('epoch ms', instanteISO(1786000000000) === new Date(1786000000000).toISOString());
// Un epoch en segundos de una fecha real cabe en 10 dígitos; interpretarlo como
// ms lo llevaría a 1970 y la venta caería en una fecha imposible.
check('epoch s se escala a ms', instanteISO(1786000000) === new Date(1786000000000).toISOString());
check('string ISO', instanteISO('2026-08-10T12:00:00Z') === '2026-08-10T12:00:00.000Z');
check('string numérico', instanteISO('1786000000000') === new Date(1786000000000).toISOString());
check('basura → null', instanteISO('no es fecha') === null);
check('null → null', instanteISO(null) === null);

// ════════════════════════════════════════════════════════════
seccion('El fallback «?? approved» ya no inventa facturación');
// ════════════════════════════════════════════════════════════
// BUG REAL (hotmart-parser.ts:114): cualquier evento desconocido que trajera un
// objeto `purchase` se guardaba como venta APROBADA. Un evento nuevo de Hotmart
// inflaba el revenue y el número parecía plausible.
const inventado = parsearWebhook(webhook({ event: 'PURCHASE_TELETRANSPORTED' }), AHORA);
check('evento desconocido NO produce venta', !inventado.ok);
check(
  'evento desconocido no se marca aprobada',
  !inventado.ok && inventado.motivo === 'no_venta',
  JSON.stringify(inventado)
);

// El segundo término del mapa viejo era código muerto: indexaba por nombre de
// evento un valor que venía con el vocabulario de `purchase.status`.
check('el mapa de eventos no reconoce un status de la API', estadoDeEvento('APPROVED') === null);
check(
  'el mapa de la API no reconoce un nombre de evento',
  estadoDeStatusApi('PURCHASE_APPROVED') === null
);
check(
  'cada mapa reconoce lo suyo',
  estadoDeEvento('PURCHASE_APPROVED') === 'aprobada' && estadoDeStatusApi('APPROVED') === 'aprobada'
);

// ════════════════════════════════════════════════════════════
seccion('Eventos que no son ventas: 200, no 422');
// ════════════════════════════════════════════════════════════
// BUG REAL: estos eventos no traen `data.purchase`, así que el parser devolvía
// error, la ruta respondía 422 y escribía `last_error` en la integración. La
// tarjeta de la UI quedaba en rojo PERMANENTE aunque la ingesta funcionara.
for (const ev of [
  'SUBSCRIPTION_CANCELLATION',
  'SWITCH_PLAN',
  'UPDATE_SUBSCRIPTION_CHARGE_DATE',
  'CLUB_FIRST_ACCESS',
  'CLUB_MODULE_COMPLETED',
]) {
  const r = parsearWebhook({ event: ev, data: { subscription: { status: 'CANCELLED' } } }, AHORA);
  check(`${ev} → no_venta (no error)`, !r.ok && r.motivo === 'no_venta');
  check(`${ev} se clasifica como no_venta`, clasificarEvento(ev) === 'no_venta');
}
// Un payload de verdad ilegible SÍ debe reportarse: es lo único que merece
// ensuciar `last_error`.
const roto = parsearWebhook({ event: 'PURCHASE_APPROVED', data: {} }, AHORA);
check('un PURCHASE_* sin purchase sí es ilegible', !roto.ok && roto.motivo === 'ilegible');
check(
  'un payload que no es objeto es ilegible',
  (() => {
    const r = parsearWebhook('hola', AHORA);
    return !r.ok && r.motivo === 'ilegible';
  })()
);

// ════════════════════════════════════════════════════════════
seccion('Order bump y oferta: los campos REALES de 2.0.0');
// ════════════════════════════════════════════════════════════
// BUG REAL (hotmart-parser.ts:124-127): buscaba `purchase.is_bump` e
// `is_upsell`, claves que no existen en el payload. `transaction_type` era
// SIEMPRE 'principal'.
const vBase = venta(parsearWebhook(webhook(), AHORA))!;
check('captura offer.code', vBase.oferta_codigo === 'x7k2p9');
check('sin order_bump → es_order_bump false', vBase.es_order_bump === false);

const vBump = venta(
  parsearWebhook(
    webhook(
      {},
      {
        order_bump: { is_order_bump: true, parent_purchase_transaction: 'HP000PADRE' },
      }
    ),
    AHORA
  )
)!;
check('order_bump.is_order_bump se lee', vBump.es_order_bump === true);
check('el padre del bump se captura', vBump.parent_transaction_id === 'HP000PADRE');

const vUpsell = venta(
  parsearWebhook(
    webhook(
      {},
      {
        parent_purchase_transaction: 'HP000PADRE',
      }
    ),
    AHORA
  )
)!;
check('parent_purchase_transaction se captura', vUpsell.parent_transaction_id === 'HP000PADRE');
check('un upsell no se marca como order bump', vUpsell.es_order_bump === false);

// Las claves inventadas del parser viejo no deben tener ningún efecto.
const vFalsas = venta(parsearWebhook(webhook({}, { is_bump: true, is_upsell: true }), AHORA))!;
check(
  'is_bump/is_upsell (que no existen en Hotmart) se ignoran',
  vFalsas.es_order_bump === false && vFalsas.parent_transaction_id === null
);

// ════════════════════════════════════════════════════════════
seccion('El documento del comprador ya no viaja como teléfono');
// ════════════════════════════════════════════════════════════
// BUG REAL (hotmart-parser.ts:137-138): `customer_phone` caía a
// `buyer.document`, y ese valor se hasheaba y se enviaba a Meta CAPI COMO
// TELÉFONO. Un CPF/CC nunca matchea: solo degradaba la calidad del evento.
const sinTel = venta(
  parsearWebhook(
    {
      ...webhook(),
      data: {
        ...webhook().data,
        buyer: { name: 'Sin Teléfono', email: 'x@y.com', document: '1020304050' },
      },
    },
    AHORA
  )
)!;
check('sin teléfono, el teléfono queda null', sinTel.comprador_telefono === null);
check('el documento va a su propia columna', sinTel.comprador_doc === '1020304050');
check('con teléfono, se usa el teléfono', vBase.comprador_telefono === '573001112233');
check('el documento se guarda aunque haya teléfono', vBase.comprador_doc === '1020304050');

// ════════════════════════════════════════════════════════════
seccion('sck / src / xcod tienen columnas propias');
// ════════════════════════════════════════════════════════════
// Antes solo se usaban como relleno de utm_content/utm_source/click_id, así que
// era imposible distinguir un UTM real de un parámetro de Hotmart.
check('src en su columna', vBase.src === 'src-1');
check('sck en su columna', vBase.sck === 'sck-1');
check('xcod en su columna', vBase.xcod === 'xc-1');
check('sin utm_source, cae a src', vBase.utm_source === 'src-1');
check('sin utm_content, cae a sck', vBase.utm_content === 'sck-1');
check('sin click_id, cae a xcod', vBase.click_id === 'xc-1');

// `purchase.origin` es la ubicación canónica en 2.0.0 y el parser viejo NO la
// miraba: solo `tracking`, `customData` y la raíz.
const conUtmReal = venta(
  parsearWebhook(
    webhook(
      {},
      {
        customData: { utm_source: 'facebook', utm_campaign: 'lanzamiento-agosto' },
      }
    ),
    AHORA
  )
)!;
check('un UTM real gana sobre src', conUtmReal.utm_source === 'facebook');
check('el src se conserva igualmente', conUtmReal.src === 'src-1');
check('utm_campaign se lee de customData', conUtmReal.utm_campaign === 'lanzamiento-agosto');

// ════════════════════════════════════════════════════════════
seccion('Fecha de venta: día Colombia materializado');
// ════════════════════════════════════════════════════════════
// Las 02:00 UTC son las 21:00 del día ANTERIOR en Colombia. Aquí es donde se
// acaban las tres definiciones de fecha que competían en el módulo.
const nocturna = venta(
  parsearWebhook(
    webhook(
      {},
      {
        approved_date: Date.parse('2026-08-08T02:00:00Z'),
      }
    ),
    AHORA
  )
)!;
check(
  '02:00 UTC cuenta como el día anterior en Colombia',
  nocturna.fecha_venta === '2026-08-07',
  nocturna.fecha_venta
);
const diurna = venta(
  parsearWebhook(
    webhook(
      {},
      {
        approved_date: Date.parse('2026-08-08T18:00:00Z'),
      }
    ),
    AHORA
  )
)!;
check(
  '18:00 UTC cuenta como el mismo día',
  diurna.fecha_venta === '2026-08-08',
  diurna.fecha_venta
);

// ════════════════════════════════════════════════════════════
seccion('Estados y reembolsos');
// ════════════════════════════════════════════════════════════
for (const [ev, esperado] of [
  ['PURCHASE_APPROVED', 'aprobada'],
  ['PURCHASE_COMPLETE', 'completa'],
  ['PURCHASE_REFUNDED', 'reembolsada'],
  ['PURCHASE_CHARGEBACK', 'chargeback'],
  ['PURCHASE_CANCELED', 'cancelada'],
  ['PURCHASE_EXPIRED', 'expirada'],
  ['PURCHASE_BILLET_PRINTED', 'pendiente'],
] as const) {
  const v = venta(parsearWebhook(webhook({ event: ev }), AHORA));
  check(`${ev} → ${esperado}`, v?.estado === esperado, v?.estado);
}
const reemb = venta(parsearWebhook(webhook({ event: 'PURCHASE_REFUNDED' }), AHORA))!;
check('un reembolso sella reembolsada_at', reemb.reembolsada_at !== null);
// El importe original NO se toca: es lo que permite calcular la tasa de
// reembolso en vez de perder la venta.
check('un reembolso conserva el bruto', reemb.bruto === 397);
check('una venta aprobada no tiene reembolsada_at', vBase.reembolsada_at === null);

// ════════════════════════════════════════════════════════════
seccion('Comisiones: las dos formas en que Hotmart las anida');
// ════════════════════════════════════════════════════════════
const comWebhook = comisionesPendientes.get(vBase)!;
check('webhook: comisión plana del productor', comWebhook.productor === 300);
check('webhook: comisión plana del afiliado', comWebhook.afiliado === 50);
check('webhook: sin coproductor → null', comWebhook.coproductor === null);

// `sales/commissions` las anida bajo `commission`. Leer solo la forma plana
// devolvía 0 en silencio para todo el camino de la API.
const itemHist: ItemHistorial = {
  purchase: {
    transaction: 'HP123456789',
    status: 'APPROVED',
    approved_date: 1786000000000,
    price: { value: 397, currency_code: 'BRL' },
    offer: { code: 'x7k2p9' },
    payment: { type: 'BILLET' },
  },
  buyer: { name: 'Ana Pérez', email: 'ana@ejemplo.com' },
  product: { id: 1234567, name: 'Camaradictos Pro' },
};
const itemCom: ItemComisiones = {
  transaction: 'HP123456789',
  commissions: [
    { source: 'PRODUCER', commission: { value: 300, currency_code: 'BRL' } },
    { source: 'COPRODUCER', commission: { value: 20, currency_code: 'BRL' } },
  ],
};
const rApi = parsearApi(itemHist, itemCom, { ahora: AHORA });
check('parsearApi devuelve una venta', rApi.ok);
const vApi = rApi.ok ? rApi.venta : null;
const comApi = vApi ? comisionesPendientes.get(vApi)! : null;
check('api: comisión anidada del productor', comApi?.productor === 300);
check('api: comisión anidada del coproductor', comApi?.coproductor === 20);
check('api: sin afiliado → null', comApi?.afiliado === null);

// ════════════════════════════════════════════════════════════
seccion('Los dos orígenes producen la MISMA forma');
// ════════════════════════════════════════════════════════════
// Es el invariante que permite que `ON CONFLICT (cliente_id, transaction_id)`
// fusione lo que sabe el webhook con lo que sabe la API.
check('mismo transaction_id', vApi!.transaction_id === vBase.transaction_id);
check('mismo bruto', vApi!.bruto === vBase.bruto);
check('misma moneda', vApi!.moneda === vBase.moneda);
check('misma oferta', vApi!.oferta_codigo === vBase.oferta_codigo);
check('mismo producto', vApi!.producto_nombre === vBase.producto_nombre);
check('misma fecha de venta', vApi!.fecha_venta === vBase.fecha_venta);
check(
  'las claves coinciden exactamente',
  JSON.stringify(Object.keys(vApi!).sort()) === JSON.stringify(Object.keys(vBase).sort())
);
check('el origen los distingue', vBase.origen === 'webhook' && vApi!.origen === 'api');
// El crudo se guarda solo en el camino del webhook: es el que sirve para
// depurar, y duplicarlo desde la API sería espacio tirado.
check('la API no guarda raw_payload', vApi!.raw_payload === null);
check('el webhook sí guarda raw_payload', vBase.raw_payload !== null);

// ════════════════════════════════════════════════════════════
seccion('La API traduce su propio vocabulario de estados');
// ════════════════════════════════════════════════════════════
for (const [status, esperado] of [
  ['APPROVED', 'aprobada'],
  ['COMPLETE', 'completa'],
  ['REFUNDED', 'reembolsada'],
  ['CHARGEBACK', 'chargeback'],
  ['CANCELLED', 'cancelada'],
  ['EXPIRED', 'expirada'],
] as const) {
  const r = parsearApi({ ...itemHist, purchase: { ...itemHist.purchase, status } }, undefined, {
    ahora: AHORA,
  });
  check(`status ${status} → ${esperado}`, r.ok && r.venta.estado === esperado);
}
check(
  'la API sin transacción es ilegible',
  (() => {
    const r = parsearApi({ purchase: { status: 'APPROVED' } }, undefined, { ahora: AHORA });
    return !r.ok;
  })()
);

// ════════════════════════════════════════════════════════════
seccion('Método de pago, cuotas y país de checkout');
// ════════════════════════════════════════════════════════════
// Ninguno de los tres se capturaba en ninguna de las dos vías.
check('método de pago', vBase.pago_tipo === 'CREDIT_CARD');
check('número de cuotas', vBase.pago_cuotas === 12);
check('país del checkout', vBase.checkout_pais === 'CO');
check('país del comprador', vBase.comprador_pais === 'CO');
check('la API también lee el método de pago', vApi!.pago_tipo === 'BILLET');

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
