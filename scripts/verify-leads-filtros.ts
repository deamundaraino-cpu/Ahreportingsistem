/**
 * Comprobaciones de los filtros y el buscador de `/leads`.
 *
 * Existen por dos fallos reales, los dos del mismo tipo: la misma lógica escrita
 * dos veces, divergiendo en silencio.
 *
 *   · La página recortaba el rango de fechas con `colombiaRangeBounds` y el CSV
 *     mandaba literales SIN zona, que Postgres lee en UTC. El export cogía 5 h de
 *     más al principio del rango y perdía las 5 últimas, así que el total de la
 *     pantalla y las filas del CSV no cuadraban.
 *   · La lista de parámetros de la URL estaba escrita tres veces (lista blanca en
 *     `buildUrl`, lista negra en el enlace de export, condición en `hasFilters`).
 *
 * Todo es puro: no toca Postgres.
 *
 *   npx tsx --conditions=react-server scripts/verify-leads-filtros.ts
 */

import { readFileSync } from 'node:fs';
import {
  leerFiltros,
  aplicarFiltrosLeads,
  aQueryString,
  hayFiltros,
  cadenaOrBusqueda,
  escLike,
  patronLike,
  valorOr,
  valorOrExacto,
  patronEmpieza,
  patronTermina,
  arbolFiltros,
  faltaAcotarFiltrosCaros,
  chipsFiltros,
  presetsFecha,
  presetActivo,
  ascendente,
  parseCondicion,
  serializarCondicion,
  urlExport,
  urlLeads,
  CAMPOS_FILTRABLES,
  COLUMNAS_BUSQUEDA,
  OP_POR_DEFECTO,
  PARAMS_LEADS,
  MIN_BUSQUEDA,
  MAX_BUSQUEDA,
  type FiltrosLeads,
  type QueryPostgrest,
} from '../src/lib/report-utm/leads-filtros';
import { MOTIVOS_EXCLUSION } from '../src/lib/report-utm/lead-exclusion';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// 1. Escapes: la tabla dorada
// ════════════════════════════════════════════════════════════════════
//
// Cada fila corresponde a una petición real hecha contra PostgREST el
// 2026-09-21. No son teoría: son lo que el servidor contestó.
console.log('\n1. Escape del término de búsqueda');

// Medido: `or=(nombre.ilike.%a,b%)` → 400 PGRST100. Con comillas, parsea bien.
check('una coma va entrecomillada', valorOr('a,b') === String.raw`"%a,b%"`, valorOr('a,b'));

// Medido: con UNA barra el parser se la come y `%` vuelve a ser comodín (6 filas
// de 6). Con DOS, el porcentaje es literal (0 filas).
check(
  'un % literal lleva exactamente dos barras',
  valorOr('100%') === String.raw`"%100\\%%"`,
  valorOr('100%')
);
check('un _ literal, igual', valorOr('a_b') === String.raw`"%a\\_b%"`, valorOr('a_b'));

// Medido: una comilla sin escapar devuelve 200 con resultados distintos, no un
// 400. Es el fallo silencioso, y por eso importa.
check('una comilla se escapa', valorOr('a"b') === String.raw`"%a\"b%"`, valorOr('a"b'));

// El orden importa: primero LIKE, luego el parser. Al revés, las barras que mete
// `escLike` se duplicarían mal.
check(
  'una barra del usuario sobrevive como barra',
  valorOr(String.raw`C:\x`) === String.raw`"%C:\\\\x%"`,
  valorOr(String.raw`C:\x`)
);

// Medido: el paréntesis no rompe la gramática si el valor va entrecomillado.
check('un paréntesis no necesita nada más', valorOr('a(b') === String.raw`"%a(b%"`);
check('el caso normal no se ensucia', valorOr('ana') === '"%ana%"');

// `patronLike` es el otro camino, el de los `.ilike()` normales. Ahí las comillas
// serían LITERALES (medido: `nombre=ilike."%a%"` → 200 con CERO filas), así que
// no las lleva. Mezclar los dos es el error caro.
console.log('\n2. El otro escape: .ilike() de primer nivel, SIN comillas');
check('patronLike no entrecomilla', patronLike('ana') === '%ana%');
check('pero sí escapa comodines', patronLike('50%') === String.raw`%50\%%`);
check('y la barra', escLike(String.raw`a\b`) === String.raw`a\\b`);
check(
  'ningún patrón de .ilike() lleva comillas dobles',
  !patronLike('a"b').startsWith('"') && !patronLike('ana').includes('"')
);

// ════════════════════════════════════════════════════════════════════
// 3. La cadena `or` del buscador
// ════════════════════════════════════════════════════════════════════
console.log('\n3. La cadena or');

const orAna = cadenaOrBusqueda('ana') ?? '';
check(
  'busca en las tres columnas',
  COLUMNAS_BUSQUEDA.every((c) => orAna.includes(`${c}.ilike.`))
);
check('separadas por comas', orAna.split(',').length === COLUMNAS_BUSQUEDA.length);
check('sin término no hay cadena', cadenaOrBusqueda(null) === null);

// El 31 % de los teléfonos guardados empiezan por `+57` y el usuario los teclea
// con espacios: sin normalizar, buscar «+57 300 1234567» no encontraría nada.
const orTel = cadenaOrBusqueda('+57 300 1234567') ?? '';
check('un teléfono añade el disyunto de solo dígitos', orTel.includes('"%573001234567%"'), orTel);
check(
  'y no lo añade cuando no hace falta',
  !(cadenaOrBusqueda('3001234567') ?? '').includes(',lead_phone.ilike."%3001234567%",lead_phone')
);
check(
  'un nombre no dispara el camino de teléfono',
  (cadenaOrBusqueda('ana') ?? '').split('lead_phone').length === 2
);

// ════════════════════════════════════════════════════════════════════
// 4. Normalización de la URL
// ════════════════════════════════════════════════════════════════════
console.log('\n4. leerFiltros');

const corto = leerFiltros({ q: 'ab' });
check('con menos de 3 caracteres no se busca', corto.q === null);
check('pero no se ignora en silencio', corto.qCorto === true);
check('y se conserva lo tecleado para el input', corto.qTexto === 'ab');

// `*` se convierte en `%` dentro y fuera de comillas: no hay escape posible, así
// que se quita. Como el término ya va envuelto en `%…%`, no se pierde nada.
check('el asterisco se elimina', leerFiltros({ q: 'a*b*c' }).q === 'abc');
check('un asterisco suelto no deja una búsqueda vacía', leerFiltros({ q: '*' }).qTexto === null);

// `?q=a&q=b` llega como ARRAY aunque el tipo de Next diga `string`. Sin esto se
// colaría una coma en la cadena `or` y PostgREST devolvería 400.
check('un parámetro repetido toma el primero', leerFiltros({ q: ['juan', 'pepe'] }).q === 'juan');

check('el término se recorta', leerFiltros({ q: 'x'.repeat(200) }).q?.length === MAX_BUSQUEDA);
check(
  'los espacios de los lados no cuentan',
  leerFiltros({ utm_source: '  ig  ' }).utmSource === 'ig'
);
check(
  'un valor vacío es null, no cadena vacía',
  leerFiltros({ utm_source: '   ' }).utmSource === null
);

check(
  'un estado inventado cae a incluidos',
  leerFiltros({ estado: 'raro' }).estado === 'incluidos'
);
check('un estado válido se respeta', leerFiltros({ estado: 'excluidos' }).estado === 'excluidos');
check('un motivo inventado se descarta', leerFiltros({ motivo: 'porque-si' }).motivo === null);
check('un motivo válido pasa', leerFiltros({ motivo: 'manual' }).motivo === 'manual');
check(
  'un método de atribución inventado se descarta',
  leerFiltros({ attribution_method: 'telepatia' }).attributionMethod === null
);

check('una página negativa es la 1', leerFiltros({ page: '-5' }).page === 1);
check('una página que no es número es la 1', leerFiltros({ page: 'abc' }).page === 1);
check('una página válida se respeta', leerFiltros({ page: '7' }).page === 7);

// Una fecha con otra forma se descarta en vez de colarse en `colombiaRangeBounds`,
// que la devolvería tal cual y produciría un límite sin sentido.
check('una fecha con mala forma se descarta', leerFiltros({ from: 'ayer' }).from === null);
check('una fecha ISO pasa', leerFiltros({ from: '2026-09-01' }).from === '2026-09-01');

check('sin nada, no hay filtros', hayFiltros(leerFiltros({})) === false);
check('la pestaña cuenta como filtro', hayFiltros(leerFiltros({ estado: 'todos' })) === true);
check('y un filtro normal también', hayFiltros(leerFiltros({ utm_source: 'ig' })) === true);

// ════════════════════════════════════════════════════════════════════
// 5. La URL sobrevive a la paginación
// ════════════════════════════════════════════════════════════════════
console.log('\n5. aQueryString no pierde parámetros');

const TODO: Record<string, string> = {
  clienteId: '11111111-1111-1111-1111-111111111111',
  form_plugin: 'elementor',
  utm_source: 'instagram',
  utm_medium: 'paid_social',
  utm_campaign: 'campaña',
  utm_content: 'creativo',
  utm_term: 'termino',
  utm_id: '120210000000000000',
  ip_country: 'CO',
  form_name: 'contacto',
  attribution_method: 'click_id',
  campo: 'Rango de renta',
  campo_valor: 'eq:2M a 3M',
  orden: 'antiguo',
  con: 'utm_id',
  sin: 'ip_country',
  motivo: 'manual',
  q: 'juan',
  from: '2026-09-01',
  to: '2026-09-30',
  estado: 'excluidos',
  page: '3',
};
const f = leerFiltros(TODO);
const qs = aQueryString(f);

// El síntoma clásico de olvidarse una clave: filtras, pasas a la página 2 y
// vuelve la lista completa.
for (const p of PARAMS_LEADS) {
  check(`«${p}» sobrevive a la reconstrucción`, qs.includes(`${p}=`), qs);
}
check('PARAMS_LEADS los cubre todos', PARAMS_LEADS.length === Object.keys(TODO).length);
check(
  'el valor se codifica',
  aQueryString(leerFiltros({ utm_campaign: 'a b&c' })).includes('a%20b%26c')
);
check('la página 1 no ensucia la URL', !aQueryString(leerFiltros({ page: '1' })).includes('page='));
check(
  'la pestaña por defecto tampoco',
  !aQueryString(leerFiltros({ estado: 'incluidos' })).includes('estado=')
);
check('override borra una clave', !aQueryString(f, { page: undefined }).includes('page='));
check('override cambia una clave', aQueryString(f, { page: '9' }).includes('page=9'));
check('sin filtros la url queda limpia', urlLeads(leerFiltros({})) === '/leads');
check('el export nunca lleva page', !urlExport(f).includes('page='), urlExport(f));
check(
  'el export hereda el resto',
  urlExport(f).includes('q=juan') && urlExport(f).includes('estado=excluidos')
);

// ════════════════════════════════════════════════════════════════════
// 6. La consulta que se genera
// ════════════════════════════════════════════════════════════════════
//
// El espía graba las llamadas al builder. Así se demuestra SIN base de datos que
// la página y el export generan exactamente la misma consulta: es lo que impide
// que vuelvan a divergir.
console.log('\n6. aplicarFiltrosLeads');

type Llamada = [string, string, unknown];

function espia(): { traza: Llamada[]; q: QueryPostgrest } {
  const traza: Llamada[] = [];
  const q: QueryPostgrest = {
    eq(columna: string, valor: unknown) {
      traza.push(['eq', columna, valor]);
      return this;
    },
    ilike(columna: string, patron: string) {
      traza.push(['ilike', columna, patron]);
      return this;
    },
    gte(columna: string, valor: string) {
      traza.push(['gte', columna, valor]);
      return this;
    },
    lt(columna: string, valor: string) {
      traza.push(['lt', columna, valor]);
      return this;
    },
    or(filtros: string) {
      traza.push(['or', '', filtros]);
      return this;
    },
    is(columna: string, valor: null) {
      traza.push(['is', columna, valor]);
      return this;
    },
    not(columna: string, operador: string, valor: unknown) {
      traza.push(['not', columna, `${operador}.${String(valor)}`]);
      return this;
    },
  };
  return { traza, q };
}

function trazar(
  filtros: FiltrosLeads,
  o: { conExclusion: boolean; conEstado: boolean }
): Llamada[] {
  const { traza, q } = espia();
  aplicarFiltrosLeads(q, filtros, o);
  return traza;
}

const completa = trazar(f, { conExclusion: true, conEstado: true });
const clave = (t: Llamada[]) => t.map(([m, c]) => `${m}:${c}`).join(' ');

check(
  'el orden y las columnas son los esperados',
  clave(completa) ===
    'eq:cliente_id eq:form_plugin eq:attribution_method ilike:utm_source ilike:utm_medium ' +
      'ilike:utm_campaign ilike:utm_content ilike:utm_term ilike:utm_id ilike:ip_country ' +
      'ilike:form_name not:utm_id is:ip_country eq:raw_fields->>Rango de renta ' +
      'gte:created_at lt:created_at or: eq:excluido eq:excluido_motivo',
  clave(completa)
);

// Lo disyuntivo viaja DENTRO del string del `or`, así que por muchas
// condiciones que haya la consulta sigue llevando una sola llamada. Si alguna
// vez aparecen dos, es que alguien volvió a encadenar `.or()` y la semántica de
// `or=…&or=…` pasa a importar.
check(
  'como mucho una llamada a or()',
  completa.filter(([m]) => m === 'or').length <= 1,
  String(completa.filter(([m]) => m === 'or').length)
);

// El bug del CSV, fijado: el límite lleva el desplazamiento de Colombia y el
// superior es EXCLUSIVO del día siguiente, no `23:59:59`.
const gte = completa.find(([m]) => m === 'gte');
const lt = completa.find(([m]) => m === 'lt');
check(
  'el límite inferior es el día Colombia',
  gte?.[2] === '2026-09-01T00:00:00-05:00',
  String(gte?.[2])
);
check(
  'el superior es exclusivo del día siguiente',
  lt?.[2] === '2026-10-01T00:00:00-05:00',
  String(lt?.[2])
);
check('y nunca es 23:59:59', !JSON.stringify(completa).includes('23:59:59'));

// `conEstado: false` es lo que permite contar los excluidos con el resto de
// filtros puestos: si colara la pestaña, el conteo de la pestaña se filtraría a
// sí mismo y siempre daría cero.
const sinEstado = trazar(f, { conExclusion: true, conEstado: false });
check('sin estado no se toca `excluido`', !clave(sinEstado).includes('excluido'), clave(sinEstado));
check('pero el resto de filtros siguen', clave(sinEstado).startsWith('eq:cliente_id'));

// Sin la migración 079 la columna no existe: tocarla tumbaría la consulta entera
// con un 42703 de PostgREST.
const sinColumna = trazar(f, { conExclusion: false, conEstado: true });
check('sin la 079 no se menciona `excluido`', !clave(sinColumna).includes('excluido'));

// El motivo solo tiene sentido sobre los excluidos.
const enIncluidos = trazar(leerFiltros({ motivo: 'manual' }), {
  conExclusion: true,
  conEstado: true,
});
check(
  'el motivo no se aplica fuera de la pestaña de excluidos',
  !clave(enIncluidos).includes('excluido_motivo'),
  clave(enIncluidos)
);

// Un extremo suelto no inventa el otro: `desde` sin `hasta` no pone techo.
const soloFrom = trazar(leerFiltros({ from: '2026-09-01' }), {
  conExclusion: true,
  conEstado: true,
});
check('«desde» suelto no pone techo', !clave(soloFrom).includes('lt:'), clave(soloFrom));
const soloTo = trazar(leerFiltros({ to: '2026-09-30' }), { conExclusion: true, conEstado: true });
check('«hasta» suelto no pone suelo', !clave(soloTo).includes('gte:'), clave(soloTo));
check(
  'y sí pone el techo del día siguiente',
  soloTo.find(([m]) => m === 'lt')?.[2] === '2026-10-01T00:00:00-05:00'
);

// Un término corto no llega a la consulta.
const busquedaCorta = trazar(leerFiltros({ q: 'ab' }), { conExclusion: true, conEstado: true });
check('un término de 2 caracteres no genera `or`', !clave(busquedaCorta).includes('or:'));
check(`el mínimo documentado es ${MIN_BUSQUEDA}`, MIN_BUSQUEDA === 3);

// ════════════════════════════════════════════════════════════════════
// 6 bis. Operadores, multi-valor y el árbol lógico
// ════════════════════════════════════════════════════════════════════
console.log('\n6 bis. El árbol de condiciones');

// ── El escape hermano ────────────────────────────────────────────────
// `valorOr` sirve para `ilike`; `valorOrExacto` para `eq`. Confundirlos hace
// que una campaña con `%` deje de encontrarse y la respuesta sea 200 con cero
// filas: el fallo que no se ve.
check(
  'un eq NO pasa por escLike',
  valorOrExacto('PROMO 50%') === '"PROMO 50%"',
  valorOrExacto('PROMO 50%')
);
check(
  'pero sí escapa para el parser',
  valorOrExacto('a"b') === String.raw`"a\"b"`,
  valorOrExacto('a"b')
);
check('un ilike sí escapa el comodín', valorOr('50%') === String.raw`"%50\\%%"`);
check('empieza con: comodín solo a la derecha', patronEmpieza('ab') === 'ab%');
check('termina con: comodín solo a la izquierda', patronTermina('ab') === '%ab');

// ── Lectura de la condición ──────────────────────────────────────────
check('sin prefijo el operador es contains', parseCondicion('verano')?.op === OP_POR_DEFECTO);
check('y contains es el defecto documentado', OP_POR_DEFECTO === 'contains');
check('un prefijo válido se respeta', parseCondicion('eq:verano')?.op === 'eq');
check(
  'un prefijo inventado es parte del valor',
  parseCondicion('telepatia:verano')?.valores[0] === 'telepatia:verano'
);
check('varios valores se parten', parseCondicion('eq:a,b,c')?.valores.length === 3);
// Hay 717 nombres de entidad con coma en esta base: si la coma no sobrevive al
// viaje, el filtro busca dos valores que no existen en vez de uno que sí.
check(
  'una coma escapada sobrevive',
  parseCondicion(String.raw`eq:[A\,B]`)?.valores[0] === '[A,B]',
  String(parseCondicion(String.raw`eq:[A\,B]`)?.valores[0])
);
check(
  'ida y vuelta de un valor con coma',
  parseCondicion(serializarCondicion({ op: 'eq', valores: ['[A,B]', 'x'] }))?.valores.join('|') ===
    '[A,B]|x'
);
check('una condición vacía es null', parseCondicion('eq:') === null);

// ── El árbol ─────────────────────────────────────────────────────────
// Una búsqueda sola tiene que generar EXACTAMENTE la cadena de antes de existir
// el árbol: es la que está medida contra PostgREST real en la sección 3.
check(
  'una búsqueda sola no se envuelve',
  arbolFiltros(leerFiltros({ q: 'ana' })) === cadenaOrBusqueda('ana'),
  String(arbolFiltros(leerFiltros({ q: 'ana' })))
);
check('sin nada disyuntivo no hay árbol', arbolFiltros(leerFiltros({})) === null);
// Un solo valor positivo va como filtro plano, no al árbol.
check(
  'un contains de un valor no entra en el árbol',
  arbolFiltros(leerFiltros({ utm_source: 'ig' })) === null
);
check('un eq de un valor tampoco', arbolFiltros(leerFiltros({ utm_source: 'eq:ig' })) === null);

// Un solo nodo va SIN envolver, porque `.or(X)` ya produce `or=(X)`. Envolverlo
// daría `or=(or(…))`: equivalente, pero una capa que nadie necesita.
const arbolMulti = arbolFiltros(leerFiltros({ utm_source: 'eq:facebook,instagram' })) ?? '';
check(
  'varios valores son un or de igualdades',
  arbolMulti === 'utm_source.eq."facebook",utm_source.eq."instagram"',
  arbolMulti
);

// La trampa de NULL: sin el `is.null` de delante, «no es instagram» se dejaría
// fuera justo los leads SIN utm_source, que son los que se está buscando.
const arbolNeq = arbolFiltros(leerFiltros({ utm_source: 'neq:ig' })) ?? '';
check('un neq incluye is.null', arbolNeq.includes('utm_source.is.null'), arbolNeq);
check('y niega el valor', arbolNeq.includes('utm_source.neq."ig"'), arbolNeq);
const arbolNcon = arbolFiltros(leerFiltros({ utm_campaign: 'ncontains:test' })) ?? '';
check('un ncontains incluye is.null', arbolNcon.includes('utm_campaign.is.null'), arbolNcon);
check('y niega con not.ilike', arbolNcon.includes('utm_campaign.not.ilike.'), arbolNcon);

// Dos nodos se unen por Y bajo un único hijo raíz.
const arbolDoble = arbolFiltros(leerFiltros({ q: 'ana', utm_source: 'eq:a,b' })) ?? '';
check('dos nodos van bajo un and()', arbolDoble.startsWith('and('), arbolDoble);
check('con el buscador envuelto en or()', arbolDoble.includes('or(lead_name.ilike.'), arbolDoble);

// `starts`/`ends` no pueden acabar con el comodín de los dos lados.
const arbolStarts = arbolFiltros(leerFiltros({ utm_campaign: 'starts:ver,oto' })) ?? '';
check('starts no pone comodín a la izquierda', arbolStarts.includes('"ver%"'), arbolStarts);

// Un solo valor positivo sí llega a la consulta, como filtro plano.
const trazaStarts = trazar(leerFiltros({ utm_campaign: 'starts:ver' }), {
  conExclusion: false,
  conEstado: false,
});
check(
  'starts de un valor es un ilike plano sin comodín izquierdo',
  trazaStarts.some(([m, c, v]) => m === 'ilike' && c === 'utm_campaign' && v === 'ver%'),
  JSON.stringify(trazaStarts)
);
const trazaEq = trazar(leerFiltros({ utm_source: 'eq:ig' }), {
  conExclusion: false,
  conEstado: false,
});
check(
  'eq de un valor es un eq plano, sin patrón',
  trazaEq.some(([m, c, v]) => m === 'eq' && c === 'utm_source' && v === 'ig'),
  JSON.stringify(trazaEq)
);

// Compatibilidad: los enlaces que la gente ya tiene guardados siguen filtrando
// por subcadena, que es lo que esta página hizo siempre.
const trazaVieja = trazar(leerFiltros({ utm_campaign: 'verano' }), {
  conExclusion: false,
  conEstado: false,
});
check(
  'un enlace viejo sigue siendo ilike %x%',
  trazaVieja.some(([m, c, v]) => m === 'ilike' && c === 'utm_campaign' && v === '%verano%'),
  JSON.stringify(trazaVieja)
);

// La lista de campos filtrables y los parámetros de la URL no pueden separarse.
for (const campo of CAMPOS_FILTRABLES) {
  check(`«${campo}» es un parámetro de la URL`, PARAMS_LEADS.includes(campo));
}

// ── Presencia: «tiene dato» / «está vacío» ───────────────────────────
console.log('\n6 ter. Presencia (con / sin)');

// Medido el 2026-09-21: CERO cadenas vacías en las ocho columnas, así que
// «vacío» es `IS NULL` puro y sale como filtro PLANO. Si esto se convirtiera en
// un `or`, el árbol cambiaría y esta comprobación lo cazaría.
const trazaSin = trazar(leerFiltros({ clienteId: 'c1', sin: 'utm_source' }), {
  conExclusion: false,
  conEstado: false,
});
check(
  'vacío es un is null plano',
  trazaSin.some(([m, c, v]) => m === 'is' && c === 'utm_source' && v === null),
  JSON.stringify(trazaSin)
);
check('y no genera árbol', !trazaSin.some(([m]) => m === 'or'), JSON.stringify(trazaSin));

const trazaCon = trazar(leerFiltros({ clienteId: 'c1', con: 'utm_campaign' }), {
  conExclusion: false,
  conEstado: false,
});
check(
  'con valor es un not.is.null plano',
  trazaCon.some(([m, c, v]) => m === 'not' && c === 'utm_campaign' && v === 'is.null'),
  JSON.stringify(trazaCon)
);

// El formulario manda un control por campo, así que el parámetro llega repetido.
check(
  'el parámetro repetido se acumula',
  leerFiltros({ sin: ['utm_source', 'utm_campaign'] }).sin.length === 2
);
check(
  'y la forma con comas también',
  leerFiltros({ sin: 'utm_source,utm_campaign' }).sin.length === 2
);
check('un campo inventado se descarta', leerFiltros({ sin: 'telepatia' }).sin.length === 0);
check('un campo no filtrable tampoco cuela', leerFiltros({ sin: 'lead_email' }).sin.length === 0);
check('sin duplicados', leerFiltros({ sin: 'utm_source,utm_source' }).sin.length === 1);

// Un campo no puede exigir dato y estar vacío a la vez: gana el restrictivo.
const contradictorio = leerFiltros({ con: 'utm_source', sin: 'utm_source' });
check('ante la contradicción gana «sin»', contradictorio.sin.length === 1);
check('y «con» se queda vacío', contradictorio.con.length === 0);

// La forma canónica es la de comas, que es la que sobrevive a la paginación.
check(
  'la URL se reemite con comas',
  aQueryString(leerFiltros({ sin: ['utm_source', 'utm_campaign'] })).includes(
    'sin=utm_source%2Cutm_campaign'
  ),
  aQueryString(leerFiltros({ sin: ['utm_source', 'utm_campaign'] }))
);
check('y cuenta como filtro', hayFiltros(leerFiltros({ sin: 'utm_source' })) === true);

// `col IS NULL` no lo sirve ningún índice: sin cliente son 93.415 filas y
// 171 MB, el patrón de la caída del 2026-09-20.
check(
  'sin cliente, la presencia está sin acotar',
  faltaAcotarFiltrosCaros(leerFiltros({ sin: 'utm_source' }))
);
check(
  'con cliente, se puede',
  !faltaAcotarFiltrosCaros(leerFiltros({ sin: 'utm_source', clienteId: 'c1' }))
);
check('y sin presencia nunca bloquea', !faltaAcotarFiltrosCaros(leerFiltros({ utm_source: 'ig' })));

// ── Respuesta de formulario (`raw_fields`) ───────────────────────────
console.log('\n6 ter bis. Respuesta de formulario');

// La clave viaja TAL CUAL está guardada. Normalizarla aquí sería el fallo: en
// `raw_fields` la clave es «Rango de renta», no «rango_de_renta».
const conCampo = leerFiltros({
  clienteId: 'c1',
  campo: 'Rango de renta',
  campo_valor: 'eq:2M a 3M',
});
check('la clave se conserva con espacios y mayúsculas', conCampo.campo === 'Rango de renta');
const trazaCampo = trazar(conCampo, { conExclusion: false, conEstado: false });
check(
  'filtra por raw_fields->>clave',
  trazaCampo.some(
    ([m, c, v]) => m === 'eq' && c === 'raw_fields->>Rango de renta' && v === '2M a 3M'
  ),
  JSON.stringify(trazaCampo)
);
check('y es un filtro plano, no entra en el árbol', arbolFiltros(conCampo) === null);

// Un `neq` sobre JSON tiene la misma trampa de NULL, así que va por `not`.
const campoNeq = leerFiltros({ clienteId: 'c1', campo: 'ciudad', campo_valor: 'neq:Bogotá' });
check(
  'un neq de respuesta usa not',
  trazar(campoNeq, { conExclusion: false, conEstado: false }).some(
    ([m, c]) => m === 'not' && c === 'raw_fields->>ciudad'
  )
);

// Una clave con caracteres que romperían el camino se descarta ENTERA, no se
// recorta: recortarla filtraría por otra pregunta sin avisar.
check('una clave con comillas se descarta', leerFiltros({ campo: 'a"b' }).campo === null);
check('una con paréntesis también', leerFiltros({ campo: 'a(b)' }).campo === null);
check('y una con coma', leerFiltros({ campo: 'a,b' }).campo === null);
check('una clave larguísima se descarta', leerFiltros({ campo: 'x'.repeat(200) }).campo === null);
check('sin clave no hay valor', leerFiltros({ campo_valor: 'eq:x' }).campoCond === null);
check(
  'sin valor no se filtra',
  trazar(leerFiltros({ campo: 'ciudad' }), { conExclusion: false, conEstado: false }).every(
    ([, c]) => !String(c).startsWith('raw_fields')
  )
);

// Es caro igual que la presencia: sin cliente no se lanza.
check(
  'una respuesta sin cliente está sin acotar',
  faltaAcotarFiltrosCaros(leerFiltros({ campo: 'ciudad', campo_valor: 'eq:Bogotá' }))
);

// ════════════════════════════════════════════════════════════════════
// 6 quater. Chips, presets y orden
// ════════════════════════════════════════════════════════════════════
console.log('\n6 quater. Chips, presets y orden');

// El chip tiene que quitar SU filtro y no tocar los demás: es el fallo típico
// de un «quitar» escrito a mano con una lista de claves aparte.
const conVarios = leerFiltros({ utm_source: 'eq:ig', utm_campaign: 'verano', q: 'ana' });
const chips = chipsFiltros(conVarios);
check('hay un chip por filtro puesto', chips.length === 3, String(chips.length));
const chipSource = chips.find((c) => c.param === 'utm_source');
const urlSinSource = urlLeads(conVarios, { ...chipSource!.quitar, page: undefined });
check('quitar un chip borra su filtro', !urlSinSource.includes('utm_source='), urlSinSource);
check(
  'y respeta los otros',
  urlSinSource.includes('utm_campaign=') && urlSinSource.includes('q=ana')
);

// La presencia vive en una lista: quitar un campo la reescribe sin él, no borra
// el parámetro entero.
const dosSin = leerFiltros({ clienteId: 'c1', sin: 'utm_source,utm_campaign' });
const chipSin = chipsFiltros(dosSin).find((c) => c.clave === 'sin:utm_source');
const urlUnSin = urlLeads(dosSin, { ...chipSin!.quitar, page: undefined });
check('quitar una presencia conserva las demás', urlUnSin.includes('sin=utm_campaign'), urlUnSin);
const unSin = leerFiltros({ clienteId: 'c1', sin: 'utm_source' });
const chipUnico = chipsFiltros(unSin).find((c) => c.clave === 'sin:utm_source');
check(
  'y quitar la última borra el parámetro',
  !urlLeads(unSin, chipUnico!.quitar).includes('sin='),
  urlLeads(unSin, chipUnico!.quitar)
);
check('sin filtros no hay chips', chipsFiltros(leerFiltros({})).length === 0);

// Los presets tienen que poder reconocerse a sí mismos: si `presetActivo` no
// encontrara el que acaba de aplicarse, ninguno se vería marcado nunca.
const HOY = '2026-09-21';
for (const p of presetsFecha(HOY)) {
  const aplicado = leerFiltros({ from: p.from, to: p.to });
  check(`el preset «${p.etiqueta}» se reconoce`, presetActivo(aplicado, HOY) === p.id);
}
check(
  'un rango cualquiera no es preset',
  presetActivo(leerFiltros({ from: '2020-01-01', to: HOY }), HOY) === null
);
check('sin fechas tampoco', presetActivo(leerFiltros({}), HOY) === null);

// Orden: el defecto no ensucia la URL y solo se aceptan los dos valores.
check('el orden por defecto es el reciente', leerFiltros({}).orden === 'reciente');
check('y no aparece en la URL', !aQueryString(leerFiltros({})).includes('orden='));
check(
  'el orden inverso sí',
  aQueryString(leerFiltros({ orden: 'antiguo' })).includes('orden=antiguo')
);
check(
  'un orden inventado cae al defecto',
  leerFiltros({ orden: 'por_nombre' }).orden === 'reciente'
);
check('ascendente solo con «antiguo»', ascendente(leerFiltros({ orden: 'antiguo' })) === true);
check('y descendente por defecto', ascendente(leerFiltros({})) === false);

// ════════════════════════════════════════════════════════════════════
// 7. Antidivergencia: nadie más escribe filtros
// ════════════════════════════════════════════════════════════════════
//
// Esta es la comprobación que impide que el fallo vuelva. Si alguien añade un
// `.ilike()` suelto a la página o al export, la copia de filtros renace.
console.log('\n7. Ni la página ni el export tienen filtros propios');

const PAGINA = 'src/app/(app)/leads/page.tsx';
const EXPORT = 'src/app/api/report-utm/leads/export/route.ts';
// Las server actions entraron en la lista al aparecer «marcar todos los que
// coinciden»: esa acción recibe FILTROS y construye una consulta, así que es el
// tercer sitio donde la copia podía renacer — y el más caro, porque escribe.
const ACCIONES = 'src/app/(app)/leads/_actions.ts';

for (const ruta of [PAGINA, EXPORT, ACCIONES]) {
  const fuente = readFileSync(ruta, 'utf8');
  const nombre = ruta.split('/').pop();
  check(`${nombre} usa leads-filtros`, /from '@\/lib\/report-utm\/leads-filtros'/.test(fuente));
  check(`${nombre} no tiene .ilike() propios`, !fuente.includes('.ilike('));
  check(`${nombre} no tiene .or() propios`, !/\.or\(/.test(fuente));
  check(`${nombre} no recorta fechas a mano`, !/\.(gte|lte)\(['"]created_at/.test(fuente));
  check(`${nombre} no usa el viejo 23:59:59`, !fuente.includes('23:59:59'));
}

const fuentePagina = readFileSync(PAGINA, 'utf8');

// Todo filtro de la URL necesita un control en el formulario (o un hidden que lo
// conserve): si no, filtrar desde la UI lo borraría.
//
// Los controles por columna viven ahora en un componente cliente, porque un
// desplegable de valores con casillas no se puede pintar desde el servidor. La
// comprobación NO se relaja por eso: se mira el conjunto de fuentes que componen
// el formulario. Si mañana aparece otro componente de filtro, va a esta lista.
const FUENTES_FORM = [
  PAGINA,
  'src/components/report-utm/leads/LeadsFiltrosBar.tsx',
  'src/components/report-utm/leads/LeadsCampoFormulario.tsx',
];
const fuenteForm = FUENTES_FORM.map((r) => readFileSync(r, 'utf8')).join('\n');

for (const p of PARAMS_LEADS) {
  if (p === 'page') continue; // la paginación son enlaces, no un input
  // El componente los pinta en un bucle sobre `CAMPOS_FILTRABLES`, así que su
  // `name` es una expresión, no un literal: basta con que el campo esté en la
  // lista que el bucle recorre.
  const literal = fuenteForm.includes(`name="${p}"`);
  const porBucle =
    (CAMPOS_FILTRABLES as readonly string[]).includes(p) && fuenteForm.includes('name={campo}');
  check(`el formulario conserva «${p}»`, literal || porBucle);
}

// El tope real de PostgREST es ~1000: pedir 5000 hacía que el aviso
// («Resumen sobre 5000») no se mostrara jamás.
check('STATS_CAP ya no promete 5000', /const STATS_CAP = 1000;/.test(fuentePagina));
check(
  'los agregados van ordenados',
  /select\('utm_source, utm_campaign, utm_content'\)[\s\S]{0,400}?\.order\(/.test(fuentePagina)
);
// Ordenar por `created_at` sin `cliente_id` no lo sirve ningún índice (los dos
// que hay empiezan por cliente_id), así que serían 93.000 filas leídas y
// ordenadas en cada carga de /leads: los mismos 171 MB contra 224 MB de caché de
// la caída del 2026-09-20. Con cliente, el índice los da ya ordenados.
check(
  'y no se lanzan sin cliente elegido',
  /const qStats\s*=\s*\n?\s*f\.q \|\| !f\.clienteId/.test(fuentePagina),
  'el desglose ordenado sin cliente lee la tabla entera'
);
// El acceso es opcional porque la consulta puede no haberse lanzado (filtros de
// presencia sin cliente), pero el error se sigue pintando.
check('la página pinta el error de la consulta', /resPagina\??\.error/.test(fuentePagina));

// Medido el 2026-09-21: `count: 'exact'` sin `cliente_id` tarda 17.212 ms
// contra un `statement_timeout` de 8 s, porque los dos índices que ordenan por
// fecha empiezan por `cliente_id`. La estimación tarda 948 ms y se desvía 56
// filas de 92.033. Si alguien vuelve a poner 'exact' a secas, la página deja de
// cargar sin cliente elegido.
check(
  'el conteo es estimado cuando no hay cliente',
  /const conteo = f\.clienteId \? 'exact' : 'estimated';/.test(fuentePagina)
);
check('y el total se marca como aproximado', /\(aprox\.\)/.test(fuentePagina));
// Y mientras la 088 no esté aplicada, el timeout se explica en vez de enseñar
// «canceling statement due to statement timeout» en crudo.
check('un timeout sin cliente se explica', /timeoutSinCliente/.test(fuentePagina));

const mig088 = readFileSync('migrations/088_leads_orden_global.sql', 'utf8');
check(
  'la 088 crea el índice de orden global',
  /idx_rutm_lead_events_created_at[\s\S]{0,120}\(created_at DESC\)/.test(mig088)
);
// Un CREATE INDEX normal bloquea los INSERT de leads con `lock_timeout = 8s`:
// la cabecera tiene que decirlo, como la de la 086.
check('y avisa de que no se aplica a pelo', /CONCURRENTLY/.test(mig088));
// Y cuando no se lanza, lo dice: un vacío sin explicación se confunde con «no
// hay leads», que es justo lo contrario de lo que pasa.
check('y explica cuándo no la lanza', /sinAcotar &&/.test(fuentePagina));

const fuenteExport = readFileSync(EXPORT, 'utf8');
check('el CSV fecha en hora Colombia', /colombiaDateTimeOf\(/.test(fuenteExport));
check('y ya escribe el motivo de exclusión', /Motivo de exclusión/.test(fuenteExport));

// ════════════════════════════════════════════════════════════════════
// 8. El SQL y el TypeScript no pueden separarse
// ════════════════════════════════════════════════════════════════════
//
// Si el buscador mira una columna que la migración no indexó, vuelve el seq scan
// de 171 MB y nadie se entera: sigue dando los resultados correctos.
console.log('\n8. La migración 086 indexa lo que el buscador mira');

const migracion = readFileSync('migrations/086_busqueda_leads.sql', 'utf8');
check('la 086 instala pg_trgm', /CREATE EXTENSION IF NOT EXISTS pg_trgm/.test(migracion));
check('en el esquema extensions', /WITH SCHEMA extensions/.test(migracion));
for (const col of COLUMNAS_BUSQUEDA) {
  check(
    `la 086 indexa ${col}`,
    new RegExp(`gin \\(${col} extensions.gin_trgm_ops\\)`).test(migracion)
  );
}
// `WITH (...)` y no la palabra suelta: la cabecera explica el porqué y también la
// menciona.
check(
  'con fastupdate apagado en los tres',
  (migracion.match(/WITH \(fastupdate = off\)/g) ?? []).length === COLUMNAS_BUSQUEDA.length
);
check('y avisa de que bloquea escrituras', /lock_timeout/.test(migracion));

// Los motivos que enseña la pestaña son los que define la regla, no una lista
// paralela escrita en el componente.
const motivosBar = readFileSync('src/components/report-utm/LeadsMotivosBar.tsx', 'utf8');
for (const m of Object.keys(MOTIVOS_EXCLUSION)) {
  check(`el desglose conoce «${m}»`, motivosBar.includes(m));
}

// ── Cierre ───────────────────────────────────────────────────────────
if (fallos > 0) {
  console.log(`\n❌ ${fallos} comprobación(es) fallaron\n`);
  process.exit(1);
}
console.log('\n✅ Filtros y buscador de leads: todas las comprobaciones pasan\n');
