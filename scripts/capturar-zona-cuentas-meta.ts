/**
 * Guarda la zona horaria (`timezone_name`) de cada cuenta de Meta en
 * `config_api.meta_estado_cuentas[*].zona`, sin esperar al vigilante de cuentas.
 *
 * El vigilante (`lib/meta/alerta-cuenta.ts`) ya la guarda en cada revisión, pero
 * solo revisa cada 3 h. Este script sirve para activar la zona por cliente en
 * el momento (antes de `recalcular-fecha-venta-hotmart.ts`). Solo toca la clave
 * `zona` de cada cuenta; el resto del estado se conserva.
 *
 *   npx tsx --conditions=react-server scripts/capturar-zona-cuentas-meta.ts            # en seco
 *   npx tsx --conditions=react-server scripts/capturar-zona-cuentas-meta.ts --aplicar
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { consultarEstadoCuenta } from '../src/lib/meta/estado-cuenta';
import { cuentasMetaDe } from '../src/lib/meta/alerta-cuenta';
import { zonaHorariaDeCliente } from '../src/lib/zona-horaria';

const aplicar = process.argv.includes('--aplicar');

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: clientes, error } = await db.from('clientes').select('id, nombre, config_api');
  if (error) throw new Error(error.message);

  for (const c of clientes ?? []) {
    const config = (c.config_api ?? {}) as Record<string, unknown>;
    const cuentas = cuentasMetaDe(config);
    if (cuentas.length === 0) continue;
    const previo = {
      ...((config.meta_estado_cuentas ?? {}) as Record<string, Record<string, unknown>>),
    };
    const zonas: string[] = [];
    for (const cu of cuentas) {
      const e = await consultarEstadoCuenta(cu.account_id, cu.token);
      const id = cu.account_id.replace(/^act_/, '');
      if (!e?.zona) {
        zonas.push(`${id}: sin respuesta`);
        continue;
      }
      previo[id] = { ...(previo[id] ?? {}), zona: e.zona };
      zonas.push(`${id}: ${e.zona}`);
    }
    const efectiva = zonaHorariaDeCliente({ ...config, meta_estado_cuentas: previo });
    console.log(
      `■ ${String(c.nombre).trim()} → ${zonas.join(' · ')} ⇒ zona del cliente: ${efectiva}`
    );
    if (!aplicar) continue;
    const r = await db.rpc('fusionar_config_api', {
      p_cliente_id: c.id,
      p_parche: { meta_estado_cuentas: previo },
    });
    if (r.error) console.log(`  ✗ ${r.error.message}`);
  }
  if (!aplicar) console.log('\nEn seco: no se ha escrito nada. Con --aplicar se guarda.');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
