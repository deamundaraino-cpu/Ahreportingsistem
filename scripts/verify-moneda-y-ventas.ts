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
  tasaPromedio,
  clavesDeRango,
  rangoDeClave,
  formatearMoneda,
  monedaDeMetrica,
  simboloMoneda,
} from '../src/lib/moneda-reporte';
import { aggregateFormula, formatValue } from '../src/lib/formula-engine';
import { fuenteParaFecha } from '../src/lib/fx';
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
const c0 = conv[0] as Record<string, unknown>;
check(
  'deja la copia SIN convertir al lado (ventas_principal_usd = 9,70)',
  c0.ventas_principal_usd === 9.7 && c0.ventas_bump_usd === 3.11
);
check(
  'añade la tasa del día con su par num/den',
  c0.tasa_cambio === 950 && c0.tasa_cambio__num === 950 && c0.tasa_cambio__den === 1
);
const usd = convertirFilasMetricas(filas, conversorIdentidad())[0] as Record<string, unknown>;
check(
  'con moneda USD los importes no cambian, la copia es igual y la tasa vale 1',
  usd.ventas_principal === 9.7 && usd.ventas_principal_usd === 9.7 && usd.tasa_cambio === 1
);

// El dinero que viaja en JSON (desglose por pestaña y extras) también se convierte.
const conFunnel = [
  {
    fecha: '2026-08-20',
    ventas_principal: 9.7,
    hotmart_funnel_data: {
      by_tab: { t1: { principal: { count: 1, net: 9.7, gross: 19 }, bump: { count: 0, net: 0 } } },
      extras: [{ product_name: 'Guía', count: 1, gross: 10, net: 8 }],
    },
  },
];
// Mismo tipo que `conFunnel`: la conversión no cambia la forma de la fila.
const fConv = convertirFilasMetricas(conFunnel, clp)[0];
check(
  'convierte by_tab (9,70 USD → 9.215 CLP) y conserva los conteos',
  fConv.hotmart_funnel_data.by_tab.t1.principal.net === 9215 &&
    fConv.hotmart_funnel_data.by_tab.t1.principal.gross === 18050 &&
    fConv.hotmart_funnel_data.by_tab.t1.principal.count === 1
);
check(
  'convierte extras (8 USD → 7.600 CLP)',
  fConv.hotmart_funnel_data.extras[0].net === 7600 &&
    fConv.hotmart_funnel_data.extras[0].gross === 9500
);
check(
  'no muta el JSON original',
  conFunnel[0].hotmart_funnel_data.by_tab.t1.principal.net === 9.7 &&
    conFunnel[0].hotmart_funnel_data.extras[0].net === 8
);

// ── 1b. La tasa en el reporting ───────────────────────────────────────
console.log('\n1b. La tasa en el reporting');
// Tres días con tasas 900, 950 y 1000: el total del rango es el PROMEDIO.
const tresDias = [900, 950, 1000].map((t, i) => ({
  fecha: `2026-08-0${i + 1}`,
  tasa_cambio: t,
  tasa_cambio__num: t,
  tasa_cambio__den: 1,
}));
check(
  'tasa_cambio en un rango de 3 días da el promedio (950), no la suma',
  aggregateFormula('tasa_cambio', tresDias) === 950,
  String(aggregateFormula('tasa_cambio', tresDias))
);
check(
  'tasaPromedio de dos días con la misma tasa',
  tasaPromedio(clp, '2026-08-06', '2026-08-07') === 900
);
check(
  'tasaPromedio mezcla la tasa de cada día (900 y 950 → 925)',
  tasaPromedio(clp, '2026-08-19', '2026-08-20') === 925
);
check(
  'tasaPromedio sin ninguna tasa es null',
  tasaPromedio(sin, '2026-08-01', '2026-08-03') === null
);
check(
  'claves por mes',
  JSON.stringify(clavesDeRango('2026-08-30', '2026-09-02', 'month')) === '["2026-08","2026-09"]'
);
check(
  'claves por semana (lunes, como el BI)',
  JSON.stringify(clavesDeRango('2026-08-30', '2026-09-02', 'week')) ===
    '["2026-08-24","2026-08-31"]'
);
check(
  'un mes se recorta al rango consultado',
  JSON.stringify(rangoDeClave('2026-08', 'month', '2026-08-10', '2026-09-30')) ===
    '{"desde":"2026-08-10","hasta":"2026-08-31"}'
);
check(
  'una semana cubre siete días, recortados',
  JSON.stringify(rangoDeClave('2026-08-31', 'week', '2026-08-01', '2026-09-02')) ===
    '{"desde":"2026-08-31","hasta":"2026-09-02"}'
);
check(
  'una clave que no es fecha cubre el rango entero',
  JSON.stringify(rangoDeClave('Camp A', 'day', '2026-08-01', '2026-08-31')) ===
    '{"desde":"2026-08-01","hasta":"2026-08-31"}'
);

// ── 1c. Formato de moneda ─────────────────────────────────────────────
console.log('\n1c. Formato de moneda');
check('formatearMoneda CLP sin decimales', formatearMoneda(233487, 'CLP') === 'CLP 233.487');
check('formatearMoneda USD con centavos', formatearMoneda(12.81, 'USD') === 'USD 12,81');
check('las gemelas siempre en USD', monedaDeMetrica('hm_neto_usd', 'CLP') === 'USD');
check(
  'el resto en la moneda del cliente',
  monedaDeMetrica('hm_neto', 'CLP') === 'CLP' &&
    monedaDeMetrica('ventas_principal_usd', 'CLP') === 'USD'
);
check('cliente en dólares: sigue el «$» de siempre', simboloMoneda('USD', 'USD') === '$');
check(
  'cliente en pesos: código ISO en cada cifra',
  simboloMoneda('CLP', 'CLP') === 'CLP' && simboloMoneda('USD', 'CLP') === 'USD'
);
check(
  'dashboard: «$» se pinta como CLP sin decimales',
  formatValue(233487, { prefix: '$', decimals: 2, moneda: 'CLP' }) === 'CLP 233,487',
  formatValue(233487, { prefix: '$', decimals: 2, moneda: 'CLP' })
);
check(
  'dashboard: con el cliente en USD, igual que siempre',
  formatValue(12.81, { prefix: '$', decimals: 2, moneda: 'USD' }) === '$12.81'
);
check(
  'dashboard: un bloque «USD » no se toca',
  formatValue(12.81, { prefix: 'USD ', decimals: 2, moneda: 'CLP' }) === 'USD 12.81'
);

// ── 1d. Qué API sirve para la tasa de cada fecha ──────────────────────
console.log('\n1d. Fuente de la tasa');
check('hoy usa la cotización actual', fuenteParaFecha('2026-09-14', '2026-09-14') === 'latest');
check(
  'ayer también (el worker sincroniza ayer)',
  fuenteParaFecha('2026-09-13', '2026-09-14') === 'latest'
);
check(
  'anteayer pide la histórica: nunca la de hoy con fecha pasada',
  fuenteParaFecha('2026-09-12', '2026-09-14') === 'historica'
);
check('una fecha de julio, histórica', fuenteParaFecha('2026-07-12', '2026-09-14') === 'historica');

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
