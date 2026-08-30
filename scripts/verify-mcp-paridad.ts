/**
 * Paridad de cifras entre el camino oficial (el del dashboard, ahora expuesto
 * por `getMetricasCliente`) y el que usaba el servidor MCP.
 *
 * Motivo: convivían cinco formas de calcular las mismas métricas y no
 * coincidían. Las dos divergencias con consecuencias visibles:
 *
 *   1. GASTO. El dashboard suma `meta_campaigns[].spend`; el MCP leía la
 *      columna `meta_spend`. Cuando la paginación de Meta se trunca, las dos
 *      dejan de cuadrar — para eso existe `metaRowIsIncomplete()`, con
 *      tolerancia del 1 %.
 *
 *   2. FILTRO DE PESTAÑA. `cliente_tabs.keyword_meta` puede llevar el prefijo
 *      `__cf:` con un filtro compuesto en JSON. El MCP lo devolvía crudo y su
 *      propia descripción le decía al modelo que lo usara como palabra clave;
 *      luego filtraba con `String.includes()`. Con una pestaña compuesta eso no
 *      casa NINGUNA campaña y devuelve gasto 0 sin error: el agente informaría
 *      de que la estrategia no gastó nada.
 *
 * Este script recorre las pestañas reales del proyecto y comprueba que el
 * camino nuevo entiende lo que el viejo no entendía.
 *
 * Requiere base de datos (forma parte de `test:datos`).
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

type Campana = { name?: string; spend?: number | string };
type FilaMetrica = {
  fecha?: string;
  meta_spend?: number | string | null;
  meta_campaigns?: Campana[] | null;
};
type Tab = {
  id: string;
  cliente_id: string;
  nombre: string;
  keyword_meta: string | null;
};

/**
 * El filtrado tal como lo hacía el MCP: la cadena cruda de `keyword_meta`
 * pasada a `String.includes()`. Se conserva aquí para poder demostrar la
 * diferencia, no para usarlo.
 */
function gastoAlEstiloMcp(filas: FilaMetrica[], keywordCruda: string): number {
  const kw = keywordCruda.toLowerCase();
  let total = 0;
  for (const row of filas) {
    const campanas = Array.isArray(row.meta_campaigns) ? row.meta_campaigns : [];
    for (const c of campanas) {
      if ((c.name ?? '').toLowerCase().includes(kw)) total += Number(c.spend ?? 0) || 0;
    }
  }
  return total;
}

function suma(filas: FilaMetrica[], campo: 'columna' | 'array'): number {
  let total = 0;
  for (const row of filas) {
    if (campo === 'columna') {
      total += Number(row.meta_spend ?? 0) || 0;
    } else {
      for (const c of Array.isArray(row.meta_campaigns) ? row.meta_campaigns : []) {
        total += Number(c.spend ?? 0) || 0;
      }
    }
  }
  return total;
}

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { getMetricasCliente, resolverRango, MAX_DIAS_RANGO } =
    await import('../src/lib/metrics/client-metrics');
  const { parseTabFilter, tabFilterLabel } = await import('../src/lib/campaign-filter');

  const sb = await createAdminClient();

  const hoy = new Date();
  const hasta = hoy.toISOString().slice(0, 10);
  const d = new Date(hoy);
  d.setDate(d.getDate() - 89);
  const desde = d.toISOString().slice(0, 10);

  // ── 1. Pestañas con filtro compuesto ─────────────────────────────────────
  console.log('\n── Filtro compuesto `__cf:` ─────────────────────────────────');

  const { data: tabsData, error: errTabs } = await sb
    .from('cliente_tabs')
    .select('id, cliente_id, nombre, keyword_meta')
    .limit(500);

  if (errTabs) throw new Error('No se pudieron leer las pestañas: ' + errTabs.message);
  const tabs = (tabsData ?? []) as Tab[];
  const compuestas = tabs.filter((t) => (t.keyword_meta ?? '').startsWith('__cf:'));

  check('el proyecto tiene pestañas con filtro compuesto que cubrir', compuestas.length > 0);

  for (const tab of compuestas) {
    const etiqueta = tabFilterLabel(tab.keyword_meta);

    // `parseTabFilter` devuelve el objeto; el camino viejo se quedaba con el texto.
    const parsed = parseTabFilter(tab.keyword_meta);
    check(
      `[${tab.nombre}] parseTabFilter devuelve un filtro estructurado, no la cadena cruda`,
      typeof parsed === 'object' && parsed !== null,
      typeof parsed
    );

    check(
      `[${tab.nombre}] la etiqueta legible no expone el prefijo __cf:`,
      !etiqueta.startsWith('__cf:') && etiqueta.length > 0,
      etiqueta
    );

    const res = await getMetricasCliente({
      clienteId: tab.cliente_id,
      from: desde,
      to: hasta,
      tabId: tab.id,
    });

    check(
      `[${tab.nombre}] getMetricasCliente expone la etiqueta legible`,
      res.tab !== null && !res.tab.filtro.startsWith('__cf:'),
      res.tab?.filtro
    );

    // Gasto sin filtrar del mismo periodo, para saber si esta pestaña tiene datos.
    const { data: crudo } = await sb
      .from('metricas_diarias')
      .select('fecha, meta_spend, meta_campaigns')
      .eq('cliente_id', tab.cliente_id)
      .gte('fecha', desde)
      .lte('fecha', hasta);

    const filas = (crudo ?? []) as FilaMetrica[];
    const gastoTotal = suma(filas, 'array');
    const gastoViejo = gastoAlEstiloMcp(filas, tab.keyword_meta ?? '');
    const gastoNuevo = Number(res.totals.meta_spend ?? 0);

    if (gastoTotal <= 0) {
      console.log(`  · [${tab.nombre}] sin gasto en el periodo, no es concluyente`);
      continue;
    }

    // El corazón del asunto: pasar la cadena cruda no casa nada.
    check(
      `[${tab.nombre}] el camino del MCP daba 0 con el filtro compuesto`,
      gastoViejo === 0,
      `daba ${gastoViejo.toFixed(2)}`
    );

    check(
      `[${tab.nombre}] el camino nuevo NO se queda en 0 (hay ${gastoTotal.toFixed(0)} sin filtrar)`,
      gastoNuevo > 0,
      `nuevo=${gastoNuevo.toFixed(2)}`
    );

    check(
      `[${tab.nombre}] el filtro recorta: el gasto de la pestaña no supera el total`,
      gastoNuevo <= gastoTotal * 1.0001,
      `${gastoNuevo.toFixed(2)} vs ${gastoTotal.toFixed(2)}`
    );
  }

  // ── 2. Columna `meta_spend` vs suma del array ────────────────────────────
  console.log('\n── Columna vs array de campañas ─────────────────────────────');

  const { data: clientesData } = await sb.from('clientes').select('id, nombre').limit(12);
  const clientes = (clientesData ?? []) as { id: string; nombre: string }[];
  check('hay clientes para comparar', clientes.length > 0);

  let divergentes = 0;
  let comparados = 0;

  for (const c of clientes) {
    const { data: crudo } = await sb
      .from('metricas_diarias')
      .select('fecha, meta_spend, meta_campaigns')
      .eq('cliente_id', c.id)
      .gte('fecha', desde)
      .lte('fecha', hasta);

    const filas = (crudo ?? []) as FilaMetrica[];
    if (filas.length === 0) continue;

    const porColumna = suma(filas, 'columna');
    const porArray = suma(filas, 'array');
    if (porColumna <= 0 && porArray <= 0) continue;

    comparados++;
    const dif = Math.abs(porColumna - porArray);
    const divergen = dif > Math.max(1, porColumna * 0.01);
    if (divergen) {
      divergentes++;
      console.log(
        `  · ${c.nombre}: columna=${porColumna.toFixed(2)} array=${porArray.toFixed(2)} (dif ${dif.toFixed(2)})`
      );
    }

    // El camino nuevo debe seguir SIEMPRE al array, que es lo que ve el usuario.
    const res = await getMetricasCliente({ clienteId: c.id, from: desde, to: hasta });
    const nuevo = Number(res.totals.meta_spend ?? 0);
    check(
      `[${c.nombre}] el gasto sale del array de campañas, como en el dashboard`,
      Math.abs(nuevo - porArray) <= Math.max(1, porArray * 0.01),
      `nuevo=${nuevo.toFixed(2)} array=${porArray.toFixed(2)} columna=${porColumna.toFixed(2)}`
    );

    // Si divergen, el aviso tiene que llegar a quien pregunta.
    if (divergen) {
      check(
        `[${c.nombre}] avisa del desglose incompleto en vez de callarlo`,
        res.warnings.some((w) => w.includes('incompleto')),
        JSON.stringify(res.warnings)
      );
    }
  }

  console.log(`  · ${comparados} clientes comparados, ${divergentes} con divergencia > 1 %`);

  // ── 3. Derivadas recalculadas, no promediadas ────────────────────────────
  console.log('\n── Métricas derivadas ───────────────────────────────────────');

  for (const c of clientes.slice(0, 6)) {
    const res = await getMetricasCliente({ clienteId: c.id, from: desde, to: hasta });
    const spend = Number(res.totals.meta_spend ?? 0);
    const leads = Number(res.totals.meta_leads ?? 0);
    if (spend <= 0 || leads <= 0) continue;

    const esperado = spend / leads;
    const obtenido = Number(res.totals.meta_cpl ?? 0);
    check(
      `[${c.nombre}] CPL = gasto total / leads totales (no el promedio de los CPL diarios)`,
      Math.abs(obtenido - esperado) < Math.max(0.01, esperado * 0.001),
      `obtenido=${obtenido.toFixed(4)} esperado=${esperado.toFixed(4)}`
    );
  }

  // ── 4. Aislamiento por cliente y tope de rango ───────────────────────────
  console.log('\n── Garantías de la capa ─────────────────────────────────────');

  let lanzo = false;
  try {
    await getMetricasCliente({ clienteId: '', from: desde, to: hasta });
  } catch {
    lanzo = true;
  }
  check('sin clienteId lanza en vez de agregar todos los clientes', lanzo);

  let lanzoNoExiste = false;
  try {
    await getMetricasCliente({
      clienteId: '00000000-0000-0000-0000-000000000000',
      from: desde,
      to: hasta,
    });
  } catch {
    lanzoNoExiste = true;
  }
  check('un cliente inexistente lanza NOT_FOUND, no devuelve ceros', lanzoNoExiste);

  const largo = resolverRango('2020-01-01', hasta);
  check(
    `un rango de años se recorta a ${MAX_DIAS_RANGO} días`,
    largo.recortado && largo.from > '2020-01-01'
  );

  const futuro = resolverRango('2099-01-01', '2099-12-31');
  check('un rango futuro se marca como recortado', futuro.recortado);

  const invertido = resolverRango(hasta, desde);
  check('un rango invertido se ordena solo', invertido.from <= invertido.to);

  // Una pestaña de otro cliente no debe poder consultarse.
  if (compuestas.length > 0 && clientes.length > 1) {
    const tab = compuestas[0];
    const otro = clientes.find((c) => c.id !== tab.cliente_id);
    if (otro) {
      let cruzado = false;
      try {
        await getMetricasCliente({
          clienteId: otro.id,
          from: desde,
          to: hasta,
          tabId: tab.id,
        });
      } catch {
        cruzado = true;
      }
      check('una pestaña de otro cliente se rechaza', cruzado);
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
