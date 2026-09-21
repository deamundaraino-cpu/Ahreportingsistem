/**
 * Comprobaciones del buscador de leads contra la base real (migración 086).
 *
 * El buscador funciona con o sin los índices: sin ellos devuelve lo mismo, solo
 * que recorriendo la tabla entera. Ese es justamente el problema — un fallo que
 * no se nota mirando la pantalla.
 *
 * Medido el 2026-09-21: `lead_events` son 171 MB contra 224 MB de
 * `shared_buffers`. Una búsqueda sin índice lee la tabla entera y desaloja casi
 * toda la caché, que es el modo de fallo de la caída del 2026-09-20. Por eso esto
 * se comprueba, y por eso se comprueba `indisvalid`: un CREATE INDEX CONCURRENTLY
 * cortado a medias deja un índice que penaliza cada INSERT y no sirve para leer.
 *
 *   npx tsx --conditions=react-server scripts/verify-busqueda-leads-db.ts
 */

import { config as loadEnv } from 'dotenv';
import { sqlRemoto } from './sql-remoto';
import { salir } from './_salida';
import {
  leerFiltros,
  aplicarFiltrosLeads,
  COLUMNAS_BUSQUEDA,
} from '../src/lib/report-utm/leads-filtros';

loadEnv({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

/** Presupuesto de la 086: 12-20 MB estimados. Que se desmadre tiene que avisar. */
const TOPE_MB = 40;

const INDICES: Record<(typeof COLUMNAS_BUSQUEDA)[number], string> = {
  lead_name: 'idx_rutm_lead_events_nombre_trgm',
  lead_email: 'idx_rutm_lead_events_email_trgm',
  lead_phone: 'idx_rutm_lead_events_tel_trgm',
};

// Término inventado a propósito: el EXPLAIN no ejecuta nada, pero que no coincida
// con nadie deja claro que esto no lee datos de ningún cliente.
const TERMINO = 'zzqxvw';

/**
 * ¿PostgREST acepta la cadena `or` que genera el buscador?
 *
 * Es la comprobación que no se puede hacer en puro: el escape es correcto sobre
 * el papel, pero quien decide es el parser del servidor. Y sus dos formas de
 * fallar son distintas — una coma sin comillas da un 400 PGRST100 (ruidoso) y una
 * comilla sin escapar da un 200 con resultados distintos (silencioso).
 *
 * Se acota a un cliente y a un rango de 2020 a propósito: así entra por
 * `idx_rutm_lead_events_cliente (cliente_id, created_at DESC)`, devuelve cero
 * filas al instante y no cuesta nada. Lo que se prueba es la GRAMÁTICA, no los
 * datos — por eso da igual que no encuentre nada.
 */
async function probarGramatica(clienteId: string) {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const db = (await createAdminClient()).schema('report_utm');

  // Cada uno rompía la cadena de una manera distinta antes de escaparlo.
  const TERMINOS = [
    ['normal', 'ana'],
    ['con coma', 'garcia, juan'],
    ['con comilla', 'a"b'],
    ['con porcentaje', '100%'],
    ['con guion bajo', 'a_b'],
    ['con barra', String.raw`C:\x`],
    ['con paréntesis', 'form (v2)'],
    ['con punto de email', 'juan.perez@dominio.com'],
    ['con teléfono', '+57 300 123 4567'],
  ] as const;

  for (const [etiqueta, termino] of TERMINOS) {
    const f = leerFiltros({
      clienteId,
      q: termino,
      from: '2020-01-01',
      to: '2020-01-02',
    });
    const { error } = await aplicarFiltrosLeads(db.from('lead_events').select('id'), f, {
      conExclusion: true,
      conEstado: true,
    }).limit(1);

    check(
      `PostgREST acepta «${etiqueta}»`,
      !error,
      error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : undefined
    );
  }
}

async function main() {
  console.log('\n── Buscador de leads: la cadena `or` contra el servidor ───');

  const clientes = await sqlRemoto<{ id: string }>(
    'SELECT id FROM report_utm.clientes ORDER BY nombre LIMIT 1'
  );
  if (clientes.length === 0) {
    console.log('  ⏳ No hay clientes en report_utm: no se puede probar la gramática.');
  } else {
    await probarGramatica(clientes[0].id);
  }

  console.log('\n── Índices de la migración 086 ───────────────────────────');

  // ── 1. La extensión ────────────────────────────────────────────────
  const ext = await sqlRemoto<{ extname: string; esquema: string }>(`
    SELECT e.extname, n.nspname AS esquema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm'
  `);

  if (ext.length === 0) {
    console.log('\n  ⏳ PENDIENTE: la migración 086 todavía no está aplicada.');
    console.log('     `pg_trgm` no está instalado, así que el buscador funciona');
    console.log('     pero recorre los 171 MB de la tabla en cada consulta.');
    console.log('\n     Para aplicarla sin bloquear escrituras:');
    console.log('       npx tsx scripts/crear-indices-busqueda.ts\n');

    // Deja medida la línea base, que es el argumento para aplicarla.
    await explicar('sin índices (línea base)');
    console.log(
      fallos === 0
        ? '\n⏳ La gramática de la búsqueda pasa; los índices de la 086, pendientes.\n'
        : `\n❌ ${fallos} comprobación(es) fallaron\n`
    );
    salir(fallos);
    return;
  }

  check('pg_trgm está instalado', true);
  check('y vive en el esquema `extensions`', ext[0].esquema === 'extensions', ext[0].esquema);

  // ── 2. Los índices ─────────────────────────────────────────────────
  console.log('\n── Los tres índices ──────────────────────────────────────');

  const filas = await sqlRemoto<{
    nombre: string;
    metodo: string;
    valido: boolean;
    bytes: number;
    tamano: string;
  }>(`
    SELECT c.relname                        AS nombre,
           am.amname                        AS metodo,
           i.indisvalid                     AS valido,
           pg_relation_size(c.oid)          AS bytes,
           pg_size_pretty(pg_relation_size(c.oid)) AS tamano
      FROM pg_class c
      JOIN pg_index i     ON i.indexrelid = c.oid
      JOIN pg_am am       ON am.oid = c.relam
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'report_utm'
       AND c.relname IN (${Object.values(INDICES)
         .map((v) => `'${v}'`)
         .join(', ')})
  `);

  const porNombre = new Map(filas.map((f) => [f.nombre, f]));

  for (const col of COLUMNAS_BUSQUEDA) {
    const nombre = INDICES[col];
    const idx = porNombre.get(nombre);
    check(`${col}: existe ${nombre}`, idx !== undefined);
    if (!idx) continue;
    check(`${col}: es un GIN`, idx.metodo === 'gin', idx.metodo);
    // La que caza un CONCURRENTLY a medias: el fallo silencioso más caro.
    check(`${col}: indisvalid = true`, idx.valido === true, 'build cortado, hay que rehacerlo');
    console.log(`      ${nombre}: ${idx.tamano}`);
  }

  const totalMb = filas.reduce((a, f) => a + Number(f.bytes), 0) / 1024 / 1024;
  check(
    `los tres suman menos de ${TOPE_MB} MB`,
    totalMb < TOPE_MB,
    `suman ${totalMb.toFixed(1)} MB`
  );

  // ── 3. El plan de la consulta real ─────────────────────────────────
  console.log('\n── El plan que sale ──────────────────────────────────────');
  const plan = await explicar('con índices');

  check('usa un Bitmap sobre los índices', /Bitmap/i.test(plan), primeraLinea(plan));
  check(
    'y ya no recorre la tabla entera',
    !/Seq Scan on lead_events/i.test(plan),
    primeraLinea(plan)
  );

  console.log(
    fallos === 0
      ? '\n✅ Buscador de leads: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  salir(fallos);
}

/** EXPLAIN (sin ANALYZE: no ejecuta la consulta) de la búsqueda que manda la app. */
async function explicar(etiqueta: string): Promise<string> {
  const sql = `
    EXPLAIN SELECT id FROM report_utm.lead_events
     WHERE excluido = false
       AND (${COLUMNAS_BUSQUEDA.map((c) => `${c} ILIKE '%${TERMINO}%'`).join(' OR ')})
     ORDER BY created_at DESC
     LIMIT 25
  `;
  const filas = await sqlRemoto<Record<string, string>>(sql);
  const plan = filas.map((f) => Object.values(f)[0]).join('\n');
  const coste = plan.match(/cost=[\d.]+\.\.([\d.]+)/)?.[1];
  console.log(`  · plan ${etiqueta}${coste ? ` — coste ${coste}` : ''}`);
  for (const linea of plan.split('\n').slice(0, 6)) console.log(`      ${linea}`);
  return plan;
}

function primeraLinea(plan: string): string {
  return plan.split('\n')[0]?.trim() ?? '';
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
