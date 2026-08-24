/**
 * Comprobaciones del agregador de respuestas de formulario del dashboard.
 *
 * Todo lo que decide una cifra del bloque —qué campañas pasan el filtro, qué días
 * entran, cómo se recorta el Top-N y de dónde sale el denominador del
 * porcentaje— es puro, así que se verifica sin Postgres. Los fixtures son los
 * casos REALES de producción: los dos nombres de la misma pregunta de Goodprop y
 * las dos escrituras del mismo rango de Sur Profundo.
 *
 *   npx tsx scripts/verify-lead-answers.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  agregarRespuestas,
  campanasPermitidas,
  fechasEnRango,
  SIN_CAMPANA,
  BUCKET_RESTO,
  clavesDelDia,
  clavesDeCampo,
  claveSinRespuesta,
  slugRespuesta,
  serieDiaria,
  CLAVE_TOTAL_LEADS,
  PREFIJO_RESPUESTA,
  formulaUsaRespuestas,
  camposEnFormula,
} from '../src/lib/dashboard/lead-answer-aggregation';
import {
  refDeCubo,
  clavesYRefDelDia,
  reDerivarRespuestas,
} from '../src/lib/dashboard/lead-answer-row';
import { buildAvailableMetrics, esSumandoDeSheet } from '../src/lib/dashboard/metric-catalog';
import { aggregateRankingRows, dimensionSoportaRespuestas } from '../src/lib/ranking-aggregation';
import type { LeadAnswerDatasetLite } from '../src/lib/dashboard/lead-answer-aggregation';
import { campoSintetico } from '../src/lib/report-utm/lead-answers-db';
import { bucketDeValor } from '../src/lib/report-utm/lead-campos';
import type { LeadAnswerBlockDef, TabCampaignFilter } from '../src/lib/layout-types';

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

// ── Fixtures ──────────────────────────────────────────────────────────
// Diccionario: 0 = (sin campaña) SIEMPRE, luego dos campañas reales.
const CAMPANAS = [SIN_CAMPANA, 'CAMP-Bogota-Renta', 'CAMP-Medellin-LP'];
const IDS = [null, '120111', '120222'];

/** Buckets del campo, en el orden que dejó el analista (de menor a mayor). */
const BUCKETS = ['Menos de $2M', '$2M a $3M', '$3M a $5M', 'Más de $5M'];

function ds(porFecha: LeadAnswerDatasetLite['porFecha']): LeadAnswerDatasetLite {
  return {
    campanas: CAMPANAS,
    campanaIds: IDS,
    campos: [
      {
        clave: 'rango_ingresos',
        nombre: 'Rango de ingresos',
        buckets: BUCKETS,
        claves_origen: ['cual_es_tu_rango_de_ingresos', 'cual_es_tu_rango_aproximado_de_ingresos'],
        origen: 'catalogo',
        cobertura: 0,
      },
    ],
    porFecha,
    incompleto: false,
  };
}

// [bucketIdx, campanaIdx, n]
const BASE = ds({
  '2026-07-01': [
    [
      [0, 1, 10],
      [1, 1, 40],
      [1, 2, 20],
      [2, 2, 30],
    ],
  ],
  '2026-07-15': [
    [
      [1, 1, 25],
      [2, 1, 15],
      [3, 0, 8],
    ],
  ],
  '2026-08-02': [
    [
      [0, 1, 5],
      [1, 2, 5],
    ],
  ],
});

/**
 * Dos campañas reales el mismo día, con totales. Bogotá aporta 30 contactos (15
 * de ellos en el primer bucket) y Medellín 10: es el fixture con el que se
 * comprueba que un filtro de bloque recorta de verdad.
 */
const CON_TOTALES_2CAMP: LeadAnswerDatasetLite = {
  ...ds({
    '2026-07-01': [
      [
        [0, 1, 15],
        [1, 2, 4],
      ],
    ],
  }),
  totalesPorFecha: {
    '2026-07-01': [
      [1, 30],
      [2, 10],
    ],
  },
};

/** Réplica de la inyección del dashboard, para probar la fila tal como se usa. */
function inyectarRespuestasParaTest(
  dsx: LeadAnswerDatasetLite,
  keyword: string,
  groups: any[]
): any[] {
  const ref = refDeCubo(dsx, keyword, groups);
  return [{ fecha: '2026-07-01', meta_spend: 100, ...clavesYRefDelDia(ref, '2026-07-01') }];
}

const DEF: LeadAnswerBlockDef = {
  id: 'b1',
  title: 'Rango de ingresos',
  origen: 'catalogo',
  clave: 'rango_ingresos',
  topN: 12,
  agruparResto: true,
  showDelta: false,
};

// ════════════════════════════════════════════════════════════════
seccion('Sin filtro: cuenta todo, incluidos los leads sin campaña');

const todo = agregarRespuestas(BASE, DEF, '', []);
// 10+40+20+30 + 25+15+8 + 5+5 = 158
check('el total suma todos los tripletes', todo.total === 158, `total=${todo.total}`);
check('no hay leads declarados fuera de filtro', todo.sinCruce === 0);
check(
  'los leads sin campaña identificada SÍ cuentan sin filtro',
  (todo.buckets.find((b) => b.label === 'Más de $5M')?.leads ?? 0) === 8
);
check(
  'los porcentajes suman 100',
  Math.abs(todo.buckets.reduce((s, b) => s + b.pct, 0) - 100) < 0.05,
  String(todo.buckets.reduce((s, b) => s + b.pct, 0))
);
check(
  'el orden es el del catálogo, no el de frecuencia',
  todo.buckets.map((b) => b.label).join('|') === BUCKETS.join('|'),
  todo.buckets.map((b) => b.label).join('|')
);

// ════════════════════════════════════════════════════════════════
seccion('Filtro de campaña de la pestaña');

const soloBogota = agregarRespuestas(BASE, DEF, 'Bogota', []);
// 10+40 (jul-01) + 25+15 (jul-15) + 5 (ago-02) = 95
check('recorta a la campaña filtrada', soloBogota.total === 95, `total=${soloBogota.total}`);
check(
  'declara los leads sin campaña que quedan fuera',
  soloBogota.sinCruce === 8,
  `sinCruce=${soloBogota.sinCruce}`
);
check(
  'con filtro, el bucket que solo tenía leads sin campaña queda en 0',
  (soloBogota.buckets.find((b) => b.label === 'Más de $5M')?.leads ?? -1) === 0
);
check(
  'los porcentajes vuelven a sumar 100 sobre el nuevo total',
  Math.abs(soloBogota.buckets.reduce((s, b) => s + b.pct, 0) - 100) < 0.05
);

const permitidas = campanasPermitidas(BASE, 'Bogota', undefined, []);
check('el índice 0 (sin campaña) no pasa un filtro activo', !permitidas.has(0));
check('la campaña que coincide sí pasa', permitidas.has(1));
check('la que no coincide no pasa', !permitidas.has(2));

// ════════════════════════════════════════════════════════════════
seccion('Filtro compuesto de pestaña (el formato __cf: ya parseado)');

const filtroOr: TabCampaignFilter = {
  mode: 'or',
  conditions: [
    { type: 'keyword', operator: 'includes', value: 'Bogota' },
    { type: 'keyword', operator: 'includes', value: 'Medellin' },
  ],
};
const filtroAnd: TabCampaignFilter = {
  mode: 'and',
  conditions: [
    { type: 'keyword', operator: 'includes', value: 'CAMP' },
    { type: 'keyword', operator: 'excludes', value: 'Medellin' },
  ],
};
const conOr = agregarRespuestas(BASE, DEF, filtroOr, []);
const conAnd = agregarRespuestas(BASE, DEF, filtroAnd, []);
check('modo O suma las dos campañas', conOr.total === 150, `total=${conOr.total}`);
check('modo Y con exclusión deja solo Bogotá', conAnd.total === 95, `total=${conAnd.total}`);
check('modo O sigue dejando fuera los leads sin campaña', conOr.sinCruce === 8);

// Regresión: `(sin campaña)` es una etiqueta sintética, no el nombre de nada.
// Pasarla por el comparador de texto la hacía coincidir con filtros tan
// corrientes como «camp» —porque "(sin campaña)" contiene "camp"—, y entonces
// una pestaña de campaña sumaba justo los leads que no se sabe de dónde vienen.
const filtroQueRozaLaEtiqueta = agregarRespuestas(BASE, DEF, 'camp', []);
check(
  'un filtro que roza la etiqueta sintética NO arrastra los leads sin campaña',
  filtroQueRozaLaEtiqueta.sinCruce === 8 && filtroQueRozaLaEtiqueta.total === 150,
  `total=${filtroQueRozaLaEtiqueta.total} sinCruce=${filtroQueRozaLaEtiqueta.sinCruce}`
);
check(
  '…y tampoco entra por un filtro de bloque',
  !campanasPermitidas(BASE, '', { type: 'keyword', operator: 'includes', value: 'camp' }, []).has(0)
);

// ════════════════════════════════════════════════════════════════
seccion('Recorte de fechas de la pestaña');

check(
  'fechasEnRango recorta por comparación de strings',
  fechasEnRango(BASE.porFecha, '2026-07-01', '2026-07-31').sort().join(',') ===
    '2026-07-01,2026-07-15'
);

const soloJulio = agregarRespuestas(BASE, DEF, '', [], {
  fechaInicio: '2026-07-01',
  fechaFin: '2026-07-31',
});
// 158 - (5+5) de agosto = 148
check(
  'el bloque respeta fecha_inicio/fecha_finalizacion de la pestaña',
  soloJulio.total === 148,
  `total=${soloJulio.total}`
);

const sinLimite = agregarRespuestas(BASE, DEF, '', [], { fechaInicio: null, fechaFin: null });
check('sin recorte de fechas entra todo', sinLimite.total === 158);

// ════════════════════════════════════════════════════════════════
seccion('Top-N: nada se descarta en silencio');

const muchos: LeadAnswerDatasetLite = {
  ...BASE,
  campos: [{ ...BASE.campos[0], buckets: ['a', 'b', 'c', 'd', 'e'] }],
  porFecha: {
    '2026-07-01': [
      [
        [0, 1, 50],
        [1, 1, 40],
        [2, 1, 30],
        [3, 1, 20],
        [4, 1, 10],
      ],
    ],
  },
};

const conResto = agregarRespuestas(muchos, { ...DEF, topN: 3, agruparResto: true }, '', []);
check('agrupar el resto conserva el total', conResto.total === 150, `total=${conResto.total}`);
check(
  'aparece el bucket sintético con su recuento',
  conResto.buckets.some((b) => b.esResto && b.label.startsWith(BUCKET_RESTO) && b.leads === 30),
  JSON.stringify(conResto.buckets.map((b) => [b.label, b.leads]))
);
check(
  'los porcentajes con resto agrupado suman 100',
  Math.abs(conResto.buckets.reduce((s, b) => s + b.pct, 0) - 100) < 0.05
);

const sinResto = agregarRespuestas(muchos, { ...DEF, topN: 3, agruparResto: false }, '', []);
check(
  'sin agrupar, los leads recortados se DECLARAN',
  sinResto.omitidos === 30,
  `omitidos=${sinResto.omitidos}`
);
check(
  'sin agrupar, el denominador excluye lo recortado',
  sinResto.total === 120,
  `total=${sinResto.total}`
);
check(
  'sin agrupar, los porcentajes siguen sumando 100',
  Math.abs(sinResto.buckets.reduce((s, b) => s + b.pct, 0) - 100) < 0.05
);

// ════════════════════════════════════════════════════════════════
seccion('Comparativo con el período anterior');

const PREV = ds({
  '2026-06-15': [
    [
      [0, 1, 5],
      [1, 1, 50],
      [2, 1, 30],
    ],
  ],
});
const conDelta = agregarRespuestas(BASE, { ...DEF, showDelta: true }, '', [], { prev: PREV });

const b2m = conDelta.buckets.find((b) => b.label === '$2M a $3M')!;
// actual 40+20+25+5 = 90, previo 50 → +80%
check(
  'el delta compara contra el mismo bucket del período anterior',
  b2m.leadsPrevio === 50 && Math.abs((b2m.delta ?? 0) - 80) < 0.01,
  `previo=${b2m.leadsPrevio} delta=${b2m.delta}`
);

const bMas5 = conDelta.buckets.find((b) => b.label === 'Más de $5M')!;
check(
  'un denominador en cero devuelve null, no Infinity ni +100%',
  bMas5.delta === null && bMas5.leadsPrevio === 0,
  `delta=${bMas5.delta}`
);

check(
  'el recorte de fechas de la pestaña NO se aplica al período anterior',
  agregarRespuestas(BASE, { ...DEF, showDelta: true }, '', [], {
    prev: PREV,
    fechaInicio: '2026-07-01',
    fechaFin: '2026-07-31',
  }).buckets.find((b) => b.label === '$2M a $3M')?.leadsPrevio === 50
);

// El catálogo del período anterior puede tener otros buckets: cruzarlos por
// POSICIÓN emparejaría barras distintas sin que nada lo delatara.
const PREV_OTRO_ORDEN: LeadAnswerDatasetLite = {
  ...PREV,
  campos: [{ ...PREV.campos[0], buckets: ['$3M a $5M', '$2M a $3M'] }],
  porFecha: {
    '2026-06-15': [
      [
        [0, 1, 30],
        [1, 1, 50],
      ],
    ],
  },
};
check(
  'el emparejamiento del comparativo es por etiqueta, no por índice',
  agregarRespuestas(BASE, { ...DEF, showDelta: true }, '', [], {
    prev: PREV_OTRO_ORDEN,
  }).buckets.find((b) => b.label === '$2M a $3M')?.leadsPrevio === 50
);

// ════════════════════════════════════════════════════════════════
seccion('El caso Goodprop: una pregunta, dos claves, un solo bucket');

// Producción: la misma pregunta llega como `cual_es_tu_rango_de_ingresos`
// (6.815 leads vía Meta) y `¿cuál_es_tu_rango_aproximado_de_ingresos?` (2.099
// vía web). Un campo del catálogo las une; el desglose tiene que sumarlas.
const campoUnificado = {
  ...campoSintetico('rango', 'Rango de ingresos', [
    'cual_es_tu_rango_de_ingresos',
    'cual_es_tu_rango_aproximado_de_ingresos',
  ]),
  // Las dos escrituras reales del mismo rango, fundidas por el analista.
  valores_map: {
    'entre $2.000.000 a $4.000.000': '$2M a $4M',
    'entre_$2.000.000_y_$4.000.000': '$2M a $4M',
  },
};
check(
  'las dos escrituras del mismo rango caen en el mismo bucket',
  bucketDeValor(campoUnificado, 'Entre $2.000.000 a $4.000.000') ===
    bucketDeValor(campoUnificado, 'entre_$2.000.000_y_$4.000.000'),
  `${bucketDeValor(campoUnificado, 'Entre $2.000.000 a $4.000.000')} vs ${bucketDeValor(campoUnificado, 'entre_$2.000.000_y_$4.000.000')}`
);

// Y en el cubo: dos filas crudas distintas, un solo bucket, sumadas.
const unificado = ds({
  '2026-07-01': [
    [
      [1, 1, 6815],
      [1, 2, 2099],
    ],
  ],
});
check(
  'el bloque suma las dos vías en una sola barra',
  agregarRespuestas(unificado, DEF, '', []).buckets.find((b) => b.label === '$2M a $3M')?.leads ===
    8914
);

// ════════════════════════════════════════════════════════════════
seccion('Campo sintético (pregunta auto-detectada)');

const auto = campoSintetico('auto:x', 'Rango de renta', ['rango_de_renta']);
check(
  'sin agrupación configurada, el valor normalizado ES el bucket',
  bucketDeValor(auto, 'Entre $2.000.000 a $3.000.000') === 'entre $2.000.000 a $3.000.000'
);
check('un valor vacío no produce bucket', bucketDeValor(auto, '   ') === null);
check(
  "con sin_mapear='ignorar' el valor se descarta",
  bucketDeValor({ ...auto, sin_mapear: 'ignorar' }, 'lo que sea') === null
);

// ════════════════════════════════════════════════════════════════
seccion('Estados degradados');

check(
  'un dataset vacío se declara ausente, no como 0 leads',
  agregarRespuestas(
    { campanas: [], campanaIds: [], campos: [], porFecha: {}, incompleto: false },
    DEF,
    '',
    []
  ).campoAusente
);
check(
  'un campo borrado del catálogo se declara ausente',
  agregarRespuestas(BASE, { ...DEF, clave: 'ya_no_existe' }, '', []).campoAusente
);
check(
  'un bloque auto sin claves no encuentra campo',
  agregarRespuestas(BASE, { ...DEF, origen: 'auto', clave: undefined, clavesOrigen: [] }, '', [])
    .campoAusente
);
check(
  'un bloque auto localiza su campo por las claves de origen',
  !agregarRespuestas(
    { ...BASE, campos: [{ ...BASE.campos[0], origen: 'auto', claves_origen: ['k1', 'k2'] }] },
    { ...DEF, origen: 'auto', clave: undefined, clavesOrigen: ['k2', 'k1'] },
    '',
    []
  ).campoAusente
);

const conVacios = agregarRespuestas(BASE, { ...DEF, ocultarVacios: true }, 'Bogota', []);
check('ocultarVacios quita los buckets en cero', !conVacios.buckets.some((b) => b.leads === 0));
check('ocultar vacíos no cambia el total', conVacios.total === 95, `total=${conVacios.total}`);

// ════════════════════════════════════════════════════════════════
seccion('Total diario y claves de fórmula');
// ════════════════════════════════════════════════════════════════
// El caso del enunciado: «hoy se registraron 40; 15 respondieron A, 5 B, 3 C».
// Los 17 restantes tienen que aparecer como (sin respuesta) o la tabla no cuadra.
const CON_TOTALES: LeadAnswerDatasetLite = {
  ...ds({
    '2026-07-01': [
      [
        [0, 1, 15],
        [1, 1, 5],
        [2, 1, 3],
      ],
    ],
  }),
  totalesPorFecha: { '2026-07-01': [[1, 40]] },
};

{
  const todas = campanasPermitidas(CON_TOTALES, '', undefined, []);
  const k = clavesDelDia(CON_TOTALES, '2026-07-01', todas);
  const campo = CON_TOTALES.campos[0];
  const claves = clavesDeCampo(campo);

  check(
    'utm_leads es el total de contactos del día',
    k[CLAVE_TOTAL_LEADS] === 40,
    String(k[CLAVE_TOTAL_LEADS])
  );
  check(
    'cada respuesta tiene su clave con su conteo',
    k[claves[0].clave] === 15 && k[claves[1].clave] === 5 && k[claves[2].clave] === 3,
    JSON.stringify(claves.map((c) => [c.clave, k[c.clave]]))
  );
  check(
    '(sin respuesta) recoge a los que no contestaron',
    k[claveSinRespuesta(campo)] === 17,
    String(k[claveSinRespuesta(campo)])
  );

  // La invariante que hace legible la tabla diaria.
  const sumaBuckets =
    claves.reduce((s, c) => s + (k[c.clave] ?? 0), 0) + (k[claveSinRespuesta(campo)] ?? 0);
  check(
    'respuestas + (sin respuesta) == utm_leads',
    sumaBuckets === k[CLAVE_TOTAL_LEADS],
    `${sumaBuckets} vs ${k[CLAVE_TOTAL_LEADS]}`
  );

  // Un bucket sin leads ese día emite 0, no se omite: si no, una gráfica por
  // fecha dibujaría huecos en vez de ceros.
  check(
    'los buckets sin leads emiten 0 explícito',
    k[claves[3].clave] === 0,
    String(k[claves[3].clave])
  );
}

{
  // El motivo por el que las claves se calculan en el cliente: si no
  // respetaran el filtro de la pestaña, `meta_spend / lf__x` dividiría un
  // gasto recortado entre unos leads que no lo están.
  const MIXTO: LeadAnswerDatasetLite = {
    ...ds({
      '2026-07-01': [
        [
          [0, 1, 15],
          [1, 2, 5],
        ],
      ],
    }),
    totalesPorFecha: {
      '2026-07-01': [
        [1, 30],
        [2, 10],
      ],
    },
  };
  const soloUna = campanasPermitidas(MIXTO, 'Bogota', undefined, []);
  const k = clavesDelDia(MIXTO, '2026-07-01', soloUna);
  const claves = clavesDeCampo(MIXTO.campos[0]);
  check(
    'utm_leads respeta el filtro de campaña',
    k[CLAVE_TOTAL_LEADS] === 30,
    String(k[CLAVE_TOTAL_LEADS])
  );
  check(
    'las claves por respuesta también lo respetan',
    k[claves[0].clave] === 15 && k[claves[1].clave] === 0,
    JSON.stringify([k[claves[0].clave], k[claves[1].clave]])
  );
  check(
    '(sin respuesta) se recalcula sobre el total filtrado',
    k[claveSinRespuesta(MIXTO.campos[0])] === 15,
    String(k[claveSinRespuesta(MIXTO.campos[0])])
  );
}

{
  // Sin totales cargados no se inventa un denominador: la clave no existe y
  // `(sin respuesta)` tampoco, en vez de salir igual a los que respondieron.
  const k = clavesDelDia(BASE, '2026-07-01', campanasPermitidas(BASE, '', undefined, []));
  check('sin totales no se emite utm_leads', k[CLAVE_TOTAL_LEADS] === undefined);
  check(
    'sin totales no se inventa (sin respuesta)',
    k[claveSinRespuesta(BASE.campos[0])] === undefined
  );
}

check(
  'el slug de una respuesta ignora acentos y signos',
  slugRespuesta('Entre $2.000.000 – $3.000.000') === 'entre_2_000_000_3_000_000',
  slugRespuesta('Entre $2.000.000 – $3.000.000')
);
check(
  'dos respuestas que colisionan reciben claves distintas',
  (() => {
    const c = clavesDeCampo({ clave: 'x', buckets: ['$2M a $3M', '$2M – $3M'] });
    return c[0].clave !== c[1].clave;
  })()
);
check(
  'una respuesta llamada como el sufijo reservado no lo pisa',
  (() => {
    const c = clavesDeCampo({ clave: 'x', buckets: ['Sin respuesta'] });
    return c[0].clave !== claveSinRespuesta({ clave: 'x' });
  })()
);

// ════════════════════════════════════════════════════════════════
seccion('Tabla diaria');
// ════════════════════════════════════════════════════════════════
{
  const { dias, buckets } = serieDiaria(CON_TOTALES, DEF, '', []);
  check('hay una fila por día', dias.length === 1);
  check('la fila trae el total del día', dias[0].total === 40, String(dias[0].total));
  check(
    'el reparto por respuesta es el esperado',
    dias[0].porBucket.slice(0, 3).join(',') === '15,5,3',
    dias[0].porBucket.join(',')
  );
  check(
    'cada fila cierra: total = respuestas + sin responder',
    dias[0].porBucket.reduce((s, n) => s + n, 0) + dias[0].sinRespuesta === dias[0].total
  );
  check('las columnas son los buckets del campo', buckets.join('|') === BUCKETS.join('|'));
}
{
  // Un día con contactos y CERO respuestas tiene que aparecer igualmente, con
  // todo en (sin respuesta). Si solo se recorriera `porFecha`, desaparecería.
  const CON_DIA_MUDO: LeadAnswerDatasetLite = {
    ...ds({ '2026-07-01': [[[0, 1, 15]]] }),
    totalesPorFecha: { '2026-07-01': [[1, 20]], '2026-07-02': [[1, 12]] },
  };
  const { dias } = serieDiaria(CON_DIA_MUDO, DEF, '', []);
  check(
    'un día sin ninguna respuesta no desaparece de la tabla',
    dias.length === 2,
    dias.map((d) => d.fecha).join(',')
  );
  const mudo = dias.find((d) => d.fecha === '2026-07-02')!;
  check(
    'ese día muestra su total y todo en (sin respuesta)',
    mudo.total === 12 && mudo.sinRespuesta === 12
  );
}
{
  const { dias } = serieDiaria(CON_TOTALES, DEF, 'Medellin', []);
  check(
    'la tabla diaria respeta el filtro de campaña',
    dias.every((d) => d.total === 0 || d.porBucket.every((n) => n === 0)),
    JSON.stringify(dias)
  );
}

// ════════════════════════════════════════════════════════════════
seccion('El selector ofrece lo que el catálogo genera');
// ════════════════════════════════════════════════════════════════
// REGRESIÓN: el filtro del selector descartaba toda métrica cuyo id contuviera
// `__`, una guarda pensada para los sumandos de Sheet. Escondía TODAS las
// métricas por respuesta y nadie se enteraba: no había ni un test que cruzara el
// catálogo con el predicado del selector.
{
  const campo = { clave: 'rango_de_ingresos', nombre: 'Rango de ingresos', buckets: BUCKETS };
  const opciones = buildAvailableMetrics([], undefined, [], [], true, [campo]);
  const ofrecibles = opciones.filter((m) => !esSumandoDeSheet(m.id)).map((m) => m.id);

  check(
    'cada respuesta del campo se puede elegir en el selector',
    clavesDeCampo(campo).every(({ clave }) => ofrecibles.includes(clave)),
    clavesDeCampo(campo)
      .map((c) => c.clave)
      .join(', ')
  );
  check('el (sin respuesta) también', ofrecibles.includes(claveSinRespuesta(campo)));
  check('utm_leads también', ofrecibles.includes(CLAVE_TOTAL_LEADS));

  check(
    'los sumandos internos de Sheet siguen fuera',
    esSumandoDeSheet('sf_x__num') &&
      esSumandoDeSheet('sv_y__den') &&
      esSumandoDeSheet('sf_x__min') &&
      esSumandoDeSheet('sf_x__max')
  );
  check(
    'una métrica por respuesta NO se confunde con un sumando',
    !esSumandoDeSheet('lf__rango__2m_3m') && !esSumandoDeSheet(claveSinRespuesta(campo))
  );
  check('un campo de Sheet normal tampoco', !esSumandoDeSheet('sf_leads_calificados'));

  // Un campo del que no se conocen los buckets no aporta nada: ofrecer solo su
  // (sin respuesta) sería el complemento de un conjunto invisible.
  const sinBuckets = buildAvailableMetrics([], undefined, [], [], true, [
    { clave: 'x', nombre: 'X', buckets: [], sinBuckets: true },
  ]);
  check(
    'un campo sin buckets conocidos no ofrece métricas',
    !sinBuckets.some((m) => m.id.startsWith(`${PREFIJO_RESPUESTA}x__`))
  );
}

// ════════════════════════════════════════════════════════════════
seccion('El filtro de un BLOQUE recorta las claves de la fila');
// ════════════════════════════════════════════════════════════════
// REGRESIÓN: los escalares se calculaban con el filtro de la PESTAÑA y se
// congelaban en la fila. `applyCompoundFilter` solo recalcula las claves
// `meta_*`, así que una tarjeta con filtro propio dividía un gasto recortado
// entre los leads de toda la pestaña: el CPL salía hundido y nada lo delataba.
{
  const filas = inyectarRespuestasParaTest(CON_TOTALES_2CAMP, '', []);
  const fila = filas[0];
  const antes = fila[CLAVE_TOTAL_LEADS];

  check('sin filtro de bloque la fila trae el total de la pestaña', antes === 40, String(antes));

  const conBloque = reDerivarRespuestas(fila, {
    type: 'keyword',
    operator: 'includes',
    value: 'Bogota',
  })!;
  check(
    'con filtro de bloque el total baja al subconjunto',
    conBloque[CLAVE_TOTAL_LEADS] === 30,
    String(conBloque[CLAVE_TOTAL_LEADS])
  );
  check(
    'las claves por respuesta también se recortan',
    conBloque[clavesDeCampo(CON_TOTALES_2CAMP.campos[0])[0].clave] === 15,
    JSON.stringify(conBloque)
  );
  check(
    '(sin respuesta) se recalcula sobre el total recortado',
    conBloque[claveSinRespuesta(CON_TOTALES_2CAMP.campos[0])] === 15
  );
  check(
    'la cuenta sigue cerrando tras recortar',
    clavesDeCampo(CON_TOTALES_2CAMP.campos[0]).reduce((s, c) => s + (conBloque[c.clave] ?? 0), 0) +
      conBloque[claveSinRespuesta(CON_TOTALES_2CAMP.campos[0])] ===
      conBloque[CLAVE_TOTAL_LEADS]
  );

  check('la re-derivación NO muta la fila original', fila[CLAVE_TOTAL_LEADS] === antes);

  // El filtro del bloque se ENCADENA sobre el de la pestaña, no lo sustituye.
  const conPestana = inyectarRespuestasParaTest(CON_TOTALES_2CAMP, 'Medellin', [])[0];
  const encadenado = reDerivarRespuestas(conPestana, {
    type: 'keyword',
    operator: 'includes',
    value: 'Bogota',
  })!;
  check(
    'pestaña y bloque se encadenan (intersección vacía → 0)',
    encadenado[CLAVE_TOTAL_LEADS] === 0,
    String(encadenado[CLAVE_TOTAL_LEADS])
  );

  check(
    'una fila sin cubo devuelve null, no un objeto vacío',
    reDerivarRespuestas({ fecha: '2026-07-01' }, undefined) === null
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Rankings: reparto por campaña y "no aplica"');
// ════════════════════════════════════════════════════════════════
{
  check(
    'solo la dimensión de campañas sirve respuestas',
    dimensionSoportaRespuestas('campaigns') &&
      !dimensionSoportaRespuestas('ads') &&
      !dimensionSoportaRespuestas('adsets') &&
      !dimensionSoportaRespuestas('tiktok_campaigns')
  );

  const filas = inyectarRespuestasParaTest(CON_TOTALES_2CAMP, '', []);
  const conCampanas = filas.map((f) => ({
    ...f,
    meta_campaigns: [
      { campaign_id: 'c1', name: 'CAMP-Bogota-Renta', spend: '100', leads: '5' },
      { campaign_id: 'c2', name: 'CAMP-Medellin-LP', spend: '50', leads: '2' },
    ],
    meta_ads: [{ ad_id: 'a1', ad_name: 'AD-1', campaign_name: 'CAMP-Bogota-Renta', spend: '100' }],
  }));

  const porCampana = aggregateRankingRows(conCampanas, 'campaigns', undefined, undefined, '', []);
  const bogota = porCampana.find((r: any) => r._id === 'c1');
  check(
    'el ranking por campaña recibe los contactos',
    bogota?.[CLAVE_TOTAL_LEADS] === 30,
    String(bogota?.[CLAVE_TOTAL_LEADS])
  );
  check(
    'y también las respuestas',
    bogota?.[clavesDeCampo(CON_TOTALES_2CAMP.campos[0])[0].clave] === 15
  );
  check(
    'el reparto no pierde leads',
    porCampana.reduce((s: number, r: any) => s + (r[CLAVE_TOTAL_LEADS] ?? 0), 0) === 40,
    String(porCampana.reduce((s: number, r: any) => s + (r[CLAVE_TOTAL_LEADS] ?? 0), 0))
  );

  const porAnuncio = aggregateRankingRows(conCampanas, 'ads', undefined, undefined, '', []);
  check(
    'el ranking por anuncio NO recibe claves de respuestas (ausencia deliberada)',
    porAnuncio.every((r: any) => r[CLAVE_TOTAL_LEADS] === undefined)
  );

  check(
    'formulaUsaRespuestas detecta las dos familias',
    formulaUsaRespuestas('meta_spend / utm_leads') &&
      formulaUsaRespuestas('lf__x__y') &&
      !formulaUsaRespuestas('meta_spend / meta_leads')
  );
  check(
    'formulaUsaRespuestas no captura total_utm_leads por accidente',
    !formulaUsaRespuestas('total_utm_leads')
  );
}

// ════════════════════════════════════════════════════════════════
seccion('Resolución de campos mencionados por una fórmula');
// ════════════════════════════════════════════════════════════════
check(
  'camposEnFormula resuelve contra el catálogo, sin ambigüedad',
  camposEnFormula('lf__a_b__x + lf__c__y', ['a_b', 'c']).sort().join(',') === 'a_b,c'
);
check(
  'una clave que no está en el catálogo no se inventa',
  camposEnFormula('lf__zzz__x', ['a', 'b']).length === 0
);
check(
  'el prefijo tiene que ir seguido de __ para contar',
  camposEnFormula('lf__ab__x', ['a']).length === 0
);

// ════════════════════════════════════════════════════════════════
console.log(
  fallos === 0
    ? '\n✅ Respuestas de formulario: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
