/**
 * Backfill histórico de ventas de Hotmart → `public.hotmart_ventas`.
 *
 * Existe además del job de la cola porque la carga inicial no cabe en los 60 s
 * de una invocación de Vercel: aquí no hay límite de tiempo.
 *
 *   npx tsx scripts/backfill-hotmart.ts --contar
 *   npx tsx scripts/backfill-hotmart.ts --contar --desde=2026-03-01
 *   npx tsx scripts/backfill-hotmart.ts --cliente=<uuid> --desde=2026-03-01
 *   npx tsx scripts/backfill-hotmart.ts --desde=2026-03-01 --hasta=2026-08-10
 *
 * Flags:
 *   --contar          Sondea la API y reporta volumen y MB estimados. NO escribe.
 *   --cliente=<uuid>  Un solo cliente (por defecto, todos los que tengan Hotmart).
 *   --desde=<fecha>   Por defecto, 180 días atrás.
 *   --hasta=<fecha>   Por defecto, hoy (Colombia).
 *
 * PASO OBLIGATORIO antes de una carga grande: correr `--contar`. La base está en
 * 449 MB contra el tope de 500 MB del plan (ver la cabecera de la migración
 * 065), y este script es lo único que dice cuántas filas se van a añadir.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { backfillRango, contarRango, estimarMb } from '../src/lib/hotmart/backfill';
import { hotmartConectado } from '../src/lib/hotmart/cliente';
import { addDaysISO, colombiaToday } from '../src/lib/colombia-date';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}

const SOLO_CONTAR = args.has('contar');
const HASTA = args.get('hasta') ?? colombiaToday();
const DESDE = args.get('desde') ?? addDaysISO(HASTA, -180);
const CLIENTE = args.get('cliente') ?? null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}
const db = createClient(url, key);

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function main() {
  console.log(`\n${SOLO_CONTAR ? '── SONDEO (no escribe) ' : '── BACKFILL '}${'─'.repeat(40)}`);
  console.log(`  Rango: ${DESDE} → ${HASTA}\n`);

  let q = db.from('clientes').select('id, nombre, config_api').order('nombre');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) {
    console.error('Error leyendo clientes:', error.message);
    process.exit(1);
  }

  const conHotmart = (clientes ?? []).filter((c) => hotmartConectado(c.config_api));
  if (conHotmart.length === 0) {
    console.log('  No hay clientes con Hotmart conectado.\n');
    return;
  }
  console.log(`  ${conHotmart.length} cliente(s) con Hotmart conectado\n`);

  let totalTx = 0;
  let totalEscritas = 0;
  const incompletos: string[] = [];

  for (const cliente of conHotmart) {
    console.log(
      `── ${cliente.nombre} ${'─'.repeat(Math.max(0, 50 - String(cliente.nombre).length))}`
    );
    const r = SOLO_CONTAR
      ? await contarRango(db, cliente, DESDE, HASTA, log)
      : await backfillRango(db, cliente, DESDE, HASTA, { log });

    if (r.error) {
      console.log(`  ✗ ${r.error}\n`);
      continue;
    }

    totalTx += r.transacciones;
    totalEscritas += r.escritas;
    if (r.diasIncompletos.length > 0) {
      incompletos.push(`${cliente.nombre}: ${r.diasIncompletos.join(', ')}`);
    }

    console.log(`  ${r.dias} día(s), ${r.transacciones} transacción(es)`);
    if (!SOLO_CONTAR) {
      console.log(`  ${r.escritas} escritas, ${r.descartadas} descartadas por la guarda de orden`);
      if (r.sinTasa > 0) {
        console.log(`  ⚠ ${r.sinTasa} importe(s) sin tasa de cambio (${r.monedas.join(', ')})`);
      }
    }
    console.log();
  }

  console.log(`── RESUMEN ${'─'.repeat(48)}`);
  console.log(`  Transacciones: ${totalTx}`);
  if (SOLO_CONTAR) {
    console.log(`  Espacio estimado: ~${estimarMb(totalTx)} MB (con raw_payload)`);
    console.log(`                    ~${estimarMb(totalTx, false)} MB (si se purga el crudo)`);
    console.log(`  Margen de la base: 51 MB sobre el tope de 500 MB del plan.`);
    console.log(`\n  Si el volumen supera ~30.000 filas, acota el rango antes de escribir.`);
  } else {
    console.log(`  Escritas: ${totalEscritas}`);
  }
  // Un tope de páginas alcanzado o un token repetido significan datos a medias:
  // callarlo haría creer que el rango quedó completo.
  if (incompletos.length > 0) {
    console.log(`\n  ⚠ DÍAS INCOMPLETOS (hay que repetirlos):`);
    for (const i of incompletos) console.log(`    ${i}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
