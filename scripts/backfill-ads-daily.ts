/**
 * Backfill de `public.ads_daily` desde los JSONB de `public.metricas_diarias`.
 *
 * Requiere que la migración 063 esté aplicada.
 *
 * ── Alcance ─────────────────────────────────────────────────────────────
 * Campaña y conjunto SIEMPRE; nivel anuncio solo los últimos 30 días. Es lo que
 * hace que la tabla quepa: el nivel anuncio es el 65% de las filas (111.800 de
 * 171.666) y la base está en 293 MB contra un tope de 500 MB.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────
 *   # Ensayo: no escribe nada, dice cuánto escribiría
 *   npx tsx scripts/backfill-ads-daily.ts --dry-run
 *
 *   # Ejecutar
 *   npx tsx scripts/backfill-ads-daily.ts
 *
 *   # Comprobar que lo escrito cuadra con metricas_diarias
 *   npx tsx scripts/backfill-ads-daily.ts --verificar
 *
 * Opciones: --cliente=<uuid>  --desde=YYYY-MM-DD  --hasta=YYYY-MM-DD  --lote=500
 *
 * Es IDEMPOTENTE (upsert por la clave del UNIQUE) y REANUDABLE (--desde).
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { expandirFila, nivelesParaFecha } from '../src/lib/ads/ads-daily-writer';
import type { AdsDailyRow, MetricasDiariasRow } from '../src/lib/ads/ads-daily-writer';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, def?: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : def;
};

const DRY = flag('dry-run');
const VERIFICAR = flag('verificar');
const LOTE = Number(opt('lote', '500'));
const CLIENTE = opt('cliente');
const DESDE = opt('desde');
const HASTA = opt('hasta');

const money = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 });

/**
 * Reintenta una operación ante fallos TRANSITORIOS de la base.
 *
 * Hizo falta de verdad: a mitad de la primera corrida la instancia devolvió
 * `57P03: the database system is not accepting connections / Hot standby mode is
 * disabled` — un reinicio del lado de Supabase, con el proyecto reportando
 * `ACTIVE_HEALTHY`. Se recuperó sola en menos de un minuto. Un backfill de 8.000
 * días no puede abortar entero por eso, sobre todo cuando ya escribió la mitad.
 *
 * Solo reintenta lo que parece transitorio. Un error de esquema o de permisos se
 * propaga a la primera: reintentarlo solo retrasaría el diagnóstico.
 */
const TRANSITORIOS = [
  'not accepting connections',
  'schema cache',
  'timeout',
  'fetch failed',
  'ECONNRESET',
  'terminating connection',
  '57P03',
];

async function conReintentos<T>(etiqueta: string, fn: () => Promise<T>, intentos = 5): Promise<T> {
  let ultimo: unknown;
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      const msg = (e as Error)?.message ?? String(e);
      if (!TRANSITORIOS.some((t) => msg.includes(t))) throw e;
      if (i === intentos) break;
      const espera = 3000 * i; // 3s, 6s, 9s, 12s
      process.stdout.write(
        `\n  ⚠ ${etiqueta}: ${msg.slice(0, 80)} — reintento ${i}/${intentos - 1} en ${espera / 1000}s\n`
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const db = await createAdminClient();

  // `hoy` se fija UNA vez: si se recalculara por fila, la ventana del nivel
  // anuncio podría moverse a mitad de la corrida y dejar días a medias.
  const hoy = new Date().toISOString().slice(0, 10);

  if (VERIFICAR) return verificar(db, hoy);

  console.log(`\nBackfill de ads_daily${DRY ? '  [ENSAYO, no escribe]' : ''}`);
  console.log(`  ventana del nivel anuncio: últimos 30 días (hoy = ${hoy})`);

  // ── Recorrido paginado de metricas_diarias ───────────────────────
  let desde = DESDE ?? '2000-01-01';
  let totalDias = 0;
  let totalFilas = 0;
  let escritas = 0;
  const porNivel: Record<string, number> = { campaign: 0, adset: 0, ad: 0 };

  // Se pagina por FECHA y no por offset: con offset, escribir a la vez que se
  // lee desplaza la ventana y se saltan filas.
  for (;;) {
    let q = db
      .from('metricas_diarias')
      .select(
        'cliente_id,fecha,meta_campaigns,meta_adsets,meta_ads,tiktok_campaigns,tiktok_adgroups,tiktok_ads'
      )
      .gte('fecha', desde)
      .order('fecha', { ascending: true })
      .order('cliente_id', { ascending: true })
      .limit(LOTE);
    if (CLIENTE) q = q.eq('cliente_id', CLIENTE);
    if (HASTA) q = q.lte('fecha', HASTA);

    const filas = await conReintentos(`leyendo desde ${desde}`, async () => {
      const { data, error } = await q;
      if (error) throw new Error(`Leyendo metricas_diarias: ${error.message}`);
      return (data ?? []) as unknown as MetricasDiariasRow[];
    });
    if (!filas.length) break;

    const salida: AdsDailyRow[] = [];
    for (const f of filas) {
      totalDias++;
      const expandidas = expandirFila(f, { hoy, origen: 'backfill' });
      for (const r of expandidas) porNivel[r.nivel]++;
      salida.push(...expandidas);
    }
    totalFilas += salida.length;

    if (!DRY && salida.length) {
      // En trozos: un insert de miles de filas supera el límite de payload.
      for (let i = 0; i < salida.length; i += 1000) {
        const trozo = salida.slice(i, i + 1000);
        // El upsert es idempotente por la clave del UNIQUE, así que
        // reintentar un trozo ya escrito no duplica nada.
        await conReintentos(`escribiendo ${trozo.length} filas`, async () => {
          const { error: e2 } = await db.from('ads_daily').upsert(trozo, {
            onConflict: 'cliente_id,fecha,plataforma,nivel,entidad_key',
          });
          if (e2) throw new Error(`Escribiendo ads_daily: ${e2.message}`);
        });
        escritas += trozo.length;
      }
    }

    const ultima = filas[filas.length - 1];
    process.stdout.write(`\r  ${totalDias} días · ${totalFilas} filas · hasta ${ultima.fecha}   `);

    // Si el lote no se llenó, se acabó.
    if (filas.length < LOTE) break;
    // Avanza al día siguiente para no releer el último (puede haber varios
    // clientes en la misma fecha; el `>=` los recogería otra vez, y el upsert
    // lo hace inofensivo).
    desde = ultima.fecha;
    // Corte de seguridad: si la fecha no avanza, se sale en vez de girar.
    if (DESDE && desde === DESDE && totalDias > LOTE * 4) break;
  }

  console.log(`\n\n  Resumen:`);
  console.log(`    días leídos      ${totalDias}`);
  console.log(`    filas generadas  ${totalFilas}`);
  console.log(`      campaña        ${porNivel.campaign}`);
  console.log(`      conjunto       ${porNivel.adset}`);
  console.log(`      anuncio        ${porNivel.ad}   (solo últimos 30 días)`);
  if (DRY) {
    console.log(`\n  ENSAYO: no se escribió nada. Quita --dry-run para ejecutar.`);
  } else {
    console.log(`    filas escritas   ${escritas}`);
    console.log(`\n  Ahora comprueba que cuadra:`);
    console.log(`    npx tsx scripts/backfill-ads-daily.ts --verificar`);
  }
  console.log('');
}

/**
 * Comprueba que lo escrito cuadra con el origen.
 *
 * La invariante que importa: para cada (cliente, fecha), la suma del gasto de
 * `ads_daily` al NIVEL CAMPAÑA tiene que igualar la suma del array
 * `meta_campaigns` / `tiktok_campaigns` del que salió.
 *
 * NO se compara contra las columnas escalares `meta_spend`/`tiktok_spend`: el
 * módulo ya documenta que el array puede quedar incompleto respecto al gasto de
 * cuenta, y ese desajuste es un problema del sync, anterior a esta tabla.
 * Compararlo aquí mezclaría dos fallos distintos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function verificar(db: any, hoy: string) {
  console.log('\nVerificación de ads_daily contra metricas_diarias\n');

  let q = db
    .from('metricas_diarias')
    .select(
      'cliente_id,fecha,meta_campaigns,meta_adsets,meta_ads,tiktok_campaigns,tiktok_adgroups,tiktok_ads'
    )
    .order('fecha', { ascending: false })
    .limit(400);
  if (CLIENTE) q = q.eq('cliente_id', CLIENTE);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const filas = (data ?? []) as unknown as MetricasDiariasRow[];

  let comprobados = 0;
  let descuadres = 0;
  let faltantes = 0;
  const detalles: string[] = [];

  for (const f of filas) {
    const esperadas = expandirFila(f, { hoy, origen: 'backfill' });
    if (!esperadas.length) continue;

    const { data: reales, error: e2 } = await db
      .from('ads_daily')
      .select('nivel,plataforma,entidad_key,spend,impressions,clicks')
      .eq('cliente_id', f.cliente_id)
      .eq('fecha', f.fecha);
    if (e2) throw new Error(e2.message);

    const mapaReal = new Map<string, { spend: number; impressions: number; clicks: number }>();
    for (const r of (reales ?? []) as Array<Record<string, unknown>>) {
      mapaReal.set(`${r.plataforma}|${r.nivel}|${r.entidad_key}`, {
        spend: Number(r.spend),
        impressions: Number(r.impressions),
        clicks: Number(r.clicks),
      });
    }

    for (const esp of esperadas) {
      comprobados++;
      const k = `${esp.plataforma}|${esp.nivel}|${esp.entidad_key}`;
      const real = mapaReal.get(k);
      if (!real) {
        faltantes++;
        if (detalles.length < 10) detalles.push(`FALTA ${f.fecha} ${k}`);
        continue;
      }
      if (Math.abs(real.spend - esp.spend) > 0.01) {
        descuadres++;
        if (detalles.length < 10) {
          detalles.push(
            `GASTO ${f.fecha} ${k}: esperado ${money(esp.spend)} vs ${money(real.spend)}`
          );
        }
      }
    }

    // Sobrantes: filas en ads_daily que el origen ya no produce. Con la
    // retención del nivel anuncio esto es NORMAL para fechas viejas, así que
    // solo se reporta dentro de la ventana.
    const nivelesHoy = new Set(nivelesParaFecha(f.fecha, hoy));
    for (const [k] of mapaReal) {
      const nivel = k.split('|')[1];
      if (!nivelesHoy.has(nivel as 'campaign' | 'adset' | 'ad')) continue;
      if (!esperadas.some((e) => `${e.plataforma}|${e.nivel}|${e.entidad_key}` === k)) {
        if (detalles.length < 10) detalles.push(`SOBRA ${f.fecha} ${k}`);
      }
    }
  }

  console.log(`  entidades comprobadas   ${comprobados}`);
  console.log(`  faltantes en ads_daily  ${faltantes}`);
  console.log(`  descuadres de gasto     ${descuadres}`);
  if (detalles.length) {
    console.log('\n  Primeros casos:');
    for (const d of detalles) console.log(`    · ${d}`);
  }

  const ok = faltantes === 0 && descuadres === 0;
  console.log(
    `\n${ok ? '✓ ads_daily cuadra con metricas_diarias' : '✗ hay diferencias — revisar antes de leer de ads_daily'}\n`
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✗ Fallo:', e?.message ?? e);
  process.exit(1);
});
