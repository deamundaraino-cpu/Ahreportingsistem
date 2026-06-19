import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { format, parseISO, isBefore, addDays, differenceInDays } from 'date-fns'
import { createClient as createSSRClient } from '@/utils/supabase/server'
import { getAgencyAccessToken, hasAgencyGoogleConnection } from '@/lib/integrations/google-auth'
import { notifyUsers } from '@/lib/notifications/notify'
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils'
import { metaFetch, tiktokFetch, hotmartFetch, ga4Run, setRetryDeadline } from '@/lib/rate-limit'

export const maxDuration = 300 // 5 minutos — necesario para sincronizar rangos amplios

/**
 * Memoiza por clave con valor Promise; si la promesa falla, limpia la entrada
 * para no cachear un fallo transitorio (permite reintento en una fecha posterior).
 * Se usa para cargar catálogos/nombres (que NO cambian por día) UNA sola vez por
 * rango en lugar de una vez por cada fecha.
 */
function memo<K, V>(cache: Map<K, Promise<V>>, key: K, factory: () => Promise<V>): Promise<V> {
    let p = cache.get(key)
    if (!p) {
        p = factory().catch((e) => { cache.delete(key); throw e })
        cache.set(key, p)
    }
    return p
}

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

    // Presupuesto de tiempo para reintentos: no reintentar pasado este momento
    // (maxDuration=300s; dejamos margen para upserts y respuesta final).
    setRetryDeadline(Date.now() + 270_000)

    const { searchParams } = new URL(request.url)
    const singleDate = searchParams.get('date')
    // Por defecto sincroniza "ayer" en hora Colombia (UTC-5), no en UTC del servidor.
    const startDateStr = singleDate || searchParams.get('start') || colombiaYesterday()
    const endDateStr = singleDate || searchParams.get('end') || startDateStr
    const specificClientId = searchParams.get('client_id')

    let query = adminSupabase.from('clientes').select('*')
    if (specificClientId) {
        query = query.eq('id', specificClientId)
    }

    const { data: clientes, error } = await query
    if (error || !clientes) return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 })

    const results: any[] = []

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

    // Procesar todos los clientes en paralelo — reduce tiempo total de N×T a T (el cliente más lento)
    await Promise.all(clientes.map(async (cliente: any) => {
        const config = cliente.config_api as any
        if (!config) return

        const platformLogs = { meta: 'Saltado', tiktok: 'Saltado', hotmart: 'Saltado', ga4: 'Saltado' }

        // ─── Cachés por-cliente para lookups independientes de la fecha ───
        // Se cargan UNA vez por rango (no por día). Valor Promise → fechas
        // concurrentes deduplican la misma carga.
        const tiktokNameCache = new Map<string, Promise<{ campaigns: Map<string, string>; ads: Map<string, string>; adgroups: Map<string, string> }>>() // key: advertiserId
        const metaFormCatalogCache = new Map<string, Promise<Map<string, string>>>() // key: actId → (formId → name)
        const metaTargetingCache = new Map<string, Promise<Map<string, any[]>>>() // key: actId → (campaignId → regions)

        let hotmartAccessToken: string | null = null
        if (config.hotmart_auth_mode === 'hotconnect') {
            // ─── Modo HotConnect (OAuth authorization_code) ──────────────────────
            // Usa el access_token guardado; si venció (o falta), lo refresca con el refresh_token.
            const expiresMs = config.hotmart_token_expires_at ? new Date(config.hotmart_token_expires_at).getTime() : 0
            const isExpired = !config.hotmart_access_token || !expiresMs || Number.isNaN(expiresMs) || expiresMs - Date.now() < 60_000
            if (!isExpired) {
                hotmartAccessToken = config.hotmart_access_token
                platformLogs.hotmart = 'Preparado'
            } else if (config.hotmart_refresh_token && process.env.HOTMART_APP_CLIENT_ID && process.env.HOTMART_APP_CLIENT_SECRET) {
                try {
                    const params = new URLSearchParams()
                    params.set('grant_type', 'refresh_token')
                    params.set('client_id', process.env.HOTMART_APP_CLIENT_ID)
                    params.set('client_secret', process.env.HOTMART_APP_CLIENT_SECRET)
                    params.set('refresh_token', config.hotmart_refresh_token)
                    const tokenRes = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: params.toString(),
                    })
                    const tokenData = await tokenRes.json()
                    if (tokenData.access_token) {
                        hotmartAccessToken = tokenData.access_token
                        const expiresIn = tokenData.expires_in ?? 6 * 60 * 60
                        // Persistir el token refrescado para que el cron/UI lo reflejen.
                        await adminSupabase.from('clientes').update({
                            config_api: {
                                ...config,
                                hotmart_access_token: tokenData.access_token,
                                hotmart_refresh_token: tokenData.refresh_token ?? config.hotmart_refresh_token,
                                hotmart_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
                                hotmart_connection_status: 'connected',
                            },
                        }).eq('id', cliente.id)
                        log(`[Cliente ${cliente.nombre}] Token de Hotmart (HotConnect) refrescado.`)
                        platformLogs.hotmart = 'Preparado'
                    } else {
                        log(`[Cliente ${cliente.nombre}] Error refrescando token HotConnect: ${JSON.stringify(tokenData)}`)
                        platformLogs.hotmart = 'Error Auth'
                    }
                } catch (err: any) {
                    log(`[Cliente ${cliente.nombre}] Catch Refresh HotConnect: ${err.message}`)
                    platformLogs.hotmart = 'Fallo Critico'
                }
            } else {
                log(`[Cliente ${cliente.nombre}] HotConnect sin refresh_token o app no configurada.`)
                platformLogs.hotmart = 'Error Auth'
            }
        } else {
            // ─── Modo "pegar credenciales" (Basic / client_credentials) ──────────
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

        // ─── Snapshot de suscripciones Hotmart (estado actual, 1 vez por cliente) ──
        // Las suscripciones son un estado actual (no por día) → tabla aparte.
        // Captura un snapshot para la fecha de hoy: conteos por estado + valor
        // recurrente de las ACTIVE. Idempotente vía upsert (cliente_id, captured_date).
        if (hotmartAccessToken) {
            try {
                const STATUS_GROUP: Record<string, 'active' | 'delayed' | 'inactive' | 'canceled'> = {
                    ACTIVE: 'active',
                    DELAYED: 'delayed', OVERDUE: 'delayed',
                    INACTIVE: 'inactive', STARTED: 'inactive',
                    CANCELLED_BY_CUSTOMER: 'canceled', CANCELLED_BY_SELLER: 'canceled', CANCELLED_BY_ADMIN: 'canceled',
                }
                const byStatus: Record<string, number> = {}
                const byProduct: Record<string, { active: number; recurring_value: number }> = {}
                let active = 0, delayed = 0, inactive = 0, canceled = 0, total = 0
                let activeRecurringValue = 0
                let currency = ''

                let pageToken = ''
                let hasNext = true
                let pages = 0
                const MAX_PAGES = 100 // tope de seguridad: 100 × 100 = 10k suscripciones
                while (hasNext && pages < MAX_PAGES) {
                    pages++
                    const url = new URL('https://developers.hotmart.com/payments/api/v1/subscriptions')
                    url.searchParams.append('max_results', '100')
                    if (pageToken) url.searchParams.append('page_token', pageToken)

                    const res = await hotmartFetch(url.toString(), {
                        headers: { 'Authorization': `Bearer ${hotmartAccessToken}` }
                    })
                    const data = await res.json()
                    if (data.error || data.message) {
                        log(`[Hotmart Subs] API Error: ${JSON.stringify(data)}`)
                        break
                    }
                    const items: any[] = Array.isArray(data.items) ? data.items : []
                    for (const it of items) {
                        total++
                        const status = String(it.status || '').toUpperCase()
                        byStatus[status] = (byStatus[status] || 0) + 1
                        const group = STATUS_GROUP[status]
                        if (group === 'active') active++
                        else if (group === 'delayed') delayed++
                        else if (group === 'inactive') inactive++
                        else if (group === 'canceled') canceled++

                        const prodName = String(it.product?.name || it.plan?.name || '(Sin nombre)').trim()
                        if (!byProduct[prodName]) byProduct[prodName] = { active: 0, recurring_value: 0 }
                        if (group === 'active') {
                            const val = Number(it.price?.value ?? it.plan?.recurrency_value ?? 0) || 0
                            const cur = String(it.price?.currency_code ?? '')
                            if (cur && !currency) currency = cur
                            activeRecurringValue += val
                            byProduct[prodName].active++
                            byProduct[prodName].recurring_value += val
                        }
                    }
                    pageToken = data.page_info?.next_page_token
                    hasNext = !!pageToken
                }
                if (pages >= MAX_PAGES && hasNext) {
                    log(`[Hotmart Subs] ${cliente.nombre}: alcanzado el tope de ${MAX_PAGES} páginas — snapshot puede estar incompleto.`)
                }

                const capturedDate = colombiaToday()
                await adminSupabase.from('hotmart_subscriptions_snapshot').upsert({
                    cliente_id: cliente.id,
                    captured_date: capturedDate,
                    captured_at: new Date().toISOString(),
                    active_count: active,
                    delayed_count: delayed,
                    inactive_count: inactive,
                    canceled_count: canceled,
                    total_count: total,
                    active_recurring_value: activeRecurringValue,
                    currency: currency || null,
                    by_status: byStatus,
                    by_product: byProduct,
                }, { onConflict: 'cliente_id, captured_date' })
                log(`[Hotmart Subs] ${cliente.nombre}: ${active} activas, ${delayed} atrasadas, ${canceled} canceladas (total ${total}).`)
            } catch (e: any) {
                log(`[Hotmart Subs] Catch: ${e.message}`)
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
        // El targeting es independiente de la fecha → se cachea por cuenta (actId)
        // y solo se piden las campañas aún no cacheadas. Los batches corren en
        // paralelo (acotados por el pool de Meta).
        async function enrichCampaignsWithTargeting(campaigns: any[], token: string, actId: string) {
            if (campaigns.length === 0) return campaigns
            try {
                const cache = await memo(metaTargetingCache, actId, async () => new Map<string, any[]>())

                // Campañas con id que aún no tenemos en caché (deduplicadas por id)
                const missing = Array.from(
                    new Map(
                        campaigns
                            .filter((c: any) => c.campaign_id && !cache.has(c.campaign_id))
                            .map((c: any) => [c.campaign_id, c])
                    ).values()
                )

                const batchSize = 50
                const batches: any[][] = []
                for (let i = 0; i < missing.length; i += batchSize) {
                    batches.push(missing.slice(i, i + batchSize))
                }

                await Promise.all(batches.map(async (batch) => {
                    const requests = batch.map((c: any, idx: number) => ({
                        method: 'GET',
                        relative_url: `${c.campaign_id}?fields=targeting`,
                        name: `req${idx}`,
                    }))
                    if (requests.length === 0) return
                    try {
                        const batchBody = new URLSearchParams()
                        batchBody.append('batch', JSON.stringify(requests))
                        batchBody.append('access_token', token)

                        const res = await metaFetch('https://graph.facebook.com/v19.0', {
                            method: 'POST',
                            body: batchBody,
                        })
                        const batchResults = await res.json()

                        if (Array.isArray(batchResults)) {
                            batchResults.forEach((result: any, idx: number) => {
                                const camp = batch[idx]
                                if (result?.body && camp?.campaign_id) {
                                    try {
                                        const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body
                                        const regions = parsed?.targeting?.geo_locations?.regions
                                        if (regions) cache.set(camp.campaign_id, regions)
                                    } catch {
                                        // Silent fail on parsing individual results
                                    }
                                }
                            })
                        }
                    } catch (err: any) {
                        log(`[Meta] Targeting enrichment batch error (non-critical): ${err.message}`)
                    }
                }))

                // Aplicar la caché a todas las campañas del rango
                for (const c of campaigns) {
                    if (c.campaign_id && cache.has(c.campaign_id)) {
                        c.targeting_regions = cache.get(c.campaign_id)
                    }
                }
            } catch (err: any) {
                log(`[Meta] Targeting enrichment failed (non-critical): ${err.message}`)
            }
            return campaigns
        }

        // ─── Helper: catálogo de nombres de leadgen forms (memoizado por cuenta) ──
        async function loadMetaFormCatalog(actId: string, token: string): Promise<Map<string, string>> {
            const nameMap = new Map<string, string>()
            try {
                const catalogUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/leadgen_forms`)
                catalogUrl.searchParams.append('access_token', token)
                catalogUrl.searchParams.append('fields', 'id,name')
                catalogUrl.searchParams.append('limit', '200')
                const catalogRes = await metaFetch(catalogUrl.toString())
                const catalogData = await catalogRes.json()
                if (catalogData.data && Array.isArray(catalogData.data)) {
                    for (const f of catalogData.data) {
                        if (f.id && f.name) nameMap.set(String(f.id), f.name)
                    }
                }
            } catch {
                /* non-critical */
            }
            return nameMap
        }

        // ─── TikTok: paginación genérica (token por parámetro) ───────────────────
        async function fetchTikTokPaged(
            baseUrl: URL,
            token: string,
            pageSize = 1000,
        ): Promise<{ ok: boolean; list: any[]; message?: string }> {
            const all: any[] = []
            let page = 1
            let totalPage = 1
            const MAX_PAGES = 200 // safety backstop
            do {
                const u = new URL(baseUrl.toString())
                u.searchParams.set('page', String(page))
                u.searchParams.set('page_size', String(pageSize))
                const res = await tiktokFetch(u.toString(), { headers: { 'Access-Token': token } })
                const json = await res.json()
                if (json?.code !== 0 || !json?.data) {
                    return { ok: false, list: all, message: json?.message || JSON.stringify(json) }
                }
                const list = Array.isArray(json.data.list) ? json.data.list : []
                all.push(...list)
                const pi = json.data.page_info || {}
                totalPage = pi.total_page || 1
                page++
            } while (page <= totalPage && page <= MAX_PAGES)
            return { ok: true, list: all }
        }

        // ─── TikTok: catálogo de nombres (campaign/ad/adgroup), memoizado por cuenta ──
        // Los nombres NO cambian por día → se cargan UNA vez por rango y por cuenta,
        // y los 3 rastreos corren en paralelo (acotados por el pool de TikTok).
        async function loadTikTokNames(advertiserId: string, token: string) {
            return memo(tiktokNameCache, advertiserId, async () => {
                const crawl = async (path: string, idKey: string, nameKey: string) => {
                    const map = new Map<string, string>()
                    try {
                        const url = new URL(path)
                        url.searchParams.append('advertiser_id', advertiserId)
                        const paged = await fetchTikTokPaged(url, token)
                        if (paged.ok) {
                            paged.list.forEach((item: any) => {
                                const id = String(item[idKey] || '')
                                const name = item[nameKey]
                                if (id && name) map.set(id, name)
                            })
                        } else {
                            log(`[TikTok] Warning: nombres no obtenidos (${path}): ${paged.message}`)
                        }
                    } catch (e: any) {
                        log(`[TikTok] Warning: nombres no obtenidos (${path}): ${e.message}`)
                    }
                    return map
                }
                const [campaigns, ads, adgroups] = await Promise.all([
                    crawl('https://business-api.tiktok.com/open_api/v1.3/campaign/get/', 'campaign_id', 'campaign_name'),
                    crawl('https://business-api.tiktok.com/open_api/v1.3/ad/get/', 'ad_id', 'ad_name'),
                    crawl('https://business-api.tiktok.com/open_api/v1.3/adgroup/get/', 'adgroup_id', 'adgroup_name'),
                ])
                return { campaigns, ads, adgroups }
            })
        }

        // ─── Helper: Fetch Meta Ads for a single account+date ───────────────
        async function fetchMetaSingleAccount(targetDate: string, rawAccountId: string, token: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[], meta_ads: [] as any[], meta_adsets: [] as any[], forms: [] as any[] }
            const actId = rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`
            try {
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                url.searchParams.append('access_token', token)
                url.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                url.searchParams.append('fields', 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions')
                url.searchParams.append('level', 'campaign')
                url.searchParams.append('limit', '500')

                const res = await metaFetch(url.toString())
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
                        const reachRes = await metaFetch(reachUrl.toString())
                        const reachData = await reachRes.json()
                        if (reachData.data?.[0]?.reach) {
                            record.account_reach = parseInt(reachData.data[0].reach || '0')
                        }
                    } catch (_e) { /* non-critical */ }

                    // Enriquecer con targeting/geo por cuenta (cacheado por actId, no por día)
                    record.campaigns = await enrichCampaignsWithTargeting(record.campaigns, token, actId)

                } else if (data.error) {
                    log(`[Meta] ${targetDate} [${rawAccountId}] Error de API: ${JSON.stringify(data.error)}`)
                } else {
                    log(`[Meta] ${targetDate} [${rawAccountId}] Sin datos.`)
                }
            } catch (e: any) {
                log(`[Meta] [${rawAccountId}] Catch Error: ${e.message}`)
            }

        // ─── Helper: Fetch Meta at ad or adset level ───────────────────────────
        async function fetchMetaAtLevel(level: 'ad' | 'adset'): Promise<any[]> {
            try {
                const idField   = level === 'ad' ? 'ad_id'      : 'adset_id'
                const nameField = level === 'ad' ? 'ad_name'    : 'adset_name'
                const extraIds  = level === 'ad'
                    ? 'ad_id,ad_name,adset_id,adset_name,'
                    : 'adset_id,adset_name,'

                const levelUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                levelUrl.searchParams.append('access_token', token)
                levelUrl.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                levelUrl.searchParams.append('fields', `${extraIds}campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions`)
                levelUrl.searchParams.append('level', level)
                levelUrl.searchParams.append('limit', '500')

                const res = await metaFetch(levelUrl.toString())
                const data = await res.json()
                if (!data.data) return []

                const items: any[] = []
                data.data.forEach((item: any) => {
                    let iLeads = 0, iLeadsForm = 0, iPurchases = 0, iAddsToCart = 0, iInitiatesCheckout = 0
                    let iLandingPageViews = 0, iVideoViews = 0, iVideoThruplay = 0, iVideo3s = 0
                    let iCompleteRegistration = 0, iViewContent = 0, iSearch = 0, iAddToWishlist = 0
                    let iContact = 0, iSchedule = 0, iStartTrial = 0, iSubmitApplication = 0
                    let iSubscribe = 0, iFindLocation = 0, iCustomizeProduct = 0, iDonate = 0
                    let iMessagingConversations = 0, iPageEngagement = 0, iPostEngagement = 0
                    let iPostReactions = 0, iPostShares = 0, iPostSaves = 0, iPostComments = 0
                    let iResults = 0
                    let iNativeLeads = 0, iPixelLeads = 0
                    let iNativePurchases = 0, iPixelPurchases = 0
                    let iNativeCompleteReg = 0, iPixelCompleteReg = 0
                    const iCustomConversions: Record<string, number> = {}

                    if (item.actions) {
                        item.actions.forEach((a: any) => {
                            const val = parseInt(a.value || '0')
                            const t = a.action_type || ''
                            if (t === 'lead') iNativeLeads += val
                            if (t === 'offsite_conversion.fb_pixel_lead') iPixelLeads += val
                            if (t === 'purchase') iNativePurchases += val
                            if (t === 'offsite_conversion.fb_pixel_purchase') iPixelPurchases += val
                            if (t === 'complete_registration') iNativeCompleteReg += val
                            if (t === 'offsite_conversion.fb_pixel_complete_registration') iPixelCompleteReg += val
                            if (t === 'offsite_conversion.fb_pixel_add_to_cart') iAddsToCart += val
                            if (t === 'offsite_conversion.fb_pixel_initiate_checkout') iInitiatesCheckout += val
                            if (t === 'landing_page_view') iLandingPageViews += val
                            if (t === 'video_view') iVideoViews += val
                            if (t === 'offsite_conversion.fb_pixel_view_content' || t === 'view_content') iViewContent += val
                            if (t === 'offsite_conversion.fb_pixel_search' || t === 'search') iSearch += val
                            if (t === 'offsite_conversion.fb_pixel_add_to_wishlist' || t === 'add_to_wishlist') iAddToWishlist += val
                            if (t === 'offsite_conversion.fb_pixel_customize_product' || t === 'customize_product') iCustomizeProduct += val
                            if (t === 'offsite_conversion.fb_pixel_contact' || t === 'contact') iContact += val
                            if (t === 'offsite_conversion.fb_pixel_schedule' || t === 'schedule') iSchedule += val
                            if (t === 'offsite_conversion.fb_pixel_start_trial' || t === 'start_trial') iStartTrial += val
                            if (t === 'offsite_conversion.fb_pixel_submit_application' || t === 'submit_application') iSubmitApplication += val
                            if (t === 'offsite_conversion.fb_pixel_subscribe' || t === 'subscribe') iSubscribe += val
                            if (t === 'offsite_conversion.fb_pixel_find_location' || t === 'find_location') iFindLocation += val
                            if (t === 'offsite_conversion.fb_pixel_donate' || t === 'donate') iDonate += val
                            if (t === 'onsite_conversion.messaging_conversation_started_7d') iMessagingConversations += val
                            if (t === 'page_engagement') iPageEngagement += val
                            if (t === 'post_engagement') iPostEngagement += val
                            if (t === 'post_reaction') iPostReactions += val
                            if (t === 'post_share' || t === 'post') iPostShares += val
                            if (t === 'onsite_conversion.post_save') iPostSaves += val
                            if (t === 'comment') iPostComments += val
                        })
                    }

                    iLeads = (iNativeLeads > 0 && iPixelLeads > 0)
                        ? Math.max(iNativeLeads, iPixelLeads) : iNativeLeads + iPixelLeads
                    iLeadsForm = iNativeLeads
                    iPurchases = (iNativePurchases > 0 && iPixelPurchases > 0)
                        ? Math.max(iNativePurchases, iPixelPurchases) : iNativePurchases + iPixelPurchases
                    iCompleteRegistration = (iNativeCompleteReg > 0 && iPixelCompleteReg > 0)
                        ? Math.max(iNativeCompleteReg, iPixelCompleteReg) : iNativeCompleteReg + iPixelCompleteReg

                    if (item.video_thruplay_watched_actions) {
                        item.video_thruplay_watched_actions.forEach((a: any) => { iVideoThruplay += parseInt(a.value || '0') })
                    }

                    if (item.conversions) {
                        item.conversions.forEach((cv: any) => {
                            const type: string = cv.action_type || ''
                            const val = parseInt(cv.value || '0')
                            if (type.startsWith('offsite_conversion.fb_pixel_custom.')) {
                                const key = type.replace('offsite_conversion.fb_pixel_custom.', '').toLowerCase()
                                iCustomConversions[key] = (iCustomConversions[key] || 0) + val
                            }
                        })
                    }

                    iResults = iLeads + iPurchases + iInitiatesCheckout

                    items.push({
                        [idField]:     item[idField]     || null,
                        [nameField]:   item[nameField]   || 'Desconocido',
                        adset_id:      item.adset_id     || null,
                        adset_name:    item.adset_name   || null,
                        campaign_id:   item.campaign_id  || null,
                        campaign_name: item.campaign_name || null,
                        account_id:    rawAccountId,
                        spend:              parseFloat(item.spend       || '0'),
                        impressions:        parseInt(item.impressions   || '0'),
                        clicks:             parseInt(item.clicks        || '0'),
                        link_clicks:        parseInt(item.inline_link_clicks || '0'),
                        reach:              parseInt(item.reach         || '0'),
                        frequency:          parseFloat(item.frequency   || '0'),
                        cpc:                parseFloat(item.cpc         || '0'),
                        cpm:                parseFloat(item.cpm         || '0'),
                        ctr:                parseFloat(item.ctr         || '0'),
                        leads:              iLeads,
                        leads_form:         iLeadsForm,
                        purchases:          iPurchases,
                        adds_to_cart:       iAddsToCart,
                        initiates_checkout: iInitiatesCheckout,
                        landing_page_views: iLandingPageViews,
                        complete_registration: iCompleteRegistration,
                        view_content:       iViewContent,
                        search:             iSearch,
                        add_to_wishlist:    iAddToWishlist,
                        customize_product:  iCustomizeProduct,
                        contact:            iContact,
                        schedule:           iSchedule,
                        start_trial:        iStartTrial,
                        submit_application: iSubmitApplication,
                        subscribe:          iSubscribe,
                        find_location:      iFindLocation,
                        donate:             iDonate,
                        video_views:        iVideoViews,
                        video_thruplay:     iVideoThruplay,
                        video_3s:           iVideo3s,
                        messaging_conversations: iMessagingConversations,
                        page_engagement:    iPageEngagement,
                        post_engagement:    iPostEngagement,
                        post_reactions:     iPostReactions,
                        post_shares:        iPostShares,
                        post_saves:         iPostSaves,
                        post_comments:      iPostComments,
                        results:            iResults,
                        custom_conversions: iCustomConversions,
                    })
                })

                // Dedup by primary key
                const deduped = new Map<string, any>()
                for (const it of items) deduped.set(it[idField] || it[nameField], it)
                return Array.from(deduped.values())
            } catch (e: any) {
                log(`[Meta] fetchMetaAtLevel(${level}) error: ${e.message}`)
                return []
            }
        }

        // ─── Fetch ads + adsets in parallel ───────────────────────────────────
        const [adsResult, adsetsResult] = await Promise.all([
            fetchMetaAtLevel('ad'),
            fetchMetaAtLevel('adset'),
        ])
        record.meta_ads    = adsResult
        record.meta_adsets = adsetsResult

            // ─── Lead form breakdown (Meta Lead Ads) ──────────────────────────
            try {
                // 1) Catálogo de nombres de forms — cacheado por cuenta (no por día)
                const nameMap = await memo(metaFormCatalogCache, actId, () => loadMetaFormCatalog(actId, token))

                // 2) Fetch insights breakdown by leadgen_form_id (level=ad required by Meta)
                const formUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                formUrl.searchParams.append('access_token', token)
                formUrl.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                formUrl.searchParams.append('fields', 'leadgen_form_id,spend,impressions,clicks,actions')
                formUrl.searchParams.append('breakdowns', 'leadgen_form_id')
                formUrl.searchParams.append('level', 'ad')
                formUrl.searchParams.append('limit', '500')

                const formRes = await metaFetch(formUrl.toString())
                const formData = await formRes.json()

                if (formData.data && Array.isArray(formData.data)) {
                    const formsMap = new Map<string, any>()

                    for (const item of formData.data) {
                        const formId: string = item.leadgen_form_id || ''
                        if (!formId) continue

                        const existing = formsMap.get(formId) || {
                            form_id:     formId,
                            form_name:   nameMap.get(formId) || formId,
                            leads:       0,
                            spend:       0,
                            impressions: 0,
                            clicks:      0,
                        }

                        existing.spend       += parseFloat(item.spend || '0')
                        existing.impressions += parseInt(item.impressions || '0')
                        existing.clicks      += parseInt(item.clicks || '0')

                        if (item.actions) {
                            for (const a of item.actions) {
                                if (a.action_type === 'lead') {
                                    existing.leads += parseInt(a.value || '0')
                                }
                            }
                        }

                        formsMap.set(formId, existing)
                    }

                    record.forms = Array.from(formsMap.values())
                }
            } catch (err: any) {
                log(`[Meta] Form breakdown fetch failed (non-critical): ${err?.message}`)
            }

            return record
        }

        // ─── Helper: Fetch Meta Ads for a single date (multi-account) ────────
        async function fetchMeta(targetDate: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[], meta_ads: [] as any[], meta_adsets: [] as any[], forms: [] as any[] }

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
                record.meta_ads.push(...(r.meta_ads || []))
                record.meta_adsets.push(...(r.meta_adsets || []))
                // Merge forms: sum metrics for same form_id across accounts
                for (const f of (r.forms || [])) {
                    const existing = record.forms.find((x: any) => x.form_id === f.form_id)
                    if (existing) {
                        existing.leads       += f.leads || 0
                        existing.spend       += f.spend || 0
                        existing.impressions += f.impressions || 0
                        existing.clicks      += f.clicks || 0
                    } else {
                        record.forms.push({ ...f })
                    }
                }
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

            // El enriquecimiento de targeting/geo ya se hizo por cuenta dentro de
            // fetchMetaSingleAccount (cacheado por actId), y el spread del merge
            // preserva `targeting_regions` en cada campaña.

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

        // ─── Helper: Fetch TikTok Ads for a single advertiser account + date ───
        async function fetchTikTokSingleAccount(targetDate: string, advertiserId: string, token: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, conversions: 0, campaigns: [] as any[], tiktok_ads: [] as any[], tiktok_adgroups: [] as any[], apiSuccess: false }
            log(`[TikTok] ${targetDate} Consultando advertiser_id: ${advertiserId}`)

            try {
                // Catálogo de nombres (campaign/ad/adgroup) — cacheado por cuenta,
                // se carga UNA vez por rango (no por día). Ver loadTikTokNames.
                const tkNames = await loadTikTokNames(advertiserId, token)
                const campaignMap = tkNames.campaigns

                // ─── Helper: fetch ad or adgroup level report for this date ─────
                async function fetchTikTokAtLevel(level: 'ad' | 'adgroup'): Promise<any[]> {
                    try {
                        const dataLevel = level === 'ad' ? 'AUCTION_AD' : 'AUCTION_ADGROUP'
                        const idDim     = level === 'ad' ? 'ad_id'      : 'adgroup_id'
                        const idKey     = level === 'ad' ? 'ad_id'      : 'adgroup_id'
                        const nameKey   = level === 'ad' ? 'ad_name'    : 'adgroup_name'

                        // Nombres ya cargados desde la caché por cuenta (no se vuelve a pedir)
                        const nameMap = level === 'ad' ? tkNames.ads : tkNames.adgroups

                        const dims = level === 'ad' ? ['ad_id'] : ['adgroup_id']

                        const rptUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
                        rptUrl.searchParams.append('advertiser_id', advertiserId)
                        rptUrl.searchParams.append('report_type', 'BASIC')
                        rptUrl.searchParams.append('data_level', dataLevel)
                        rptUrl.searchParams.append('dimensions', JSON.stringify(dims))
                        rptUrl.searchParams.append('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']))
                        rptUrl.searchParams.append('start_date', targetDate)
                        rptUrl.searchParams.append('end_date', targetDate)

                        const rptPaged = await fetchTikTokPaged(rptUrl, token)
                        if (!rptPaged.ok) {
                            log(`[TikTok] fetchTikTokAtLevel(${level}) error: ${rptPaged.message}`)
                            return []
                        }

                        const items: any[] = []
                        rptPaged.list.forEach((item: any) => {
                            const d  = item.dimensions || {}
                            const m  = item.metrics    || {}
                            const id = String(d[idDim] || '')
                            const out: any = {
                                [idKey]:     id || null,
                                [nameKey]:   nameMap.get(id) || id || 'Desconocido',
                                spend:       parseFloat(m.spend       || '0'),
                                impressions: parseInt(m.impressions   || '0'),
                                clicks:      parseInt(m.clicks        || '0'),
                                conversions: parseInt(m.conversion    || '0'),
                                account_id:  advertiserId,
                            }
                            items.push(out)
                        })

                        const deduped = new Map<string, any>()
                        for (const it of items) deduped.set(it[idKey] || it[nameKey], it)
                        log(`[TikTok] ${targetDate} ${level}: ${deduped.size} registros`)
                        return Array.from(deduped.values())
                    } catch (e: any) {
                        log(`[TikTok] fetchTikTokAtLevel(${level}) catch: ${e.message}`)
                        return []
                    }
                }

                // Fetch reports from TikTok Business API
                const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
                url.searchParams.append('advertiser_id', advertiserId)
                url.searchParams.append('report_type', 'BASIC')
                url.searchParams.append('data_level', 'AUCTION_CAMPAIGN')
                url.searchParams.append('dimensions', JSON.stringify(['campaign_id']))
                url.searchParams.append('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']))
                url.searchParams.append('start_date', targetDate)
                url.searchParams.append('end_date', targetDate)

                const campReport = await fetchTikTokPaged(url, token)

                if (campReport.ok) {
                    if (campReport.list.length > 0) {
                        log(`[TikTok] ${targetDate} RAW primer resultado: ${JSON.stringify(campReport.list[0])}`)
                    }
                    let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalConv = 0
                    const campaignsArr: any[] = []

                    campReport.list.forEach((camp: any) => {
                        const dims = camp.dimensions || {}
                        const mets = camp.metrics || {}
                        const cSpend = parseFloat(mets.spend || '0')
                        const cImpr = parseInt(mets.impressions || '0')
                        const cClicks = parseInt(mets.clicks || '0')
                        const cConv = parseInt(mets.conversion || '0')

                        totalSpend += cSpend
                        totalImpr += cImpr
                        totalClicks += cClicks
                        totalConv += cConv

                        const cId = (dims.campaign_id || '').toString()
                        campaignsArr.push({
                            campaign_id: cId || null,
                            name: campaignMap.get(cId) || 'Desconocida',
                            spend: cSpend,
                            impressions: cImpr,
                            clicks: cClicks,
                            conversions: cConv,
                            account_id: advertiserId,
                        })
                    })

                    record.spend = totalSpend
                    record.impressions = totalImpr
                    record.clicks = totalClicks
                    record.conversions = totalConv
                    record.campaigns = campaignsArr
                    record.apiSuccess = true
                    log(`[TikTok] ${targetDate} [${advertiserId}] Spend: ${totalSpend}, Campañas: ${campaignsArr.length}`)

                    // Fetch ad-level and adgroup-level breakdowns in parallel
                    const [tiktokAdsResult, tiktokAdgroupsResult] = await Promise.all([
                        fetchTikTokAtLevel('ad'),
                        fetchTikTokAtLevel('adgroup'),
                    ])
                    record.tiktok_ads      = tiktokAdsResult
                    record.tiktok_adgroups = tiktokAdgroupsResult
                } else {
                    log(`[TikTok] ${targetDate} [${advertiserId}] Error de API: ${campReport.message}`)
                }
            } catch (e: any) {
                log(`[TikTok] [${advertiserId}] Catch Error: ${e.message}`)
            }
            return record
        }

        // ─── Multi-account wrapper: iterates tiktok_accounts, consolidates ───
        async function fetchTikTok(targetDate: string) {
            const record = {
                spend: 0, impressions: 0, clicks: 0, conversions: 0,
                campaigns: [] as any[], tiktok_ads: [] as any[], tiktok_adgroups: [] as any[],
                apiSuccess: false,
            }

            // Build list of accounts to sync (multi-account or legacy single-account)
            let accountsToFetch: { advertiser_id: string; token: string }[] = []
            if (config.tiktok_accounts && Array.isArray(config.tiktok_accounts) && config.tiktok_accounts.length > 0) {
                accountsToFetch = config.tiktok_accounts
                    .filter((a: any) => a.advertiser_id)
                    .map((a: any) => ({
                        advertiser_id: a.advertiser_id,
                        token: a.access_token || config.tiktok_access_token || '',
                    }))
            } else if (config.tiktok_access_token && config.tiktok_advertiser_id) {
                accountsToFetch = [{ advertiser_id: config.tiktok_advertiser_id, token: config.tiktok_access_token }]
            }

            if (accountsToFetch.length === 0) {
                platformLogs.tiktok = 'Sin configurar'
                log(`[TikTok] ${targetDate} Sin cuentas configuradas`)
                return record
            }

            const results = await Promise.all(
                accountsToFetch.map(({ advertiser_id, token }) =>
                    fetchTikTokSingleAccount(targetDate, advertiser_id, token)
                )
            )

            for (const r of results) {
                record.spend       += r.spend
                record.impressions += r.impressions
                record.clicks      += r.clicks
                record.conversions += r.conversions
                record.campaigns.push(...r.campaigns)
                record.tiktok_ads.push(...r.tiktok_ads)
                record.tiktok_adgroups.push(...r.tiktok_adgroups)
                if (r.apiSuccess) record.apiSuccess = true
            }

            if (record.apiSuccess) {
                platformLogs.tiktok = record.campaigns.length > 0 || record.spend > 0 ? 'Conectado OK' : 'Sin Datos'
            }
            log(`[TikTok] ${targetDate} Total — Spend: ${record.spend.toFixed(2)}, Campañas: ${record.campaigns.length}, Cuentas: ${accountsToFetch.length}`)
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
            affiliate_net: number      // comisión de afiliado (USD) — fuente AFFILIATE
            affiliate_count: number    // # de transacciones con comisión de afiliado
            coproducer_net: number     // comisión de co-producción (USD) — fuente COPRODUCER
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
                affiliate_net: 0, affiliate_count: 0, coproducer_net: 0,
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

                    const res = await hotmartFetch(url.toString(), {
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

                    const res2 = await hotmartFetch(url2.toString(), {
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
                            let hadAffiliate = false
                            if (item.commissions && Array.isArray(item.commissions)) {
                                item.commissions.forEach((c: any) => {
                                    if (c.commission?.currency_code !== 'USD') return
                                    const val = Number(c.commission.value) || 0
                                    if (c.source === 'PRODUCER') {
                                        netUSD += val
                                    } else if (c.source === 'AFFILIATE') {
                                        record.affiliate_net += val
                                        hadAffiliate = true
                                    } else if (c.source === 'COPRODUCER') {
                                        record.coproducer_net += val
                                    }
                                })
                            }
                            if (hadAffiliate) record.affiliate_count++

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
            // Necesita una propiedad. La autenticación puede venir de:
            //  1) OAuth de agencia (preferido) — solo hace falta ga_property_id
            //  2) Service account legacy por cliente (ga_client_email + ga_private_key)
            const useAgencyOAuth = await hasAgencyGoogleConnection()
            const hasServiceAccount = !!(config.ga_client_email && config.ga_private_key)
            if (!config.ga_property_id || (!useAgencyOAuth && !hasServiceAccount)) {
                platformLogs.ga4 = 'Sin configurar'
                return record
            }

            try {
                const { BetaAnalyticsDataClient } = await import('@google-analytics/data')
                const client = useAgencyOAuth
                    ? new BetaAnalyticsDataClient({ authClient: await getAgencyAccessToken() as any })
                    : new BetaAnalyticsDataClient({
                        credentials: {
                            client_email: config.ga_client_email,
                            private_key: config.ga_private_key.replace(/\\n/g, '\n'),
                        }
                    })

                const propertyName = config.ga_property_id.startsWith('properties/')
                    ? config.ga_property_id
                    : `properties/${config.ga_property_id}`

                const [response] = await ga4Run(() => client.runReport({
                    property: propertyName,
                    dateRanges: [{ startDate: targetDate, endDate: targetDate }],
                    metrics: [
                        { name: 'sessions' },
                        { name: 'bounceRate' },
                        { name: 'averageSessionDuration' },
                    ],
                }))

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
                        const [resp] = await ga4Run(() => client.runReport({
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
                        }))
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
                    const landingPathVals  = Array.from(new Set(landingQueries.filter(q => q.url.startsWith('/')).map(q => q.url)))
                    const landingTitleVals = Array.from(new Set(landingQueries.filter(q => !q.url.startsWith('/')).map(q => q.url)))

                    // ── Pageviews para payment / upsell ──
                    const pvPathVals   = Array.from(new Set(pageviewQueries.filter(q => q.url.startsWith('/')).map(q => q.url)))
                    const pvTitleVals  = Array.from(new Set(pageviewQueries.filter(q => !q.url.startsWith('/')).map(q => q.url)))

                    // Las 4 consultas son independientes → en paralelo (acotadas por el pool GA4)
                    const emptyMap = (): Map<string, number> => new Map()
                    const [landingByPath, landingByTitle, viewsByPath, viewsByTitle] = await Promise.all([
                        landingPathVals.length  ? ga4Query('pagePath',  'screenPageViews', landingPathVals)  : Promise.resolve(emptyMap()),
                        landingTitleVals.length ? ga4Query('pageTitle', 'screenPageViews', landingTitleVals) : Promise.resolve(emptyMap()),
                        pvPathVals.length       ? ga4Query('pagePath',  'screenPageViews', pvPathVals)       : Promise.resolve(emptyMap()),
                        pvTitleVals.length      ? ga4Query('pageTitle', 'screenPageViews', pvTitleVals)      : Promise.resolve(emptyMap()),
                    ])

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
        // El pool de rate-limit (src/lib/rate-limit.ts) ya gobierna la TASA real de
        // peticiones, así que el chunk es solo una palanca de memoria/scheduling.
        // Lo adaptamos al número de cuentas: con más cuentas, cada fecha ya abre
        // más peticiones en paralelo, así que reducimos el chunk.
        const metaAccts = (Array.isArray(config.meta_accounts) ? config.meta_accounts.length : 0) || (config.meta_account_id ? 1 : 0)
        const tiktokAccts = (Array.isArray(config.tiktok_accounts) ? config.tiktok_accounts.length : 0) || (config.tiktok_advertiser_id ? 1 : 0)
        const totalAccounts = Math.max(1, metaAccts + tiktokAccts)
        const CHUNK_SIZE = Math.max(3, Math.min(10, Math.floor(40 / totalAccounts)));
        const upsertPayloads: any[] = [];
        
        for (let i = 0; i < datesToSync.length; i += CHUNK_SIZE) {
            const chunk = datesToSync.slice(i, i + CHUNK_SIZE);
            log(`[Batch] Procesando chunk de fechas en paralelo: ${chunk.join(', ')}`);
            
            const chunkResults = await Promise.all(
                chunk.map(async (targetDate) => {
                    // Fetch Meta, TikTok, Hotmart and GA4 in parallel for this specific date
                    const [metaRecord, tiktokRecord, hotmartRecord, gaRecord] = await Promise.all([
                        fetchMeta(targetDate),
                        fetchTikTok(targetDate),
                        fetchHotmart(targetDate),
                        fetchGA4(targetDate),
                    ]);
                    
                    return { targetDate, metaRecord, tiktokRecord, hotmartRecord, gaRecord };
                })
            );
            
            // Collect the results for the mass upsert list
            for (const res of chunkResults) {
                const { targetDate, metaRecord, tiktokRecord, hotmartRecord, gaRecord } = res;

                // Guard: skip empty responses for dates older than 2 days
                // (prevents overwriting good data with stale empty API responses)
                const daysAgo = differenceInDays(new Date(), parseISO(targetDate))
                const isEmptyMeta = metaRecord.campaigns.length === 0 && metaRecord.spend === 0
                const isEmptyTikTok = tiktokRecord.campaigns.length === 0 && tiktokRecord.spend === 0
                const isAllEmpty = isEmptyMeta && isEmptyTikTok && hotmartRecord.principal === 0 && hotmartRecord.ventas_count === 0 && gaRecord.sessions === 0
                if (isAllEmpty && daysAgo > 2 && existingHashMap.has(targetDate)) {
                    log(`[DB] Saltando ${targetDate} — respuesta vacía para fecha histórica con datos existentes`)
                    results.push({ cliente_id: cliente.id, date: targetDate, status: 'skipped_empty', platform_status: { ...platformLogs } } as any)
                    continue
                }

                // Per-platform guard: if TikTok API failed (not just zero spend, but actual API error),
                // skip TikTok fields in the upsert to preserve previously-synced data in the DB.
                const hasAnyTikTokConfig = (Array.isArray(config.tiktok_accounts) && config.tiktok_accounts.length > 0) || !!config.tiktok_access_token
                const tiktokFailed = hasAnyTikTokConfig && !tiktokRecord.apiSuccess

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
                    affiliates: {
                        affiliate_net: hotmartRecord.affiliate_net,
                        affiliate_count: hotmartRecord.affiliate_count,
                        coproducer_net: hotmartRecord.coproducer_net,
                    },
                }

                // Compute payload hash for idempotency
                const hashPayload = { meta: metaRecord, tiktok: tiktokRecord, hotmart: hotmartRecord, ga: gaRecord }
                const payloadHash = computeSyncHash(hashPayload)
                if (existingHashMap.get(targetDate) === payloadHash) {
                    log(`[DB] Saltando ${targetDate} — sync_hash sin cambios`)
                    results.push({ cliente_id: cliente.id, date: targetDate, status: 'skipped_hash', platform_status: { ...platformLogs } } as any)
                    continue
                }

                if (tiktokFailed) {
                    log(`[TikTok] ${targetDate} API falló — se omiten campos TikTok del upsert para preservar datos existentes`)
                }

                upsertPayloads.push({
                    cliente_id: cliente.id,
                    fecha: targetDate,
                    sync_hash: payloadHash,
                    meta_spend: metaRecord.spend,
                    meta_impressions: metaRecord.impressions,
                    meta_clicks: metaRecord.clicks,
                    meta_campaigns: metaRecord.campaigns,
                    meta_ads:      metaRecord.meta_ads,
                    meta_adsets:   metaRecord.meta_adsets,
                    meta_forms:    metaRecord.forms,
                    // Only include TikTok fields when the API call actually succeeded.
                    // On failure, preserve whatever is already in the DB for these columns.
                    ...(!tiktokFailed && {
                        tiktok_spend: tiktokRecord.spend,
                        tiktok_impressions: tiktokRecord.impressions,
                        tiktok_clicks: tiktokRecord.clicks,
                        tiktok_conversions: tiktokRecord.conversions,
                        tiktok_campaigns: tiktokRecord.campaigns,
                        tiktok_ads:      tiktokRecord.tiktok_ads,
                        tiktok_adgroups: tiktokRecord.tiktok_adgroups,
                    }),
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
    }))

    // Aviso in-app a admins si falló el upsert de algún cliente (un aviso por corrida)
    const failedClienteIds = [...new Set(results.filter((r: any) => r.status === 'failed').map((r: any) => r.cliente_id))]
    if (failedClienteIds.length > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const failedNames = clientes
            .filter((c: any) => failedClienteIds.includes(c.id))
            .map((c: any) => c.nombre)
        await notifyUsers({
            db: adminSupabase,
            type: 'sync_failed',
            severity: 'error',
            audience: 'admins',
            title: `Fallo de sincronización (${failedClienteIds.length} cliente${failedClienteIds.length > 1 ? 's' : ''})`,
            message: failedNames.join(', ').slice(0, 300),
            link: '/dashboard',
            metadata: { cliente_ids: failedClienteIds, range: { start: startDateStr, end: endDateStr } },
        })
    }

    return NextResponse.json({ message: 'Sync complete', results, debugLogs })
}