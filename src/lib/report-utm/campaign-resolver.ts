// ── Resolver de campañas: el puente entre los UTM y el gasto real ─────
//
// `public.metricas_diarias` está preagregada por día×cliente y NO tiene UTM. El
// único puente hacia `report_utm.lead_events` / `sales_events` es el NOMBRE de la
// entidad (campaña, anuncio, conjunto), que llega a los UTM de mil formas:
// `promo_verano`, `Promo Verano`, el `campaign_id` en `utm_id`, el nombre del
// anuncio en `utm_content`…
//
// Este módulo centraliza ese cruce para que TODOS lo hagan igual:
//   • el motor del BI al agrupar leads/ventas por campaña/anuncio/conjunto
//   • el diagnóstico de /cruce-campanas
//
// Antes vivía dentro de `campaign-data.ts` junto a un motor de consulta paralelo
// (`runCampaignQuery`) que solo sabía emitir ~20 de las 72 métricas e ignoraba
// los campos calculados. Al extraerlo, el motor principal puede usar el mismo
// cruce sin heredar aquellas limitaciones.

import { createAdminClient } from '@/utils/supabase/server';
import { AD_JSONB_METRICS, normLabel } from './bi-metadata';
import { esIdPublicitario, idPublicitario } from './lead-ids';
import { campanaEnAlcance, cargarAlcanceCampanas, type AlcanceCampanas } from './alcance-campanas';

// ============================================================
// Cruce leads/ventas ↔ campañas (gasto).
// Estrategia en cascada porque los UTMs son inconsistentes.
// Prioridad (todos los matches de aquí son EXACTOS = automáticos):
//   1. overrides manuales (report_utm.utm_campaign_map) → el trafficker manda
//   1b. IDs dedicados del lead (migración 082, Sheets): ad_id → adset_id → campaign_id
//   2. utm_id === campaign_id (Meta dinámico)
//   3. utm_id === ad_id / adset_id (sube a su campaña)
//   3b-3d. el ID llegó en el campo del nombre (utm_campaign / utm_content / utm_term)
//   4. utm_campaign normalizado === nombre de campaña (cualquiera que haya tenido)
//   5. utm_content normalizado === nombre de ad (o de campaña)
//   6. utm_term normalizado === nombre de adset
//   7. sin match → sin campaña
// Los pasos 5 y 6 solo cruzan si el nombre lleva a UNA campaña, sola o cruzando
// anuncio con conjunto. Un nombre repetido en varias campañas se queda sin
// cruzar (`ambiguous`) en vez de caer en una cualquiera: la auditoría del
// 2026-09-14 vio 651 leads de Eduversio atribuidos así, al azar.
// Lo que no cruza exacto se ofrece como SUGERENCIA por similitud
// (ver campaign-data.ts) para que el trafficker confirme — nunca se aplica solo.
// ============================================================

export type MatchMethod =
  | 'override'
  | 'ad_id'
  | 'adset_id'
  | 'campaign_id'
  | 'utm_id_campaign'
  | 'utm_id_ad'
  | 'utm_id_adset'
  | 'campaign_id_field'
  | 'content_ad_id'
  | 'term_adset_id'
  | 'name'
  | 'content_ad'
  | 'term_adset'
  | 'ambiguous'
  | 'none';

/** Resultado del cruce de un registro. */
export interface MatchResult {
  key: string | null;
  method: MatchMethod;
  /** Solo con `ambiguous`: claves de las campañas entre las que no se pudo elegir. */
  candidates?: string[];
  /** Solo con `ambiguous`: el campo cuyo nombre se repite. */
  campo?: 'utm_campaign' | 'utm_content' | 'utm_term';
}

/** Plataforma de la que el índice tiene gasto. */
export type PlataformaGasto = 'meta' | 'tiktok';

/**
 * Plataforma a la que apunta `utm_source`, o `null` si no se sabe.
 *
 * El cruce por NOMBRE miraba todas las plataformas a la vez: un lead de TikTok
 * cuyo nombre de campaña coincidía con uno de Meta (Sur Profundo usa las dos)
 * caía en la campaña que se hubiera indexado la última, y un lead de Google caía
 * en el gasto de Meta. Con la plataforma, el nombre solo se busca en la suya.
 *
 * Los valores son los que llegan de verdad (auditoría del 2026-09-28): Meta manda
 * la ubicación (`facebook_mobile_feed`, `instagram_reels`, `ig`, `fb`, `th`…) y
 * TikTok `tiktok` o su red `pangle`. `'otra'` es una plataforma conocida SIN gasto
 * en el reporting (Google, email…): sus leads no pueden cruzar por nombre. Un
 * valor desconocido o una macro sin rellenar devuelven `null` y se busca en todas,
 * que es lo de siempre.
 */
export function plataformaDeFuente(source: unknown): PlataformaGasto | 'otra' | null {
  if (typeof source !== 'string') return null;
  const s = normLabel(source);
  if (!s || s.includes('{') || s.startsWith('%7b')) return null;
  if (/^(tiktok|tt|pangle)\b/.test(s)) return 'tiktok';
  if (
    /^(facebook|fb|instagram|ig|meta|threads|th|messenger|msg|an|audience network|whatsapp)\b/.test(
      s
    )
  )
    return 'meta';
  if (
    /^(google|gads|adwords|youtube|yt|bing|microsoft|linkedin|email|e mail|newsletter|mailchimp|twitter|x com)\b/.test(
      s
    )
  )
    return 'otra';
  return null;
}

/** Nivel de una entidad publicitaria. Es también el `nivel` de un override. */
export type NivelEntidad = 'campaign' | 'adset' | 'ad';

/**
 * ¿El valor es un ID numérico de Meta y no un nombre?
 *
 * GoHighLevel manda a veces el NOMBRE de la entidad en los UTM y a veces su ID
 * (`{{ad.id}}`, `{{adset.id}}`): la reunión del 2026-09-08 lo vio en Cris
 * Tributario, donde conjunto y anuncio salían como `120212…` en el informe.
 *
 * Solo dígitos y al menos 10: los IDs de Meta tienen 15-18. El umbral evita que
 * un anuncio llamado `2026` o `11` se trate como ID y deje de cruzar por nombre.
 * La regla vive en `lead-ids.ts`, que la comparte con la ingesta.
 */
export function esIdMeta(v: unknown): boolean {
  return esIdPublicitario(v);
}

// Margen extra (días) para el índice de campañas respecto al rango de leads:
// registra campañas cuyo gasto cayó justo fuera del rango exacto, sin sumar su
// gasto al periodo (el gasto solo se acumula dentro de [dateFrom, dateTo]).
const INDEX_MARGIN_DAYS = 30;

// Hasta dónde se busca la IDENTIDAD (no el gasto) de las entidades: lo que una
// venta de Hotmart puede heredar de un lead (`LOOKBACK_DIAS` de atribucion.ts).
const INDEX_IDENTIDAD_DIAS = 180;

function shiftDate(isoDate: string, deltaDays: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function zeroAdMetrics(): Record<string, number> {
  const e: Record<string, number> = {};
  for (const k of AD_JSONB_METRICS) e[k] = 0;
  return e;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? Number(n) : 0;
}

export interface CampaignAgg {
  key: string;
  campaign_id: string | null;
  name: string;
  platform: 'meta' | 'tiktok';
  spend: number;
  impressions: number;
  clicks: number;
  platform_leads: number; // leads reportados por la plataforma (referencia)
  extra: Record<string, number>; // métricas de campaña aditivas (alcance, video, compras…)
}

export interface CampaignIndex {
  campaigns: Map<string, CampaignAgg>; // key → agg
  byCampaignId: Map<string, string>; // campaign_id → key
  byAdId: Map<string, string>; // ad_id → key (de la campaña)
  // Nombre de campaña normalizado (actual o anterior) → TODAS las campañas que lo
  // usaron. Un Set por lo mismo que los anuncios: dos campañas con el mismo nombre
  // (una duplicada sin renombrar) no dicen cuál; antes ganaba la última escrita.
  byName: Map<string, Set<string>>;
  // Nombre de anuncio/conjunto → TODAS las campañas donde existe. Un Set y no una
  // clave: el mismo creativo se duplica entre campañas (en Eduversio 83 de 91
  // nombres de anuncio), y quedarse con la última escrita atribuía al azar.
  byAdName: Map<string, Set<string>>; // nombre de ad normalizado → keys (campañas)
  byAdsetName: Map<string, Set<string>>; // nombre de adset normalizado → keys (campañas)
  // ── Canónicos: normalizado → nombre REAL tal como lo escribió el anunciante ──
  // Son los que permiten que la fila del informe se titule "Promo Verano" (el
  // nombre del anuncio) y no "promo_verano" (lo que venía en el UTM), y que esa
  // clave coincida exactamente con la que emite el desglose del gasto.
  adCanonicalByName: Map<string, string>; // normLabel(ad_name) → ad_name
  adByAdId: Map<string, string>; // ad_id → ad_name
  adsetCanonicalByName: Map<string, string>; // normLabel(adset_name) → adset_name
  adsetByAdId: Map<string, string>; // ad_id → adset_name
  // ── Con actividad DENTRO del rango exacto ──
  // El índice se construye con un margen de ±30 días para poder resolver un UTM
  // que apunta a algo que gastó justo antes. Pero esas entidades no producen
  // ninguna fila en el informe: ofrecerlas en un desplegable daba opciones
  // fantasma que dejaban el widget vacío. Estos conjuntos son los que sí.
  adsActivos: Set<string>; // ad_name con gasto en el rango
  adsetsActivos: Set<string>; // adset_name con gasto en el rango
  // ── Por ID de conjunto ──
  // GHL manda a veces el ID del conjunto en `utm_term`. Sin estos dos mapas ese
  // lead no cruzaba ni se podía titular: el informe mostraba `120212…`.
  adsetByAdsetId: Map<string, string>; // adset_id → adset_name
  byAdsetId: Map<string, string>; // adset_id → key (de la campaña)
  // ── Catálogo para corregir a mano por nivel (/cruce-campanas) ──
  adCatalog: Map<string, EntidadCatalogo>; // ad_id → anuncio
  adsetCatalog: Map<string, EntidadCatalogo>; // adset_id → conjunto
}

/** Un anuncio o conjunto real, tal como se ofrece para mapear a mano. */
export interface EntidadCatalogo {
  id: string;
  name: string;
  /** Clave de la campaña a la que pertenece, si el índice la conoce. */
  campaignKey: string | null;
  /** Conjunto padre (solo anuncios). */
  adsetId: string | null;
  adsetName: string | null;
  /** Gastó dentro del rango exacto (no solo en el margen de indexación). */
  activo: boolean;
}

export interface Override {
  match_field: string;
  match_value: string;
  campaign_id: string | null;
  campaign_name: string | null;
  platform: string;
  /**
   * Nivel de la corrección (migración 079). Ausente o `campaign` en las filas
   * anteriores y mientras la migración no esté aplicada: se comportan igual que
   * siempre.
   */
  nivel?: NivelEntidad | null;
  /** Entidad real de nivel conjunto o anuncio a la que apunta el valor. */
  target_id?: string | null;
  target_name?: string | null;
}

function emptyIndex(): CampaignIndex {
  return {
    campaigns: new Map(),
    byCampaignId: new Map(),
    byAdId: new Map(),
    byName: new Map(),
    byAdName: new Map(),
    byAdsetName: new Map(),
    adCanonicalByName: new Map(),
    adByAdId: new Map(),
    adsetCanonicalByName: new Map(),
    adsetByAdId: new Map(),
    adsActivos: new Set(),
    adsetsActivos: new Set(),
    adsetByAdsetId: new Map(),
    byAdsetId: new Map(),
    adCatalog: new Map(),
    adsetCatalog: new Map(),
  };
}

/**
 * Carga y agrega las campañas (Meta + TikTok) de metricas_diarias para
 * el cliente público en el rango, e indexa por id, ad_id y nombre.
 */
export async function loadCampaignIndex(
  publicClienteId: string,
  dateFrom: string,
  dateTo: string,
  opciones: { margenDias?: number } = {}
): Promise<CampaignIndex | null> {
  const supabase = await createAdminClient();
  const alcance = await cargarAlcanceCampanas(publicClienteId);
  // Ventana ampliada para registrar claves de campañas/ads/adsets que pudieron
  // gastar justo fuera del rango. El gasto solo se acumula dentro del rango exacto.
  const keyFrom = shiftDate(dateFrom, -(opciones.margenDias ?? INDEX_MARGIN_DAYS));

  // ── Lectura por tramos de fechas ───────────────────────────────────
  // Cada fila lleva el desglose por anuncio del día entero: para un cliente con
  // cientos de anuncios activos son cientos de KB por fila. Pedir 120 días de
  // golpe producía respuestas de varios MB que PostgREST devolvía TRUNCADAS de
  // forma intermitente —sin error—, y un índice a medias mapea unos leads sí y
  // otros no, en silencio: el mismo informe daba 1.315 leads en una carga y 57
  // en la siguiente. Troceando, cada respuesta es pequeña y el resultado es
  // determinista.
  const CHUNK_DAYS = 10;
  const tramos: { from: string; to: string }[] = [];
  for (let cursor = keyFrom; cursor <= dateTo; cursor = shiftDate(cursor, CHUNK_DAYS)) {
    const fin = shiftDate(cursor, CHUNK_DAYS - 1);
    tramos.push({ from: cursor, to: fin > dateTo ? dateTo : fin });
  }

  const respuestas = await Promise.all(
    tramos.map((t) =>
      supabase
        .from('metricas_diarias')
        .select(
          'fecha,meta_campaigns,meta_ads,meta_adsets,tiktok_campaigns,tiktok_ads,tiktok_adgroups'
        )
        .eq('cliente_id', publicClienteId)
        .gte('fecha', t.from)
        .lte('fecha', t.to)
        // Cronológico: la última escritura de cada nombre es la más reciente,
        // que es con la que se titula una entidad renombrada.
        .order('fecha', { ascending: true })
    )
  );

  // Un tramo fallido daría un índice PARCIAL, que es peor que no tener índice:
  // parte de los leads cruzaría y parte no, sin forma de notarlo. Se aborta para
  // degradar de forma consistente (el motor cae a los UTM crudos).
  if (respuestas.some((r) => r.error)) return null;
  const idx = construirIndice(
    respuestas.flatMap((r) => r.data ?? []) as Record<string, unknown>[],
    dateFrom,
    { alcance }
  );

  // Identidad de lo que gastó ANTES de la ventana (hasta 180 días): una venta de
  // Hotmart hereda leads de hasta 180 días, y su ID no estaba en el índice. Solo
  // identidad, sin gasto, y leída de `ads_entidades_ids` (migración 094), que la
  // agrupa en la base: el JSONB de esos meses serían decenas de MB. Sin la
  // migración, o si falla, el índice se queda como siempre.
  const { data: previas, error: ePrevias } = await supabase.rpc('ads_entidades_ids', {
    p_cliente_id: publicClienteId,
    p_desde: shiftDate(dateFrom, -INDEX_IDENTIDAD_DIAS),
    p_hasta: shiftDate(keyFrom, -1),
  });
  if (!ePrevias && Array.isArray(previas)) {
    ampliarConEntidades(idx, previas as EntidadPrevia[], alcance);
  }
  return idx;
}

/** Fila de `ads_entidades_ids` (migración 094). */
export interface EntidadPrevia {
  plataforma: string;
  nivel: string;
  entidad_id: string;
  entidad_nombre: string | null;
  campana_id: string | null;
  campana_nombre: string | null;
  adset_id: string | null;
  adset_nombre: string | null;
}

/**
 * (Puro) Añade al índice la identidad de entidades que gastaron antes de su
 * ventana. Nunca pisa lo que ya estaba (lo de dentro de la ventana es más
 * reciente) ni suma gasto: sirve para atar un ID a su campaña y titularlo.
 */
export function ampliarConEntidades(
  idx: CampaignIndex,
  filas: EntidadPrevia[],
  alcance: AlcanceCampanas | null = null
): void {
  // Primero las campañas: los conjuntos y anuncios se cuelgan de ellas.
  const orden = { campaign: 0, adset: 1, ad: 2 } as Record<string, number>;
  const ordenadas = [...filas].sort((a, b) => (orden[a.nivel] ?? 9) - (orden[b.nivel] ?? 9));
  for (const f of ordenadas) {
    const plat = f.plataforma === 'tiktok' ? 'tiktok' : 'meta';
    const campId = f.nivel === 'campaign' ? f.entidad_id : f.campana_id;
    const campNombre = f.nivel === 'campaign' ? f.entidad_nombre : f.campana_nombre;
    if (!campId) continue;
    if (alcance && campNombre && !campanaEnAlcance(campNombre, alcance)) continue;
    let campKey = idx.byCampaignId.get(campId);
    if (!campKey) {
      campKey = `${plat}:${campId}`;
      idx.campaigns.set(campKey, {
        key: campKey,
        campaign_id: campId,
        name: campNombre || '(sin nombre)',
        platform: plat,
        spend: 0,
        impressions: 0,
        clicks: 0,
        platform_leads: 0,
        extra: zeroAdMetrics(),
      });
      // Solo por ID, NO por nombre: una campaña vieja que se llamara como una
      // actual volvería «ambiguos» leads que hoy cruzan bien por nombre.
      idx.byCampaignId.set(campId, campKey);
    }
    if (f.nivel === 'adset') {
      if (!idx.byAdsetId.has(f.entidad_id)) idx.byAdsetId.set(f.entidad_id, campKey);
      if (f.entidad_nombre && !idx.adsetByAdsetId.has(f.entidad_id)) {
        idx.adsetByAdsetId.set(f.entidad_id, f.entidad_nombre);
      }
    }
    if (f.nivel === 'ad') {
      if (!idx.byAdId.has(f.entidad_id)) idx.byAdId.set(f.entidad_id, campKey);
      if (f.entidad_nombre && !idx.adByAdId.has(f.entidad_id)) {
        idx.adByAdId.set(f.entidad_id, f.entidad_nombre);
      }
      if (f.adset_nombre && !idx.adsetByAdId.has(f.entidad_id)) {
        idx.adsetByAdId.set(f.entidad_id, f.adset_nombre);
      }
      if (f.adset_id && !idx.byAdsetId.has(f.adset_id)) idx.byAdsetId.set(f.adset_id, campKey);
    }
  }
}

/**
 * (Puro) Índice a partir de filas de `metricas_diarias`.
 *
 * Separado de la lectura para poder comprobarlo sin Postgres: los renombrados y
 * los nombres repetidos entre campañas dependen de CÓMO se recorren las filas, y
 * eso es justo lo que hay que fijar con casos (scripts/verify-cruce-por-id.ts).
 * Las filas se recorren por fecha: la última escritura de cada nombre es la
 * vigente.
 */
export function construirIndice(
  filas: Record<string, unknown>[],
  dateFrom: string,
  opciones: { alcance?: AlcanceCampanas | null } = {}
): CampaignIndex {
  const idx = emptyIndex();
  const data = [...filas].sort((a, b) =>
    String(a.fecha ?? '').localeCompare(String(b.fecha ?? ''))
  );
  // Alcance del cliente (cuenta compartida, ver alcance-campanas.ts): las
  // campañas de fuera no entran en el índice, ni sus anuncios ni sus conjuntos.
  // Se recuerda su ID para descartar también los anuncios que solo traen el ID.
  const alcance = opciones.alcance ?? null;
  const fueraDeAlcance = new Set<string>();
  const enAlcance = (campId: unknown, nombre: unknown): boolean => {
    if (!alcance) return true;
    if (campId != null && fueraDeAlcance.has(String(campId))) return false;
    if (typeof nombre === 'string' && nombre.trim()) {
      const dentro = campanaEnAlcance(nombre, alcance);
      if (!dentro && campId != null) fueraDeAlcance.add(String(campId));
      return dentro;
    }
    return true;
  };

  function upsert(
    platform: 'meta' | 'tiktok',
    campId: string | null,
    name: string,
    addSpend: boolean,
    m: { spend: number; impressions: number; clicks: number; leads: number }
  ) {
    const key = `${platform}:${campId ?? normLabel(name)}`;
    let agg = idx.campaigns.get(key);
    if (!agg) {
      agg = {
        key,
        campaign_id: campId,
        name: name || '(sin nombre)',
        platform,
        spend: 0,
        impressions: 0,
        clicks: 0,
        platform_leads: 0,
        extra: zeroAdMetrics(),
      };
      idx.campaigns.set(key, agg);
      if (campId) idx.byCampaignId.set(campId, key);
    }
    if (name) {
      // Una campaña renombrada sigue cruzando por CADA nombre que tuvo: un lead
      // guarda el nombre del día en que entró. Antes solo se indexaba el primero
      // y los leads con el nombre nuevo se quedaban sin cruzar (Eduversio,
      // `V5[D][2|08]…` → `V5[D][2|09]…`). La fila se titula con el último,
      // porque las filas llegan en orden de fecha.
      agregarCandidato(idx.byName, normLabel(name), key);
      agg.name = name;
    }
    if (addSpend) {
      agg.spend += m.spend;
      agg.impressions += m.impressions;
      agg.clicks += m.clicks;
      agg.platform_leads += m.leads;
    }
    return key;
  }

  for (const row of data as Record<string, unknown>[]) {
    const inRange = typeof row.fecha === 'string' ? row.fecha >= dateFrom : true;
    const metaCamps = (row.meta_campaigns as Record<string, unknown>[] | null) ?? [];
    for (const c of metaCamps) {
      if (!enAlcance(c.campaign_id, c.name)) continue;
      const key = upsert(
        'meta',
        (c.campaign_id as string) ?? null,
        (c.name as string) ?? '',
        inRange,
        {
          spend: num(c.spend),
          impressions: num(c.impressions),
          clicks: num(c.clicks),
          leads: num(c.leads),
        }
      );
      if (inRange) {
        const agg = idx.campaigns.get(key)!;
        for (const k of AD_JSONB_METRICS) agg.extra[k] += num(c[k]);
      }
    }
    // Indexa ad_id y nombre de ad/adset → campaña (para cruzar utm_id=ad_id,
    // utm_content=ad_name, utm_term=adset_name).
    const metaAds = (row.meta_ads as Record<string, unknown>[] | null) ?? [];
    for (const a of metaAds) {
      if (!enAlcance(a.campaign_id, a.campaign_name)) continue;
      const adId = a.ad_id as string | null;
      const adName = a.ad_name as string | null;
      const adsetName = a.adset_name as string | null;
      // Los canónicos NO dependen de que la campaña esté indexada: sirven para
      // titular la fila aunque el ad venga de una campaña fuera del rango.
      const activo = inRange && num(a.spend) > 0;
      const adsetId = a.adset_id ? String(a.adset_id) : null;
      if (adName) {
        idx.adCanonicalByName.set(normLabel(adName), adName);
        if (adId) idx.adByAdId.set(adId, adName);
        if (activo) idx.adsActivos.add(adName);
      }
      if (adsetName) {
        idx.adsetCanonicalByName.set(normLabel(adsetName), adsetName);
        if (adId) idx.adsetByAdId.set(adId, adsetName);
        if (adsetId) idx.adsetByAdsetId.set(adsetId, adsetName);
      }
      const campId = a.campaign_id as string | null;
      const campKey = campId ? idx.byCampaignId.get(campId) : undefined;
      if (adId && adName) {
        const previo = idx.adCatalog.get(adId);
        idx.adCatalog.set(adId, {
          id: adId,
          name: adName,
          campaignKey: campKey ?? previo?.campaignKey ?? null,
          adsetId: adsetId ?? previo?.adsetId ?? null,
          adsetName: adsetName ?? previo?.adsetName ?? null,
          activo: activo || previo?.activo === true,
        });
      }
      if (!campKey) continue;
      if (adId) idx.byAdId.set(adId, campKey);
      if (adName) agregarCandidato(idx.byAdName, normLabel(adName), campKey);
      if (adsetName) agregarCandidato(idx.byAdsetName, normLabel(adsetName), campKey);
      if (adsetId) idx.byAdsetId.set(adsetId, campKey);
    }
    const metaAdsets = (row.meta_adsets as Record<string, unknown>[] | null) ?? [];
    for (const a of metaAdsets) {
      if (!enAlcance(a.campaign_id, a.campaign_name)) continue;
      const adsetName = a.adset_name as string | null;
      const adsetId = a.adset_id ? String(a.adset_id) : null;
      const activo = inRange && num(a.spend) > 0;
      if (adsetName) {
        idx.adsetCanonicalByName.set(normLabel(adsetName), adsetName);
        if (activo) idx.adsetsActivos.add(adsetName);
        if (adsetId) idx.adsetByAdsetId.set(adsetId, adsetName);
      }
      const campId = a.campaign_id as string | null;
      const campKey = campId ? idx.byCampaignId.get(campId) : undefined;
      if (adsetId && adsetName) {
        const previo = idx.adsetCatalog.get(adsetId);
        idx.adsetCatalog.set(adsetId, {
          id: adsetId,
          name: adsetName,
          campaignKey: campKey ?? previo?.campaignKey ?? null,
          adsetId: null,
          adsetName: null,
          activo: activo || previo?.activo === true,
        });
      }
      if (!campKey) continue;
      if (adsetName) agregarCandidato(idx.byAdsetName, normLabel(adsetName), campKey);
      if (adsetId) idx.byAdsetId.set(adsetId, campKey);
    }
    const ttCamps = (row.tiktok_campaigns as Record<string, unknown>[] | null) ?? [];
    for (const c of ttCamps) {
      if (!enAlcance(c.campaign_id, c.name)) continue;
      upsert('tiktok', (c.campaign_id as string) ?? null, (c.name as string) ?? '', inRange, {
        spend: num(c.spend),
        impressions: num(c.impressions),
        clicks: num(c.clicks),
        leads: num(c.conversions),
      });
    }
    // Anuncios y adgroups de TikTok. Desde que el worker los enriquece con sus
    // catálogos traen `campaign_id` y `adset_id`/`adgroup_id`, así que se
    // indexan igual que los de Meta: sin esto, un enlace con `ad_id=__CID__`
    // (la plantilla del doc 22) no cruzaba nunca. Los objetos antiguos, sin
    // campaña, solo aportan el nombre canónico, como antes.
    for (const a of (row.tiktok_ads as Record<string, unknown>[] | null) ?? []) {
      if (!enAlcance(a.campaign_id, a.campaign_name)) continue;
      const adName = a.ad_name as string | null;
      const adId = a.ad_id ? String(a.ad_id) : null;
      const adsetId = a.adset_id ? String(a.adset_id) : null;
      const adsetName = (a.adset_name as string | null) ?? null;
      const activo = inRange && num(a.spend) > 0;
      if (adName) {
        if (!idx.adCanonicalByName.has(normLabel(adName))) {
          idx.adCanonicalByName.set(normLabel(adName), adName);
        }
        if (adId) idx.adByAdId.set(adId, adName);
        if (activo) idx.adsActivos.add(adName);
      }
      if (adsetName) {
        if (adId) idx.adsetByAdId.set(adId, adsetName);
        if (adsetId) idx.adsetByAdsetId.set(adsetId, adsetName);
      }
      const campId = a.campaign_id != null ? String(a.campaign_id) : null;
      const campKey = campId ? idx.byCampaignId.get(campId) : undefined;
      if (adId && adName) {
        const previo = idx.adCatalog.get(adId);
        idx.adCatalog.set(adId, {
          id: adId,
          name: adName,
          campaignKey: campKey ?? previo?.campaignKey ?? null,
          adsetId: adsetId ?? previo?.adsetId ?? null,
          adsetName: adsetName ?? previo?.adsetName ?? null,
          activo: activo || previo?.activo === true,
        });
      }
      if (!campKey) continue;
      if (adId) idx.byAdId.set(adId, campKey);
      if (adName) agregarCandidato(idx.byAdName, normLabel(adName), campKey);
      if (adsetName) agregarCandidato(idx.byAdsetName, normLabel(adsetName), campKey);
      if (adsetId) idx.byAdsetId.set(adsetId, campKey);
    }
    for (const a of (row.tiktok_adgroups as Record<string, unknown>[] | null) ?? []) {
      if (!enAlcance(a.campaign_id, a.campaign_name)) continue;
      const gName = a.adgroup_name as string | null;
      const gId = a.adgroup_id ? String(a.adgroup_id) : null;
      const activo = inRange && num(a.spend) > 0;
      if (gName) {
        if (!idx.adsetCanonicalByName.has(normLabel(gName))) {
          idx.adsetCanonicalByName.set(normLabel(gName), gName);
        }
        if (activo) idx.adsetsActivos.add(gName);
        if (gId) idx.adsetByAdsetId.set(gId, gName);
      }
      const campId = a.campaign_id != null ? String(a.campaign_id) : null;
      const campKey = campId ? idx.byCampaignId.get(campId) : undefined;
      if (gId && gName) {
        const previo = idx.adsetCatalog.get(gId);
        idx.adsetCatalog.set(gId, {
          id: gId,
          name: gName,
          campaignKey: campKey ?? previo?.campaignKey ?? null,
          adsetId: null,
          adsetName: null,
          activo: activo || previo?.activo === true,
        });
      }
      if (!campKey) continue;
      if (gName) agregarCandidato(idx.byAdsetName, normLabel(gName), campKey);
      if (gId) idx.byAdsetId.set(gId, campKey);
    }
  }

  return idx;
}

/** Añade una campaña candidata a un nombre de anuncio o conjunto. */
function agregarCandidato(m: Map<string, Set<string>>, nombre: string, campKey: string): void {
  let s = m.get(nombre);
  if (!s) {
    s = new Set();
    m.set(nombre, s);
  }
  s.add(campKey);
}

/**
 * La única campaña de `candidatos`, directa o cruzándola con `otros`.
 *
 * Un nombre de anuncio repetido en tres campañas no dice cuál; pero si el
 * conjunto del lead solo existe en una de esas tres, sí. Si ni así queda una,
 * no se elige: devolverla sería inventar la atribución.
 */
function campanaUnica(
  candidatos: Set<string>,
  otros: Set<string> | null | undefined
): string | null {
  if (candidatos.size === 1) return candidatos.values().next().value ?? null;
  if (!otros || otros.size === 0) return null;
  let unica: string | null = null;
  for (const k of candidatos) {
    if (!otros.has(k)) continue;
    if (unica !== null) return null;
    unica = k;
  }
  return unica;
}

/**
 * Candidatos de un nombre, restringidos a la plataforma del registro (si se
 * sabe) y sin duplicados «sin ID» cuando la misma campaña ya está por ID.
 *
 * Lo segundo importa porque las filas viejas de `meta_campaigns` no traían
 * `campaign_id`: la misma campaña queda indexada una vez por nombre y otra por
 * ID, y sin este filtro todo nombre de esa época saldría «ambiguo».
 */
function filtrarCandidatos(
  cands: Set<string> | null | undefined,
  plataforma: PlataformaGasto | null
): Set<string> | null {
  if (!cands || cands.size === 0) return null;
  let lista = [...cands];
  if (plataforma) lista = lista.filter((k) => k.startsWith(`${plataforma}:`));
  const conId = lista.filter((k) => /^[a-z]+:\d{10,}$/.test(k));
  if (conId.length > 0) lista = conId;
  return lista.length > 0 ? new Set(lista) : null;
}

/** Cascada de matching de un registro (lead/venta) a una campaña. */
export function matchToCampaign(
  rec: UtmRecord,
  idx: CampaignIndex,
  overrides: Override[]
): MatchResult {
  // 1. overrides manuales → máxima prioridad (el trafficker corrige el motor).
  //    Todos los niveles cuentan aquí: una corrección de anuncio o de conjunto
  //    también dice a qué campaña pertenece el lead, que es lo que ata el gasto.
  //
  //    Salvo contra un ID exacto del lead: una corrección de campaña o de
  //    conjunto se escribe por un NOMBRE, y «Confirmar todas» las creaba por
  //    similitud; no debe desviar un lead cuyo `ad_id` dice dónde está. Solo una
  //    corrección de nivel anuncio, que el trafficker hizo sobre ese anuncio,
  //    manda también sobre el ID.
  const conIdExacto = Boolean(
    (idPublicitario(rec.ad_id) && idx.byAdId.has(idPublicitario(rec.ad_id)!)) ||
    (idPublicitario(rec.adset_id) && idx.byAdsetId.has(idPublicitario(rec.adset_id)!)) ||
    (idPublicitario(rec.campaign_id) && idx.byCampaignId.has(idPublicitario(rec.campaign_id)!))
  );
  for (const ov of overrides) {
    if (conIdExacto && (ov.nivel ?? 'campaign') !== 'ad') continue;
    if (!coincideOverride(rec as Record<string, unknown>, ov)) continue;
    const key = claveCampanaDeOverride(ov, idx);
    if (key) return { key, method: 'override' };
  }
  // 1b. IDs dedicados (migración 082 en leads, columnas propias en Sheets y
  //     ventas). Del nivel más específico al más general: si el anuncio ya no
  //     está en el índice, su conjunto o su campaña todavía pueden estarlo.
  const adId = idPublicitario(rec.ad_id);
  if (adId) {
    const k = idx.byAdId.get(adId);
    if (k) return { key: k, method: 'ad_id' };
  }
  const adsetId = idPublicitario(rec.adset_id);
  if (adsetId) {
    const k = idx.byAdsetId.get(adsetId);
    if (k) return { key: k, method: 'adset_id' };
  }
  const campaignId = idPublicitario(rec.campaign_id);
  if (campaignId) {
    const k = idx.byCampaignId.get(campaignId);
    if (k) return { key: k, method: 'campaign_id' };
  }
  // 2. utm_id === campaign_id
  if (rec.utm_id && idx.byCampaignId.has(rec.utm_id)) {
    return { key: idx.byCampaignId.get(rec.utm_id)!, method: 'utm_id_campaign' };
  }
  // 3. utm_id === ad_id → su campaña
  if (rec.utm_id && idx.byAdId.has(rec.utm_id)) {
    return { key: idx.byAdId.get(rec.utm_id)!, method: 'utm_id_ad' };
  }
  // 3a. utm_id === adset_id → su campaña. Un enlace con `utm_id={{adset.id}}`
  //     no cruzaba: `adsetOf` ya lo leía, pero el paso que ata el gasto no.
  if (rec.utm_id && idx.byAdsetId.has(rec.utm_id)) {
    return { key: idx.byAdsetId.get(rec.utm_id)!, method: 'utm_id_adset' };
  }
  // 3b-3d. El ID de la entidad llegó en el campo del NOMBRE. Es lo que manda GHL
  //    cuando el enlace usa `{{campaign.id}}` / `{{ad.id}}` / `{{adset.id}}`.
  //    Van antes que los nombres porque un ID es un cruce exacto.
  if (esIdMeta(rec.utm_campaign)) {
    const k = idx.byCampaignId.get(String(rec.utm_campaign).trim());
    if (k) return { key: k, method: 'campaign_id_field' };
  }
  if (esIdMeta(rec.utm_content)) {
    const k = idx.byAdId.get(String(rec.utm_content).trim());
    if (k) return { key: k, method: 'content_ad_id' };
  }
  if (esIdMeta(rec.utm_term)) {
    const k = idx.byAdsetId.get(String(rec.utm_term).trim());
    if (k) return { key: k, method: 'term_adset_id' };
  }
  // A partir de aquí se cruza por NOMBRE, y un nombre solo vale dentro de su
  // plataforma. Una fuente conocida sin gasto en el reporting (Google, email…)
  // no cruza por nombre: caía en una campaña de Meta que se llamara igual.
  const fuente = plataformaDeFuente(rec.utm_source);
  if (fuente === 'otra') return { key: null, method: 'none' };
  const plataforma = fuente;

  // 4. utm_campaign === nombre de campaña (normalizado), si lleva a UNA.
  const porCampana = rec.utm_campaign
    ? filtrarCandidatos(idx.byName.get(normLabel(rec.utm_campaign)), plataforma)
    : null;
  if (porCampana?.size === 1) {
    return { key: porCampana.values().next().value!, method: 'name' };
  }
  // 5-6. utm_content === nombre de ad (o de campaña) / utm_term === nombre de
  //      adset → su campaña, pero solo si el nombre lleva a UNA. Cada campo
  //      desambigua al otro (ver `campanaUnica`), y también a la campaña.
  let porAnuncio: Set<string> | null = null;
  if (rec.utm_content) {
    const n = normLabel(rec.utm_content);
    porAnuncio = filtrarCandidatos(idx.byAdName.get(n), plataforma);
    if (!porAnuncio) porAnuncio = filtrarCandidatos(idx.byName.get(n), plataforma);
  }
  const porConjunto = rec.utm_term
    ? filtrarCandidatos(idx.byAdsetName.get(normLabel(rec.utm_term)), plataforma)
    : null;
  if (porCampana && porCampana.size > 1) {
    // Nombre de campaña repetido: el anuncio o el conjunto pueden decir cuál.
    const k = campanaUnica(porCampana, porAnuncio) ?? campanaUnica(porCampana, porConjunto);
    if (k) return { key: k, method: 'name' };
  }
  if (porAnuncio && porAnuncio.size > 0) {
    const k = campanaUnica(porAnuncio, porConjunto ?? porCampana);
    if (k) return { key: k, method: 'content_ad' };
  }
  if (porConjunto && porConjunto.size > 0) {
    const k = campanaUnica(porConjunto, porAnuncio ?? porCampana);
    if (k) return { key: k, method: 'term_adset' };
  }
  if (porCampana && porCampana.size > 1) {
    return {
      key: null,
      method: 'ambiguous',
      candidates: [...porCampana],
      campo: 'utm_campaign',
    };
  }
  if (porAnuncio?.size) {
    return {
      key: null,
      method: 'ambiguous',
      candidates: [...porAnuncio],
      campo: 'utm_content',
    };
  }
  if (porConjunto?.size) {
    return { key: null, method: 'ambiguous', candidates: [...porConjunto], campo: 'utm_term' };
  }
  return { key: null, method: 'none' };
}

/** ¿El valor del registro en el campo del override es el que el override corrige? */
function coincideOverride(rec: Record<string, unknown>, ov: Override): boolean {
  const val = rec[ov.match_field];
  if (val === null || val === undefined || val === '') return false;
  return normLabel(String(val)) === normLabel(ov.match_value);
}

/**
 * Campaña a la que apunta un override, sea del nivel que sea.
 *
 * Con `campaign_id` manda ese ID. Una corrección de conjunto o anuncio sin
 * campaña explícita la hereda del índice a través de su propia entidad: el
 * trafficker eligió un anuncio, y el anuncio sabe de qué campaña es.
 */
function claveCampanaDeOverride(ov: Override, idx: CampaignIndex): string | null {
  if (ov.campaign_id) return `${ov.platform}:${ov.campaign_id}`;
  const nivel = ov.nivel ?? 'campaign';
  if (ov.target_id && nivel === 'ad') {
    const k = idx.byAdId.get(ov.target_id);
    if (k) return k;
  }
  if (ov.target_id && nivel === 'adset') {
    const k = idx.byAdsetId.get(ov.target_id);
    if (k) return k;
  }
  return ov.campaign_name ? `${ov.platform}:${normLabel(ov.campaign_name)}` : null;
}

/** Primer override del NIVEL pedido que corrige este registro. */
function overrideDeNivel(
  rec: Record<string, unknown>,
  overrides: Override[],
  nivel: NivelEntidad
): Override | null {
  for (const ov of overrides) {
    if ((ov.nivel ?? 'campaign') !== nivel) continue;
    if (coincideOverride(rec, ov)) return ov;
  }
  return null;
}

export async function loadOverrides(clienteId: string): Promise<Override[]> {
  const supabase = await createAdminClient();
  // `*` y no una lista: así las columnas de nivel (migración 079) llegan si
  // existen y, si la migración aún no está aplicada, la consulta no falla por
  // pedir una columna que no hay. Sin ellas, todo override es de campaña, que es
  // exactamente como funcionaba antes.
  const { data } = await supabase
    .schema('report_utm')
    .from('utm_campaign_map')
    .select('*')
    .eq('cliente_id', clienteId)
    // La más reciente primero, y con desempate por id: gana la primera que
    // coincide, y sin orden el ganador entre dos correcciones equivalentes
    // dependía de cómo devolviera las filas Postgres.
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(5000);
  return (data as Override[] | null) ?? [];
}

/** Resuelve el public cliente_id enlazado a un cliente report_utm (o null). */
// El enlace cliente report_utm → cliente público cambia muy de vez en cuando
// (solo al vincular a mano), pero se pregunta varias veces por consulta: una en
// `queryAdsDirect`, otra en `loadResolver` y otra en el diagnóstico. Con 12
// widgets por informe eso son decenas de viajes idénticos a la base. TTL igual
// que el del resolver, por coherencia.
const PUBLIC_ID_TTL_MS = 60_000;
const publicIdCache = new Map<string, { value: string | null; ts: number }>();

export async function resolvePublicClienteId(rtmClienteId: string): Promise<string | null> {
  const now = Date.now();
  const hit = publicIdCache.get(rtmClienteId);
  if (hit && now - hit.ts <= PUBLIC_ID_TTL_MS) return hit.value;

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .schema('report_utm')
    .from('clientes')
    .select('public_cliente_id')
    .eq('id', rtmClienteId)
    .maybeSingle();
  // Un error de red NO se cachea: cachear el null convertiría un fallo puntual
  // en un minuto entero de informes en blanco.
  if (error) return null;

  const value = data?.public_cliente_id ?? null;
  if (publicIdCache.size > 500) publicIdCache.clear();
  publicIdCache.set(rtmClienteId, { value, ts: now });
  return value;
}

/**
 * El camino INVERSO: cliente del dashboard (`public.clientes.id`) → cliente
 * report_utm, o null si no está enlazado.
 *
 * Lo necesita todo lo que arranca en el dashboard y quiere leer leads: la ficha
 * de cliente ya lo hacía con esta consulta copiada inline, y el bloque de
 * respuestas la necesitaba otra vez. Con dos copias, el día que el enlace deje
 * de ser 1:1 una de las dos se queda atrás.
 *
 * `.limit(1)` y no `.maybeSingle()`: nada en el esquema impide que dos clientes
 * report_utm apunten al mismo `public_cliente_id`, y `maybeSingle()` lanzaría en
 * ese caso en vez de escoger uno.
 */
const rtmIdCache = new Map<string, { value: string | null; ts: number }>();

export async function resolveRtmClienteId(publicClienteId: string): Promise<string | null> {
  if (!publicClienteId) return null;
  const now = Date.now();
  const hit = rtmIdCache.get(publicClienteId);
  if (hit && now - hit.ts <= PUBLIC_ID_TTL_MS) return hit.value;

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicClienteId)
    .limit(1);
  // Igual que arriba: un error de red no se cachea, para no convertir un fallo
  // puntual en un minuto entero de bloques vacíos.
  if (error) return null;

  const value = data?.[0]?.id ?? null;
  if (rtmIdCache.size > 500) rtmIdCache.clear();
  rtmIdCache.set(publicClienteId, { value, ts: now });
  return value;
}

// ── API pública del resolver ──────────────────────────────────────────

/** Registro mínimo (lead o venta) que el resolver sabe cruzar. */
export interface UtmRecord {
  utm_id?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  /**
   * IDs dedicados de la entidad (ver `lead-ids.ts`). Llegan de las columnas de
   * la migración 082, de las de `sales_events` (vía alias) o del Sheet. Mandan
   * sobre los UTM porque son exactos en su propio nivel.
   */
  campaign_id?: string | null;
  adset_id?: string | null;
  ad_id?: string | null;
}

/** Etiqueta resuelta + si cruzó con una entidad real del reporting. */
export interface ResolvedLabel {
  label: string;
  matched: boolean;
}

export const SIN_CAMPANA = '(sin campaña)';
export const SIN_ANUNCIO = '(sin anuncio)';
export const SIN_CONJUNTO = '(sin conjunto)';

export interface CampaignResolver {
  /** Campaña real a la que pertenece el registro, o su utm_campaign crudo. */
  campaignOf(rec: UtmRecord): ResolvedLabel;
  /** Nombre real del anuncio (utm_content canonizado), o el valor crudo. */
  adOf(rec: UtmRecord): ResolvedLabel;
  /** Nombre real del conjunto (utm_term canonizado), o el valor crudo. */
  adsetOf(rec: UtmRecord): ResolvedLabel;
  /** Nombres de campaña conocidos, para poblar desplegables. */
  campaignLabels(): string[];
  /** Nombres de anuncio conocidos. */
  adLabels(): string[];
  /** Nombres de conjunto conocidos. */
  adsetLabels(): string[];
  /** Nombre real de una campaña a partir de cualquier variante de escritura. */
  canonicalCampaign(name: string): string | null;
  /** Índice crudo, para quien necesite el gasto agregado por campaña. */
  index: CampaignIndex;
}

export function buildResolver(idx: CampaignIndex, overrides: Override[]): CampaignResolver {
  return {
    campaignOf(rec) {
      const m = matchToCampaign(rec, idx, overrides);
      if (m.key) {
        const agg = idx.campaigns.get(m.key);
        if (agg) return { label: agg.name, matched: true };
        // Un override puede apuntar a una campaña sin gasto en el rango: se
        // respeta su nombre igualmente, que para eso lo escribió el trafficker.
        const ov = overrides.find(
          (o) =>
            o.campaign_name &&
            m.key ===
              (o.campaign_id
                ? `${o.platform}:${o.campaign_id}`
                : `${o.platform}:${normLabel(o.campaign_name)}`)
        );
        if (ov?.campaign_name) return { label: ov.campaign_name, matched: true };
      }
      // Sin cruce, cada UTM huérfano es su PROPIA fila (con gasto 0), no un
      // cubo común: fundirlos escondía justo el problema que hay que arreglar.
      const raw = (rec.utm_campaign ?? '').trim();
      return { label: raw || SIN_CAMPANA, matched: false };
    },

    adOf(rec) {
      // 1. Corrección manual de nivel anuncio: el trafficker manda.
      const ov = overrideDeNivel(rec as Record<string, unknown>, overrides, 'ad');
      if (ov?.target_name) return { label: ov.target_name, matched: true };
      // 1b. El ID dedicado del anuncio: exacto, y a salvo de renombrados.
      const adId = idPublicitario(rec.ad_id);
      if (adId) {
        const real = idx.adByAdId.get(adId);
        if (real) return { label: real, matched: true };
      }
      // 2. `utm_id` es el ID del anuncio (GHL y Meta Lead Ads lo llenan así).
      if (rec.utm_id) {
        const real = idx.adByAdId.get(rec.utm_id);
        if (real) return { label: real, matched: true };
      }
      const raw = (rec.utm_content ?? '').trim();
      if (raw) {
        // 3. El ID del anuncio llegó en `utm_content` en vez del nombre.
        if (esIdMeta(raw)) {
          const real = idx.adByAdId.get(raw);
          if (real) return { label: real, matched: true };
        }
        // 4. Nombre, en cualquiera de sus escrituras.
        const real = idx.adCanonicalByName.get(normLabel(raw));
        if (real) return { label: real, matched: true };
      }
      return { label: raw || SIN_ANUNCIO, matched: false };
    },

    adsetOf(rec) {
      const r = rec as Record<string, unknown>;
      // 1. Corrección manual de nivel conjunto.
      const ov = overrideDeNivel(r, overrides, 'adset');
      if (ov?.target_name) return { label: ov.target_name, matched: true };
      // 1b. Una corrección de ANUNCIO también dice su conjunto.
      const ovAd = overrideDeNivel(r, overrides, 'ad');
      if (ovAd?.target_id) {
        const real = idx.adsetByAdId.get(ovAd.target_id);
        if (real) return { label: real, matched: true };
      }
      // 1c. IDs dedicados: el del conjunto, o el del anuncio, que sabe su conjunto.
      const adsetId = idPublicitario(rec.adset_id);
      if (adsetId) {
        const real = idx.adsetByAdsetId.get(adsetId);
        if (real) return { label: real, matched: true };
      }
      const adId = idPublicitario(rec.ad_id);
      if (adId) {
        const real = idx.adsetByAdId.get(adId);
        if (real) return { label: real, matched: true };
      }
      // 2. `utm_id` es el ID del anuncio → su conjunto; o directamente el del conjunto.
      if (rec.utm_id) {
        const real = idx.adsetByAdId.get(rec.utm_id) ?? idx.adsetByAdsetId.get(rec.utm_id);
        if (real) return { label: real, matched: true };
      }
      const raw = (rec.utm_term ?? '').trim();
      if (raw) {
        // 3. El ID del conjunto llegó en `utm_term`.
        if (esIdMeta(raw)) {
          const real = idx.adsetByAdsetId.get(raw);
          if (real) return { label: real, matched: true };
        }
        // 4. Nombre.
        const real = idx.adsetCanonicalByName.get(normLabel(raw));
        if (real) return { label: real, matched: true };
      }
      // 5. Sin conjunto propio, pero el ID del anuncio en `utm_content` lo delata.
      if (esIdMeta(rec.utm_content)) {
        const real = idx.adsetByAdId.get(String(rec.utm_content).trim());
        if (real) return { label: real, matched: true };
      }
      return { label: raw || SIN_CONJUNTO, matched: false };
    },

    // Solo entidades con actividad DENTRO del rango: son las únicas que
    // producen una fila en el informe. Las del margen de indexación siguen
    // sirviendo para resolver un UTM, pero no se ofrecen para elegir.
    campaignLabels() {
      return Array.from(idx.campaigns.values())
        .filter((c) => c.spend > 0 || c.impressions > 0 || c.clicks > 0)
        .sort((a, b) => b.spend - a.spend)
        .map((c) => c.name);
    },
    adLabels() {
      return Array.from(idx.adsActivos);
    },
    adsetLabels() {
      return Array.from(idx.adsetsActivos);
    },
    canonicalCampaign(name) {
      // Solo si el nombre lleva a UNA campaña: con varias, cualquiera sería inventada.
      const keys = filtrarCandidatos(idx.byName.get(normLabel(name)), null);
      if (!keys || keys.size !== 1) return null;
      return idx.campaigns.get(keys.values().next().value!)?.name ?? null;
    },
    index: idx,
  };
}

// ── Caché de módulo ───────────────────────────────────────────────────
// Un informe con 12 widgets dispara 12 consultas independientes, cada una con su
// propio rango pero casi siempre el MISMO. Sin caché eso son 12 lecturas de
// `metricas_diarias` (hasta 2000 filas cada una) para construir el mismo índice.
// TTL corto: el índice solo cambia cuando el worker sincroniza.

const RESOLVER_TTL_MS = 60_000;

interface CacheEntry {
  resolver: CampaignResolver;
  ts: number;
}
const resolverCache = new Map<string, CacheEntry>();

/** Vacía las entradas expiradas (evita que el mapa crezca sin fin). */
function pruneCache(now: number): void {
  for (const [k, v] of resolverCache) {
    if (now - v.ts > RESOLVER_TTL_MS) resolverCache.delete(k);
  }
}

/**
 * Resolver listo para usar: índice de campañas + overrides del cliente.
 * Devuelve null si el cliente report_utm no está enlazado a un cliente público
 * (sin ese enlace no hay gasto con el que cruzar).
 */
export async function loadResolver(
  clienteId: string,
  dateFrom: string,
  dateTo: string
): Promise<CampaignResolver | null> {
  const key = `${clienteId}|${dateFrom}|${dateTo}`;
  const now = Date.now();
  const hit = resolverCache.get(key);
  if (hit && now - hit.ts <= RESOLVER_TTL_MS) return hit.resolver;

  const publicId = await resolvePublicClienteId(clienteId);
  if (!publicId) return null;

  const [idx, overrides] = await Promise.all([
    loadCampaignIndex(publicId, dateFrom, dateTo),
    loadOverrides(clienteId),
  ]);
  // Sin índice fiable no se resuelve nada: el motor degrada a los UTM crudos,
  // que es coherente aunque sea peor, y no se cachea para reintentar enseguida.
  if (!idx) return null;
  const resolver = buildResolver(idx, overrides);

  pruneCache(now);
  resolverCache.set(key, { resolver, ts: now });
  return resolver;
}
