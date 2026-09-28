/**
 * Atribuye las ventas de Hotmart ya guardadas heredando la UTM del lead del
 * mismo comprador (email, luego teléfono), y marca como `tracking` las que ya
 * traen campaña propia.
 *
 * EN SECO por defecto: lee, calcula y cuenta, sin escribir nada. Con
 * `--aplicar` escribe, y para eso hace falta la migración 089 (sin sus columnas
 * no hay dónde guardar la atribución).
 *
 *   npx tsx --conditions=react-server scripts/atribuir-hotmart-leads.ts
 *   npx tsx --conditions=react-server scripts/atribuir-hotmart-leads.ts --cliente=<uuid> --desde=2026-07-01 --hasta=2026-08-31
 *   npx tsx --conditions=react-server scripts/atribuir-hotmart-leads.ts --aplicar
 *
 * `--cliente` es el id de `public.clientes`. Sin él, recorre todos los clientes
 * con Hotmart conectado. Nunca imprime emails ni teléfonos.
 *
 * La misma lógica corre sola a diario (job `hotmart_reconciliar`) sobre los
 * últimos 30 días; este script es para el histórico y para mirar la cobertura.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { hotmartConectado } from '../src/lib/hotmart/cliente';
import { reatribuirGuardadas } from '../src/lib/hotmart/atribucion-db';
import { addDaysISO, colombiaToday } from '../src/lib/colombia-date';
import { salir } from './_salida';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}

const APLICAR = args.has('aplicar');
const CLIENTE = args.get('cliente') ?? null;
const HASTA = args.get('hasta') ?? colombiaToday();
const DESDE = args.get('desde') ?? addDaysISO(HASTA, -365);

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)} %` : '—');

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
    process.exit(1);
  }
  const db = createClient(url, key);

  let q = db.from('clientes').select('id, nombre, config_api').order('nombre');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);

  const conHotmart = (clientes ?? []).filter((c) => CLIENTE || hotmartConectado(c.config_api));
  console.log(
    `\n── Atribución de ventas Hotmart por lead ${APLICAR ? '[APLICAR]' : '[EN SECO]'} ──`
  );
  console.log(`  Rango: ${DESDE} → ${HASTA} · ${conHotmart.length} cliente(s)\n`);

  let fallos = 0;
  for (const c of conHotmart) {
    try {
      const inf = await reatribuirGuardadas(db, c.id, {
        desde: DESDE,
        hasta: HASTA,
        aplicar: APLICAR,
        log: (m) => console.log(`    ${m}`),
      });
      console.log(`  ${c.nombre}`);
      console.log(
        `    migración 089: ${inf.con089 ? 'aplicada' : 'NO aplicada (solo en seco)'} · leads leídos vía ${inf.via ?? '—'}`
      );
      console.log(
        `    ventas revisadas: ${inf.revisadas} · ya atribuidas: ${inf.yaAtribuidas} · nuevas: ${inf.nuevas}`
      );
      console.log(
        `    por método → tracking ${inf.porMetodo.tracking} · email ${inf.porMetodo.lead_email} · teléfono ${inf.porMetodo.lead_telefono} · padre ${inf.porMetodo.padre}`
      );
      console.log(
        `    compras con campaña: ${inf.principalesConCampana}/${inf.principales} (${pct(inf.principalesConCampana, inf.principales)})`
      );
      console.log(
        `    facturación neta con campaña: ${inf.netoUsdConCampana.toFixed(2)} / ${inf.netoUsdTotal.toFixed(2)} USD (${pct(inf.netoUsdConCampana, inf.netoUsdTotal)})`
      );
      const porCampana = new Map<string, number>();
      for (const cambio of inf.cambios) {
        const k = cambio.utm_campaign ?? '(solo utm_id)';
        porCampana.set(k, (porCampana.get(k) ?? 0) + 1);
      }
      for (const [camp, n] of Array.from(porCampana.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)) {
        console.log(`      ${String(n).padStart(3)} × ${camp.slice(0, 110)}`);
      }
      if (APLICAR) console.log(`    filas escritas: ${inf.escritas}`);
      console.log();
    } catch (e) {
      fallos++;
      console.error(`  ✗ ${c.nombre}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  if (!APLICAR)
    console.log('  (En seco: no se escribió nada. Repite con --aplicar para guardar.)\n');
  salir(fallos);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
