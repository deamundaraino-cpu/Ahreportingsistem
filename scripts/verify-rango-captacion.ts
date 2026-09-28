/**
 * Discrepancia de leads entre la pestaña del dashboard y el informe (Invest
 * Brokers, sep-2026: 141 contra 153 para "el mismo mes").
 *
 * Dos causas, dos guardas:
 *   1. La pestaña recortaba los datos a su rango de captación y el calendario
 *      decía otra cosa. Ahora el calendario manda; la ventana solo es del
 *      presupuesto (`rango-captacion.ts`).
 *   2. Las dos vistas llamaban «Leads» a dos fuentes distintas. Ahora comparten
 *      rótulo y explicación (`fuentes-de-lead.ts`).
 *
 * Todo PURO: no toca la base ni la red. Forma parte de `test:puro`.
 *
 *   npx tsx --conditions=react-server scripts/verify-rango-captacion.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { diasFueraDeCaptacion } from '../src/lib/dashboard/rango-captacion';
import {
  ROTULO_LEADS_META,
  ROTULO_LEADS_META_TODAS,
  ROTULO_LEADS_RECIBIDOS,
  DESCRIPCION_LEADS_META,
  DESCRIPCION_LEADS_RECIBIDOS,
  descripcionFuenteLead,
} from '../src/lib/leads/fuentes-de-lead';
import { AVAILABLE_METRICS } from '../src/lib/dashboard/metric-catalog';
import { METRIC_META, METRIC_GLOSSARY } from '../src/lib/report-utm/bi-metadata';
import { BASE_REGISTRY } from '../src/lib/report-utm/bi/registry';
import { QUICK_WIDGETS } from '../src/components/report-utm/bi/BiQuickWidgets';

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

// ── 1. Rango de captación ─────────────────────────────────────────────
console.log('\nRango de captación');

const sep = Array.from({ length: 28 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);

check(
  'Invest (ADS HOUSE): 1–28 sep con captación 23 ago–23 sep → 5 días fuera',
  diasFueraDeCaptacion(sep, '2026-08-23', '2026-09-23') === 5
);
check(
  'calendario dentro de la ventana → 0',
  diasFueraDeCaptacion(sep.slice(0, 23), '2026-08-23', '2026-09-23') === 0
);
check('sin ventana → 0', diasFueraDeCaptacion(sep, null, undefined) === 0);
check('solo inicio → cuenta los anteriores', diasFueraDeCaptacion(sep, '2026-09-26', null) === 25);
check('solo fin → cuenta los posteriores', diasFueraDeCaptacion(sep, null, '2026-09-26') === 2);
check(
  'fechas repetidas (varias filas por día) cuentan una vez',
  diasFueraDeCaptacion(['2026-09-27', '2026-09-27', '2026-09-28'], null, '2026-09-26') === 2
);
check(
  'los extremos son inclusivos',
  diasFueraDeCaptacion(['2026-09-23'], null, '2026-09-23') === 0
);

// Regresión: el dashboard NO debe volver a recortar las filas a la ventana.
// Es una guarda de texto a propósito: la lógica vive en un `useMemo` de un
// componente cliente que no se puede montar desde aquí.
const dashboard = readFileSync(
  join(process.cwd(), 'src', 'app', '(app)', 'dashboard', 'components', 'DashboardClient.tsx'),
  'utf8'
);
check(
  'DashboardClient no filtra filas por fecha_finalizacion',
  !/\.fecha\s*<=\s*activeTabObj\??\.fecha_finalizacion/.test(dashboard)
);
check(
  'DashboardClient no filtra filas por fecha_inicio',
  !/\.fecha\s*>=\s*activeTabObj\??\.fecha_inicio/.test(dashboard)
);

// ── 2. Un solo vocabulario para los leads ─────────────────────────────
console.log('\nRótulos de leads');

const catalogo = (id: string) => AVAILABLE_METRICS.find((m) => m.id === id)?.label;

check(
  'dashboard meta_leads_form = «Leads Meta (atribuidos)»',
  catalogo('meta_leads_form') === ROTULO_LEADS_META
);
check(
  'dashboard meta_leads = «Leads Meta (todas las acciones)»',
  catalogo('meta_leads') === ROTULO_LEADS_META_TODAS
);
check(
  'dashboard utm_leads = «Leads recibidos (contactos)»',
  catalogo('utm_leads') === ROTULO_LEADS_RECIBIDOS
);

check(
  'BI leads_form = mismo rótulo que el dashboard',
  METRIC_META.leads_form.label === ROTULO_LEADS_META
);
check(
  'BI leads_count = mismo rótulo que el dashboard',
  METRIC_META.leads_count.label === ROTULO_LEADS_RECIBIDOS
);

check(
  'registro ads.leads_form: rótulo y ayuda compartidos',
  BASE_REGISTRY.measure('ads.leads_form')?.label === ROTULO_LEADS_META &&
    BASE_REGISTRY.measure('ads.leads_form')?.help === DESCRIPCION_LEADS_META
);
check(
  'registro leads.count: rótulo y ayuda compartidos',
  BASE_REGISTRY.measure('leads.count')?.label === ROTULO_LEADS_RECIBIDOS &&
    BASE_REGISTRY.measure('leads.count')?.help === DESCRIPCION_LEADS_RECIBIDOS
);
check(
  'glosario BI leads_form = tooltip del dashboard',
  METRIC_GLOSSARY.leads_form === DESCRIPCION_LEADS_META
);
check(
  'glosario BI leads_count = tooltip del dashboard',
  METRIC_GLOSSARY.leads_count === DESCRIPCION_LEADS_RECIBIDOS
);

check(
  'widget rápido de leads no se llama «Leads» a secas',
  QUICK_WIDGETS.filter((w) => w.metric === 'leads_count').every(
    (w) => w.title === ROTULO_LEADS_RECIBIDOS
  )
);

// Ningún texto visible debe seguir llamando «píxel» a los leads atribuidos.
const textos = [
  ...Object.values(METRIC_GLOSSARY),
  ...BASE_REGISTRY.measures().map((m) => `${m.label} ${m.help}`),
];
check(
  'ningún texto menciona los rótulos antiguos',
  !textos.some((t) => /Leads del píxel de Meta|“Leads \(contactos\)”/.test(t))
);

// ── 3. Tooltip de las tarjetas ────────────────────────────────────────
console.log('\nTooltip de fuente');

check(
  'meta_leads_form → explica Meta',
  descripcionFuenteLead('meta_leads_form') === DESCRIPCION_LEADS_META
);
check(
  'utm_leads → explica contactos',
  descripcionFuenteLead('utm_leads') === DESCRIPCION_LEADS_RECIBIDOS
);
check(
  'con espacios alrededor también',
  descripcionFuenteLead('  meta_leads_form ') === DESCRIPCION_LEADS_META
);
check('meta_leads → tiene explicación', descripcionFuenteLead('meta_leads') !== null);
check(
  'un CPL no es un conteo de leads → sin tooltip',
  descripcionFuenteLead('meta_spend / meta_leads_form') === null
);
check('gasto → sin tooltip', descripcionFuenteLead('meta_spend') === null);
check(
  'vacío → sin tooltip',
  descripcionFuenteLead('') === null && descripcionFuenteLead(undefined) === null
);

console.log(`\n${ok} ok, ${fail} fallos`);
if (fail > 0) process.exit(1);
