/**
 * Guardián del borrado en cascada, contra la base real (solo lecturas).
 *
 * Regla del 2026-09-14: eliminar un cliente borra TODOS sus datos. La garantía
 * vive en las FK, así que se comprueba en el catálogo de Postgres después de
 * cada migración: una tabla nueva con `cliente_id` sin FK en cascada rompe este
 * test en vez de dejar huérfanos en silencio.
 *
 *   1. Todo lo que cuelga (directa o indirectamente) de `public.clientes` o de
 *      `report_utm.clientes` cae en CASCADE. Los SET NULL de segundo nivel que
 *      no dejan restos van en lista blanca, y la fila tiene que caer igualmente
 *      por otra FK en cascada.
 *   2. Ninguna columna con «client» en el nombre queda sin FK, salvo el array
 *      `agent_contacts.client_scope`, que lo cubre el código.
 *   3. Borrar un usuario no borra clientes: `clientes.user_id` es RESTRICT
 *      (migración 081).
 *
 *   npx tsx --conditions=react-server scripts/verify-borrado-cascada.ts
 */

import { sqlRemoto } from './sql-remoto';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

/** SET NULL que no dejan nada: la fila hija cae por su propio `cliente_id`. */
const SET_NULL_INOCUOS = new Set([
  'public.hotmart_ventas.tab_id',
  'public.sync_runs.job_id',
  'report_utm.outbound_deliveries.sale_event_id',
  'report_utm.pixel_events.link_id',
]);

/** Columnas de cliente que no admiten FK y cubre el código. */
const SIN_FK_PERMITIDAS = new Set(['public.agent_contacts.client_scope']);

type Arista = { hija: string; madre: string; cols: string; del: string; conname: string };

const NOMBRE = (oid: string) =>
  `(select n.nspname||'.'||r.relname from pg_class r join pg_namespace n on n.oid = r.relnamespace where r.oid = ${oid})`;

async function main() {
  console.log('\n1. Todo lo que cuelga de un cliente cae en cascada');
  const aristas = await sqlRemoto<Arista>(`
    with recursive fks as (
      select c.conrelid as child, c.confrelid as parent, c.confdeltype as del, c.conname,
        (select string_agg(a.attname, ',') from unnest(c.conkey) k
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) as cols
      from pg_constraint c where c.contype = 'f'
    ), walk as (
      select child, parent, del, conname, cols, 1 as depth from fks
       where parent in ('public.clientes'::regclass, 'report_utm.clientes'::regclass)
      union
      select f.child, f.parent, f.del, f.conname, f.cols, w.depth + 1
        from fks f join walk w on f.parent = w.child where w.depth < 8
    )
    select distinct ${NOMBRE('w.child')} as hija, ${NOMBRE('w.parent')} as madre,
           w.cols, w.del::text as del, w.conname
      from walk w`);

  check('hay FK hacia los clientes (la consulta ve el catálogo)', aristas.length > 20);

  const malas = aristas.filter(
    (a) => a.del !== 'c' && !SET_NULL_INOCUOS.has(`${a.hija}.${a.cols}`)
  );
  check(
    'ninguna FK de la cadena es SET NULL / NO ACTION / RESTRICT fuera de la lista blanca',
    malas.length === 0,
    malas.map((a) => `${a.hija}(${a.cols}) → ${a.madre}: ${a.del}`).join('; ')
  );

  const hijas = [...new Set(aristas.map((a) => a.hija))];
  const sinCascada = hijas.filter((h) => !aristas.some((a) => a.hija === h && a.del === 'c'));
  check(
    'toda tabla alcanzada cae por al menos una FK en cascada',
    sinCascada.length === 0,
    sinCascada.join(', ')
  );

  const espejo = aristas.find(
    (a) => a.hija === 'report_utm.clientes' && a.cols === 'public_cliente_id'
  );
  check('el espejo UTM cae con su cliente del reporting', espejo?.del === 'c');

  console.log('\n2. Ninguna columna de cliente sin FK');
  const sueltas = await sqlRemoto<{ col: string }>(`
    select n.nspname||'.'||c.relname||'.'||a.attname as col
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'report_utm') and c.relkind in ('r', 'p')
       and a.attnum > 0 and not a.attisdropped and a.attname ~* 'client'
       and not exists (select 1 from pg_constraint k
                        where k.conrelid = c.oid and k.contype = 'f' and a.attnum = any(k.conkey))`);
  const inesperadas = sueltas.map((s) => s.col).filter((c) => !SIN_FK_PERMITIDAS.has(c));
  check(
    'toda columna «client…» tiene FK (salvo agent_contacts.client_scope)',
    inesperadas.length === 0,
    inesperadas.join(', ')
  );

  console.log('\n3. Borrar un usuario no borra clientes');
  const [duenio] = await sqlRemoto<{ del: string }>(`
    select confdeltype::text as del from pg_constraint
     where conrelid = 'public.clientes'::regclass and conname = 'clientes_user_id_fkey'`);
  check(
    'clientes.user_id → auth.users es RESTRICT (migración 081)',
    duenio?.del === 'r',
    `confdeltype = ${duenio?.del ?? 'sin FK'}`
  );

  console.log(fallos === 0 ? '\n✓ TODO OK\n' : `\n✗ ${fallos} fallo(s)\n`);
  salir(fallos);
}

main().catch((e) => {
  console.error('\n✗ Fallo del arnés:', e instanceof Error ? e.message : e);
  process.exit(1);
});
