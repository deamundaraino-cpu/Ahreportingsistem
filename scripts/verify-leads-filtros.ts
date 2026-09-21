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
  urlExport,
  urlLeads,
  COLUMNAS_BUSQUEDA,
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
  utm_campaign: 'campaña',
  utm_content: 'creativo',
  form_name: 'contacto',
  attribution_method: 'click_id',
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
    'eq:cliente_id eq:form_plugin eq:attribution_method ilike:utm_source ilike:utm_campaign ' +
      'ilike:utm_content ilike:form_name gte:created_at lt:created_at or: eq:excluido eq:excluido_motivo',
  clave(completa)
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
// 7. Antidivergencia: nadie más escribe filtros
// ════════════════════════════════════════════════════════════════════
//
// Esta es la comprobación que impide que el fallo vuelva. Si alguien añade un
// `.ilike()` suelto a la página o al export, la copia de filtros renace.
console.log('\n7. Ni la página ni el export tienen filtros propios');

const PAGINA = 'src/app/(app)/leads/page.tsx';
const EXPORT = 'src/app/api/report-utm/leads/export/route.ts';

for (const ruta of [PAGINA, EXPORT]) {
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
for (const p of PARAMS_LEADS) {
  if (p === 'page') continue; // la paginación son enlaces, no un input
  check(`el formulario conserva «${p}»`, fuentePagina.includes(`name="${p}"`));
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
check('la página pinta el error de la consulta', /resPagina\.error/.test(fuentePagina));

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
