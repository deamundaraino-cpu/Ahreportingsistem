/**
 * Filtro de Sheet de las tarjetas del dashboard (`offline-filter.ts`),
 * auditoría de superficies del 2026-09-28.
 *
 *   · Una celda vacía NO entra en una comparación numérica (antes valía 0 y
 *     «menor que 5» contaba todas las filas sin el dato).
 *   · Un operador desconocido EXCLUYE la fila (antes la dejaba pasar y la
 *     tarjeta mostraba el total sin filtrar) y se avisa una sola vez.
 *   · El resumen filtrado promedia las columnas de porcentaje igual que el
 *     merge del día, en vez de sumarlas.
 *
 * Todo PURO: no toca la base ni la red.
 *
 *   npx tsx --conditions=react-server scripts/verify-offline-filter.ts
 */
import { offlineRowMatchesFilter, enrichOfflineRow } from '../src/lib/offline-filter';
import { agruparOfflinePorFecha, mergeMetricasDelRango } from '../src/lib/dashboard/merge-metrics';
import type { SheetFilterSpec } from '../src/lib/layout-types';

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

const f = (field: string, operator: string, value: string | string[]): SheetFilterSpec =>
  ({ field, operator, value }) as SheetFilterSpec;

sec('Comparaciones numéricas');
{
  const vacia = { custom_fields: { monto: '' } };
  const sinCampo = { custom_fields: {} };
  const tres = { custom_fields: { monto: 3 } };
  const texto = { custom_fields: { monto: 'n/a' } };
  check('3 < 5', offlineRowMatchesFilter(tres, f('sheet_monto', 'less_than', '5')));
  check('3 ≥ 5 no', !offlineRowMatchesFilter(tres, f('sheet_monto', 'greater_equal', '5')));
  check(
    'celda vacía NO es «menor que 5»',
    !offlineRowMatchesFilter(vacia, f('sheet_monto', 'less_than', '5'))
  );
  check(
    'campo ausente NO es «menor o igual que 0»',
    !offlineRowMatchesFilter(sinCampo, f('sheet_monto', 'less_equal', '0'))
  );
  check(
    'texto no numérico no entra en «mayor que»',
    !offlineRowMatchesFilter(texto, f('sheet_monto', 'greater_than', '0'))
  );
  check(
    'umbral vacío no deja pasar todo',
    !offlineRowMatchesFilter(tres, f('sheet_monto', 'greater_than', ''))
  );
  check(
    '0 real sí es «menor que 5»',
    offlineRowMatchesFilter({ custom_fields: { monto: 0 } }, f('sheet_monto', 'less_than', '5'))
  );
}

sec('Operadores de texto (sin cambios)');
{
  const fila = { tipo: 'venta', fuente: 'Instagram', custom_fields: { ciudad: 'Bogotá' } };
  check('equals', offlineRowMatchesFilter(fila, f('tipo', 'equals', 'VENTA')));
  check('includes', offlineRowMatchesFilter(fila, f('fuente', 'includes', 'insta')));
  check('any_of', offlineRowMatchesFilter(fila, f('sheet_ciudad', 'any_of', ['bogotá', 'cali'])));
  check('none_of', !offlineRowMatchesFilter(fila, f('sheet_ciudad', 'none_of', ['bogotá'])));
  check(
    'sin filtro → pasa',
    offlineRowMatchesFilter(fila, undefined as unknown as SheetFilterSpec)
  );
}

sec('Operador desconocido');
{
  const avisos: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => avisos.push(a.join(' '));
  try {
    const fila = { tipo: 'venta' };
    const r1 = offlineRowMatchesFilter(fila, f('tipo', 'parece', 'venta'));
    const r2 = offlineRowMatchesFilter(fila, f('tipo', 'parece', 'venta'));
    check('excluye la fila', r1 === false && r2 === false);
    check('avisa una sola vez por operador', avisos.length === 1, String(avisos.length));
  } finally {
    console.warn = original;
  }
}

sec('Resumen filtrado: porcentajes promediados, no sumados');
{
  const offline = [
    { fecha: '2026-09-01', tipo: 'lead', fuente: 'ig', cantidad: 1, custom_fields: { tasa: 40 } },
    { fecha: '2026-09-01', tipo: 'lead', fuente: 'ig', cantidad: 3, custom_fields: { tasa: 20 } },
    { fecha: '2026-09-01', tipo: 'lead', fuente: 'fb', cantidad: 2, custom_fields: { tasa: 90 } },
  ];
  const [fila] = mergeMetricasDelRango({
    metricas: [{ fecha: '2026-09-01', meta_spend: 1 }],
    leads: [],
    offlinePorFecha: agruparOfflinePorFecha(offline, new Set(['tasa'])),
    sheetPorFecha: new Map(),
    leadsLegacyPorFecha: new Map(),
  });
  const soloIg = enrichOfflineRow(fila, f('fuente', 'equals', 'ig'));
  check(
    'solo ig: (40·1 + 20·3)/4 = 25, no 60',
    soloIg.sheet_tasa === 25,
    String(soloIg.sheet_tasa)
  );
  check('leads offline de ig = 4', soloIg.offline_leads === 4);
  const ninguna = enrichOfflineRow(fila, f('fuente', 'equals', 'tiktok'));
  check('sin coincidencias → la columna queda en 0', ninguna.sheet_tasa === 0);
}

console.log(`\n${ok} ok, ${fail} fallos`);
if (fail > 0) process.exit(1);
