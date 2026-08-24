/**
 * Auxiliar de `verify-ads-daily-paridad.ts`. No es una comprobación por sí solo.
 *
 * Imprime, en una línea JSON, el gasto por campaña de TODOS los clientes según
 * el motor del BI. Vive en un archivo aparte porque la elección entre
 * `ads_daily` y los JSONB se hace con `BI_ADS_SOURCE` al arrancar el proceso: la
 * única forma de comparar los dos caminos es ejecutarlo dos veces con entornos
 * distintos.
 *
 *   npx tsx scripts/_bi-gasto-por-campana.ts 2026-07-01 2026-07-31
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

const [DESDE, HASTA] = process.argv.slice(2);

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { runBiQuery } = await import('../src/lib/report-utm/bi-query');

  const db = await createAdminClient();
  const { data } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .order('nombre');
  const clientes = (data ?? []) as Array<{
    id: string;
    nombre: string;
    public_cliente_id: string | null;
  }>;

  const out: Record<string, number> = {};
  for (const c of clientes) {
    if (!c.public_cliente_id) continue;
    const filas = await runBiQuery({
      cliente_id: c.id,
      metrics: ['spend'],
      dimension: 'campaign',
      date_from: DESDE,
      date_to: HASTA,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    for (const f of filas) {
      // La clave lleva el cliente porque dos clientes pueden tener una
      // campaña con el mismo nombre y fundirlas escondería una diferencia.
      out[`${c.nombre.trim()} · ${f.dimension_value}`] = Number(f.spend ?? 0);
    }
  }
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
