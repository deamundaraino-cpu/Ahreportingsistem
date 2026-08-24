/**
 * Comprobaciones de los segmentos de campo de lead (migración 073).
 *
 * Un segmento es un subconjunto con nombre de los buckets de un campo —«Desde
 * 2M» = estos tres— ofrecido como MÉTRICA. Todo lo que decide su valor es puro,
 * así que se verifica sin Postgres, con los casos reales de producción.
 *
 *   npx tsx scripts/verify-lead-segmentos.ts
 */

import {
  segmentoIncluyeBucket,
  cuentaEnSegmento,
  bucketsAcumulados,
  indexarRawFields,
  normalizarValorCrudo,
} from '../src/lib/report-utm/lead-campos';
import type { LeadCampoDef, LeadSegmentoDef } from '../src/lib/report-utm/lead-campos';
import {
  makeLeadSegMetric,
  isLeadSegMetric,
  parseLeadSegMetric,
  leadSegAlias,
  extractLeadSegAliases,
  leadSegLabel,
  isLeadFieldDim,
  isSheetToken,
  isFieldMetric,
  isAdditiveMetric,
  supportsPivot,
  esEtapaDeEmbudo,
  extractFieldMetricAliases,
  extractSheetAliases,
  extractOfflineFieldAliases,
  hasNonAttributableFilter,
  makeLeadFieldDim,
} from '../src/lib/report-utm/bi-metadata';
import {
  clavesDelDia,
  clavesDeCampo,
  claveSinRespuesta,
  claveSegmento,
  camposEnFormula,
  formulaUsaRespuestas,
  CLAVE_TOTAL_LEADS,
  PREFIJO_SEGMENTO,
} from '../src/lib/dashboard/lead-answer-aggregation';
import type { LeadAnswerDatasetLite } from '../src/lib/dashboard/lead-answer-aggregation';
import { esSumandoDeSheet } from '../src/lib/dashboard/metric-catalog';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// Los buckets reales de Goodprop, que es el cliente que motivó la migración.
const BUCKETS = [
  'Menos de $1.000.000',
  'Entre $1.000.000 y $1.300.000',
  'Entre $1.300.000 y $1.600.000',
  'Entre $1.600.000 y $2.000.000',
  'Más de $2.000.000',
];

/**
 * Mapa que devuelve cada bucket con su capitalización de presentación. Sin él,
 * `sin_mapear: 'crudo'` deja el valor NORMALIZADO (minúsculas), que es lo que el
 * agrupador de la UI está para arreglar. Un segmento guarda lo que el agrupador
 * muestra, así que los dos lados hablan de buckets ya mapeados.
 */
const MAP_PRESENTACION = Object.fromEntries(
  BUCKETS.map((b) => [normalizarValorCrudo(b), b])
) as Record<string, string>;

function campo(over: Partial<LeadCampoDef> = {}): LeadCampoDef {
  return {
    id: 'campo-1',
    cliente_id: 'c',
    clave: 'rango_de_ingresos',
    nombre: 'Rango de ingresos',
    descripcion: null,
    claves_origen: ['cual_es_tu_rango_de_ingresos'],
    valores_map: MAP_PRESENTACION,
    valores_orden: BUCKETS,
    sin_mapear: 'crudo',
    max_valores: 200,
    activo: true,
    orden: 0,
    ...over,
  };
}

function seg(over: Partial<LeadSegmentoDef> = {}): LeadSegmentoDef {
  return {
    id: 'seg-1',
    cliente_id: 'c',
    campo_id: 'campo-1',
    campo_clave: 'rango_de_ingresos',
    clave: 'desde_2m',
    nombre: 'Desde 2M',
    descripcion: null,
    operador: 'in',
    valores: ['Más de $2.000.000'],
    activo: true,
    orden: 0,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Pertenencia de un bucket al segmento ───────────────────');

const desde2m = seg({ valores: ['Entre $1.600.000 y $2.000.000', 'Más de $2.000.000'] });
check('un bucket listado entra', segmentoIncluyeBucket(desde2m, 'Más de $2.000.000'));
check('uno no listado no entra', !segmentoIncluyeBucket(desde2m, 'Menos de $1.000.000'));

const excepto = seg({ operador: 'not_in', valores: ['Menos de $1.000.000'] });
check('not_in excluye lo listado', !segmentoIncluyeBucket(excepto, 'Menos de $1.000.000'));
check('not_in incluye el resto', segmentoIncluyeBucket(excepto, 'Más de $2.000.000'));

const vacio = seg({ valores: [] });
check('un `in` sin buckets no cuenta a nadie', !segmentoIncluyeBucket(vacio, 'Más de $2.000.000'));

// ════════════════════════════════════════════════════════════════
console.log('\n── Un lead sin respuesta nunca entra ──────────────────────');

const c = campo();
const conRespuesta = indexarRawFields({ cual_es_tu_rango_de_ingresos: 'Más de $2.000.000' });
const sinRespuesta = indexarRawFields({ email: 'a@b.com' });
const vacia = indexarRawFields({ cual_es_tu_rango_de_ingresos: '   ' });

check('un lead que respondió sí cuenta', cuentaEnSegmento(desde2m, c, conRespuesta));
check('un lead que no respondió no cuenta en `in`', !cuentaEnSegmento(desde2m, c, sinRespuesta));
// La decisión que más fácil sería equivocar: «no contestó» no es «no es de este
// grupo». Contarlo inflaría el complemento con gente de la que no se sabe nada.
check(
  'un lead que no respondió TAMPOCO cuenta en `not_in`',
  !cuentaEnSegmento(excepto, c, sinRespuesta)
);
check('una respuesta en blanco cuenta como sin responder', !cuentaEnSegmento(excepto, c, vacia));

// Un campo sin agrupar deja el valor en minúsculas, así que un segmento escrito
// con la capitalización de presentación NO lo recoge. Es el motivo por el que el
// editor deriva los buckets con la misma `bucketDeValor` que el motor.
check(
  'sin `valores_map`, el bucket es el valor normalizado y no coincide',
  !cuentaEnSegmento(desde2m, campo({ valores_map: {} }), conRespuesta)
);

// Con el catálogo agrupando variantes, el bucket manda sobre el texto crudo.
const cAgrupado = campo({
  valores_map: {
    entre_$1600000_y_$2000000: 'Entre $1.600.000 y $2.000.000',
    'entre $1.600.000 a $2.000.000': 'Entre $1.600.000 y $2.000.000',
  },
});
for (const crudo of ['entre_$1600000_y_$2000000', 'Entre $1.600.000 a $2.000.000']) {
  check(
    `la variante "${crudo}" cae en el segmento por su bucket`,
    cuentaEnSegmento(desde2m, cAgrupado, indexarRawFields({ cual_es_tu_rango_de_ingresos: crudo }))
  );
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Acumulados «desde X» ───────────────────────────────────');

check(
  'desde el penúltimo devuelve dos buckets',
  bucketsAcumulados(c, 'Entre $1.600.000 y $2.000.000').join('|') ===
    'Entre $1.600.000 y $2.000.000|Más de $2.000.000'
);
check(
  'desde el primero devuelve todos',
  bucketsAcumulados(c, BUCKETS[0]).length === BUCKETS.length
);
check('desde el último devuelve solo ese', bucketsAcumulados(c, BUCKETS[4]).length === 1);
check(
  'un bucket que no está en el orden no produce acumulado',
  bucketsAcumulados(c, 'inexistente').length === 0
);
// Sin orden configurado no hay «hacia arriba»: adivinarlo alfabéticamente
// pondría «Menos de $2M» en medio de los demás.
check(
  'sin `valores_orden` no se inventa un acumulado',
  bucketsAcumulados(campo({ valores_orden: [] }), BUCKETS[0]).length === 0
);

// ════════════════════════════════════════════════════════════════
console.log('\n── Token y alias ──────────────────────────────────────────');

const token = makeLeadSegMetric('desde_2m');
check(
  'ida y vuelta del token',
  token === 'leadseg:desde_2m' && parseLeadSegMetric(token) === 'desde_2m'
);
check('reconoce el suyo', isLeadSegMetric(token));
check(
  'no confunde con una dimensión de campo',
  !isLeadSegMetric(makeLeadFieldDim('rango_de_ingresos'))
);
check('una dimensión de campo no se lee como segmento', !isLeadFieldDim(token));
check('un token vacío no parsea', parseLeadSegMetric('leadseg:') === null);
check('el alias es lseg__', leadSegAlias('desde_2m') === 'lseg__desde_2m');

check(
  'la etiqueta lleva la pregunta delante',
  leadSegLabel(token, [
    {
      clave: 'desde_2m',
      nombre: 'Desde 2M',
      campo_clave: 'rango_de_ingresos',
      campo_nombre: 'Rango de ingresos',
      operador: 'in',
      valores: [],
      cobertura: 0,
    },
  ]) === 'Rango de ingresos: Desde 2M'
);
check('sin metadata no rompe: humaniza la clave', typeof leadSegLabel(token, []) === 'string');
check('un token de otra familia no produce etiqueta', leadSegLabel('spend') === null);

// ════════════════════════════════════════════════════════════════
console.log('\n── Los alias no colisionan entre familias ─────────────────');

// `lf__` y `lseg__` se diferencian en poco y los dos son de lead; el motor de
// fórmulas resuelve un identificador desconocido como 0, así que una captura
// cruzada sería un cero silencioso.
const mezcla =
  'spend / lseg__desde_2m + f_sum__edad + sf__calificados + sv__leads_20_100 + off__ventas + lf__rango__2m';
const segs = extractLeadSegAliases(mezcla);
check('extrae exactamente un segmento', segs.length === 1 && segs[0].clave === 'desde_2m');
check('no captura f_sum__', !segs.some((s) => s.clave.includes('edad')));
check(
  'no captura sf__/sv__',
  !segs.some((s) => s.clave.includes('calificados') || s.clave.includes('leads_20_100'))
);
check('no captura lf__', !segs.some((s) => s.clave.includes('rango')));

check(
  'extractFieldMetricAliases ignora lseg__',
  extractFieldMetricAliases('lseg__desde_2m').length === 0
);
check('extractSheetAliases ignora lseg__', extractSheetAliases('lseg__desde_2m').length === 0);
check(
  'extractOfflineFieldAliases ignora lseg__',
  extractOfflineFieldAliases('lseg__desde_2m').length === 0
);
check('el token no se confunde con uno de Sheet', !isSheetToken(token));
check('el token no se confunde con una métrica de campo', !isFieldMetric(token));
// El selector de fórmulas del dashboard descarta los sumandos internos de Sheet;
// la guarda es por prefijo+sufijo, así que no puede tragarse un segmento.
check(
  'el selector del dashboard no lo esconde',
  !esSumandoDeSheet(claveSegmento({ clave: 'desde_2m' }))
);

// ════════════════════════════════════════════════════════════════
console.log('\n── Registros de widget: dónde se puede usar ───────────────');

check('es aditivo (la fila de totales lo suma)', isAdditiveMetric(token));
check('vale como dimensión secundaria', supportsPivot(token));
check('vale como etapa de embudo', esEtapaDeEmbudo(token));
check('el catálogo fijo sigue valiendo como etapa', esEtapaDeEmbudo('leads_count'));
check('una métrica cualquiera no pasa a ser etapa', !esEtapaDeEmbudo('roas'));

// ════════════════════════════════════════════════════════════════
console.log('\n── La regla del gasto: filtro anula, métrica no ───────────');

// Es la distinción por la que existe toda la familia. Si un segmento entrara por
// la vía de los filtros no atribuibles, `spend / lseg__x` daría 0 y la feature no
// tendría ningún sentido.
check('un segmento como MÉTRICA no anula el gasto', !hasNonAttributableFilter({}, undefined));
check(
  'un filtro por campo de lead SÍ anula el gasto',
  hasNonAttributableFilter(
    { [makeLeadFieldDim('rango_de_ingresos')]: 'Más de $2.000.000' },
    undefined
  )
);

// ════════════════════════════════════════════════════════════════
console.log('\n── Dashboard: el invariante de la suma sigue cerrando ─────');

// Cubo de un día: 10 leads en el bucket 0, 5 en el 4, y 20 contactos en total.
const ds: LeadAnswerDatasetLite = {
  campanas: ['(sin campaña)', 'Campaña A'],
  campanaIds: [null, 'c1'],
  campos: [
    {
      clave: 'rango_de_ingresos',
      nombre: 'Rango de ingresos',
      buckets: BUCKETS,
      claves_origen: ['cual_es_tu_rango_de_ingresos'],
      origen: 'catalogo',
      cobertura: 15,
      // Dos segmentos que SE SOLAPAN a propósito: es el caso que rompería la
      // suma si entraran en `respondieron`.
      segmentos: [
        { clave: 'desde_2m', nombre: 'Desde 2M', operador: 'in', valores: [BUCKETS[4]] },
        { clave: 'todos', nombre: 'Respondieron', operador: 'in', valores: BUCKETS },
      ],
    },
  ],
  porFecha: {
    '2026-08-01': [
      [
        [0, 1, 10],
        [4, 1, 5],
      ],
    ],
  },
  totalesPorFecha: { '2026-08-01': [[1, 20]] },
  incompleto: false,
};

const claves = clavesDelDia(ds, '2026-08-01', new Set([0, 1]));
const c0 = clavesDeCampo(ds.campos[0]);
const suma =
  c0.reduce((n, k) => n + (claves[k.clave] ?? 0), 0) + claves[claveSinRespuesta(ds.campos[0])];
check(
  'respuestas + sin_respuesta == utm_leads',
  suma === claves[CLAVE_TOTAL_LEADS],
  `${suma} vs ${claves[CLAVE_TOTAL_LEADS]}`
);
check('el total es el del cubo', claves[CLAVE_TOTAL_LEADS] === 20);
check(
  'el `(sin respuesta)` no sale negativo pese al solape',
  claves[claveSinRespuesta(ds.campos[0])] === 5
);
check('el segmento cuenta solo su bucket', claves['lseg__desde_2m'] === 5);
check('un segmento que abarca todo cuenta los que respondieron', claves['lseg__todos'] === 15);

// Los segmentos se emiten siempre, incluso en cero: una serie por fecha con
// huecos dibujaría cortes donde solo hubo días sin ese tipo de lead.
const otroDia = clavesDelDia(ds, '2026-08-02', new Set([0, 1]));
check('un día sin datos emite el segmento en 0', otroDia['lseg__desde_2m'] === 0);

// El recorte por campaña vale igual para los segmentos que para las respuestas.
const soloSinCampana = clavesDelDia(ds, '2026-08-01', new Set([0]));
check('un filtro de campaña recorta el segmento', soloSinCampana['lseg__desde_2m'] === 0);

// ════════════════════════════════════════════════════════════════
console.log('\n── Dashboard: resolver el campo padre de una fórmula ──────');

const relacion = [{ clave: 'desde_2m', campoClave: 'rango_de_ingresos' }];
check(
  'una fórmula con solo un segmento carga su campo padre',
  camposEnFormula('meta_spend / lseg__desde_2m', ['rango_de_ingresos'], relacion).join() ===
    'rango_de_ingresos'
);
check(
  'una fórmula con lf__ sigue resolviendo por la clave del campo',
  camposEnFormula('lf__rango_de_ingresos__2m', ['rango_de_ingresos'], relacion).join() ===
    'rango_de_ingresos'
);
check(
  'no se duplica si la fórmula usa los dos',
  camposEnFormula('lf__rango_de_ingresos__2m + lseg__desde_2m', ['rango_de_ingresos'], relacion)
    .length === 1
);
check(
  'una fórmula sin nada de esto no carga campos',
  camposEnFormula('meta_spend / meta_leads', ['rango_de_ingresos'], relacion).length === 0
);

check(
  'formulaUsaRespuestas reconoce un segmento',
  formulaUsaRespuestas('meta_spend / lseg__desde_2m')
);
check('y sigue reconociendo utm_leads', formulaUsaRespuestas('utm_leads * 2'));
check('y no se dispara con cualquier fórmula', !formulaUsaRespuestas('meta_spend / meta_leads'));
check(
  'el prefijo del dashboard es el mismo alias que el del BI',
  PREFIJO_SEGMENTO + 'desde_2m' === leadSegAlias('desde_2m')
);

// ════════════════════════════════════════════════════════════════
console.log(
  fallos === 0
    ? '\n✅ Segmentos de lead: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
