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
  monedaAjustada,
  monedasDeCuentasMeta,
  monedaDeCuentasMeta,
  resolverMonedaReporte,
  avisoDeTasas,
  unirAvisosTasas,
  textoAvisoTasas,
  precioUsdEnFila,
  cargarConversor,
} from '../src/lib/moneda-reporte';
import { aggregateFormula, formatValue } from '../src/lib/formula-engine';
import { fuenteParaFecha, huecosFx } from '../src/lib/fx';
import { sanitizeForClient } from '../src/lib/report-utm/bi/diagnostics';
import { buildSummarySentences } from '../src/lib/report-utm/bi/resumen';
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
  planConversiones,
  sumarConversiones,
  valoresConversiones,
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
  formatValue(233487, { prefix: '$', decimals: 2, moneda: 'CLP' }) === 'CLP 233.487',
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
// Las conversiones viajan con el gasto: el motor suma cada elemento del JSONB
// en la entrada de su clave (total, fecha o entidad) con `sumarConversiones`.
const plan = planConversiones({ tokens: [tok], aliases: [], resultados: false }, [
  { conversion_key: 'lead_calificado' },
]);
check('el plan pide la clave del token', plan?.claves.join() === 'lead_calificado');
const acumular = (claveDe: (fecha: string, camp: string) => string) => {
  const m = new Map<string, Record<string, number>>();
  for (const d of dias) {
    for (const c of d.meta_campaigns) {
      const k = claveDe(d.fecha, c.name);
      const e = m.get(k) ?? {};
      sumarConversiones(
        e,
        (c as { custom_conversions?: unknown }).custom_conversions,
        plan!.claves
      );
      m.set(k, e);
    }
  }
  return m;
};
const total = acumular(() => 'total');
check(
  'total suma todas las campañas y días',
  valoresConversiones(total.get('total'), plan, 0).valores[tok] === 6
);
const porCamp = acumular((_f, c) => c);
check(
  'por campaña',
  valoresConversiones(porCamp.get('Camp A'), plan, 0).valores[tok] === 5 &&
    valoresConversiones(porCamp.get('Camp B'), plan, 0).valores[tok] === 1
);
check(
  'una campaña sin conversiones vale 0',
  valoresConversiones(porCamp.get('Camp C'), plan, 0).valores[tok] === 0
);

// ── 6. Moneda efectiva: ajuste > cuenta de Meta > USD ─────────────────
console.log('\n6. Moneda efectiva');
const metaClp = {
  meta_accounts: [{ account_id: 'act_111' }, { account_id: '222' }],
  meta_estado_cuentas: { '111': { moneda: 'clp' }, '222': { moneda: 'CLP' } },
};
check(
  'monedasDeCuentasMeta: distintas y en mayúsculas',
  monedasDeCuentasMeta(metaClp).join() === 'CLP'
);
check('monedaDeCuentasMeta: todas en CLP → CLP', monedaDeCuentasMeta(metaClp) === 'CLP');
check(
  'una cuenta ya quitada no decide la moneda',
  monedaDeCuentasMeta({
    meta_accounts: [{ account_id: 'act_111' }],
    meta_estado_cuentas: { '111': { moneda: 'COP' }, '999': { moneda: 'CLP' } },
  }) === 'COP'
);
check(
  'cuenta única por meta_account_id',
  monedaDeCuentasMeta({
    meta_account_id: 'act_5',
    meta_estado_cuentas: { '5': { moneda: 'MXN' } },
  }) === 'MXN'
);
const mezcla = {
  meta_estado_cuentas: { a: { moneda: 'CLP' }, b: { moneda: 'COP' } },
};
check('monedas mezcladas → null (no se adivina)', monedaDeCuentasMeta(mezcla) === null);
check(
  'moneda que no se ofrece como moneda de reporte → null',
  monedaDeCuentasMeta({ meta_estado_cuentas: { a: { moneda: 'GBP' } } }) === null
);
check(
  'sin estado de cuentas → []',
  monedasDeCuentasMeta({}).length === 0 && monedasDeCuentasMeta(null).length === 0
);

let res = resolverMonedaReporte({ moneda_reporte: 'USD' }, metaClp);
check(
  'el ajuste gana a Meta (y se conservan las monedas de Meta para avisar)',
  res.moneda === 'USD' && res.origen === 'ajuste' && res.monedasMeta.join() === 'CLP'
);
res = resolverMonedaReporte({}, metaClp);
check('sin ajuste: la de Meta', res.moneda === 'CLP' && res.origen === 'meta');
res = resolverMonedaReporte(null, mezcla);
check(
  'Meta mezclada: USD por defecto',
  res.moneda === 'USD' && res.origen === 'defecto' && res.monedasMeta.join() === 'CLP,COP'
);
check(
  'monedaAjustada: sin ajuste → null',
  monedaAjustada({}) === null && monedaAjustada({ moneda_reporte: 'cop' }) === 'COP'
);

// ── 7. Días sin tasa: visibles ────────────────────────────────────────
console.log('\n7. Días sin tasa');
const convAvisos = crearConversor('CLP', [
  { fecha: '2026-09-14', usd_rate: 1 / 950 },
  { fecha: '2026-09-16', usd_rate: 1 / 960 },
]);
convAvisos.convertir(10, '2026-09-14');
convAvisos.convertir(10, '2026-09-15');
convAvisos.convertir(0, '2026-09-17');
check('el día con su tasa no se marca', !convAvisos.aproximadas.has('2026-09-14'));
check('el día sin tasa propia se marca como aproximado', convAvisos.aproximadas.has('2026-09-15'));
check('un importe 0 no marca nada', !convAvisos.aproximadas.has('2026-09-17'));
check(
  'el aproximado usa la ANTERIOR más cercana (950)',
  convAvisos.convertir(1, '2026-09-15') === 950
);
const aviso = avisoDeTasas(convAvisos);
check(
  'avisoDeTasas lo resume',
  aviso?.aproximadas.join() === '2026-09-15' && aviso.sinTasa.length === 0
);
check('sin días raros, sin aviso', avisoDeTasas(conversorIdentidad()) === null);
check(
  'textoAvisoTasas',
  textoAvisoTasas(aviso) === 'Sin tasa de cambio para 1 día (15-09): se usó la más cercana.',
  String(textoAvisoTasas(aviso))
);
const unidos = unirAvisosTasas([
  aviso,
  { sinTasa: ['2026-09-01'], aproximadas: ['2026-09-15'] },
  null,
]);
check(
  'unirAvisosTasas junta sin duplicar',
  unidos?.aproximadas.join() === '2026-09-15' && unidos?.sinTasa.join() === '2026-09-01'
);
check(
  'el texto nombra también los que quedaron en USD',
  String(textoAvisoTasas(unidos)).includes('quedaron en USD')
);

// ── 8. Precio del funnel en días sin tasa ─────────────────────────────
console.log('\n8. Precio del funnel por fila');
const conTasa = precioUsdEnFila(97, 950, 'CLP');
check(
  'con tasa: convertido y con su par num/den',
  conTasa.valor === 92150 && conTasa.num === 92150 && conTasa.den === 1
);
const sinTasaFila = precioUsdEnFila(97, undefined, 'CLP');
check(
  'sin tasa: no aporta al promedio (antes colaba 97 USD entre pesos)',
  sinTasaFila.valor === 0 && sinTasaFila.den === undefined
);
check('cliente en USD: no necesita tasa', precioUsdEnFila(97, undefined, 'USD').num === 97);
const filasPrecio = [
  {
    funnel_principal_price: 92150,
    funnel_principal_price__num: 92150,
    funnel_principal_price__den: 1,
  },
  { funnel_principal_price: 0 },
];
check(
  'el promedio del rango ignora la fila sin tasa',
  aggregateFormula('funnel_principal_price', filasPrecio) === 92150,
  String(aggregateFormula('funnel_principal_price', filasPrecio))
);

// ── 9. Huecos de fx_rates de la última semana ─────────────────────────
console.log('\n9. Relleno de huecos de tasas');
const guardadas = [
  { fecha: '2026-09-24', moneda: 'CLP' },
  { fecha: '2026-09-24', moneda: 'COP' },
  { fecha: '2026-09-23', moneda: 'CLP' },
];
const huecos = huecosFx(guardadas, '2026-09-25', ['USD', 'CLP', 'COP'], 3);
check(
  'detecta solo lo que falta, sin contar hoy ni USD',
  JSON.stringify(huecos) ===
    JSON.stringify([
      { fecha: '2026-09-23', monedas: ['COP'] },
      { fecha: '2026-09-22', monedas: ['CLP', 'COP'] },
    ]),
  JSON.stringify(huecos)
);
check(
  'sin huecos, nada que pedir',
  huecosFx(
    [
      { fecha: '2026-09-24', moneda: 'CLP' },
      { fecha: '2026-09-23', moneda: 'CLP' },
    ],
    '2026-09-25',
    ['CLP'],
    2
  ).length === 0
);

// ── 10. El enlace público conserva la moneda ──────────────────────────
console.log('\n10. BI público y resumen');
const saneado = sanitizeForClient({
  unavailable: {},
  skipped: [],
  hasPublicLink: false,
  moneda: 'CLP',
  tasas: { sinTasa: [], aproximadas: ['2026-09-15'] },
});
check(
  'sanitizeForClient conserva moneda y tasas',
  saneado?.moneda === 'CLP' && saneado?.tasas?.aproximadas[0] === '2026-09-15'
);
check('y sigue ocultando el estado del enlace', saneado?.hasPublicLink === true);
const soloDiag = sanitizeForClient({ unavailable: {}, skipped: [], hasPublicLink: true });
check('sin moneda no inventa la clave', soloDiag !== undefined && !('moneda' in soloDiag));
const frases = buildSummarySentences({ spend: 185000, leads_count: 50, cpl: 3700 }, {}, 'CLP');
check(
  'el resumen del BI pinta la moneda del cliente',
  frases[0].includes('CLP 185.000') && frases[0].includes('CLP 3.700'),
  frases[0]
);
check(
  'en dólares, igual que siempre',
  buildSummarySentences({ spend: 1850, leads_count: 5 }, {})[0].includes('$1.850')
);

// ── 11. cargarConversor para rangos viejos ────────────────────────────
function dbTasas(filas: Array<{ fecha: string; usd_rate: number }>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (): any => {
    const filtros: Array<(f: { fecha: string }) => boolean> = [];
    let desc = false;
    let lim = Infinity;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: (_c: string, v: string) => (filtros.push((f) => f.fecha >= v), b),
      gt: (_c: string, v: string) => (filtros.push((f) => f.fecha > v), b),
      lte: (_c: string, v: string) => (filtros.push((f) => f.fecha <= v), b),
      order: (_c: string, o?: { ascending?: boolean }) => ((desc = o?.ascending === false), b),
      limit: (n: number) => ((lim = n), b),
      then: (ok: (r: unknown) => unknown) => {
        const out = filas
          .filter((f) => filtros.every((p) => p(f)))
          .sort((a, c) => (desc ? -1 : 1) * a.fecha.localeCompare(c.fecha))
          .slice(0, lim);
        return Promise.resolve({ data: out, error: null }).then(ok);
      },
    };
    return b;
  };
  return { from: q };
}

async function asincronas() {
  console.log('\n11. cargarConversor: rango sin tasas en su ventana');
  const tabla = [
    { fecha: '2025-01-10', usd_rate: 1 / 800 },
    { fecha: '2026-09-20', usd_rate: 1 / 950 },
  ];
  const viejo = await cargarConversor(dbTasas(tabla), 'CLP', '2025-06-01', '2025-06-30');
  check(
    'usa la más cercana ANTERIOR al rango (800), no la última de la tabla (950)',
    viejo.tasa('2025-06-15') === 800,
    String(viejo.tasa('2025-06-15'))
  );
  const antiguo = await cargarConversor(dbTasas(tabla), 'CLP', '2024-01-01', '2024-01-31');
  check(
    'sin ninguna anterior, la primera posterior (800)',
    antiguo.tasa('2024-01-15') === 800,
    String(antiguo.tasa('2024-01-15'))
  );
}

asincronas()
  .catch((e) => {
    fallos++;
    console.error('ERROR:', e instanceof Error ? e.stack : e);
  })
  .finally(() => {
    console.log(
      fallos === 0
        ? '\n✅ Moneda, cuentas de Meta, ventas del CRM y conversiones: todas las comprobaciones pasan\n'
        : `\n❌ ${fallos} comprobación(es) fallaron\n`
    );
    process.exit(fallos === 0 ? 0 : 1);
  });
