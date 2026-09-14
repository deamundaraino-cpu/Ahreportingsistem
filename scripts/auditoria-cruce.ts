/**
 * Auditoría del cruce leads ↔ campañas, con el resolver REAL. Solo lectura.
 *
 * Es la versión reproducible de la auditoría del 2026-09-14 (docs/22). Aquella
 * se hizo con SQL a mano, que aproximaba la normalización y solo miraba el gasto
 * de Meta. Esto pasa cada lead por `getCrossDiagnostics`, la misma función de
 * /report-utm/cruce-campanas, así que dice exactamente lo que ve el informe.
 *
 * Por cliente: cómo cruzan los leads (por ID, por nombre, a mano, ambiguos, sin
 * cruzar), cuántos traen IDs dedicados (migración 082), qué gasto tiene leads y
 * los nombres ambiguos más frecuentes.
 *
 *   npx tsx --conditions=react-server scripts/auditoria-cruce.ts
 *   npx tsx --conditions=react-server scripts/auditoria-cruce.ts --desde=2026-08-15 --hasta=2026-09-13
 *   npx tsx --conditions=react-server scripts/auditoria-cruce.ts --json
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

const POR_ID = [
  'ad_id',
  'adset_id',
  'campaign_id',
  'utm_id_campaign',
  'utm_id_ad',
  'utm_id_adset',
  'campaign_id_field',
  'content_ad_id',
  'term_adset_id',
];
const POR_NOMBRE = ['name', 'content_ad', 'term_adset'];

function arg(nombre: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a ? a.slice(nombre.length + 3) : null;
}

function diaIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { getCrossDiagnostics } = await import('../src/lib/report-utm/campaign-data');

  // Rango CERRADO por defecto (los 30 días hasta ayer): con hoy dentro, los
  // leads que entran durante la auditoría mueven las cifras entre clientes.
  const ayer = new Date(Date.now() - 86400_000);
  const hasta = arg('hasta') ?? diaIso(ayer);
  const desde = arg('desde') ?? diaIso(new Date(Date.parse(`${hasta}T00:00:00Z`) - 29 * 86400_000));
  const json = process.argv.includes('--json');

  const db = await createAdminClient();
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .not('public_cliente_id', 'is', null)
    .order('nombre');
  if (error) throw new Error(error.message);
  const clientes = (data ?? []) as Array<{ id: string; nombre: string }>;

  const informe = [];
  for (const c of clientes) {
    const d = await getCrossDiagnostics({ cliente_id: c.id, date_from: desde, date_to: hasta });
    const m = d.coverage.methods as Record<string, number>;
    const suma = (claves: string[]) => claves.reduce((s, k) => s + (m[k] ?? 0), 0);
    const fila = {
      cliente: c.nombre.trim(),
      leads: d.coverage.total,
      por_id: suma(POR_ID),
      por_nombre: suma(POR_NOMBRE),
      manual: m.override ?? 0,
      ambiguos: m.ambiguous ?? 0,
      sin_cruzar: m.none ?? 0,
      sin_utm: d.invalid.filter((i) => i.reason === 'sin_utm').reduce((s, i) => s + i.count, 0),
      macros: d.invalid
        .filter((i) => i.reason === 'macro_no_renderizado')
        .reduce((s, i) => s + i.count, 0),
      gasto_con_leads: d.spend?.pct ?? null,
      ids: d.ids,
      top_ambiguos: d.ambiguos.slice(0, 3).map((a) => ({
        valor: a.value,
        leads: a.count,
        campanas: a.candidates.length,
      })),
    };
    informe.push(fila);
  }

  if (json) {
    console.log(JSON.stringify({ desde, hasta, clientes: informe }, null, 2));
    return;
  }

  console.log(`\nAuditoría del cruce · ${desde} → ${hasta}\n`);
  for (const f of informe) {
    if (f.leads === 0) {
      console.log(`■ ${f.cliente}: sin leads en el rango\n`);
      continue;
    }
    console.log(`■ ${f.cliente} — ${f.leads.toLocaleString()} leads que cuentan`);
    console.log(
      `  por ID ${pct(f.por_id, f.leads)} · por nombre ${pct(f.por_nombre, f.leads)} · manual ${pct(f.manual, f.leads)} · ambiguos ${pct(f.ambiguos, f.leads)} · sin cruzar ${pct(f.sin_cruzar, f.leads)}`
    );
    console.log(
      `  sin cruzar: ${f.sin_utm.toLocaleString()} sin UTM · ${f.macros.toLocaleString()} macros sin rellenar · ${(f.sin_cruzar - f.sin_utm - f.macros).toLocaleString()} con valores que no existen`
    );
    console.log(
      f.ids.columnas
        ? `  IDs propios: anuncio ${pct(f.ids.ad, f.ids.total)} · conjunto ${pct(f.ids.adset, f.ids.total)} · campaña ${pct(f.ids.campaign, f.ids.total)}`
        : '  IDs propios: migración 082 sin aplicar'
    );
    console.log(`  gasto con leads: ${f.gasto_con_leads === null ? '—' : `${f.gasto_con_leads}%`}`);
    for (const a of f.top_ambiguos) {
      console.log(`  ambiguo: «${a.valor}» — ${a.leads} leads, existe en ${a.campanas} campañas`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
