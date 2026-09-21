import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const db = await createAdminClient();
  const t0 = Date.now();
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .order('nombre');
  const ms = Date.now() - t0;
  const ok = !error && (data ?? []).length > 0;
  console.log(ok ? `OK ${ms}` : `ERROR ${ms}`);
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
}
main();
