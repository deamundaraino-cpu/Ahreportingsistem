/**
 * Comprobaciones del selector de valores por columna.
 *
 * Todo PURO: no toca la base ni la red. Lo que necesita datos reales vive en
 * `scripts/verify-bi-valores-db.ts`.
 *
 * Aquí se fija sobre todo UNA cosa: que serializar la selección con escapes sea
 * compatible hacia atrás. Los filtros guardados de 19 informes se leen con este
 * código a partir de ahora, y si el formato cambia de significado se rompen sin
 * que nadie lo note hasta que un cliente abra su informe.
 *
 *   npx tsx scripts/verify-bi-valores.ts
 */

import {
  plegarConteos,
  ordenarPorFrecuencia,
  recortar,
  aValoresPlanos,
  parseSeleccion,
  serializarSeleccion,
  tieneComa,
  esSeleccionPorCasillas,
  componerFilas,
  alternarValor,
  sinValores,
  VACIO_HONESTO,
} from '../src/lib/report-utm/bi-valores';
import type { ValorConConteo, ResultadoValores } from '../src/lib/report-utm/bi-valores';

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

/** Lo que hacía el código antes de este cambio, para comparar. */
const splitViejo = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// ════════════════════════════════════════════════════════════
seccion('Compatibilidad con los filtros ya guardados');
// ════════════════════════════════════════════════════════════
// Es la condición que hace seguro el cambio: sin secuencias de escape,
// `parseSeleccion` tiene que comportarse EXACTAMENTE como el `split(',')` de
// antes. Se comprobó además que ninguno de los 19 informes guardados contiene
// hoy la secuencia `\,`.

const guardadosReales = [
  'facebook',
  'facebook,instagram',
  ' facebook , instagram ',
  'CL',
  'FORM FILTRO LÓGICO NOV-25',
  '[ÑUÑOA][CAPTACIÓN LEADS][FORM][ABO][NOV]',
  'entre_$1.300.000_y_$1.600.000',
  'a,,b',
  '',
  'C:\\ruta,otra',
];
for (const g of guardadosReales) {
  const antes = splitViejo(g);
  const ahora = parseSeleccion(g);
  check(
    `«${g || '(vacío)'}» se lee igual que antes`,
    JSON.stringify(antes) === JSON.stringify(ahora),
    `antes=${JSON.stringify(antes)} ahora=${JSON.stringify(ahora)}`
  );
}

// ════════════════════════════════════════════════════════════
seccion('Valores que contienen una coma');
// ════════════════════════════════════════════════════════════
// El caso que esta función destapa: hay 717 nombres de entidad en `ads_daily` y
// 23 `utm_content` con coma. Marcarlos en una lista los partía en dos trozos que
// no coincidían con nada, y el widget salía vacío sin explicar por qué.

const conComa = '[VIDEOS_11,12Y13][ABIERTO][25-55][CHILE][HM]';
check('el valor real con coma existe y se detecta', tieneComa(conComa));
check(
  'ida y vuelta lo conserva entero',
  JSON.stringify(parseSeleccion(serializarSeleccion([conComa]))) === JSON.stringify([conComa]),
  parseSeleccion(serializarSeleccion([conComa])).join(' | ')
);
// Y el formato viejo lo partía: esto documenta el fallo que se arregla.
check('el split anterior SÍ lo partía (el fallo que se corrige)', splitViejo(conComa).length === 2);

check(
  'varios valores, uno con coma',
  JSON.stringify(parseSeleccion(serializarSeleccion(['fb', conComa, 'ig']))) ===
    JSON.stringify(['fb', conComa, 'ig'])
);
check(
  'un valor que ya trae una barra invertida sobrevive',
  JSON.stringify(parseSeleccion(serializarSeleccion(['a\\b']))) === JSON.stringify(['a\\b'])
);
check('lista vacía → cadena vacía', serializarSeleccion([]) === '');
check(
  'los espacios de sobra se recortan',
  JSON.stringify(serializarSeleccion([' fb ', 'ig'])) === JSON.stringify('fb,ig')
);
check('un valor vacío no genera una entrada', serializarSeleccion(['fb', '', '  ']) === 'fb');

// ════════════════════════════════════════════════════════════
seccion('Alternar un valor');
// ════════════════════════════════════════════════════════════
check('añade el primero', alternarValor('', 'fb') === 'fb');
check('añade el segundo', alternarValor('fb', 'ig') === 'fb,ig');
check('quita uno ya marcado', alternarValor('fb,ig', 'fb') === 'ig');
check('quitar el último deja vacío', alternarValor('fb', 'fb') === '');
check(
  'alternar un valor con coma no rompe la lista',
  JSON.stringify(parseSeleccion(alternarValor('fb', conComa))) === JSON.stringify(['fb', conComa])
);

// ════════════════════════════════════════════════════════════
seccion('Plegado de conteos');
// ════════════════════════════════════════════════════════════
// SQL agrupa por el valor CRUDO y Node aplica la etiqueta. Dos crudos que
// resuelven a lo mismo tienen que SUMAR, no competir.
{
  const crudos: ValorConConteo[] = [
    { valor: '20 a 100', n: 3 },
    { valor: '20-100', n: 5 },
    { valor: 'más de 100', n: 2 },
    { valor: 'basura', n: 9 },
  ];
  const mapa = plegarConteos(crudos, (v) =>
    v === '20 a 100' || v === '20-100' ? '20-100' : v === 'basura' ? null : v
  );
  check('dos escrituras de lo mismo suman', mapa.get('20-100') === 8, String(mapa.get('20-100')));
  check('lo que la etiqueta descarta no aparece', !mapa.has('basura'));
  check('lo demás se conserva', mapa.get('más de 100') === 2);
  check(
    'una etiqueta vacía también descarta',
    plegarConteos([{ valor: 'x', n: 1 }], () => '').size === 0
  );
}

// ════════════════════════════════════════════════════════════
seccion('Orden');
// ════════════════════════════════════════════════════════════
{
  const m = new Map([
    ['a', 5],
    ['b', 12],
    ['c', 5],
  ]);
  const orden = ordenarPorFrecuencia(m);
  check('manda la frecuencia', orden[0].valor === 'b');
  // El desempate alfabético hace el orden ESTABLE: sin él, dos ejecuciones
  // sobre los mismos datos podían pintar la lista en distinto orden.
  check('empate → alfabético estable', orden[1].valor === 'a' && orden[2].valor === 'c');

  // Cuando el analista declaró el orden de los buckets, ese orden manda: los
  // rangos van de menor a mayor porque alguien lo decidió, no por conteo.
  const conOrden = ordenarPorFrecuencia(
    new Map([
      ['20-100', 5],
      ['1-10', 2],
      ['11-20', 99],
    ]),
    ['1-10', '11-20', '20-100']
  );
  check(
    'el orden del analista gana a la frecuencia',
    conOrden.map((v) => v.valor).join(',') === '1-10,11-20,20-100',
    conOrden.map((v) => v.valor).join(',')
  );
  check('y conserva los conteos', conOrden[2].n === 5);
}

// ════════════════════════════════════════════════════════════
seccion('Recorte y truncado honesto');
// ════════════════════════════════════════════════════════════
// Es la regresión del corte sesgado: antes se pedía una página sin ORDER BY, así
// que QUÉ valores llegaban era indefinido. Ahora el corte es el top-N real y el
// total se dice.
{
  const muchos: ValorConConteo[] = Array.from({ length: 120 }, (_, i) => ({
    valor: `v${i}`,
    n: 120 - i,
  }));
  const r = recortar(muchos, 50);
  check('devuelve exactamente el límite', r.valores.length === 50);
  check(
    'son los MÁS FRECUENTES, no los primeros que llegaron',
    r.valores[0].n === 120 && r.valores[49].n === 71
  );
  check('el 51.º no desplaza al 50.º', r.valores[49].valor === 'v49');
  check('el total refleja el conjunto entero', r.total === 120);
  check('se declara truncado', r.truncado);

  const cabe = recortar(muchos.slice(0, 10), 50);
  check('si cabe entero, no se declara truncado', !cabe.truncado && cabe.total === 10);
  check('límite 0 no recorta', recortar(muchos, 0).valores.length === 120);
}

// ════════════════════════════════════════════════════════════
seccion('Contrato histórico intacto');
// ════════════════════════════════════════════════════════════
// `type=distinct` sigue devolviendo un array de nombres: lo consumen el slicer y
// el desplegable de campaña, y un widget servido desde caché del navegador tiene
// que seguir funcionando.
{
  const r: ResultadoValores = {
    valores: [
      { valor: 'b', n: 9 },
      { valor: 'a', n: 3 },
    ],
    total: 2,
    truncado: false,
  };
  const plano = aValoresPlanos(r);
  check('devuelve string[]', Array.isArray(plano) && plano.every((v) => typeof v === 'string'));
  check('conserva el mismo orden', plano.join(',') === 'b,a');
}

// ════════════════════════════════════════════════════════════
seccion('Una lista vacía siempre dice por qué');
// ════════════════════════════════════════════════════════════
// Doctrina del proyecto: donde no se puede saber, se dice. Un error de consulta
// que se traduce a «no hay datos» ya costó un fallo real en este repo.
for (const m of ['sin_cliente', 'dimension_no_listable', 'error_consulta', 'timeout'] as const) {
  const r = sinValores(m);
  check(
    `«${m}» viene con lista vacía y motivo`,
    r.valores.length === 0 && r.motivo === m && r.total === 0 && !r.truncado
  );
}
check(
  'un vacío legítimo NO lleva motivo',
  VACIO_HONESTO.valores.length === 0 && VACIO_HONESTO.motivo === undefined
);

// ════════════════════════════════════════════════════════════
seccion('Los seleccionados nunca se pierden de vista');
// ════════════════════════════════════════════════════════════
// Sin esto, abrir el panel de un filtro guardado sobre un valor que ya no está
// entre los más frecuentes del rango y tocar cualquier cosa lo borraría.
{
  const listados: ValorConConteo[] = [
    { valor: 'a', n: 10 },
    { valor: 'b', n: 5 },
  ];
  const filas = componerFilas(listados, ['b', 'raro']);
  check(
    'el seleccionado ausente aparece',
    filas.some((f) => f.valor === 'raro')
  );
  check('y va el primero', filas[0].valor === 'raro');
  // `null` no es cero: no se sabe cuántos hay, y decir 0 sería inventarlo.
  check('su conteo es desconocido, no cero', filas[0].n === null);
  check('el seleccionado presente conserva su conteo', filas.find((f) => f.valor === 'b')?.n === 5);
  check(
    'los marcados se marcan',
    filas
      .filter((f) => f.marcado)
      .map((f) => f.valor)
      .sort()
      .join(',') === 'b,raro'
  );
  check('los no marcados no', filas.find((f) => f.valor === 'a')?.marcado === false);
  check('no hay duplicados', new Set(filas.map((f) => f.valor)).size === filas.length);
}

// ════════════════════════════════════════════════════════════
seccion('Casillas solo en los operadores de pertenencia');
// ════════════════════════════════════════════════════════════
// «contiene ∈ {a, b, c}» no significa nada: un operador de subcadena se aplica a
// UN texto, y ofrecer valores exactos ahí construiría un filtro engañoso.
check('«es igual a» sí', esSeleccionPorCasillas('eq'));
check('«no es igual a» sí', esSeleccionPorCasillas('neq'));
for (const op of ['contains', 'ncontains', 'starts', 'ends'] as const) {
  check(`«${op}» no`, !esSeleccionPorCasillas(op));
}

console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} comprobación(es) fallida(s)`);
process.exit(fallos === 0 ? 0 : 1);
