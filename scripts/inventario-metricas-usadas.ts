/**
 * ¿Qué métricas del catálogo usa de verdad algún informe o layout?
 *
 * Antes de retirar métricas del selector (reunión del 2026-09-08: «eliminar
 * métricas offline de funnel»), hay que saber cuáles están guardadas en algún
 * sitio. Una métrica que desaparece del catálogo sigue funcionando en el motor
 * —no se borra de él—, pero un informe que la use dejaría de poder editarse
 * limpio. Esto dice cuáles se pueden quitar sin tocar nada guardado.
 *
 * Solo LEE. Busca cada id como texto en:
 *   · public.layouts_reporte   (columnas, tarjetas, gráficos del dashboard clásico)
 *   · public.cliente_tabs      (overrides de layout por pestaña)
 *   · public.bi_reports        (widgets de los informes BI)
 *   · public.notification_rules
 *
 *   npx tsx --conditions=react-server scripts/inventario-metricas-usadas.ts
 *   npx tsx --conditions=react-server scripts/inventario-metricas-usadas.ts --prefijos=offline_,funnel_
 */

import { sqlRemoto } from './sql-remoto';
import { AVAILABLE_METRICS } from '../src/lib/dashboard/metric-catalog';

const args = process.argv.slice(2);
const prefArg = args.find((a) => a.startsWith('--prefijos='));
const PREFIJOS = (prefArg ? prefArg.slice('--prefijos='.length) : 'offline_,funnel_')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FUENTES = [
  { tabla: 'public.layouts_reporte', expr: 't::text' },
  { tabla: 'public.cliente_tabs', expr: 't::text' },
  { tabla: 'public.bi_reports', expr: "t.layout::text || coalesce(t.calculated_fields::text, '')" },
  { tabla: 'public.notification_rules', expr: 't::text' },
];

async function main() {
  const candidatos = AVAILABLE_METRICS.map((m) => m.id).filter((id) =>
    PREFIJOS.some((p) => id.startsWith(p))
  );
  // Las offline dinámicas (offline_leads…) no están en AVAILABLE_METRICS: se
  // añaden a mano para no darlas por muertas sin mirar.
  for (const id of [
    'offline_leads',
    'offline_ventas',
    'offline_revenue',
    'offline_total',
    'offline_cpa',
    'offline_close_rate',
    'offline_roas',
  ]) {
    if (PREFIJOS.some((p) => id.startsWith(p)) && !candidatos.includes(id)) candidatos.push(id);
  }

  console.log(`\nCandidatas (${candidatos.length}) con prefijo ${PREFIJOS.join(', ')}\n`);

  // Una consulta por fuente, con todas las candidatas: el patrón busca el id
  // como palabra completa para que `funnel_roas` no case con `funnel_roas_x`.
  const usos = new Map<string, Array<{ tabla: string; n: number }>>();
  for (const f of FUENTES) {
    const cols = candidatos
      .map(
        (id) =>
          `sum(case when ${f.expr} ~ '(^|[^a-z0-9_])${id}([^a-z0-9_]|$)' then 1 else 0 end) as "${id}"`
      )
      .join(',\n  ');
    let fila: Record<string, unknown> | undefined;
    try {
      [fila] = await sqlRemoto<Record<string, unknown>>(`select\n  ${cols}\nfrom ${f.tabla} t`);
    } catch (e) {
      console.log(
        `  (no se pudo leer ${f.tabla}: ${e instanceof Error ? e.message.slice(0, 120) : e})`
      );
      continue;
    }
    for (const id of candidatos) {
      const n = Number(fila?.[id] ?? 0);
      if (n > 0) {
        const l = usos.get(id) ?? [];
        l.push({ tabla: f.tabla, n });
        usos.set(id, l);
      }
    }
  }

  const usadas = candidatos.filter((id) => usos.has(id));
  const libres = candidatos.filter((id) => !usos.has(id));

  console.log(`EN USO (${usadas.length}) — no se retiran del catálogo:`);
  for (const id of usadas) {
    console.log(
      `  ${id.padEnd(30)} ${usos
        .get(id)!
        .map((u) => `${u.tabla}×${u.n}`)
        .join(', ')}`
    );
  }
  console.log(`\nSIN USO (${libres.length}) — se pueden retirar del selector:`);
  for (const id of libres) console.log(`  ${id}`);
  console.log(`\nJSON_SIN_USO=${JSON.stringify(libres)}`);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
