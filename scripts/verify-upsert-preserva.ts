/**
 * Comprobaciones de la corrección del borrado silencioso de gasto y leads.
 *
 * ── El fallo ─────────────────────────────────────────────────────────────
 * El worker «preserva» los datos de una plataforma omitiendo sus claves del
 * objeto del upsert. En un lote mezclado eso no preservaba: PostgREST normaliza
 * el insert masivo a UNA lista de columnas (la unión de todas las claves) y
 * rellena con NULL las filas que no traen una clave, que el ON CONFLICT DO
 * UPDATE escribe encima. Sur Profundo perdió así 4 días de Meta (24-27 jul
 * 2026): 3.385.086 COP y 432 leads que el worker SÍ había descargado.
 *
 * Todo lo de aquí es puro o de lectura del repo: no toca base de datos ni APIs.
 *
 *   npx tsx scripts/verify-upsert-preserva.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { agruparPorForma, firmaDeFila, plataformasOmitidas } from '../src/lib/sync/upsert-batches';
import { mapElemento, expandirFila } from '../src/lib/ads/ads-daily-writer';
import { clienteOcupado, releaseJob } from '../src/lib/sync/queue';

let pasadas = 0;
let fallidas = 0;

function check(nombre: string, condicion: boolean, detalle?: string) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallidas++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);
}

const leerFuente = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

// ════════════════════════════════════════════════════════════
seccion('agruparPorForma: lotes homogéneos');
// ════════════════════════════════════════════════════════════

// Reproduce el lote exacto que produjo el fallo: una corrida donde la ventana
// de Meta (7 días) ya no cubre unas fechas que TikTok (3 días) sí re-pide.
const CLIENTE = 'd6c0b6ea-825d-4246-9c7a-103633c7fc0a';
const conAmbas = (fecha: string) => ({
  cliente_id: CLIENTE,
  fecha,
  sync_hash: 'h',
  meta_spend: 1039587,
  meta_impressions: 231418,
  meta_clicks: 6072,
  meta_campaigns: [],
  tiktok_spend: 237866,
  tiktok_campaigns: [],
  synced_at: 'now',
  is_partial: false,
});
/** Meta omitida a propósito: debe conservarse lo que ya hay en BD. */
const soloTikTok = (fecha: string) => ({
  cliente_id: CLIENTE,
  fecha,
  sync_hash: 'h',
  tiktok_spend: 179364,
  tiktok_campaigns: [],
  synced_at: 'now',
  is_partial: false,
});

const lote = [
  soloTikTok('2026-07-24'),
  soloTikTok('2026-07-25'),
  soloTikTok('2026-07-26'),
  soloTikTok('2026-07-27'),
  conAmbas('2026-07-28'),
  conAmbas('2026-07-29'),
];
const grupos = agruparPorForma(lote);

check('el lote mezclado se parte en 2 grupos', grupos.length === 2, `salieron ${grupos.length}`);
check(
  'no se pierde ni se duplica ninguna fila',
  grupos.reduce((n, g) => n + g.length, 0) === lote.length
);
check(
  'cada grupo es homogéneo (misma firma en todas sus filas)',
  grupos.every((g) => new Set(g.map(firmaDeFila)).size === 1)
);

// Esta es LA invariante: si dentro de un grupo hubiera claves distintas,
// PostgREST rellenaría con NULL y volvería a borrar gasto ya descargado.
const clavesPorGrupo = grupos.map((g) => g.map((f) => Object.keys(f).sort().join('|')));
check(
  'ninguna fila de un grupo aporta columnas que otra no tenga',
  clavesPorGrupo.every((g) => g.every((k) => k === g[0]))
);

const grupoSinMeta = grupos.find((g) => !('meta_spend' in g[0]))!;
check(
  'el grupo sin Meta agrupa las 4 fechas del incidente real',
  grupoSinMeta.length === 4 &&
    grupoSinMeta.map((f) => f.fecha).join(',') === '2026-07-24,2026-07-25,2026-07-26,2026-07-27'
);
check(
  'el grupo sin Meta NO lleva ninguna columna meta_*',
  Object.keys(grupoSinMeta[0]).every((k) => !k.startsWith('meta_'))
);

check(
  'un lote homogéneo sigue siendo un solo grupo',
  agruparPorForma([conAmbas('2026-08-01'), conAmbas('2026-08-02')]).length === 1
);
check('lote vacío → sin grupos', agruparPorForma([]).length === 0);
check(
  'conserva el orden de aparición',
  grupos[0][0].fecha === '2026-07-24' && grupos[1][0].fecha === '2026-07-28'
);

// El orden de las claves en el objeto no puede cambiar la firma: si lo hiciera,
// dos filas idénticas caerían en grupos distintos y se multiplicarían las queries.
check(
  'la firma no depende del orden de las claves',
  firmaDeFila({ b: 1, a: 2 }) === firmaDeFila({ a: 2, b: 1 })
);

// ════════════════════════════════════════════════════════════
seccion('plataformasOmitidas: qué se está conservando');
// ════════════════════════════════════════════════════════════

check('detecta Meta omitida', plataformasOmitidas(soloTikTok('2026-07-24')).join() === 'meta');
check(
  'sin omisiones cuando vienen las dos',
  plataformasOmitidas(conAmbas('2026-07-28')).length === 0
);
check(
  'detecta las dos omitidas',
  plataformasOmitidas({ cliente_id: CLIENTE, fecha: 'x' }).join() === 'meta,tiktok'
);

// ════════════════════════════════════════════════════════════
seccion('El worker usa los grupos (no el lote entero)');
// ════════════════════════════════════════════════════════════

const worker = leerFuente('src/app/api/worker/route.ts');

check(
  'importa el helper de agrupación',
  /import \{[^}]*agruparPorForma[^}]*\} from '@\/lib\/sync\/upsert-batches'/.test(worker)
);
check(
  'NO queda ningún upsert del lote completo a metricas_diarias',
  !/\.upsert\(upsertPayloads/.test(worker),
  'un upsert del array sin agrupar reintroduce el borrado por NULL'
);
check(
  'el upsert de metricas_diarias recibe el grupo',
  /from\('metricas_diarias'\)\s*\n\s*\.upsert\(filas,/.test(worker)
);

// El espejo ads_daily tenía el mismo agujero por otra vía: si una fecha conserva
// Meta de BD no genera filas Meta nuevas, y el borrado por fecha a secas se
// llevaba por delante el espejo bueno (comprobado: 24-27 jul quedaron solo con
// TikTok en ads_daily).
check(
  'la limpieza de ads_daily está acotada por plataforma',
  /\.from\('ads_daily'\)\s*\n\s*\.delete\(\)[\s\S]{0,200}?\.eq\('plataforma', plataforma\)/.test(
    worker
  ),
  'sin filtrar por plataforma, el borrado elimina el espejo que se estaba conservando'
);

// ════════════════════════════════════════════════════════════
seccion('Familia lead de Meta: variantes nativas/agrupadas');
// ════════════════════════════════════════════════════════════

// La cuenta de Sur Profundo emite estos action_types y el worker los registraba
// como «sin mapear», así que meta_leads salía a 0 para los formularios nativos.
const familiaLead = worker.match(/lead:\s*\[([^\]]*)\]/)?.[1] ?? '';
for (const tipo of [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'omni_lead',
  'onsite_conversion.lead',
  'onsite_conversion.lead_grouped',
  'onsite_web_lead',
]) {
  check(`la familia lead incluye ${tipo}`, familiaLead.includes(`'${tipo}'`));
}
// El agregado por familia es un MAX entre variantes; si fuera una suma, añadir
// variantes duplicaría el mismo evento reportado de varias formas.
check(
  'el agregado por familia sigue siendo MAX (no suma)',
  /variants\.reduce\(\(max, v\) => Math\.max\(max, exact\[v\] \?\? 0\), 0\)/.test(worker)
);

// ════════════════════════════════════════════════════════════
seccion('TikTok: anuncios y conjuntos llevan su campaña');
// ════════════════════════════════════════════════════════════

check(
  'el catálogo de TikTok guarda la jerarquía',
  /padresAds/.test(worker) && /padresAdgroups/.test(worker)
);
check(
  'las filas de nivel ad/adgroup adjuntan campaign_id',
  /campaign_id:\s*campaignId/.test(worker)
);
check(
  'la campaña se resuelve a nombre desde el catálogo',
  /campaign_name:\s*campaignId \? \(?campaignMap\.get\(campaignId\)/.test(worker)
);

// Efecto real aguas abajo: sin campaña, el motor BI descarta la fila entera en
// cuanto hay un filtro por campaña (bi-query.ts: «sin nombre no se puede
// comprobar el filtro»). Con ella, el espejo la propaga.
const adgroupFila = mapElemento(
  'tiktok_adgroups',
  {
    adgroup_id: '1871435133625346',
    adgroup_name: '[]ADVANTAGE][28-60][AYSÉN][HM][AUTOMATICO]',
    campaign_id: '1871435133624754',
    campaign_name: 'DX - AH [060826] [LSP] - [EVS] [CAPTACIÓN][ABO][TANDA 1] [CHILE]',
    spend: 126835,
    clicks: 1060,
    impressions: 67055,
    conversions: 52,
    account_id: '7387511059776798737',
  },
  { cliente_id: CLIENTE, fecha: '2026-08-04' }
)!;

check(
  'ads_daily recibe la campaña del conjunto TikTok',
  adgroupFila.campana_id === '1871435133624754' &&
    adgroupFila.campana_nombre?.includes('[LSP] - [EVS]') === true
);
check(
  'el conjunto conserva su propia identidad',
  adgroupFila.nivel === 'adset' && adgroupFila.entidad_id === '1871435133625346'
);
check(
  'la campaña NO se cuela como evento numérico',
  !('campaign_id' in adgroupFila.eventos) && !('campaign_name' in adgroupFila.eventos)
);

const adFila = mapElemento(
  'tiktok_ads',
  {
    ad_id: '99',
    ad_name: 'AD 1',
    campaign_id: '1871435133624754',
    campaign_name: 'C1',
    adset_id: '1871435133625346',
    adset_name: 'AG 1',
    spend: 10,
    account_id: '7387511059776798737',
  },
  { cliente_id: CLIENTE, fecha: '2026-08-04' }
)!;
check(
  'el anuncio TikTok cuelga de campaña y conjunto',
  adFila.campana_id === '1871435133624754' && adFila.adset_id === '1871435133625346'
);

// Una fila sin jerarquía (campaña borrada en TikTok) no puede romper el espejo.
const sinPadre = mapElemento(
  'tiktok_adgroups',
  {
    adgroup_id: '1',
    adgroup_name: 'X',
    campaign_id: null,
    campaign_name: null,
    spend: 5,
  },
  { cliente_id: CLIENTE, fecha: '2026-08-04' }
);
check(
  'sin campaña conocida la fila sigue existiendo',
  sinPadre !== null && sinPadre.campana_id === null && sinPadre.spend === 5
);

// El espejo completo de un día no debe perder niveles por el cambio.
const filasEspejo = expandirFila(
  {
    cliente_id: CLIENTE,
    fecha: '2026-08-04',
    tiktok_campaigns: [{ campaign_id: 'c1', name: 'C1', spend: 1 }],
    tiktok_adgroups: [
      { adgroup_id: 'g1', adgroup_name: 'G1', campaign_id: 'c1', campaign_name: 'C1', spend: 2 },
    ],
    tiktok_ads: [
      {
        ad_id: 'a1',
        ad_name: 'A1',
        campaign_id: 'c1',
        campaign_name: 'C1',
        adset_id: 'g1',
        spend: 3,
      },
    ],
  },
  { hoy: '2026-08-05' }
);
check(
  'el espejo genera los 3 niveles de TikTok',
  new Set(filasEspejo.map((f) => f.nivel)).size === 3
);
check(
  'los 3 niveles comparten la misma campaña',
  filasEspejo.every((f) => f.campana_id === 'c1')
);

// ════════════════════════════════════════════════════════════
// Serialización por cliente en la cola
// ════════════════════════════════════════════════════════════

// claim_sync_job (SKIP LOCKED) garantiza que un JOB no se entrega dos veces,
// pero no que un CLIENTE no se procese dos veces a la vez: se observaron 5
// corridas del mismo cliente en 3 minutos, con rangos solapados.
type Filtro = { col: string; val: unknown };
function dbStub(filas: Array<Record<string, unknown>>) {
  const aplicados: Filtro[] = [];
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      aplicados.push({ col, val });
      return q;
    },
    neq: (col: string, val: unknown) => {
      aplicados.push({ col: `!${col}`, val });
      return q;
    },
    gte: (col: string, val: unknown) => {
      aplicados.push({ col: `>=${col}`, val });
      return q;
    },
    limit: () => Promise.resolve({ data: filas, error: null }),
    update: (patch: Record<string, unknown>) => {
      aplicados.push({ col: 'update', val: patch });
      return q;
    },
  };
  // `update(...).eq(...)` cierra la cadena: hace falta ser thenable.
  q.then = (r: (v: unknown) => void) => r({ error: null });
  return { db: { from: () => q }, aplicados };
}

async function comprobarCola() {
  seccion('Serialización por cliente en la cola');

  const ocupado = dbStub([{ id: 'otro-job' }]);
  check(
    'cliente con otro job vivo → ocupado',
    (await clienteOcupado(ocupado.db, CLIENTE, 'job-actual', 'worker-a')) === true
  );
  check(
    'se excluye el propio job y el propio ejecutor',
    ocupado.aplicados.some((f) => f.col === '!id' && f.val === 'job-actual') &&
      ocupado.aplicados.some((f) => f.col === '!locked_by' && f.val === 'worker-a')
  );
  check(
    'solo cuenta el lease vivo (locked_at reciente)',
    ocupado.aplicados.some((f) => f.col === '>=locked_at')
  );
  check(
    'solo mira jobs en curso',
    ocupado.aplicados.some((f) => f.col === 'estado' && f.val === 'running')
  );

  check(
    'sin otros jobs → libre',
    (await clienteOcupado(dbStub([]).db, CLIENTE, 'job-actual', 'worker-a')) === false
  );
  check(
    'un job global (sin cliente) nunca bloquea',
    (await clienteOcupado(dbStub([{ id: 'x' }]).db, null, 'job-actual', 'worker-a')) === false
  );

  const liberado = dbStub([]);
  await releaseJob(liberado.db, 'job-1');
  const patch = liberado.aplicados.find((f) => f.col === 'update')?.val as Record<string, unknown>;
  check(
    'releaseJob devuelve el job a pending sin gastar intentos',
    patch?.estado === 'pending' &&
      patch?.locked_at === null &&
      patch?.locked_by === null &&
      !('intentos' in patch) &&
      !('last_error' in patch)
  );

  const runner = leerFuente('src/lib/sync/runner.ts');
  check(
    'el runner comprueba si el cliente está ocupado antes de ejecutar',
    /clienteOcupado\(db, job\.cliente_id, job\.id, opts\.workerId/.test(runner)
  );
  check(
    'el job devuelto a la cola no cuenta como reclamado',
    runner.indexOf('await releaseJob(db, job.id)') < runner.indexOf('result.claimed++')
  );
  check(
    'no gira en vacío: corta si vuelve el mismo job liberado',
    /if \(liberados\.has\(job\.id\)\) break/.test(runner)
  );
}

comprobarCola().then(() => {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pasadas} comprobaciones pasadas, ${fallidas} fallidas`);
  console.log('═'.repeat(66));
  process.exit(fallidas > 0 ? 1 : 0);
});
