/**
 * Rellena `lead_events.campaign_id / adset_id / ad_id` en el histórico
 * (migración 082). En seco por defecto: solo cuenta lo que haría.
 *
 *   npx tsx --conditions=react-server scripts/backfill-ids-leads.ts            # informe
 *   npx tsx --conditions=react-server scripts/backfill-ids-leads.ts --aplicar  # escribe
 *
 * De dónde sale cada ID:
 *   · GoHighLevel  → la atribución que el contacto ya trae guardada en
 *                    `custom_data` (`idsDeContacto`, la misma función que la ingesta).
 *   · Meta Lead Ads → campaña (`utm_id`) + conjunto (`utm_term`) + anuncio
 *                    (`utm_content`), buscados en `metricas_diarias.meta_ads`.
 *                    Solo se escribe si esa terna lleva a UN anuncio; si el mismo
 *                    nombre de anuncio existe dos veces en el mismo conjunto, no
 *                    se elige y se cuenta como ambiguo.
 *   · S2S          → los parámetros `campaign_id`, `adset_id` y `ad_id` de la
 *                    `page_url`, si la landing ya los llevaba.
 *
 * Nunca pisa un ID que ya esté: rellena solo los que faltan.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

type Ids = { campaign_id: string | null; adset_id: string | null; ad_id: string | null };
type Lead = Record<string, unknown> & { id: string };

const CHUNK_DIAS = 10;

function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Solo los IDs que faltan en la fila: el backfill nunca pisa. */
function faltantes(actual: Lead, nuevos: Ids, conCols: boolean): Partial<Ids> {
  const out: Partial<Ids> = {};
  for (const k of ['campaign_id', 'adset_id', 'ad_id'] as const) {
    if (!nuevos[k]) continue;
    if (conCols && actual[k]) continue;
    out[k] = nuevos[k];
  }
  return out;
}

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { fetchAllRows } = await import('../src/lib/supabase-paginate');
  const { normLabel } = await import('../src/lib/report-utm/bi-metadata');
  const { COLUMNAS_ID, columnasIdDisponibles, idsPublicitarios } =
    await import('../src/lib/report-utm/lead-ids');
  const { idsDeContacto } = await import('../src/lib/report-utm/ghl-leads');

  const db = await createAdminClient();
  const rtm = db.schema('report_utm');
  const conCols = await columnasIdDisponibles(db);
  if (aplicar && !conCols) {
    console.error('❌ La migración 082 no está aplicada: no hay columnas que rellenar.');
    console.error('   npx tsx scripts/sql-remoto.ts migrations/082_ids_publicitarios_en_leads.sql');
    process.exit(1);
  }
  if (!conCols)
    console.log('ℹ️  Migración 082 sin aplicar: informe en seco sobre todos los leads.\n');

  const extra = conCols ? `,${COLUMNAS_ID.join(',')}` : '';
  const { data: clientes } = await rtm
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .order('nombre');

  const cambios: Array<{ id: string; ids: Partial<Ids> }> = [];
  const resumen: Array<Record<string, unknown>> = [];

  for (const c of (clientes ?? []) as Array<{
    id: string;
    nombre: string;
    public_cliente_id: string | null;
  }>) {
    const nombre = c.nombre.trim();

    // ── GoHighLevel ────────────────────────────────────────────────
    const ghl = (await fetchAllRows(() =>
      rtm
        .from('lead_events')
        .select(
          `id,attribution_source:custom_data->attribution_source,last_attribution_source:custom_data->last_attribution_source${extra}`
        )
        .eq('cliente_id', c.id)
        .eq('source', 'gohighlevel')
    )) as Lead[];
    let ghlCon = 0;
    for (const l of ghl) {
      const ids = idsDeContacto({
        attributionSource: l.attribution_source ?? undefined,
        lastAttributionSource: l.last_attribution_source ?? undefined,
      } as Parameters<typeof idsDeContacto>[0]);
      const f = faltantes(l, ids, conCols);
      if (Object.keys(f).length) {
        ghlCon++;
        cambios.push({ id: l.id, ids: f });
      }
    }

    // ── S2S con IDs en la URL ──────────────────────────────────────
    const s2s = (await fetchAllRows(() =>
      rtm
        .from('lead_events')
        .select(`id,page_url${extra}`)
        .eq('cliente_id', c.id)
        .eq('source', 's2s')
        .or('page_url.ilike.*ad_id=*,page_url.ilike.*adset_id=*,page_url.ilike.*campaign_id=*')
    )) as Lead[];
    let s2sCon = 0;
    for (const l of s2s) {
      let qs: URLSearchParams | null = null;
      try {
        qs = new URL(String(l.page_url)).searchParams;
      } catch {
        continue;
      }
      const ids = idsPublicitarios(qs.get('campaign_id'), qs.get('adset_id'), qs.get('ad_id'));
      const f = faltantes(l, ids, conCols);
      if (Object.keys(f).length) {
        s2sCon++;
        cambios.push({ id: l.id, ids: f });
      }
    }

    // ── Meta Lead Ads ──────────────────────────────────────────────
    const meta = (await fetchAllRows(() =>
      rtm
        .from('lead_events')
        .select(`id,created_at,utm_id,utm_content,utm_term${extra}`)
        .eq('cliente_id', c.id)
        .eq('source', 'meta_lead_ads')
    )) as Lead[];
    let metaCon = 0;
    let metaAmbiguos = 0;
    let metaSinAnuncio = 0;
    if (meta.length > 0 && c.public_cliente_id) {
      const fechas = meta.map((l) => String(l.created_at).slice(0, 10)).sort();
      // Anuncios de todo el periodo de los leads, con 3 días de margen (un lead
      // de las 23:59 en Colombia es del día siguiente en UTC).
      const desde = sumarDias(fechas[0], -3);
      const hasta = sumarDias(fechas[fechas.length - 1], 3);
      const terna = new Map<string, Map<string, string>>(); // campaña|conjunto|anuncio → ad_id → adset_id
      for (let d = desde; d <= hasta; d = sumarDias(d, CHUNK_DIAS)) {
        const fin = sumarDias(d, CHUNK_DIAS - 1);
        const { data: filas, error } = await db
          .from('metricas_diarias')
          .select('meta_ads')
          .eq('cliente_id', c.public_cliente_id)
          .gte('fecha', d)
          .lte('fecha', fin > hasta ? hasta : fin);
        if (error) throw new Error(`metricas_diarias ${nombre}: ${error.message}`);
        for (const f of filas ?? []) {
          for (const a of ((f as { meta_ads: unknown }).meta_ads as Record<string, unknown>[]) ??
            []) {
            if (!a.ad_id || !a.campaign_id) continue;
            const k = `${a.campaign_id}|${normLabel(String(a.adset_name ?? ''))}|${normLabel(String(a.ad_name ?? ''))}`;
            let m = terna.get(k);
            if (!m) {
              m = new Map();
              terna.set(k, m);
            }
            m.set(String(a.ad_id), a.adset_id ? String(a.adset_id) : '');
          }
        }
      }
      for (const l of meta) {
        const k = `${l.utm_id ?? ''}|${normLabel(String(l.utm_term ?? ''))}|${normLabel(String(l.utm_content ?? ''))}`;
        const m = terna.get(k);
        if (!m) {
          metaSinAnuncio++;
          continue;
        }
        if (m.size > 1) {
          metaAmbiguos++;
          continue;
        }
        const [adId, adsetId] = m.entries().next().value as [string, string];
        const ids = idsPublicitarios(l.utm_id, adsetId, adId);
        const f = faltantes(l, ids, conCols);
        if (Object.keys(f).length) {
          metaCon++;
          cambios.push({ id: l.id, ids: f });
        }
      }
    }

    if (ghl.length + s2s.length + meta.length > 0) {
      resumen.push({
        cliente: nombre,
        ghl: `${ghlCon}/${ghl.length}`,
        s2s_con_ids_en_url: `${s2sCon}/${s2s.length}`,
        meta_lead_ads: `${metaCon}/${meta.length}`,
        meta_ambiguos: metaAmbiguos,
        meta_sin_anuncio_en_gasto: metaSinAnuncio,
      });
    }
  }

  console.table(resumen);
  console.log(`\nLeads con IDs que rellenar: ${cambios.length.toLocaleString()}`);

  if (!aplicar) {
    console.log('En seco: no se ha escrito nada. Con --aplicar se escriben.');
    return;
  }

  // Una actualización por lead (cada uno lleva sus propios IDs), en tandas
  // concurrentes pequeñas para no saturar PostgREST.
  const TANDA = 20;
  let hechos = 0;
  let errores = 0;
  for (let i = 0; i < cambios.length; i += TANDA) {
    const tanda = cambios.slice(i, i + TANDA);
    const res = await Promise.all(
      tanda.map((x) => rtm.from('lead_events').update(x.ids).eq('id', x.id))
    );
    for (const r of res) {
      if (r.error) errores++;
      else hechos++;
    }
  }
  console.log(`✅ Actualizados ${hechos.toLocaleString()} · errores ${errores}`);
  if (errores > 0) process.exit(1);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
