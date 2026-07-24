import type { CampaignFilterOperator, CampaignFilterSpec, TabCampaignFilter } from './layout-types'

/** Filtro admitido en todo el pipeline: string simple, un spec, o compuesto Y/O. */
export type AnyCampaignFilter = string | CampaignFilterSpec | TabCampaignFilter | undefined

/** Prefijo con que se serializa un TabCampaignFilter dentro de `keyword_meta`. */
const TAB_FILTER_PREFIX = '__cf:'

/** Type guard: ¿es un filtro compuesto (lista de condiciones Y/O)? */
function isTabFilter(f: AnyCampaignFilter): f is TabCampaignFilter {
    return typeof f === 'object' && f !== null && 'conditions' in f && Array.isArray((f as TabCampaignFilter).conditions)
}

// Helper: Verificar si una campaña coincide con el patrón del grupo
function campaignMatchesPattern(
    campaign: any,
    pattern: string
): boolean {
    if (!pattern) return false

    // Convertir patrón SQL LIKE a regex
    // % = .* (cualquier cosa)
    // _ = . (un carácter)
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escapar caracteres especiales regex
        .replace(/%/g, '.*')
        .replace(/_/g, '.')

    const regex = new RegExp(`^${regexPattern}$`, 'i')
    return regex.test(campaign.name || '')
}

// Helper: Verificar si una campaña pertenece a un grupo
function campaignMatchesGroup(
    campaign: any,
    groupMappings: Array<{ campaign_id?: string; campaign_name_pattern?: string }>
): boolean {
    for (const mapping of groupMappings) {
        if (mapping.campaign_id && campaign.campaign_id === mapping.campaign_id) {
            return true
        }
        if (mapping.campaign_name_pattern && campaignMatchesPattern(campaign, mapping.campaign_name_pattern)) {
            return true
        }
    }
    return false
}

// Helper: Aplicar operador de filtro al nombre de una campaña
function campaignMatchesOperator(
    name: string,
    operator: CampaignFilterOperator,
    value: string | string[]
): boolean {
    const n = name.toLowerCase()
    switch (operator) {
        case 'includes':
            return typeof value === 'string' && n.includes(value.toLowerCase())
        case 'excludes':
            return typeof value === 'string' && !n.includes(value.toLowerCase())
        case 'exact':
            return typeof value === 'string' && n === value.toLowerCase()
        case 'not_exact':
            return typeof value === 'string' && n !== value.toLowerCase()
        case 'starts_with':
            return typeof value === 'string' && n.startsWith(value.toLowerCase())
        case 'ends_with':
            return typeof value === 'string' && n.endsWith(value.toLowerCase())
        case 'any_of':
            return Array.isArray(value) && value.some(v => v.toLowerCase() === n)
        case 'none_of':
            return Array.isArray(value) && !value.some(v => v.toLowerCase() === n)
        default:
            return true
    }
}

/** ¿El filtro (string vacío / spec sin valor / compuesto sin condiciones) es "nada"? */
function isEmptyFilter(filter: AnyCampaignFilter): boolean {
    if (!filter) return true
    if (typeof filter === 'string') return filter === ''
    if (isTabFilter(filter)) {
        return filter.conditions.every(c => (Array.isArray(c.value) ? c.value.length === 0 : c.value === ''))
    }
    return Array.isArray(filter.value) ? filter.value.length === 0 : filter.value === ''
}

type CampaignLike = { name?: string | null; campaign_id?: string | number | null }
type CampaignGroupLike = { id?: string; campaign_group_mappings?: Array<{ campaign_id?: string; campaign_name_pattern?: string }> }

/**
 * ¿Una campaña individual cumple una condición simple (string o CampaignFilterSpec)?
 * Es el ladrillo reutilizado tanto por el filtro simple como por el compuesto.
 */
function campaignMatchesOne(
    campaign: CampaignLike,
    filter: string | CampaignFilterSpec,
    campaignGroups?: CampaignGroupLike[]
): boolean {
    if (typeof filter === 'string') {
        if (filter === '') return true
        if (campaignGroups && campaignGroups.length > 0) {
            const selectedGroup = campaignGroups.find(g => g.id === filter)
            if (selectedGroup && selectedGroup.campaign_group_mappings) {
                return campaignMatchesGroup(campaign, selectedGroup.campaign_group_mappings)
            }
        }
        return (campaign.name?.toLowerCase() ?? '').includes(filter.toLowerCase())
    }
    if (filter.type === 'group' && typeof filter.value === 'string' && campaignGroups) {
        const selectedGroup = campaignGroups.find(g => g.id === filter.value)
        if (selectedGroup && selectedGroup.campaign_group_mappings) {
            return campaignMatchesGroup(campaign, selectedGroup.campaign_group_mappings)
        }
        return true // grupo no resuelto → no recorta (comportamiento previo)
    }
    // Condición vacía no recorta.
    if (Array.isArray(filter.value) ? filter.value.length === 0 : filter.value === '') return true
    const op: CampaignFilterOperator = filter.operator ?? 'includes'
    return campaignMatchesOperator(campaign.name || '', op, filter.value)
}

/**
 * Filters a list of campaigns by a keyword/group/spec/compound filter.
 * Returns the subset of campaigns that match. Exported for compound filtering.
 *
 * Un `TabCampaignFilter` combina varias condiciones con Y (todas) u O (alguna),
 * reutilizando `campaignMatchesOne` por condición.
 */
export function filterCampaignList(
    campaigns: any[],
    filter: AnyCampaignFilter,
    campaignGroups?: any[]
): any[] {
    if (isEmptyFilter(filter)) return campaigns

    if (isTabFilter(filter)) {
        // Condiciones con valor; las vacías se ignoran (no aportan al Y/O).
        const conds = filter.conditions.filter(c => (Array.isArray(c.value) ? c.value.length > 0 : c.value !== ''))
        if (conds.length === 0) return campaigns
        return campaigns.filter((c: any) =>
            filter.mode === 'or'
                ? conds.some(cond => campaignMatchesOne(c, cond, campaignGroups))
                : conds.every(cond => campaignMatchesOne(c, cond, campaignGroups))
        )
    }

    return campaigns.filter((c: any) => campaignMatchesOne(c, filter as string | CampaignFilterSpec, campaignGroups))
}

/**
 * ¿El desglose por campaña respalda la columna agregada de gasto?
 *
 * Importa porque todas las cifras de gasto del dashboard salen de sumar el array
 * de campañas, nunca de la columna. Si el array quedó truncado (paginación de
 * Meta rota antes del fix de 2026-06-23, o una página que falló a mitad), el día
 * aparece en $0 aunque la cuenta sí gastó — indistinguible de un día sin
 * inversión. Marcarlo permite avisar en vez de mostrar un cero que parece real.
 *
 * Tolerancia del 1% con piso de 1 unidad: absorbe redondeos sin tapar faltantes.
 */
function desgloseIncompleto(columna: any, campanas: any): boolean {
    const col = parseFloat(columna ?? '0') || 0
    if (col <= 0) return false
    if (!Array.isArray(campanas)) return false
    const arr = campanas.reduce((s: number, c: any) => s + (parseFloat(c?.spend || '0') || 0), 0)
    return Math.abs(col - arr) > Math.max(1, col * 0.01)
}

export function metaRowIsIncomplete(row: any): boolean {
    return desgloseIncompleto(row?.meta_spend, row?.meta_campaigns)
}

/** Igual que `metaRowIsIncomplete`, para el desglose de TikTok. */
export function tiktokRowIsIncomplete(row: any): boolean {
    return desgloseIncompleto(row?.tiktok_spend, row?.tiktok_campaigns)
}

export function enrichMetaRow(
    row: any,
    filter: AnyCampaignFilter,
    campaignGroups?: any[]
): any {
    if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) return row

    // Se evalúan las dos plataformas aquí porque `enrichMetaRow` es el paso por el
    // que pasan todas las filas del dashboard; `enrichTikTokRow` es opcional.
    const incomplete = metaRowIsIncomplete(row) || tiktokRowIsIncomplete(row)
    const matching = filterCampaignList(row.meta_campaigns, filter, campaignGroups)

    // Reduce helper (inline to avoid breaking patterns)
    const ri = (field: string) => matching.reduce((s: number, c: any) => s + (parseInt(c[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, c: any) => s + (parseFloat(c[field] || '0') || 0), 0)

    // Base metrics from matched campaigns
    const base = {
        ...row,
        // El desglose no respalda la columna: las cifras de este día están
        // incompletas y la UI debe avisarlo en vez de mostrar un cero creíble.
        meta_data_incomplete: incomplete,
        // Entrega
        meta_spend:       rf('spend'),
        meta_impressions: ri('impressions'),
        meta_clicks:      ri('clicks'),
        meta_link_clicks: ri('link_clicks'),
        meta_reach:       ri('reach'),
        meta_frequency:   rf('frequency'),
        // Leads y conversiones estándar
        meta_leads:                  ri('leads'),
        meta_leads_form:             ri('leads_form'),
        meta_purchases:              ri('purchases'),
        meta_adds_to_cart:           ri('adds_to_cart'),
        meta_initiates_checkout:     ri('initiates_checkout'),
        meta_landing_page_views:     ri('landing_page_views'),
        meta_complete_registration:  ri('complete_registration'),
        meta_view_content:           ri('view_content'),
        meta_search:                 ri('search'),
        meta_add_to_wishlist:        ri('add_to_wishlist'),
        meta_customize_product:      ri('customize_product'),
        meta_contact:                ri('contact'),
        meta_schedule:               ri('schedule'),
        meta_start_trial:            ri('start_trial'),
        meta_submit_application:     ri('submit_application'),
        meta_subscribe:              ri('subscribe'),
        meta_find_location:          ri('find_location'),
        meta_donate:                 ri('donate'),
        // Video
        meta_video_views:    ri('video_views'),
        meta_video_thruplay: ri('video_thruplay'),
        meta_video_3s_views: ri('video_3s'),
        // Mensajería
        meta_messaging_conversations_started: ri('messaging_conversations'),
        // Engagement
        meta_page_engagement: ri('page_engagement'),
        meta_post_engagement: ri('post_engagement'),
        meta_post_reactions:  ri('post_reactions'),
        meta_post_shares:     ri('post_shares'),
        meta_post_saves:      ri('post_saves'),
        meta_post_comments:   ri('post_comments'),
        // Resultados
        meta_results: ri('results'),
    }

    // Auto-expand custom pixel conversions: custom_conversions: { leadtcc: 456, lead_neuroemocion: 115 }
    // → exposes meta_custom_leadtcc, meta_custom_lead_neuroemocion, etc. for use in formulas
    const customKeys = new Set<string>()
    matching.forEach((c: any) => {
        if (c.custom_conversions && typeof c.custom_conversions === 'object') {
            Object.keys(c.custom_conversions).forEach(k => customKeys.add(k))
        }
    })
    customKeys.forEach(key => {
        base[`meta_custom_${key}`] = matching.reduce((s: number, c: any) => {
            return s + (c.custom_conversions?.[key] || 0)
        }, 0)
    })

    // Merge manual metrics
    const manuales = row.metricas_manuales || {}
    Object.keys(manuales).forEach(k => {
        base[k] = manuales[k]
    })

    return base
}

/**
 * Recalcula las métricas de TikTok (tiktok_spend/impressions/clicks/conversions)
 * sumando solo las campañas de `tiktok_campaigns` que coinciden con el filtro
 * keyword/grupo/spec. Es el análogo de enrichMetaRow para TikTok.
 *
 * Conserva `tiktok_campaigns` intacto (...row), igual que enrichMetaRow con
 * meta_campaigns, para que el filtro por cuenta (filterRowByTikTokAccount) pueda
 * re-derivar combinando keyword + account_id sobre la misma lista.
 *
 * Si la fila no trae arreglo `tiktok_campaigns` se devuelve sin cambios, así no
 * se sobreescribe el tiktok_spend almacenado en filas antiguas sin desglose.
 */
export function enrichTikTokRow(
    row: any,
    filter: AnyCampaignFilter,
    campaignGroups?: any[]
): any {
    if (!row.tiktok_campaigns || !Array.isArray(row.tiktok_campaigns)) return row

    const matching = filterCampaignList(row.tiktok_campaigns, filter, campaignGroups)
    const ri = (field: string) => matching.reduce((s: number, c: any) => s + (parseInt(c[field] ?? '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, c: any) => s + (parseFloat(c[field] ?? '0') || 0), 0)

    return {
        ...row,
        tiktok_spend:       rf('spend'),
        tiktok_impressions: ri('impressions'),
        tiktok_clicks:      ri('clicks'),
        tiktok_conversions: ri('conversions'),
    }
}

// ─── Filtro de pestaña: (de)serialización sobre keyword_meta (TEXT) ───────────
// Un TabCampaignFilter viaja serializado dentro de `cliente_tabs.keyword_meta`
// con el prefijo `__cf:` (sin migración de BD). Una sola condición `includes`
// se guarda como string plano → compatibilidad total con pestañas existentes y
// con cualquier consumidor que aún trate keyword_meta como texto.

/**
 * Lee `keyword_meta` crudo y devuelve el filtro efectivo:
 * string plano (comportamiento clásico) o `TabCampaignFilter` compuesto.
 * Ante JSON corrupto degrada al string tal cual (nunca lanza).
 */
export function parseTabFilter(raw: string | null | undefined): string | TabCampaignFilter {
    if (!raw) return ''
    if (!raw.startsWith(TAB_FILTER_PREFIX)) return raw
    try {
        const parsed = JSON.parse(raw.slice(TAB_FILTER_PREFIX.length))
        if (parsed && Array.isArray(parsed.conditions)) {
            const mode: 'and' | 'or' = parsed.mode === 'or' ? 'or' : 'and'
            const conditions: CampaignFilterSpec[] = parsed.conditions
                .filter((c: any) => c && (typeof c.value === 'string' || Array.isArray(c.value)))
                .map((c: any) => ({
                    type: c.type === 'group' ? 'group' : 'keyword',
                    operator: c.operator,
                    value: c.value,
                }))
            if (conditions.length > 0) return { mode, conditions }
        }
    } catch {
        // JSON inválido → tratar como texto plano
    }
    return raw
}

/**
 * Serializa un `TabCampaignFilter` para guardarlo en `keyword_meta`.
 * Colapsa a string simple cuando hay una única condición `includes` (o ninguna),
 * para no ensuciar datos que no lo necesitan y mantener retro-compatibilidad.
 */
export function serializeTabFilter(f: string | TabCampaignFilter | null | undefined): string {
    if (f == null) return ''
    if (typeof f === 'string') return f
    const conds = f.conditions.filter(c => (Array.isArray(c.value) ? c.value.length > 0 : String(c.value ?? '') !== ''))
    if (conds.length === 0) return ''
    if (conds.length === 1) {
        const c = conds[0]
        if (c.type === 'keyword' && (c.operator ?? 'includes') === 'includes' && typeof c.value === 'string') {
            return c.value
        }
    }
    return TAB_FILTER_PREFIX + JSON.stringify({ mode: f.mode === 'or' ? 'or' : 'and', conditions: conds })
}

const OPERATOR_LABEL: Record<CampaignFilterOperator, string> = {
    includes: 'incluye', excludes: 'excluye', exact: '=', not_exact: '≠',
    starts_with: 'empieza', ends_with: 'termina', any_of: 'entre', none_of: 'fuera de',
}

/**
 * Etiqueta legible del filtro de una pestaña para badges/tooltips.
 * String plano → tal cual; compuesto → condiciones unidas por "y"/"o".
 */
export function tabFilterLabel(raw: string | null | undefined): string {
    const f = parseTabFilter(raw)
    if (typeof f === 'string') return f
    const parts = f.conditions.map(c => {
        const val = Array.isArray(c.value) ? c.value.join('/') : String(c.value ?? '')
        if (c.type === 'group') return `grupo:${val}`
        const op = c.operator ?? 'includes'
        return op === 'includes' ? val : `${OPERATOR_LABEL[op]} ${val}`
    })
    return parts.join(f.mode === 'or' ? ' o ' : ' y ')
}
