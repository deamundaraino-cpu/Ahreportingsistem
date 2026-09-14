/**
 * Retira de las tablas de Sheets las filas HUÉRFANAS: su `sheet_id` no está en
 * la config del cliente (documento retirado, o entrada recreada con otro id), o
 * es NULL (anterior a la trazabilidad por sheet).
 *
 * Hubo una segunda pasada que borraba los «lotes viejos» de un sheet vigente.
 * Se retiró el 2026-09-14: desde la migración 069 varios `sync_batch_id` vivos
 * por sheet son lo normal, y aquella pasada borraba filas buenas.
 *
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts                 → informe, no toca nada
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts --apply         → borra
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts --cliente=UUID  → acota a un cliente
 *
 * Un sheet DESHABILITADO no es huérfano: sigue en la config y su historia se
 * conserva. (`cleanupOrphanConversiones` sí lo trataba como huérfano — deshabilitar
 * borraba los datos. Aquí se cuenta como vigente a propósito.)
 *
 * El borrado va por páginas de ids y nunca por `.eq('sheet_id', …)` de golpe: con
 * el índice GIN de `sheet_filas.valores`, borrar decenas de miles de filas en una
 * sola sentencia no cabe en el `statement_timeout` de 8 s del rol de PostgREST.
 * Ese es justamente el motivo de que la basura se acumulara.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { normalizeSheetConfigs } from '../src/lib/integrations/google-sheets-conversiones';

config({ path: '.env.local' });

const APLICAR = process.argv.includes('--apply');
const CLIENTE = process.argv.find((a) => a.startsWith('--cliente='))?.split('=')[1];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const TABLAS = ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas'] as const;
const PAGINA = 1000;
const LOTE_BORRADO = 500;

/** Lee una tabla entera para un cliente, paginando. */
async function leerTodo<T>(tabla: string, columnas: string, clienteId: string): Promise<T[]> {
  const todas: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await db
      .from(tabla)
      .select(columnas)
      .eq('cliente_id', clienteId)
      .order('sync_batch_id', { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    if (!data || data.length === 0) break;
    todas.push(...(data as T[]));
    if (data.length < PAGINA) break;
  }
  return todas;
}

/** Borra por páginas de ids las filas que cumplan el filtro. */
async function borrarPorPaginas(tabla: string, aplicarFiltro: (q: any) => any): Promise<number> {
  let total = 0;
  for (;;) {
    const { data, error } = await aplicarFiltro(db.from(tabla).select('id')).limit(LOTE_BORRADO);
    if (error) throw new Error(`${tabla} select: ${error.message}`);
    if (!data || data.length === 0) return total;

    const ids = (data as { id: string }[]).map((r) => r.id);
    const { error: delErr } = await db.from(tabla).delete().in('id', ids);
    if (delErr) throw new Error(`${tabla} delete: ${delErr.message}`);
    total += ids.length;
    process.stdout.write(`\r        ${tabla}: ${total} borradas…`);
  }
}

async function main() {
  let q = db.from('clientes').select('id, nombre, config_api');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) throw new Error(error.message);

  console.log(
    APLICAR ? '── MODO BORRADO ──\n' : '── Informe. No se toca nada. Añade --apply para borrar ──\n'
  );

  let huerfanas = 0;

  for (const cliente of (clientes ?? []) as { id: string; nombre: string; config_api: any }[]) {
    // Vigentes = TODOS los sheets configurados, habilitados o no.
    const configurados = new Set(
      normalizeSheetConfigs(cliente.config_api?.google_sheets_conversiones).map((s) => s.id!)
    );

    const filas = await leerTodo<{ sheet_id: string | null; sync_batch_id: string }>(
      'sheet_filas',
      'sheet_id, sync_batch_id',
      cliente.id
    );
    const conv = await leerTodo<{ sheet_id: string | null; sync_batch_id: string }>(
      'conversiones_offline',
      'sheet_id, sync_batch_id',
      cliente.id
    );
    if (filas.length === 0 && conv.length === 0) continue;

    // ── Pasada 1: sheets que ya no están en la config ────────────────────
    const vistos = new Set<string>();
    for (const f of [...filas, ...conv]) vistos.add(f.sheet_id ?? '∅');
    const retirados = [...vistos].filter((s) => s === '∅' || !configurados.has(s));

    if (retirados.length > 0) {
      console.log(`\n${cliente.nombre}`);
      console.log(`  configurados: ${[...configurados].join(', ') || '(ninguno)'}`);
      for (const sheetId of retirados) {
        const nulo = sheetId === '∅';
        console.log(`  ▸ huérfano ${nulo ? '(sheet_id NULL, datos legacy)' : sheetId}`);
        for (const tabla of TABLAS) {
          const filtro = (qq: any) => {
            const base = qq.eq('cliente_id', cliente.id);
            return nulo ? base.is('sheet_id', null) : base.eq('sheet_id', sheetId);
          };
          const { count } = await filtro(
            db.from(tabla).select('id', { count: 'exact', head: true })
          );
          if (!count) continue;
          huerfanas += count;
          if (!APLICAR) {
            console.log(`      ${tabla}: ${count} filas`);
            continue;
          }
          const n = await borrarPorPaginas(tabla, filtro);
          console.log(`\r      ${tabla}: ${n} borradas ✓                    `);
        }
        if (APLICAR) {
          const l = db.from('conversiones_offline_sync_log').delete().eq('cliente_id', cliente.id);
          await (nulo ? l.is('sheet_id', null) : l.eq('sheet_id', sheetId));
        }
      }
    }

    // La antigua «pasada 2» (lotes viejos dentro de un sheet vigente) se retiró
    // el 2026-09-14: suponía un único `sync_batch_id` vivo por sheet, y desde la
    // migración 069 las filas que no cambian conservan A PROPÓSITO el lote en que
    // se escribieron. Con varios lotes legítimos, borraba filas buenas de
    // `sheet_filas`. La poda por número de fila del propio sync ya cubre ese caso.
  }

  console.log(`\n\n${APLICAR ? 'Retiradas' : 'Sobran'}: ${huerfanas} filas huérfanas`);
  if (!APLICAR) console.log('Vuelve a lanzarlo con --apply para borrarlas.');
}

main().catch((e) => {
  console.error('\n', e.message);
  process.exit(1);
});
