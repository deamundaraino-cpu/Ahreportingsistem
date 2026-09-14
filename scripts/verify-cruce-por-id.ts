/**
 * Comprobaciones del cruce por ID en los tres niveles (campaign-resolver.ts).
 *
 * Reproduce lo que se vio el 2026-09-08 en Cris Tributario: GoHighLevel manda a
 * veces el NOMBRE de campaña, conjunto y anuncio en los UTM, y a veces su ID.
 * Con el ID, el conjunto y el anuncio salían en el informe como `120212…` y no
 * había forma de corregirlos.
 *
 * Todo es puro: el índice se construye a mano, sin Postgres.
 *
 *   npx tsx --conditions=react-server scripts/verify-cruce-por-id.ts
 */

import {
  buildResolver,
  esIdMeta,
  matchToCampaign,
  type CampaignIndex,
  type Override,
} from '../src/lib/report-utm/campaign-resolver';
import { normLabel } from '../src/lib/report-utm/bi-metadata';

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
      [normLabel(AD), KEY],
      [normLabel(AD2), KEY],
    ]),
    byAdsetName: new Map([[normLabel(ADSET), KEY]]),
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

console.log(
  fallos === 0
    ? '\n✅ Cruce por ID: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
