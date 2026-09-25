/**
 * Comprobaciones del webhook de Hotmart: lo que se espeja en `sales_events` y
 * lo que se avisa (auditoría del 2026-09-25).
 *
 * Todo PURO: no toca la base ni la red. Las decisiones del webhook viven como
 * funciones puras en `src/lib/report-utm/hotmart-parser.ts` justamente para
 * poder probarlas aquí; la ruta solo las orquesta.
 *
 *   npx tsx --conditions=react-server scripts/verify-hotmart-webhook.ts
 */

import { readFileSync } from 'node:fs';
import { parsearWebhook } from '../src/lib/hotmart/parser';
import { ESTADO_POR_EVENTO } from '../src/lib/hotmart/eventos';
import type { VentaHotmart } from '../src/lib/hotmart/tipos';
import {
  aEventoLegacy,
  clickIdsExplicitos,
  decidirAviso,
  decidirEspejo,
  estadoAviso,
  tipoSaliente,
  type EstadoAviso,
  type EstadoLegacy,
} from '../src/lib/report-utm/hotmart-parser';
import { salir } from './_salida';

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

// ── Fixtures ────────────────────────────────────────────────────
// Payload 2.0.0 de Hotmart, recortado a lo que el parser lee.
function webhook(
  evento: string,
  compraOver: Record<string, unknown> = {},
  datosOver: Record<string, unknown> = {}
) {
  return {
    id: 'evt-1',
    event: evento,
    version: '2.0.0',
    creation_date: 1786000000000,
    data: {
      product: { id: 1234567, name: 'Camaradictos Pro' },
      buyer: { name: 'Ana Pérez', email: 'ana@ejemplo.com' },
      purchase: {
        transaction: 'HP123456789',
        approved_date: 1786000000000,
        order_date: 1785999000000,
        price: { value: 397, currency_value: 'CLP' },
        ...compraOver,
      },
      ...datosOver,
    },
  };
}

function venta(evento: string, compraOver: Record<string, unknown> = {}): VentaHotmart {
  const r = parsearWebhook(webhook(evento, compraOver));
  if (!r.ok) throw new Error(`el fixture ${evento} no parsea: ${JSON.stringify(r)}`);
  return r.venta;
}

// ════════════════════════════════════════════════════════════
seccion('VentaHotmart → sales_events: estados');
// ════════════════════════════════════════════════════════════
// BUG REAL: `cancelada` se guardaba como 'refunded'. Un pedido que nunca se
// cobró inflaba la tasa de reembolsos y mandaba «Venta reembolsada».
check(
  'PURCHASE_CANCELED → canceled (no refunded)',
  aEventoLegacy(venta('PURCHASE_CANCELED')).status === 'canceled',
  aEventoLegacy(venta('PURCHASE_CANCELED')).status
);
check(
  'PURCHASE_COMPLETE → approved',
  aEventoLegacy(venta('PURCHASE_COMPLETE')).status === 'approved'
);
check(
  'PURCHASE_APPROVED → approved',
  aEventoLegacy(venta('PURCHASE_APPROVED')).status === 'approved'
);
check(
  'PURCHASE_REFUNDED → refunded',
  aEventoLegacy(venta('PURCHASE_REFUNDED')).status === 'refunded'
);
check(
  'PURCHASE_CHARGEBACK → chargeback',
  aEventoLegacy(venta('PURCHASE_CHARGEBACK')).status === 'chargeback'
);
check(
  'PURCHASE_EXPIRED → pending (nunca cobrada, pero tampoco reembolso)',
  aEventoLegacy(venta('PURCHASE_EXPIRED')).status === 'pending'
);

// Todo evento de venta produce un status que el filtro de /ventas conoce.
const paginaVentas = readFileSync('src/app/(app)/ventas/page.tsx', 'utf8');
const LEGACY: EstadoLegacy[] = ['approved', 'pending', 'refunded', 'chargeback', 'canceled'];
for (const evento of Object.keys(ESTADO_POR_EVENTO)) {
  const s = aEventoLegacy(venta(evento)).status;
  check(`${evento} → un status conocido (${s})`, LEGACY.includes(s));
}
for (const s of LEGACY) {
  check(`el filtro de /ventas ofrece «${s}»`, paginaVentas.includes(`value="${s}"`));
}

// ════════════════════════════════════════════════════════════
seccion('VentaHotmart → sales_events: divisa');
// ════════════════════════════════════════════════════════════
// BUG REAL: `venta.moneda ?? 'BRL'`. Una venta sin divisa se mandaba a Meta y a
// Google como reales brasileños.
check('con divisa, se conserva', aEventoLegacy(venta('PURCHASE_APPROVED')).currency === 'CLP');
check(
  'sin divisa → null (no BRL)',
  aEventoLegacy(venta('PURCHASE_APPROVED', { price: { value: 397 } })).currency === null,
  String(aEventoLegacy(venta('PURCHASE_APPROVED', { price: { value: 397 } })).currency)
);

// ════════════════════════════════════════════════════════════
seccion('Avisos: qué estado avisa y con qué webhook saliente');
// ════════════════════════════════════════════════════════════
check('approved → cobrada', estadoAviso('approved') === 'cobrada');
check('canceled → nada que avisar', estadoAviso('canceled') === null);
check('canceled → sin webhook saliente', tipoSaliente('canceled') === null);
check('approved → sale.approved', tipoSaliente('approved') === 'sale.approved');
check('refunded → sale.refunded', tipoSaliente('refunded') === 'sale.refunded');
check('status desconocido → nada', estadoAviso('lo-que-sea') === null);
check('status null → nada', estadoAviso(null) === null);

// ════════════════════════════════════════════════════════════
seccion('Avisos: deduplicación (sin 089, contra el estado previo)');
// ════════════════════════════════════════════════════════════
const previo = (status: EstadoLegacy, estadoPrevio: string | null) =>
  decidirAviso({ status, modo: 'estado_previo', estadoPrevio });

check('primera vez aprobada → avisar', previo('approved', null).accion === 'avisar');
// BUG REAL: PURCHASE_COMPLETE llega días después del APPROVED, también mapea a
// 'approved', y mandaba una segunda «Venta aprobada».
check(
  'COMPLETE tras APPROVED (approved sobre approved) → nada',
  (() => {
    const d = previo(aEventoLegacy(venta('PURCHASE_COMPLETE')).status, 'approved');
    return d.accion === 'nada' && d.motivo === 'ya_avisado';
  })()
);
check('reintento de APPROVED → nada', previo('approved', 'approved').accion === 'nada');
check('pendiente → aprobada → avisar', previo('approved', 'pending').accion === 'avisar');
check('aprobada → reembolsada → avisar', previo('refunded', 'approved').accion === 'avisar');
check('reintento de REFUNDED → nada', previo('refunded', 'refunded').accion === 'nada');
check('cancelada → nunca avisa', previo('canceled', null).accion === 'nada');
check('cancelada → aprobada → avisar', previo('approved', 'canceled').accion === 'avisar');

// ════════════════════════════════════════════════════════════
seccion('Avisos: deduplicación (con 089, reclamo atómico)');
// ════════════════════════════════════════════════════════════
check(
  'aprobada → reclamar «cobrada» (y avisar si se gana)',
  (() => {
    const d = decidirAviso({ status: 'approved', modo: 'reclamo' });
    return d.accion === 'reclamar' && d.estado === 'cobrada' && !d.soloAnotar;
  })()
);
check(
  'COMPLETE reclama el MISMO estado que APPROVED',
  (() => {
    const a = decidirAviso({ status: 'approved', modo: 'reclamo' });
    const c = decidirAviso({
      status: aEventoLegacy(venta('PURCHASE_COMPLETE')).status,
      modo: 'reclamo',
    });
    return a.accion === 'reclamar' && c.accion === 'reclamar' && a.estado === c.estado;
  })()
);
check(
  'cancelada → no reclama nada',
  decidirAviso({ status: 'canceled', modo: 'reclamo' }).accion === 'nada'
);
// Transición: venta avisada ANTES de aplicar la 089 (notificado_estado NULL).
// Su PURCHASE_COMPLETE ganaría el reclamo; el estado previo lo frena.
check(
  'con 089 y el estado previo ya avisado → se reclama solo para anotar',
  (() => {
    const d = decidirAviso({ status: 'approved', modo: 'reclamo', estadoPrevio: 'approved' });
    return d.accion === 'reclamar' && d.soloAnotar === true;
  })()
);
check(
  'con 089 y un estado previo distinto → se reclama para avisar',
  (() => {
    const d = decidirAviso({ status: 'refunded', modo: 'reclamo', estadoPrevio: 'approved' });
    return d.accion === 'reclamar' && d.soloAnotar === false;
  })()
);

/**
 * Simula la ruta: `notificado_estado` con la MISMA condición que su UPDATE
 * (`IS NULL OR <> X`) y `sales_events.status` leído antes de cada upsert.
 * Devuelve los estados por los que se avisó.
 */
function simular(
  secuencia: string[],
  inicio: { notificado: EstadoAviso | null; previo: string | null }
): string[] {
  let notificado = inicio.notificado;
  let previo = inicio.previo;
  const avisos: string[] = [];
  for (const evento of secuencia) {
    const status = aEventoLegacy(venta(evento)).status;
    const d = decidirAviso({ status, modo: 'reclamo', estadoPrevio: previo });
    previo = status; // el upsert en sales_events
    if (d.accion !== 'reclamar') continue;
    const gana = notificado === null || notificado !== d.estado;
    if (gana) notificado = d.estado;
    if (gana && !d.soloAnotar) avisos.push(d.estado);
  }
  return avisos;
}

{
  const avisos = simular(
    [
      'PURCHASE_BILLET_PRINTED',
      'PURCHASE_APPROVED',
      'PURCHASE_APPROVED', // reintento
      'PURCHASE_COMPLETE',
      'PURCHASE_REFUNDED',
      'PURCHASE_REFUNDED', // reintento
    ],
    { notificado: null, previo: null }
  );
  check(
    'boleto → aprobada ×2 → completa → reembolso ×2 = tres avisos',
    avisos.join(',') === 'pendiente,cobrada,reembolsada',
    avisos.join(',')
  );
}
{
  // Aprobada y avisada sin la 089; la 089 se aplica; llegan COMPLETE y REFUNDED.
  const avisos = simular(['PURCHASE_COMPLETE', 'PURCHASE_REFUNDED'], {
    notificado: null,
    previo: 'approved',
  });
  check(
    'transición a la 089: COMPLETE no re-avisa, REFUNDED sí',
    avisos.join(',') === 'reembolsada',
    avisos.join(',')
  );
}

// ════════════════════════════════════════════════════════════
seccion('Espejo en sales_events');
// ════════════════════════════════════════════════════════════
// Solo si `hotmart_ventas` aplicó el evento como el más reciente. Un reintento
// viejo del APPROVED después del REFUNDED devolvía la venta a 'approved' en
// sales_events y volvía a mandar «Venta aprobada».
check(
  'escrita = false → NO se espeja',
  decidirEspejo({ hayPuente: true, guardado: { escrita: false } }) === false
);
check(
  'escrita = true → se espeja',
  decidirEspejo({ hayPuente: true, guardado: { escrita: true } }) === true
);
check(
  'sin puente → se espeja (el evento no se pierde)',
  decidirEspejo({ hayPuente: false, guardado: null }) === true
);
check(
  'la escritura en hotmart_ventas lanzó → se espeja (respaldo)',
  decidirEspejo({ hayPuente: true, guardado: null }) === true
);

// ════════════════════════════════════════════════════════════
seccion('Click ids: solo con nombre explícito');
// ════════════════════════════════════════════════════════════
// BUG REAL: Google Ads recibía `parsed.click_id` como gclid (podía ser un
// fbclid, y antes hasta el `xcod`) y Meta lo mismo como `fbc`.
check(
  'gclid en tracking → gclid',
  clickIdsExplicitos(webhook('PURCHASE_APPROVED', { tracking: { gclid: 'G-1' } })).gclid === 'G-1'
);
check(
  'fbclid en customData → fbclid',
  clickIdsExplicitos(webhook('PURCHASE_APPROVED', { customData: { fbclid: 'F-1' } })).fbclid ===
    'F-1'
);
check(
  'un fbclid NO se usa como gclid',
  clickIdsExplicitos(webhook('PURCHASE_APPROVED', { tracking: { fbclid: 'F-1' } })).gclid === null
);
check(
  'un gclid NO se usa como fbclid',
  clickIdsExplicitos(webhook('PURCHASE_APPROVED', { tracking: { gclid: 'G-1' } })).fbclid === null
);
check(
  'solo xcod → ni gclid ni fbclid',
  (() => {
    const c = clickIdsExplicitos(webhook('PURCHASE_APPROVED', { origin: { xcod: 'xc-1' } }));
    return c.gclid === null && c.fbclid === null;
  })()
);
check(
  'un `click_id` genérico → ni gclid ni fbclid',
  (() => {
    const c = clickIdsExplicitos(webhook('PURCHASE_APPROVED', { tracking: { click_id: 'X-1' } }));
    return c.gclid === null && c.fbclid === null;
  })()
);
check(
  'payload basura → nulls, sin lanzar',
  (() => {
    const c = clickIdsExplicitos('no es un objeto');
    return c.gclid === null && c.fbclid === null;
  })()
);

// ════════════════════════════════════════════════════════════
seccion('Guardarraíl estático: la ruta usa las decisiones');
// ════════════════════════════════════════════════════════════
const ruta = readFileSync('src/app/api/report-utm/webhooks/hotmart/[clienteId]/route.ts', 'utf8');
const pos = (s: string) => ruta.indexOf(s);
check('valida contra el hottok de Hotmart', ruta.includes('hottokHotmart:'));
check(
  'atribuye ANTES de guardar',
  pos('atribuirLote(') > 0 && pos('atribuirLote(') < pos('guardarVenta(')
);
check(
  'decide el espejo ANTES del upsert en sales_events',
  pos('decidirEspejo(') > 0 && pos('decidirEspejo(') < pos('.upsert(')
);
check('deduplica los avisos', ruta.includes('decidirAviso(') && ruta.includes('notificado_estado'));
check(
  'reagrega el dashboard en after()',
  /after\(async \(\) => \{\s*await reagregarFechasHotmart/.test(ruta)
);
check('el fbc de Meta sale de un fbclid explícito', ruta.includes('fbclid: clicks.fbclid'));
check('Google Ads ya no cae a parsed.click_id', !/gclid\s*=\s*\n?\s*parsed\.click_id/.test(ruta));

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
salir(fallos);
