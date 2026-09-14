/**
 * Comprobaciones puras de las piezas nuevas de la Fase 3-4 (reunión del
 * 2026-09-08): moneda de reporte, estado de cuenta de Meta, ventas del CRM de
 * GoHighLevel y conversiones personalizadas de Meta en el BI.
 *
 * Nada de Postgres ni de red: los conversores, los intérpretes y los agregadores
 * son puros y se prueban con datos a mano.
 *
 *   npx tsx --conditions=react-server scripts/verify-moneda-y-ventas.ts
 */

import {
  crearConversor,
  conversorIdentidad,
  convertirFilasMetricas,
  leerMonedaReporte,
  esMonedaReporte,
} from '../src/lib/moneda-reporte';
import { interpretarEstadoCuenta } from '../src/lib/meta/estado-cuenta';
import { cuentasMetaDe, mensajeAlerta } from '../src/lib/meta/alerta-cuenta';
import { leerVentaGhl, esVentaGanada, numero } from '../src/lib/report-utm/ghl-ventas';
import {
  agruparVentasCrm,
  inyectarVentasCrm,
  CLAVE_CRM_VENTAS,
  CLAVE_CRM_REVENUE,
} from '../src/lib/dashboard/ventas-crm';
import {
  agregarMetaCustomConv,
  aplicarMetaCustomConv,
} from '../src/lib/report-utm/bi/meta-custom-conv';
import {
  isMetaCcMetric,
  parseMetaCcMetric,
  makeMetaCcMetric,
} from '../src/lib/report-utm/bi-metadata';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ── 1. Moneda de reporte ──────────────────────────────────────────────
console.log('\n1. Moneda de reporte');
check('por defecto USD', leerMonedaReporte({}) === 'USD' && leerMonedaReporte(null) === 'USD');
check('lee la del config en mayúsculas', leerMonedaReporte({ moneda_reporte: 'clp' }) === 'CLP');
check('una moneda no admitida cae a USD', leerMonedaReporte({ moneda_reporte: 'XYZ' }) === 'USD');
check('esMonedaReporte', esMonedaReporte('CLP') && !esMonedaReporte('BTC'));

// usd_rate = USD por 1 CLP. 900 CLP = 1 USD → usd_rate = 1/900.
const tasas = [
  { fecha: '2026-08-06', usd_rate: 1 / 900 },
  { fecha: '2026-08-20', usd_rate: 1 / 950 },
];
const clp = crearConversor('CLP', tasas);
check('la tasa exacta del día', clp.convertir(10, '2026-08-06') === 9000);
check('otro día con su propia tasa (congelada)', clp.convertir(10, '2026-08-20') === 9500);
check('día sin fila usa la última ANTERIOR conocida', clp.convertir(10, '2026-08-15') === 9000);
check('día anterior a todo usa la primera posterior', clp.convertir(10, '2026-08-01') === 9000);
check('cero se queda en cero', clp.convertir(0, '2026-08-06') === 0);
const sin = crearConversor('CLP', []);
check(
  'sin ninguna tasa NO convierte a 0: deja el USD',
  sin.convertir(12.81, '2026-08-20') === 12.81
);
check('y lo anota como sin tasa', sin.sinTasa.has('2026-08-20'));
check('USD es identidad', conversorIdentidad().convertir(12.81, 'x') === 12.81);

const filas = [
  {
    fecha: '2026-08-20',
    ventas_principal: 9.7,
    ventas_bump: 3.11,
    meta_spend: 32000,
    ventas_principal_count: 1,
  },
];
const conv = convertirFilasMetricas(filas, clp);
check(
  'convierte solo el dinero de Hotmart (9,70 USD → 9.215 CLP)',
  conv[0].ventas_principal === 9215 && conv[0].ventas_bump === 2954.5
);
check('el gasto de la cuenta NO se toca', conv[0].meta_spend === 32000);
check('los conteos NO se tocan', conv[0].ventas_principal_count === 1);
check('no muta la fila original', filas[0].ventas_principal === 9.7);
check(
  'con moneda USD las filas salen idénticas',
  convertirFilasMetricas(filas, conversorIdentidad()) === filas
);

// ── 2. Estado de cuenta de Meta ───────────────────────────────────────
console.log('\n2. Estado de cuenta de Meta');
const activa = interpretarEstadoCuenta({ account_id: '123', account_status: 1, currency: 'CLP' });
check('activa no está bloqueada', !activa.bloqueada && activa.moneda === 'CLP');
const impaga = interpretarEstadoCuenta({ id: 'act_456', name: 'Cris', account_status: 3 });
check('pago pendiente = bloqueada y por pago', impaga.bloqueada && impaga.porPago);
check('el id se normaliza sin act_', impaga.account_id === '456');
const inhab = interpretarEstadoCuenta({ account_status: 2, disable_reason: 3 });
check('inhabilitada por riesgo de pago = por pago', inhab.bloqueada && inhab.porPago);
check('el texto dice el motivo', inhab.texto.includes('Riesgo de pago'));
const gracia = interpretarEstadoCuenta({ account_status: 9 });
check('periodo de gracia avisa como pago pero aún publica', !gracia.bloqueada && gracia.porPago);
check('estado desconocido no dispara nada', !interpretarEstadoCuenta({}).bloqueada);
check(
  'cuentas del cliente sin duplicados ni sin token',
  cuentasMetaDe({
    meta_token: 't',
    meta_accounts: [{ account_id: 'act_1' }, { account_id: '1' }, { account_id: '2', token: '' }],
  }).length === 2
);
check(
  'el mensaje nombra la cuenta y el pago',
  mensajeAlerta('Cris', [impaga]).includes('Cris') &&
    mensajeAlerta('Cris', [impaga]).includes('pago')
);

// ── 3. Venta del CRM de GoHighLevel ───────────────────────────────────
console.log('\n3. Venta de GoHighLevel');
const v1 = leerVentaGhl({
  contact_id: 'c1',
  opportunity: { id: 'o1', status: 'won', monetary_value: '1.500.000', name: 'Asesoría' },
});
check(
  'lee contacto, oportunidad y nombre',
  v1.contactId === 'c1' && v1.oportunidadId === 'o1' && v1.nombre === 'Asesoría'
);
check('entiende importes con puntos de miles', v1.importe === 1500000);
const v2 = leerVentaGhl({
  contactId: 'c2',
  opportunityId: 'o2',
  monetaryValue: 250,
  status: 'Won',
});
check(
  'acepta las variantes camelCase',
  v2.oportunidadId === 'o2' && v2.importe === 250 && v2.estado === 'won'
);
check(
  'importes en todos los formatos del CRM',
  numero('1.500') === 1500 &&
    numero('1,500.50') === 1500.5 &&
    numero('12.345,67') === 12345.67 &&
    numero('1500,5') === 1500.5 &&
    numero('$ 250') === 250 &&
    numero(99.9) === 99.9 &&
    numero('') === null
);
check('won es venta', esVentaGanada('won'));
check('lost NO es venta', !esVentaGanada('lost'));
check('open NO es venta', !esVentaGanada('open'));
check('sin estado (el Workflow ya filtra por etapa) sí es venta', esVentaGanada(null));

// ── 4. Ventas del CRM en el dashboard clásico ─────────────────────────
console.log('\n4. Ventas del CRM en el dashboard');
const porDia = agruparVentasCrm([
  { sale_timestamp: '2026-08-20T15:00:00Z', amount: 100 },
  { sale_timestamp: '2026-08-20T20:00:00Z', amount: 50 },
  // 03:00 UTC del 21 = 22:00 del 20 en Colombia.
  { sale_timestamp: '2026-08-21T03:00:00Z', amount: 25 },
  { sale_timestamp: '2026-08-22T15:00:00Z', amount: 10 },
]);
check('agrupa por día COLOMBIA', porDia.get('2026-08-20')?.ventas === 3);
check('suma el importe', porDia.get('2026-08-20')?.importe === 175);
const inyectadas = inyectarVentasCrm(
  [
    { fecha: '2026-08-20', meta_spend: 10 },
    { fecha: '2026-08-21', meta_spend: 5 },
  ],
  porDia
);
check(
  'inyecta en la fila de su día',
  (inyectadas[0] as Record<string, unknown>)[CLAVE_CRM_VENTAS] === 3 &&
    (inyectadas[0] as Record<string, unknown>)[CLAVE_CRM_REVENUE] === 175
);
check('un día sin ventas no cambia', !(CLAVE_CRM_VENTAS in inyectadas[1]));
check(
  'un día con ventas y sin fila se añade',
  inyectadas.some((f) => f.fecha === '2026-08-22')
);
check(
  'sin ventas del CRM las filas no cambian',
  inyectarVentasCrm([{ fecha: 'x' }], new Map()).length === 1
);

// ── 5. Conversiones personalizadas de Meta en el BI ───────────────────
console.log('\n5. Conversiones personalizadas');
const tok = makeMetaCcMetric('lead_calificado');
check('token metacc', isMetaCcMetric(tok) && parseMetaCcMetric(tok) === 'lead_calificado');
check('metacc: sin clave no es token', !isMetaCcMetric('metacc:'));
const dias = [
  {
    fecha: '2026-08-20',
    meta_campaigns: [
      { name: 'Camp A', custom_conversions: { lead_calificado: 3, otra: 9 } },
      { name: 'Camp B', custom_conversions: { lead_calificado: 1 } },
      { name: 'Camp C' },
    ],
  },
  {
    fecha: '2026-08-21',
    meta_campaigns: [{ name: 'Camp A', custom_conversions: { lead_calificado: 2 } }],
  },
];
const total = agregarMetaCustomConv(dias, [tok], () => 'total');
check('total suma todas las campañas y días', total.get('total')?.[tok] === 6);
const porCamp = agregarMetaCustomConv(dias, [tok], (_f, c) => c);
check('por campaña', porCamp.get('Camp A')?.[tok] === 5 && porCamp.get('Camp B')?.[tok] === 1);
check('una campaña sin conversiones no genera fila', !porCamp.has('Camp C'));
const aplicadas = aplicarMetaCustomConv([{ dimension_value: 'Camp A', spend: 100 }], porCamp, [
  tok,
]);
check('se suma a la fila existente', (aplicadas[0] as Record<string, unknown>)[tok] === 5);
check('y añade la campaña que solo tenía conversiones', aplicadas.length === 2);

console.log(
  fallos === 0
    ? '\n✅ Moneda, cuentas de Meta, ventas del CRM y conversiones: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
