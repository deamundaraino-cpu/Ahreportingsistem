/**
 * GA4 por campaña (migración 097): ingesta, métricas, cruce y seguridad.
 *
 * Todo PURO: ni red ni base. Las respuestas de GA4 son fixtures con la forma de
 * `runReport` (cabeceras + filas), incluidos los formatos reales que manda Meta
 * en Cris Tributario (auditoría del 2026-09-28): a veces `fb | paid | <id>` y a
 * veces `Facebook_Right_Column | fb | <nombre codificado>`.
 *
 *   npx tsx --conditions=react-server scripts/verify-ga4-desglose.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fechaGa,
  normalizarValorGa,
  filasSesiones,
  filasEventos,
  metadatosDeRespuestas,
  offsetsPendientes,
  ventanas,
  sospechosoVacio,
  peticionSesiones,
  peticionEventos,
  LIMITE_PAGINA_GA4,
  type RespuestaGa4,
} from '../src/lib/integrations/ga4-desglose';
import {
  normalizarPropiedadGa4,
  limpiarClavePrivada,
  clasificarErrorGa4,
  mensajeErrorGa4,
} from '../src/lib/integrations/ga4-cliente';
import {
  derivadasGa4,
  aporteVacioGa4,
  sumarAporteGa4,
  ga4SinDatos,
  GA4_METRICAS,
} from '../src/lib/ga4/metricas';
import {
  METRIC_META,
  isAdditiveMetric,
  isLowerBetter,
  metricCrossesDimension,
  isGa4EvMetric,
  parseGa4EvMetric,
  makeGa4EvMetric,
  ga4EvAlias,
  extractGa4EvAliases,
  ga4EvLabel,
  basesAditivasDeFormula,
  normLabel,
  type BiMetric,
} from '../src/lib/report-utm/bi-metadata';
import { BASE_REGISTRY, legacyBreakdownOfField } from '../src/lib/report-utm/bi/registry';
import { LEGACY_MEASURE_IDS } from '../src/lib/report-utm/bi/legacy-tokens';
import { RATIOS_DE_TOTAL, basesOcultasDeRatios } from '../src/lib/report-utm/bi-table-totals';
import {
  buildResolver,
  type CampaignIndex,
  SIN_CAMPANA,
} from '../src/lib/report-utm/campaign-resolver';
import { SYNC_JOB_TIPOS } from '../src/lib/sync/queue';
import { tieneGa4 } from '../src/lib/sync/planner';
import { firmarState } from '../src/lib/hotmart/oauth-state';
import {
  STATE_AGENCIA_GOOGLE,
  verificarStateGoogle,
} from '../src/lib/integrations/google-oauth-state';
import {
  peticionLanding,
  peticionVistas,
  filasLanding,
  filasVistas,
  paginasSospechosas,
  desvioLanding,
} from '../src/lib/integrations/ga4-desglose';
import { rutaDePagina, SIN_PAGINA } from '../src/lib/report-utm/page-url';
import { GA4_POR_LANDING } from '../src/lib/report-utm/bi-metadata';
import { fieldCrossesDimension } from '../src/lib/report-utm/bi/registry';
import { migrateDimensionId, migrateMeasureId } from '../src/lib/report-utm/bi/legacy-tokens';
import {
  agruparPorProveedor,
  CARPETA_GA4,
  CARPETA_HOTMART,
} from '../src/components/report-utm/bi/fuentesPorProveedor';
import type { CatalogSource } from '../src/components/report-utm/bi/BiFieldPicker';
import { salir } from './_salida';

process.env.CRON_SECRET = 'secreto-de-prueba-para-firmar-el-state';

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

/** Respuesta de `runReport` a partir de cabeceras y filas de texto. */
function resp(
  dims: string[],
  mets: string[],
  filas: Array<[string[], Array<string | number>]>,
  metadata: RespuestaGa4['metadata'] = {}
): RespuestaGa4 {
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: mets.map((name) => ({ name })),
    rows: filas.map(([d, m]) => ({
      dimensionValues: d.map((value) => ({ value })),
      metricValues: m.map((value) => ({ value: String(value) })),
    })),
    rowCount: filas.length,
    metadata,
  };
}

const DIMS = ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionCampaignId'];
const METS = ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'];

// ════════════════════════════════════════════════════════════════
seccion('Normalización de valores de GA4');
// ════════════════════════════════════════════════════════════════
check('20260927 → 2026-09-27', fechaGa('20260927') === '2026-09-27');
check('una fecha ya ISO se deja igual', fechaGa('2026-09-27') === '2026-09-27');
for (const v of ['(not set)', '(none)', '(direct)', '(organic)', '(referral)', '(NOT SET)']) {
  check(`«${v}» → ''`, normalizarValorGa(v) === '');
}
check('un valor real se conserva (recortado)', normalizarValorGa('  fb ') === 'fb');
check('null → ""', normalizarValorGa(null) === '');

// ════════════════════════════════════════════════════════════════
seccion('Filas de sesiones: por NOMBRE de cabecera y sumando colisiones');
// ════════════════════════════════════════════════════════════════
const CAMP_ID = '120250123332020774';
{
  const r = resp(DIMS, METS, [
    [
      ['20260927', 'fb', 'paid', CAMP_ID, CAMP_ID],
      [128, 43, 0, 0],
    ],
    [
      ['20260927', '(direct)', '(none)', '(direct)', '(not set)'],
      [68, 21, 1, 0.52],
    ],
    // Otra fila que tras normalizar es la MISMA tupla que la de arriba.
    [
      ['20260927', '(direct)', '(none)', '(not set)', '(not set)'],
      [2, 1, 0, 0],
    ],
  ]);
  const filas = filasSesiones([r]);
  check('tres filas → dos tuplas (las directas se funden)', filas.length === 2);
  const directa = filas.find((f) => f.utm_source === '');
  check(
    'la tupla directa suma sesiones y sesiones con interacción',
    directa?.sesiones === 70 && directa?.sesiones_interaccion === 22
  );
  check('ingresos con decimales', directa?.ingresos === 0.52);
  const meta = filas.find((f) => f.utm_source === 'fb');
  check(
    'la tupla de Meta conserva campaña e id',
    meta?.utm_campaign === CAMP_ID && meta?.utm_id === CAMP_ID && meta?.fecha === '2026-09-27'
  );

  // Las cabeceras en otro orden no cambian nada: se lee por nombre.
  const alRev = resp([...DIMS].reverse(), [...METS].reverse(), [
    [
      [CAMP_ID, CAMP_ID, 'paid', 'fb', '20260927'],
      [0, 0, 43, 128],
    ],
  ]);
  const f2 = filasSesiones([alRev])[0];
  check(
    'con las cabeceras en otro orden se lee igual',
    f2?.sesiones === 128 && f2?.sesiones_interaccion === 43 && f2?.utm_source === 'fb'
  );

  const conv = filasSesiones([
    resp(
      DIMS,
      ['sessions', 'conversions'],
      [
        [
          ['20260927', 'fb', 'paid', 'x', ''],
          [5, 2],
        ],
      ]
    ),
  ])[0];
  check('sin keyEvents, cae a la métrica antigua `conversions`', conv?.eventos_clave === 2);
  check(
    'una fila sin fecha válida se descarta',
    filasSesiones([
      resp(DIMS, METS, [
        [
          ['', 'fb', 'paid', 'x', ''],
          [1, 0, 0, 0],
        ],
      ]),
    ]).length === 0
  );
}

seccion('Filas de eventos clave');
{
  const r = resp(
    [...DIMS, 'eventName'],
    ['keyEvents'],
    [
      [['20260927', 'fb', 'paid', CAMP_ID, CAMP_ID, 'purchase'], [3]],
      [['20260927', 'fb', 'paid', CAMP_ID, CAMP_ID, 'purchase'], [2]],
      [['20260927', 'fb', 'paid', CAMP_ID, CAMP_ID, 'generate_lead'], [0]],
      [['20260927', 'fb', 'paid', CAMP_ID, CAMP_ID, ''], [4]],
    ]
  );
  const ev = filasEventos([r]);
  check('se suman los eventos de la misma tupla', ev.length === 1 && ev[0].eventos_clave === 5);
  check('un evento con 0 o sin nombre no se guarda', !ev.some((e) => e.evento !== 'purchase'));
}

seccion('Metadatos: umbral, fila «(other)», muestreo, zona y moneda');
{
  const md = metadatosDeRespuestas([
    resp(DIMS, METS, [], { timeZone: 'Pacific/Easter', currencyCode: 'USD' }),
    resp(DIMS, METS, [], { subjectToThresholding: true, samplingMetadatas: [{}] }),
    resp(DIMS, METS, [], { dataLossFromOtherRow: true }),
  ]);
  check(
    'zona y moneda de la primera respuesta',
    md.zona_horaria === 'Pacific/Easter' && md.moneda === 'USD'
  );
  check('un flag en cualquier respuesta cuenta', md.umbral && md.muestreo && md.fila_otros);
  const limpio = metadatosDeRespuestas([resp(DIMS, METS, [])]);
  check('sin metadatos, todo en falso', !limpio.umbral && !limpio.fila_otros && !limpio.muestreo);
}

seccion('Peticiones, paginación y ventanas');
{
  const p = peticionSesiones('2026-09-01', '2026-09-27');
  check(
    'sesiones: las cinco dimensiones de la tupla',
    JSON.stringify(p.dimensions.map((d) => d.name)) === JSON.stringify(DIMS)
  );
  check(
    'pide la cuota solo en la primera página',
    p.returnPropertyQuota && !peticionSesiones('a', 'b', 10_000).returnPropertyQuota
  );
  check('orden estable por las cinco dimensiones', p.orderBys.length === 5);
  check('límite explícito (sin él GA corta en 10.000 en silencio)', p.limit === LIMITE_PAGINA_GA4);
  const e = peticionEventos('2026-09-01', '2026-09-27');
  check(
    'eventos: filtra keyEvents > 0',
    e.metricFilter.filter.fieldName === 'keyEvents' &&
      e.metricFilter.filter.numericFilter.operation === 'GREATER_THAN'
  );
  check('eventos: añade eventName', e.dimensions.at(-1)?.name === 'eventName');

  check('rowCount 9.999 → sin más páginas', offsetsPendientes(9_999).length === 0);
  check(
    'rowCount 25.000 → páginas en 10.000 y 20.000',
    JSON.stringify(offsetsPendientes(25_000)) === '[10000,20000]'
  );

  const v = ventanas('2025-12-15', '2026-02-20');
  check(
    'ventanas de 31 días, contiguas y sin solapar',
    v.length === 3 &&
      v[0][0] === '2025-12-15' &&
      v[0][1] === '2026-01-14' &&
      v[1][0] === '2026-01-15' &&
      v.at(-1)![1] === '2026-02-20'
  );
  check('un rango invertido no genera ventanas', ventanas('2026-02-01', '2026-01-01').length === 0);
  check('un solo día → una ventana', ventanas('2026-09-27', '2026-09-27').length === 1);

  check(
    'vacío con datos la semana anterior y días asentados → sospechoso',
    sospechosoVacio([], true, '2026-09-20', '2026-09-28')
  );
  check(
    'vacío en los días recientes no es sospechoso',
    !sospechosoVacio([], true, '2026-09-27', '2026-09-28')
  );
  check(
    'vacío sin datos previos no es sospechoso',
    !sospechosoVacio([], false, '2026-09-20', '2026-09-28')
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Derivadas de GA4: una sola definición, null sin denominador');
// ════════════════════════════════════════════════════════════════
{
  const a = sumarAporteGa4(aporteVacioGa4(), {
    ga4_sesiones: 200,
    ga4_sesiones_interaccion: 80,
    ga4_eventos_clave: 10,
    ga4_ingresos: 500,
  });
  const d = derivadasGa4(a, 1000, 20);
  check('tasa de interacción 40 %', d.ga4_tasa_interaccion === 40);
  check('tasa de rebote 60 % (1 − interacción)', d.ga4_tasa_rebote === 60);
  check('tasa de eventos clave 5 %', d.ga4_tasa_evento_clave === 5);
  check('coste por sesión 5', d.ga4_coste_sesion === 5);
  check('coste por evento clave 100', d.ga4_coste_evento_clave === 100);
  check('sesión → lead 10 %', d.ga4_tasa_sesion_lead === 10);
  check('ROAS GA4 0,5', d.ga4_roas === 0.5);

  const cero = derivadasGa4(aporteVacioGa4(), 1000, 20);
  check(
    'sin sesiones, TODAS las tasas son null (no 0)',
    Object.values(cero).every((v) => v === null)
  );
  const sinGasto = derivadasGa4(a, 0, 20);
  check(
    'sin gasto, los costes y el ROAS son null',
    sinGasto.ga4_coste_sesion === null && sinGasto.ga4_roas === null
  );
  check(
    'estado nulo, sin propiedad o sin sincronizar → sin datos',
    ga4SinDatos(null) &&
      ga4SinDatos({ configurado: false, sincronizado: true } as never) &&
      ga4SinDatos({ configurado: true, sincronizado: false } as never) &&
      !ga4SinDatos({ configurado: true, sincronizado: true } as never)
  );
}

seccion('Fila Total de la tabla: misma definición que el motor');
{
  const r = RATIOS_DE_TOTAL.ga4_coste_sesion;
  check(
    'coste por sesión se totaliza con gasto y sesiones',
    JSON.stringify(r.bases) === '["spend","ga4_sesiones"]'
  );
  check('Total = gasto total ÷ sesiones totales', r.calc({ spend: 300, ga4_sesiones: 60 }) === 5);
  check('sin sesiones, el Total es «—»', r.calc({ spend: 300, ga4_sesiones: 0 }) === null);
  const ocultas = basesOcultasDeRatios(['ga4_tasa_rebote']);
  check(
    'la tasa de rebote pide sesiones y sesiones con interacción ocultas',
    ocultas.includes('ga4_sesiones') && ocultas.includes('ga4_sesiones_interaccion')
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Catálogo: tokens, aditividad, dirección');
// ════════════════════════════════════════════════════════════════
for (const m of GA4_METRICAS) {
  check(
    `${m} está en METRIC_META y tiene id canónico`,
    !!METRIC_META[m as BiMetric] && !!LEGACY_MEASURE_IDS[m]
  );
}
check(
  'las cuatro medidas son aditivas',
  ['ga4_sesiones', 'ga4_sesiones_interaccion', 'ga4_eventos_clave', 'ga4_ingresos'].every(
    isAdditiveMetric
  )
);
check(
  'las tasas NO son aditivas',
  !isAdditiveMetric('ga4_tasa_rebote') && !isAdditiveMetric('ga4_coste_sesion')
);
check(
  'rebote y costes: bajar es mejorar',
  isLowerBetter('ga4_tasa_rebote') && isLowerBetter('ga4_coste_sesion')
);
check(
  'los tokens antiguos de GA siguen apuntando a la cuenta (no se redirigen)',
  LEGACY_MEASURE_IDS.ga_sessions === 'cuenta.ga_sessions'
);

seccion('Eventos clave: token ga4ev: y alias ga4ev__');
check('ga4ev:purchase es un evento', isGa4EvMetric('ga4ev:purchase'));
check(
  'un nombre inválido no lo es',
  !isGa4EvMetric('ga4ev:') && !isGa4EvMetric('ga4ev:1x') && !isGa4EvMetric('ga4ev:a b')
);
check('parse → nombre', parseGa4EvMetric('ga4ev:generate_lead') === 'generate_lead');
check('make ↔ parse', parseGa4EvMetric(makeGa4EvMetric('purchase')) === 'purchase');
check('alias ga4ev__purchase', ga4EvAlias('purchase') === 'ga4ev__purchase');
check(
  'se extraen los alias de una fórmula',
  JSON.stringify(
    extractGa4EvAliases('spend / ga4ev__purchase + ga4ev__generate_lead').map((a) => a.evento)
  ) === '["purchase","generate_lead"]'
);
check('un evento es aditivo (la fila Total lo suma)', isAdditiveMetric('ga4ev:purchase'));
check('etiqueta legible', ga4EvLabel('ga4ev:purchase') === 'Evento clave: purchase (GA4)');
{
  const bases = basesAditivasDeFormula('spend / ga4ev__purchase');
  check(
    'spend / ga4ev__purchase se totaliza con sus bases',
    bases?.get('ga4ev__purchase') === 'ga4ev:purchase' && bases?.get('spend') === 'spend'
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Qué cruza con qué');
// ════════════════════════════════════════════════════════════════
for (const d of [
  'date',
  'utm_campaign',
  'campaign',
  'utm_id',
  'utm_source',
  'utm_medium',
  'utm_campaign_raw',
]) {
  check(`ga4_sesiones × ${d} → cruza`, metricCrossesDimension('ga4_sesiones', d));
}
for (const d of ['utm_content', 'utm_term', 'ad', 'adset', 'ip_country', 'form_name']) {
  check(`ga4_sesiones × ${d} → NO cruza`, !metricCrossesDimension('ga4_sesiones', d));
}
check(
  'ga4ev: cruza como las sesiones',
  metricCrossesDimension('ga4ev:purchase', 'utm_source') &&
    !metricCrossesDimension('ga4ev:purchase', 'ad')
);
check(
  'coste por sesión: campaña sí, fuente no (el gasto no tiene utm_source)',
  metricCrossesDimension('ga4_coste_sesion', 'utm_campaign') &&
    !metricCrossesDimension('ga4_coste_sesion', 'utm_source')
);
check(
  'coste por sesión: anuncio no (GA4 no lo tiene)',
  !metricCrossesDimension('ga4_coste_sesion', 'ad')
);
check(
  'sesión → lead cruza por fuente (leads y GA4 la tienen)',
  metricCrossesDimension('ga4_tasa_sesion_lead', 'utm_source')
);
check(
  'GA4 del sitio sigue siendo solo por fecha',
  metricCrossesDimension('ga_sessions', 'date') &&
    !metricCrossesDimension('ga_sessions', 'utm_campaign')
);
check('el gasto sigue cruzando por anuncio', metricCrossesDimension('spend', 'ad'));
check(
  "registro: ga4.sesiones → 'utm'",
  legacyBreakdownOfField(BASE_REGISTRY, 'ga4.sesiones') === 'utm'
);
check(
  "registro: ga4.coste_sesion → 'campaign_top'",
  legacyBreakdownOfField(BASE_REGISTRY, 'ga4.coste_sesion') === 'campaign_top'
);
check(
  "registro: ga4.tasa_sesion_lead → 'utm'",
  legacyBreakdownOfField(BASE_REGISTRY, 'ga4.tasa_sesion_lead') === 'utm'
);
check(
  "registro: cpl sigue en 'campaign'",
  legacyBreakdownOfField(BASE_REGISTRY, LEGACY_MEASURE_IDS.cpl) === 'campaign'
);

// ════════════════════════════════════════════════════════════════
seccion('Resolver: una fila de GA4 cae en la campaña del gasto');
// ════════════════════════════════════════════════════════════════
{
  const CAMP = 'F2[24|08][CBO][ASESORIA TRIBUTARIA][C LEADS]';
  const KEY = `meta:${CAMP_ID}`;
  const idx: CampaignIndex = {
    campaigns: new Map([
      [
        KEY,
        {
          key: KEY,
          campaign_id: CAMP_ID,
          name: CAMP,
          platform: 'meta',
          spend: 100,
          impressions: 0,
          clicks: 0,
          platform_leads: 0,
          extra: {},
        },
      ],
    ]),
    byCampaignId: new Map([[CAMP_ID, KEY]]),
    byAdId: new Map(),
    byName: new Map([[normLabel(CAMP), new Set([KEY])]]),
    byAdName: new Map(),
    byAdsetName: new Map(),
    adCanonicalByName: new Map(),
    adByAdId: new Map(),
    adsetCanonicalByName: new Map(),
    adsetByAdId: new Map(),
    adsActivos: new Set(),
    adsetsActivos: new Set(),
    adsetByAdsetId: new Map(),
    byAdsetId: new Map(),
    adCatalog: new Map(),
    adsetCatalog: new Map(),
  } as CampaignIndex;
  const r = buildResolver(idx, []);
  const porId = r.campaignOf({
    utm_source: 'fb',
    utm_medium: 'paid',
    utm_campaign: CAMP_ID,
    utm_id: CAMP_ID,
  });
  check(
    '`fb | paid | <id>` → la campaña real, cruce exacto',
    porId.label === CAMP && porId.matched
  );
  const porNombre = r.campaignOf({
    utm_source: 'Facebook_Right_Column',
    utm_medium: 'fb',
    utm_campaign: encodeURIComponent(CAMP),
  });
  check(
    'ubicación en source + nombre codificado en URL → la misma campaña',
    porNombre.label === CAMP && porNombre.matched
  );
  const google = r.campaignOf({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: CAMP });
  check('mismo nombre desde Google NO cae en el gasto de Meta', !google.matched);
  const directa = r.campaignOf({
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_id: null,
  });
  check('una visita directa cae en «(sin campaña)», como los leads', directa.label === SIN_CAMPANA);
}

// ════════════════════════════════════════════════════════════════
seccion('Cliente de GA4: propiedad, clave y errores accionables');
// ════════════════════════════════════════════════════════════════
check(
  'ID numérico → properties/<id>',
  normalizarPropiedadGa4('511475756')?.name === 'properties/511475756'
);
check(
  'con prefijo se normaliza igual',
  normalizarPropiedadGa4('properties/524635063')?.id === '524635063'
);
check('vacío → null', normalizarPropiedadGa4('  ') === null);
check('la clave privada deshace los \\n escapados', limpiarClavePrivada('a\\nb') === 'a\nb');
check('gRPC 7 → sin_permiso', clasificarErrorGa4({ code: 7, message: 'x' }) === 'sin_permiso');
check(
  'PERMISSION_DENIED en el texto → sin_permiso',
  clasificarErrorGa4(
    new Error('7 PERMISSION_DENIED: User does not have sufficient permissions')
  ) === 'sin_permiso'
);
check('gRPC 5 → no_encontrada', clasificarErrorGa4({ code: 5 }) === 'no_encontrada');
check(
  'invalid_grant → credenciales',
  clasificarErrorGa4(new Error('invalid_grant')) === 'credenciales'
);
check('gRPC 8 → cuota', clasificarErrorGa4({ code: 8 }) === 'cuota');
{
  const m = mensajeErrorGa4('sin_permiso', {
    via: 'oauth_agencia',
    propertyId: '511475756',
    email: 'cuentas@adshouseagencia.com',
  });
  check(
    'el mensaje nombra la cuenta y la propiedad',
    m.includes('cuentas@adshouseagencia.com') && m.includes('511475756')
  );
  check('y dice qué hacer', m.includes('Lector'));
}

// ════════════════════════════════════════════════════════════════
seccion('OAuth de Google: el state firmado de la agencia');
// ════════════════════════════════════════════════════════════════
{
  const ahora = Date.UTC(2026, 8, 28, 12);
  const f = firmarState(STATE_AGENCIA_GOOGLE, ahora);
  check('state de agencia + su nonce → válido', verificarStateGoogle(f.state, f.nonce, ahora).ok);
  check(
    'el state fijo de antes («agency») → rechazado',
    !verificarStateGoogle('agency', f.nonce, ahora).ok
  );
  check('sin cookie → rechazado', !verificarStateGoogle(f.state, null, ahora).ok);
  check(
    'con el nonce de otro navegador → rechazado',
    !verificarStateGoogle(f.state, 'otro', ahora).ok
  );
  check('caducado → rechazado', !verificarStateGoogle(f.state, f.nonce, ahora + 11 * 60_000).ok);
  const hm = firmarState('00000000-0000-0000-0000-000000000001', ahora);
  check(
    'un state firmado para Hotmart no sirve para Google',
    !verificarStateGoogle(hm.state, hm.nonce, ahora).ok
  );

  const cb = readFileSync('src/app/api/auth/google/callback/route.ts', 'utf8');
  check(
    'el callback valida el state ANTES de canjear el código',
    cb.includes('verificarStateGoogle') &&
      cb.indexOf('verificarStateGoogle(') < cb.indexOf('oauth.getToken(')
  );
  const ini = readFileSync('src/app/api/auth/google/route.ts', 'utf8');
  check(
    'iniciar el flujo exige sesión con rol admin',
    ini.includes('auth.getUser()') && ini.includes("'superadmin'")
  );
  check('ya no manda el state fijo', !/state:\s*'agency'/.test(ini));
}

// ════════════════════════════════════════════════════════════════
seccion('sync_jobs: todo tipo del código está en el último CHECK de migrations/');
// ════════════════════════════════════════════════════════════════
{
  // Un tipo que el CHECK no conoce hace fallar el INSERT; en `planDiario` eso
  // abortaba el resto del plan (ghl_leads, migración 094).
  const dir = 'migrations';
  let ultimo: string[] | null = null;
  let origen = '';
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const re = /sync_jobs_tipo_check\s+CHECK\s*\(\s*tipo\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      ultimo = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
      origen = f;
    }
  }
  check('hay un CHECK de sync_jobs en migrations/', !!ultimo, origen);
  const faltan = SYNC_JOB_TIPOS.filter((t) => !ultimo?.includes(t));
  check(`SYNC_JOB_TIPOS ⊆ CHECK de ${origen}`, faltan.length === 0, faltan.join(', '));
  check('incluye ga4', (SYNC_JOB_TIPOS as readonly string[]).includes('ga4'));
  check(
    'tieneGa4 con propiedad',
    tieneGa4({ ga_property_id: '524635063' }) && !tieneGa4({}) && !tieneGa4(null)
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Páginas: la ruta canónica (GA4 ≡ lead)');
// ════════════════════════════════════════════════════════════════
{
  const casos: Array<[string | null, string]> = [
    ['https://robla.pro/clase-gratis/?fbclid=IwAR1', '/clase-gratis'],
    ['/clase-gratis', '/clase-gratis'],
    ['/clase-gratis/', '/clase-gratis'],
    ['/Clase-Gratis#form', '/clase-gratis'],
    ['/asesoria-de-ahorro-tributario-v2/', '/asesoria-de-ahorro-tributario-v2'],
    ['(not set)', ''],
    ['', ''],
    [null, ''],
    ['/', '/'],
    ['https://cristributario.cl', '/'],
    ['//cdn.x.com/a/?q=1', '/a'],
    ['/a%C3%B1o', '/año'],
    ['/a//b/', '/a/b'],
    ['landing', '/landing'],
  ];
  for (const [entrada, esperado] of casos) {
    const r = rutaDePagina(entrada);
    check(`«${entrada}» → «${esperado}»`, r === esperado, r);
  }
  check('una % rota no rompe', rutaDePagina('/bad%E0%A4%A') === '/bad%e0%a4%a');
  check(
    'idempotente en todos los casos',
    casos.every(([e]) => rutaDePagina(rutaDePagina(e)) === rutaDePagina(e))
  );
  check(
    'el landingPage de GA4 y la page_url del lead dan la MISMA clave',
    rutaDePagina('/asesoria-de-ahorro-tributario-v3') ===
      rutaDePagina('https://cristributario.cl/asesoria-de-ahorro-tributario-v3/?fbclid=abc')
  );
  check('etiqueta de sin página', SIN_PAGINA === '(sin página)');
}

seccion('Páginas: peticiones');
{
  const l = peticionLanding('2026-09-01', '2026-09-27');
  const dl = l.dimensions.map((d) => d.name);
  check('landing: la tupla + landingPage', dl.at(-1) === 'landingPage' && dl.length === 6);
  check('landing: ≤ 9 dimensiones (límite de la API)', dl.length <= 9);
  check(
    'landing: pide totalUsers (visitantes)',
    l.metrics.some((m) => m.name === 'totalUsers')
  );
  check('landing: ordena por todas sus dimensiones', l.orderBys.length === dl.length);
  const v = peticionVistas('2026-09-01', '2026-09-27');
  check(
    'vistas: fecha, host y página + screenPageViews',
    JSON.stringify(v.dimensions.map((d) => d.name)) === '["date","hostName","pagePath"]' &&
      v.metrics[0].name === 'screenPageViews'
  );
  check('vistas: orden por sus 3 dimensiones', v.orderBys.length === 3);
}

seccion('Páginas: filas, colisiones y guardas');
{
  const DL = [...DIMS, 'landingPage'];
  const ML = ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue', 'totalUsers'];
  const r = resp(DL, ML, [
    [
      ['20260920', 'm.facebook.com', 'referral', '(referral)', '(not set)', '/asesoria-v2'],
      [41, 0, 0, 0, 41],
    ],
    // La misma página con barra final y mayúsculas: tras normalizar, la misma fila.
    [
      ['20260920', 'm.facebook.com', 'referral', '(referral)', '(not set)', '/Asesoria-v2/'],
      [9, 2, 1, 0, 8],
    ],
    [
      ['20260920', '(direct)', '(none)', '(direct)', '(not set)', '(not set)'],
      [3, 1, 0, 0, 3],
    ],
  ]);
  const f = filasLanding([r]);
  check('dos filas que solo difieren en la barra/mayúsculas se funden', f.length === 2);
  const a = f.find((x) => x.landing === '/asesoria-v2');
  check('suma sesiones y visitantes', a?.sesiones === 50 && a?.visitantes === 49);
  check(
    '(not set) → landing vacía',
    f.some((x) => x.landing === '' && x.sesiones === 3)
  );
  check(
    'la tupla UTM se normaliza igual que en campañas',
    a?.utm_campaign === '' && a?.utm_source === 'm.facebook.com'
  );

  const vr = resp(
    ['date', 'hostName', 'pagePath'],
    ['screenPageViews'],
    [
      [['20260908', 'cristributario.cl', '/asesoria-v3/'], [64]],
      [['20260908', 'CRISTRIBUTARIO.cl', '/asesoria-v3'], [6]],
      [['20260908', 'cristributario.cl', '/otra/'], [0]],
    ]
  );
  const fv = filasVistas([vr]);
  check(
    'vistas: la misma página en otra forma se funde (host en minúsculas)',
    fv.length === 1 && fv[0].vistas === 70
  );
  check('vistas: una fila con 0 vistas no se guarda', !fv.some((x) => x.pagina === '/otra'));

  check(
    'con sesiones y landing vacío → no se escribe landing',
    paginasSospechosas(10, [], fv).landing
  );
  check(
    'con sesiones y vistas vacías → no se escriben vistas',
    paginasSospechosas(10, f, []).vistas
  );
  const ok = paginasSospechosas(10, f, fv);
  check('con datos, se escriben las dos', !ok.landing && !ok.vistas);
  check('sin sesiones, un vacío no es sospechoso', !paginasSospechosas(0, [], []).landing);
  check('desvío 0 cuando cuadran', desvioLanding(53, f) === 0);
  check('desvío > 5 % detectado', desvioLanding(100, f) > 0.05);
}

// ════════════════════════════════════════════════════════════════
seccion('Páginas: qué cruza con qué (editor y registro de acuerdo)');
// ════════════════════════════════════════════════════════════════
{
  const debeCruzar: Array<[string, string]> = [
    ['ga4_sesiones', 'landing'],
    ['ga4_tasa_rebote', 'landing'],
    ['ga4_tasa_sesion_lead', 'landing'],
    ['ga4_visitantes', 'landing'],
    ['leads_count', 'landing'],
    ['ga4_vistas', 'ga4_pagina'],
    ['ga4_vistas', 'date'],
    ['ga4_visitantes', 'utm_campaign'],
    ['ga4_visitantes', 'utm_source'],
  ];
  const noDebeCruzar: Array<[string, string]> = [
    ['spend', 'landing'],
    ['cpl', 'landing'],
    ['sales_count', 'landing'],
    ['conversion_rate', 'landing'],
    ['hm_ventas', 'landing'],
    ['ga4_coste_sesion', 'landing'],
    ['ga4_roas', 'landing'],
    ['ga_sessions', 'landing'],
    ['ga4ev:purchase', 'landing'],
    ['leads_count', 'ga4_pagina'],
    ['ga4_sesiones', 'ga4_pagina'],
    ['ga4_vistas', 'landing'],
    ['ga4_vistas', 'utm_source'],
    ['ga4_vistas', 'utm_campaign'],
  ];
  for (const [m, d] of debeCruzar) check(`${m} × ${d} → cruza`, metricCrossesDimension(m, d));
  for (const [m, d] of noDebeCruzar) check(`${m} × ${d} → NO cruza`, !metricCrossesDimension(m, d));
  const discrepan = [...debeCruzar, ...noDebeCruzar]
    .filter(([m]) => !m.startsWith('ga4ev:'))
    .filter(
      ([m, d]) =>
        metricCrossesDimension(m, d) !==
        fieldCrossesDimension(BASE_REGISTRY, migrateMeasureId(m), migrateDimensionId(d))
    );
  check('el registro canónico dice lo mismo', discrepan.length === 0, JSON.stringify(discrepan));
  check(
    'las métricas de lead dinámicas cruzan por landing',
    metricCrossesDimension('leadseg:x', 'landing')
  );
  check(
    'GA4_POR_LANDING incluye visitantes y no los costes',
    GA4_POR_LANDING.has('ga4_visitantes') && !GA4_POR_LANDING.has('ga4_coste_sesion')
  );
  check(
    "registro: ga4_paginas.vistas → 'total'",
    legacyBreakdownOfField(BASE_REGISTRY, 'ga4_paginas.vistas') === 'total'
  );
  check('visitantes NO es aditiva (suma diaria)', !isAdditiveMetric('ga4_visitantes'));
  check('vistas SÍ es aditiva', isAdditiveMetric('ga4_vistas'));
  check(
    'pagos iniciados está en el grupo GA4',
    METRIC_META.hotmart_pagos_iniciados.group === 'ga4'
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Selector de campos: carpetas por proveedor');
// ════════════════════════════════════════════════════════════════
{
  const campo = (id: string, group: string) => ({
    id,
    canonicalId: id,
    label: id,
    help: '',
    kind: 'measure' as const,
    group,
  });
  const fuente = (
    id: string,
    fields: ReturnType<typeof campo>[],
    available = true
  ): CatalogSource => ({
    id,
    label: id,
    grain: 'daily',
    grainText: '',
    joinAxes: ['date'],
    available,
    fields,
  });
  const entrada: CatalogSource[] = [
    fuente('cliente_ga4ev', [campo('ga4ev:purchase', 'ga4')]),
    fuente('leads', [campo('leads_count', 'leads')]),
    fuente('hotmart', [campo('hm_ventas', 'hotmart')]),
    fuente('cuenta', [
      campo('ga_sessions', 'ga4'),
      campo('hotmart_pagos_iniciados', 'ga4'),
      campo('ventas_principal', 'hotmart'),
      campo('ventas_cerradas', 'manual'),
    ]),
    fuente('ga4', [campo('ga4_sesiones', 'ga4')]),
    fuente('ga4_paginas', [campo('ga4_vistas', 'ga4')]),
  ];
  const salida = agruparPorProveedor(entrada);
  const ids = salida.map((s) => s.id);
  const ga4 = salida.find((s) => s.id === CARPETA_GA4)!;
  const hm = salida.find((s) => s.id === CARPETA_HOTMART)!;
  const todos = (ss: CatalogSource[]) => ss.flatMap((s) => s.fields.map((f) => f.id)).sort();
  check(
    'no se pierde ni se duplica ningún campo',
    JSON.stringify(todos(entrada)) === JSON.stringify(todos(salida))
  );
  check(
    'una carpeta «Google Analytics 4» con todo lo de GA4',
    !!ga4 && ga4.label === 'Google Analytics 4'
  );
  check(
    'GA4 junta sitio, campaña, página, eventos y pagos iniciados',
    [
      'ga_sessions',
      'ga4_sesiones',
      'ga4_vistas',
      'ga4ev:purchase',
      'hotmart_pagos_iniciados',
    ].every((id) => ga4.fields.some((f) => f.id === id))
  );
  check(
    'secciones en orden: sitio → campaña → página → eventos',
    JSON.stringify([...new Set(ga4.fields.map((f) => f.group))]) ===
      '["Todo el sitio (por día)","Por campaña","Por página","Eventos clave"]'
  );
  check(
    'Hotmart junta las ventas y los totales por día',
    hm.fields.map((f) => f.id).join() === 'hm_ventas,ventas_principal'
  );
  check(
    '«Cuenta» se queda solo con lo manual',
    salida
      .find((s) => s.id === 'cuenta')
      ?.fields.map((f) => f.id)
      .join() === 'ventas_cerradas'
  );
  check(
    'la carpeta ocupa el sitio de su primera fuente',
    ids.indexOf(CARPETA_GA4) === 0 && ids.indexOf('leads') === 1
  );
  const sinCuenta = agruparPorProveedor([fuente('cuenta', [campo('ga_sessions', 'ga4')])]);
  check(
    'una fuente que se vacía desaparece',
    sinCuenta.length === 1 && sinCuenta[0].id === CARPETA_GA4
  );
  const bloqueada = agruparPorProveedor([
    fuente('ga4', [campo('ga4_sesiones', 'ga4')], false),
    fuente('cuenta', [campo('ga_sessions', 'ga4')]),
  ]);
  check('si una fuente no se puede leer, la carpeta tampoco', bloqueada[0].available === false);
  check('las carpetas traen su propio texto', !!ga4.nota && !!hm.nota);
}

seccion('Migración 100');
{
  const sql = readFileSync('migrations/100_ga4_paginas.sql', 'utf8');
  for (const t of ['ga4_landing_diarios', 'ga4_vistas_diarias']) {
    check(
      `${t}: FK en cascada`,
      new RegExp(`TABLE IF NOT EXISTS public\\.${t}[\\s\\S]*?ON DELETE CASCADE`).test(sql)
    );
    check(`${t}: RLS`, sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`));
  }
  for (const fn of [
    'ga4_reemplazar_paginas',
    'ga4_landing_resumen',
    'ga4_vistas_resumen',
    'bi_valores_pagina',
  ]) {
    check(`${fn}: GRANT`, new RegExp(`GRANT EXECUTE ON FUNCTION [a-z_.]*${fn}`).test(sql));
  }
  check(
    'los resúmenes ordenan (paginación estable)',
    (sql.match(/ORDER BY 1, 2/g) ?? []).length >= 2
  );
  check('termina recargando el esquema', /NOTIFY pgrst, 'reload schema';\s*$/.test(sql));
  check(
    'no toca el CHECK de sync_jobs (el job sigue siendo ga4)',
    !sql.includes('sync_jobs_tipo_check')
  );
}

console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
salir(fallos);
