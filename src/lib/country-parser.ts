/**
 * Country Parser — extracts country names from Meta campaign names.
 *
 * Supported formats (in priority order):
 *   1. Bracket notation:  V3[PRODUCTO][MEXICO][CAPTACIÓN][CBO]
 *   2. Dash suffix:       Diplomado-Colombia
 */

// Known country names / abbreviations to recognize
const KNOWN_COUNTRIES = [
    'Colombia', 'México', 'Mexico', 'Argentina', 'Chile', 'Perú', 'Peru',
    'Venezuela', 'Ecuador', 'Bolivia', 'Uruguay', 'Paraguay', 'Panama',
    'CostaRica', 'Guatemala', 'Honduras', 'ElSalvador', 'Nicaragua',
    'RepDominicana', 'Cuba', 'España', 'Espana', 'USA', 'EEUU', 'US',
    'Brasil', 'Brazil', 'Portugal',
]

const COUNTRY_ALIASES: Record<string, string> = {
    mexico: 'México',
    peru: 'Perú',
    espana: 'España',
    costarica: 'Costa Rica',
    elsalvador: 'El Salvador',
    repdom: 'Rep. Dominicana',
    repdomin: 'Rep. Dominicana',
    repdomini: 'Rep. Dominicana',
    repdominicana: 'Rep. Dominicana',
    eeuu: 'USA',
    us: 'USA',
    brasil: 'Brasil',
    brazil: 'Brasil',
}

function normalizeCountry(raw: string): string {
    const lower = raw.toLowerCase()
    if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower]
    const found = KNOWN_COUNTRIES.find(c => c.toLowerCase() === lower)
    return found ?? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
}

/**
 * Extracts country from Meta targeting regions.
 * Meta returns targeting regions with keys like "US", "BR", "MX", etc.
 */
function extractCountryFromTargeting(regions: any[]): string | null {
    if (!Array.isArray(regions) || regions.length === 0) return null

    const regionMap: Record<string, string> = {
        'US': 'USA', 'BR': 'Brasil', 'MX': 'México', 'CO': 'Colombia', 'CL': 'Chile',
        'PE': 'Perú', 'AR': 'Argentina', 'VE': 'Venezuela', 'EC': 'Ecuador', 'ES': 'España',
        'PT': 'Portugal', 'UY': 'Uruguay', 'PY': 'Paraguay', 'PA': 'Panama', 'CR': 'Costa Rica',
        'GT': 'Guatemala', 'HN': 'Honduras', 'SV': 'El Salvador', 'NI': 'Nicaragua',
        'DO': 'Rep. Dominicana', 'CU': 'Cuba', 'BO': 'Bolivia'
    }

    for (const region of regions) {
        const key = region.key || region.name || region
        const country = regionMap[key.toUpperCase()]
        if (country) return country
    }
    return null
}

/**
 * Extracts a country label from a campaign, prioritizing Meta targeting location.
 *
 * Priority:
 *   1. Meta targeting_regions: direct location from campaign's targeting configuration
 *   2. Bracket segments: [TOKEN] — matches any bracket against known countries
 *   3. Dash segments: last "-Token" that matches a known country
 *
 * Returns null if no country detected.
 */
export function extractCountry(campaignName: string, targetingRegions?: any[]): string | null {
    // 1. Use Meta targeting regions if available (highest priority for accuracy)
    if (targetingRegions && targetingRegions.length > 0) {
        const fromTargeting = extractCountryFromTargeting(targetingRegions)
        if (fromTargeting) return fromTargeting
    }

    if (!campaignName) return null

    // 2. Bracket notation — e.g. [MEXICO], [COLOMBIA]
    const bracketMatches = [...campaignName.matchAll(/\[([^\]]+)\]/g)]
    for (const match of bracketMatches) {
        const token = match[1].trim()
        const lower = token.toLowerCase()
        if (KNOWN_COUNTRIES.some(c => c.toLowerCase() === lower) || COUNTRY_ALIASES[lower]) {
            return normalizeCountry(token)
        }
    }

    // 3. Dash suffix — e.g. "Diplomado-Colombia"
    const parts = campaignName.split('-').map(p => p.trim()).filter(Boolean)
    for (let i = parts.length - 1; i >= 1; i--) {
        const lower = parts[i].toLowerCase()
        if (KNOWN_COUNTRIES.some(c => c.toLowerCase() === lower) || COUNTRY_ALIASES[lower]) {
            return normalizeCountry(parts[i])
        }
    }

    return null
}

export interface CountryMetrics {
    country: string
    spend: number
    leads: number
    results: number
    impressions: number
    clicks: number
    cpl: number | null       // spend / leads
    cpr: number | null       // spend / results
    topAdsByResults: AdMetrics[]
    topAdsByCost: AdMetrics[]
}

export interface AdMetrics {
    id: string
    name: string
    spend: number
    leads: number
    results: number
    impressions: number
    clicks: number
    cpl: number | null
    cpr: number | null
}

/**
 * Resolves leads count from a campaign object given a formula string.
 *   - "meta_leads"           → campaign.leads
 *   - "meta_results"         → campaign.results
 *   - "meta_custom_<key>"    → campaign.custom_conversions[key]
 *   - anything else          → campaign.leads (fallback)
 */
function resolveLeadsFromCampaign(campaign: any, leadsFormula: string): number {
    const f = leadsFormula.trim()
    if (f === 'meta_results') return parseInt(campaign.results || '0') || 0
    if (f.startsWith('meta_custom_')) {
        const key = f.replace('meta_custom_', '')
        return Number(campaign.custom_conversions?.[key] || 0)
    }
    // default: meta_leads
    return parseInt(campaign.leads || '0') || 0
}

/**
 * Aggregates campaign-level data by country across all metric rows.
 * @param leadsFormula  Formula string used for leads in this tab/layout (e.g. "meta_custom_leadduaypiar")
 * Returns an array of CountryMetrics sorted by spend descending.
 */
export function aggregateByCountry(
    metrics: any[],
    keywordFilter: string = '',
    leadsFormula: string = 'meta_leads'
): CountryMetrics[] {
    // country → { spend, leads, results, impressions, clicks, ads: Map<id, AdMetrics> }
    const countryMap = new Map<string, {
        spend: number
        leads: number
        results: number
        impressions: number
        clicks: number
        ads: Map<string, { name: string; spend: number; leads: number; results: number; impressions: number; clicks: number }>
    }>()

    const kw = keywordFilter ? keywordFilter.toLowerCase() : ''

    for (const row of metrics) {
        if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) continue

        const campaigns: any[] = row.meta_campaigns.filter((c: any) =>
            kw === '' || c.name?.toLowerCase().includes(kw)
        )

        for (const campaign of campaigns) {
            const country = extractCountry(campaign.name || '', campaign.targeting_regions) ?? 'Sin País'

            if (!countryMap.has(country)) {
                countryMap.set(country, { spend: 0, leads: 0, results: 0, impressions: 0, clicks: 0, ads: new Map() })
            }
            const entry = countryMap.get(country)!

            const spend = parseFloat(campaign.spend || '0') || 0
            const leads = resolveLeadsFromCampaign(campaign, leadsFormula)
            const results = parseInt(campaign.results || '0') || 0
            const impressions = parseInt(campaign.impressions || '0') || 0
            const clicks = parseInt(campaign.clicks || '0') || 0

            entry.spend += spend
            entry.leads += leads
            entry.results += results
            entry.impressions += impressions
            entry.clicks += clicks

            // Accumulate per-ad (campaign level) — prefer campaign_id for dedup accuracy
            const adId = campaign.campaign_id || campaign.id || campaign.name || 'unknown'
            if (!entry.ads.has(adId)) {
                entry.ads.set(adId, { name: campaign.name || adId, spend: 0, leads: 0, results: 0, impressions: 0, clicks: 0 })
            }
            const ad = entry.ads.get(adId)!
            ad.spend += spend
            ad.leads += leads
            ad.results += results
            ad.impressions += impressions
            ad.clicks += clicks
        }
    }

    const result: CountryMetrics[] = []

    for (const [country, data] of countryMap.entries()) {
        const ads: AdMetrics[] = Array.from(data.ads.values()).map(ad => ({
            id: ad.name,
            name: ad.name,
            spend: ad.spend,
            leads: ad.leads,
            results: ad.results,
            impressions: ad.impressions,
            clicks: ad.clicks,
            cpl: ad.leads > 0 ? ad.spend / ad.leads : null,
            cpr: ad.results > 0 ? ad.spend / ad.results : null,
        }))

        result.push({
            country,
            spend: data.spend,
            leads: data.leads,
            results: data.results,
            impressions: data.impressions,
            clicks: data.clicks,
            cpl: data.leads > 0 ? data.spend / data.leads : null,
            cpr: data.results > 0 ? data.spend / data.results : null,
            topAdsByResults: [...ads].sort((a, b) => b.results - a.results).slice(0, 3),
            topAdsByCost: [...ads].sort((a, b) => b.spend - a.spend).slice(0, 3),
        })
    }

    return result.sort((a, b) => b.spend - a.spend)
}
