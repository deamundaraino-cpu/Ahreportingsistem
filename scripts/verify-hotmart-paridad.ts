/**
 * Paridad: `hotmart_ventas` agregada vs. lo que ya está en `metricas_diarias`.
 *
 * Es la red de seguridad del cambio más arriesgado del módulo: sustituir las
 * ~270 líneas que `worker/route.ts` tenía inline por una lectura de la tabla de
 * hechos. Si la agregación nueva no reproduce lo que el worker escribió, los
 * clientes ven otros números sin que nadie haya tocado su configuración.
 *
 * Calcado de `verify-ads-daily-paridad.ts`.
 *
 * ── Qué se exige y qué solo se informa ──────────────────────────
 * Se EXIGE paridad exacta en las fechas sin reembolsos. En las fechas CON
 * reembolsos se imprime la desviación sin fallar: esa diferencia es la mejora,
 * no un error — la vía de pull filtraba a APPROVED+COMPLETE, así que una venta
 * devuelta contaba como facturación para siempre.
 *
 * Solo compara fechas que existan en AMBOS lados: un día que aún no se ha
 * backfilleado no es una discrepancia.
 *
 *   npx tsx scripts/verify-hotmart-paridad.ts
 *   npx tsx scripts/verify-hotmart-paridad.ts --dias=60
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { addDaysISO, colombiaToday } from '../src/lib/colombia-date';

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

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}
const DIAS = Number(args.get('dias') ?? 30);
/** Céntimos de tolerancia: los dos lados redondean por separado. */
const EPSILON = 0.02;

type Agregado = {
  principal_n: number;
  bump_n: number;
  principal: number;
  bump: number;
  upsell: number;
};
const cero = (): Agregado => ({ principal_n: 0, bump_n: 0, principal: 0, bump: 0, upsell: 0 });
const num = (v: unknown) => Number(v ?? 0) || 0;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('\n  (sin credenciales de Supabase: nada que comparar)\n');
    process.exit(0);
  }
  const db = createClient(url, key);

  const hasta = colombiaToday();
  const desde = addDaysISO(hasta, -DIAS);
  seccion(`Paridad ${desde} → ${hasta}`);

  const { data: ventas, error: e1 } = await db
    .from('hotmart_ventas')
    .select('cliente_id, fecha_venta, tipo, estado, neto_productor_usd')
    .gte('fecha_venta', desde)
    .lte('fecha_venta', hasta)
    .limit(20000);
  if (e1) {
    check('lectura de hotmart_ventas', false, e1.message);
    process.exit(1);
  }

  if ((ventas ?? []).length === 0) {
    // No es un fallo: la tabla es nueva y hasta que corra el backfill está
    // legítimamente vacía. Callarlo sí sería un problema.
    console.log(
      '  · sin ventas en el rango: ejecuta `npm run backfill:hotmart` para poder comparar.'
    );
    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
    process.exit(fallos === 0 ? 0 : 1);
  }

  const nuevo = new Map<string, Agregado>();
  const conReembolso = new Set<string>();
  for (const v of ventas ?? []) {
    const k = `${v.cliente_id}|${v.fecha_venta}`;
    const a = nuevo.get(k) ?? cero();
    if (v.estado === 'reembolsada' || v.estado === 'chargeback') {
      conReembolso.add(k);
    } else if (v.estado === 'aprobada' || v.estado === 'completa') {
      const neto = num(v.neto_productor_usd);
      if (v.tipo === 'principal') {
        a.principal_n++;
        a.principal += neto;
      } else if (v.tipo === 'bump') {
        a.bump_n++;
        a.bump += neto;
      } else if (v.tipo === 'upsell') {
        a.upsell += neto;
      }
    }
    nuevo.set(k, a);
  }

  const { data: diarias, error: e2 } = await db
    .from('metricas_diarias')
    .select(
      'cliente_id, fecha, ventas_principal, ventas_bump, ventas_upsell, ventas_principal_count, ventas_bump_count'
    )
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .limit(20000);
  if (e2) {
    check('lectura de metricas_diarias', false, e2.message);
    process.exit(1);
  }

  const viejo = new Map<string, Agregado>();
  for (const d of diarias ?? []) {
    viejo.set(`${d.cliente_id}|${d.fecha}`, {
      principal_n: num(d.ventas_principal_count),
      bump_n: num(d.ventas_bump_count),
      principal: num(d.ventas_principal),
      bump: num(d.ventas_bump),
      upsell: num(d.ventas_upsell),
    });
  }

  const { data: clientes } = await db.from('clientes').select('id, nombre');
  const nombre = new Map((clientes ?? []).map((c) => [c.id, c.nombre]));

  const desviaciones: string[] = [];
  const conocidas: string[] = [];
  let comparadas = 0;

  for (const [k, n] of nuevo) {
    const v = viejo.get(k);
    if (!v) continue; // fecha aún no escrita por el worker: no es discrepancia
    comparadas++;
    const [cli, fecha] = k.split('|');
    const dif =
      Math.abs(n.principal - v.principal) > EPSILON ||
      Math.abs(n.bump - v.bump) > EPSILON ||
      Math.abs(n.upsell - v.upsell) > EPSILON ||
      n.principal_n !== v.principal_n ||
      n.bump_n !== v.bump_n;
    if (!dif) continue;
    const linea = `${nombre.get(cli) ?? cli} ${fecha}: nuevo ${n.principal_n}/${n.principal.toFixed(2)} vs viejo ${v.principal_n}/${v.principal.toFixed(2)}`;
    // Un día con reembolsos DEBE diferir: el lado viejo nunca los vio.
    if (conReembolso.has(k)) conocidas.push(linea);
    else desviaciones.push(linea);
  }

  console.log(`  ${comparadas} día(s)×cliente comparados`);
  check(
    'paridad exacta en los días SIN reembolsos',
    desviaciones.length === 0,
    desviaciones.slice(0, 5).join(' | ')
  );

  if (conocidas.length > 0) {
    // Se imprime, no se calla: es exactamente la cifra que justifica todo
    // este trabajo — facturación que el sistema anterior contaba de más.
    console.log(`\n  ${conocidas.length} día(s) difieren POR REEMBOLSOS (la mejora, no un fallo):`);
    for (const l of conocidas.slice(0, 10)) console.log(`    ${l}`);
  }

  console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
