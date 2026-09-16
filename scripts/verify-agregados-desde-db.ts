/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Qué cambiará en el BI al recalcular los agregados diarios desde la base.
 *
 *   npx tsx --conditions=react-server scripts/verify-agregados-desde-db.ts [--cliente=UUID]
 *
 * SOLO LECTURA. No va en `npm test`: su salida son diferencias reales de datos,
 * no fallos del código.
 *
 * Hasta ahora `conversiones_offline_diarias` se llenaba con lo leído en cada
 * corrida, así que una pestaña que falló dejaba sus totales fuera del BI
 * mientras el dashboard —que lee las filas— la seguía contando. Desde el cambio,
 * la consolidación recalcula los totales leyendo `conversiones_offline` entera.
 * Este script hace ese recálculo sin escribir y lo compara con lo que hay hoy,
 * sheet a sheet, para poder explicar cualquier salto después de desplegar.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import {
  agregadosDesdeFilasDb,
  mergeTabCustomColumns,
  normalizeSheetConfigs,
  normalizeTabs,
} from '../src/lib/integrations/google-sheets-conversiones';
import { fetchAllRows } from '../src/lib/supabase-paginate';

config({ path: '.env.local' });

const CLIENTE = process.argv.find((a) => a.startsWith('--cliente='))?.split('=')[1];

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const redondear = (n: number) => Math.round(n * 100) / 100;

async function main() {
  let q = db.from('clientes').select('id, nombre, config_api');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);

  let sheetsConDiferencias = 0;
  let sheetsRevisados = 0;

  for (const cliente of (clientes ?? []) as any[]) {
    const sheets = normalizeSheetConfigs(cliente.config_api?.google_sheets_conversiones).filter(
      (s) => s.enabled && s.sheet_url
    );
    for (const sheet of sheets) {
      sheetsRevisados++;
      const sheetId = sheet.id!;
      const filas = await fetchAllRows(
        () =>
          db
            .from('conversiones_offline')
            .select('id, fecha, tipo, cantidad, valor, fuente, custom_fields')
            .eq('cliente_id', cliente.id)
            .eq('sheet_id', sheetId),
        1000,
        200_000,
        { estricto: true }
      );
      const recalculado = agregadosDesdeFilasDb(filas, mergeTabCustomColumns(normalizeTabs(sheet)));

      const actuales = (await fetchAllRows(
        () =>
          db
            .from('conversiones_offline_diarias')
            .select('id, fecha, tipo, fuente, total_cantidad, total_valor')
            .eq('cliente_id', cliente.id)
            .eq('sheet_id', sheetId),
        1000,
        200_000,
        { estricto: true }
      )) as any[];

      const clave = (x: { fecha: string; tipo: string; fuente: string | null }) =>
        `${x.fecha}|${x.tipo}|${x.fuente ?? ''}`;
      const hoy = new Map(actuales.map((a) => [clave(a), a]));
      const nuevo = new Map(recalculado.map((a) => [clave(a), a]));

      const diferencias: string[] = [];
      for (const k of new Set([...hoy.keys(), ...nuevo.keys()])) {
        const h = hoy.get(k);
        const n = nuevo.get(k);
        const cantH = h?.total_cantidad ?? 0;
        const cantN = n?.total_cantidad ?? 0;
        const valH = redondear(Number(h?.total_valor ?? 0));
        const valN = redondear(n?.total_valor ?? 0);
        if (cantH !== cantN || valH !== valN) {
          diferencias.push(`${k}: cantidad ${cantH}→${cantN}, valor ${valH}→${valN}`);
        }
      }

      const suma = (xs: any[], campo: string) => xs.reduce((s, x) => s + Number(x[campo] ?? 0), 0);
      const etiqueta = `${cliente.nombre} › ${sheet.name || sheetId}`;
      if (diferencias.length === 0) {
        console.log(`✓ ${etiqueta}: sin cambios (${actuales.length} días-tipo-fuente)`);
        continue;
      }
      sheetsConDiferencias++;
      console.log(
        `△ ${etiqueta}: ${diferencias.length} claves cambian — ` +
          `cantidad ${suma(actuales, 'total_cantidad')}→${suma(recalculado, 'total_cantidad')}, ` +
          `valor ${redondear(suma(actuales, 'total_valor'))}→${redondear(suma(recalculado, 'total_valor'))}`
      );
      for (const d of diferencias.slice(0, 8)) console.log(`    ${d}`);
      if (diferencias.length > 8) console.log(`    … y ${diferencias.length - 8} más`);
    }
  }

  console.log(
    `\n${sheetsRevisados} sheet(s) revisados, ${sheetsConDiferencias} con diferencias. ` +
      'Nada se ha escrito.'
  );
}

main().catch((e) => {
  console.error('\n', e instanceof Error ? e.message : e);
  process.exit(1);
});
