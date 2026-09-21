/**
 * Limpia el histórico de `report_utm.lead_events.page_url` (migración 084).
 *
 * En seco por defecto: cuenta lo que haría sin tocar nada.
 *
 *   npx tsx --conditions=react-server scripts/backfill-page-url.ts            # informe
 *   npx tsx --conditions=react-server scripts/backfill-page-url.ts --aplicar  # escribe
 *
 * Quita de cada URL los parámetros que ya viven en columnas de la misma fila
 * (`utm_*`, `fbclid`, `gclid`, `ttclid`…) y conserva los propios del cliente
 * (`lpt`, `hsa_*`, `brid`…). Medido antes de empezar: 42 MB → ~6 MB.
 *
 * Va POR LOTES y por la Management API, no por PostgREST, por dos razones:
 * PostgREST corta a los 8 s, y un UPDATE de las 93.000 filas de una vez es justo
 * la clase de operación que tumbó la base el 2026-09-20.
 *
 * Es reanudable: `backfill_page_url` solo mira las filas que aún tienen algo que
 * limpiar, así que si se corta a medias basta con volver a lanzarlo.
 *
 * Requiere la 084 aplicada.
 */

import { sqlRemoto } from './sql-remoto';

const LOTE = 2000;
/** Tope de vueltas: 93.000 filas / 2.000 son ~47, el resto es margen. */
const MAX_VUELTAS = 200;

const aplicar = process.argv.includes('--aplicar');

async function main() {
  const [{ pendientes, peso }] = await sqlRemoto<{ pendientes: number; peso: string }>(
    `select count(*) as pendientes,
            pg_size_pretty(sum(pg_column_size(page_url))) as peso
     from report_utm.lead_events
     where page_url ~* '[?&](utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id)='`
  );

  console.log(`Filas con parámetros duplicados: ${pendientes}`);
  console.log(`Peso actual de esas page_url:    ${peso}`);

  if (Number(pendientes) === 0) {
    console.log('\n✅ Nada que limpiar.');
    return;
  }

  const [{ despues }] = await sqlRemoto<{ despues: string }>(
    `select pg_size_pretty(sum(pg_column_size(report_utm.limpiar_page_url(page_url)))) as despues
     from report_utm.lead_events
     where page_url ~* '[?&](utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id)='`
  );
  console.log(`Peso después de limpiarlas:      ${despues}`);

  if (!aplicar) {
    console.log('\n🔍 En seco. Añade --aplicar para escribir.');
    return;
  }

  console.log(`\nAplicando en lotes de ${LOTE}…`);
  let total = 0;
  for (let vuelta = 1; vuelta <= MAX_VUELTAS; vuelta++) {
    const [{ tocadas }] = await sqlRemoto<{ tocadas: number }>(
      `select report_utm.backfill_page_url(${LOTE}) as tocadas`
    );
    const n = Number(tocadas);
    total += n;
    if (n === 0) {
      console.log(`\n✅ Terminado: ${total} filas limpiadas.`);
      return;
    }
    console.log(`  lote ${vuelta}: ${n} filas (acumulado ${total})`);
  }

  console.log(
    `\n⚠️  Alcanzado el tope de ${MAX_VUELTAS} vueltas con ${total} filas limpiadas.` +
      ' Vuelve a lanzarlo para continuar: es reanudable.'
  );
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
