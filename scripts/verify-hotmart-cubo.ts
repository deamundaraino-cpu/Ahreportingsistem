/**
 * Comprobaciones del cubo de ventas de Hotmart por campaña (`hm_*`) en las
 * pestañas del dashboard.
 *
 * Todo lo que decide una cifra —cómo se codifica el cubo, qué campañas pasan el
 * filtro de la pestaña y el de cada bloque, cuándo cuenta `(sin campaña)`, cómo
 * se reparte en un ranking, con qué tasa se convierte cada venta y qué dicen las
 * macros— es puro, así que se verifica sin Postgres.
 *
 * Además fija las correcciones de la auditoría del 2026-09-25 en las macros de
 * cuenta (`total_facturacion_neta_real`, `total_tasa_reembolso`, `meta_roas`) y
 * el promedio de `funnel_principal_price`.
 *
 *   npx tsx --conditions=react-server scripts/verify-hotmart-cubo.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  construirCuboHotmart,
  clavesHotmartDelDia,
  desgloseHotmartPorCampana,
  formulaUsaHotmart,
  cuboHotmartVacio,
  CLAVES_APORTE,
} from '../src/lib/dashboard/hotmart-cubo';
import type { FilaVentaCubo, HotmartCuboLite } from '../src/lib/dashboard/hotmart-cubo';
import {
  refDeCuboHotmart,
  clavesHotmartYRefDelDia,
  reDerivarHotmart,
  permitidasDelCuboHotmart,
  CLAVE_CUBO_HOTMART,
} from '../src/lib/dashboard/hotmart-cubo-row';
import { campanasPermitidas, SIN_CAMPANA } from '../src/lib/dashboard/lead-answer-aggregation';
import { applyCompoundFilter, enrichMetaRow, enrichTikTokRow } from '../src/lib/campaign-filter';
import {
  aggregateRankingRows,
  dimensionSoportaHotmart,
  dimensionSoportaRespuestas,
} from '../src/lib/ranking-aggregation';
import { aggregateFormula, evaluateFormula, MACRO_MAP } from '../src/lib/formula-engine';
import {
  aporteDeVenta,
  sumarAporte,
  aporteVacio,
  derivadasHotmart,
} from '../src/lib/hotmart/metricas';
import { crearConversor } from '../src/lib/moneda-reporte';
import { funnelCambio } from '../src/lib/hotmart/funnel-cambio';
import { AVAILABLE_METRICS } from '../src/lib/dashboard/metric-catalog';
import type { CampaignFilterSpec, TabCampaignFilter } from '../src/lib/layout-types';
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
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);
}
const cerca = (a: number | null | undefined, b: number, tol = 1e-6) =>
  a !== null && a !== undefined && Math.abs(a - b) <= tol;

// ── Fixtures ──────────────────────────────────────────────────────────
// Tres campañas de Meta (una sin ventas), una de TikTok y ventas sin UTM. Los
// nombres imitan los de Cris Tributario.
const CAPT = 'LANZ-Tributario-Captacion';
const REM = 'LANZ-Tributario-Remarketing';
const FRIO = 'LANZ-Tributario-Frio';
const TT = 'TT-Tributario';

/** Lo que haría el resolver: utm_campaign → nombre real de la campaña. */
const RESUELVE: Record<string, string> = { captacion: CAPT, remarketing: REM, tiktok: TT };
/** El id de TikTok NO se da a propósito: el ranking tiene que cruzarlo por nombre. */
const IDS: Record<string, string> = { [CAPT]: '111', [REM]: '222' };

const D1 = '2026-08-01';
const D2 = '2026-08-02';
const D3 = '2026-08-03'; // sin ventas

function venta(
  fecha: string,
  utm: string | null,
  estado: string,
  tipo: string,
  neto: number,
  bruto: number,
  extra: Partial<FilaVentaCubo> = {}
): FilaVentaCubo {
  return {
    fecha_venta: fecha,
    estado,
    tipo,
    es_order_bump: false,
    parent_transaction_id: null,
    neto_productor_usd: neto,
    bruto_usd: bruto,
    utm_campaign: utm,
    ...extra,
  };
}

const VENTAS: FilaVentaCubo[] = [
  venta(D1, 'captacion', 'aprobada', 'principal', 10, 20),
  venta(D1, 'captacion', 'aprobada', 'bump', 4, 5, {
    es_order_bump: true,
    parent_transaction_id: 'tx1',
  }),
  venta(D1, 'remarketing', 'reembolsada', 'principal', 30, 40),
  venta(D1, 'captacion', 'pendiente', 'principal', 99, 99), // no aporta: fuera del cubo
  venta(D1, null, 'completa', 'principal', 7, 9), // sin UTM → (sin campaña)
  // Los importes llegan como texto desde PostgREST (numeric): tienen que sumar.
  venta(D2, 'captacion', 'aprobada', 'principal', '10' as any, '20' as any),
  venta(D2, 'remarketing', 'aprobada', 'upsell', 15, 18, { parent_transaction_id: 'tx9' }),
  venta(D2, 'tiktok', 'aprobada', 'sin_clasificar', 12, 15),
  venta('', 'captacion', 'aprobada', 'principal', 1, 1), // sin fecha: se ignora
];

// CLP con una tasa distinta cada día: cada venta tiene que convertirse con la
// de SU fecha, no con la del rango.
const conv = crearConversor('CLP', [
  { fecha: D1, usd_rate: 1 / 900 },
  { fecha: D2, usd_rate: 1 / 1000 },
]);

let llamadasResolver = 0;
const cubo = construirCuboHotmart(VENTAS, {
  campanaDe: (t) => {
    llamadasResolver++;
    const raw = (t.utm_campaign ?? '').trim();
    return RESUELVE[raw] ?? (raw || SIN_CAMPANA);
  },
  idDeCampana: (label) => IDS[label] ?? null,
  convertir: conv.convertir,
  moneda: conv.moneda,
});

const idx = (nombre: string) => cubo.campanas.indexOf(nombre);
const filaDe = (fecha: string, nombre: string) =>
  (cubo.porFecha[fecha] ?? []).find((f) => f[0] === idx(nombre));
const valorDe = (fila: number[] | undefined, clave: string) =>
  fila ? fila[1 + CLAVES_APORTE.indexOf(clave as any)] : undefined;

// ── 1. Codificación ───────────────────────────────────────────────────
seccion('Codificación del cubo');

check('el índice 0 es SIEMPRE (sin campaña)', cubo.campanas[0] === SIN_CAMPANA, cubo.campanas[0]);
check('(sin campaña) no tiene id', cubo.campanaIds[0] === null);
check(
  'el diccionario lleva el id de cada campaña (y null si no lo tiene)',
  cubo.campanaIds[idx(CAPT)] === '111' &&
    cubo.campanaIds[idx(REM)] === '222' &&
    cubo.campanaIds[idx(TT)] === null
);
check(
  'el resolver se llama UNA vez por tupla UTM distinta (4), no por venta',
  llamadasResolver === 4,
  String(llamadasResolver)
);
check('la moneda viaja en el cubo', cubo.moneda === 'CLP');
check('un día sin ventas no está en el cubo', !(D3 in cubo.porFecha));
check(
  'la venta sin fecha no entra',
  Object.keys(cubo.porFecha).every((f) => f === D1 || f === D2),
  Object.keys(cubo.porFecha).join(',')
);
check(
  'cada fila es [iCampaña, ...las 9 claves en el orden de CLAVES_APORTE]',
  Object.values(cubo.porFecha).every((filas) =>
    filas.every((f) => f.length === 1 + CLAVES_APORTE.length)
  )
);
check(
  'el día 1 tiene 3 campañas (captación, remarketing, sin campaña)',
  cubo.porFecha[D1].length === 3
);

const capt1 = filaDe(D1, CAPT);
check('captación día 1: 2 ventas (principal + bump)', valorDe(capt1, 'hm_ventas') === 2);
check('captación día 1: 1 compra (el bump no es un pedido)', valorDe(capt1, 'hm_compras') === 1);
check('captación día 1: 1 bump', valorDe(capt1, 'hm_bumps') === 1);
check(
  'la pendiente NO aporta (neto 14 USD, no 113)',
  valorDe(capt1, 'hm_neto_usd') === 14,
  String(valorDe(capt1, 'hm_neto_usd'))
);
check(
  'neto convertido con la tasa del día 1 (14 × 900 = 12.600 CLP)',
  valorDe(capt1, 'hm_neto') === 12600,
  String(valorDe(capt1, 'hm_neto'))
);
check('bruto convertido (25 × 900 = 22.500)', valorDe(capt1, 'hm_bruto') === 22500);
check('las gemelas en USD quedan sin convertir', valorDe(capt1, 'hm_bruto_usd') === 25);

const capt2 = filaDe(D2, CAPT);
check(
  'la MISMA venta el día 2 usa la tasa del día 2 (10 × 1.000 = 10.000)',
  valorDe(capt2, 'hm_neto') === 10000,
  String(valorDe(capt2, 'hm_neto'))
);
check('los importes en texto (numeric de PostgREST) suman', valorDe(capt2, 'hm_neto_usd') === 10);

const rem1 = filaDe(D1, REM);
check(
  'reembolso: 1 reembolso, 0 ventas, neto reembolsado convertido (30 × 900)',
  valorDe(rem1, 'hm_reembolsos') === 1 &&
    valorDe(rem1, 'hm_ventas') === 0 &&
    valorDe(rem1, 'hm_neto_reembolsado') === 27000
);
const rem2 = filaDe(D2, REM);
check(
  'upsell: cuenta como venta pero NO como compra',
  valorDe(rem2, 'hm_ventas') === 1 && valorDe(rem2, 'hm_compras') === 0
);
check(
  'sin_clasificar SIN padre ni bump es una compra (no cae a 0 sin embudo)',
  valorDe(filaDe(D2, TT), 'hm_compras') === 1
);
check('la venta sin UTM va a (sin campaña)', valorDe(filaDe(D1, SIN_CAMPANA), 'hm_ventas') === 1);

// El cubo y `aporteDeVenta` venta a venta tienen que cuadrar: es la definición única.
{
  const total = aporteVacio();
  for (const v of VENTAS) if (v.fecha_venta) sumarAporte(total, aporteDeVenta(v, conv.convertir));
  const todas = campanasPermitidas(cubo, '', undefined, []);
  const d1 = clavesHotmartDelDia(cubo, D1, todas);
  const d2 = clavesHotmartDelDia(cubo, D2, todas);
  check(
    'la suma del cubo = la suma de aporteDeVenta venta a venta (las 9 claves)',
    CLAVES_APORTE.every((k) => cerca(d1[k] + d2[k], total[k], 0.001)),
    CLAVES_APORTE.map((k) => `${k}:${d1[k] + d2[k]}/${total[k]}`).join(' ')
  );
}

{
  let n = 0;
  const vacio = construirCuboHotmart([], {
    campanaDe: () => {
      n++;
      return 'x';
    },
  });
  check(
    'sin ventas: cubo vacío, con (sin campaña) y sin llamar al resolver',
    Object.keys(vacio.porFecha).length === 0 && vacio.campanas[0] === SIN_CAMPANA && n === 0
  );
}

// ── 2. Filtro de la pestaña ───────────────────────────────────────────
seccion('Campañas permitidas (filtro de la pestaña)');

const GRUPOS = [
  { id: 'g-rem', nombre: 'Remarketing', campaign_group_mappings: [{ campaign_id: '222' }] },
];

{
  const sinFiltro = campanasPermitidas(cubo, '', undefined, GRUPOS);
  check('sin filtro: (sin campaña) cuenta', sinFiltro.has(0));
  const d1 = clavesHotmartDelDia(cubo, D1, sinFiltro);
  check(
    'sin filtro: día 1 = captación (2) + sin campaña (1) = 3 ventas',
    d1.hm_ventas === 3,
    String(d1.hm_ventas)
  );

  const soloCapt = campanasPermitidas(cubo, 'Captacion', undefined, GRUPOS);
  check('con filtro: (sin campaña) NO cuenta', !soloCapt.has(0));
  const d1c = clavesHotmartDelDia(cubo, D1, soloCapt);
  check('filtro «Captacion»: día 1 = 2 ventas', d1c.hm_ventas === 2, String(d1c.hm_ventas));
  check('filtro «Captacion»: el reembolso de remarketing no entra', d1c.hm_reembolsos === 0);

  // Un filtro que casaría por accidente con la etiqueta sintética.
  const camp = campanasPermitidas(cubo, 'camp', undefined, GRUPOS);
  check('«camp» no selecciona «(sin campaña)» por casualidad', !camp.has(0));

  const compuesto: TabCampaignFilter = {
    mode: 'or',
    conditions: [
      { type: 'keyword', operator: 'includes', value: 'Captacion' },
      { type: 'keyword', operator: 'starts_with', value: 'TT-' },
    ],
  };
  const orr = campanasPermitidas(cubo, compuesto, undefined, GRUPOS);
  const d2o = clavesHotmartDelDia(cubo, D2, orr);
  check(
    'filtro compuesto O (captación o TikTok): día 2 = 2 ventas',
    d2o.hm_ventas === 2,
    String(d2o.hm_ventas)
  );

  const grupo = campanasPermitidas(
    cubo,
    { type: 'group', value: 'g-rem' } as any,
    undefined,
    GRUPOS
  );
  const d1g = clavesHotmartDelDia(cubo, D1, grupo);
  check(
    'grupo de campañas (por campaign_id): solo remarketing',
    d1g.hm_reembolsos === 1 && d1g.hm_ventas === 0
  );

  const d3 = clavesHotmartDelDia(cubo, D3, sinFiltro);
  check(
    'un día sin ventas emite las 9 claves en 0 (no un hueco)',
    CLAVES_APORTE.every((k) => d3[k] === 0) && Object.keys(d3).length === CLAVES_APORTE.length
  );
}

// ── 3. Filas del dashboard y filtro propio de tarjeta/columna ─────────
seccion('Filas: inyección y re-derivación por bloque');

/** Filas de `metricas_diarias` con su desglose por campaña. */
function metricas(): any[] {
  return [D1, D2, D3].map((fecha) => ({
    fecha,
    meta_spend: 180,
    tiktok_spend: 20,
    meta_campaigns: [
      { campaign_id: '111', name: CAPT, spend: 100 },
      { campaign_id: '222', name: REM, spend: 50 },
      { campaign_id: '444', name: FRIO, spend: 30 },
    ],
    tiktok_campaigns: [{ campaign_id: '333', name: TT, spend: 20 }],
  }));
}

/** Lo que hace DashboardClient: enriquecer con el filtro de la pestaña e inyectar. */
function filasDePestana(ds: HotmartCuboLite | null, keyword: string | TabCampaignFilter): any[] {
  const ref = refDeCuboHotmart(ds, keyword, GRUPOS);
  return metricas()
    .map((m) => enrichTikTokRow(enrichMetaRow(m, keyword, GRUPOS), keyword, GRUPOS))
    .map((r) => ({ ...r, ...clavesHotmartYRefDelDia(ref, r.fecha) }));
}

const sinFiltro = filasDePestana(cubo, '');
check(
  'la fila lleva el cubo por referencia (no una copia)',
  sinFiltro.every((r) => r[CLAVE_CUBO_HOTMART]?.ds === cubo)
);
check(
  'pestaña sin filtro: 6 ventas en el rango (sin campaña incluida)',
  aggregateFormula('hm_ventas', sinFiltro) === 6,
  String(aggregateFormula('hm_ventas', sinFiltro))
);
check('pestaña sin filtro: 4 compras', aggregateFormula('hm_compras', sinFiltro) === 4);
check('el día 3 (sin ventas) tiene hm_ventas = 0, no undefined', sinFiltro[2].hm_ventas === 0);

const pestanaCapt = filasDePestana(cubo, 'Captacion');
check(
  'pestaña «Captacion»: gasto y ventas recortados por el MISMO filtro',
  aggregateFormula('meta_spend', pestanaCapt) === 300 &&
    aggregateFormula('hm_ventas', pestanaCapt) === 3,
  `${aggregateFormula('meta_spend', pestanaCapt)} / ${aggregateFormula('hm_ventas', pestanaCapt)}`
);
check(
  'pestaña «Captacion»: CPA por compra = 300 / 2 = 150 (antes: gasto filtrado / TODAS las ventas)',
  aggregateFormula('hm_cpa_compra', pestanaCapt) === 150,
  String(aggregateFormula('hm_cpa_compra', pestanaCapt))
);

{
  const tarjeta: CampaignFilterSpec = {
    type: 'keyword',
    operator: 'includes',
    value: 'Remarketing',
  };
  const filas = sinFiltro.map((r) => applyCompoundFilter(r, '', tarjeta, GRUPOS));
  check(
    'tarjeta con filtro propio: re-deriva el gasto Y las ventas (remarketing)',
    aggregateFormula('meta_spend', filas) === 150 &&
      aggregateFormula('hm_ventas', filas) === 1 &&
      aggregateFormula('hm_reembolsos', filas) === 1,
    `${aggregateFormula('meta_spend', filas)} / ${aggregateFormula('hm_ventas', filas)}`
  );
  check(
    'tarjeta con filtro: TikTok no casa, así que su gasto sale del denominador',
    aggregateFormula('tiktok_spend', filas) === 0
  );
  check(
    'tarjeta con filtro: (sin campaña) deja de contar aunque la pestaña no filtre',
    aggregateFormula('hm_compras', filas) === 0
  );
  check(
    'hm_cpa = 150 / 1; hm_cpa_compra sin compras = «—» (null)',
    aggregateFormula('hm_cpa', filas) === 150 && aggregateFormula('hm_cpa_compra', filas) === null
  );
  // Encadenado sobre la pestaña: pestaña «Captacion» + tarjeta «Remarketing» = nada.
  const encadenado = pestanaCapt.map((r) => applyCompoundFilter(r, 'Captacion', tarjeta, GRUPOS));
  check(
    'el filtro del bloque se ENCADENA con el de la pestaña (no lo sustituye)',
    aggregateFormula('hm_ventas', encadenado) === 0
  );
  check(
    'sin campaignFilter, applyCompoundFilter devuelve la fila tal cual',
    applyCompoundFilter(sinFiltro[0], '', undefined, GRUPOS) === sinFiltro[0]
  );
  const directo = reDerivarHotmart(sinFiltro[1], tarjeta);
  check(
    'reDerivarHotmart devuelve las 9 claves del día para el filtro',
    !!directo && Object.keys(directo).length === CLAVES_APORTE.length && directo.hm_ventas === 1
  );
  check(
    'una fila sin cubo no se re-deriva (null)',
    reDerivarHotmart({ fecha: D1 }, tarjeta) === null
  );
  const ref = sinFiltro[0][CLAVE_CUBO_HOTMART];
  check(
    'el conjunto de permitidas se memoriza por (referencia, filtro)',
    permitidasDelCuboHotmart(ref, tarjeta) === permitidasDelCuboHotmart(ref, tarjeta)
  );
}

{
  const roto: HotmartCuboLite = { ...cuboHotmartVacio('CLP'), incompleto: true };
  check('un cubo incompleto NO se adjunta', refDeCuboHotmart(roto, '', GRUPOS) === null);
  const filas = filasDePestana(roto, '');
  check(
    'sin cubo, las fórmulas hm_* salen «—» (null), no 0',
    aggregateFormula('hm_ventas', filas) === null && evaluateFormula('hm_roas', filas[0]) === null
  );
  const vacio = filasDePestana(cuboHotmartVacio('CLP'), '');
  check(
    'un cubo vacío pero completo SÍ se adjunta: 0 ventas es un dato',
    aggregateFormula('hm_ventas', vacio) === 0
  );
}

// ── 4. Ranking por campaña ────────────────────────────────────────────
seccion('Tablas de ranking');

check('campañas de Meta sirven hm_*', dimensionSoportaHotmart('campaigns'));
check('campañas de TikTok sirven hm_*', dimensionSoportaHotmart('tiktok_campaigns'));
check(
  'anuncios y conjuntos NO (n/a)',
  !dimensionSoportaHotmart('ads') && !dimensionSoportaHotmart('adsets')
);
check(
  'las respuestas siguen igual (solo campañas de Meta)',
  !dimensionSoportaRespuestas('tiktok_campaigns')
);

{
  const filas = aggregateRankingRows(sinFiltro, 'campaigns', undefined, undefined, '', GRUPOS);
  const de = (n: string) => filas.find((f) => f._name === n);
  check(
    'captación: 3 ventas, 2 compras, 1 bump en el rango',
    de(CAPT)?.hm_ventas === 3 && de(CAPT)?.hm_compras === 2 && de(CAPT)?.hm_bumps === 1
  );
  check(
    'remarketing: 1 venta (upsell) y 1 reembolso',
    de(REM)?.hm_ventas === 1 && de(REM)?.hm_reembolsos === 1
  );
  check(
    'una campaña con gasto y sin ventas lleva las claves en 0 (no «n/a»)',
    de(FRIO)?.hm_ventas === 0 && de(FRIO)?.hm_neto === 0
  );
  const suma = filas.reduce((s, f) => s + (f.hm_ventas ?? 0), 0);
  check(
    'ranking de Meta: 4 de las 6 ventas (la de TikTok va en su tabla y la sin campaña en ninguna)',
    suma === 4,
    String(suma)
  );
  check(
    'CPA por compra de captación en la fila = 300 / 2',
    evaluateFormula('hm_cpa_compra', de(CAPT)) === 150
  );

  const soloCapt = aggregateRankingRows(
    sinFiltro,
    'campaigns',
    { type: 'keyword', operator: 'includes', value: 'Captacion' },
    undefined,
    '',
    GRUPOS
  );
  check(
    'con filtro de ranking: solo la fila de captación, con sus ventas',
    soloCapt.length === 1 && soloCapt[0].hm_ventas === 3
  );

  const tiktok = aggregateRankingRows(
    sinFiltro,
    'tiktok_campaigns',
    undefined,
    undefined,
    '',
    GRUPOS
  );
  check(
    'ranking de TikTok: cruza por NOMBRE cuando el cubo no tiene id',
    tiktok.length === 1 && tiktok[0].hm_ventas === 1 && tiktok[0].hm_neto === 12000,
    JSON.stringify(tiktok.map((t) => [t._name, t.hm_ventas]))
  );

  const ads = aggregateRankingRows(
    sinFiltro.map((r) => ({
      ...r,
      meta_ads: [{ ad_id: 'a1', ad_name: 'Ad', campaign_name: CAPT, spend: 5 }],
    })),
    'ads',
    undefined,
    undefined,
    '',
    GRUPOS
  );
  check('en anuncios no se cuelga nada (la celda dice n/a)', ads[0]?.hm_ventas === undefined);

  const desglose = desgloseHotmartPorCampana(cubo, D1, campanasPermitidas(cubo, '', undefined, []));
  check(
    'el desglose marca la fila de (sin campaña)',
    desglose.some((d) => d.esSinCampana && d.valores.hm_ventas === 1)
  );
}

// ── 5. Macros hm_* = las derivadas del BI ─────────────────────────────
seccion('Macros hm_* (mismas definiciones que el BI)');

check('formulaUsaHotmart: una clave base', formulaUsaHotmart('meta_spend / hm_compras'));
check('formulaUsaHotmart: una macro', formulaUsaHotmart('hm_roas'));
check('formulaUsaHotmart: no captura otra cosa', !formulaUsaHotmart('xhm_ventas + total_roas'));
check('formulaUsaHotmart: vacío', !formulaUsaHotmart('') && !formulaUsaHotmart(null));
check(
  'todas las macros hm_* empiezan por hm_ (el cargador condicional las ve)',
  Object.keys(MACRO_MAP)
    .filter((k) => /\bhm_/.test(MACRO_MAP[k]))
    .every((k) => k.startsWith('hm_'))
);

{
  // Lo que ve una pestaña sin filtro, sumado a mano con aporteDeVenta.
  const a = aporteVacio();
  for (const v of VENTAS) if (v.fecha_venta) sumarAporte(a, aporteDeVenta(v, conv.convertir));
  const gasto = (180 + 20) * 3;
  const bi = derivadasHotmart(a, gasto);
  for (const k of [
    'hm_roas',
    'hm_cpa',
    'hm_cpa_compra',
    'hm_ticket_medio',
    'hm_ticket_compra',
    'hm_tasa_reembolso',
    'hm_tasa_bump',
  ] as const) {
    const pestana = aggregateFormula(k, sinFiltro);
    check(
      `${k}: pestaña = BI (${bi[k]?.toFixed(4)})`,
      cerca(pestana, bi[k] ?? NaN, 1e-6),
      String(pestana)
    );
  }
  check(
    'hm_tasa_reembolso divide entre lo facturado ANTES de devolver',
    cerca(aggregateFormula('hm_tasa_reembolso', sinFiltro), (27000 / (55900 + 27000)) * 100)
  );
}

{
  const faltan = [
    'hm_ventas',
    'hm_compras',
    'hm_bumps',
    'hm_neto',
    'hm_bruto',
    'hm_reembolsos',
    'hm_neto_reembolsado',
    'hm_roas',
    'hm_cpa',
    'hm_cpa_compra',
    'hm_ticket_medio',
    'hm_ticket_compra',
    'hm_tasa_reembolso',
    'hm_tasa_bump',
    'hm_neto_usd',
    'hm_bruto_usd',
  ].filter((id) => !AVAILABLE_METRICS.some((m) => m.id === id));
  check(
    'las 16 métricas hm_* están en el selector del dashboard',
    faltan.length === 0,
    faltan.join(',')
  );
  const fmt = (id: string) => AVAILABLE_METRICS.find((m) => m.id === id)?.format;
  check(
    'formatos: conteo = number, dinero = currency, tasa = percent, gemela = currency_usd',
    fmt('hm_compras') === 'number' &&
      fmt('hm_neto') === 'currency' &&
      fmt('hm_cpa_compra') === 'currency' &&
      fmt('hm_tasa_reembolso') === 'percent' &&
      fmt('hm_neto_usd') === 'currency_usd'
  );
}

// ── 6. Macros de cuenta corregidas (auditoría del 2026-09-25) ─────────
seccion('Macros total_* y meta_roas corregidas');

{
  const fila = {
    meta_spend: 100,
    tiktok_spend: 0,
    ventas_principal: 100,
    ventas_bump: 20,
    ventas_upsell: 30,
    ventas_downsell: 50,
    // Ya EXCLUIDO de `ventas_*`: `agregarDesdeHotmartVentas` salta las devueltas.
    ventas_reembolsado: 40,
  };
  check(
    'total_facturacion_neta_real NO resta el reembolso otra vez (200, antes 160)',
    evaluateFormula('total_facturacion_neta_real', fila) === 200,
    String(evaluateFormula('total_facturacion_neta_real', fila))
  );
  check(
    'total_tasa_reembolso = 40 / (200 + 40) × 100 = 16,67 % (antes 0,2)',
    cerca(evaluateFormula('total_tasa_reembolso', fila), (40 / 240) * 100),
    String(evaluateFormula('total_tasa_reembolso', fila))
  );
  check(
    'meta_roas incluye el downsell (200 / 100 = 2, antes 1,5)',
    evaluateFormula('meta_roas', fila) === 2,
    String(evaluateFormula('meta_roas', fila))
  );
  check(
    'sin downsell, meta_roas no cambia (verify-sync-fixes: 300 / 100 = 3)',
    evaluateFormula('meta_roas', { meta_spend: 100, ventas_principal: 300 }) === 3
  );
}

// ── 7. funnel_principal_price: promedio, no suma ──────────────────────
seccion('funnel_principal_price se promedia');

{
  // Lo que inyecta DashboardClient: precio USD × tasa del día, con su par.
  const precioUsd = 19;
  const dia = (fecha: string, tasa: number, compras: number) => ({
    fecha,
    tasa_cambio: tasa,
    tasa_cambio__num: tasa,
    tasa_cambio__den: 1,
    funnel_principal_count: compras,
    funnel_principal_price: precioUsd * tasa,
    funnel_principal_price__num: precioUsd * tasa,
    funnel_principal_price__den: 1,
  });
  const mes = [dia(D1, 900, 1), dia(D2, 900, 2), dia(D3, 900, 0)];
  check(
    'el precio de un rango es el promedio (17.100), no precio × días (51.300)',
    cerca(aggregateFormula('funnel_principal_price', mes), 17100),
    String(aggregateFormula('funnel_principal_price', mes))
  );
  check(
    'funnel_facturacion_bruta = precio × 3 compras = 51.300 (antes 153.900)',
    cerca(aggregateFormula('funnel_facturacion_bruta', mes), 51300),
    String(aggregateFormula('funnel_facturacion_bruta', mes))
  );
  check(
    'un día suelto sigue siendo precio × compras (17.100 × 2)',
    evaluateFormula('funnel_facturacion_bruta', mes[1]) === 34200
  );
  check(
    'la tasa de cambio sigue promediándose igual',
    aggregateFormula('tasa_cambio', mes) === 900
  );
}

// ── 8. Reclasificación del embudo solo si cambió ──────────────────────
seccion('saveClienteTab: ¿cambió el embudo?');

{
  const base = { enabled: true, principal_offers: ['abc'], principal_price_usd: 19 };
  check(
    'mismo embudo con las claves en otro orden → sin cambio',
    !funnelCambio(base, { principal_price_usd: 19, principal_offers: ['abc'], enabled: true })
  );
  check('null y undefined son el mismo «sin embudo»', !funnelCambio(null, undefined));
  check(
    'una clave a undefined no cuenta',
    !funnelCambio(base, { ...base, bump_offers: undefined })
  );
  check('de nada a un embudo → cambio', funnelCambio(null, base));
  check('otra oferta → cambio', funnelCambio(base, { ...base, principal_offers: ['xyz'] }));
  check('deshabilitarlo → cambio', funnelCambio(base, { ...base, enabled: false }));
}

console.log(
  fallos === 0 ? '\n✓ TODO OK — cubo de Hotmart por campaña\n' : `\n✗ ${fallos} FALLO(S)\n`
);
salir(fallos);
