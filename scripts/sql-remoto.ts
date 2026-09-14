/**
 * SQL contra la base del proyecto vía Management API de Supabase.
 *
 * PostgREST no ejecuta DDL ni hace GROUP BY libre, y el repo no tiene cadena de
 * conexión directa: el único camino para aplicar una migración o inspeccionar el
 * esquema sin abrir Studio es `POST /v1/projects/{ref}/database/query` con el
 * `SUPABASE_ACCESS_TOKEN` de `.env.local`. Es el mismo que ya usan
 * `detectar-dias-nulos.ts` e `informe-tz-colombia.ts`.
 *
 *   npx tsx scripts/sql-remoto.ts migrations/079_leads_excluidos_y_mapeo_por_nivel.sql
 *   npx tsx scripts/sql-remoto.ts --query="select count(*) from report_utm.lead_events"
 *
 * Un archivo se envía ENTERO en una sola petición: la Management API lo ejecuta
 * como una transacción implícita, así que una migración que falla a la mitad no
 * deja la base a medias. Por eso las migraciones de este repo son idempotentes:
 * volver a aplicarlas tras un fallo es seguro.
 */

import { readFileSync } from 'node:fs';

function envLocal(): (k: string) => string {
  const env = readFileSync('.env.local', 'utf8');
  return (k: string) =>
    env
      .split('\n')
      .find((l) => l.startsWith(`${k}=`))
      ?.slice(k.length + 1)
      .trim()
      .replace(/^"|"$/g, '') ?? '';
}

export async function sqlRemoto<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const get = envLocal();
  const proj = get('NEXT_PUBLIC_SUPABASE_URL')
    .replace(/.*https:\/\//, '')
    .replace(/\.supabase\.co.*/, '');
  const token = get('SUPABASE_ACCESS_TOKEN');
  if (!proj || !token) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_ACCESS_TOKEN en .env.local');
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${proj}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${texto.slice(0, 2000)}`);
  return (texto ? JSON.parse(texto) : []) as T[];
}

async function main() {
  const args = process.argv.slice(2);
  const q = args.find((a) => a.startsWith('--query='));
  const archivo = args.find((a) => !a.startsWith('--'));

  if (!q && !archivo) {
    console.error('Uso: npx tsx scripts/sql-remoto.ts <archivo.sql> | --query="..."');
    process.exit(2);
  }

  const query = q ? q.slice('--query='.length) : readFileSync(archivo!, 'utf8');
  const filas = await sqlRemoto(query);
  if (archivo && !q) console.log(`✅ Aplicado ${archivo}`);
  if (filas.length > 0) console.log(JSON.stringify(filas, null, 2));
}

// Solo corre como CLI; importado desde otro script expone `sqlRemoto`.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/sql-remoto.ts')) {
  main().catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
