import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { format, subDays, parseISO, isBefore, addDays } from 'date-fns'
import { createClient as createSSRClient } from '@/utils/supabase/server'

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
        if (config.hotmart_basic) {
            try {
                const tokenRes = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${config.hotmart_basic}`
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
            log(`[Cliente ${cliente.nombre}] No tiene config.hotmart_basic definida.`)
        }

        // ─── Helper: Fetch Meta Ads for a single date ────────────────────────
        async function fetchMeta(targetDate: string) {
            const record = { spend: 0, impressions: 0, clicks: 0, campaigns: [] as any[] }
            if (!(config.meta_token && config.meta_account_id)) {
                log(`[Meta] Sin config para el cliente.`)
                return record
            }
            try {
                const actId = config.meta_account_id.startsWith('act_') ? config.meta_account_id : `act_${config.meta_account_id}`
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                url.searchParams.append('access_token', config.meta_token)
                url.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                url.searchParams.append('fields', 'campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions,video_p3_watched_actions')
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

                        let cLeads = 0, cPurchases = 0, cAddsToCart = 0, cInitiatesCheckout = 0
                        let cLandingPageViews = 0, cVideoViews = 0, cVideoThruplay = 0, cVideo3s = 0, cResults = 0
                        let cCompleteRegistration = 0, cViewContent = 0, cSearch = 0, cAddToWishlist = 0
                        let cCustomizeProduct = 0, cContact = 0, cSchedule = 0, cStartTrial = 0
                        let cSubmitApplication = 0, cSubscribe = 0, cFindLocation = 0, cDonate = 0
                        let cMessagingConversations = 0
                        let cPageEngagement = 0, cPostEngagement = 0, cPostReactions = 0
                        let cPostShares = 0, cPostSaves = 0, cPostComments = 0
                        const cCustomConversions: Record<string, number> = {}

                        if (camp.actions) {
                            camp.actions.forEach((a: any) => {
                                const val = parseInt(a.value || '0')
                                const t = a.action_type || ''
                                // Leads (native Lead Ads + pixel)
                                if (t === 'lead' || t === 'offsite_conversion.fb_pixel_lead') cLeads += val
                                // Purchases
                                if (t === 'purchase' || t === 'offsite_conversion.fb_pixel_purchase') cPurchases += val
                                // Carrito y checkout
                                if (t === 'offsite_conversion.fb_pixel_add_to_cart') cAddsToCart += val
                                if (t === 'offsite_conversion.fb_pixel_initiate_checkout') cInitiatesCheckout += val
                                // Landing page
                                if (t === 'landing_page_view') cLandingPageViews += val
                                // Video
                                if (t === 'video_view') cVideoViews += val
                                // Registro, contenido, búsqueda
                                if (t === 'offsite_conversion.fb_pixel_complete_registration' || t === 'complete_registration') cCompleteRegistration += val
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

                        // ThruPlay y 3-segundos (campos separados en la API)
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
                            name: camp.campaign_name || 'Desconocida',
                            spend: cSpend, impressions: cImpr, clicks: cClicks,
                            link_clicks: cLinkClicks, reach: cReach, frequency: cFrequency,
                            cpc: cCpc, cpm: cCpm, ctr: cCtr,
                            // Leads y conversiones estándar
                            leads: cLeads, purchases: cPurchases,
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

                    log(`[Meta] ${targetDate} Datos de campañas obtenidos. Total Spend: ${totalSpend}`)
                    record.spend = totalSpend
                    record.impressions = totalImpr
                    record.clicks = totalClicks
                    record.campaigns = campaignsArr
                    platformLogs.meta = 'Conectado OK'

                    // ── Auto-discover custom conversions → upsert into catalog
                    const allCustomKeys = new Set<string>()
                    campaignsArr.forEach((camp: any) => {
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
                } else if (data.error) {
                    log(`[Meta] ${targetDate} Error de API: ${JSON.stringify(data.error)}`)
                    if (platformLogs.meta === 'Saltado') platformLogs.meta = 'Error API'
                } else {
                    log(`[Meta] ${targetDate} Sin Datos para hoy.`)
                    if (platformLogs.meta === 'Saltado') platformLogs.meta = 'Sin Datos'
                }
            } catch (e: any) {
                log(`[Meta] Catch Error: ${e.message}`)
                platformLogs.meta = 'Error'
            }
            return record
        }

        // ─── Helper: Fetch Hotmart for a single date ────────────────────────
        async function fetchHotmart(targetDate: string) {
            const record = { principal: 0, bump: 0, upsell: 0, pagos_iniciados: 0 }
            if (!hotmartAccessToken) {
                log(`[Hotmart] Sin accessToken generado.`)
                return record
            }
            try {
                const clean = (str: string) => (str || '').toLowerCase().split(',').map(s => s.trim()).filter(s => s)
                const principalNames = clean(config.hotmart_principal_names)
                const bumpNames = clean(config.hotmart_bump_names)
                const upsellNames = clean(config.hotmart_upsell_names)

                const dayStart = new Date(`${targetDate}T00:00:00.000-05:00`).getTime()
                const dayEnd = new Date(`${targetDate}T23:59:59.999-05:00`).getTime()

                // PASO 1: Transacciones válidas aprobadas
                let pageToken = ""
                let hasNext = true
                const validTransactions = new Set<string>()

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
                            if (item.purchase?.transaction) {
                                validTransactions.add(item.purchase.transaction)
                            }
                        })
                    }
                    pageToken = data.page_info?.next_page_token
                    hasNext = !!pageToken
                }

                // PASO 2: Comisiones exactas (USD) de transacciones validadas
                pageToken = ""
                hasNext = true
                let totalItemsProcessed = 0

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
                            if (validTransactions.has(item.transaction)) {
                                totalItemsProcessed++
                                let netUSD = 0

                                if (item.commissions && Array.isArray(item.commissions)) {
                                    item.commissions.forEach((c: any) => {
                                        if (c.source === 'PRODUCER' && c.commission?.currency_code === 'USD') {
                                            netUSD += c.commission.value
                                        }
                                    })
                                }

                                const prodName = (item.product?.name || '').toLowerCase().trim()

                                if (principalNames.includes(prodName)) {
                                    record.principal += netUSD
                                } else if (bumpNames.includes(prodName)) {
                                    record.bump += netUSD
                                } else if (upsellNames.includes(prodName)) {
                                    record.upsell += netUSD
                                } else {
                                    record.principal += netUSD
                                }
                            }
                        })
                    }
                    pageToken = data2.page_info?.next_page_token
                    hasNext = !!pageToken
                }

                log(`[Hotmart] ${targetDate} Procesados ${totalItemsProcessed} registros. USD: ${record.principal.toFixed(2)}`)
                platformLogs.hotmart = 'Conectado OK'
            } catch (e: any) {
                log(`[Hotmart] Catch Error: ${e.message}`)
                platformLogs.hotmart = 'Error'
            }
            return record
        }

        // ─── Helper: Fetch GA4 for a single date ────────────────────────────
        async function fetchGA4(targetDate: string) {
            const record = { sessions: 0 }
            if (!(config.ga_property_id && config.ga_client_email && config.ga_private_key)) {
                log(`[GA4] Sin config conectada.`)
                return record
            }
            try {
                const { BetaAnalyticsDataClient } = require('@google-analytics/data')
                const analyticsDataClient = new BetaAnalyticsDataClient({
                    credentials: {
                        client_email: config.ga_client_email,
                        private_key: config.ga_private_key.replace(/\\n/g, '\n')
                    }
                })
                const [response] = await analyticsDataClient.runReport({
                    property: `properties/${config.ga_property_id}`,
                    dateRanges: [{ startDate: targetDate, endDate: targetDate }],
                    metrics: [{ name: 'sessions' }],
                })
                if (response.rows?.[0]) {
                    record.sessions = parseInt(response.rows[0].metricValues?.[0]?.value || '0')
                }
                platformLogs.ga4 = 'Conectado OK'
            } catch (e: any) {
                console.error("Error GA4", e)
                platformLogs.ga4 = 'Error'
            }
            return record
        }

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
                upsertPayloads.push({
                    cliente_id: cliente.id,
                    fecha: targetDate,
                    meta_spend: metaRecord.spend,
                    meta_impressions: metaRecord.impressions,
                    meta_clicks: metaRecord.clicks,
                    meta_campaigns: metaRecord.campaigns,
                    ga_sessions: gaRecord.sessions,
                    ventas_principal: hotmartRecord.principal,
                    ventas_bump: hotmartRecord.bump,
                    ventas_upsell: hotmartRecord.upsell,
                    hotmart_pagos_iniciados: hotmartRecord.pagos_iniciados
                });
                
                results.push({
                    cliente_id: cliente.id,
                    date: targetDate,
                    localLog: `Principal: ${hotmartRecord.principal}, Bump: ${hotmartRecord.bump}, Upsell: ${hotmartRecord.upsell}`,
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