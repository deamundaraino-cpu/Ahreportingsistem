/**
 * Paridad de cifras ENTRE SUPERFICIES, por cliente y con un rango cerrado.
 *
 * La auditoría del 2026-09-28 (docs/25) encontró cinco caminos que calculan
 * gasto y leads —informes BI, pestañas del dashboard, API v1/MCP, alertas y
 * CSV— y ningún test que los comparara entre sí: `verify-bi-golden` solo
 * compara el motor del BI consigo mismo. Este script compara:
 *
 *   1. GASTO: el total del BI (`runBiQuery`) frente al del camino del dashboard
 *      y la API (`getMetricasCliente`), que suma los arrays de campañas. Pueden
 *      diferir un 1 % cuando Meta trunca el desglose (`metaRowIsIncomplete`), y
 *      a propósito cuando el cliente tiene alcance de campañas (el BI recorta la
 *      cuenta compartida y el dashboard lo hace por pestaña): ahí se informa.
 *   2. LEADS: `leads_count` del BI frente al total del cubo `leads_cubo`, que es
 *      lo que pintan las tarjetas «Contactos» del dashboard. Tienen que ser
 *      IDÉNTICOS: los dos cuentan `lead_events` no excluidos en el mismo rango,
 *      y en la misma zona horaria del cliente.
 *   3. DESGLOSE: la suma de los leads de una tabla por campaña (sin Top-N) es el
 *      total. Si no, alguna fila se pierde.
 *
 *   npx tsx --conditions=react-server scripts/verify-paridad-superficies.ts
 *   npx tsx --conditions=react-server scripts/verify-paridad-superficies.ts --desde=2026-09-01 --hasta=2026-09-27
 *
 * Solo lectura. Forma parte de `test:datos` (usa la base de producción).
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? `  → ${detalle}` : ''}`);
  }
}

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { runBiQuery } = await import('../src/lib/report-utm/bi-query');
  const { getMetricasCliente } = await import('../src/lib/metrics/client-metrics');
  const { cargarCuboCrudo } = await import('../src/lib/leads/respuestas/cubo-db');
  const { conZonaDeCliente } = await import('../src/lib/zona-activa');
  const { cargarAlcanceCampanas } = await import('../src/lib/report-utm/alcance-campanas');

  // Rango CERRADO por defecto: los 14 días hasta anteayer. Con hoy dentro, los
  // leads que entran durante la prueba moverían una cifra y no la otra.
  const hasta = arg('hasta') ?? new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  const desde =
    arg('desde') ??
    new Date(Date.parse(`${hasta}T00:00:00Z`) - 13 * 86400_000).toISOString().slice(0, 10);
  console.log(`\nParidad entre superficies · ${desde} → ${hasta}`);

  const db = await createAdminClient();
  const { data: clientes, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id, nombre, public_cliente_id')
    .not('public_cliente_id', 'is', null)
    .order('nombre');
  if (error) throw new Error(error.message);

  for (const c of (clientes ?? []) as Array<{
    id: string;
    nombre: string;
    public_cliente_id: string;
  }>) {
    console.log(`\n■ ${c.nombre.trim()}`);
    const base = { cliente_id: c.id, date_from: desde, date_to: hasta };

    // En la zona del cliente, como corre el BI de verdad (`dispatchBiQuery`):
    // fuera de ella los días serían los de Colombia y no cuadrarían con el cubo.
    const enZona = <T>(fn: () => Promise<T>) => conZonaDeCliente({ rtm: c.id }, fn);
    const [bi] = await enZona(() =>
      runBiQuery({ ...base, metrics: ['spend', 'leads_count'], dimension: 'none' })
    );
    const spendBi = Number(bi?.spend ?? 0);
    const leadsBi = Number(bi?.leads_count ?? 0);

    // 1. Gasto
    const alcance = await cargarAlcanceCampanas(c.public_cliente_id);
    const dash = await getMetricasCliente({
      clienteId: c.public_cliente_id,
      from: desde,
      to: hasta,
    });
    const spendDash = Number(dash.totals.meta_spend ?? 0) + Number(dash.totals.tiktok_spend ?? 0);
    const tolerancia = Math.max(1, spendDash * 0.01);
    if (alcance) {
      console.log(
        `  · gasto BI ${spendBi.toFixed(0)} (recortado por alcance) · cuenta ${spendDash.toFixed(0)}`
      );
      check(
        'con alcance, el BI no supera el gasto de la cuenta',
        spendBi <= spendDash + tolerancia
      );
    } else {
      check(
        `gasto BI = dashboard/API (±1 %)`,
        Math.abs(spendBi - spendDash) <= tolerancia,
        `BI ${spendBi.toFixed(2)} · dashboard ${spendDash.toFixed(2)}`
      );
    }

    // 2. Leads
    const cubo = await conZonaDeCliente({ rtm: c.id }, () =>
      cargarCuboCrudo(db.schema('report_utm'), c.id, desde, hasta, [])
    );
    if (cubo) {
      const leadsCubo = cubo.totales.reduce((s, [, , n]) => s + n, 0);
      check(
        'leads del BI = contactos del dashboard (leads_cubo)',
        leadsBi === leadsCubo,
        `BI ${leadsBi} · cubo ${leadsCubo}`
      );
    } else {
      console.log('  · leads_cubo no disponible: se omite la paridad de leads');
    }

    // 3. Desglose por campaña sin Top-N
    const porCampana = await enZona(() =>
      runBiQuery({ ...base, metrics: ['leads_count'], dimension: 'utm_campaign' })
    );
    const sumaFilas = porCampana.reduce((s, r) => s + Number(r.leads_count ?? 0), 0);
    check(
      'la tabla por campaña suma el total de leads',
      sumaFilas === leadsBi,
      `filas ${sumaFilas} · total ${leadsBi}`
    );
  }

  console.log(
    fallos === 0
      ? '\n✅ Paridad entre superficies: todo OK\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  salir(fallos);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  salir(1);
});
