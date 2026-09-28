/**
 * Métricas NO aditivas del dashboard (auditoría de superficies, 2026-09-28).
 *
 * El dashboard sumaba todo al agrupar: la frecuencia de 30 días era la suma de
 * 30 frecuencias diarias (y, dentro de un día, la suma de las frecuencias de
 * cada campaña), el rebote de GA4 la suma de rebotes y una columna de
 * porcentaje del Sheet la suma de porcentajes. El BI ya lo hacía bien; el
 * usuario decidió corregir el dashboard y avisar a los clientes. Aquí se fija
 * la definición nueva, igual a la del BI:
 *
 *   · frecuencia = Σimpresiones ÷ Σalcance (día, rango, campaña del ranking);
 *   · rebote y duración media = promedio ponderado por sesiones;
 *   · tasa de calificación = calificados ÷ totales × 100;
 *   · porcentaje del Sheet = promedio ponderado por la cantidad de la fila.
 *
 * Y el rango por defecto de las vistas de un cliente sale del día Colombia.
 *
 * Todo PURO: no toca la base ni la red.
 *
 *   npx tsx --conditions=react-server scripts/verify-agregacion-no-aditivas.ts
 */
import { aggregateFormula, reagregarNoAditivas } from '../src/lib/formula-engine';
import { enrichMetaRow, frecuenciaDeCampanas } from '../src/lib/campaign-filter';
import { aggregateRankingRows } from '../src/lib/ranking-aggregation';
import {
  agruparOfflinePorFecha,
  mergeMetricasDelRango,
  columnasPorcentajeDeFila,
} from '../src/lib/dashboard/merge-metrics';
import { hoyCliente, rangoPorDefectoCliente } from '../src/lib/colombia-date';

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? ` — ${detalle}` : ''));
  }
}
function sec(t: string) {
  console.log(`\n── ${t}`);
}
const cerca = (a: number | null | undefined, b: number) =>
  typeof a === 'number' && Math.abs(a - b) < 1e-9;

sec('Frecuencia dentro de un día (enrichMetaRow)');
{
  const fila = {
    fecha: '2026-09-01',
    meta_spend: 0,
    meta_campaigns: [
      { name: 'A', spend: 10, impressions: 200, reach: 100, frequency: 2 },
      { name: 'B', spend: 10, impressions: 300, reach: 100, frequency: 3 },
    ],
  };
  const e = enrichMetaRow(fila, '');
  check(
    'dos campañas (2 y 3) → 500/200 = 2,5, no 5',
    cerca(e.meta_frequency, 2.5),
    String(e.meta_frequency)
  );
  check(
    'campaña antigua sin `reach`: aporta impresiones ÷ frecuencia',
    cerca(frecuenciaDeCampanas([{ impressions: 400, frequency: 2 }]), 2)
  );
  check('sin impresiones ni alcance → 0', frecuenciaDeCampanas([]) === 0);
}

sec('Frecuencia, rebote y duración en el rango (aggregateFormula)');
{
  const filas = [
    {
      fecha: '2026-09-01',
      meta_impressions: 1000,
      meta_reach: 500,
      meta_frequency: 2,
      ga_sessions: 100,
      ga_bounce_rate: 0.5,
      ga_avg_session_duration: 30,
    },
    {
      fecha: '2026-09-02',
      meta_impressions: 3000,
      meta_reach: 1000,
      meta_frequency: 3,
      ga_sessions: 300,
      ga_bounce_rate: 0.3,
      ga_avg_session_duration: 70,
    },
  ];
  check(
    'frecuencia del rango = 4000/1500, no 2 + 3',
    cerca(aggregateFormula('meta_frequency', filas), 4000 / 1500),
    String(aggregateFormula('meta_frequency', filas))
  );
  check(
    'rebote ponderado por sesiones = (0,5·100 + 0,3·300)/400 = 0,35',
    cerca(aggregateFormula('ga_bounce_rate', filas), 0.35),
    String(aggregateFormula('ga_bounce_rate', filas))
  );
  check(
    'duración ponderada = (30·100 + 70·300)/400 = 60',
    cerca(aggregateFormula('ga_avg_session_duration', filas), 60),
    String(aggregateFormula('ga_avg_session_duration', filas))
  );
  check(
    'una fórmula sobre la tasa usa la tasa recalculada (× 100 = 35)',
    cerca(aggregateFormula('ga_bounce_rate * 100', filas), 35)
  );
  check(
    'sin sesiones en el rango → «—» (null), no 0',
    aggregateFormula('ga_bounce_rate', [{ fecha: '2026-09-01', ga_bounce_rate: 0.4 }]) === null
  );
  check(
    'sin alcance → frecuencia «—»',
    aggregateFormula('meta_frequency', [{ fecha: '2026-09-01', meta_impressions: 10 }]) === null
  );
  check(
    'el alcance sigue siendo la suma de alcances diarios (1500), como el BI',
    aggregateFormula('meta_reach', filas) === 1500
  );
  check('las impresiones siguen sumándose', aggregateFormula('meta_impressions', filas) === 4000);
}

sec('Tasa de calificación del rango');
{
  const filas = [
    { fecha: '2026-09-01', leads_totales: 10, leads_calificados: 5, tasa_calificacion: 50 },
    { fecha: '2026-09-02', leads_totales: 30, leads_calificados: 3, tasa_calificacion: 10 },
  ];
  check(
    '8/40 = 20 %, no 50 + 10',
    cerca(aggregateFormula('tasa_calificacion', filas), 20),
    String(aggregateFormula('tasa_calificacion', filas))
  );
}

sec('reagregarNoAditivas sobre totales propios (API de métricas)');
{
  const filas = [
    { meta_impressions: 100, meta_reach: 50, meta_frequency: 2 },
    { meta_impressions: 300, meta_reach: 50, meta_frequency: 6 },
  ];
  const tot: Record<string, number | null> = {
    meta_impressions: 400,
    meta_reach: 100,
    meta_frequency: 8,
  };
  reagregarNoAditivas(tot, filas);
  check('frecuencia 400/100 = 4', tot.meta_frequency === 4, String(tot.meta_frequency));
  const sinClave: Record<string, number | null> = { meta_spend: 5 };
  reagregarNoAditivas(sinClave, [{ meta_spend: 5 }]);
  check('no añade claves que el total no tenía', !('meta_frequency' in sinClave));
}

sec('Ranking por campaña: la frecuencia no se suma entre días');
{
  const metrics = [
    {
      fecha: '2026-09-01',
      meta_campaigns: [
        { campaign_id: 'c1', name: 'C1', spend: 10, impressions: 200, reach: 100, frequency: 2 },
      ],
    },
    {
      fecha: '2026-09-02',
      meta_campaigns: [
        { campaign_id: 'c1', name: 'C1', spend: 10, impressions: 600, reach: 200, frequency: 3 },
      ],
    },
  ];
  const [c1] = aggregateRankingRows(metrics, 'campaigns');
  check('C1: 800/300, no 2 + 3', cerca(c1?.meta_frequency, 800 / 300), String(c1?.meta_frequency));
}

sec('Porcentajes del Sheet: promedio ponderado por cantidad, como el BI');
{
  const offline = [
    {
      fecha: '2026-09-01',
      tipo: 'lead',
      cantidad: 1,
      custom_fields: { tasa_cierre: 40, monto: 10 },
    },
    {
      fecha: '2026-09-01',
      tipo: 'lead',
      cantidad: 3,
      custom_fields: { tasa_cierre: 20, monto: 5 },
    },
    { fecha: '2026-09-02', tipo: 'lead', cantidad: 4, custom_fields: { tasa_cierre: 50 } },
  ];
  const pct = new Set(['tasa_cierre']);
  const porFecha = agruparOfflinePorFecha(offline, pct);
  const d1 = porFecha.get('2026-09-01')!.summary;
  check(
    'día 1: (40·1 + 20·3)/4 = 25, no 60',
    cerca(d1.sheet_tasa_cierre, 25),
    String(d1.sheet_tasa_cierre)
  );
  check('una columna que no es porcentaje se sigue sumando (15)', d1.sheet_monto === 15);

  const filas = mergeMetricasDelRango({
    metricas: [
      { fecha: '2026-09-01', meta_spend: 1 },
      { fecha: '2026-09-02', meta_spend: 1 },
    ],
    leads: [],
    offlinePorFecha: porFecha,
    sheetPorFecha: new Map(),
    leadsLegacyPorFecha: new Map(),
  });
  check(
    'rango: (40 + 60 + 200)/8 = 37,5, no 25 + 50',
    cerca(aggregateFormula('sheet_tasa_cierre', filas), 37.5),
    String(aggregateFormula('sheet_tasa_cierre', filas))
  );
  check(
    'la fila deja ver qué columnas son porcentaje (para el filtro de Sheet)',
    columnasPorcentajeDeFila(filas[0]).has('tasa_cierre') &&
      !columnasPorcentajeDeFila(filas[0]).has('monto')
  );
  const sinConfig = agruparOfflinePorFecha(offline);
  check(
    'sin la config del cliente se suma como antes (60)',
    sinConfig.get('2026-09-01')!.summary.sheet_tasa_cierre === 60
  );
}

sec('Rango por defecto de un cliente: día Colombia');
{
  // 2026-09-29 02:00 UTC = 2026-09-28 21:00 en Colombia.
  const noche = new Date('2026-09-29T02:00:00Z');
  check('hoyCliente usa el día Colombia', hoyCliente(undefined, noche) === '2026-09-28');
  const r = rangoPorDefectoCliente(30, undefined, noche);
  check(
    '30 días inclusive: 2026-08-30 → 2026-09-28',
    r.from === '2026-08-30' && r.to === '2026-09-28',
    JSON.stringify(r)
  );
}

console.log(`\n${ok} ok, ${fail} fallos`);
if (fail > 0) process.exit(1);
