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

export function enrichMetaRow(row: any, keywordFilter: string, campaignGroups?: any[]): any {
    // Use original logic for campaign filtering
    if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) return row

    let matching = row.meta_campaigns

    // Si hay un ID de grupo válido, filtrar por ese grupo
    if (keywordFilter && campaignGroups && campaignGroups.length > 0) {
        const selectedGroup = campaignGroups.find(g => g.id === keywordFilter)
        if (selectedGroup && selectedGroup.campaign_group_mappings) {
            matching = row.meta_campaigns.filter((c: any) =>
                campaignMatchesGroup(c, selectedGroup.campaign_group_mappings)
            )
        } else {
            // Fallback: buscar por nombre si no es un ID de grupo válido
            const kw = keywordFilter.toLowerCase()
            matching = row.meta_campaigns.filter((c: any) =>
                kw === '' || c.name?.toLowerCase().includes(kw)
            )
        }
    } else if (keywordFilter) {
        // Original behavior: búsqueda por keyword en nombre
        const kw = keywordFilter.toLowerCase()
        matching = row.meta_campaigns.filter((c: any) =>
            kw === '' || c.name?.toLowerCase().includes(kw)
        )
    }

    // Reduce helper (inline to avoid breaking patterns)
    const ri = (field: string) => matching.reduce((s: number, c: any) => s + (parseInt(c[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, c: any) => s + (parseFloat(c[field] || '0') || 0), 0)

    // Base metrics from matched campaigns
    const base = {
        ...row,
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
