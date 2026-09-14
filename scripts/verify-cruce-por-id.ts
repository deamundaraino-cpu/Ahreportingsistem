/**
 * Comprobaciones del cruce por ID en los tres niveles (campaign-resolver.ts).
 *
 * Reproduce lo que se vio el 2026-09-08 en Cris Tributario: GoHighLevel manda a
 * veces el NOMBRE de campaña, conjunto y anuncio en los UTM, y a veces su ID.
 * Con el ID, el conjunto y el anuncio salían en el informe como `120212…` y no
 * había forma de corregirlos.
 *
 * Y lo que encontró la auditoría del 2026-09-14 (docs/22): IDs dedicados en el
 * lead (migración 082), nombres de anuncio repetidos entre campañas, campañas
 * renombradas y UTMs que llegan URL-encoded.
 *
 * Todo es puro: el índice se construye a mano o con `construirIndice`, sin Postgres.
 *
 *   npx tsx --conditions=react-server scripts/verify-cruce-por-id.ts
 */

import {
  buildResolver,
  construirIndice,
  esIdMeta,
  matchToCampaign,
  type CampaignIndex,
  type Override,
} from '../src/lib/report-utm/campaign-resolver';
import { normLabel } from '../src/lib/report-utm/bi-metadata';
import { adaptarIds, idsPublicitarios } from '../src/lib/report-utm/lead-ids';
import { utmDeFilaSheet } from '../src/lib/sheets/atribucion';
import { buildLeadRow as buildLeadRowGhl, idsDeContacto } from '../src/lib/report-utm/ghl-leads';
import type { GhlContact } from '../src/lib/report-utm/ghl-client';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ── Índice de un cliente con una campaña, un conjunto y dos anuncios ──
const CAMP_ID = '120200000000000001';
const ADSET_ID = '120200000000000010';
const AD_ID = '120200000000000100';
const AD2_ID = '120200000000000200';
const CAMP = '[CRIS] Beneficios Tributarios 🚀';
const ADSET = '[CRIS] Inversionistas inmobiliarios';
const AD = 'Reel 4 agosto';
const AD2 = 'Carrusel testimonios';
const KEY = `meta:${CAMP_ID}`;

function indice(): CampaignIndex {
  const idx: CampaignIndex = {
    campaigns: new Map([
      [
        KEY,
        {
          key: KEY,
          campaign_id: CAMP_ID,
          name: CAMP,
          platform: 'meta',
          spend: 3500,
          impressions: 10000,
          clicks: 400,
          platform_leads: 14,
          extra: {},
        },
      ],
    ]),
    byCampaignId: new Map([[CAMP_ID, KEY]]),
    byAdId: new Map([
      [AD_ID, KEY],
      [AD2_ID, KEY],
    ]),
    byName: new Map([[normLabel(CAMP), KEY]]),
    byAdName: new Map([
      [normLabel(AD), new Set([KEY])],
      [normLabel(AD2), new Set([KEY])],
    ]),
    byAdsetName: new Map([[normLabel(ADSET), new Set([KEY])]]),
    adCanonicalByName: new Map([
      [normLabel(AD), AD],
      [normLabel(AD2), AD2],
    ]),
    adByAdId: new Map([
      [AD_ID, AD],
      [AD2_ID, AD2],
    ]),
    adsetCanonicalByName: new Map([[normLabel(ADSET), ADSET]]),
    adsetByAdId: new Map([
      [AD_ID, ADSET],
      [AD2_ID, ADSET],
    ]),
    adsActivos: new Set([AD, AD2]),
    adsetsActivos: new Set([ADSET]),
    adsetByAdsetId: new Map([[ADSET_ID, ADSET]]),
    byAdsetId: new Map([[ADSET_ID, KEY]]),
    adCatalog: new Map(),
    adsetCatalog: new Map(),
  };
  return idx;
}

const idx = indice();
const r = buildResolver(idx, []);

// ── 1. Qué es un ID ───────────────────────────────────────────────────
console.log('\n1. Detección de IDs');
check('un ID de Meta de 18 dígitos es ID', esIdMeta(AD_ID));
check('con espacios alrededor también', esIdMeta(`  ${AD_ID} `));
check('un nombre no es ID', !esIdMeta(AD));
check('un anuncio llamado «2026» NO es ID (umbral de 10 dígitos)', !esIdMeta('2026'));
check('null / vacío no es ID', !esIdMeta(null) && !esIdMeta(''));
check('un ID con letras no es ID', !esIdMeta('as:120200000000000010'));

// ── 2. Lo que ya funcionaba sigue igual ───────────────────────────────
console.log('\n2. Cascada previa intacta');
check(
  'utm_id = ID de campaña cruza por utm_id_campaign',
  matchToCampaign({ utm_id: CAMP_ID }, idx, []).method === 'utm_id_campaign'
);
check(
  'utm_id = ID de anuncio cruza por utm_id_ad',
  matchToCampaign({ utm_id: AD_ID }, idx, []).method === 'utm_id_ad'
);
check(
  'nombre de campaña con emojis y corchetes cruza por nombre',
  matchToCampaign({ utm_campaign: CAMP }, idx, []).method === 'name'
);
check('nombre de anuncio → su nombre real', r.adOf({ utm_content: 'reel_4_agosto' }).label === AD);
check('nombre de conjunto → su nombre real', r.adsetOf({ utm_term: ADSET }).label === ADSET);
check(
  'un nombre de anuncio único sigue cruzando a su campaña',
  matchToCampaign({ utm_content: AD }, idx, []).method === 'content_ad'
);

// ── 3. El caso de la reunión: el ID llega en el campo del nombre ──────
console.log('\n3. ID en el campo del nombre');
const m1 = matchToCampaign({ utm_campaign: CAMP_ID }, idx, []);
check(
  'ID de campaña en utm_campaign → cruza (campaign_id_field)',
  m1.key === KEY && m1.method === 'campaign_id_field'
);
const m2 = matchToCampaign({ utm_content: AD_ID }, idx, []);
check(
  'ID de anuncio en utm_content → cruza (content_ad_id)',
  m2.key === KEY && m2.method === 'content_ad_id'
);
const m3 = matchToCampaign({ utm_term: ADSET_ID }, idx, []);
check(
  'ID de conjunto en utm_term → cruza (term_adset_id)',
  m3.key === KEY && m3.method === 'term_adset_id'
);

const anuncio = r.adOf({ utm_content: AD_ID });
check('el anuncio se titula con su NOMBRE, no con el ID', anuncio.label === AD && anuncio.matched);
const conjunto = r.adsetOf({ utm_term: ADSET_ID });
check(
  'el conjunto se titula con su NOMBRE, no con el ID',
  conjunto.label === ADSET && conjunto.matched
);
const conjuntoPorAnuncio = r.adsetOf({ utm_content: AD2_ID });
check(
  'sin utm_term, el ID del anuncio en utm_content delata su conjunto',
  conjuntoPorAnuncio.label === ADSET && conjuntoPorAnuncio.matched
);
check(
  'la campaña del lead con solo IDs sale con su nombre real',
  r.campaignOf({ utm_content: AD_ID, utm_term: ADSET_ID }).label === CAMP
);

// ── 4. Lo que NO debe pasar ───────────────────────────────────────────
console.log('\n4. Casos que no deben cruzar');
const huerfano = r.adOf({ utm_content: '999999999999999999' });
check(
  'un ID que el índice no conoce no se inventa un nombre',
  !huerfano.matched && huerfano.label === '999999999999999999'
);
check(
  'un nombre desconocido sigue siendo su propia fila',
  !r.adOf({ utm_content: 'Anuncio que no existe' }).matched
);
check(
  'un nombre que parece número corto no busca por ID',
  matchToCampaign({ utm_content: '2026' }, idx, []).method === 'none'
);

// ── 5. Corrección manual por nivel ────────────────────────────────────
console.log('\n5. Corrección manual por nivel');
const OV_AD: Override = {
  match_field: 'utm_content',
  match_value: 'anuncio viejo renombrado',
  platform: 'meta',
  campaign_id: null,
  campaign_name: AD2,
  nivel: 'ad',
  target_id: AD2_ID,
  target_name: AD2,
};
const OV_ADSET: Override = {
  match_field: 'utm_term',
  match_value: '777777777777777777',
  platform: 'meta',
  campaign_id: null,
  campaign_name: ADSET,
  nivel: 'adset',
  target_id: ADSET_ID,
  target_name: ADSET,
};
const OV_CAMP: Override = {
  match_field: 'utm_campaign',
  match_value: 'promo_vieja',
  platform: 'meta',
  campaign_id: CAMP_ID,
  campaign_name: CAMP,
};
const rm = buildResolver(idx, [OV_AD, OV_ADSET, OV_CAMP]);

const adManual = rm.adOf({ utm_content: 'Anuncio viejo renombrado' });
check('el override de anuncio titula el anuncio', adManual.label === AD2 && adManual.matched);
check(
  'el override de anuncio también da su conjunto',
  rm.adsetOf({ utm_content: 'anuncio viejo renombrado' }).label === ADSET
);
const mAd = matchToCampaign({ utm_content: 'anuncio viejo renombrado' }, idx, [OV_AD]);
check(
  'y su campaña (deducida del índice por target_id, sin campaign_id)',
  mAd.key === KEY && mAd.method === 'override'
);
check(
  'el override de conjunto corrige un ID de conjunto desconocido',
  rm.adsetOf({ utm_term: '777777777777777777' }).label === ADSET
);
check(
  'un override de campaña (fila anterior, sin nivel) funciona como siempre',
  matchToCampaign({ utm_campaign: 'promo_vieja' }, idx, [OV_CAMP]).key === KEY
);
check(
  'un override de campaña NO titula anuncios (no se confunden los niveles)',
  !rm.adOf({ utm_campaign: 'promo_vieja' }).matched
);

// ── Índice construido desde metricas_diarias (construirIndice) ────────
// Dos campañas que comparten el nombre de un anuncio y de un conjunto (el
// creativo duplicado de Eduversio) y una de ellas renombrada a mitad de rango.
const CA = '120250000000000001';
const CB = '120250000000000002';
const CA_VIEJO = 'V5[D][2|08][BIODESCODIFICACION][CHILE][C LEADS]';
const CA_NUEVO = 'V5[D][2|09][BIODESCODIFICACION][CHILE][C LEADS]';
const CB_NOMBRE = '[V1][13|08][SISTEMAS DE GESTION][MEXICO][C LEADS]';
const AD_REPETIDO = 'IMAGEN 1 - IA 100%';
const AD_A = '120250000000000101';
const AD_B = '120250000000000201';
const SET_A = '120250000000000011';
const SET_B = '120250000000000021';
const SET_A2 = '120250000000000012';
const SET_B2 = '120250000000000022';
const KA = `meta:${CA}`;
const KB = `meta:${CB}`;

const anuncioDe = (ad_id: string, adset_id: string, adset_name: string, campaign_id: string) => ({
  ad_id,
  ad_name: AD_REPETIDO,
  adset_id,
  adset_name,
  campaign_id,
  spend: 1,
});

// Desordenadas a propósito: `construirIndice` las recorre por fecha.
const filas = [
  {
    fecha: '2026-09-05',
    meta_campaigns: [
      { campaign_id: CA, name: CA_NUEVO, spend: 10 },
      { campaign_id: CB, name: CB_NOMBRE, spend: 5 },
    ],
    meta_ads: [anuncioDe(AD_A, SET_A, 'ADV CHILE', CA), anuncioDe(AD_B, SET_B, 'ADV MEXICO', CB)],
    meta_adsets: [
      { adset_id: SET_A, adset_name: 'ADV CHILE', campaign_id: CA, spend: 1 },
      { adset_id: SET_B, adset_name: 'ADV MEXICO', campaign_id: CB, spend: 1 },
      { adset_id: SET_A2, adset_name: 'ABIERTO', campaign_id: CA, spend: 1 },
      { adset_id: SET_B2, adset_name: 'ABIERTO', campaign_id: CB, spend: 1 },
    ],
  },
  {
    fecha: '2026-09-01',
    meta_campaigns: [{ campaign_id: CA, name: CA_VIEJO, spend: 3 }],
    meta_ads: [],
    meta_adsets: [],
  },
];
const idx2 = construirIndice(filas, '2026-09-01');
const r2 = buildResolver(idx2, []);

// ── 6. IDs dedicados del lead (migración 082) ─────────────────────────
console.log('\n6. IDs dedicados del lead');
const mAdId = matchToCampaign({ ad_id: AD_B, utm_content: AD_REPETIDO }, idx2, []);
check(
  'ad_id cruza exacto aunque el nombre sea ambiguo',
  mAdId.key === KB && mAdId.method === 'ad_id'
);
check(
  'adset_id cruza a su campaña',
  matchToCampaign({ adset_id: SET_A2 }, idx2, []).key === KA &&
    matchToCampaign({ adset_id: SET_A2 }, idx2, []).method === 'adset_id'
);
check(
  'campaign_id cruza a su campaña',
  matchToCampaign({ campaign_id: CB }, idx2, []).method === 'campaign_id'
);
check(
  'el ID de anuncio manda sobre un utm_campaign de otra campaña',
  matchToCampaign({ ad_id: AD_A, utm_campaign: CB_NOMBRE }, idx2, []).key === KA
);
check(
  'un ID dedicado que el índice no conoce cae a la cascada de siempre',
  matchToCampaign({ campaign_id: '999999999999999', utm_campaign: CB_NOMBRE }, idx2, []).method ===
    'name'
);
check(
  'una macro sin rellenar en ad_id no cuenta como ID',
  matchToCampaign({ ad_id: '{{ad.id}}', utm_campaign: CB_NOMBRE }, idx2, []).method === 'name'
);
check(
  'el anuncio se titula por su ID dedicado',
  r2.adOf({ ad_id: AD_B }).label === AD_REPETIDO && r2.adOf({ ad_id: AD_B }).matched
);
check(
  'el conjunto se titula por el ID del anuncio',
  r2.adsetOf({ ad_id: AD_B }).label === 'ADV MEXICO'
);
check(
  'el conjunto se titula por su propio ID',
  r2.adsetOf({ adset_id: SET_A }).label === 'ADV CHILE'
);
const mUtmSet = matchToCampaign({ utm_id: SET_B }, idx2, []);
check(
  'utm_id con el ID de un CONJUNTO cruza a su campaña (utm_id_adset)',
  mUtmSet.key === KB && mUtmSet.method === 'utm_id_adset'
);

// ── 7. Nombres repetidos entre campañas ───────────────────────────────
console.log('\n7. Nombres ambiguos');
const amb = matchToCampaign({ utm_content: AD_REPETIDO }, idx2, []);
check(
  'un nombre de anuncio en dos campañas NO se asigna a una cualquiera',
  amb.key === null && amb.method === 'ambiguous'
);
check(
  'y dice entre qué campañas duda y por qué campo',
  (amb.candidates ?? []).length === 2 && amb.campo === 'utm_content'
);
check('el lead ambiguo sale como no cruzado', !r2.campaignOf({ utm_content: AD_REPETIDO }).matched);
const desamb = matchToCampaign({ utm_content: AD_REPETIDO, utm_term: 'ADV MEXICO' }, idx2, []);
check('el conjunto desambigua el anuncio', desamb.key === KB && desamb.method === 'content_ad');
const ambSet = matchToCampaign({ utm_term: 'ABIERTO' }, idx2, []);
check(
  'un nombre de conjunto repetido también queda ambiguo',
  ambSet.method === 'ambiguous' && ambSet.campo === 'utm_term'
);
check(
  'un conjunto repetido con un anuncio repetido sigue ambiguo si no se estrechan',
  matchToCampaign({ utm_content: AD_REPETIDO, utm_term: 'ABIERTO' }, idx2, []).method ===
    'ambiguous'
);
check(
  'un nombre de campaña exacto sigue ganando al anuncio repetido',
  matchToCampaign({ utm_campaign: CB_NOMBRE, utm_content: AD_REPETIDO }, idx2, []).key === KB
);

// ── 8. Campañas renombradas ───────────────────────────────────────────
console.log('\n8. Renombrados');
check(
  'el nombre VIEJO sigue cruzando',
  matchToCampaign({ utm_campaign: CA_VIEJO }, idx2, []).key === KA
);
check(
  'el nombre NUEVO cruza igual',
  matchToCampaign({ utm_campaign: CA_NUEVO }, idx2, []).key === KA
);
check(
  'la fila se titula con el nombre más reciente',
  r2.campaignOf({ utm_campaign: CA_VIEJO }).label === CA_NUEVO
);
check(
  'el gasto de los dos nombres es de la misma campaña',
  idx2.campaigns.get(KA)?.spend === 13,
  `spend=${idx2.campaigns.get(KA)?.spend}`
);

// ── 9. UTMs URL-encoded ───────────────────────────────────────────────
console.log('\n9. URL-encoded');
check(
  'el percent-encoding se deshace al normalizar',
  normLabel('%5BV1%5D%5B13%7C08%5D%5BSISTEMAS+DE+GESTION%5D') ===
    normLabel('[V1][13|08][SISTEMAS DE GESTION]')
);
check(
  'un utm_campaign URL-encoded cruza con su campaña',
  matchToCampaign({ utm_campaign: encodeURIComponent(CB_NOMBRE) }, idx2, []).key === KB
);
check('un «%» suelto no se toca', normLabel('20% dto') === '20% dto');
check('un «+» sin encoding no se toca', normLabel('C+LEADS') === 'c+leads');
check('una secuencia rota no rompe', normLabel('%E0%A4%A') === '%e0%a4%a');

// ── 10. Ingesta: los IDs llegan al lead ───────────────────────────────
console.log('\n10. Ingesta de IDs');
const ids = idsPublicitarios('{{campaign.id}}', ` ${SET_A} `, null);
check(
  'solo se guardan IDs de verdad, limpios',
  ids.campaign_id === null && ids.adset_id === SET_A && ids.ad_id === null
);
const filaSinCols: Record<string, unknown> = adaptarIds(
  { a: 1, campaign_id: CA, adset_id: null, ad_id: AD_A },
  false
);
check(
  'sin la 082 las columnas de ID no se escriben',
  !('ad_id' in filaSinCols) && !('campaign_id' in filaSinCols) && filaSinCols.a === 1
);
check('con la 082 se escriben tal cual', adaptarIds({ a: 1, ad_id: AD_A }, true).ad_id === AD_A);
const sheet = utmDeFilaSheet({ ad_id: `ad:${AD_A}`, adset_id: SET_A, campaign_id: `c:${CA}` });
check(
  'el Sheet entrega los tres IDs por separado y limpios',
  sheet.ad_id === AD_A && sheet.adset_id === SET_A && sheet.campaign_id === CA
);
check('y el más específico sigue en utm_id', sheet.utm_id === AD_A);
const contacto = {
  id: 'c1',
  attributionSource: { adId: AD_A, adGroupId: SET_A, campaignId: CA, adName: AD_REPETIDO },
} as unknown as GhlContact;
const idsGhl = idsDeContacto(contacto);
check(
  'GHL: los IDs de la atribución salen del contacto',
  idsGhl.ad_id === AD_A && idsGhl.adset_id === SET_A && idsGhl.campaign_id === CA
);
const filaGhl = buildLeadRowGhl('cliente', contacto, new Map());
check(
  'GHL: y entran en la fila del lead',
  filaGhl.ad_id === AD_A && filaGhl.adset_id === SET_A && filaGhl.campaign_id === CA
);

console.log(
  fallos === 0
    ? '\n✅ Cruce por ID: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
