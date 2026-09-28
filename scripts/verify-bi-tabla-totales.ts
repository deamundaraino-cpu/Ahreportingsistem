/**
 * Fila «Total» de la tabla del BI (auditoría de superficies, 2026-09-28).
 *
 * La tabla totalizaba los ratios sobre bases que no pedía al motor: una tabla de
 * «campaña × CPL» mostraba «$0,00» en el Total porque no tenía ni gasto ni
 * leads. Y un denominador en 0 daba 0 en vez de «—». Aquí se fija:
 *
 *   · las bases de cada ratio visible se piden ocultas (`basesOcultasDeRatios`);
 *   · el ratio del Total se recalcula sobre las bases sumadas;
 *   · base ausente o denominador 0 → null («—»);
 *   · con el Top-N recortando filas, el rótulo dice «Total (filas visibles)».
 *
 * Todo PURO: no toca la base ni la red.
 *
 *   npx tsx --conditions=react-server scripts/verify-bi-tabla-totales.ts
 */
import {
  calcularTotalesTabla,
  basesOcultasDeRatios,
  rotuloFilaTotal,
} from '../src/lib/report-utm/bi-table-totals';

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

sec('Bases ocultas');
{
  const b = basesOcultasDeRatios(['cpl', 'roas']);
  check(
    'CPL + ROAS piden gasto, leads y revenue',
    ['spend', 'leads_count', 'revenue'].every((k) => b.includes(k)),
    JSON.stringify(b)
  );
  check(
    'no repite una base que ya es columna',
    !basesOcultasDeRatios(['spend', 'cpl']).includes('spend')
  );
  check('una aditiva no pide nada', basesOcultasDeRatios(['leads_count']).length === 0);
  check(
    'el rebote pide las sesiones para ponderar',
    basesOcultasDeRatios(['ga_bounce_rate']).includes('ga_sessions')
  );
}

sec('Ratios del Total sobre bases ocultas');
{
  // La tabla visible es solo «campaña × CPL»; el gasto y los leads llegan ocultos.
  const rows = [
    { dimension_value: 'A', cpl: 10, spend: 100, leads_count: 10 },
    { dimension_value: 'B', cpl: 20, spend: 200, leads_count: 10 },
  ];
  const t = calcularTotalesTabla({ rows, colKeys: ['cpl'] });
  check('CPL total = 300/20 = 15 (no 0, no 30)', t.cpl === 15, String(t.cpl));

  const sinBases = calcularTotalesTabla({
    rows: [{ dimension_value: 'A', cpl: 10 }],
    colKeys: ['cpl'],
  });
  check('sin las bases → null («—»), no 0', sinBases.cpl === null, String(sinBases.cpl));

  const gastoAnulado = calcularTotalesTabla({
    rows: [{ dimension_value: 'A', cpl: null, spend: null, leads_count: 5 }],
    colKeys: ['cpl'],
  });
  check(
    'gasto anulado por el motor (null) → «—»',
    gastoAnulado.cpl === null,
    String(gastoAnulado.cpl)
  );

  const ceroLeads = calcularTotalesTabla({
    rows: [{ dimension_value: 'A', spend: 100, leads_count: 0 }],
    colKeys: ['cpl'],
  });
  check('denominador 0 → «—»', ceroLeads.cpl === null, String(ceroLeads.cpl));

  const roas = calcularTotalesTabla({
    rows: [
      { revenue: 300, spend: 100 },
      { revenue: 100, spend: 100 },
    ],
    colKeys: ['roas', 'ctr'],
  });
  check('ROAS = 400/200 = 2', roas.roas === 2);
  check('CTR sin clics ni impresiones → «—»', roas.ctr === null);

  const cpm = calcularTotalesTabla({
    rows: [{ spend: 50, impressions: 10000 }],
    colKeys: ['cpm'],
  });
  check('CPM = 50/10000 × 1000 = 5', cpm.cpm === 5, String(cpm.cpm));
}

sec('Hotmart: mismas derivadas que el motor');
{
  const t = calcularTotalesTabla({
    rows: [
      { hm_neto: 300, spend: 100, hm_ventas: 3 },
      { hm_neto: 0, spend: 100, hm_ventas: 0 },
    ],
    colKeys: ['hm_roas', 'hm_cpa'],
  });
  check('hm_roas = 300/200 = 1,5', t.hm_roas === 1.5, String(t.hm_roas));
  check('hm_cpa = 200/3', t.hm_cpa === Math.round((200 / 3) * 100) / 100, String(t.hm_cpa));
  const sinVentas = calcularTotalesTabla({
    rows: [{ hm_neto: 0, spend: 100 }],
    colKeys: ['hm_roas'],
  });
  check('hm_roas sin ventas → «—» (como el KPI)', sinVentas.hm_roas === null);
}

sec('Aditivas, frecuencia y GA4');
{
  const t = calcularTotalesTabla({
    rows: [
      { leads_count: 3, reach: 100, frequency: 2 },
      { leads_count: 4, reach: 50, frequency: 3 },
    ],
    colKeys: ['leads_count', 'reach', 'frequency'],
  });
  check('leads suman (7)', t.leads_count === 7);
  check('alcance: sin total (personas únicas)', !('reach' in t));
  check('frecuencia: sin total', !('frequency' in t));

  const nulas = calcularTotalesTabla({
    rows: [{ spend: null }, { spend: null }],
    colKeys: ['spend'],
  });
  check('columna aditiva toda null → «—», no 0', nulas.spend === null);

  const ga = calcularTotalesTabla({
    rows: [
      { ga_bounce_rate: 40, ga_sessions: 100 },
      { ga_bounce_rate: 20, ga_sessions: 300 },
    ],
    colKeys: ['ga_bounce_rate'],
  });
  check('rebote ponderado por sesiones = 25', ga.ga_bounce_rate === 25, String(ga.ga_bounce_rate));
}

sec('Campos calculados y conteos de lead');
{
  const t = calcularTotalesTabla({
    rows: [
      { spend: 100, leads_count: 5 },
      { spend: 50, leads_count: 5 },
    ],
    colKeys: ['cpl_propio'],
    calculados: [{ name: 'cpl_propio', expression: 'spend / leads_count' }],
  });
  check('calculado sobre bases aditivas = 150/10 = 15', t.cpl_propio === 15, String(t.cpl_propio));
  const sinBase = calcularTotalesTabla({
    rows: [{ spend: 100 }],
    colKeys: ['cpl_propio'],
    calculados: [{ name: 'cpl_propio', expression: 'spend / leads_count' }],
  });
  check('calculado con una base ausente → «—»', sinBase.cpl_propio === null);
}

sec('Rótulo de la fila Total');
{
  check(
    'sin recorte ni filtro → «Total»',
    rotuloFilaTotal({ filasRecibidas: 5, filasVisibles: 5, limite: 100 }) === 'Total'
  );
  check(
    'Top-N lleno → «Total (filas visibles)»',
    rotuloFilaTotal({ filasRecibidas: 10, filasVisibles: 10, limite: 10 }) ===
      'Total (filas visibles)'
  );
  check(
    'filtro por valor ocultó filas → «Total (filas visibles)»',
    rotuloFilaTotal({ filasRecibidas: 5, filasVisibles: 3, limite: 100 }) ===
      'Total (filas visibles)'
  );
}

console.log(`\n${ok} ok, ${fail} fallos`);
if (fail > 0) process.exit(1);
