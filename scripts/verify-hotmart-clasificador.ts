/**
 * Comprobaciones del clasificador de ventas de Hotmart.
 *
 * El assert que de verdad importa es el de ANTIRREGRESIÓN: un funnel sin las
 * claves nuevas (`*_offers`, `downsell_names`) tiene que clasificar EXACTAMENTE
 * igual que el bloque que hoy vive en `worker/route.ts:1821-1854`. Si eso se
 * rompe, las ventas históricas cambian de categoría y el dashboard de un
 * cliente muestra otros números sin que nadie haya tocado su configuración.
 *
 * Todo PURO.
 *
 *   npx tsx scripts/verify-hotmart-clasificador.ts
 */

import {
  clasificarVenta,
  matchesAny,
  leerFunnel,
  cobertura,
} from '../src/lib/hotmart/clasificador';
import type { FunnelHotmart } from '../src/lib/hotmart/clasificador';
import type { VentaHotmart } from '../src/lib/hotmart/tipos';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

type EntradaVenta = Pick<
  VentaHotmart,
  'oferta_codigo' | 'es_order_bump' | 'parent_transaction_id' | 'producto_nombre'
>;
function v(p: Partial<EntradaVenta> = {}): EntradaVenta {
  return {
    oferta_codigo: null,
    es_order_bump: false,
    parent_transaction_id: null,
    producto_nombre: null,
    ...p,
  };
}

function funnel(p: Partial<FunnelHotmart> = {}): FunnelHotmart {
  return {
    tab_id: 'tab-1',
    principal_patterns: [],
    bump_patterns: [],
    upsell_patterns: [],
    downsell_patterns: [],
    principal_offers: [],
    bump_offers: [],
    upsell_offers: [],
    downsell_offers: [],
    landing_page_urls: [],
    ...p,
  };
}

// ════════════════════════════════════════════════════════════
seccion('matchesAny se mueve LITERAL desde el worker');
// ════════════════════════════════════════════════════════════
// Sin comodines la comparación es por IGUALDAD, no por `includes`. Cambiarlo a
// «contiene» reclasificaría ventas históricas en silencio.
check('sin comodines exige igualdad exacta', matchesAny('camaradictos pro', ['camaradictos pro']));
check('sin comodines NO es «contiene»', !matchesAny('camaradictos pro plus', ['camaradictos pro']));
check('% actúa como .*', matchesAny('camaradictos pro plus', ['camaradictos%']));
check('_ actúa como un carácter', matchesAny('nivel 1', ['nivel _']));
check('no distingue mayúsculas', matchesAny('CAMARADICTOS PRO', ['camaradictos pro']));
check('lista vacía nunca casa', !matchesAny('lo que sea', []));
check('patrón vacío se ignora', !matchesAny('lo que sea', ['']));
// Los metacaracteres de regex del nombre no deben poder romper el patrón.
check('los metacaracteres se escapan', matchesAny('curso (avanzado)', ['curso (avanzado)']));
check('un punto no es comodín', !matchesAny('cursoXavanzado', ['curso.avanzado']));

// ════════════════════════════════════════════════════════════
seccion('ANTIRREGRESIÓN: el mecanismo por nombre no cambia');
// ════════════════════════════════════════════════════════════
// Réplica exacta del bloque `worker/route.ts:1821-1854`: recorre los funnels en
// orden, prueba principal → bump → upsell y corta al primer match.
function clasificadorViejo(
  nombreProducto: string,
  funnels: FunnelHotmart[]
): { tipo: string; tab_id: string | null } {
  for (const f of funnels) {
    if (matchesAny(nombreProducto, f.principal_patterns))
      return { tipo: 'principal', tab_id: f.tab_id };
    if (matchesAny(nombreProducto, f.bump_patterns)) return { tipo: 'bump', tab_id: f.tab_id };
    if (matchesAny(nombreProducto, f.upsell_patterns)) return { tipo: 'upsell', tab_id: f.tab_id };
  }
  return { tipo: 'sin_clasificar', tab_id: null };
}

const funnelsHeredados = [
  funnel({
    tab_id: 'tab-A',
    principal_patterns: ['camaradictos%'],
    bump_patterns: ['bump camaradictos'],
    upsell_patterns: ['upsell camaradictos'],
  }),
  funnel({
    tab_id: 'tab-B',
    principal_patterns: ['tributario pro'],
    bump_patterns: ['plantillas%'],
  }),
];

const nombres = [
  'Camaradictos Pro',
  'Camaradictos Basico',
  'Bump Camaradictos',
  'Upsell Camaradictos',
  'Tributario Pro',
  'Plantillas Excel',
  'Producto Suelto',
  '',
  'CAMARADICTOS%raro',
];
let paridad = true;
const divergencias: string[] = [];
for (const nombre of nombres) {
  const viejo = clasificadorViejo(nombre, funnelsHeredados);
  const nuevo = clasificarVenta(v({ producto_nombre: nombre }), funnelsHeredados);
  if (viejo.tipo !== nuevo.tipo || viejo.tab_id !== nuevo.tab_id) {
    paridad = false;
    divergencias.push(`«${nombre}»: ${viejo.tipo}/${viejo.tab_id} ≠ ${nuevo.tipo}/${nuevo.tab_id}`);
  }
}
check(
  'un funnel sin ofertas clasifica igual que el worker actual',
  paridad,
  divergencias.join(' | ')
);
check(
  'el origen se reporta como «nombre»',
  clasificarVenta(v({ producto_nombre: 'Camaradictos Pro' }), funnelsHeredados).origen === 'nombre'
);
check(
  'el primer funnel gana',
  clasificarVenta(v({ producto_nombre: 'Camaradictos Pro' }), funnelsHeredados).tab_id === 'tab-A'
);
check(
  'sin match → sin_clasificar',
  clasificarVenta(v({ producto_nombre: 'Producto Suelto' }), funnelsHeredados).tipo ===
    'sin_clasificar'
);

// ════════════════════════════════════════════════════════════
seccion('La oferta gana sobre el nombre');
// ════════════════════════════════════════════════════════════
// Este es el punto del cambio: renombrar un producto en Hotmart dejaba de
// clasificar sus ventas y las mandaba a `extras[]` sin ningún aviso.
const conOfertas = [
  funnel({
    tab_id: 'tab-A',
    principal_patterns: ['camaradictos pro'],
    principal_offers: ['x7k2p9'],
    bump_offers: ['a1b2c3'],
    upsell_offers: ['z9y8x7'],
    downsell_offers: ['d0w0n0'],
  }),
];

check(
  'la oferta principal clasifica',
  clasificarVenta(v({ oferta_codigo: 'x7k2p9' }), conOfertas).tipo === 'principal'
);
check(
  'el origen se reporta como «oferta»',
  clasificarVenta(v({ oferta_codigo: 'x7k2p9' }), conOfertas).origen === 'oferta'
);
check(
  'la oferta de bump clasifica',
  clasificarVenta(v({ oferta_codigo: 'a1b2c3' }), conOfertas).tipo === 'bump'
);
check(
  'la oferta de upsell clasifica',
  clasificarVenta(v({ oferta_codigo: 'z9y8x7' }), conOfertas).tipo === 'upsell'
);

// El caso que motiva todo: el producto se renombró en Hotmart.
const renombrado = clasificarVenta(
  v({ oferta_codigo: 'x7k2p9', producto_nombre: 'Camaradictos Pro 2026 (nuevo nombre)' }),
  conOfertas
);
check(
  'renombrar el producto ya no rompe la clasificación',
  renombrado.tipo === 'principal' && renombrado.origen === 'oferta'
);

// Y al revés: la oferta manda aunque el nombre diga otra cosa.
const contradictorio = clasificarVenta(
  v({ oferta_codigo: 'a1b2c3', producto_nombre: 'Camaradictos Pro' }),
  conOfertas
);
check(
  'la oferta gana sobre un nombre que dice otra cosa',
  contradictorio.tipo === 'bump' && contradictorio.origen === 'oferta'
);

// ════════════════════════════════════════════════════════════
seccion('DOWNSELL — el tipo que no existía en todo el repo');
// ════════════════════════════════════════════════════════════
check(
  'la oferta de downsell clasifica',
  clasificarVenta(v({ oferta_codigo: 'd0w0n0' }), conOfertas).tipo === 'downsell'
);
const porNombre = [funnel({ downsell_patterns: ['downsell%'] })];
check(
  'el patrón de nombre de downsell clasifica',
  clasificarVenta(v({ producto_nombre: 'Downsell Camaradictos' }), porNombre).tipo === 'downsell'
);
check(
  'un downsell cuelga de una compra padre y aun así respeta la oferta',
  clasificarVenta(v({ oferta_codigo: 'd0w0n0', parent_transaction_id: 'HP000' }), conOfertas)
    .tipo === 'downsell'
);

// ════════════════════════════════════════════════════════════
seccion('Cascada: order_bump y parent_transaction');
// ════════════════════════════════════════════════════════════
// Sin oferta mapeada el TIPO sigue siendo seguro: lo dice la plataforma.
const bumpSinMapa = clasificarVenta(v({ es_order_bump: true }), [funnel()]);
check('order_bump sin mapa de ofertas → bump', bumpSinMapa.tipo === 'bump');
check('el origen se reporta como «order_bump»', bumpSinMapa.origen === 'order_bump');

const upsellSinMapa = clasificarVenta(v({ parent_transaction_id: 'HP000' }), [funnel()]);
check('cuelga de otra compra y no es bump → upsell', upsellSinMapa.tipo === 'upsell');
check('el origen se reporta como «parent_tx»', upsellSinMapa.origen === 'parent_tx');

// El orden importa: un bump también trae padre, y no debe salir como upsell.
const bumpConPadre = clasificarVenta(v({ es_order_bump: true, parent_transaction_id: 'HP000' }), [
  funnel(),
]);
check('un bump con padre sigue siendo bump', bumpConPadre.tipo === 'bump');

// Aunque el tipo venga de la plataforma, si el nombre identifica la pestaña se
// aprovecha: un tipo correcto con pestaña vale más que uno huérfano.
const bumpConNombre = clasificarVenta(
  v({ es_order_bump: true, producto_nombre: 'Camaradictos Pro' }),
  funnelsHeredados
);
check('el order_bump hereda la pestaña por nombre', bumpConNombre.tab_id === 'tab-A');
check('pero el tipo lo decide la plataforma', bumpConNombre.tipo === 'bump');

// ════════════════════════════════════════════════════════════
seccion('leerFunnel es aditivo y retrocompatible');
// ════════════════════════════════════════════════════════════
const viejo = leerFunnel('tab-A', {
  enabled: true,
  principal_names: ['Camaradictos%', '  ', null],
  bump_names: ['Bump Camaradictos'],
});
check('un funnel viejo se lee', viejo !== null);
check('los patrones se normalizan a minúsculas', viejo!.principal_patterns[0] === 'camaradictos%');
check('los vacíos se descartan', viejo!.principal_patterns.length === 1);
check(
  'sin claves nuevas, las listas quedan vacías',
  viejo!.principal_offers.length === 0 && viejo!.downsell_patterns.length === 0
);
check('un funnel deshabilitado devuelve null', leerFunnel('t', { enabled: false }) === null);
check('un funnel ausente devuelve null', leerFunnel('t', null) === null);

const nuevo = leerFunnel('tab-A', {
  enabled: true,
  principal_offers: ['x7k2p9', ' ', 'A1B2C3'],
  downsell_offers: ['d0w0n0'],
  principal_price_usd: '97',
});
// Los códigos de oferta de Hotmart distinguen mayúsculas: normalizarlos como se
// hace con los nombres rompería el cruce.
check('los códigos de oferta NO se pasan a minúsculas', nuevo!.principal_offers.includes('A1B2C3'));
check('los códigos vacíos se descartan', nuevo!.principal_offers.length === 2);
check('el precio configurado se lee como número', nuevo!.principal_price_usd === 97);

// ════════════════════════════════════════════════════════════
seccion('Cobertura del mapa');
// ════════════════════════════════════════════════════════════
// Es la métrica que decide si el dashboard puede fiarse del `tipo`.
const muestra = [
  { clasificacion_origen: 'oferta' as const },
  { clasificacion_origen: 'oferta' as const },
  { clasificacion_origen: 'nombre' as const },
  { clasificacion_origen: 'sin_clasificar' as const },
];
const c = cobertura(muestra);
check('cuenta el total', c.total === 4);
check('cuenta las clasificadas', c.clasificadas === 3);
check('cuenta las que vienen de oferta', c.porOferta === 2);
check('calcula el porcentaje', c.pct === 75, String(c.pct));
check('sin ventas la cobertura es 100 (no divide por cero)', cobertura([]).pct === 100);

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
