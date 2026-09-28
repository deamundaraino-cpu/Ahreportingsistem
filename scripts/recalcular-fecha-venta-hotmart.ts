/**
 * Recalcula `hotmart_ventas.fecha_venta` en la zona horaria de cada cliente.
 *
 * `fecha_venta` se materializa al escribir la venta. Hasta el 2026-09-28 se
 * calculaba siempre en día de Colombia; desde entonces, en la zona del cliente
 * (la de su cuenta de Meta, ver src/lib/zona-horaria.ts). Las ventas ya guardadas
 * conservan el día viejo: una venta de Chile a las 23:30 sigue en el día
 * siguiente hasta que se pase este script.
 *
 * EN SECO por defecto: lee, calcula y cuenta cuántas cambian de día, sin escribir.
 * Con `--aplicar` escribe por lotes de 200 y después reagrega en
 * `metricas_diarias` los días tocados (los de antes y los de después), que es
 * de donde leen el dashboard y la fuente «Cuenta» del BI.
 *
 *   npx tsx --conditions=react-server scripts/recalcular-fecha-venta-hotmart.ts
 *   npx tsx --conditions=react-server scripts/recalcular-fecha-venta-hotmart.ts --aplicar
 *   npx tsx --conditions=react-server scripts/recalcular-fecha-venta-hotmart.ts --cliente=<uuid public>
 *
 * Los meses cerrados (`periodos_cerrados`) no se reagregan: `reagregarFechasHotmart`
 * los respeta y los informa. Nunca imprime datos del comprador.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { diaEnZona, zonaHorariaDeCliente } from '../src/lib/zona-horaria';
import { fetchAllRows } from '../src/lib/supabase-paginate';

const aplicar = process.argv.includes('--aplicar');
const soloCliente = process.argv.find((a) => a.startsWith('--cliente='))?.slice(10) ?? null;
const LOTE = 200;

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { reagregarFechasHotmart } = await import('../src/lib/hotmart/reagregar');

  let q = db.from('clientes').select('id, nombre, config_api');
  if (soloCliente) q = q.eq('id', soloCliente);
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);

  let total = 0;
  let cambian = 0;
  for (const c of clientes ?? []) {
    const zona = zonaHorariaDeCliente(c.config_api);
    const filas = (await fetchAllRows(
      () =>
        db
          .from('hotmart_ventas')
          .select('id, fecha_venta, aprobada_at, orden_at, evento_ts')
          .eq('cliente_id', c.id),
      1000,
      200000,
      { estricto: true }
    )) as Array<{
      id: string;
      fecha_venta: string;
      aprobada_at: string | null;
      orden_at: string | null;
      evento_ts: string | null;
    }>;
    if (filas.length === 0) continue;

    // La misma regla que el parser: aprobación, si no orden, si no el evento.
    const cambios = filas
      .map((f) => {
        const instante = f.aprobada_at ?? f.orden_at ?? f.evento_ts;
        const nueva = instante ? diaEnZona(instante, zona) : f.fecha_venta;
        return { id: f.id, vieja: String(f.fecha_venta).slice(0, 10), nueva };
      })
      .filter((x) => x.nueva !== x.vieja);

    total += filas.length;
    cambian += cambios.length;
    console.log(
      `■ ${String(c.nombre).trim()} (${zona}): ${filas.length} ventas, ${cambios.length} cambian de día`
    );
    if (!aplicar || cambios.length === 0) continue;

    const fechasTocadas = new Set<string>();
    for (let i = 0; i < cambios.length; i += LOTE) {
      for (const x of cambios.slice(i, i + LOTE)) {
        const { error: e } = await db
          .from('hotmart_ventas')
          .update({ fecha_venta: x.nueva })
          .eq('id', x.id);
        if (e) throw new Error(`venta ${x.id}: ${e.message}`);
        fechasTocadas.add(x.vieja);
        fechasTocadas.add(x.nueva);
      }
    }
    const r = await reagregarFechasHotmart(db, c.id, fechasTocadas, { log: console.log });
    console.log(
      `  escritas ${cambios.length}; reagregados ${r.reagregadas.length} días` +
        (r.cerradas.length ? `, ${r.cerradas.length} en meses cerrados (sin tocar)` : '') +
        (r.errores.length ? `, ${r.errores.length} errores: ${r.errores.join(' | ')}` : '')
    );
  }

  console.log(
    `\n${total} ventas revisadas, ${cambian} cambian de día.` +
      (aplicar ? '' : ' En seco: no se ha escrito nada. Con --aplicar se escriben.')
  );
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
