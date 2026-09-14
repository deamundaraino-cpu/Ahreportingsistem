/**
 * Archivos de Storage cuyo cliente ya no existe.
 *
 * `eliminarClienteCompleto` borra desde el 2026-09-14 las imágenes de las
 * bitácoras (`bitacoras-images/{id del reporting}/…`) y los logos de branding
 * (`bitacoras-images/branding/cliente_{id UTM}_…`). Los clientes borrados antes
 * dejaron los suyos, con su URL pública funcionando. Esto los encuentra.
 *
 * No toca el branding global de la app (`branding/logo_…`, `branding/favicon_…`)
 * ni la carpeta `general/` del editor.
 *
 * No se puede deshacer. Sin `--apply` solo lista lo que borraría.
 *
 *   npx tsx scripts/limpiar-storage-huerfano.ts
 *   npx tsx scripts/limpiar-storage-huerfano.ts --apply
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { BUCKET_CLIENTES, listarArchivos } from '../src/lib/clientes/ciclo-de-vida';

loadEnv({ path: '.env.local' });

const APLICAR = process.argv.slice(2).includes('--apply');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO = /^cliente_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  const db = createClient(url, key);

  const [{ data: pubs, error: e1 }, { data: utms, error: e2 }] = await Promise.all([
    db.from('clientes').select('id'),
    db.schema('report_utm').from('clientes').select('id'),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  const publicos = new Set((pubs ?? []).map((c) => c.id as string));
  const deUtm = new Set((utms ?? []).map((c) => c.id as string));

  const bucket = db.storage.from(BUCKET_CLIENTES);
  const huerfanos: string[] = [];

  // Carpetas de bitácoras: el nombre es el id del cliente del reporting.
  const raiz = await listarArchivos(bucket, '', { incluirCarpetas: true });
  for (const carpeta of raiz.filter((n) => UUID.test(n) && !publicos.has(n))) {
    const archivos = await listarArchivos(bucket, carpeta);
    huerfanos.push(...archivos.map((a) => `${carpeta}/${a}`));
  }

  // Logos de branding de informes BI: llevan el id del cliente UTM.
  const logos = await listarArchivos(bucket, 'branding');
  for (const nombre of logos) {
    const id = LOGO.exec(nombre)?.[1];
    if (id && !deUtm.has(id)) huerfanos.push(`branding/${nombre}`);
  }

  if (huerfanos.length === 0) {
    console.log('\nNo hay archivos huérfanos en Storage.\n');
    return;
  }
  console.log(`\n${huerfanos.length} archivo(s) huérfano(s)${APLICAR ? '' : '   [SIMULACIÓN]'}\n`);
  for (const r of huerfanos) console.log(`  ${BUCKET_CLIENTES}/${r}`);

  if (!APLICAR) {
    console.log('\nNada borrado. Repite con --apply para borrarlos.\n');
    return;
  }
  for (let i = 0; i < huerfanos.length; i += 1000) {
    const { error } = await bucket.remove(huerfanos.slice(i, i + 1000));
    if (error) throw new Error(error.message);
  }
  console.log('\n✅ Hecho.\n');
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
