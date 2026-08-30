/**
 * Segmentos de campo de lead contra datos REALES.
 *
 * Comprueba las tres cosas que la versión pura no puede:
 *
 *   1. El motor del BI devuelve el conteo del segmento, y lo devuelve igual
 *      agrupando por fecha que en el total. Un segmento que se descuadra al
 *      cambiar la dimensión es el fallo clásico de este motor.
 *   2. **El gasto NO se anula.** Es la razón de ser de la familia: un segmento es
 *      una medida, no un filtro, así que `spend / lseg__x` tiene que dar un CPL
 *      de verdad. El caso espejo —el mismo widget con un FILTRO `leadfield:`—
 *      tiene que seguir dejando el gasto en 0.
 *   3. Los dos consumidores coinciden: el número que da el motor del BI y el que
 *      sale del cubo del dashboard son el mismo. Si divergieran, la misma
 *      pregunta daría dos cifras según la pantalla.
 *
 *   npx tsx scripts/verify-lead-segmentos-db.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

// Estático y no dinámico como el resto: son funciones puras de fecha, sin red ni
// `server-only`, y hacen falta antes de entrar en `main()`.
import { addDaysISO, colombiaToday } from '../src/lib/colombia-date';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// El rango termina en el PASADO, no hoy, y es lo que hace fiable a este script.
//
// Todas sus comprobaciones cruzan números tomados en momentos distintos: el
// total del BI se mide al arrancar y el cubo del dashboard varios minutos
// después. Con una ventana que llega hasta hoy, cualquier lead que entre
// mientras el script corre cae DENTRO de lo comparado y solo lo ve la segunda
// lectura. El síntoma era un fallo intermitente —una de cada tres pasadas— con
// el dashboard siempre un punto por encima del BI (`7135 vs 7134`), que tenía
// toda la pinta de un error de cálculo y era la ventana moviéndose sola.
//
// El margen es de dos días, no de uno: un webhook de Meta o de GoHighLevel que
// llegue tarde inserta el lead con SU hora, no con la de llegada, así que ayer
// todavía puede recibir filas. Anteayer ya no.
//
// Día Colombia, que es el grano con el que agrupan las dos rutas.
const HASTA = addDaysISO(colombiaToday(), -2);
const DESDE = addDaysISO(HASTA, -180);

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { runBiQuery } = await import('../src/lib/report-utm/bi-query');
  const { loadLeadCampos, loadLeadSegmentos } =
    await import('../src/lib/report-utm/lead-campos-db');
  const { cargarRespuestasLead } = await import('../src/lib/report-utm/lead-answers-db');
  const { clavesDelDia, campanasPermitidas, claveSegmento } =
    await import('../src/lib/dashboard/lead-answer-aggregation');
  const { makeLeadSegMetric, makeLeadFieldDim } = await import('../src/lib/report-utm/bi-metadata');

  const db = await createAdminClient();
  const rtm = db.schema('report_utm');

  // `.order()` no es decorativo: sin él PostgREST no garantiza ningún orden, así
  // que «el primer cliente con segmentos» podía ser otro en cada pasada y un
  // fallo no se dejaba reproducir. Un verificador tiene que elegir siempre el
  // mismo caso.
  const { data: clientes } = await rtm
    .from('clientes')
    .select('id,nombre')
    .eq('status', 'active')
    .order('nombre');

  // Se prueba con el primer cliente que tenga segmentos configurados: sin
  // ninguno no hay nada que verificar y el script no debe fallar por eso.
  let elegido: { id: string; nombre: string } | null = null;
  let campos: any[] = [];
  let segmentos: any[] = [];
  for (const c of (clientes ?? []) as any[]) {
    const cs = await loadLeadCampos(rtm, c.id, { soloActivos: true });
    if (cs.length === 0) continue;
    const ss = await loadLeadSegmentos(rtm, c.id, cs, { soloActivos: true });
    if (ss.length === 0) continue;
    elegido = c;
    campos = cs;
    segmentos = ss;
    break;
  }

  if (!elegido) {
    console.log('\n⚠ Ningún cliente tiene segmentos configurados: nada que verificar.\n');
    return;
  }

  const seg = segmentos[0];
  const campo = campos.find((c) => c.clave === seg.campo_clave)!;
  console.log(`\nCliente: ${elegido.nombre} · campo «${campo.nombre}» · segmento «${seg.nombre}»`);
  console.log(`Rango: ${DESDE} → ${HASTA}\n`);

  const token = makeLeadSegMetric(seg.clave);

  // ── 1. El motor devuelve el conteo, y cuadra al cambiar de dimensión ──
  console.log('── El motor del BI cuenta el segmento ─────────────────────');

  const [total] = await runBiQuery({
    cliente_id: elegido.id,
    date_from: DESDE,
    date_to: HASTA,
    metrics: [token, 'leads_count', 'spend'] as any,
    dimension: 'none',
  });
  const valorTotal = Number(total?.[token] ?? 0);
  const leads = Number(total?.leads_count ?? 0);

  check('el segmento devuelve un número', Number.isFinite(valorTotal));
  check('no cuenta más leads de los que hay', valorTotal <= leads, `${valorTotal} > ${leads}`);

  const porFecha = await runBiQuery({
    cliente_id: elegido.id,
    date_from: DESDE,
    date_to: HASTA,
    metrics: [token] as any,
    dimension: 'date',
    date_grouping: 'day',
  });
  const sumaDias = porFecha.reduce((n, r) => n + Number((r as any)[token] ?? 0), 0);
  check(
    'agrupado por fecha suma lo mismo que el total',
    sumaDias === valorTotal,
    `${sumaDias} vs ${valorTotal}`
  );

  const porCampana = await runBiQuery({
    cliente_id: elegido.id,
    date_from: DESDE,
    date_to: HASTA,
    metrics: [token] as any,
    dimension: 'utm_campaign',
  });
  const sumaCampanas = porCampana.reduce((n, r) => n + Number((r as any)[token] ?? 0), 0);
  check(
    'agrupado por campaña suma lo mismo que el total',
    sumaCampanas === valorTotal,
    `${sumaCampanas} vs ${valorTotal}`
  );

  // ── 2. La regla del gasto ─────────────────────────────────────────────
  console.log('\n── El gasto: métrica no lo anula, filtro sí ───────────────');

  const [conFormula] = await runBiQuery({
    cliente_id: elegido.id,
    date_from: DESDE,
    date_to: HASTA,
    metrics: ['spend'] as any,
    dimension: 'none',
    calculated: [{ name: 'cpl_seg', expression: `spend / lseg__${seg.clave}` }],
  } as any);
  const gasto = Number(conFormula?.spend ?? 0);
  const cpl = Number((conFormula as any)?.cpl_seg ?? 0);

  if (gasto === 0) {
    console.log(`  · el cliente no tiene gasto en el rango: no se puede comprobar el CPL`);
  } else {
    check('el gasto NO se anula con un segmento en la fórmula', gasto > 0);
    check(
      'la fórmula `spend / lseg__…` da un CPL',
      valorTotal === 0 ? cpl === 0 : cpl > 0,
      `cpl=${cpl}, seg=${valorTotal}, spend=${gasto}`
    );

    // El caso espejo: con un FILTRO por campo de lead el gasto sí se anula, y
    // eso no puede cambiar. Es lo que impide inventar un CPL por respuesta.
    const [conFiltro] = await runBiQuery({
      cliente_id: elegido.id,
      date_from: DESDE,
      date_to: HASTA,
      metrics: ['spend', 'leads_count'] as any,
      dimension: 'none',
      filters: { [makeLeadFieldDim(campo.clave)]: seg.valores[0] ?? '(otros)' },
    } as any);
    check(
      'un FILTRO por campo de lead sigue anulando el gasto',
      Number(conFiltro?.spend ?? 0) === 0,
      String(conFiltro?.spend)
    );
  }

  // ── 3. Los dos consumidores dan el mismo número ───────────────────────
  console.log('\n── BI y dashboard coinciden ───────────────────────────────');

  const ds = await cargarRespuestasLead(
    rtm,
    elegido.id,
    DESDE,
    HASTA,
    [campo],
    { [campo.clave]: 'catalogo' },
    true,
    {
      [campo.clave]: segmentos
        .filter((s) => s.campo_clave === campo.clave)
        .map((s) => ({
          clave: s.clave,
          nombre: s.nombre,
          operador: s.operador,
          valores: s.valores,
        })),
    }
  );

  const permitidas = campanasPermitidas(ds as any, undefined, undefined, undefined);
  let desdeCubo = 0;
  for (const fecha of Object.keys(ds.porFecha)) {
    desdeCubo += clavesDelDia(ds as any, fecha, permitidas)[claveSegmento(seg)] ?? 0;
  }

  if (ds.incompleto) {
    console.log('  · el cubo llegó truncado en este rango: se omite la comparación');
  } else {
    check(
      'el cubo del dashboard da el mismo conteo que el motor del BI',
      desdeCubo === valorTotal,
      `dashboard=${desdeCubo} vs bi=${valorTotal}`
    );
  }

  console.log(
    fallos === 0
      ? '\n✅ Segmentos contra datos reales: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
