/**
 * Los filtros de /leads contra PostgREST de verdad.
 *
 * `verify-leads-filtros.ts` demuestra qué consulta se GENERA, pero no que el
 * servidor la entienda ni que signifique lo que creemos. Esa diferencia ya costó
 * cara una vez: `nombre=ilike."%a%"` devuelve 200 con CERO filas en vez de un
 * 400, así que un escape mal puesto se ve igual que «no hay resultados».
 *
 * Lo que se comprueba aquí y no se puede comprobar en puro:
 *
 *   1. La PARTICIÓN de la presencia: `vacío` + `con valor` == total, por
 *      columna. Es lo que caza la trampa de NULL de un plumazo — si «no es X»
 *      se dejara fuera los NULL, los dos lados no sumarían el total.
 *   2. Que el vacío siga siendo NULL puro. La tabla medida el 2026-09-21 da
 *      CERO cadenas vacías en las ocho columnas, y `leads-filtros.ts` construye
 *      el filtro DANDO ESO POR HECHO. Si una ingesta empieza a escribir `''`,
 *      el filtro deja de encontrarlas y nadie se entera: aquí falla.
 *   3. Que el árbol `or=(and(…))` lo parsee PostgREST y signifique Y, no O.
 *   4. Que el filtro por `raw_fields->>clave` funcione con claves reales, que
 *      llevan espacios y mayúsculas.
 *   5. Que nada de esto se acerque al `statement_timeout` de 8 s.
 *
 *   npx tsx --conditions=react-server scripts/verify-leads-filtros-db.ts
 */

import { config as loadEnv } from 'dotenv';
import { salir } from './_salida';
loadEnv({ path: '.env.local' });

import {
  leerFiltros,
  aplicarFiltrosLeads,
  CAMPOS_FILTRABLES,
} from '../src/lib/report-utm/leads-filtros';

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

// Rango CERRADO: con uno que llegue a hoy entran leads durante la prueba y los
// totales dejan de cuadrar entre una consulta y la siguiente.
const DESDE = '2026-07-01';
const HASTA = '2026-07-31';
/** Margen sobre el `statement_timeout` de 8 s. */
const PRESUPUESTO_MS = 6000;

const SIN_FILTROS = { conExclusion: false, conEstado: false };

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const db = await createAdminClient();

  const base = () => db.schema('report_utm').from('lead_events');
  const contar = (f: ReturnType<typeof leerFiltros>) =>
    aplicarFiltrosLeads(base().select('id', { count: 'exact', head: true }), f, SIN_FILTROS);

  /**
   * Un `statement_timeout` de PostgREST llega como un error con `message: ''`.
   *
   * Sin distinguirlo, un timeout se presentaba como «la partición no cuadra»,
   * que es una acusación de corrección sobre un fallo de capacidad. Y esta
   * instancia es una Micro de 1 GB: la PRIMERA consulta de la serie, con la
   * caché recién desalojada por el resto de la suite, se pasa de los 8 s de vez
   * en cuando y las siguientes van a 200 ms.
   *
   * De ahí un reintento —uno, no un bucle— y un mensaje que dice qué pasó. Lo
   * que NO se hace es tragarse el fallo: si el segundo intento también se pasa,
   * el check falla y lo dice con esas palabras.
   */
  const esTimeout = (e: { message: string } | null) => !!e && e.message === '';

  async function contarFiable(
    f: ReturnType<typeof leerFiltros>
  ): Promise<{ count: number | null; error: { message: string } | null }> {
    const r1 = await contar(f);
    if (!esTimeout(r1.error)) return r1;
    const r2 = await contar(f);
    if (esTimeout(r2.error)) {
      return { count: null, error: { message: 'statement timeout (dos intentos)' } };
    }
    return r2;
  }

  // El cliente con más leads en el rango: es el que puede reventar el
  // presupuesto y el que tiene más variedad de valores.
  const { data: csRaw } = await db.schema('report_utm').from('clientes').select('id,nombre');
  const clientes = (csRaw ?? []) as Array<{ id: string; nombre: string }>;
  if (clientes.length === 0) {
    console.error('No hay clientes: no se puede verificar nada.');
    process.exit(1);
  }

  let cliente = clientes[0];
  let maxLeads = -1;
  for (const c of clientes) {
    const { count } = await contar(leerFiltros({ clienteId: c.id, from: DESDE, to: HASTA }));
    if ((count ?? 0) > maxLeads) {
      maxLeads = count ?? 0;
      cliente = c;
    }
  }
  const CL = cliente.id;
  console.log(
    `\nCliente de prueba: ${cliente.nombre} — ${maxLeads} leads entre ${DESDE} y ${HASTA}`
  );
  if (maxLeads === 0) {
    console.error('Ese rango no tiene leads en ningún cliente: ajusta DESDE/HASTA.');
    process.exit(1);
  }

  const fBase = { clienteId: CL, from: DESDE, to: HASTA };
  const { count: total } = await contar(leerFiltros(fBase));

  // ── 1. Partición de la presencia ───────────────────────────────────
  seccion('Presencia: vacío + con valor == total');

  for (const campo of CAMPOS_FILTRABLES) {
    const { count: vacios, error: e1 } = await contarFiable(leerFiltros({ ...fBase, sin: campo }));
    const { count: conDato, error: e2 } = await contarFiable(leerFiltros({ ...fBase, con: campo }));
    if (e1 || e2) {
      // Un fallo de capacidad no es un fallo de corrección: se dice cuál es.
      check(`«${campo}» particiona el total`, false, `consulta fallida: ${(e1 ?? e2)!.message}`);
      continue;
    }
    check(
      `«${campo}» particiona el total (${vacios} vacíos + ${conDato} con dato = ${total})`,
      (vacios ?? 0) + (conDato ?? 0) === (total ?? 0),
      `${(vacios ?? 0) + (conDato ?? 0)} ≠ ${total}`
    );
  }

  // ── 2. El vacío sigue siendo NULL puro ─────────────────────────────
  seccion('El vacío es NULL, no cadena vacía');

  // `leads-filtros.ts` construye «vacío» como un `.is(col, null)` a secas
  // PORQUE está medido que no hay cadenas vacías. Si aparecen, ese filtro deja
  // de encontrarlas y la partición de arriba se rompería sin decir por qué.
  // Acotado por cliente Y rango, igual que exige `faltaAcotarFiltrosCaros`.
  // Sin el rango esto mismo se pasaba de los 8 s en las columnas sin índice y
  // PostgREST devolvía un error con `message: ""` — o sea, el script se saltaba
  // su propio guardarraíl y luego no sabía decir por qué había fallado.
  for (const campo of CAMPOS_FILTRABLES) {
    const { count: cadenas, error } = await aplicarFiltrosLeads(
      base().select('id', { count: 'exact', head: true }),
      leerFiltros(fBase),
      SIN_FILTROS
    ).eq(campo, '');
    check(
      `«${campo}» no tiene cadenas vacías`,
      !error && (cadenas ?? 0) === 0,
      error
        ? `consulta fallida: ${error.message || '(sin mensaje: statement timeout)'}`
        : `${cadenas} filas con ''`
    );
  }

  // ── 3. El árbol: or=(and(…)) significa Y ───────────────────────────
  seccion('El árbol lógico lo parsea PostgREST y significa Y');

  // Dos valores del mismo campo: el multi-valor tiene que ser la SUMA de los
  // dos por separado (son disjuntos, un lead tiene un solo utm_source).
  const { data: fuentes } = await base()
    .select('utm_source')
    .eq('cliente_id', CL)
    .not('utm_source', 'is', null)
    .limit(400);
  const distintas = [...new Set((fuentes ?? []).map((r) => r.utm_source as string))].slice(0, 2);

  if (distintas.length === 2) {
    const [a, b] = distintas;
    const solo = async (v: string) =>
      (await contar(leerFiltros({ ...fBase, utm_source: `eq:${v.replace(/,/g, '\\,')}` }))).count ??
      0;
    const na = await solo(a);
    const nb = await solo(b);
    const sel = [a, b].map((v) => v.replace(/,/g, '\\,')).join(',');
    const { count: juntos, error } = await contar(
      leerFiltros({ ...fBase, utm_source: `eq:${sel}` })
    );
    check(
      `multi-valor suma los dos (${na} + ${nb} = ${juntos})`,
      !error && (juntos ?? 0) === na + nb,
      error ? error.message : `${juntos} ≠ ${na + nb}`
    );

    // Y con el buscador puesto, los dos nodos van bajo un `and(…)`: el
    // resultado NO puede ser mayor que el del filtro solo. Si PostgREST lo
    // interpretara como O, sería mayor.
    const { count: conBusqueda, error: eB } = await contar(
      leerFiltros({ ...fBase, utm_source: `eq:${sel}`, q: 'mar' })
    );
    check(
      `el and() restringe, no amplía (${conBusqueda} ≤ ${juntos})`,
      !eB && (conBusqueda ?? 0) <= (juntos ?? 0),
      eB ? eB.message : `${conBusqueda} > ${juntos}`
    );
  } else {
    check('hay al menos dos fuentes distintas para probar el árbol', false, 'datos insuficientes');
  }

  // Un `neq` tiene que incluir los NULL: es la trampa que más cuesta ver.
  if (distintas.length >= 1) {
    const v = distintas[0];
    const esc = v.replace(/,/g, '\\,');
    const { count: noEs } = await contar(leerFiltros({ ...fBase, utm_source: `neq:${esc}` }));
    const { count: es } = await contar(leerFiltros({ ...fBase, utm_source: `eq:${esc}` }));
    check(
      `«no es X» + «es X» cubre el total (${noEs} + ${es} = ${total})`,
      (noEs ?? 0) + (es ?? 0) === (total ?? 0),
      `${(noEs ?? 0) + (es ?? 0)} ≠ ${total} — ¿se están perdiendo los NULL?`
    );
  }

  // ── 4. Respuesta de formulario con claves reales ───────────────────
  seccion('raw_fields con claves reales');

  const { data: muestras } = await base()
    .select('raw_fields')
    .eq('cliente_id', CL)
    .not('raw_fields', 'is', null)
    .limit(50);
  const claves = new Set<string>();
  for (const r of muestras ?? []) {
    for (const k of Object.keys((r.raw_fields ?? {}) as Record<string, unknown>)) claves.add(k);
  }
  // Interesa la clave más incómoda: la que lleva espacios o mayúsculas.
  const clave =
    [...claves].find((k) => /[A-Z\s]/.test(k) && !/[(),."\\]/.test(k)) ??
    [...claves].find((k) => !/[(),."\\]/.test(k));

  if (clave) {
    const { count: conRespuesta, error } = await contar(
      leerFiltros({ ...fBase, campo: clave, campo_valor: 'ncontains:zzzz-imposible' })
    );
    check(
      `se puede filtrar por «${clave}»`,
      !error,
      error ? error.message : `${conRespuesta} filas`
    );
  } else {
    check('hay alguna clave de raw_fields para probar', false, 'ninguna clave utilizable');
  }

  // ── 5. Presupuesto de tiempo ───────────────────────────────────────
  seccion('Nada se acerca al statement_timeout de 8 s');

  const cronometrar = async (nombre: string, f: ReturnType<typeof leerFiltros>) => {
    const t0 = Date.now();
    const { error } = await contar(f);
    const ms = Date.now() - t0;
    check(`${nombre} — ${ms} ms`, !error && ms < PRESUPUESTO_MS, error?.message ?? `${ms} ms`);
  };

  await cronometrar('presencia', leerFiltros({ ...fBase, sin: 'utm_source' }));
  await cronometrar(
    'presencia múltiple',
    leerFiltros({ ...fBase, sin: 'utm_source,utm_campaign', con: 'form_name' })
  );
  await cronometrar(
    'búsqueda + multi-valor',
    leerFiltros({ ...fBase, q: 'mar', utm_source: 'eq:a,b' })
  );
  if (clave) {
    await cronometrar(
      'respuesta de formulario',
      leerFiltros({ ...fBase, campo: clave, campo_valor: 'contains:a' })
    );
  }

  // ── Cierre ─────────────────────────────────────────────────────────
  console.log(
    fallos === 0
      ? '\n✅ Filtros de leads contra la base: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
