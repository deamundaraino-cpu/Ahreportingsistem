/**
 * Comprobaciones de la unificación UTM ↔ campañas del BI.
 *
 * Dos bloques:
 *
 *   1. PURO — la lógica que decide qué cruza con qué, qué recorta el gasto y
 *      cómo se comparan los nombres. No toca la base.
 *
 *   2. DATOS — contra el proyecto real (service role de .env.local), porque las
 *      invariantes que importan solo se ven con volumen:
 *        · ningún lead se pierde al agrupar por campaña
 *        · el gasto por campaña cuadra con el gasto total
 *        · no se funden campañas distintas bajo el mismo nombre normalizado
 *
 *   npx tsx scripts/verify-bi-unificacion.ts
 */

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  normLabel,
  unifiedTarget,
  UNIFIED_DIMS,
  platformFromUtm,
  matchFilterCondition,
  matchFilterConditionNorm,
  platformScopeFromFilters,
  hasEntityFilter,
  entityNameFilterPredicate,
  splitEntityGroups,
  metricCrossesDimension,
  RECOMMENDED_METRICS,
  METRIC_META,
  METRIC_GROUP_META,
  metricsOfGroup,
  metricGlossary,
  hasNonAttributableFilter,
  DIMENSION_META,
} from '../src/lib/report-utm/bi-metadata';
import type { BiMetric, AdvancedFilter } from '../src/lib/report-utm/bi-metadata';

loadEnv({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);
}

// ════════════════════════════════════════════════════════════
// 1. PURO
// ════════════════════════════════════════════════════════════

seccion('Normalización de nombres');
check('promo_verano == Promo Verano', normLabel('promo_verano') === normLabel('Promo Verano'));
check('quita acentos', normLabel('Campaña Otoño') === 'campana otono');
check('guiones y guiones bajos son espacios', normLabel('a-b_c') === 'a b c');
check('colapsa espacios', normLabel('  a   b  ') === 'a b');
check('no funde nombres distintos', normLabel('LSP Ranco II') !== normLabel('LSP EVS'));

seccion('Comparación de filtros: cruda vs normalizada');
check(
  'la cruda NO matchea promo_verano con Promo Verano',
  !matchFilterCondition('Promo Verano', 'eq', 'promo_verano')
);
check(
  'la normalizada SÍ lo matchea',
  matchFilterConditionNorm('Promo Verano', 'eq', 'promo_verano')
);
check(
  'normalizada: contains con acentos',
  matchFilterConditionNorm('Campaña Otoño 2026', 'contains', 'campana otono')
);
check(
  'normalizada: multi-valor por comas',
  matchFilterConditionNorm('Promo Verano', 'eq', 'otra_cosa, promo-verano')
);
check(
  'normalizada: neq sigue excluyendo',
  !matchFilterConditionNorm('Promo Verano', 'neq', 'promo_verano')
);

seccion('Dimensiones unificadas');
check('utm_campaign resuelve a campaña', unifiedTarget('utm_campaign') === 'campaign');
check('campaign (alias) resuelve a campaña', unifiedTarget('campaign') === 'campaign');
check('utm_id resuelve a campaña', unifiedTarget('utm_id') === 'campaign');
check(
  'utm_content y ad resuelven a anuncio',
  unifiedTarget('utm_content') === 'ad' && unifiedTarget('ad') === 'ad'
);
check(
  'utm_term y adset resuelven a conjunto',
  unifiedTarget('utm_term') === 'adset' && unifiedTarget('adset') === 'adset'
);
check('utm_source NO es unificada', unifiedTarget('utm_source') === null);
check(
  'utm_campaign_raw NO es unificada (es la de auditoría)',
  unifiedTarget('utm_campaign_raw') === null
);
check('date NO es unificada', unifiedTarget('date') === null);
check(
  'UNIFIED_DIMS y unifiedTarget coinciden',
  Array.from(UNIFIED_DIMS).every((d) => unifiedTarget(d) !== null)
);
check(
  'toda dimensión unificada existe en DIMENSION_META',
  Array.from(UNIFIED_DIMS).every((d) => !!DIMENSION_META[d as keyof typeof DIMENSION_META])
);
check(
  'campaign está oculta del selector (es alias de utm_campaign)',
  DIMENSION_META.campaign.hidden === true
);

seccion('Plataforma a partir de source/medium');
check('facebook → meta', platformFromUtm('facebook', null) === 'meta');
check('IG → meta', platformFromUtm('IG', null) === 'meta');
check('tiktok → tiktok', platformFromUtm('tiktok', null) === 'tiktok');
check(
  'google → null (no es plataforma de gasto del sistema)',
  platformFromUtm('google', null) === null
);
check(
  'paid_social → null (no identifica plataforma)',
  platformFromUtm(null, 'paid_social') === null
);

seccion('Recorte del gasto por plataforma');
const f = (o: Record<string, string>) => o;
check(
  'utm_source=facebook recorta a Meta',
  platformScopeFromFilters(f({ utm_source: 'facebook' }), undefined) === 'meta'
);
check(
  'utm_source=tiktok recorta a TikTok',
  platformScopeFromFilters(f({ utm_source: 'tiktok' }), undefined) === 'tiktok'
);
check(
  'facebook,instagram sigue siendo Meta',
  platformScopeFromFilters(f({ utm_source: 'facebook,instagram' }), undefined) === 'meta'
);
check(
  'facebook,tiktok mezcladas → no se recorta',
  platformScopeFromFilters(f({ utm_source: 'facebook,tiktok' }), undefined) === null
);
check(
  'un source desconocido → no se recorta',
  platformScopeFromFilters(f({ utm_source: 'newsletter' }), undefined) === null
);
check(
  'neq no delimita → no se recorta',
  platformScopeFromFilters(f({ utm_source: 'neq:facebook' }), undefined) === null
);
check('sin filtros → no se recorta', platformScopeFromFilters(undefined, undefined) === null);
const grupoMixto: AdvancedFilter = {
  groups: [
    {
      conditions: [
        { field: 'utm_source', op: 'eq', value: 'facebook' },
        { field: 'ip_country', op: 'eq', value: 'CL' },
      ],
    },
  ],
};
check(
  'grupo mixto (source O país) → no se recorta',
  platformScopeFromFilters(undefined, grupoMixto) === null
);

seccion('Filtro por nombre de entidad');
check(
  'detecta filtro plano de campaña',
  hasEntityFilter(f({ utm_campaign: 'Promo' }), undefined, 'utm_campaign')
);
check(
  'no detecta filtro donde no lo hay',
  !hasEntityFilter(f({ utm_source: 'facebook' }), undefined, 'utm_campaign')
);
const grupoPuro: AdvancedFilter = {
  groups: [
    {
      conditions: [
        { field: 'utm_campaign', op: 'eq', value: 'A' },
        { field: 'utm_campaign', op: 'eq', value: 'B' },
      ],
    },
  ],
};
check(
  'un grupo puro de campaña sí restringe',
  hasEntityFilter(undefined, grupoPuro, 'utm_campaign')
);
check(
  'un grupo MIXTO no restringe el nombre (su otra rama admite cualquiera)',
  !hasEntityFilter(undefined, grupoMixto, 'utm_campaign')
);
const predPuro = entityNameFilterPredicate(undefined, grupoPuro, 'utm_campaign');
check('el predicado del grupo puro acepta A y B', predPuro('A') && predPuro('B'));
check('el predicado del grupo puro rechaza C', !predPuro('C'));
const split = splitEntityGroups({ groups: [...grupoPuro.groups, ...grupoMixto.groups] });
check(
  'splitEntityGroups separa puro de mixto',
  split.entityOnly?.groups.length === 1 && split.rest?.groups.length === 1
);

seccion('Atribución del gasto: lo que NO se puede recortar');
check('país anula el gasto', hasNonAttributableFilter(f({ ip_country: 'CL' }), undefined));
check('formulario anula el gasto', hasNonAttributableFilter(f({ form_name: 'x' }), undefined));
check(
  'campo de lead anula el gasto',
  hasNonAttributableFilter(f({ 'leadfield:ingresos': 'alto' }), undefined)
);
check(
  'utm_campaign NO anula el gasto (se recorta por nombre)',
  !hasNonAttributableFilter(f({ utm_campaign: 'Promo' }), undefined)
);
check(
  'utm_source NO anula el gasto (se recorta por plataforma)',
  !hasNonAttributableFilter(f({ utm_source: 'facebook' }), undefined)
);

seccion('Catálogo: taxonomía y cruce');
const metricas = Object.keys(METRIC_META) as BiMetric[];
check(`el catálogo tiene ${metricas.length} métricas`, metricas.length > 60);
check(
  'toda métrica declara grupo y breakdown',
  metricas.every((m) => !!METRIC_META[m].group && !!METRIC_META[m].breakdown)
);
check(
  'todo grupo declarado tiene al menos una métrica',
  METRIC_GROUP_META.every((g) => metricsOfGroup(g.key).length > 0)
);
check(
  'toda métrica pertenece a un grupo declarado',
  metricas.every((m) => METRIC_GROUP_META.some((g) => g.key === METRIC_META[m].group))
);
check(
  'las recomendadas existen en el catálogo',
  RECOMMENDED_METRICS.every((m) => !!METRIC_META[m])
);
check(
  'las recomendadas cruzan por campaña',
  RECOMMENDED_METRICS.every((m) => metricCrossesDimension(m, 'utm_campaign'))
);
check(
  'las recomendadas cruzan por fecha',
  RECOMMENDED_METRICS.every((m) => metricCrossesDimension(m, 'date'))
);
check(
  'leads cruza por país (es columna de lead_events)',
  metricCrossesDimension('leads_count', 'ip_country')
);
check('el gasto NO cruza por país', !metricCrossesDimension('spend', 'ip_country'));
check(
  'el gasto SÍ cruza por campaña (esto es lo que se arregló)',
  metricCrossesDimension('spend', 'utm_campaign')
);
check(
  'el gasto SÍ cruza por anuncio y conjunto',
  metricCrossesDimension('spend', 'ad') && metricCrossesDimension('spend', 'adset')
);
check('CPL cruza por campaña', metricCrossesDimension('cpl', 'utm_campaign'));
check(
  'GA4 solo cruza por fecha',
  metricCrossesDimension('ga_sessions', 'date') &&
    !metricCrossesDimension('ga_sessions', 'utm_campaign')
);
check(
  'Hotmart solo cruza por fecha',
  metricCrossesDimension('hotmart_revenue', 'date') &&
    !metricCrossesDimension('hotmart_revenue', 'utm_campaign')
);
check(
  'las suscripciones no cruzan por nada (son una foto)',
  !metricCrossesDimension('subs_active', 'date') &&
    !metricCrossesDimension('subs_active', 'utm_campaign') &&
    metricCrossesDimension('subs_active', 'none')
);
check(
  'un token de campo de formulario no dispara aviso',
  metricCrossesDimension('fieldagg:sum:presupuesto', 'ip_country')
);

seccion('Catálogo: nomenclatura');
check(
  'los tres "leads" tienen etiquetas distinguibles',
  new Set([
    METRIC_META.leads_count.label,
    METRIC_META.leads_form.label,
    METRIC_META.offline_leads.label,
  ]).size === 3
);
check(
  'ya no hay dos "Pagos iniciados" idénticos',
  METRIC_META.initiates_checkout.label !== METRIC_META.hotmart_pagos_iniciados.label
);
check(
  'no hay etiquetas duplicadas en todo el catálogo',
  new Set(metricas.map((m) => METRIC_META[m].label)).size === metricas.length,
  (() => {
    const vistos = new Map<string, string>();
    const dup: string[] = [];
    for (const m of metricas) {
      const l = METRIC_META[m].label;
      if (vistos.has(l)) dup.push(`${l} (${vistos.get(l)} / ${m})`);
      else vistos.set(l, m);
    }
    return dup.join('; ');
  })()
);
check(
  'TODA métrica del catálogo tiene glosario',
  metricas.every((m) => !!metricGlossary(m)),
  metricas.filter((m) => !metricGlossary(m)).join(', ')
);

// ════════════════════════════════════════════════════════════
// 2. DATOS REALES
// ════════════════════════════════════════════════════════════

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function verificarDatos() {
  if (!url || !key) {
    console.log('\n⚠  Sin NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local:');
    console.log('   se omiten las comprobaciones contra datos reales.');
    return;
  }
  const db = createClient(url, key);

  seccion('Datos reales: cliente con más volumen');
  const { data: clientes } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .not('public_cliente_id', 'is', null)
    .limit(50);
  if (!clientes?.length) {
    console.log('  ⚠ ningún cliente report_utm enlazado a un cliente público');
    return;
  }

  // Elegir el cliente con más leads en los últimos 90 días.
  const desde = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);
  let mejor: { id: string; nombre: string; publicId: string; leads: number } | null = null;
  for (const c of clientes) {
    const { count } = await db
      .schema('report_utm')
      .from('lead_events')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', c.id)
      .gte('created_at', desde + 'T00:00:00');
    if ((count ?? 0) > (mejor?.leads ?? 0)) {
      mejor = { id: c.id, nombre: c.nombre, publicId: c.public_cliente_id, leads: count ?? 0 };
    }
  }
  if (!mejor || mejor.leads === 0) {
    console.log('  ⚠ ningún cliente con leads en los últimos 90 días');
    return;
  }
  console.log(`  · Cliente: ${mejor.nombre} — ${mejor.leads} leads (${desde} → ${hasta})`);

  // ── Motor: mismas rutas que usa el BI ──────────────────────────────
  const { runBiQuery } = await import('../src/lib/report-utm/bi-query');
  const base = { cliente_id: mejor.id, date_from: desde, date_to: hasta };

  const total = await runBiQuery({
    ...base,
    metrics: ['leads_count', 'spend'] as BiMetric[],
    dimension: 'none',
  });
  const leadsTotal = Number(total[0]?.leads_count ?? 0);
  const spendTotal = Number(total[0]?.spend ?? 0);
  console.log(`  · Total del período: ${leadsTotal} leads · $${spendTotal.toFixed(2)} de gasto`);

  const porCampana = await runBiQuery({
    ...base,
    metrics: ['leads_count', 'spend', 'cpl'] as BiMetric[],
    dimension: 'utm_campaign',
    limit: 500,
  });
  const leadsCampana = porCampana.reduce((s, r) => s + Number(r.leads_count ?? 0), 0);
  const spendCampana = porCampana.reduce((s, r) => s + Number(r.spend ?? 0), 0);

  seccion('Datos reales: nada se pierde al agrupar por campaña');
  check(
    `no se pierde ningún lead (${leadsTotal} → ${leadsCampana})`,
    leadsCampana === leadsTotal,
    `diferencia de ${leadsTotal - leadsCampana}`
  );
  check(
    `el gasto cuadra (${spendTotal.toFixed(2)} → ${spendCampana.toFixed(2)})`,
    Math.abs(spendCampana - spendTotal) <= Math.max(1, spendTotal * 0.01),
    `diferencia de $${(spendTotal - spendCampana).toFixed(2)}`
  );

  seccion('Datos reales: el cruce produce gasto donde antes había 0');
  const conGasto = porCampana.filter((r) => Number(r.spend ?? 0) > 0);
  const conAmbos = porCampana.filter(
    (r) => Number(r.spend ?? 0) > 0 && Number(r.leads_count ?? 0) > 0
  );
  const sinCruce = porCampana.filter((r) => r.__nocross === 1);
  console.log(
    `  · ${porCampana.length} filas · ${conGasto.length} con gasto · ${conAmbos.length} con gasto Y leads · ${sinCruce.length} sin cruce`
  );
  if (spendTotal > 0) {
    check('al menos una campaña tiene gasto desglosado', conGasto.length > 0);
    check(
      'al menos una campaña tiene gasto Y leads (el cruce funciona)',
      conAmbos.length > 0,
      'ninguna fila combina ambos: el cruce no está resolviendo'
    );
    check(
      'esas filas tienen CPL calculado',
      conAmbos.every((r) => r.cpl !== null && r.cpl !== undefined)
    );
  } else {
    console.log('  ⚠ el cliente no tiene gasto en el período: se omiten estas comprobaciones');
  }
  check(
    'las filas sin cruce están marcadas y tienen gasto 0',
    sinCruce.every((r) => Number(r.spend ?? 0) === 0)
  );

  seccion('Datos reales: no se funden campañas distintas');
  // Regresión conocida: 4 pestañas comparten keyword "LSP" mezclando proyectos.
  const { data: md } = await db
    .from('metricas_diarias')
    .select('meta_campaigns,tiktok_campaigns')
    .eq('cliente_id', mejor.publicId)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .limit(2000);
  const nombres = new Set<string>();
  for (const row of (md ?? []) as Record<string, unknown>[]) {
    for (const col of ['meta_campaigns', 'tiktok_campaigns']) {
      for (const c of (row[col] as Record<string, unknown>[] | null) ?? []) {
        const n = String(c.name ?? '').trim();
        if (n) nombres.add(n);
      }
    }
  }
  const porNorm = new Map<string, Set<string>>();
  for (const n of nombres) {
    const k = normLabel(n);
    if (!porNorm.has(k)) porNorm.set(k, new Set());
    porNorm.get(k)!.add(n);
  }
  const colisiones = Array.from(porNorm.entries()).filter(([, s]) => s.size > 1);
  console.log(`  · ${nombres.size} nombres de campaña distintos en el período`);
  check(
    'ningún par de campañas distintas colapsa al mismo nombre normalizado',
    colisiones.length === 0,
    colisiones.map(([k, s]) => `${k} ← ${Array.from(s).join(' | ')}`).join('; ')
  );

  seccion('Datos reales: desglose por anuncio y conjunto');
  for (const dim of ['ad', 'adset'] as const) {
    const filas = await runBiQuery({
      ...base,
      metrics: ['leads_count', 'spend'] as BiMetric[],
      dimension: dim,
      limit: 200,
    });
    const gasto = filas.reduce((s, r) => s + Number(r.spend ?? 0), 0);
    console.log(`  · ${dim}: ${filas.length} filas · $${gasto.toFixed(2)}`);
    check(`${dim} devuelve filas`, filas.length > 0 || spendTotal === 0);
  }

  seccion('Datos reales: el desplegable no ofrece valores fantasma');
  const { runDistinctValues } = await import('../src/lib/report-utm/bi-query');
  const opciones = await runDistinctValues({
    cliente_id: mejor.id,
    dimension: 'utm_campaign',
    date_from: desde,
    date_to: hasta,
  });
  console.log(`  · ${opciones.length} opciones ofrecidas`);
  const clavesReales = new Set(porCampana.map((r) => String(r.dimension_value ?? '')));
  const fantasma = opciones.filter((o) => !clavesReales.has(o));
  check(
    'toda opción del desplegable existe como fila del informe',
    fantasma.length === 0,
    `fantasma: ${fantasma.slice(0, 5).join(', ')}${fantasma.length > 5 ? ` (+${fantasma.length - 5})` : ''}`
  );

  seccion('Datos reales: el filtro por campaña recorta las tres fuentes');
  const objetivo = conAmbos[0] ?? conGasto[0] ?? porCampana[0];
  if (objetivo?.dimension_value) {
    const nombre = String(objetivo.dimension_value);
    const filtrado = await runBiQuery({
      ...base,
      metrics: ['leads_count', 'spend', 'cpl'] as BiMetric[],
      dimension: 'none',
      filters: { utm_campaign: nombre },
    });
    const lf = Number(filtrado[0]?.leads_count ?? 0);
    const sf = Number(filtrado[0]?.spend ?? 0);
    console.log(`  · Filtrando por “${nombre}”: ${lf} leads · $${sf.toFixed(2)}`);
    check('el filtro recorta los leads', lf <= leadsTotal);
    check('el filtro recorta el gasto', sf <= spendTotal + 0.01);
    check(
      'el total filtrado coincide con la fila de la tabla (leads)',
      lf === Number(objetivo.leads_count ?? 0),
      `tabla=${objetivo.leads_count} vs filtro=${lf}`
    );
    check(
      'el total filtrado coincide con la fila de la tabla (gasto)',
      Math.abs(sf - Number(objetivo.spend ?? 0)) <= Math.max(0.5, sf * 0.01),
      `tabla=${objetivo.spend} vs filtro=${sf}`
    );
  } else {
    console.log('  ⚠ sin campañas con las que probar el filtro');
  }
}

verificarDatos()
  .catch((e) => {
    fallos++;
    console.log(`\n✗ error ejecutando las comprobaciones de datos: ${e.message}`);
  })
  .finally(() => {
    if (fallos === 0) {
      console.log('\n✅ Unificación UTM ↔ campañas: todas las comprobaciones pasan\n');
      process.exit(0);
    } else {
      console.log(
        `\n❌ ${fallos} comprobacion${fallos === 1 ? '' : 'es'} fallida${fallos === 1 ? '' : 's'}\n`
      );
      process.exit(1);
    }
  });
