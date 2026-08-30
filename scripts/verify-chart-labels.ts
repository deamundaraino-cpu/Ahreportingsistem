/**
 * Medida y recorte de etiquetas de gráfico (`src/lib/chart-labels.ts`).
 *
 * Es la lógica que decide cuánto ocupa el eje de categorías y qué se corta. Un
 * error aquí no se ve como un error: se ve como un gráfico feo, o —peor— como un
 * eje que se come el área de datos. De ahí que se verifiquen los INVARIANTES y
 * no un píxel concreto, que depende de la fuente.
 *
 * Sin red y sin DOM: entra en `npm run test:puro`.
 *
 *   npx tsx --conditions=react-server scripts/verify-chart-labels.ts
 */

import {
  anchoTextoPx,
  truncarEtiqueta,
  truncarAAncho,
  anchoEjeCategoria,
} from '../src/lib/chart-labels';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);
}

// Etiquetas reales del proyecto, que son el caso que importa.
const BUCKET = 'Entre $2.000.000 y $4.000.000';
const CAMPANA = '[SANTIAGO CENTRO][CAPTACIÓN LEADS][FORM][ABO][JUL]';

seccion('Ancho estimado');

check('el texto vacío no ocupa nada', anchoTextoPx('', 11) === 0);
check(
  'crece con la longitud',
  anchoTextoPx('aa', 11) > anchoTextoPx('a', 11) && anchoTextoPx('aaa', 11) > anchoTextoPx('aa', 11)
);
check('crece con el tamaño de fuente', anchoTextoPx(BUCKET, 14) > anchoTextoPx(BUCKET, 10));
// Lo que un factor plano de 0.6 no sabe distinguir, y es justo la diferencia
// entre un nombre de campaña en mayúsculas y una palabra en minúsculas.
check(
  'las letras anchas ocupan más que las estrechas',
  anchoTextoPx('MMMM', 11) > anchoTextoPx('llll', 11),
  `${anchoTextoPx('MMMM', 11)} vs ${anchoTextoPx('llll', 11)}`
);
check(
  'las mayúsculas ocupan más que las minúsculas',
  anchoTextoPx('CAPTACION', 11) > anchoTextoPx('captacion', 11)
);
check(
  'un nombre de campaña ocupa más que un bucket',
  anchoTextoPx(CAMPANA, 11) > anchoTextoPx(BUCKET, 11)
);

seccion('Corte por caracteres');

check('lo que cabe no se toca', truncarEtiqueta('corto', 28) === 'corto');
check('un texto de largo exacto no se corta', truncarEtiqueta('12345', 5) === '12345');
check('nunca devuelve más de `max`', truncarEtiqueta(CAMPANA, 18).length <= 18);
check('lo cortado acaba en elipsis', truncarEtiqueta(CAMPANA, 18).endsWith('…'));
check(
  'es idempotente',
  truncarEtiqueta(truncarEtiqueta(CAMPANA, 18), 18) === truncarEtiqueta(CAMPANA, 18)
);
check('max 0 devuelve cadena vacía', truncarEtiqueta(CAMPANA, 0) === '');

seccion('Corte por ancho');

check('el texto vacío se queda vacío', truncarAAncho('', 100, 11) === '');
check('sin ancho no se pinta nada', truncarAAncho(CAMPANA, 0, 11) === '');
// La regla que evita que TODAS las filas salgan con «…» y el tooltip se vuelva ruido.
check(
  'lo que cabe NO recibe elipsis',
  truncarAAncho(BUCKET, anchoTextoPx(BUCKET, 11) + 10, 11) === BUCKET
);
const cortado = truncarAAncho(CAMPANA, 80, 11);
check('lo que no cabe se corta', cortado !== CAMPANA);
check('lo cortado acaba en elipsis', cortado.endsWith('…'));
check('lo cortado cabe en el ancho pedido', anchoTextoPx(cortado, 11) <= 80 + 1);
// El escalón inferior, que es donde estaba el riesgo de devolver basura: por
// debajo del ancho de la propia elipsis no cabe NADA, y la respuesta honesta es
// la elipsis sola (el nombre completo sigue en el tooltip), nunca una cadena
// vacía que haría desaparecer la fila.
check('con un ancho ridículo queda al menos la elipsis', truncarAAncho(CAMPANA, 6, 11) === '…');
check(
  'en cuanto cabe un carácter, se pinta antes de la elipsis',
  truncarAAncho(CAMPANA, 20, 11).length >= 2,
  JSON.stringify(truncarAAncho(CAMPANA, 20, 11))
);
check(
  'a más ancho, más texto',
  truncarAAncho(CAMPANA, 160, 11).length > truncarAAncho(CAMPANA, 80, 11).length
);

seccion('Ancho del eje de categorías');

const OPTS = { fontSize: 11, minPx: 56, maxPx: 220, fraccionMax: 0.4 };

check('sin etiquetas se queda en el mínimo', anchoEjeCategoria([], OPTS) === 56);
check('una etiqueta corta no baja del mínimo', anchoEjeCategoria(['A'], OPTS) >= 56);
check(
  'una etiqueta larga no supera el máximo',
  anchoEjeCategoria([CAMPANA.repeat(3)], OPTS) <= 220
);
check(
  'manda la etiqueta más larga',
  anchoEjeCategoria(['A', BUCKET, 'B'], OPTS) === anchoEjeCategoria([BUCKET], OPTS)
);
check(
  'un bucket real pide más que el mínimo',
  anchoEjeCategoria([BUCKET], OPTS) > 56,
  String(anchoEjeCategoria([BUCKET], OPTS))
);

// El techo relativo: es lo que impide que el eje se coma el gráfico en un widget
// estrecho, que era el motivo de poner 100 px fijos en primer lugar.
const estrecho = anchoEjeCategoria([CAMPANA], { ...OPTS, anchoContenedor: 300 });
const ancho = anchoEjeCategoria([CAMPANA], { ...OPTS, anchoContenedor: 900 });
check('en un contenedor estrecho el eje se recorta', estrecho <= 300 * 0.4, String(estrecho));
check('en uno ancho el eje crece', ancho > estrecho, `${ancho} vs ${estrecho}`);
check('…pero nunca pasa del máximo duro', ancho <= 220, String(ancho));

// El caso patológico: un contenedor tan pequeño que el 40 % cae por debajo del
// suelo. Sin la guarda, el clamp se invierte y devuelve un ancho absurdo.
const minusculo = anchoEjeCategoria([CAMPANA], { ...OPTS, anchoContenedor: 120 });
check('un contenedor diminuto no invierte el clamp', minusculo === 56, String(minusculo));

check(
  'el resultado siempre es un entero positivo',
  [[], ['A'], [BUCKET], [CAMPANA]].every((e) => {
    const v = anchoEjeCategoria(e, OPTS);
    return Number.isInteger(v) && v > 0;
  })
);

console.log(
  fallos === 0
    ? '\n✅ Etiquetas de gráfico: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
