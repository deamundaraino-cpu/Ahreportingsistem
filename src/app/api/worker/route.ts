import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { format, subDays, parseISO, isBefore, addDays, differenceInDays } from 'date-fns'
import { createClient as createSSRClient } from '@/utils/supabase/server'

/** Lightweight sync hash — detects payload changes without storing full JSON */
function computeSyncHash(obj: any): string {
    const str = JSON.stringify(obj)
    let h = 5381
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(31, h) + str.charCodeAt(i) | 0
    }
    return (h >>> 0).toString(16)
}

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization')
    // CORRECCIÓN 1: Backticks en el Bearer
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let adminSupabase: any;
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        adminSupabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } else {
        adminSupabase = await createSSRClient()
    }

    const { searchParams } = new URL(request.url)
    const singleDate = searchParams.get('date')
    const startDateStr = singleDate || searchParams.get('start') || format(subDays(new Date(), 1), 'yyyy-MM-dd')
    const endDateStr = singleDate || searchParams.get('end') || startDateStr
    const specificClientId = searchParams.get('client_id')

    let query = adminSupabase.from('clientes').select('*')
    if (specificClientId) {
        query = query.eq('id', specificClientId)
    }

    const { data: clientes, error } = await query
    if (error || !clientes) return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 })

    const results = []

    const debugLogs: string[] = []
    const log = (msg: string) => {
        console.log(msg)
        debugLogs.push(msg)
    }

    const datesToSync: string[] = []
    try {
        let currentDate = parseISO(startDateStr)
        const endDate = parseISO(endDateStr)
        const MAX_DAYS = 365
        let dayCount = 0
        while ((isBefore(currentDate, endDate) || currentDate.getTime() === endDate.getTime()) && dayCount < MAX_DAYS) {
            datesToSync.push(format(currentDate, 'yyyy-MM-dd'))
            currentDate = addDays(currentDate, 1)
            dayCount++
        }
    } catch {
        return NextResponse.json({ error: 'Fechas inválidas.' }, { status: 400 })
    }

    for (const cliente of clientes) {
        const config = cliente.config_api as any
        if (!config) continue

        const platformLogs = { meta: 'Saltado', hotmart: 'Saltado', ga4: 'Saltado' }

        let hotmartAccessToken: string | null = null
        const hotmartBasic = config.hotmart_basic ||
            (config.hotmart_client_id && config.hotmart_client_secret
                ? Buffer.from(`${config.hotmart_client_id}:${config.hotmart_client_secret}`).toString('base64')
                : null)
        if (hotmartBasic) {
            try {
                const tokenRes = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${hotmartBasic}`
                    }
                })
                const tokenData = await tokenRes.json()
                if (tokenData.access_token) {
                    hotmartAccessToken = tokenData.access_token
                    log(`[Cliente ${cliente.nombre}] Token de Hotmart obtenido.`)
                    platformLogs.hotmart = 'Preparado'
                } else {
                    log(`[Cliente ${cliente.nombre}] Error obteniendo token de Hotmart: ${JSON.stringify(tokenData)}`)
                    platformLogs.hotmart = 'Error Auth'
                }
            } catch (err: any) {
                log(`[Cliente ${cliente.nombre}] Catch Token Hotmart: ${err.message}`)
                platformLogs.hotmart = 'Fallo Critico'
            }
        } else {
            log(`[Cliente ${cliente.nombre}] No tiene hotmart_basic ni hotmart_client_id/secret definidos.`)
        }

        // ─── Cargar funnels Hotmart configurados por pestaña ────────────────────
        // Cada cliente_tab puede tener hotmart_funnel = { enabled, principal_names[], bump_names[], upsell_names[], payment_page_url, upsell_page_url }
        type FunnelConfig = {
            tab_id: string
            principal_patterns: string[]
            bump_patterns: string[]
            upsell_patterns: string[]
            landing_page_urls: string[]
            payment_page_url?: string
            upsell_page_url?: string
            principal_price_usd?: number
        }
        const hotmartFunnels: FunnelConfig[] = []
        if (hotmartAccessToken) {
            const { data: tabsData } = await adminSupabase
                .from('cliente_tabs')
                .select('id, hotmart_funnel')
                .eq('cliente_id', cliente.id)
            const cleanList = (arr: any): string[] => Array.isArray(arr)
                ? arr.map((s: any) => String(s || '').toLowerCase().trim()).filter(Boolean)
                : []
            for (const tab of (tabsData || [])) {
                const f = tab.hotmart_funnel as any
                if (!f || !f.enabled) continue
                hotmartFunnels.push({
                    tab_id: tab.id,
                    principal_patterns: cleanList(f.principal_names),
                    bump_patterns: cleanList(f.bump_names),
                    upsell_patterns: cleanList(f.upsell_names),
                    landing_page_urls: Array.isArray(f.landing_page_urls) ? f.landing_page_urls.map((s: any) => String(s).trim()).filter(Boolean) : [],
                    payment_page_url: f.payment_page_url || undefined,
                    upsell_page_url: f.upsell_page_url || undefined,
                    principal_price_usd: f.principal_price_usd ? Number(f.principal_price_usd) : undefined,
                })
            }
            if (hotmartFunnels.length > 0) {
                log(`[Cliente ${cliente.nombre}] ${hotmartFunnels.length} funnel(s) Hotmart configurados`)
            }
        }

        // Match SQL LIKE: % = .*, _ = .  case-insensitive
        function matchesAny(name: string, patterns: string[]): boolean {
            if (!patterns.length) return false
            const lower = name.toLowerCase()
            for (const p of patterns) {
                if (!p) continue
                if (!p.includes('%') && !p.includes('_')) {
                    if (lower === p) return true
                } else {
                    const regexStr = p
                        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                        .replace(/%/g, '.*')
                        .replace(/_/g, '.')
                    const re = new RegExp(`^${regexStr}$`, 'i')
                    if (re.test(lower)) return true
                }
            }
            return false
        }

        // ─── Helper: Fetch campaign targeting location from Meta ────────────────
        async function enrichCampaignsWithTargeting(campaigns: any[], token: string) {
            if (campaigns.length === 0) return campaigns
            try {
                // Batch fetch targeting for campaigns (limit 50 per batch to avoid rate limits)
                const batchSize = 50
                for (let i = 0; i < campaigns.length; i += batchSize) {
                    const batch = campaigns.slice(i, i + batchSize)
                    const requests = batch
                        .filter((c: any) => c.campaign_id)
                        .map((c: any, idx: number) => ({
                            method: 'GET',
                            relative_url: `${c.campaign_id}?fields=targeting`,
                            name: `req${idx}`
                        }))

                    if (requests.length === 0) continue

                    try {
                        const batchUrl = new URL(`https://graph.facebook.com/v19.0`)
                        const batchBody = new URLSearchParams()
                        batchBody.append('batch', JSON.stringify(requests))
                        batchBody.append('access_token', token)

                        const res = await fetch(batchUrl.toString(), {
                            method: 'POST',
                            body: batchBody
                        })
                        const batchResults = await res.json()

                        if (Array.isArray(batchResults)) {
                            batchResults.forEach((result: any, idx: number) => {
                                if (result.body) {
                                    try {
                                        const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body
                                        const campIdx = i + idx
                                        if (campaigns[campIdx] && parsed.targeting) {
                                            const geoLocations = parsed.targeting.geo_locations
                                            if (geoLocations && geoLocations.regions) {
                                                campaigns[campIdx].targeting_regions = geoLocations.regions
                                            }
                                        }
                                    } catch (e: any) {
                                        // Silent fail on parsing individual results
                                    }
                                }
                            })
                        }
                    } catch (err: any) {
                        log(`[Meta] Targeting enrichment batch error (non-critical): ${err.message}`)
                    }
                }
            } catch (err: any) {
                log(`[Meta] Targeting enrichment failed (non-critical): ${err.message}`)
            }
            return campaigns
        }

        // ─── Helper: Fetch Meta Ads for a single account+date ───────────────
        async function fetchMetaSingleAccount(targetDate: string, rawAccountId: string, token: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[] }
            try {
                const actId = rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                url.searchParams.append('access_token', token)
                url.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                url.searchParams.append('fields', 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions')
                url.searchParams.append('level', 'campaign')
                url.searchParams.append('limit', '500')

                const res = await fetch(url.toString())
                const data = await res.json()
                if (data.data) {
                    let totalSpend = 0, totalImpr = 0, totalClicks = 0
                    const campaignsArr: any[] = []

                    data.data.forEach((camp: any) => {
                        const cSpend = parseFloat(camp.spend || '0')
                        const cImpr = parseInt(camp.impressions || '0')
                        const cClicks = parseInt(camp.clicks || '0')
                        const cLinkClicks = parseInt(camp.inline_link_clicks || '0')
                        const cReach = parseInt(camp.reach || '0')
                        const cFrequency = parseFloat(camp.frequency || '0')
                        const cCpc = parseFloat(camp.cpc || '0')
                        const cCpm = parseFloat(camp.cpm || '0')
                        const cCtr = parseFloat(camp.ctr || '0')

                        let cLeads = 0, cLeadsForm = 0, cPurchases = 0, cAddsToCart = 0, cInitiatesCheckout = 0
                        let cLandingPageViews = 0, cVideoViews = 0, cVideoThruplay = 0, cVideo3s = 0, cResults = 0
                        let cCompleteRegistration = 0, cViewContent = 0, cSearch = 0, cAddToWishlist = 0
                        let cContact = 0, cSchedule = 0, cStartTrial = 0, cSubmitApplication = 0
                        let cSubscribe = 0, cFindLocation = 0, cCustomizeProduct = 0, cDonate = 0
                        let cMessagingConversations = 0
                        let cPageEngagement = 0, cPostEngagement = 0, cPostReactions = 0
                        let cPostShares = 0, cPostSaves = 0, cPostComments = 0
                        const cCustomConversions: Record<string, number> = {}
                        // Track native vs pixel separately to avoid double-counting.
                        // Meta reports both native and offsite_conversion.fb_pixel_* for pixel
                        // campaigns — they represent the same event. We take the max.
                        let cNativeLeads = 0, cPixelLeads = 0
                        let cNativePurchases = 0, cPixelPurchases = 0
                        let cNativeCompleteReg = 0, cPixelCompleteReg = 0

                        if (camp.actions) {
                            camp.actions.forEach((a: any) => {
                                const val = parseInt(a.value || '0')
                                const t = a.action_type || ''
                                // Leads: track native and pixel separately, resolved after loop
                                if (t === 'lead') cNativeLeads += val
                                if (t === 'offsite_conversion.fb_pixel_lead') cPixelLeads += val
                                // Purchases: track native and pixel separately, resolved after loop
                                if (t === 'purchase') cNativePurchases += val
                                if (t === 'offsite_conversion.fb_pixel_purchase') cPixelPurchases += val
                                // Registro completado: track native and pixel separately, resolved after loop
                                if (t === 'complete_registration') cNativeCompleteReg += val
                                if (t === 'offsite_conversion.fb_pixel_complete_registration') cPixelCompleteReg += val
                                // Carrito y checkout
                                if (t === 'offsite_conversion.fb_pixel_add_to_cart') cAddsToCart += val
                                if (t === 'offsite_conversion.fb_pixel_initiate_checkout') cInitiatesCheckout += val
                                // Landing page y video
                                if (t === 'landing_page_view') cLandingPageViews += val
                                if (t === 'video_view') cVideoViews += val
                                // Contenido y navegación
                                if (t === 'offsite_conversion.fb_pixel_view_content' || t === 'view_content') cViewContent += val
                                if (t === 'offsite_conversion.fb_pixel_search' || t === 'search') cSearch += val
                                if (t === 'offsite_conversion.fb_pixel_add_to_wishlist' || t === 'add_to_wishlist') cAddToWishlist += val
                                if (t === 'offsite_conversion.fb_pixel_customize_product' || t === 'customize_product') cCustomizeProduct += val
                                // Contacto y agenda
                                if (t === 'offsite_conversion.fb_pixel_contact' || t === 'contact') cContact += val
                                if (t === 'offsite_conversion.fb_pixel_schedule' || t === 'schedule') cSchedule += val
                                if (t === 'offsite_conversion.fb_pixel_start_trial' || t === 'start_trial') cStartTrial += val
                                if (t === 'offsite_conversion.fb_pixel_submit_application' || t === 'submit_application') cSubmitApplication += val
                                if (t === 'offsite_conversion.fb_pixel_subscribe' || t === 'subscribe') cSubscribe += val
                                if (t === 'offsite_conversion.fb_pixel_find_location' || t === 'find_location') cFindLocation += val
                                if (t === 'offsite_conversion.fb_pixel_donate' || t === 'donate') cDonate += val
                                // Mensajería
                                if (t === 'onsite_conversion.messaging_conversation_started_7d') cMessagingConversations += val
                                // Engagement
                                if (t === 'page_engagement') cPageEngagement += val
                                if (t === 'post_engagement') cPostEngagement += val
                                if (t === 'post_reaction') cPostReactions += val
                                if (t === 'post_share' || t === 'post') cPostShares += val
                                if (t === 'onsite_conversion.post_save') cPostSaves += val
                                if (t === 'comment') cPostComments += val
                            })
                        }

                        // Resolve leads/purchases: if both native and pixel are reported for the
                        // same campaign, they represent the same event — take the max to avoid doubling.
                        // If only one is non-zero, it's used as-is.
                        cLeads = (cNativeLeads > 0 && cPixelLeads > 0)
                            ? Math.max(cNativeLeads, cPixelLeads)
                            : cNativeLeads + cPixelLeads
                        // Form leads: only native Lead Ads form submissions (action_type = 'lead')
                        cLeadsForm = cNativeLeads
                        cPurchases = (cNativePurchases > 0 && cPixelPurchases > 0)
                            ? Math.max(cNativePurchases, cPixelPurchases)
                            : cNativePurchases + cPixelPurchases
                        cCompleteRegistration = (cNativeCompleteReg > 0 && cPixelCompleteReg > 0)
                            ? Math.max(cNativeCompleteReg, cPixelCompleteReg)
                            : cNativeCompleteReg + cPixelCompleteReg

                        // ThruPlay y vistas de 3s (campos separados en la respuesta de Meta)
                        if (camp.video_thruplay_watched_actions) {
                            camp.video_thruplay_watched_actions.forEach((a: any) => { cVideoThruplay += parseInt(a.value || '0') })
                        }
                        if (camp.video_p3_watched_actions) {
                            camp.video_p3_watched_actions.forEach((a: any) => { cVideo3s += parseInt(a.value || '0') })
                        }

                        if (camp.conversions) {
                            camp.conversions.forEach((cv: any) => {
                                const type: string = cv.action_type || ''
                                const val = parseInt(cv.value || '0')
                                if (type.startsWith('offsite_conversion.fb_pixel_custom.')) {
                                    const key = type.replace('offsite_conversion.fb_pixel_custom.', '').toLowerCase()
                                    cCustomConversions[key] = (cCustomConversions[key] || 0) + val
                                }
                            })
                        }

                        cResults = cLeads + cPurchases + cInitiatesCheckout

                        totalSpend += cSpend
                        totalImpr += cImpr
                        totalClicks += cClicks

                        campaignsArr.push({
                            campaign_id: camp.campaign_id || null,
                            account_id: rawAccountId,
                            name: camp.campaign_name || 'Desconocida',
                            // Entrega
                            spend: cSpend, impressions: cImpr, clicks: cClicks,
                            link_clicks: cLinkClicks, reach: cReach, frequency: cFrequency,
                            cpc: cCpc, cpm: cCpm, ctr: cCtr,
                            // Conversiones estándar
                            leads: cLeads, leads_form: cLeadsForm, purchases: cPurchases,
                            adds_to_cart: cAddsToCart, initiates_checkout: cInitiatesCheckout,
                            landing_page_views: cLandingPageViews,
                            complete_registration: cCompleteRegistration,
                            view_content: cViewContent, search: cSearch,
                            add_to_wishlist: cAddToWishlist, customize_product: cCustomizeProduct,
                            contact: cContact, schedule: cSchedule,
                            start_trial: cStartTrial, submit_application: cSubmitApplication,
                            subscribe: cSubscribe, find_location: cFindLocation, donate: cDonate,
                            // Video
                            video_views: cVideoViews, video_thruplay: cVideoThruplay, video_3s: cVideo3s,
                            // Mensajería
                            messaging_conversations: cMessagingConversations,
                            // Engagement
                            page_engagement: cPageEngagement, post_engagement: cPostEngagement,
                            post_reactions: cPostReactions, post_shares: cPostShares,
                            post_saves: cPostSaves, post_comments: cPostComments,
                            // Resultados y custom
                            results: cResults,
                            custom_conversions: cCustomConversions
                        })
                    })

                    // Dedup within this account by campaign_id (prevents API double-counting)
                    const dedupedWithin = new Map<string, any>()
                    for (const c of campaignsArr) {
                        const key = c.campaign_id || c.name
                        dedupedWithin.set(key, c)
                    }
                    const dedupedCampaigns = Array.from(dedupedWithin.values())
                    log(`[Meta] ${targetDate} [${rawAccountId}] Spend: ${totalSpend}, Campañas: ${dedupedCampaigns.length}`)
                    record.spend = totalSpend
                    record.impressions = totalImpr
                    record.clicks = totalClicks
                    record.campaigns = dedupedCampaigns

                    // Reach deduplicado a nivel de cuenta (una query separada con level=account)
                    try {
                        const reachUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                        reachUrl.searchParams.append('access_token', token)
                        reachUrl.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                        reachUrl.searchParams.append('fields', 'reach')
                        reachUrl.searchParams.append('level', 'account')
                        const reachRes = await fetch(reachUrl.toString())
                        const reachData = await reachRes.json()
                        if (reachData.data?.[0]?.reach) {
                            record.account_reach = parseInt(reachData.data[0].reach || '0')
                        }
                    } catch (_e) { /* non-critical */ }

                } else if (data.error) {
                    log(`[Meta] ${targetDate} [${rawAccountId}] Error de API: ${JSON.stringify(data.error)}`)
                } else {
                    log(`[Meta] ${targetDate} [${rawAccountId}] Sin datos.`)
                }
            } catch (e: any) {
                log(`[Meta] [${rawAccountId}] Catch Error: ${e.message}`)
            }
            return record
        }

        // ─── Helper: Fetch Meta Ads for a single date (multi-account) ────────
        async function fetchMeta(targetDate: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[] }

            // Build account list — multi-account if configured, legacy fallback otherwise
            let accountsToFetch: { account_id: string; token: string }[] = []
            if (config.meta_accounts && Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) {
                accountsToFetch = config.meta_accounts
                    .filter((a: any) => a.account_id)
                    .map((a: any) => ({ account_id: a.account_id, token: a.token || config.meta_token || '' }))
            } else if (config.meta_token && config.meta_account_id) {
                accountsToFetch = [{ account_id: config.meta_account_id, token: config.meta_token }]
            }

            if (accountsToFetch.length === 0) {
                log(`[Meta] Sin config para el cliente.`)
                return record
            }

            // Fetch all accounts in parallel for this date
            const accountResults = await Promise.all(
                accountsToFetch.map(({ account_id, token }) => fetchMetaSingleAccount(targetDate, account_id, token))
            )

            // Merge results from all accounts
            let anySuccess = false
            for (const r of accountResults) {
                record.spend += r.spend
                record.impressions += r.impressions
                record.clicks += r.clicks
                record.account_reach += r.account_reach  // suma de reach deduplicado por cuenta
                // Inyectar account_reach en cada campaña para poder filtrarlo en el dashboard
                const campaignsWithReach = r.campaigns.map((c: any) => ({
                    ...c,
                    account_reach: r.account_reach,
                }))
                record.campaigns.push(...campaignsWithReach)
                if (r.campaigns.length > 0 || r.spend > 0) anySuccess = true
            }

            // Dedup across accounts: campaign_ids are globally unique in Meta
            if (accountsToFetch.length > 1 && record.campaigns.length > 0) {
                const crossDedup = new Map<string, any>()
                for (const c of record.campaigns) {
                    const key = c.campaign_id || `${c.account_id}:${c.name}`
                    crossDedup.set(key, c)
                }
                record.campaigns = Array.from(crossDedup.values())
            }

            // Enrich campaigns with targeting location data (non-blocking)
            if (record.campaigns.length > 0 && accountsToFetch.length > 0) {
                const primaryToken = accountsToFetch[0]?.token || config.meta_token || ''
                if (primaryToken) {
                    record.campaigns = await enrichCampaignsWithTargeting(record.campaigns, primaryToken)
                }
            }

            platformLogs.meta = anySuccess ? 'Conectado OK' : 'Sin Datos'
            log(`[Meta] ${targetDate} Total consolidado — Spend: ${record.spend.toFixed(2)}, Campañas: ${record.campaigns.length}`)

            // Auto-discover custom conversions → upsert into catalog
            const allCustomKeys = new Set<string>()
            record.campaigns.forEach((camp: any) => {
                if (camp.custom_conversions) {
                    Object.keys(camp.custom_conversions).forEach(k => allCustomKeys.add(k))
                }
            })

            if (allCustomKeys.size > 0) {
                const catalogRows = Array.from(allCustomKeys).map((key) => {
                    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
                    return {
                        cliente_id: cliente.id,
                        conversion_key: key,
                        label: `Lead ${label.replace('Lead', '').trim() || label}`,
                        field_id: `meta_custom_${key}`,
                        last_seen: targetDate,
                    }
                })

                const { error: catErr } = await adminSupabase
                    .from('meta_conversiones_catalogo')
                    .upsert(catalogRows, { onConflict: 'cliente_id,conversion_key', ignoreDuplicates: false })

                if (catErr) {
                    log(`[Meta] ⚠️ Error actualizando catálogo: ${catErr.message}`)
                } else {
                    log(`[Meta] ✓ Catálogo actualizado: ${Array.from(allCustomKeys).join(', ')}`)
                }
            }

            return record
        }

        // ─── Helper: Fetch Hotmart for a single date ────────────────────────
        // Devuelve totales globales + desglose por funnel (tab) + extras.
        // Pagos iniciados se mide desde GA4 (no se consulta WAITING_PAYMENT).
        type FunnelBreakdown = {
            principal: { count: number; gross: number; net: number }
            bump:      { count: number; gross: number; net: number }
            upsell:    { count: number; gross: number; net: number; page_visits: number }
            pagos_iniciados: number
            landing_sessions: number
        }
        type HotmartRecord = {
            // Totales globales (suma de todos los funnels + extras)
            principal: number          // neto producto principal
            bump: number               // neto bump
            upsell: number             // neto upsell
            principal_count: number
            bump_count: number
            upsell_count: number
            principal_bruto: number    // bruto producto principal
            bump_bruto: number         // bruto order bump
            upsell_bruto: number       // bruto upsell
            ventas_count: number       // total transacciones procesadas
            // Desglose JSON
            by_tab: Record<string, FunnelBreakdown>
            extras: Array<{ product_name: string; count: number; gross: number; net: number }>
        }
        function emptyFunnelBreakdown(): FunnelBreakdown {
            return {
                principal: { count: 0, gross: 0, net: 0 },
                bump:      { count: 0, gross: 0, net: 0 },
                upsell:    { count: 0, gross: 0, net: 0, page_visits: 0 },
                pagos_iniciados: 0,
                landing_sessions: 0,
            }
        }

        async function fetchHotmart(targetDate: string): Promise<HotmartRecord> {
            const record: HotmartRecord = {
                principal: 0, bump: 0, upsell: 0,
                principal_count: 0, bump_count: 0, upsell_count: 0,
                principal_bruto: 0, bump_bruto: 0, upsell_bruto: 0, ventas_count: 0,
                by_tab: {},
                extras: [],
            }
            // Inicializar breakdown por cada funnel configurado
            for (const f of hotmartFunnels) {
                record.by_tab[f.tab_id] = emptyFunnelBreakdown()
            }

            if (!hotmartAccessToken) {
                log(`[Hotmart] Sin accessToken generado.`)
                return record
            }
            try {
                const dayStart = new Date(`${targetDate}T00:00:00.000-05:00`).getTime()
                const dayEnd = new Date(`${targetDate}T23:59:59.999-05:00`).getTime()

                // PASO 1: Transacciones válidas aprobadas + capturar gross (purchase.price.value)
                let pageToken = ""
                let hasNext = true
                // transaction_id → { gross_value, currency }
                const txInfo = new Map<string, { gross: number; currency: string }>()

                while (hasNext) {
                    const url = new URL('https://developers.hotmart.com/payments/api/v1/sales/history')
                    url.searchParams.append('start_date', dayStart.toString())
                    url.searchParams.append('end_date', dayEnd.toString())
                    url.searchParams.append('max_results', '100')
                    url.searchParams.append('transaction_status', 'APPROVED')
                    url.searchParams.append('transaction_status', 'COMPLETE')
                    if (pageToken) url.searchParams.append('page_token', pageToken)

                    const res = await fetch(url.toString(), {
                        headers: { 'Authorization': `Bearer ${hotmartAccessToken}` }
                    })
                    const data = await res.json()

                    if (data.error || data.message) {
                        log(`[Hotmart] ${targetDate} API Error on History: ${JSON.stringify(data)}`)
                        hasNext = false
                        platformLogs.hotmart = 'Error API'
                        break
                    }

                    if (data.items) {
                        data.items.forEach((item: any) => {
                            const txId = item.purchase?.transaction
                            if (txId) {
                                const grossVal = Number(item.purchase?.price?.value ?? 0) || 0
                                const grossCur = String(item.purchase?.price?.currency_code ?? '')
                                txInfo.set(txId, { gross: grossVal, currency: grossCur })
                            }
                        })
                    }
                    pageToken = data.page_info?.next_page_token
                    hasNext = !!pageToken
                }

                // PASO 2: Comisiones exactas (USD) de transacciones validadas + clasificar por funnel
                pageToken = ""
                hasNext = true
                let totalItemsProcessed = 0

                // Acumulador temporal de extras: productName → {count, gross, net}
                const extrasMap = new Map<string, { count: number; gross: number; net: number }>()

                while (hasNext) {
                    const url2 = new URL('https://developers.hotmart.com/payments/api/v1/sales/commissions')
                    url2.searchParams.append('start_date', dayStart.toString())
                    url2.searchParams.append('end_date', dayEnd.toString())
                    url2.searchParams.append('max_results', '100')
                    if (pageToken) url2.searchParams.append('page_token', pageToken)

                    const res2 = await fetch(url2.toString(), {
                        headers: { 'Authorization': `Bearer ${hotmartAccessToken}` }
                    })
                    const data2 = await res2.json()

                    if (data2.items) {
                        data2.items.forEach((item: any) => {
                            const tx = item.transaction
                            if (!txInfo.has(tx)) return
                            totalItemsProcessed++
                            record.ventas_count++

                            let netUSD = 0
                            if (item.commissions && Array.isArray(item.commissions)) {
                                item.commissions.forEach((c: any) => {
                                    if (c.source === 'PRODUCER' && c.commission?.currency_code === 'USD') {
                                        netUSD += c.commission.value
                                    }
                                })
                            }

                            const prodName = String(item.product?.name || '').trim()
                            const txMeta = txInfo.get(tx)!
                            const grossVal = txMeta.currency === 'USD' ? txMeta.gross : 0

                            // Buscar a qué funnel pertenece este producto y en qué rol
                            let matched = false
                            for (const f of hotmartFunnels) {
                                if (matchesAny(prodName, f.principal_patterns)) {
                                    // Bruto: si hay precio configurado, usar precio × 1; si no, caer al valor de la API (solo USD)
                                    const principalGross = f.principal_price_usd ?? grossVal
                                    record.by_tab[f.tab_id].principal.count++
                                    record.by_tab[f.tab_id].principal.net   += netUSD
                                    record.by_tab[f.tab_id].principal.gross += principalGross
                                    record.principal       += netUSD
                                    record.principal_count += 1
                                    record.principal_bruto += principalGross
                                    matched = true
                                    break
                                }
                                if (matchesAny(prodName, f.bump_patterns)) {
                                    record.by_tab[f.tab_id].bump.count++
                                    record.by_tab[f.tab_id].bump.net   += netUSD
                                    record.by_tab[f.tab_id].bump.gross += grossVal
                                    record.bump       += netUSD
                                    record.bump_count += 1
                                    record.bump_bruto += grossVal
                                    matched = true
                                    break
                                }
                                if (matchesAny(prodName, f.upsell_patterns)) {
                                    record.by_tab[f.tab_id].upsell.count++
                                    record.by_tab[f.tab_id].upsell.net   += netUSD
                                    record.by_tab[f.tab_id].upsell.gross += grossVal
                                    record.upsell        += netUSD
                                    record.upsell_count  += 1
                                    record.upsell_bruto  += grossVal
                                    matched = true
                                    break
                                }
                            }

                            if (!matched) {
                                // Producto extra → acumular en extras
                                const key = prodName || '(Sin nombre)'
                                const cur = extrasMap.get(key) || { count: 0, gross: 0, net: 0 }
                                cur.count += 1
                                cur.net   += netUSD
                                cur.gross += grossVal
                                extrasMap.set(key, cur)
                            }
                        })
                    }
                    pageToken = data2.page_info?.next_page_token
                    hasNext = !!pageToken
                }

                // Volcar extras del map al array final
                for (const [product_name, vals] of extrasMap.entries()) {
                    record.extras.push({ product_name, ...vals })
                }

                log(`[Hotmart] ${targetDate} Procesados ${totalItemsProcessed} reg. Funnels: ${hotmartFunnels.length}, Extras: ${record.extras.length}, Principal USD: ${record.principal.toFixed(2)}, Bruto: ${record.principal_bruto.toFixed(2)}`)
                platformLogs.hotmart = 'Conectado OK'
            } catch (e: any) {
                log(`[Hotmart] Catch Error: ${e.message}`)
                platformLogs.hotmart = 'Error'
            }
            return record
        }

        // ─── Fetch GA4 ───
        // Devuelve métricas globales + page views por funnel (payment_page + upsell_page).
        type GARecord = {
            sessions: number
            bounceRate: number
            avgSessionDuration: number
            // Por tab_id: { payment_page_views, upsell_page_views, landing_sessions }
            funnel_pages: Record<string, { payment_page_views: number; upsell_page_views: number; landing_sessions: number }>
        }
        async function fetchGA4(targetDate: string): Promise<GARecord> {
            const record: GARecord = { sessions: 0, bounceRate: 0, avgSessionDuration: 0, funnel_pages: {} }
            if (!config.ga_property_id || !config.ga_client_email || !config.ga_private_key) {
                platformLogs.ga4 = 'Sin configurar'
                return record
            }

            try {
                const { BetaAnalyticsDataClient } = await import('@google-analytics/data')
                const client = new BetaAnalyticsDataClient({
                    credentials: {
                        client_email: config.ga_client_email,
                        private_key: config.ga_private_key.replace(/\\n/g, '\n'),
                    }
                })

                const propertyName = config.ga_property_id.startsWith('properties/')
                    ? config.ga_property_id
                    : `properties/${config.ga_property_id}`

                const [response] = await client.runReport({
                    property: propertyName,
                    dateRanges: [{ startDate: targetDate, endDate: targetDate }],
                    metrics: [
                        { name: 'sessions' },
                        { name: 'bounceRate' },
                        { name: 'averageSessionDuration' },
                    ],
                })

                if (response.rows?.[0]) {
                    const vals = response.rows[0].metricValues || []
                    record.sessions = parseInt(vals[0]?.value || '0')
                    record.bounceRate = parseFloat(vals[1]?.value || '0')
                    record.avgSessionDuration = parseFloat(vals[2]?.value || '0')
                }

                // ─── Page views por funnel (payment + upsell) ──────────────
                // Recolectar todas las URLs únicas a consultar, mapeadas a su tab+rol
                type PageQuery = { url: string; tab_id: string; role: 'payment' | 'upsell' | 'landing' }
                const queries: PageQuery[] = []
                for (const f of hotmartFunnels) {
                    for (const url of f.landing_page_urls) queries.push({ url, tab_id: f.tab_id, role: 'landing' })
                    if (f.payment_page_url) queries.push({ url: f.payment_page_url, tab_id: f.tab_id, role: 'payment' })
                    if (f.upsell_page_url)  queries.push({ url: f.upsell_page_url,  tab_id: f.tab_id, role: 'upsell'  })
                    record.funnel_pages[f.tab_id] = { payment_page_views: 0, upsell_page_views: 0, landing_sessions: 0 }
                }

                if (queries.length > 0) {
                    // Separar por rol y por tipo de filtro (path vs título)
                    const landingQueries  = queries.filter(q => q.role === 'landing')
                    const pageviewQueries = queries.filter(q => q.role !== 'landing')

                    // Helper: GA4 query genérica
                    const ga4Query = async (dimension: string, metric: string, values: string[]) => {
                        const [resp] = await client.runReport({
                            property: propertyName,
                            dateRanges: [{ startDate: targetDate, endDate: targetDate }],
                            dimensions: [{ name: dimension }],
                            metrics: [{ name: metric }],
                            dimensionFilter: {
                                filter: {
                                    fieldName: dimension,
                                    inListFilter: { values, caseSensitive: false }
                                }
                            }
                        })
                        const map = new Map<string, number>()
                        for (const row of (resp.rows || [])) {
                            const key = row.dimensionValues?.[0]?.value || ''
                            const v = parseInt(row.metricValues?.[0]?.value || '0')
                            map.set(key, (map.get(key) || 0) + v)
                        }
                        return map
                    }

                    // ── Landing page views (screenPageViews, igual que el informe de Páginas de GA4) ──
                    // path → pagePath + screenPageViews
                    // título → pageTitle + screenPageViews
                    const landingByPath  = new Map<string, number>()
                    const landingByTitle = new Map<string, number>()
                    const landingPathVals  = Array.from(new Set(landingQueries.filter(q => q.url.startsWith('/')).map(q => q.url)))
                    const landingTitleVals = Array.from(new Set(landingQueries.filter(q => !q.url.startsWith('/')).map(q => q.url)))
                    if (landingPathVals.length > 0) {
                        const m = await ga4Query('pagePath', 'screenPageViews', landingPathVals)
                        m.forEach((v, k) => landingByPath.set(k, v))
                    }
                    if (landingTitleVals.length > 0) {
                        const m = await ga4Query('pageTitle', 'screenPageViews', landingTitleVals)
                        m.forEach((v, k) => landingByTitle.set(k, v))
                    }

                    // ── Pageviews para payment / upsell ──
                    const viewsByPath  = new Map<string, number>()
                    const viewsByTitle = new Map<string, number>()
                    const pvPathVals   = Array.from(new Set(pageviewQueries.filter(q => q.url.startsWith('/')).map(q => q.url)))
                    const pvTitleVals  = Array.from(new Set(pageviewQueries.filter(q => !q.url.startsWith('/')).map(q => q.url)))
                    if (pvPathVals.length > 0) {
                        const m = await ga4Query('pagePath', 'screenPageViews', pvPathVals)
                        m.forEach((v, k) => viewsByPath.set(k, v))
                    }
                    if (pvTitleVals.length > 0) {
                        const m = await ga4Query('pageTitle', 'screenPageViews', pvTitleVals)
                        m.forEach((v, k) => viewsByTitle.set(k, v))
                    }

                    // Asignar a cada funnel/rol
                    for (const q of queries) {
                        if (q.role === 'landing') {
                            const map = q.url.startsWith('/') ? landingByPath : landingByTitle
                            record.funnel_pages[q.tab_id].landing_sessions += map.get(q.url) || 0
                        } else if (q.role === 'payment') {
                            const map = q.url.startsWith('/') ? viewsByPath : viewsByTitle
                            record.funnel_pages[q.tab_id].payment_page_views = map.get(q.url) || 0
                        } else {
                            const map = q.url.startsWith('/') ? viewsByPath : viewsByTitle
                            record.funnel_pages[q.tab_id].upsell_page_views = map.get(q.url) || 0
                        }
                    }
                }

                platformLogs.ga4 = 'Conectado OK'
            } catch (e: any) {
                log(`[GA4] Error: ${e.message}`)
                platformLogs.ga4 = 'Error'
            }

            return record
        }

        // ─── Pre-fetch existing sync hashes for idempotency ───
        const { data: existingHashRows } = await adminSupabase
            .from('metricas_diarias')
            .select('fecha, sync_hash')
            .eq('cliente_id', cliente.id)
            .in('fecha', datesToSync)
        const existingHashMap = new Map<string, string>(
            (existingHashRows || []).map((r: any) => [r.fecha, r.sync_hash])
        )

        // ─── Process all dates: chunked in parallel (Batching) ───
        const CHUNK_SIZE = 5; // Procesamos 5 días totalmente en paralelo a la vez para no saturar APIs
        const upsertPayloads: any[] = [];
        
        for (let i = 0; i < datesToSync.length; i += CHUNK_SIZE) {
            const chunk = datesToSync.slice(i, i + CHUNK_SIZE);
            log(`[Batch] Procesando chunk de fechas en paralelo: ${chunk.join(', ')}`);
            
            const chunkResults = await Promise.all(
                chunk.map(async (targetDate) => {
                    // Fetch Meta, Hotmart and GA4 in parallel for this specific date
                    const [metaRecord, hotmartRecord, gaRecord] = await Promise.all([
                        fetchMeta(targetDate),
                        fetchHotmart(targetDate),
                        fetchGA4(targetDate),
                    ]);
                    
                    return { targetDate, metaRecord, hotmartRecord, gaRecord };
                })
            );
            
            // Collect the results for the mass upsert list
            for (const res of chunkResults) {
                const { targetDate, metaRecord, hotmartRecord, gaRecord } = res;

                // Guard: skip empty Meta responses for dates older than 2 days
                // (prevents overwriting good data with stale empty API responses)
                const daysAgo = differenceInDays(new Date(), parseISO(targetDate))
                const isEmptyMeta = metaRecord.campaigns.length === 0 && metaRecord.spend === 0
                const isAllEmpty = isEmptyMeta && hotmartRecord.principal === 0 && hotmartRecord.ventas_count === 0 && gaRecord.sessions === 0
                if (isAllEmpty && daysAgo > 2 && existingHashMap.has(targetDate)) {
                    log(`[DB] Saltando ${targetDate} — respuesta vacía para fecha histórica con datos existentes`)
                    results.push({ cliente_id: cliente.id, date: targetDate, status: 'skipped_empty', platform_status: { ...platformLogs } } as any)
                    continue
                }

                // ─── Merge funnel breakdown: Hotmart sales + GA4 page views per tab ───
                // Total pagos_iniciados (suma de payment_page_views de todos los funnels)
                let totalPagosIniciados = 0
                const byTabFinal: Record<string, any> = {}
                for (const tabId of Object.keys(hotmartRecord.by_tab)) {
                    const fb = hotmartRecord.by_tab[tabId]
                    const gp = gaRecord.funnel_pages[tabId] || { payment_page_views: 0, upsell_page_views: 0, landing_sessions: 0 }
                    fb.upsell.page_visits = gp.upsell_page_views
                    fb.pagos_iniciados = gp.payment_page_views
                    fb.landing_sessions = gp.landing_sessions
                    totalPagosIniciados += gp.payment_page_views
                    byTabFinal[tabId] = fb
                }
                const funnelDataPayload = {
                    by_tab: byTabFinal,
                    extras: hotmartRecord.extras,
                }

                // Compute payload hash for idempotency
                const hashPayload = { meta: metaRecord, hotmart: hotmartRecord, ga: gaRecord }
                const payloadHash = computeSyncHash(hashPayload)
                if (existingHashMap.get(targetDate) === payloadHash) {
                    log(`[DB] Saltando ${targetDate} — sync_hash sin cambios`)
                    results.push({ cliente_id: cliente.id, date: targetDate, status: 'skipped_hash', platform_status: { ...platformLogs } } as any)
                    continue
                }

                upsertPayloads.push({
                    cliente_id: cliente.id,
                    fecha: targetDate,
                    sync_hash: payloadHash,
                    meta_spend: metaRecord.spend,
                    meta_impressions: metaRecord.impressions,
                    meta_clicks: metaRecord.clicks,
                    meta_campaigns: metaRecord.campaigns,
                    // Hotmart totales globales (suma de funnels + extras)
                    ventas_principal: hotmartRecord.principal,
                    ventas_bump: hotmartRecord.bump,
                    ventas_upsell: hotmartRecord.upsell,
                    ventas_principal_count: hotmartRecord.principal_count,
                    ventas_bump_count: hotmartRecord.bump_count,
                    ventas_upsell_count: hotmartRecord.upsell_count,
                    ventas_principal_bruto: hotmartRecord.principal_bruto,
                    ventas_bump_bruto: hotmartRecord.bump_bruto,
                    ventas_upsell_bruto: hotmartRecord.upsell_bruto,
                    // Pagos iniciados ahora viene de GA4 (suma de payment_page_views por funnel)
                    hotmart_pagos_iniciados: totalPagosIniciados,
                    // Desglose granular por funnel
                    hotmart_funnel_data: funnelDataPayload,
                    ga_sessions: gaRecord.sessions,
                    ga_bounce_rate: gaRecord.bounceRate,
                    ga_avg_session_duration: gaRecord.avgSessionDuration
                });

                results.push({
                    cliente_id: cliente.id,
                    date: targetDate,
                    localLog: `Principal: ${hotmartRecord.principal} (${hotmartRecord.principal_count}), Bump: ${hotmartRecord.bump} (${hotmartRecord.bump_count}), Upsell: ${hotmartRecord.upsell} (${hotmartRecord.upsell_count}), Bruto: ${hotmartRecord.principal_bruto}, Pagos: ${totalPagosIniciados}`,
                    platform_status: { ...platformLogs }
                } as any);
            }
        }
        
        // ─── Mass Upsert into Supabase (1 Single Database Query per Client!) ───
        if (upsertPayloads.length > 0) {
            log(`[DB] Ejecutando Mass Upsert de ${upsertPayloads.length} días de golpe para el cliente ${cliente.nombre}...`);
            const { error: batchError } = await adminSupabase
                .from('metricas_diarias')
                .upsert(upsertPayloads, { onConflict: 'cliente_id, fecha' });
            
            if (batchError) {
                log(`[DB] ❌ Error en Mass Upsert: ${batchError.message}`);
                results.forEach((r: any) => { if (r.cliente_id === cliente.id) r.status = 'failed' });
            } else {
                log(`[DB] ✓ Mass Upsert exitoso. ${upsertPayloads.length} filas actualizadas/insertadas procesadas rapidísimo.`);
                results.forEach((r: any) => { if (r.cliente_id === cliente.id) r.status = 'ok' });
            }
        }
    }

    return NextResponse.json({ message: 'Sync complete', results, debugLogs })
}