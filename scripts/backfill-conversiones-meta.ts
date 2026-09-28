/**
 * Backfill de conversiones personalizadas de Meta.
 *
 * Hasta el 2026-09-28 el worker solo leía el campo `conversions` de /insights, y
 * las conversiones personalizadas (`offsite_conversion.custom.<id>`) solo llegan
 * en `actions`: no se guardó ninguna. Este script:
 *
 *   1. Descubre, para cada cliente con Meta, las conversiones con actividad en
 *      el rango y actualiza el catálogo (pocas llamadas: nivel cuenta).
 *   2. Elige los clientes con alguna conversión personalizada REAL (origen `cc`).
 *   3. Con `--ejecutar`, les encola un resync de métricas SOLO de Meta, por
 *      oleadas: un cliente, espera a que la cola se vacíe, el siguiente. La
 *      instancia es Micro; lanzarlo de madrugada.
 *
 *   npx tsx --conditions=react-server scripts/backfill-conversiones-meta.ts
 *   npx tsx --conditions=react-server scripts/backfill-conversiones-meta.ts --ejecutar
 *   npx tsx --conditions=react-server scripts/backfill-conversiones-meta.ts --clientes=<uuid>,<uuid> --dias=90
 *
 * Flags:
 *   --dias=90          Rango hacia atrás desde hoy (Colombia). Por defecto 90.
 *   --clientes=a,b     Solo esos clientes (id público).
 *   --chunk=7          Días por job.
 *   --ejecutar         Encola los jobs. Sin él, solo descubre e informa.
 *   --sin-catalogo     No actualiza el catálogo (paso 1 en modo solo lectura).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { addDaysISO, colombiaToday } from '../src/lib/colombia-date';
import { cuentasMetaDe } from '../src/lib/meta/cuentas';
import {
  descubrirConversiones,
  filasCatalogo,
  guardarCatalogo,
  listarCustomConversions,
} from '../src/lib/meta/conversiones-personalizadas-sync';
import { enqueueRange } from '../src/lib/sync/queue';
import { PRIORIDAD } from '../src/lib/sync/planner';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}

const DIAS = Number(args.get('dias') ?? 90);
const CHUNK = Number(args.get('chunk') ?? 7);
const EJECUTAR = args.has('ejecutar');
const SIN_CATALOGO = args.has('sin-catalogo');
const SOLO = args.get('clientes')?.split(',').filter(Boolean) ?? null;
const HASTA = colombiaToday();
const DESDE = addDaysISO(HASTA, -(DIAS - 1));
const TRIGGER = 'backfill_conversiones_meta';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}
const db = createClient(url, key);

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Jobs de este backfill que aún no han terminado. */
async function pendientes(clienteId: string): Promise<number> {
  const { count, error } = await db
    .from('sync_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('cliente_id', clienteId)
    .eq('triggered_by', TRIGGER)
    .in('estado', ['pending', 'running']);
  if (error) throw new Error(`sync_jobs: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log(`\n── ${EJECUTAR ? 'BACKFILL' : 'SONDEO (no encola)'} ${'─'.repeat(40)}`);
  console.log(`  Rango: ${DESDE} → ${HASTA} (${DIAS} días)\n`);

  let q = db.from('clientes').select('id, nombre, config_api').order('nombre');
  if (SOLO) q = q.in('id', SOLO);
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);

  const candidatos: Array<{ id: string; nombre: string; ccs: string[] }> = [];
  for (const c of (clientes ?? []) as Array<{ id: string; nombre: string; config_api: any }>) {
    const cuentas = cuentasMetaDe(c.config_api ?? {});
    if (cuentas.length === 0) continue;
    const { descubiertas, cuentasConError } = await descubrirConversiones(cuentas, DESDE, HASTA);
    const ccs = [...descubiertas].filter(([, d]) => d.origen === 'cc').map(([k]) => k);
    const eventos = descubiertas.size - ccs.length;
    const aviso = cuentasConError.length ? ` · sin respuesta: ${cuentasConError.join(', ')}` : '';
    console.log(
      `  ${c.nombre.trim().padEnd(28)} ${String(ccs.length).padStart(2)} CC · ${String(eventos).padStart(2)} eventos${aviso}`
    );
    if (!SIN_CATALOGO && descubiertas.size > 0) {
      const nombres = ccs.length ? await listarCustomConversions(cuentas) : new Map();
      for (const k of ccs) {
        const d = descubiertas.get(k)!;
        console.log(
          `      · ${k} «${nombres.get(k)?.name ?? '?'}» última actividad ${d.ultimaActividad ?? '—'}`
        );
      }
      const r = await guardarCatalogo(db, c.id, filasCatalogo(descubiertas, nombres), HASTA);
      if (r.error) console.log(`      ⚠ catálogo: ${r.error}`);
    }
    if (ccs.length > 0) candidatos.push({ id: c.id, nombre: c.nombre.trim(), ccs });
  }

  console.log(`\n  Clientes con conversiones personalizadas: ${candidatos.length}`);
  for (const c of candidatos) console.log(`    - ${c.nombre} (${c.id})`);

  if (!EJECUTAR) {
    console.log('\n  Sin --ejecutar no se encola nada.');
    return;
  }

  for (const c of candidatos) {
    const n = await enqueueRange(db, {
      tipo: 'metricas',
      clienteId: c.id,
      start: DESDE,
      end: HASTA,
      chunkDays: CHUNK,
      params: { force: true, refresh_days: DIAS, platforms: 'meta' },
      prioridad: PRIORIDAD.cierre,
      triggeredBy: TRIGGER,
    });
    console.log(`\n  ${c.nombre}: ${n} jobs encolados. Esperando a que terminen…`);
    const inicio = Date.now();
    for (;;) {
      const p = await pendientes(c.id);
      if (p === 0) break;
      if (Date.now() - inicio > 3 * 60 * 60 * 1000) {
        console.log('  ⚠ Más de 3 h esperando: se para aquí. Revisa /admin/sync.');
        return;
      }
      process.stdout.write(`\r    pendientes: ${p}   `);
      await dormir(30_000);
    }
    console.log(`\r    ✓ ${c.nombre} terminado.`);
  }

  // Comprobación: suma por conversión en el rango, desde el JSONB.
  console.log('\n── Comprobación (metricas_diarias.meta_campaigns) ──');
  for (const c of candidatos) {
    const { data } = await db
      .from('metricas_diarias')
      .select('fecha, meta_campaigns')
      .eq('cliente_id', c.id)
      .gte('fecha', DESDE)
      .lte('fecha', HASTA);
    const tot: Record<string, number> = {};
    for (const f of (data ?? []) as Array<{ meta_campaigns: any[] | null }>) {
      for (const camp of f.meta_campaigns ?? []) {
        for (const k of c.ccs)
          tot[k] = (tot[k] ?? 0) + (Number(camp?.custom_conversions?.[k]) || 0);
      }
    }
    console.log(`  ${c.nombre}: ${c.ccs.map((k) => `${k}=${tot[k] ?? 0}`).join(' · ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
