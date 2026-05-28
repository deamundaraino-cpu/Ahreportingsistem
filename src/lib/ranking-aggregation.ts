import type { CampaignFilterSpec, CampaignFilterOperator } from './layout-types'

export type RankingDimension =
    | 'campaigns' | 'ads' | 'adsets'
    | 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups'

// Maps raw entry fields → meta_* formula keys
const META_FIELD_MAP: { raw: string; meta: string; float?: boolean }[] = [
    { raw: 'spend',                   meta: 'meta_spend',                           float: true },
    { raw: 'impressions',             meta: 'meta_impressions' },
    { raw: 'clicks',                  meta: 'meta_clicks' },
    { raw: 'link_clicks',             meta: 'meta_link_clicks' },
    { raw: 'reach',                   meta: 'meta_reach' },
    { raw: 'frequency',               meta: 'meta_frequency',                        float: true },
    { raw: 'leads',                   meta: 'meta_leads' },
    { raw: 'leads_form',              meta: 'meta_leads_form' },
    { raw: 'purchases',               meta: 'meta_purchases' },
    { raw: 'adds_to_cart',            meta: 'meta_adds_to_cart' },
    { raw: 'initiates_checkout',      meta: 'meta_initiates_checkout' },
    { raw: 'landing_page_views',      meta: 'meta_landing_page_views' },
    { raw: 'complete_registration',   meta: 'meta_complete_registration' },
    { raw: 'view_content',            meta: 'meta_view_content' },
    { raw: 'search',                  meta: 'meta_search' },
    { raw: 'add_to_wishlist',         meta: 'meta_add_to_wishlist' },
    { raw: 'customize_product',       meta: 'meta_customize_product' },
    { raw: 'contact',                 meta: 'meta_contact' },
    { raw: 'schedule',                meta: 'meta_schedule' },
    { raw: 'start_trial',             meta: 'meta_start_trial' },
    { raw: 'submit_application',      meta: 'meta_submit_application' },
    { raw: 'subscribe',               meta: 'meta_subscribe' },
    { raw: 'find_location',           meta: 'meta_find_location' },
    { raw: 'donate',                  meta: 'meta_donate' },
    { raw: 'video_views',             meta: 'meta_video_views' },
    { raw: 'video_thruplay',          meta: 'meta_video_thruplay' },
    { raw: 'video_3s',                meta: 'meta_video_3s_views' },
    { raw: 'messaging_conversations', meta: 'meta_messaging_conversations_started' },
    { raw: 'page_engagement',         meta: 'meta_page_engagement' },
    { raw: 'post_engagement',         meta: 'meta_post_engagement' },
    { raw: 'post_reactions',          meta: 'meta_post_reactions' },
    { raw: 'post_shares',             meta: 'meta_post_shares' },
    { raw: 'post_saves',              meta: 'meta_post_saves' },
    { raw: 'post_comments',           meta: 'meta_post_comments' },
    { raw: 'results',                 meta: 'meta_results' },
]

// Maps TikTok raw entry fields → tiktok_* formula keys
const TIKTOK_FIELD_MAP: { raw: string; meta: string; float?: boolean }[] = [
    { raw: 'spend',       meta: 'tiktok_spend',       float: true },
    { raw: 'impressions', meta: 'tiktok_impressions' },
    { raw: 'clicks',      meta: 'tiktok_clicks' },
    { raw: 'conversions', meta: 'tiktok_conversions' },
]

function matchesFilter(name: string, filter: CampaignFilterSpec): boolean {
    const op: CampaignFilterOperator = filter.operator ?? 'includes'
    const n = name.toLowerCase()
    const v = filter.value
    switch (op) {
        case 'includes':    return typeof v === 'string' && n.includes(v.toLowerCase())
        case 'excludes':    return typeof v === 'string' && !n.includes(v.toLowerCase())
        case 'exact':       return typeof v === 'string' && n === v.toLowerCase()
        case 'not_exact':   return typeof v === 'string' && n !== v.toLowerCase()
        case 'starts_with': return typeof v === 'string' && n.startsWith(v.toLowerCase())
        case 'ends_with':   return typeof v === 'string' && n.endsWith(v.toLowerCase())
        case 'any_of':      return Array.isArray(v) && v.some(x => x.toLowerCase() === n)
        case 'none_of':     return Array.isArray(v) && !v.some(x => x.toLowerCase() === n)
        default:            return true
    }
}

export function aggregateRankingRows(
    metrics: any[],
    dimension: RankingDimension,
    campaignFilter?: CampaignFilterSpec,
    accountId?: string,
): any[] {
    const isTiktok = dimension.startsWith('tiktok_')

    if (isTiktok) {
        return aggregateTiktokRows(metrics, dimension as 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups', campaignFilter, accountId)
    }

    // ── Meta aggregation (original logic) ────────────────────────────────────
    const groupMap = new Map<string, any>()

    const arrayKey = dimension === 'campaigns' ? 'meta_campaigns'
        : dimension === 'ads' ? 'meta_ads'
        : 'meta_adsets'

    const idKey = dimension === 'campaigns' ? 'campaign_id'
        : dimension === 'ads' ? 'ad_id'
        : 'adset_id'

    const nameKey = dimension === 'campaigns' ? 'name'
        : dimension === 'ads' ? 'ad_name'
        : 'adset_name'

    const filterKey = dimension === 'campaigns' ? 'name' : 'campaign_name'

    for (const row of metrics) {
        const entries: any[] = Array.isArray(row[arrayKey]) ? row[arrayKey] : []

        for (const entry of entries) {
            if (campaignFilter && campaignFilter.type === 'keyword') {
                const nameToFilter = String(entry[filterKey] || entry.name || '')
                if (!matchesFilter(nameToFilter, campaignFilter)) continue
            }

            const pk = String(entry[idKey] || entry[nameKey] || 'unknown')

            if (!groupMap.has(pk)) {
                const acc: any = {
                    _name: String(entry[nameKey] || 'Desconocido'),
                    _id: String(entry[idKey] || ''),
                    _campaign_id: String(entry.campaign_id || ''),
                    _adset_id: String(entry.adset_id || ''),
                }
                META_FIELD_MAP.forEach(f => { acc[f.meta] = 0 })
                groupMap.set(pk, acc)
            }

            const acc = groupMap.get(pk)!
            META_FIELD_MAP.forEach(f => {
                const parsed = f.float
                    ? parseFloat(String(entry[f.raw] ?? 0)) || 0
                    : parseInt(String(entry[f.raw] ?? 0)) || 0
                acc[f.meta] += parsed
            })

            if (entry.custom_conversions && typeof entry.custom_conversions === 'object') {
                for (const [k, v] of Object.entries(entry.custom_conversions)) {
                    acc[`meta_custom_${k}`] = (acc[`meta_custom_${k}`] || 0) + (Number(v) || 0)
                }
            }
        }
    }

    return Array.from(groupMap.values())
}

function aggregateTiktokRows(
    metrics: any[],
    dimension: 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups',
    campaignFilter?: CampaignFilterSpec,
    accountId?: string,
): any[] {
    const groupMap = new Map<string, any>()

    const arrayKey = dimension === 'tiktok_campaigns' ? 'tiktok_campaigns'
        : dimension === 'tiktok_ads' ? 'tiktok_ads'
        : 'tiktok_adgroups'

    const idKey = dimension === 'tiktok_campaigns' ? 'campaign_id'
        : dimension === 'tiktok_ads' ? 'ad_id'
        : 'adgroup_id'

    const nameKey = dimension === 'tiktok_campaigns' ? 'name'
        : dimension === 'tiktok_ads' ? 'ad_name'
        : 'adgroup_name'

    for (const row of metrics) {
        const entries: any[] = Array.isArray(row[arrayKey]) ? row[arrayKey] : []

        for (const entry of entries) {
            if (accountId && entry.account_id !== accountId) continue

            if (campaignFilter && campaignFilter.type === 'keyword') {
                const nameToFilter = String(entry.campaign_name || entry.name || '')
                if (!matchesFilter(nameToFilter, campaignFilter)) continue
            }

            const pk = String(entry[idKey] || entry[nameKey] || 'unknown')

            if (!groupMap.has(pk)) {
                const acc: any = {
                    _name: String(entry[nameKey] || 'Desconocido'),
                    _id: String(entry[idKey] || ''),
                    _campaign_name: String(entry.campaign_name || ''),
                }
                TIKTOK_FIELD_MAP.forEach(f => { acc[f.meta] = 0 })
                groupMap.set(pk, acc)
            }

            const acc = groupMap.get(pk)!
            TIKTOK_FIELD_MAP.forEach(f => {
                const parsed = f.float
                    ? parseFloat(String(entry[f.raw] ?? 0)) || 0
                    : parseInt(String(entry[f.raw] ?? 0)) || 0
                acc[f.meta] += parsed
            })
        }
    }

    return Array.from(groupMap.values())
}
