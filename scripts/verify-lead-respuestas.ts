/**
 * Respuestas de formulario como métrica: el vocabulario único de claves, la
 * activación de un clic, la edición de respuestas, la selección múltiple, el cubo
 * único y la regla del gasto en el BI (auditoría del 2026-09-26).
 *
 * Puro: sin Postgres ni red.
 *
 *   npx tsx --conditions=react-server scripts/verify-lead-respuestas.ts
 */

import {
  slugRespuesta,
  clavesDeRespuestas,
  claveDeEtiqueta,
  claveVigente,
  reasignarClaves,
  extraerReferenciasDeLead,
  textoUsaMetricasDeLead,
  parseClaveFormulaRespuesta,
  parseTokenRespuesta,
  tokenRespuesta,
  claveFormulaRespuesta,
  esClaveRespuestaValida,
} from '../src/lib/leads/respuestas/claves';
import {
  configurarCampoAutomatico,
  ordenarRespuestas,
  claveDeRango,
  limpiarEtiqueta,
  unificarPreguntas,
  respuestasSinClasificar,
} from '../src/lib/leads/respuestas/catalogo';
import {
  renombrarRespuesta,
  unirRespuestas,
  apartarRespuesta,
  recuperarValor,
  anadirSinClasificar,
  respuestasConConteo,
  valoresApartados,
} from '../src/lib/leads/respuestas/edicion';
import { construirDataset } from '../src/lib/leads/respuestas/cubo';
import { ventanas, fusionarCubos } from '../src/lib/leads/respuestas/cubo-db';
import { preguntasDeFieldsMeta } from '../src/lib/leads/respuestas/wordpress';
import {
  bucketDeValor,
  bucketsDeValor,
  bucketsDeLead,
  indexarRawFields,
  predicadoDeRespuesta,
  predicadoDeSegmento,
  etiquetasDeCampo,
} from '../src/lib/report-utm/lead-campos';
import type { LeadCampoDef, CampoValorCrudo } from '../src/lib/report-utm/lead-campos';
import {
  clavesDelDia,
  clavesDeCampo,
  camposEnFormula,
  desglosePorCampana,
  desglosePorEntidad,
} from '../src/lib/dashboard/lead-answer-aggregation';
import { refDeCubo } from '../src/lib/dashboard/lead-answer-row';
import { aggregateRankingRows, dimensionSoportaRespuestas } from '../src/lib/ranking-aggregation';
import type { LeadAnswerDatasetLite } from '../src/lib/dashboard/lead-answer-aggregation';
import {
  isLeadAnsMetric,
  leadAnsLabel,
  isAdditiveMetric,
  supportsPivot,
  esEtapaDeEmbudo,
  basesAditivasDeFormula,
  extractLeadAnsAliases,
} from '../src/lib/report-utm/bi-metadata';
import {
  esMetricaDeLead,
  expresionUsaMetricaDeAnuncio,
  consultaSinGasto,
} from '../src/lib/report-utm/bi-query';
import { preguntasDeFormularioMeta } from '../src/lib/report-utm/meta-leads';
import { preguntasDeCamposGhl } from '../src/lib/report-utm/ghl-leads';
import { opcionesDeCampoGhl } from '../src/lib/report-utm/ghl-client';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const v = (valor_crudo: string, filas: number): CampoValorCrudo => ({
  valor_crudo,
  valor_norm: valor_crudo.toLowerCase(),
  filas,
  origenes: [],
  ultima_fecha: null,
});

function campo(parcial: Partial<LeadCampoDef>): LeadCampoDef {
  return {
    id: 'c1',
    cliente_id: 'x',
    clave: 'rango',
    nombre: 'Rango de ingresos',
    descripcion: null,
    claves_origen: ['rango'],
    valores_map: {},
    valores_orden: [],
    sin_mapear: 'crudo',
    max_valores: 200,
    activo: true,
    orden: 0,
    ...parcial,
  };
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Claves estables');
check(
  'el slug es el mismo que usaba el dashboard',
  slugRespuesta('Entre $2M – $3M') === 'entre_2m_3m'
);
check(
  'las guardadas mandan sobre el slug',
  eq(clavesDeRespuestas(['Calificados'], [{ clave: 'calificadas', nombre: 'Calificados' }]), [
    'calificadas',
  ])
);
check(
  'el desempate NO depende del orden de los buckets (el período)',
  eq(
    clavesDeRespuestas(['B $2M', 'A $2M']).slice().reverse(),
    clavesDeRespuestas(['A $2M', 'B $2M'])
  ) ||
    eq(
      new Set(clavesDeRespuestas(['$2M a', '$2M A'])),
      new Set(clavesDeRespuestas(['$2M A', '$2M a']))
    )
);
{
  const x = clavesDeRespuestas(['2M a', '2M A']);
  const y = clavesDeRespuestas(['2M A', '2M a']);
  check(
    'misma etiqueta → misma clave en cualquier orden',
    x[0] === y[1] && x[1] === y[0],
    `${x} / ${y}`
  );
}
check(
  'una clave guardada ausente del período no se reasigna a otra respuesta',
  clavesDeRespuestas(['Nueva'], [{ clave: 'nueva', nombre: 'Vieja' }])[0] === 'nueva_2'
);
check('sin_respuesta es reservada', clavesDeRespuestas(['Sin respuesta'])[0] === 'sin_respuesta_2');
check(
  'claveDeEtiqueta = clavesDeRespuestas de uno',
  claveDeEtiqueta('Hola Mundo') === 'hola_mundo'
);
check(
  'un alias resuelve a la vigente',
  claveVigente('vieja', [{ clave: 'nueva', nombre: 'X', alias: ['vieja'] }]) === 'nueva'
);
check(
  'claves válidas',
  esClaveRespuestaValida('entre_2m_3m') &&
    !esClaveRespuestaValida('a__b') &&
    !esClaveRespuestaValida('sin_respuesta')
);

console.log('\n── Renombres y fusiones al guardar');
{
  const r = reasignarClaves({
    mapaAnterior: { a: 'Calificadas', b: 'Calificadas', c: 'Otras' },
    mapaNuevo: { a: 'Calificados', b: 'Calificados', c: 'Otras' },
    respuestasAnteriores: [
      { clave: 'calificadas', nombre: 'Calificadas' },
      { clave: 'otras', nombre: 'Otras' },
    ],
    etiquetasNuevas: ['Calificados', 'Otras'],
  });
  check(
    'renombrar conserva la clave',
    r.respuestas.find((x) => x.nombre === 'Calificados')?.clave === 'calificadas'
  );
  check(
    'y devuelve el renombre para los segmentos',
    r.renombres.get('Calificadas') === 'Calificados'
  );
}
{
  const r = reasignarClaves({
    mapaAnterior: { a: 'A', b: 'A', c: 'B' },
    mapaNuevo: { a: 'AB', b: 'AB', c: 'AB' },
    respuestasAnteriores: [
      { clave: 'a', nombre: 'A' },
      { clave: 'b', nombre: 'B' },
    ],
    etiquetasNuevas: ['AB'],
  });
  const ab = r.respuestas.find((x) => x.nombre === 'AB');
  check('fusionar: la mayor da la clave', ab?.clave === 'a', JSON.stringify(r.respuestas));
  check('y la otra queda como alias (su fórmula sigue resolviendo)', !!ab?.alias?.includes('b'));
}
{
  const r = reasignarClaves({
    mapaAnterior: { a: 'A' },
    mapaNuevo: { z: 'Z' },
    respuestasAnteriores: [{ clave: 'a', nombre: 'A' }],
    etiquetasNuevas: ['Z'],
  });
  check(
    'una respuesta que desaparece conserva su clave reservada',
    r.respuestas.some((x) => x.clave === 'a') &&
      r.respuestas.find((x) => x.nombre === 'Z')?.clave === 'z'
  );
}

console.log('\n── Referencias por token EXACTO');
{
  const refs = extraerReferenciasDeLead('total_spend / lseg__desde_2m + lf__rango__2m_3m');
  check('lseg__desde_2m no es lseg__desde_2', !refs.segmentos.some((s) => s.clave === 'desde_2'));
  check(
    'respuesta partida en campo y respuesta',
    eq(refs.respuestas[0], { campo: 'rango', resp: '2m_3m', texto: 'lf__rango__2m_3m' })
  );
  check(
    'utm_leads como palabra completa',
    !extraerReferenciasDeLead('total_utm_leads').totales &&
      extraerReferenciasDeLead('utm_leads*2').totales
  );
  check(
    'leadfield exacto',
    extraerReferenciasDeLead('"leadfield:rango_de_ingresos"').campos[0]?.clave ===
      'rango_de_ingresos'
  );
  check(
    'textoUsaMetricasDeLead',
    textoUsaMetricasDeLead('lf__a__b') && !textoUsaMetricasDeLead('meta_spend / meta_leads')
  );
  check(
    'token ↔ alias',
    eq(parseTokenRespuesta(tokenRespuesta('rango', 'x_1')), { campo: 'rango', resp: 'x_1' }) &&
      eq(parseClaveFormulaRespuesta(claveFormulaRespuesta('rango', 'x_1')), {
        campo: 'rango',
        resp: 'x_1',
      })
  );
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Activación de un clic');
{
  const auto = configurarCampoAutomatico({
    etiqueta: 'cual_es_tu_rango_de_ingresos',
    claves_origen: ['cual_es_tu_rango_de_ingresos'],
    valores: [
      v('entre_$2.000.000_y_$4.000.000', 40),
      v('Entre $2.000.000 a $4.000.000', 10),
      v('menos_de_$2.000.000', 30),
      v('más_de_$4.000.000', 5),
      v('Seleccione una opción.', 7),
    ],
    es_opcion: true,
  });
  check('nombre legible', auto.nombre === 'Cual es tu rango de ingresos');
  check(
    'variantes fundidas',
    auto.valores_map['entre $2.000.000 a $4.000.000'] ===
      auto.valores_map['entre_$2.000.000_y_$4.000.000']
  );
  check('etiqueta limpia', auto.valores_map['menos_de_$2.000.000'] === 'Menos de $2.000.000');
  check('placeholder apartado (vacío)', auto.valores_map['seleccione una opción.'] === '');
  check(
    'rangos de menor a mayor',
    eq(auto.valores_orden, [
      'Menos de $2.000.000',
      'Entre $2.000.000 y $4.000.000',
      'Más de $4.000.000',
    ]),
    auto.valores_orden.join(' | ')
  );
}
{
  const auto = configurarCampoAutomatico({
    etiqueta: 'presupuesto',
    claves_origen: ['presupuesto'],
    valores: [v('mas_de_5k', 3)],
    opciones: [
      { valor: 'hasta_1k', etiqueta: 'Hasta 1k' },
      { valor: 'mas_de_5k', etiqueta: 'Más de 5k' },
    ],
  });
  check(
    'con opciones de la plataforma, su etiqueta manda',
    auto.valores_map['mas_de_5k'] === 'Más de 5k'
  );
  check('y se ofrecen aunque nadie las eligiera', auto.valores_orden.includes('Hasta 1k'));
  check('lista cerrada → lo desconocido a (otros)', auto.sin_mapear === 'otros');
}
check(
  'orden: (otros) al final',
  eq(ordenarRespuestas(['Más de 4', '0 a 1', '(otros)', 'De 2 a 3']), [
    '0 a 1',
    'De 2 a 3',
    'Más de 4',
    '(otros)',
  ])
);
check('sin números no se reordena', eq(ordenarRespuestas(['Sí', 'No']), ['Sí', 'No']));
check(
  '«Hasta 2M» antes que «Entre 2M…»',
  (claveDeRango('Hasta 2M') ?? 0) < (claveDeRango('Entre 2M y 3M') ?? 0)
);
check('limpiarEtiqueta', limpiarEtiqueta('mas_de_$4.000.000') === 'Mas de $4.000.000');
{
  const u = unificarPreguntas(
    [
      {
        clave: 'rango',
        clave_norm: 'rango',
        leads: 10,
        distintos: 3,
        es_opcion: false,
        formularios: ['Web'],
        valores: [],
      },
    ],
    [
      {
        fuente: 'meta',
        clave_origen: 'rango',
        clave_norm: 'rango',
        etiqueta: '¿Rango?',
        tipo: 'opcion',
        opciones: [{ valor: 'a', etiqueta: 'A' }],
      },
      { fuente: 'meta', clave_origen: 'email', clave_norm: 'email', tipo: 'email', opciones: [] },
    ]
  );
  check(
    'lead + plataforma en una sola pregunta',
    u.length === 1 && eq(u[0].fuentes, ['leads', 'meta'])
  );
  check(
    'la plataforma da el tipo y las opciones',
    u[0].tipo === 'opcion' && u[0].opciones.length === 1 && u[0].es_opcion
  );
  check('un correo no es una pregunta medible', !u.some((p) => p.clave_norm === 'email'));
}

console.log('\n── Edición de respuestas');
{
  const c = campo({
    valores_map: { a: 'A', a2: 'A', b: 'B', c: 'C' },
    valores_orden: ['A', 'B', 'C'],
  });
  const r = renombrarRespuesta(c, 'A', 'Alfa');
  check(
    'renombrar mueve todos sus valores',
    r.valores_map.a === 'Alfa' &&
      r.valores_map.a2 === 'Alfa' &&
      eq(r.valores_orden, ['Alfa', 'B', 'C'])
  );
  const u = unirRespuestas(c, ['B', 'C'], 'BC');
  check(
    'unir: los valores a la nueva, en el sitio de la primera',
    u.valores_map.b === 'BC' && u.valores_map.c === 'BC' && eq(u.valores_orden, ['A', 'BC'])
  );
  const ap = apartarRespuesta(c, 'C');
  check(
    'apartar = mapear a vacío y salir del orden',
    ap.valores_map.c === '' && !ap.valores_orden.includes('C')
  );
  check('lo apartado cuenta como sin respuesta', bucketDeValor({ ...c, ...ap }, 'c') === null);
  const rec = recuperarValor({ ...c, ...ap }, 'c');
  check('recuperar lo devuelve con nombre', rec.valores_map.c === 'C');
  const conCrudos = campo({ valores_map: { a: 'A' }, sin_mapear: 'otros' });
  const vistos = [v('a', 5), v('nueva_opcion', 2)];
  check('detecta lo sin clasificar', respuestasSinClasificar(conCrudos, vistos).length === 1);
  const an = anadirSinClasificar(conCrudos, vistos);
  check('añadir le da nombre limpio', an.valores_map['nueva_opcion'] === 'Nueva opcion');
  const cc = respuestasConConteo(c, [v('a', 3), v('a2', 2), v('b', 1)]);
  check(
    'conteo por respuesta en el orden del campo',
    eq(
      cc.map((x) => [x.etiqueta, x.leads]),
      [
        ['A', 5],
        ['B', 1],
        ['C', 0],
      ]
    )
  );
  check('valores apartados', valoresApartados({ ...c, ...ap }, [v('c', 4)]).length === 1);
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Placeholders y selección múltiple');
{
  check(
    'mapeado a vacío = sin respuesta aunque sin_mapear sea crudo',
    bucketDeValor({ valores_map: { x: '' }, sin_mapear: 'crudo' }, 'X') === null
  );
  check(
    'la etiqueta reservada «(sin respuesta)» también',
    bucketDeValor({ valores_map: { x: '(sin respuesta)' }, sin_mapear: 'crudo' }, 'x') === null
  );
  check(
    'etiquetasDeCampo no la ofrece',
    !etiquetasDeCampo(campo({ valores_map: { x: '(sin respuesta)', y: 'Y' } })).includes(
      '(sin respuesta)'
    )
  );
  const m = campo({
    tipo: 'multiple',
    valores_map: {
      inversion: 'Inversión',
      vivienda: 'Vivienda',
      'entre 2, aprox.': 'Entre 2 aprox',
    },
  });
  check(
    'múltiple: se parte por comas',
    eq(bucketsDeValor(m, 'Inversion, Vivienda'), ['Inversión', 'Vivienda'])
  );
  check(
    'una opción con coma no se parte',
    eq(bucketsDeValor(m, 'Entre 2, aprox.'), ['Entre 2 aprox'])
  );
  check(
    'ni se parte un desplegable normal',
    eq(bucketsDeValor({ ...m, tipo: 'opcion' }, 'Inversion, Vivienda'), ['inversion, vivienda'])
  );
  const idx = indexarRawFields({ rango: 'Inversion, Vivienda' });
  check(
    'bucketsDeLead',
    eq(bucketsDeLead({ ...m, claves_origen: ['rango'] }, idx), ['Inversión', 'Vivienda'])
  );
}

console.log('\n── Predicados de respuesta y segmento (BI)');
{
  const c = campo({
    valores_map: { a: 'Calificados' },
    respuestas: [{ clave: 'calificadas', nombre: 'Calificados', alias: ['viejas'] }],
  });
  check('por clave guardada', predicadoDeRespuesta(c, 'calificadas')(['Calificados']));
  check('por alias antiguo', predicadoDeRespuesta(c, 'viejas')(['Calificados']));
  check(
    'sin_respuesta = no respondió',
    predicadoDeRespuesta(c, 'sin_respuesta')([]) &&
      !predicadoDeRespuesta(c, 'sin_respuesta')(['Calificados'])
  );
  check('crudo por slug', predicadoDeRespuesta(campo({}), 'hola_mundo')(['hola mundo']));
  const seg = predicadoDeSegmento({ operador: 'not_in', valores: ['A'] });
  check('un no-respondió nunca entra en un segmento, ni en not_in', !seg([]) && seg(['B']));
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Cubo único → dataset del dashboard');
{
  const ds = construirDataset(
    {
      tuplas: [
        ['1', 'Promo', null, null, null, null, null],
        [null, null, null, null, null, null, null],
      ],
      totales: [
        ['2026-09-01', 0, 10],
        ['2026-09-01', 1, 4],
      ],
      respuestas: [
        ['2026-09-01', 0, 0, 'a', 6],
        ['2026-09-01', 1, 0, 'b', 1],
        ['2026-09-01', 0, 1, 'x, y', 3],
        ['2026-09-01', 0, 1, 'x', 2],
      ],
      truncado: false,
    },
    [
      {
        campo: campo({
          clave: 'rango',
          valores_map: { a: 'A', b: 'B' },
          respuestas: [{ clave: 'la_a', nombre: 'A' }],
        }),
        origen: 'catalogo',
      },
      {
        campo: campo({ clave: 'interes', tipo: 'multiple', valores_map: { x: 'X', y: 'Y' } }),
        origen: 'catalogo',
      },
    ],
    {
      campanaDeTupla: (t) => (t[1] ? 'Promo Real' : ''),
      idsCampana: new Map([['Promo Real', '999']]),
      conTotales: true,
    }
  );
  check(
    'índice 0 = (sin campaña)',
    ds.campanas[0] === '(sin campaña)' && ds.campanas[1] === 'Promo Real'
  );
  check('el id de campaña viaja', ds.campanaIds[1] === '999');
  check(
    'claves estables en el catálogo',
    ds.campos[0].claves?.[ds.campos[0].buckets.indexOf('A')] === 'la_a'
  );
  check('la pregunta múltiple se marca', ds.campos[1].multiple === true);
  const dia = clavesDelDia(ds as LeadAnswerDatasetLite, '2026-09-01', new Set([0, 1]));
  check('utm_leads = total', dia.utm_leads === 14);
  check('respuesta con clave estable', dia.lf__rango__la_a === 6);
  check(
    'respuestas + sin_respuesta = total (única)',
    dia.lf__rango__la_a + dia.lf__rango__b + dia.lf__rango__sin_respuesta === 14
  );
  check('múltiple: cada opción cuenta', dia.lf__interes__x === 5 && dia.lf__interes__y === 3);
  check(
    'múltiple: sin_respuesta contra los que respondieron (5), no contra la suma (8)',
    dia.lf__interes__sin_respuesta === 9,
    String(dia.lf__interes__sin_respuesta)
  );
  const porCampana = desglosePorCampana(ds as LeadAnswerDatasetLite, '2026-09-01', new Set([1]));
  check(
    'desglose por campaña con la misma regla',
    porCampana[0]?.valores.lf__interes__sin_respuesta === 5
  );
  check(
    'clavesDeCampo usa las guardadas',
    clavesDeCampo(ds.campos[0]).some((c) => c.clave === 'lf__rango__la_a')
  );
  check(
    'camposEnFormula exacto',
    eq(camposEnFormula('lf__rango__la_a / utm_leads', ['rango', 'rang']), ['rango'])
  );
}
check(
  'ventanas de ≤ 366 días, sin huecos',
  eq(ventanas('2024-01-01', '2025-01-02'), [
    ['2024-01-01', '2024-12-31'],
    ['2025-01-01', '2025-01-02'],
  ])
);
{
  const f = fusionarCubos([
    {
      tuplas: [['1', null, null, null, null, null, null]],
      totales: [['2024-01-01', 0, 1]],
      respuestas: [],
      truncado: false,
    },
    {
      tuplas: [
        ['2', null, null, null, null, null, null],
        ['1', null, null, null, null, null, null],
      ],
      totales: [['2025-01-01', 1, 2]],
      respuestas: [],
      truncado: true,
    },
  ]);
  check(
    'fusionar re-indexa tuplas y arrastra el truncado',
    f.tuplas.length === 2 && eq(f.totales[1], ['2025-01-01', 0, 2]) && f.truncado
  );
}

// ════════════════════════════════════════════════════════════════
console.log('\n── Nivel de anuncio y conjunto (rankings)');
{
  const ds = construirDataset(
    {
      tuplas: [
        ['1', 'Promo', 'Anuncio A', 'Conjunto X', null, null, null],
        ['1', 'Promo', 'Anuncio B', 'Conjunto X', null, null, null],
        ['2', 'Otra', 'Anuncio A', 'Conjunto Y', null, null, null],
      ],
      totales: [
        ['2026-09-01', 0, 5],
        ['2026-09-01', 1, 3],
        ['2026-09-01', 2, 7],
      ],
      respuestas: [
        ['2026-09-01', 0, 0, 'a', 4],
        ['2026-09-01', 1, 0, 'a', 1],
        ['2026-09-01', 2, 0, 'a', 2],
      ],
      truncado: false,
    },
    [{ campo: campo({ clave: 'rango', valores_map: { a: 'A' } }), origen: 'catalogo' }],
    {
      campanaDeTupla: (t) => String(t[1]),
      idsCampana: new Map([
        ['Promo', '100'],
        ['Otra', '200'],
      ]),
      conTotales: true,
      niveles: {
        conjuntoDe: (t) => ({ label: String(t[3]), id: null }),
        anuncioDe: (t) => ({ label: String(t[2]), id: null }),
      },
    }
  );
  check('el dataset trae el nivel', !!ds.niveles && ds.niveles.tuplas.length === 3);
  const lite = ds as LeadAnswerDatasetLite;
  const todas = new Set(ds.campanas.map((_, i) => i));
  const porConjunto = desglosePorEntidad(lite, '2026-09-01', todas, 'conjunto');
  const x = porConjunto.find((e) => e.nombre === 'Conjunto X');
  check('conjunto: suma sus tuplas', x?.valores.utm_leads === 8 && x?.valores.lf__rango__a === 5);
  check(
    'conjunto: sin respuesta cierra contra su total',
    x?.valores.lf__rango__sin_respuesta === 3
  );
  const soloPromo = new Set([ds.campanas.indexOf('Promo')]);
  const anuncios = desglosePorEntidad(lite, '2026-09-01', soloPromo, 'anuncio');
  check(
    'el filtro de campaña se aplica por la campaña de la tupla',
    anuncios.find((e) => e.nombre === 'Anuncio A')?.valores.utm_leads === 5
  );
  check(
    'sin nivel no hay desglose',
    desglosePorEntidad({ ...lite, niveles: undefined }, '2026-09-01', todas, 'anuncio').length === 0
  );
  check(
    'dimensionSoportaRespuestas depende del nivel',
    dimensionSoportaRespuestas('ads', ds) &&
      !dimensionSoportaRespuestas('ads', { niveles: undefined }) &&
      dimensionSoportaRespuestas('campaigns')
  );

  // Ranking por anuncio: «Anuncio A» existe en dos campañas → homónimo, no se cuelga.
  const ref = refDeCubo(lite, undefined, []);
  const filas = [
    {
      fecha: '2026-09-01',
      __leadAnswers: ref,
      meta_ads: [
        { ad_id: '1', ad_name: 'Anuncio A', campaign_id: '100', campaign_name: 'Promo', spend: 10 },
        { ad_id: '2', ad_name: 'Anuncio B', campaign_id: '100', campaign_name: 'Promo', spend: 5 },
        { ad_id: '3', ad_name: 'Anuncio A', campaign_id: '200', campaign_name: 'Otra', spend: 7 },
      ],
    },
  ];
  const rk = aggregateRankingRows(filas, 'ads');
  check(
    'anuncio con nombre único recibe sus leads',
    rk.find((r) => r._id === '2')?.utm_leads === 3
  );
  check(
    'un homónimo no recibe leads que no son suyos',
    rk.filter((r) => r._name === 'Anuncio A').every((r) => r.utm_leads === 0)
  );

  // Filtro por GRUPO en el ranking de campañas: ahora recorta también el gasto.
  const grupos = [
    { id: 'g1', campaign_group_mappings: [{ campaign_id: '100', campaign_name_pattern: null }] },
  ];
  const filasCamp = [
    {
      fecha: '2026-09-01',
      meta_campaigns: [
        { campaign_id: '100', name: 'Promo', spend: 10 },
        { campaign_id: '200', name: 'Otra', spend: 7 },
      ],
    },
  ];
  const rkG = aggregateRankingRows(
    filasCamp,
    'campaigns',
    { type: 'group', value: 'g1' },
    undefined,
    undefined,
    grupos
  );
  check(
    'filtro por grupo recorta el gasto del ranking',
    rkG.length === 1 && rkG[0]._id === '100',
    JSON.stringify(rkG.map((r) => r._id))
  );
}

// ════════════════════════════════════════════════════════════════
console.log('\n── BI: respuestas como métrica y regla del gasto');
check(
  'leadans es métrica aditiva, apilable y etapa',
  isLeadAnsMetric('leadans:rango:a') &&
    isAdditiveMetric('leadans:rango:a') &&
    supportsPivot('leadans:rango:a') &&
    esEtapaDeEmbudo('leadans:rango:a')
);
check(
  'etiqueta con el catálogo',
  leadAnsLabel('leadans:rango:la_a', [
    {
      clave: 'rango',
      nombre: 'Rango',
      valores: [],
      claves_origen: [],
      cobertura: 0,
      alta_cardinalidad: false,
      respuestas: [{ clave: 'la_a', nombre: 'A' }],
    },
  ]) === 'Rango: A'
);
check(
  'alias lf__ en una fórmula del BI',
  eq(extractLeadAnsAliases('spend / lf__rango__a'), [
    { campo: 'rango', resp: 'a', alias: 'lf__rango__a' },
  ])
);
{
  const b = basesAditivasDeFormula('spend / lf__rango__a');
  check(
    'CPL por respuesta totalizable',
    b?.get('spend') === 'spend' && b?.get('lf__rango__a') === 'leadans:rango:a'
  );
  check('una fórmula sobre un ratio no', basesAditivasDeFormula('cpl * 2') === null);
}
check(
  'métricas de lead',
  esMetricaDeLead('leads_count') &&
    esMetricaDeLead('leadans:a:b') &&
    esMetricaDeLead('lseg__x') &&
    !esMetricaDeLead('spend')
);
check(
  'una fórmula con gasto usa métricas de anuncio',
  expresionUsaMetricaDeAnuncio('spend / lf__a__b') &&
    !expresionUsaMetricaDeAnuncio('lf__a__b / leads_count')
);
check('agrupar por pregunta anula el gasto', consultaSinGasto({ dimension: 'leadfield:rango' }));
check(
  'filtrar por pregunta también',
  consultaSinGasto({ dimension: 'none', filters: { 'leadfield:rango': 'A' } })
);
check('medir una respuesta NO', !consultaSinGasto({ dimension: 'utm_campaign' }));

// ════════════════════════════════════════════════════════════════
console.log('\n── Preguntas de las plataformas');
{
  const meta = preguntasDeFormularioMeta({ id: 'f1', name: 'Form' }, [
    { key: 'rango', label: '¿Rango?', type: 'CUSTOM', options: [{ key: 'a_b', value: 'A b' }] },
    { key: 'email', type: 'EMAIL' },
  ]);
  check(
    'Meta: opción = {clave de la opción, texto}',
    eq(meta[0].opciones, [{ valor: 'a_b', etiqueta: 'A b' }]) && meta[0].tipo === 'opcion'
  );
  check('Meta: el correo es contacto', meta[1].tipo === 'email');
  check(
    'GHL: picklistOptions',
    eq(opcionesDeCampoGhl({ picklistOptions: ['Sí', 'No'] }), [
      { valor: 'Sí', etiqueta: 'Sí' },
      { valor: 'No', etiqueta: 'No' },
    ])
  );
  const ghl = preguntasDeCamposGhl([
    {
      id: '1',
      name: 'Interés',
      dataType: 'MULTIPLE_OPTIONS',
      opciones: [{ valor: 'x', etiqueta: 'x' }],
    },
  ]);
  check(
    'GHL: casillas = múltiple, clave = nombre del campo',
    ghl[0].tipo === 'multiple' && ghl[0].clave_origen === 'Interés'
  );
  const wp = preguntasDeFieldsMeta(
    {
      interes: { type: 'checkbox', multiple: true, options: [{ value: 'a', label: 'A' }] },
      basura: 3,
    },
    { form_id: '7' }
  );
  check(
    'WordPress: valida y convierte',
    wp?.length === 1 && wp[0].tipo === 'multiple' && wp[0].form_id === '7'
  );
  check('WordPress: algo que no es objeto → null', preguntasDeFieldsMeta([1, 2], {}) === null);
}

console.log(
  fallos === 0
    ? '\n✅ Respuestas de formulario: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
