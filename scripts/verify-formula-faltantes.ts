/**
 * Motor de fórmulas del dashboard: «dato faltante» y números en notación
 * científica (auditoría de superficies, 2026-09-28).
 *
 *   1. Un campo sin dato valía 0, así que un ROAS sin Hotmart salía «0.00x»
 *      donde la doc 09 y el BI dicen «—». Ahora un DENOMINADOR sin dato, o una
 *      fórmula cuyos campos faltan todos, da null. Donde el 0 es legítimo (0
 *      leads, un sumando de una plataforma no conectada) sigue dando número.
 *   2. `String(1e-7)` es `"1e-7"`: la `e` no pasaba la validación de caracteres
 *      y la fórmula entera daba null.
 *
 * Todo PURO: no toca la base ni la red.
 *
 *   npx tsx --conditions=react-server scripts/verify-formula-faltantes.ts
 */
import {
  evaluateFormula,
  aggregateFormula,
  numeroSinExponente,
  limpiarCacheDeFormulas,
} from '../src/lib/formula-engine';

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

limpiarCacheDeFormulas();
const SOLO_META = new Set(['meta']);
const CON_HOTMART = new Set(['meta', 'hotmart']);

sec('ROAS sin Hotmart conectado → «—»');
{
  // Columnas `ventas_*` con DEFAULT 0 aunque el cliente no tenga Hotmart.
  const fila = {
    meta_spend: 500,
    tiktok_spend: 0,
    ventas_principal: 0,
    ventas_bump: 0,
    ventas_upsell: 0,
    ventas_downsell: 0,
  };
  const v = evaluateFormula('total_roas', fila, {}, {}, SOLO_META);
  check('total_roas sin Hotmart → null', v === null, String(v));
  const m = evaluateFormula('meta_roas', fila, {}, {}, SOLO_META);
  check('meta_roas sin Hotmart → null', m === null, String(m));
  const agg = aggregateFormula('total_roas', [fila, fila], {}, {}, SOLO_META);
  check('agregado, igual → null', agg === null, String(agg));

  // CON Hotmart y sin ventas en el periodo: 0 es un dato (no se recuperó nada).
  const conHm = evaluateFormula('total_roas', fila, {}, {}, CON_HOTMART);
  check('con Hotmart y 0 ventas → 0 (dato real)', conHm === 0, String(conHm));

  // Un valor distinto de 0 se respeta aunque la plataforma no figure.
  const conVentas = evaluateFormula(
    'total_roas',
    { ...fila, ventas_principal: 1000 },
    {},
    {},
    SOLO_META
  );
  check('ventas ≠ 0 sin la plataforma → se usan (2)', conVentas === 2, String(conVentas));

  // Sin `availablePlatforms` (llamadas antiguas, MCP) no hay gating: igual que antes.
  const sinPlat = evaluateFormula('total_roas', fila);
  check('sin lista de plataformas → comportamiento anterior (0)', sinPlat === 0, String(sinPlat));
}

sec('Denominador sin dato → null; 0 legítimo se conserva');
{
  // `null` explícito = sin dato (una columna NULL en la base).
  check(
    'meta_spend / ga_sessions con sesiones NULL → null',
    evaluateFormula('meta_spend / ga_sessions', { meta_spend: 100, ga_sessions: null }) === null
  );
  check(
    'denominador con UN sumando presente no es faltante (100 / (10 + NULL) = 10)',
    evaluateFormula('meta_spend / (meta_leads + offline_leads)', {
      meta_spend: 100,
      meta_leads: 10,
      offline_leads: null,
    }) === 10
  );
  check(
    'división por 0 real sigue siendo null',
    evaluateFormula('meta_spend / meta_leads', { meta_spend: 100, meta_leads: 0 }) === null
  );
  check(
    '0 leads es 0 (no «—»)',
    evaluateFormula('meta_leads', { meta_leads: 0 }) === 0,
    String(evaluateFormula('meta_leads', { meta_leads: 0 }))
  );
  check(
    'todos los campos sin dato → null',
    evaluateFormula('ga_sessions + ga_bounce_rate', { ga_sessions: null, ga_bounce_rate: null }) ===
      null
  );
  check(
    'un sumando sin dato y otro presente → la suma de lo que hay',
    evaluateFormula('meta_spend + ga_sessions', { meta_spend: 5, ga_sessions: null }) === 5
  );
  check(
    'un literal no «rescata» a un faltante: (NULL / 5) * 100 → null',
    evaluateFormula('(ga_sessions / meta_spend) * 100', { ga_sessions: null, meta_spend: 5 }) ===
      null
  );
  check(
    'fórmula sin campos (constante) sigue funcionando',
    evaluateFormula('2 + 3 * 4', {}) === 14
  );
  check(
    'campo del catálogo que la fila no trae sigue valiendo 0 (día sin offline)',
    evaluateFormula('offline_ventas', { meta_spend: 10 }) === 0
  );
  check(
    'meta_spend + tiktok_spend sin TikTok conectado = gasto de Meta',
    evaluateFormula(
      'meta_spend + tiktok_spend',
      { meta_spend: 500, tiktok_spend: 0 },
      {},
      {},
      SOLO_META
    ) === 500
  );
  check(
    'tiktok_cpc sin TikTok conectado → null',
    evaluateFormula('tiktok_cpc', { tiktok_spend: 0, tiktok_clicks: 0 }, {}, {}, SOLO_META) === null
  );
}

sec('Agregado: un campo NULL en todo el rango es faltante');
{
  const filas = [
    { fecha: '2026-09-01', meta_spend: 100, ga_sessions: null },
    { fecha: '2026-09-02', meta_spend: 200, ga_sessions: null },
  ];
  check(
    'Σgasto / Σsesiones con sesiones siempre NULL → null',
    aggregateFormula('meta_spend / ga_sessions', filas) === null
  );
  const mixtas = [
    { fecha: '2026-09-01', meta_spend: 100, ga_sessions: null },
    { fecha: '2026-09-02', meta_spend: 200, ga_sessions: 30 },
  ];
  check(
    'con un día medido se usa lo medido (300 / 30 = 10)',
    aggregateFormula('meta_spend / ga_sessions', mixtas) === 10,
    String(aggregateFormula('meta_spend / ga_sessions', mixtas))
  );
}

sec('Notación científica');
{
  check('numeroSinExponente(1e-7) sin «e»', !/e/i.test(numeroSinExponente(1e-7)));
  check(
    'numeroSinExponente(1e-7) conserva el valor',
    Math.abs(Number(numeroSinExponente(1e-7)) - 1e-7) < 1e-15,
    numeroSinExponente(1e-7)
  );
  check('numeroSinExponente(1e21) sin «e»', !/e/i.test(numeroSinExponente(1e21)));
  check('numeroSinExponente(-2.5e-8) negativo', Number(numeroSinExponente(-2.5e-8)) < 0);
  check('números normales intactos', numeroSinExponente(1234.5) === '1234.5');

  const v = evaluateFormula('meta_spend * 1000', { meta_spend: 1e-7 });
  check(
    'un valor de 1e-7 ya no anula la fórmula (1e-7 × 1000 = 1e-4)',
    v !== null && Math.abs(v - 1e-4) < 1e-12,
    String(v)
  );
  const ctx = evaluateFormula('meta_spend * tasa', { meta_spend: 100 }, { tasa: 3e-7 });
  check(
    'también desde el contexto (100 × 3e-7)',
    ctx !== null && Math.abs(ctx - 3e-5) < 1e-12,
    String(ctx)
  );
  const grande = evaluateFormula('meta_spend / 1000', { meta_spend: 5e21 });
  check('valores ≥ 1e21 también', grande !== null && Math.abs(grande - 5e18) < 1e6, String(grande));
}

console.log(`\n${ok} ok, ${fail} fallos`);
if (fail > 0) process.exit(1);
