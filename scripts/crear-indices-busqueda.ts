/**
 * Crea los índices de búsqueda de leads SIN bloquear las escrituras.
 *
 *   npx tsx scripts/crear-indices-busqueda.ts
 *   npx tsx scripts/crear-indices-busqueda.ts --estado    (solo mira, no crea)
 *
 * ── Por qué no basta con aplicar la migración 086 ────────────────────
 * `CREATE INDEX` normal toma un lock SHARE, que bloquea INSERT/UPDATE/DELETE. Y
 * el rol `authenticator` de este proyecto tiene `lock_timeout = 8s`, así que los
 * INSERT de leads que lleguen durante el build NO se encolan: **fallan**. Un
 * webhook de lead que devuelve 500 y no se reintenta es un lead perdido.
 *
 * `CREATE INDEX CONCURRENTLY` toma SHARE UPDATE EXCLUSIVE, que no molesta al
 * tráfico normal. A cambio no puede correr dentro de un bloque de transacción
 * (error 25001), y `scripts/sql-remoto.ts` manda el archivo entero como una
 * transacción implícita. Pero la restricción es por BLOQUE: una petición con UNA
 * sola sentencia no lo es. De ahí este script — un envío por índice.
 *
 * ── Las tres trampas del camino CONCURRENTLY ─────────────────────────
 *  1. Si falla o se corta, deja un índice con `indisvalid = false` que sigue
 *     costando en cada INSERT y no sirve para leer. Hay que tirarlo antes de
 *     reintentar, y este script lo hace solo.
 *  2. La Management API tiene su propio timeout HTTP y puede cortar la conexión
 *     MIENTRAS el índice se sigue construyendo en el servidor. Por eso no nos
 *     fiamos de la respuesta HTTP: se sondea `pg_index.indisvalid`.
 *  3. Dos CONCURRENTLY sobre la misma tabla se bloquean entre sí
 *     (SHARE UPDATE EXCLUSIVE es autoexcluyente), así que van uno detrás de otro.
 *
 * Es idempotente: un índice ya válido se salta. Repetirlo es gratis.
 */

import { sqlRemoto } from './sql-remoto';

type Indice = { nombre: string; sql: string };

// Mismas definiciones que migrations/086_busqueda_leads.sql, con CONCURRENTLY.
const INDICES: Indice[] = [
  {
    nombre: 'idx_rutm_lead_events_nombre_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rutm_lead_events_nombre_trgm ON report_utm.lead_events USING gin (lead_name extensions.gin_trgm_ops) WITH (fastupdate = off)`,
  },
  {
    nombre: 'idx_rutm_lead_events_email_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rutm_lead_events_email_trgm ON report_utm.lead_events USING gin (lead_email extensions.gin_trgm_ops) WITH (fastupdate = off)`,
  },
  {
    nombre: 'idx_rutm_lead_events_tel_trgm',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rutm_lead_events_tel_trgm ON report_utm.lead_events USING gin (lead_phone extensions.gin_trgm_ops) WITH (fastupdate = off) WHERE lead_phone IS NOT NULL`,
  },
];

const ESPERA_MS = 10_000;
const INTENTOS_SONDEO = 60; // 10 min por índice

type EstadoIndice = { existe: boolean; valido: boolean; tamano: string | null };

async function estado(nombre: string): Promise<EstadoIndice> {
  const filas = await sqlRemoto<{ indisvalid: boolean; tamano: string }>(`
    SELECT i.indisvalid,
           pg_size_pretty(pg_relation_size(c.oid)) AS tamano
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'report_utm' AND c.relname = '${nombre}'
  `);
  if (filas.length === 0) return { existe: false, valido: false, tamano: null };
  return { existe: true, valido: filas[0].indisvalid === true, tamano: filas[0].tamano };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a que el índice quede válido. Devuelve false si se agota la paciencia. */
async function esperarValido(nombre: string): Promise<boolean> {
  for (let i = 0; i < INTENTOS_SONDEO; i++) {
    const e = await estado(nombre);
    if (e.existe && e.valido) return true;
    await dormir(ESPERA_MS);
  }
  return false;
}

async function crear(idx: Indice): Promise<boolean> {
  const inicial = await estado(idx.nombre);

  if (inicial.existe && inicial.valido) {
    console.log(`  ✓ ${idx.nombre} — ya existe y es válido (${inicial.tamano})`);
    return true;
  }

  // Un índice a medias penaliza cada INSERT y no sirve para leer. Fuera.
  if (inicial.existe && !inicial.valido) {
    console.log(`  ⚠ ${idx.nombre} — existe pero INVÁLIDO (build cortado). Lo elimino.`);
    await sqlRemoto(`DROP INDEX CONCURRENTLY IF EXISTS report_utm.${idx.nombre}`);
  }

  console.log(`  · ${idx.nombre} — construyendo (no bloquea escrituras)…`);
  try {
    await sqlRemoto(idx.sql);
  } catch (e) {
    // La Management API puede cortar por timeout mientras el servidor sigue
    // trabajando: no es concluyente, decide el sondeo.
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    (la petición terminó con «${msg.slice(0, 120)}»; compruebo el estado real)`);
  }

  const ok = await esperarValido(idx.nombre);
  const fin = await estado(idx.nombre);
  if (ok) {
    console.log(`  ✓ ${idx.nombre} — listo (${fin.tamano})`);
    return true;
  }
  console.log(
    `  ✗ ${idx.nombre} — sigue sin ser válido tras ${(INTENTOS_SONDEO * ESPERA_MS) / 60000} min.`
  );
  console.log('    Puede seguir construyéndose. Vuelve a lanzar el script con --estado.');
  return false;
}

async function main() {
  const soloEstado = process.argv.includes('--estado');

  console.log('\n── Índices de búsqueda de leads (migración 086) ───────────');

  if (soloEstado) {
    for (const idx of INDICES) {
      const e = await estado(idx.nombre);
      const etiqueta = !e.existe
        ? 'no existe'
        : e.valido
          ? `válido (${e.tamano})`
          : `INVÁLIDO (${e.tamano})`;
      console.log(`  · ${idx.nombre}: ${etiqueta}`);
    }
    return;
  }

  // La extensión sí cabe en una transacción, así que va por la vía normal.
  console.log('  · pg_trgm…');
  await sqlRemoto('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions');

  // Uno detrás de otro: dos CONCURRENTLY sobre la misma tabla se bloquean.
  let fallos = 0;
  for (const idx of INDICES) {
    if (!(await crear(idx))) fallos++;
  }

  // Un índice nuevo sin estadísticas frescas puede no llegar a usarse (es lo que
  // diagnosticó la 085). ANALYZE no bloquea y es barato.
  console.log('  · ANALYZE report_utm.lead_events…');
  await sqlRemoto('ANALYZE report_utm.lead_events');

  if (fallos > 0) {
    console.log(`\n❌ ${fallos} índice(s) sin confirmar.\n`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✅ Índices de búsqueda listos.');
  console.log('   La migración 086 ya es un no-op: commitéala igual, es la fuente de verdad.\n');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
