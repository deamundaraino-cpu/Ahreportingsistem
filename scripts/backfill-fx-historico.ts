/**
 * Rellena `fx_rates` con la tasa HISTÓRICA de las monedas de reporte.
 *
 * El worker solo cachea la tasa del día en que sincroniza (open.er-api.com no da
 * histórico en su plan libre). Para convertir ventas pasadas a la moneda del
 * cliente con la tasa de SU día, hace falta la tasa de cada fecha anterior. Sin
 * este relleno el conversor usa la más cercana conocida, que es aproximada.
 *
 * Fuente: el conjunto público `@fawazahmed0/currency-api` servido por jsDelivr,
 * con un archivo por día desde 2024-03. Sin clave.
 *
 * Solo escribe las filas (fecha, moneda) que FALTAN: una tasa ya cacheada no se
 * toca nunca, que es lo que la mantiene congelada.
 *
 *   npx tsx --conditions=react-server scripts/backfill-fx-historico.ts --desde=2026-01-01
 *   npx tsx --conditions=react-server scripts/backfill-fx-historico.ts --desde=2026-01-01 --monedas=CLP --apply
 *
 * Sin `--apply` solo informa de lo que escribiría.
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { MONEDAS_REPORTE } from '../src/lib/moneda-reporte';
import { fetchRatesHistoricas, FUENTE_HISTORICA } from '../src/lib/fx';

loadEnv({ path: '.env.local' });

const args = process.argv.slice(2);
const opt = (n: string, def?: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : def;
};
const APLICAR = args.includes('--apply');
const DESDE = opt('desde', '2026-01-01')!;
const HASTA = opt('hasta', new Date().toISOString().slice(0, 10))!;
const MONEDAS = (opt('monedas') ?? MONEDAS_REPORTE.join(','))
  .split(',')
  .map((m) => m.trim().toUpperCase())
  .filter((m) => m && m !== 'USD');

function dias(desde: string, hasta: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${desde}T00:00:00Z`); d <= new Date(`${hasta}T00:00:00Z`);) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400_000);
  }
  return out;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(url, key);

  const { data: existentes, error } = await db
    .from('fx_rates')
    .select('fecha, moneda')
    .in('moneda', MONEDAS)
    .gte('fecha', DESDE)
    .lte('fecha', HASTA)
    .limit(20000);
  if (error) throw new Error(error.message);
  const hay = new Set((existentes ?? []).map((r) => `${String(r.fecha).slice(0, 10)}|${r.moneda}`));

  const faltan = dias(DESDE, HASTA).filter((f) => MONEDAS.some((m) => !hay.has(`${f}|${m}`)));
  console.log(
    `\n${MONEDAS.join(', ')} · ${DESDE} → ${HASTA}: ${faltan.length} día(s) con alguna tasa faltante${APLICAR ? '' : '   [SIMULACIÓN]'}\n`
  );

  const filas: Array<{ fecha: string; moneda: string; usd_rate: number; fuente: string }> = [];
  for (const fecha of faltan) {
    const t = await fetchRatesHistoricas(fecha);
    if (!t) {
      console.log(`  ${fecha}: sin datos en la fuente`);
      continue;
    }
    for (const m of MONEDAS) {
      if (hay.has(`${fecha}|${m}`)) continue;
      const usdRate = t.get(m);
      if (!usdRate) continue;
      filas.push({ fecha, moneda: m, usd_rate: usdRate, fuente: FUENTE_HISTORICA });
    }
  }

  console.log(`Filas a escribir: ${filas.length}`);
  for (const f of filas.slice(0, 5)) {
    console.log(`  ${f.fecha} ${f.moneda}  1 USD = ${(1 / f.usd_rate).toFixed(2)} ${f.moneda}`);
  }
  if (!APLICAR) {
    console.log('\nNada escrito. Repite con --apply para guardar.\n');
    return;
  }
  for (let i = 0; i < filas.length; i += 500) {
    // ignoreDuplicates: si otra corrida (o el worker) la escribió entre medias,
    // la que ya estaba gana. Una tasa cacheada no se reescribe nunca.
    const { error: e } = await db
      .from('fx_rates')
      .upsert(filas.slice(i, i + 500), { onConflict: 'fecha,moneda', ignoreDuplicates: true });
    if (e) throw new Error(e.message);
  }
  console.log(`\n✅ ${filas.length} tasa(s) guardadas.\n`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
