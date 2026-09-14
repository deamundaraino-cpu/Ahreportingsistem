/**
 * Borra los clientes de Report-UTM que perdieron su cliente del reporting
 * (`public_cliente_id` NULL) con TODOS sus datos: leads, ventas, integraciones,
 * mapeos, campos de lead, informes BI y logo.
 *
 * Es la limpieza que pide la regla del 2026-09-14 («eliminar un cliente borra
 * todo») para los huérfanos que dejó la FK `SET NULL` antes de la migración 080.
 * Usa la misma función que el botón «Eliminar» de /report-utm/clientes.
 *
 * No se puede deshacer. Sin `--apply` solo lista lo que borraría; `--ids=a,b`
 * limita el borrado a esos clientes.
 *
 *   npx tsx scripts/borrar-clientes-huerfanos.ts
 *   npx tsx scripts/borrar-clientes-huerfanos.ts --ids=<uuid>,<uuid> --apply
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { eliminarClienteUtm } from '../src/lib/clientes/ciclo-de-vida';

loadEnv({ path: '.env.local' });

const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const IDS = (args.find((a) => a.startsWith('--ids='))?.slice(6) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(url, key);
  const rtm = db.schema('report_utm');

  let q = rtm
    .from('clientes')
    .select('id, nombre, status, created_at')
    .is('public_cliente_id', null);
  if (IDS.length > 0) q = q.in('id', IDS);
  const { data: huerfanos, error } = await q.order('nombre');
  if (error) throw new Error(error.message);
  if (!huerfanos?.length) {
    console.log('\nNo hay clientes huérfanos que borrar.\n');
    return;
  }

  const contar = async (tabla: string, id: string, esquema: 'report_utm' | 'public') => {
    const base = esquema === 'report_utm' ? rtm : db;
    const { count } = await base
      .from(tabla)
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', id);
    return count ?? 0;
  };

  console.log(`\n${huerfanos.length} cliente(s) huérfano(s)${APLICAR ? '' : '   [SIMULACIÓN]'}\n`);
  for (const h of huerfanos) {
    const [leads, ventas, integraciones, informes] = await Promise.all([
      contar('lead_events', h.id, 'report_utm'),
      contar('sales_events', h.id, 'report_utm'),
      contar('integrations', h.id, 'report_utm'),
      contar('bi_reports', h.id, 'public'),
    ]);
    console.log(
      `  ${String(h.nombre).trim()}  [${h.id}]  ${h.status} · alta ${String(h.created_at).slice(0, 10)}\n` +
        `    ${leads} leads · ${ventas} ventas · ${integraciones} integraciones · ${informes} informes BI`
    );
  }

  if (!APLICAR) {
    console.log('\nNada borrado. Repite con --apply (y --ids= para elegir) para borrar.\n');
    return;
  }

  let errores = 0;
  for (const h of huerfanos) {
    const r = await eliminarClienteUtm(db, h.id);
    if (r.ok) console.log(`  ✓ ${String(h.nombre).trim()} borrado`);
    else {
      errores++;
      console.log(`  ✗ ${String(h.nombre).trim()}: ${r.error}`);
    }
  }
  console.log(errores === 0 ? '\n✅ Hecho.\n' : `\n❌ ${errores} cliente(s) sin borrar.\n`);
  if (errores > 0) process.exit(1);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
