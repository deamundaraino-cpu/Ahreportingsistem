import type { CampaignFilterSpec, CampaignFilterOperator } from './layout-types';
import { filterCampaignList, type AnyCampaignFilter } from './campaign-filter';
import {
  clavesDelDataset,
  desglosePorCampana,
  CLAVE_TOTAL_LEADS,
} from './dashboard/lead-answer-aggregation';
import { CLAVE_CUBO, permitidasDelCubo } from './dashboard/lead-answer-row';
import type { CuboRespuestasRef } from './dashboard/lead-answer-row';

/** ¿La entrada (campaña/ad/adset) pasa el filtro de keyword/compuesto de la pestaña? */
function passesKeyword(
  nameToCheck: string,
  campaignId: any,
  effectiveKeyword: AnyCampaignFilter,
  campaignGroups?: any[]
): boolean {
  if (!effectiveKeyword) return true;
  // Reutiliza el motor central (grupos + operadores + Y/O) sobre una campaña-sonda.
  return (
    filterCampaignList(
      [{ name: nameToCheck, campaign_id: campaignId }],
      effectiveKeyword,
      campaignGroups
    ).length > 0
  );
}

export type RankingDimension =
  'campaigns' | 'ads' | 'adsets' | 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups';

/**
 * ¿Esta dimensión puede servir métricas de Report-UTM?
 *
 * Solo `campaigns`. El cubo de respuestas resuelve cada lead hasta su CAMPAÑA
 * —la cascada de `campaign-resolver` no llega más abajo— porque un formulario no
 * sabe qué anuncio concreto trajo al visitante. En anuncio y conjunto la única
 * respuesta honesta es «no aplica»: un 0 diría que no hubo leads, que es falso.
 */
export function dimensionSoportaRespuestas(d: RankingDimension): boolean {
  return d === 'campaigns';
}

/** Leads que el ranking no puede colgar de ninguna fila. Se declaran, no se pierden. */
export interface LeadsFueraDeRanking {
  /** Sin campaña identificada: quedan fuera en cuanto hay filtro. */
  sinCampana: number;
  /** De campañas que existen en el cubo pero sin registro de gasto en el rango. */
  fueraDeTabla: number;
}

// Maps raw entry fields → meta_* formula keys
const META_FIELD_MAP: { raw: string; meta: string; float?: boolean }[] = [
  { raw: 'spend', meta: 'meta_spend', float: true },
  { raw: 'impressions', meta: 'meta_impressions' },
  { raw: 'clicks', meta: 'meta_clicks' },
  { raw: 'link_clicks', meta: 'meta_link_clicks' },
  { raw: 'reach', meta: 'meta_reach' },
  { raw: 'frequency', meta: 'meta_frequency', float: true },
  { raw: 'leads', meta: 'meta_leads' },
  { raw: 'leads_form', meta: 'meta_leads_form' },
  { raw: 'purchases', meta: 'meta_purchases' },
  { raw: 'adds_to_cart', meta: 'meta_adds_to_cart' },
  { raw: 'initiates_checkout', meta: 'meta_initiates_checkout' },
  { raw: 'landing_page_views', meta: 'meta_landing_page_views' },
  { raw: 'complete_registration', meta: 'meta_complete_registration' },
  { raw: 'view_content', meta: 'meta_view_content' },
  { raw: 'search', meta: 'meta_search' },
  { raw: 'add_to_wishlist', meta: 'meta_add_to_wishlist' },
  { raw: 'customize_product', meta: 'meta_customize_product' },
  { raw: 'contact', meta: 'meta_contact' },
  { raw: 'schedule', meta: 'meta_schedule' },
  { raw: 'start_trial', meta: 'meta_start_trial' },
  { raw: 'submit_application', meta: 'meta_submit_application' },
  { raw: 'subscribe', meta: 'meta_subscribe' },
  { raw: 'find_location', meta: 'meta_find_location' },
  { raw: 'donate', meta: 'meta_donate' },
  { raw: 'video_views', meta: 'meta_video_views' },
  { raw: 'video_thruplay', meta: 'meta_video_thruplay' },
  { raw: 'video_3s', meta: 'meta_video_3s_views' },
  { raw: 'messaging_conversations', meta: 'meta_messaging_conversations_started' },
  { raw: 'page_engagement', meta: 'meta_page_engagement' },
  { raw: 'post_engagement', meta: 'meta_post_engagement' },
  { raw: 'post_reactions', meta: 'meta_post_reactions' },
  { raw: 'post_shares', meta: 'meta_post_shares' },
  { raw: 'post_saves', meta: 'meta_post_saves' },
  { raw: 'post_comments', meta: 'meta_post_comments' },
  { raw: 'results', meta: 'meta_results' },
];

// Maps TikTok raw entry fields → tiktok_* formula keys
const TIKTOK_FIELD_MAP: { raw: string; meta: string; float?: boolean }[] = [
  { raw: 'spend', meta: 'tiktok_spend', float: true },
  { raw: 'impressions', meta: 'tiktok_impressions' },
  { raw: 'clicks', meta: 'tiktok_clicks' },
  { raw: 'conversions', meta: 'tiktok_conversions' },
];

function matchesFilter(name: string, filter: CampaignFilterSpec): boolean {
  const op: CampaignFilterOperator = filter.operator ?? 'includes';
  const n = name.toLowerCase();
  const v = filter.value;
  switch (op) {
    case 'includes':
      return typeof v === 'string' && n.includes(v.toLowerCase());
    case 'excludes':
      return typeof v === 'string' && !n.includes(v.toLowerCase());
    case 'exact':
      return typeof v === 'string' && n === v.toLowerCase();
    case 'not_exact':
      return typeof v === 'string' && n !== v.toLowerCase();
    case 'starts_with':
      return typeof v === 'string' && n.startsWith(v.toLowerCase());
    case 'ends_with':
      return typeof v === 'string' && n.endsWith(v.toLowerCase());
    case 'any_of':
      return Array.isArray(v) && v.some((x) => x.toLowerCase() === n);
    case 'none_of':
      return Array.isArray(v) && !v.some((x) => x.toLowerCase() === n);
    default:
      return true;
  }
}

export function aggregateRankingRows(
  metrics: any[],
  dimension: RankingDimension,
  campaignFilter?: CampaignFilterSpec,
  accountId?: string,
  effectiveKeyword?: AnyCampaignFilter,
  campaignGroups?: any[]
): any[] {
  const isTiktok = dimension.startsWith('tiktok_');

  if (isTiktok) {
    return aggregateTiktokRows(
      metrics,
      dimension as 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups',
      campaignFilter,
      accountId,
      effectiveKeyword,
      campaignGroups
    );
  }

  // ── Meta aggregation (original logic) ────────────────────────────────────
  const groupMap = new Map<string, any>();

  const arrayKey =
    dimension === 'campaigns' ? 'meta_campaigns' : dimension === 'ads' ? 'meta_ads' : 'meta_adsets';

  const idKey =
    dimension === 'campaigns' ? 'campaign_id' : dimension === 'ads' ? 'ad_id' : 'adset_id';

  const nameKey =
    dimension === 'campaigns' ? 'name' : dimension === 'ads' ? 'ad_name' : 'adset_name';

  const filterKey = dimension === 'campaigns' ? 'name' : 'campaign_name';

  for (const row of metrics) {
    const entries: any[] = Array.isArray(row[arrayKey]) ? row[arrayKey] : [];

    for (const entry of entries) {
      // Keyword/filtro compuesto de la pestaña (nomenclatura de campañas)
      if (
        !passesKeyword(
          String(entry[filterKey] || entry.name || ''),
          entry.campaign_id,
          effectiveKeyword,
          campaignGroups
        )
      )
        continue;
      // Filtro específico del ranking encadenado sobre el subset del keyword
      if (campaignFilter && campaignFilter.type === 'keyword') {
        const nameToFilter = String(entry[filterKey] || entry.name || '');
        if (!matchesFilter(nameToFilter, campaignFilter)) continue;
      }

      const pk = String(entry[idKey] || entry[nameKey] || 'unknown');

      if (!groupMap.has(pk)) {
        const acc: any = {
          _name: String(entry[nameKey] || 'Desconocido'),
          _id: String(entry[idKey] || ''),
          _campaign_id: String(entry.campaign_id || ''),
          _adset_id: String(entry.adset_id || ''),
        };
        META_FIELD_MAP.forEach((f) => {
          acc[f.meta] = 0;
        });
        groupMap.set(pk, acc);
      }

      const acc = groupMap.get(pk)!;
      META_FIELD_MAP.forEach((f) => {
        const parsed = f.float
          ? parseFloat(String(entry[f.raw] ?? 0)) || 0
          : parseInt(String(entry[f.raw] ?? 0)) || 0;
        acc[f.meta] += parsed;
      });

      if (entry.custom_conversions && typeof entry.custom_conversions === 'object') {
        for (const [k, v] of Object.entries(entry.custom_conversions)) {
          acc[`meta_custom_${k}`] = (acc[`meta_custom_${k}`] || 0) + (Number(v) || 0);
        }
      }
    }
  }

  // ── Respuestas de formulario ─────────────────────────────────────────────
  // Solo en dimensión campaña: es hasta donde resuelve el cubo. En anuncio y
  // conjunto NO se añade nada, y esa ausencia es deliberada — hace que la celda
  // muestre «n/a» en vez de un 0 que afirmaría que no hubo leads.
  if (dimension === 'campaigns') {
    repartirRespuestas(groupMap, metrics, campaignFilter);
  }

  return Array.from(groupMap.values());
}

/**
 * Cuelga las claves de Report-UTM de cada campaña del ranking.
 *
 * El cruce va por `campaign_id` y cae al nombre normalizado: los dos lados salen
 * de la misma tabla de campañas —el cubo toma su etiqueta de `resolver.campaignOf`,
 * que devuelve el `name` del índice— y en producción el 100 % de las entradas de
 * `meta_campaigns` traen id.
 */
function repartirRespuestas(
  groupMap: Map<string, any>,
  metrics: any[],
  campaignFilter?: CampaignFilterSpec
): void {
  const ref = metrics.find((r: any) => r?.[CLAVE_CUBO])?.[CLAVE_CUBO] as
    CuboRespuestasRef | undefined;
  if (!ref) return;

  const claves = clavesDelDataset(ref.ds);
  if (claves.length === 0) return;

  // Índice de acumuladores por id y por nombre normalizado.
  const porId = new Map<string, any>();
  const porNombre = new Map<string, any>();
  for (const acc of groupMap.values()) {
    for (const clave of claves) if (acc[clave] === undefined) acc[clave] = 0;
    if (acc._id) porId.set(String(acc._id), acc);
    if (acc._name) porNombre.set(normalizarNombre(String(acc._name)), acc);
  }

  const permitidas = permitidasDelCubo(ref, campaignFilter);

  for (const row of metrics) {
    const fecha = String(row?.fecha ?? '');
    if (!fecha) continue;
    for (const { campaignId, nombre, valores } of desglosePorCampana(ref.ds, fecha, permitidas)) {
      const acc = (campaignId && porId.get(campaignId)) ?? porNombre.get(normalizarNombre(nombre));
      if (!acc) continue; // campaña sin gasto ese día: se declara aparte
      for (const [clave, n] of Object.entries(valores)) {
        acc[clave] = (acc[clave] ?? 0) + n;
      }
    }
  }
}

function normalizarNombre(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Contactos que no aparecen en ninguna fila del ranking.
 *
 * Se calculan aparte para no cambiar el tipo de retorno de `aggregateRankingRows`
 * —lo consumen la tabla y las gráficas— y para poder declararlos al pie: un total
 * que no cuadra con la suma de la tabla parece un fallo si nadie lo explica.
 */
export function leadsFueraDeRanking(
  metrics: any[],
  filas: any[],
  campaignFilter?: CampaignFilterSpec
): LeadsFueraDeRanking {
  const ref = metrics.find((r: any) => r?.[CLAVE_CUBO])?.[CLAVE_CUBO] as
    CuboRespuestasRef | undefined;
  if (!ref) return { sinCampana: 0, fueraDeTabla: 0 };

  const porId = new Set<string>();
  const porNombre = new Set<string>();
  for (const acc of filas) {
    if (acc._id) porId.add(String(acc._id));
    if (acc._name) porNombre.add(normalizarNombre(String(acc._name)));
  }

  const permitidas = permitidasDelCubo(ref, campaignFilter);
  // Sin filtro el índice 0 SÍ está permitido y sus leads cuentan en el total,
  // pero siguen sin poder colgar de ninguna campaña: se cuentan aparte igual.
  let sinCampana = 0;
  let fueraDeTabla = 0;

  for (const row of metrics) {
    const fecha = String(row?.fecha ?? '');
    if (!fecha) continue;
    for (const { campaignId, nombre, valores, esSinCampana } of desglosePorCampana(
      ref.ds,
      fecha,
      permitidas
    )) {
      const n = valores[CLAVE_TOTAL_LEADS] ?? 0;
      if (!n) continue;
      if (esSinCampana) {
        sinCampana += n;
        continue;
      }
      const encontrada =
        (campaignId && porId.has(campaignId)) || porNombre.has(normalizarNombre(nombre));
      if (!encontrada) fueraDeTabla += n;
    }
  }
  return { sinCampana, fueraDeTabla };
}

function aggregateTiktokRows(
  metrics: any[],
  dimension: 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups',
  campaignFilter?: CampaignFilterSpec,
  accountId?: string,
  effectiveKeyword?: AnyCampaignFilter,
  campaignGroups?: any[]
): any[] {
  const groupMap = new Map<string, any>();

  const arrayKey =
    dimension === 'tiktok_campaigns'
      ? 'tiktok_campaigns'
      : dimension === 'tiktok_ads'
        ? 'tiktok_ads'
        : 'tiktok_adgroups';

  const idKey =
    dimension === 'tiktok_campaigns'
      ? 'campaign_id'
      : dimension === 'tiktok_ads'
        ? 'ad_id'
        : 'adgroup_id';

  const nameKey =
    dimension === 'tiktok_campaigns'
      ? 'name'
      : dimension === 'tiktok_ads'
        ? 'ad_name'
        : 'adgroup_name';

  for (const row of metrics) {
    const entries: any[] = Array.isArray(row[arrayKey]) ? row[arrayKey] : [];

    for (const entry of entries) {
      if (accountId && entry.account_id !== accountId) continue;

      // Keyword/filtro compuesto de la pestaña
      if (
        !passesKeyword(
          String(entry.campaign_name || entry.name || ''),
          entry.campaign_id,
          effectiveKeyword,
          campaignGroups
        )
      )
        continue;
      // Filtro específico encadenado
      if (campaignFilter && campaignFilter.type === 'keyword') {
        const nameToFilter = String(entry.campaign_name || entry.name || '');
        if (!matchesFilter(nameToFilter, campaignFilter)) continue;
      }

      const pk = String(entry[idKey] || entry[nameKey] || 'unknown');

      if (!groupMap.has(pk)) {
        const acc: any = {
          _name: String(entry[nameKey] || 'Desconocido'),
          _id: String(entry[idKey] || ''),
          _campaign_name: String(entry.campaign_name || ''),
        };
        TIKTOK_FIELD_MAP.forEach((f) => {
          acc[f.meta] = 0;
        });
        groupMap.set(pk, acc);
      }

      const acc = groupMap.get(pk)!;
      TIKTOK_FIELD_MAP.forEach((f) => {
        const parsed = f.float
          ? parseFloat(String(entry[f.raw] ?? 0)) || 0
          : parseInt(String(entry[f.raw] ?? 0)) || 0;
        acc[f.meta] += parsed;
      });
    }
  }

  return Array.from(groupMap.values());
}
