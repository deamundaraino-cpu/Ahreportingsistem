import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { format, parseISO, isBefore, addDays, differenceInDays } from 'date-fns'
import { createClient as createSSRClient } from '@/utils/supabase/server'
import { getAgencyAccessToken, hasAgencyGoogleConnection } from '@/lib/integrations/google-auth'
import { notifyUsers } from '@/lib/notifications/notify'
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils'
import { metaFetch, tiktokFetch, hotmartFetch, ga4Run, setRetryDeadline } from '@/lib/rate-limit'
import { evaluateAlertRules } from '@/lib/notifications/rules-engine'
// La conversión de moneda de Hotmart se hace ahora en `src/lib/hotmart/moneda.ts`,
// en lote y con el mismo invariante de siempre: sin tasa el importe es NULL,
// nunca 0.
import { importesCuadran, sumarCampanas } from '@/lib/sync/reconcile'
import { expandirFila } from '@/lib/ads/ads-daily-writer'
import { agruparPorForma, plataformasOmitidas } from '@/lib/sync/upsert-batches'
import { hotmartConectado, obtenerToken } from '@/lib/hotmart/cliente'
import { cargarFunnels } from '@/lib/hotmart/persistencia'
import {
    agregarDesdeHotmartVentas, desgloseVacio, registroVacio, sincronizarDiaHotmart,
    type RegistroHotmart,
} from '@/lib/hotmart/sync'
import type { FunnelHotmart } from '@/lib/hotmart/clasificador'

// Vercel Hobby corta las funciones a 60s: pedir 300 no las alarga, solo hacía que
// los presupuestos internos (270s) nunca dispararan y la función muriera a mitad
// del upsert. Los rangos amplios van por la cola `sync_jobs` (worker self-hosted).
export const maxDuration = 60

/** Margen de seguridad dentro del límite de 60s: al agotarse se persiste lo hecho. */
const WORKER_BUDGET_MS = 45_000

/**
 * Ventana de dedupe del aviso de "sincronización incompleta".
 *
 * El worker corre varias veces al día y el fallback de GitHub Actions drena la
 * cola cada 30 min: un fallo persistente de una API generaba un aviso por
 * pasada. Durante la caída de Hotmart del 18-ago fueron 95 avisos idénticos en
 * 3 días. 6 h deja ver el problema cada día sin enterrar la campanita.
 */
const ALERTA_API_DEDUPE_MS = 6 * 60 * 60 * 1000

/**
 * `reason` de la alerta → texto que lee un humano en la notificación.
 *
 * Las claves `api_*` las produce la clasificación por status HTTP de
 * `clasificarErrorHotmart`; el resto son las guardas anti-cero del worker.
 */
const ETIQUETA_RAZON: Record<string, string> = {
    api_disconnected: 'API caída',
    api_parametros: 'parámetros rechazados',
    api_credenciales: 'credenciales inválidas',
    api_limite: 'límite de peticiones',
    api_indisponible: 'API no disponible',
    api_respuesta_invalida: 'respuesta ilegible de la API',
    api_desconocido: 'error no clasificado',
    zero_vs_previous: 'cero que contradice datos previos',
    caida_relativa: 'caída brusca de ventas',
    sin_tasa_cambio: 'importes sin tasa de cambio',
    spend_mismatch: 'gasto inconsistente',
}

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

/**
 * Familias de acciones de Meta.
 *
 * Un mismo evento se reporta con varios `action_type` según cómo esté configurada
 * la cuenta: nativo (`add_to_cart`), agregado omnicanal (`omni_add_to_cart`) y del
 * píxel (`offsite_conversion.fb_pixel_add_to_cart`). Son EL MISMO evento, así que
 * el valor de la familia es el MÁXIMO entre variantes, nunca la suma.
 *
 * Antes cada evento se buscaba con un `if` suelto y varios solo miraban la variante
 * `fb_pixel_*`: las cuentas que reportan la nativa/omni devolvían 0 para siempre
 * (carrito, ver contenido, búsquedas, contacto, agenda, suscripción…).
 */
const META_ACTION_FAMILIES: Record<string, string[]> = {
    // Los formularios nativos de Instagram/Messenger y el reporte agrupado de Meta
    // llegan como `onsite_conversion.lead_grouped` / `onsite_conversion.lead` /
    // `onsite_web_lead`, que no estaban mapeados: esas cuentas devolvían 0 leads
    // para siempre. El agregado por familia es un MAX entre variantes, así que
    // añadirlas no duplica el mismo evento reportado de varias formas.
    lead:                  ['lead', 'offsite_conversion.fb_pixel_lead', 'omni_lead',
                            'onsite_conversion.lead', 'onsite_conversion.lead_grouped',
                            'onsite_web_lead', 'leadgen_grouped'],
    purchase:              ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
    complete_registration: ['complete_registration', 'omni_complete_registration', 'offsite_conversion.fb_pixel_complete_registration'],
    add_to_cart:           ['add_to_cart', 'omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
    initiate_checkout:     ['initiate_checkout', 'omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
    view_content:          ['view_content', 'omni_view_content', 'offsite_conversion.fb_pixel_view_content'],
    search:                ['search', 'omni_search', 'offsite_conversion.fb_pixel_search'],
    add_to_wishlist:       ['add_to_wishlist', 'omni_add_to_wishlist', 'offsite_conversion.fb_pixel_add_to_wishlist'],
    customize_product:     ['customize_product', 'omni_customize_product', 'offsite_conversion.fb_pixel_customize_product'],
    contact:               ['contact', 'omni_contact', 'offsite_conversion.fb_pixel_contact'],
    schedule:              ['schedule', 'omni_schedule', 'offsite_conversion.fb_pixel_schedule'],
    start_trial:           ['start_trial', 'omni_start_trial', 'offsite_conversion.fb_pixel_start_trial'],
    submit_application:    ['submit_application', 'omni_submit_application', 'offsite_conversion.fb_pixel_submit_application'],
    subscribe:             ['subscribe', 'omni_subscribe', 'offsite_conversion.fb_pixel_subscribe'],
    find_location:         ['find_location', 'omni_find_location', 'offsite_conversion.fb_pixel_find_location'],
    donate:                ['donate', 'omni_donate', 'offsite_conversion.fb_pixel_donate'],
    landing_page_view:     ['landing_page_view'],
    video_view:            ['video_view'],
    messaging:             ['onsite_conversion.messaging_conversation_started_7d'],
    page_engagement:       ['page_engagement'],
    post_engagement:       ['post_engagement'],
    post_reaction:         ['post_reaction'],
    post_share:            ['post_share', 'post'],
    post_save:             ['onsite_conversion.post_save'],
    comment:               ['comment'],
}

/** action_types conocidos (para reportar los que Meta envía y no mapeamos). */
const KNOWN_ACTION_TYPES = new Set(Object.values(META_ACTION_FAMILIES).flat())

/**
 * Ventana de atribución explícita para /insights.
 *
 * Sin este parámetro Meta aplica la ventana por defecto de CADA cuenta, así que
 * dos clientes con configuraciones distintas producían conversiones no
 * comparables y el ROAS cambiaba si alguien tocaba los ajustes en Business
 * Manager. Fijarla aquí hace que el número signifique lo mismo para todos.
 *
 * 7d_click + 1d_view es el estándar de Meta desde iOS 14.
 */
const META_ATTRIBUTION_WINDOWS = JSON.stringify(['7d_click', '1d_view'])

/** Recolecta action_types no mapeados de toda la corrida, para diagnosticar. */
const unmappedActionTypes = new Set<string>()

interface MetaActionTotals {
    /** Valor por familia (máximo entre sus variantes). */
    fam: Record<string, number>
    /** Valor exacto de un action_type concreto (leads_form necesita el nativo). */
    exact: Record<string, number>
}

/** Normaliza el array `actions` de un insight de Meta a totales por familia. */
function parseMetaActions(actions: any): MetaActionTotals {
    const exact: Record<string, number> = {}
    if (Array.isArray(actions)) {
        for (const a of actions) {
            const t = a?.action_type || ''
            if (!t) continue
            const val = parseInt(a?.value || '0') || 0
            exact[t] = (exact[t] ?? 0) + val
            if (!KNOWN_ACTION_TYPES.has(t) && !t.startsWith('offsite_conversion.fb_pixel_custom.')
                && !t.startsWith('offsite_conversion.custom.')) {
                unmappedActionTypes.add(t)
            }
        }
    }
    const fam: Record<string, number> = {}
    for (const [family, variants] of Object.entries(META_ACTION_FAMILIES)) {
        // Máximo entre variantes: nativa y píxel describen el mismo evento.
        fam[family] = variants.reduce((max, v) => Math.max(max, exact[v] ?? 0), 0)
    }
    return { fam, exact }
}

export async function GET(request: Request) {
    const authError = requireCronAuth(request)
    if (authError) return authError

    let adminSupabase: any;
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        adminSupabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } else {
        adminSupabase = await createSSRClient()
    }

    // Presupuesto de tiempo para reintentos: no reintentar pasado este momento
    // (maxDuration=60s en Hobby; dejamos margen para upserts y respuesta final).
    const runStartedAt = Date.now()
    setRetryDeadline(runStartedAt + 50_000)
    const budgetExhausted = () => Date.now() - runStartedAt > WORKER_BUDGET_MS

    const { searchParams } = new URL(request.url)
    const singleDate = searchParams.get('date')
    // Por defecto sincroniza "ayer" en hora Colombia (UTC-5), no en UTC del servidor.
    const startDateStr = singleDate || searchParams.get('start') || colombiaYesterday()
    const endDateStr = singleDate || searchParams.get('end') || startDateStr
    const specificClientId = searchParams.get('client_id')
    // `force` ignora la ventana de refresco y re-descarga todo el rango; lo usa el
    // cierre de mes para recoger la reatribución tardía de Meta antes de congelar.
    const forceRefresh = searchParams.get('force') === '1' || searchParams.get('force') === 'true'
    const refreshDaysOverride = Number(searchParams.get('refresh_days')) || null

    // `platforms=meta` (CSV) limita el sync a ciertas fuentes. Reparar 120 días de
    // Meta no debe arrastrar 120 días de Hotmart (paginado) ni de GA4 (6 queries
    // por día) — eso es lo que hacía inviable un backfill amplio. Las plataformas
    // excluidas se marcan como fallidas para que el guard de preservación deje
    // intactos sus campos en la BD.
    const platformsParam = searchParams.get('platforms')
    const onlyPlatforms = platformsParam
        ? new Set(platformsParam.split(',').map(p => p.trim().toLowerCase()).filter(Boolean))
        : null
    const wantsPlatform = (p: string) => !onlyPlatforms || onlyPlatforms.has(p)

    let query = adminSupabase.from('clientes').select('*')
    if (specificClientId) {
        query = query.eq('id', specificClientId)
    }

    const { data: clientes, error } = await query
    if (error || !clientes) return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 })

    const results: any[] = []

    // Alertas de desconexión/inconsistencia acumuladas en toda la corrida (a nivel de
    // corrida, no por cliente). Se emite UNA notificación agregada al final.
    const inconsistencyAlerts: { cliente: string; platform: string; fecha: string; reason: string }[] = []

    /** Clientes cuyo rango quedó a medias por agotarse el presupuesto de 60s. */
    const partialClientes: string[] = []
    /** Fecha más temprana sin procesar: el runner de la cola reanuda desde aquí. */
    let resumeFrom: string | null = null

    const debugLogs: string[] = []
    const log = (msg: string) => {
        console.log(msg)
        debugLogs.push(msg)
    }

    // Fechas del rango pedido, antes de filtrar por períodos congelados de cada
    // cliente (ese filtro es por-cliente y se aplica más abajo).
    const allDatesToSync: string[] = []
    try {
        let currentDate = parseISO(startDateStr)
        const endDate = parseISO(endDateStr)
        const MAX_DAYS = 365
        let dayCount = 0
        while ((isBefore(currentDate, endDate) || currentDate.getTime() === endDate.getTime()) && dayCount < MAX_DAYS) {
            allDatesToSync.push(format(currentDate, 'yyyy-MM-dd'))
            currentDate = addDays(currentDate, 1)
            dayCount++
        }
    } catch {
        return NextResponse.json({ error: 'Fechas inválidas.' }, { status: 400 })
    }

    // Nunca sincronizar el futuro: un rango con `end` pasado de hoy creaba filas
    // vacías en metricas_diarias (las APIs no devuelven nada para esos días) que
    // luego ensucian los informes. Se recorta contra HOY en hora Colombia, igual
    // criterio que el resto del worker.
    const todayStr = colombiaToday()
    const skippedFuture = allDatesToSync.filter(d => d > todayStr).length
    if (skippedFuture > 0) {
        const pastDates = allDatesToSync.filter(d => d <= todayStr)
        allDatesToSync.length = 0
        allDatesToSync.push(...pastDates)
        log(`[worker] Se omiten ${skippedFuture} fecha(s) futura(s) (> ${todayStr}): las APIs no tienen datos y solo crearían filas vacías.`)
    }
    if (allDatesToSync.length === 0) {
        // Todo el rango era futuro. NO es un fallo: no hay nada que pedir, y
        // devolver 400 hacía que el job se reintentara 3 veces y acabara en rojo
        // en /admin/sync (y en el semáforo del dashboard) sin nada que reparar.
        log(`[worker] Nada que sincronizar: el rango pedido (${startDateStr} → ${endDateStr}) está por completo después de hoy (${todayStr}).`)
        return NextResponse.json({
            message: 'Sin fechas que sincronizar: el rango pedido está por completo en el futuro.',
            skipped: 'rango_futuro',
            partial: false,
            results: [],
            debugLogs,
        })
    }

    // ─── Períodos congelados ────────────────────────────────────────────────
    // Un mes cerrado ya se entregó al cliente en un informe: no puede cambiar
    // porque Meta reatribuya o porque una API falle. Las fechas de esos meses se
    // excluyen del sync (reabrir = borrar la fila en periodos_cerrados).
    const { data: cerradosRows } = await adminSupabase
        .from('periodos_cerrados')
        .select('cliente_id, periodo')
    const periodosCerrados = new Set<string>(
        (cerradosRows || []).map((r: any) => `${r.cliente_id}|${String(r.periodo).slice(0, 7)}`)
    )

    // Procesar todos los clientes en paralelo — reduce tiempo total de N×T a T (el cliente más lento)
    await Promise.all(clientes.map(async (cliente: any) => {
        const config = cliente.config_api as any
        if (!config) return

        const datesToSync = allDatesToSync.filter(d => !periodosCerrados.has(`${cliente.id}|${d.slice(0, 7)}`))
        if (datesToSync.length === 0) {
            log(`[Cliente ${cliente.nombre}] Todas las fechas del rango pertenecen a meses congelados — nada que sincronizar.`)
            return
        }
        if (datesToSync.length < allDatesToSync.length) {
            log(`[Cliente ${cliente.nombre}] ${allDatesToSync.length - datesToSync.length} fecha(s) omitidas por pertenecer a un mes congelado.`)
        }

        const platformLogs = { meta: 'Saltado', tiktok: 'Saltado', hotmart: 'Saltado', ga4: 'Saltado' }

        // ─── Cachés por-cliente para lookups independientes de la fecha ───
        // Se cargan UNA vez por rango (no por día). Valor Promise → fechas
        // concurrentes deduplican la misma carga.
        /**
         * Catálogo por cuenta: nombres + a qué campaña/conjunto cuelga cada
         * entidad. La jerarquía sale gratis de /ad/get/ y /adgroup/get/, y sin
         * ella las filas de anuncio/conjunto de TikTok no tienen campaña, así
         * que cualquier filtro por campaña las descarta enteras.
         */
        type TikTokPadre = { campaign_id: string | null; adgroup_id: string | null }
        const tiktokNameCache = new Map<string, Promise<{
            campaigns: Map<string, string>
            ads: Map<string, string>
            adgroups: Map<string, string>
            padresAds: Map<string, TikTokPadre>
            padresAdgroups: Map<string, TikTokPadre>
        }>>() // key: advertiserId
        const metaFormCatalogCache = new Map<string, Promise<Map<string, string>>>() // key: actId → (formId → name)
        const metaTargetingCache = new Map<string, Promise<Map<string, any[]>>>() // key: actId → (campaignId → regions)

        // ─── Token de Hotmart ────────────────────────────────────────────────
        // Toda la lógica (HotConnect + Basic, refresco y cifrado) vive en
        // `src/lib/hotmart/cliente.ts`, compartida con el cron y el backfill.
        // Antes eran ~80 líneas inline aquí, duplicadas casi literalmente en el
        // cron de refresco de tokens.
        let hotmartAccessToken: string | null = null
        try {
            const auth = await obtenerToken(config)
            hotmartAccessToken = auth.token
            if (auth.token) {
                platformLogs.hotmart = 'Preparado'
                // Escritura ATÓMICA: el read-modify-write anterior reescribía el
                // JSONB entero y pisaba lo que el cron de refresco guardara a la vez.
                if (auth.parche) {
                    await adminSupabase.rpc('fusionar_config_api', {
                        p_cliente_id: cliente.id,
                        p_parche: auth.parche,
                    })
                    log(`[Cliente ${cliente.nombre}] Token de Hotmart refrescado y persistido cifrado.`)
                }
            } else if (auth.motivo) {
                log(`[Cliente ${cliente.nombre}] Hotmart: ${auth.motivo}`)
                platformLogs.hotmart = 'Error Auth'
            }
        } catch (err: any) {
            log(`[Cliente ${cliente.nombre}] Catch Token Hotmart: ${err.message}`)
            platformLogs.hotmart = 'Fallo Critico'
        }

        // ¿El cliente TIENE Hotmart conectado? Distingue "sin configurar" (escribir
        // ceros es correcto) de "configurado pero la auth falló" (hay que preservar).
        //
        // El criterio vive ahora en un solo sitio: el dashboard usaba otro
        // distinto (`hotmart_basic || hotmart_token`) que dejaba fuera a los
        // clientes conectados por HotConnect, y esos perdían la resolución de los
        // alias `$facturacion_*` del motor de fórmulas.
        const hotmartConfigured = hotmartConectado(config)

        // ─── Cargar funnels Hotmart configurados por pestaña ────────────────────
        // `cliente_tabs.hotmart_funnel`. El lector vive en
        // `src/lib/hotmart/clasificador.ts` para que el webhook, el backfill y este
        // worker interpreten la MISMA configuración: con dos lecturas distintas,
        // una venta se clasificaba de una forma en vivo y de otra en el agregado.
        //
        // Se cargan aunque no haya token: la agregación desde `hotmart_ventas` los
        // necesita, y esa no depende de la API.
        const hotmartFunnels: FunnelHotmart[] = await cargarFunnels(adminSupabase, cliente.id)
        if (hotmartFunnels.length > 0) {
            log(`[Cliente ${cliente.nombre}] ${hotmartFunnels.length} funnel(s) Hotmart configurados`)
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

        // `matchesAny` (coincidencia estilo SQL LIKE sobre el nombre del producto)
        // se movió LITERAL a `src/lib/hotmart/clasificador.ts`, donde ahora es el
        // último paso de la cascada de clasificación. Vivía aquí y era el único
        // mecanismo, por eso renombrar un producto en Hotmart mandaba sus ventas a
        // `extras[]` sin ningún aviso.

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
                // `padres` guarda a qué campaña pertenece cada anuncio/conjunto.
                // /ad/get/ y /adgroup/get/ ya devuelven `campaign_id` en cada objeto,
                // así que sale gratis: sin él, las filas de tiktok_ads/tiktok_adgroups
                // no tienen campaña y el motor BI las descarta enteras en cuanto hay
                // un filtro por campaña (bi-query.ts: sin nombre no se puede comprobar).
                const crawl = async (path: string, idKey: string, nameKey: string) => {
                    const map = new Map<string, string>()
                    const padres = new Map<string, { campaign_id: string | null; adgroup_id: string | null }>()
                    try {
                        const url = new URL(path)
                        url.searchParams.append('advertiser_id', advertiserId)
                        const paged = await fetchTikTokPaged(url, token)
                        if (paged.ok) {
                            paged.list.forEach((item: any) => {
                                const id = String(item[idKey] || '')
                                if (!id) return
                                const name = item[nameKey]
                                if (name) map.set(id, name)
                                const campaignId = item.campaign_id ? String(item.campaign_id) : null
                                const adgroupId = item.adgroup_id ? String(item.adgroup_id) : null
                                if (campaignId || adgroupId) padres.set(id, { campaign_id: campaignId, adgroup_id: adgroupId })
                            })
                        } else {
                            log(`[TikTok] Warning: nombres no obtenidos (${path}): ${paged.message}`)
                        }
                    } catch (e: any) {
                        log(`[TikTok] Warning: nombres no obtenidos (${path}): ${e.message}`)
                    }
                    return { map, padres }
                }
                const [campaigns, ads, adgroups] = await Promise.all([
                    crawl('https://business-api.tiktok.com/open_api/v1.3/campaign/get/', 'campaign_id', 'campaign_name'),
                    crawl('https://business-api.tiktok.com/open_api/v1.3/ad/get/', 'ad_id', 'ad_name'),
                    crawl('https://business-api.tiktok.com/open_api/v1.3/adgroup/get/', 'adgroup_id', 'adgroup_name'),
                ])
                return {
                    campaigns: campaigns.map,
                    ads: ads.map,
                    adgroups: adgroups.map,
                    padresAds: ads.padres,
                    padresAdgroups: adgroups.padres,
                }
            })
        }

        const emptyMetaRecord = (apiSuccess: boolean) => ({
            spend: 0, impressions: 0, clicks: 0, account_reach: 0, account_spend: 0,
            campaigns: [] as any[], meta_ads: [] as any[], meta_adsets: [] as any[], forms: [] as any[], apiSuccess,
        })

        // ─── Meta: paginación de /insights siguiendo data.paging.next ───
        // Con time_increment=1 sobre un rango, una sola página (limit) puede no alcanzar
        // (días × campañas). Sin paginar se perderían filas EN SILENCIO → seguimos
        // paging.next hasta agotar. Devuelve ok=false ante error/respuesta malformada.
        async function metaInsightsPaged(firstUrl: string): Promise<{ ok: boolean; list: any[]; error?: any }> {
            const all: any[] = []
            let next: string | null = firstUrl
            let pages = 0
            const MAX_PAGES = 200 // backstop de seguridad
            while (next && pages < MAX_PAGES) {
                const res = await metaFetch(next)
                const data = await res.json()
                if (!data || data.error || !Array.isArray(data.data)) {
                    return { ok: false, list: all, error: data?.error ?? data }
                }
                all.push(...data.data)
                next = data.paging?.next || null
                pages++
            }
            return { ok: true, list: all }
        }

        // ─── Helper: Fetch Meta Ads for a single account, RANGO COMPLETO ───
        // Pide TODO el rango en UNA llamada paginada por nivel (time_increment=1 → una
        // fila por día con date_start) en vez de una llamada por día.
        // Devuelve Map<fecha, record> + apiSuccess del rango completo.
        async function fetchMetaSingleAccountRange(startDate: string, endDate: string, rawAccountId: string, token: string) {
            const byDate = new Map<string, any>()
            let apiSuccess = false
            const actId = rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`

            const ensureDay = (day: string) => {
                let rec = byDate.get(day)
                if (!rec) { rec = emptyMetaRecord(true); byDate.set(day, rec) }
                return rec
            }

            try {
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                url.searchParams.append('access_token', token)
                url.searchParams.append('time_range', JSON.stringify({ since: startDate, until: endDate }))
                url.searchParams.append('time_increment', '1')
                url.searchParams.append('fields', 'campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions')
                url.searchParams.append('action_attribution_windows', META_ATTRIBUTION_WINDOWS)
                url.searchParams.append('level', 'campaign')
                url.searchParams.append('limit', '500')

                const paged = await metaInsightsPaged(url.toString())
                if (paged.ok) {
                    // La API respondió correctamente (puede no traer filas = sin gasto en el rango).
                    apiSuccess = true

                    // Agrupar filas por día (date_start), luego procesar cada día con la MISMA lógica.
                    const rowsByDay = new Map<string, any[]>()
                    for (const camp of paged.list) {
                        const day = camp.date_start
                        if (!day) continue
                        const arr = rowsByDay.get(day) || []
                        arr.push(camp)
                        rowsByDay.set(day, arr)
                    }

                    for (const [day, dayRows] of rowsByDay) {
                    const campaignsArr: any[] = []

                    dayRows.forEach((camp: any) => {
                        const cSpend = parseFloat(camp.spend || '0')
                        const cImpr = parseInt(camp.impressions || '0')
                        const cClicks = parseInt(camp.clicks || '0')
                        const cLinkClicks = parseInt(camp.inline_link_clicks || '0')
                        const cReach = parseInt(camp.reach || '0')
                        const cFrequency = parseFloat(camp.frequency || '0')
                        const cCpc = parseFloat(camp.cpc || '0')
                        const cCpm = parseFloat(camp.cpm || '0')
                        const cCtr = parseFloat(camp.ctr || '0')

                        let cVideoThruplay = 0, cVideo3s = 0, cResults = 0
                        const cCustomConversions: Record<string, number> = {}

                        // Totales por familia de acción (máximo entre variantes nativa/omni/píxel).
                        const { fam, exact } = parseMetaActions(camp.actions)
                        const cLeads = fam.lead
                        // Leads de formulario: SOLO los envíos nativos de Lead Ads.
                        const cLeadsForm = exact['lead'] ?? 0
                        const cPurchases = fam.purchase
                        const cCompleteRegistration = fam.complete_registration
                        const cAddsToCart = fam.add_to_cart
                        const cInitiatesCheckout = fam.initiate_checkout
                        const cLandingPageViews = fam.landing_page_view
                        const cVideoViews = fam.video_view
                        const cViewContent = fam.view_content
                        const cSearch = fam.search
                        const cAddToWishlist = fam.add_to_wishlist
                        const cCustomizeProduct = fam.customize_product
                        const cContact = fam.contact
                        const cSchedule = fam.schedule
                        const cStartTrial = fam.start_trial
                        const cSubmitApplication = fam.submit_application
                        const cSubscribe = fam.subscribe
                        const cFindLocation = fam.find_location
                        const cDonate = fam.donate
                        const cMessagingConversations = fam.messaging
                        const cPageEngagement = fam.page_engagement
                        const cPostEngagement = fam.post_engagement
                        const cPostReactions = fam.post_reaction
                        const cPostShares = fam.post_share
                        const cPostSaves = fam.post_save
                        const cPostComments = fam.comment

                        // ThruPlay: campo propio en la respuesta de Meta.
                        if (camp.video_thruplay_watched_actions) {
                            camp.video_thruplay_watched_actions.forEach((a: any) => { cVideoThruplay += parseInt(a.value || '0') })
                        }
                        // Vistas de 3s: Meta retiró `video_p3_watched_actions` (y `video_3_sec_watched_actions`)
                        // del parámetro fields — pedirlo devolvía (#100) y tumbaba TODA la llamada de insights,
                        // dejando la cuenta entera sin datos. El equivalente vivo es la acción `video_view`,
                        // que es justamente la reproducción de ≥3 segundos.
                        cVideo3s = cVideoViews

                        if (camp.conversions) {
                            camp.conversions.forEach((cv: any) => {
                                const type: string = cv.action_type || ''
                                const val = parseInt(cv.value || '0')
                                if (type.startsWith('offsite_conversion.fb_pixel_custom.')) {
                                    const key = type.replace('offsite_conversion.fb_pixel_custom.', '').toLowerCase()
                                    cCustomConversions[key] = (cCustomConversions[key] || 0) + val
                                } else if (type.startsWith('offsite_conversion.custom.')) {
                                    const key = type.replace('offsite_conversion.custom.', '').toLowerCase()
                                    cCustomConversions[key] = (cCustomConversions[key] || 0) + val
                                }
                            })
                        }

                        cResults = cLeads + cPurchases + cInitiatesCheckout

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
                    const rec = ensureDay(day)
                    // La columna sale del array YA deduplicado, no de la suma previa.
                    // Si Meta repite una fila de campaña (misma campaign_id en el día),
                    // sumar antes del dedup inflaba la columna mientras el array —que es
                    // lo que suma el dashboard— quedaba correcto. Recalcular aquí los
                    // mantiene idénticos (columna == Σ meta_campaigns[].spend).
                    rec.spend = dedupedCampaigns.reduce((s: number, c) => s + (c.spend || 0), 0)
                    rec.impressions = dedupedCampaigns.reduce((s: number, c) => s + (c.impressions || 0), 0)
                    rec.clicks = dedupedCampaigns.reduce((s: number, c) => s + (c.clicks || 0), 0)
                    rec.campaigns = dedupedCampaigns
                    log(`[Meta] ${day} [${rawAccountId}] Spend: ${rec.spend}, Campañas: ${dedupedCampaigns.length}`)
                    } // ← cierre del loop por día (rowsByDay)

                    // Reach y gasto a nivel de cuenta para TODO el rango
                    // (level=account + time_increment=1 → una fila por día).
                    //
                    // El `spend` de aquí es la FUENTE DE VERDAD para detectar días
                    // con el desglose por campaña incompleto: el dashboard suma
                    // `meta_campaigns[]` filtrado por keyword, así que un array a
                    // medias muestra $0 en un día que sí tuvo gasto. Cuesta una
                    // sola fila por día, así que se pide siempre.
                    try {
                        const reachUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                        reachUrl.searchParams.append('access_token', token)
                        reachUrl.searchParams.append('time_range', JSON.stringify({ since: startDate, until: endDate }))
                        reachUrl.searchParams.append('time_increment', '1')
                        reachUrl.searchParams.append('fields', 'reach,spend')
                        reachUrl.searchParams.append('level', 'account')
                        const reachPaged = await metaInsightsPaged(reachUrl.toString())
                        if (reachPaged.ok) {
                            for (const row of reachPaged.list) {
                                const day = row.date_start
                                if (!day) continue
                                const rec = ensureDay(day)
                                if (row.reach) rec.account_reach = parseInt(row.reach || '0')
                                if (row.spend != null) {
                                    rec.account_spend = (rec.account_spend || 0) + (parseFloat(row.spend || '0') || 0)
                                }
                            }
                        }
                    } catch (_e) { /* non-critical */ }

                    // Enriquecer con targeting/geo (cacheado por actId, no por día) — por cada día
                    for (const [, dRec] of byDate) {
                        dRec.campaigns = await enrichCampaignsWithTargeting(dRec.campaigns, token, actId)
                    }

                } else {
                    log(`[Meta] ${startDate}..${endDate} [${rawAccountId}] Error de API: ${JSON.stringify(paged.error)}`)
                }
            } catch (e: any) {
                log(`[Meta] [${rawAccountId}] Catch Error: ${e.message}`)
            }

        // ─── Helper: Fetch Meta at ad/adset level, RANGO COMPLETO → Map<fecha, item[]> ──
        async function fetchMetaAtLevelRange(level: 'ad' | 'adset'): Promise<Map<string, any[]>> {
            const flat = new Map<string, any[]>()
            try {
                const idField   = level === 'ad' ? 'ad_id'      : 'adset_id'
                const nameField = level === 'ad' ? 'ad_name'    : 'adset_name'
                const extraIds  = level === 'ad'
                    ? 'ad_id,ad_name,adset_id,adset_name,'
                    : 'adset_id,adset_name,'

                const levelUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                levelUrl.searchParams.append('access_token', token)
                levelUrl.searchParams.append('time_range', JSON.stringify({ since: startDate, until: endDate }))
                levelUrl.searchParams.append('time_increment', '1')
                levelUrl.searchParams.append('fields', `${extraIds}campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,reach,frequency,cpc,cpm,ctr,actions,conversions,video_thruplay_watched_actions`)
                levelUrl.searchParams.append('action_attribution_windows', META_ATTRIBUTION_WINDOWS)
                levelUrl.searchParams.append('level', level)
                levelUrl.searchParams.append('limit', '500')

                const paged = await metaInsightsPaged(levelUrl.toString())
                if (!paged.ok) {
                    log(`[Meta] fetchMetaAtLevelRange(${level}) error: ${JSON.stringify(paged.error)}`)
                    return flat
                }

                // Dedup por primary key DENTRO de cada día (time_increment=1 separa los días)
                const perDay = new Map<string, Map<string, any>>()
                paged.list.forEach((item: any) => {
                    const day = item.date_start
                    if (!day) return
                    let iVideoThruplay = 0, iVideo3s = 0
                    let iResults = 0
                    const iCustomConversions: Record<string, number> = {}

                    // Mismo criterio que a nivel campaña: familias con máximo entre variantes.
                    const { fam: iFam, exact: iExact } = parseMetaActions(item.actions)
                    const iLeads = iFam.lead
                    const iLeadsForm = iExact['lead'] ?? 0
                    const iPurchases = iFam.purchase
                    const iCompleteRegistration = iFam.complete_registration
                    const iAddsToCart = iFam.add_to_cart
                    const iInitiatesCheckout = iFam.initiate_checkout
                    const iLandingPageViews = iFam.landing_page_view
                    const iVideoViews = iFam.video_view
                    const iViewContent = iFam.view_content
                    const iSearch = iFam.search
                    const iAddToWishlist = iFam.add_to_wishlist
                    const iCustomizeProduct = iFam.customize_product
                    const iContact = iFam.contact
                    const iSchedule = iFam.schedule
                    const iStartTrial = iFam.start_trial
                    const iSubmitApplication = iFam.submit_application
                    const iSubscribe = iFam.subscribe
                    const iFindLocation = iFam.find_location
                    const iDonate = iFam.donate
                    const iMessagingConversations = iFam.messaging
                    const iPageEngagement = iFam.page_engagement
                    const iPostEngagement = iFam.post_engagement
                    const iPostReactions = iFam.post_reaction
                    const iPostShares = iFam.post_share
                    const iPostSaves = iFam.post_save
                    const iPostComments = iFam.comment

                    if (item.video_thruplay_watched_actions) {
                        item.video_thruplay_watched_actions.forEach((a: any) => { iVideoThruplay += parseInt(a.value || '0') })
                    }
                    // Mismo criterio que a nivel campaña: `video_view` = reproducción de ≥3s.
                    iVideo3s = iVideoViews

                    if (item.conversions) {
                        item.conversions.forEach((cv: any) => {
                            const type: string = cv.action_type || ''
                            const val = parseInt(cv.value || '0')
                            if (type.startsWith('offsite_conversion.fb_pixel_custom.')) {
                                const key = type.replace('offsite_conversion.fb_pixel_custom.', '').toLowerCase()
                                iCustomConversions[key] = (iCustomConversions[key] || 0) + val
                            } else if (type.startsWith('offsite_conversion.custom.')) {
                                const key = type.replace('offsite_conversion.custom.', '').toLowerCase()
                                iCustomConversions[key] = (iCustomConversions[key] || 0) + val
                            }
                        })
                    }

                    iResults = iLeads + iPurchases + iInitiatesCheckout

                    const out: any = {
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
                    }
                    const dayMap = perDay.get(day) || new Map<string, any>()
                    dayMap.set(out[idField] || out[nameField], out)
                    perDay.set(day, dayMap)
                })

                for (const [day, m] of perDay) flat.set(day, Array.from(m.values()))
                return flat
            } catch (e: any) {
                log(`[Meta] fetchMetaAtLevelRange(${level}) error: ${e.message}`)
                return flat
            }
        }

        // ─── Fetch ads + adsets para TODO el rango, en paralelo → asignar por día ──
        const [adsByDate, adsetsByDate] = await Promise.all([
            fetchMetaAtLevelRange('ad'),
            fetchMetaAtLevelRange('adset'),
        ])
        for (const [day, ads] of adsByDate) ensureDay(day).meta_ads = ads
        for (const [day, adsets] of adsetsByDate) ensureDay(day).meta_adsets = adsets

            // ─── Lead form breakdown (Meta Lead Ads) para TODO el rango ──────────
            try {
                // 1) Catálogo de nombres de forms — cacheado por cuenta (no por día)
                const nameMap = await memo(metaFormCatalogCache, actId, () => loadMetaFormCatalog(actId, token))

                // 2) Insights breakdown by leadgen_form_id (level=ad), una fila por día (time_increment=1)
                const formUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                formUrl.searchParams.append('access_token', token)
                formUrl.searchParams.append('time_range', JSON.stringify({ since: startDate, until: endDate }))
                formUrl.searchParams.append('time_increment', '1')
                formUrl.searchParams.append('fields', 'leadgen_form_id,spend,impressions,clicks,actions')
                formUrl.searchParams.append('action_attribution_windows', META_ATTRIBUTION_WINDOWS)
                formUrl.searchParams.append('breakdowns', 'leadgen_form_id')
                formUrl.searchParams.append('level', 'ad')
                formUrl.searchParams.append('limit', '500')

                const formPaged = await metaInsightsPaged(formUrl.toString())
                if (formPaged.ok) {
                    // Acumular forms por día (clave: día → form_id → métricas)
                    const perDay = new Map<string, Map<string, any>>()
                    for (const item of formPaged.list) {
                        const day = item.date_start
                        const formId: string = item.leadgen_form_id || ''
                        if (!day || !formId) continue

                        const formsMap = perDay.get(day) || new Map<string, any>()
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
                        perDay.set(day, formsMap)
                    }
                    for (const [day, m] of perDay) ensureDay(day).forms = Array.from(m.values())
                }
            } catch (err: any) {
                log(`[Meta] Form breakdown fetch failed (non-critical): ${err?.message}`)
            }

            return { byDate, apiSuccess }
        }

        // ─── Multi-account wrapper (RANGO): consolida todas las cuentas por fecha ──
        async function fetchMetaRange(startDate: string, endDate: string) {
            const byDate = new Map<string, any>()

            // Build account list — multi-account if configured, legacy fallback otherwise
            let accountsToFetch: { account_id: string; token: string }[] = []
            if (config.meta_accounts && Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) {
                accountsToFetch = config.meta_accounts
                    .filter((a: any) => a.account_id)
                    .map((a: any) => ({ account_id: a.account_id, token: a.token || config.meta_token || '' }))
            } else if (config.meta_token && config.meta_account_id) {
                accountsToFetch = [{ account_id: config.meta_account_id, token: config.meta_token }]
            }

            // Dedup por account_id normalizado (con/sin prefijo act_): la misma cuenta
            // repetida en la config duplicaría su gasto. El array de campañas ya se
            // protege con dedup cross-cuenta, pero la columna se sumaba por cuenta.
            // Se conserva la primera aparición (su token).
            const seenMetaActIds = new Set<string>()
            accountsToFetch = accountsToFetch.filter((a) => {
                const norm = a.account_id.startsWith('act_') ? a.account_id : `act_${a.account_id}`
                if (seenMetaActIds.has(norm)) return false
                seenMetaActIds.add(norm)
                return true
            })

            if (accountsToFetch.length === 0) {
                log(`[Meta] Sin config para el cliente.`)
                return { byDate, apiSuccess: false, configured: false }
            }

            // Fetch all accounts in parallel for the whole range
            const accountResults = await Promise.all(
                accountsToFetch.map(({ account_id, token }) => fetchMetaSingleAccountRange(startDate, endDate, account_id, token))
            )

            let apiSuccess = false
            let anyData = false
            // Merge results from all accounts, per day
            for (const r of accountResults) {
                if (r.apiSuccess) apiSuccess = true
                for (const [day, src] of r.byDate as Map<string, any>) {
                    const record = byDate.get(day) || emptyMetaRecord(true)
                    record.spend += src.spend
                    record.impressions += src.impressions
                    record.clicks += src.clicks
                    record.account_reach += src.account_reach  // suma de reach deduplicado por cuenta
                    record.account_spend += (src.account_spend || 0)  // gasto real de la cuenta (control de integridad)
                    // Inyectar account_reach en cada campaña para poder filtrarlo en el dashboard
                    const campaignsWithReach = src.campaigns.map((c: any) => ({
                        ...c,
                        account_reach: src.account_reach,
                    }))
                    record.campaigns.push(...campaignsWithReach)
                    record.meta_ads.push(...(src.meta_ads || []))
                    record.meta_adsets.push(...(src.meta_adsets || []))
                    if (src.campaigns.length > 0 || src.spend > 0) anyData = true
                    // Merge forms: sum metrics for same form_id across accounts
                    for (const f of (src.forms || [])) {
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

                    byDate.set(day, record)
                }
            }

            // Dedup cross-cuenta POR DÍA (campaign_id es único global en Meta) y
            // recolección de claves de custom conversions de TODOS los días.
            const allCustomKeys = new Set<string>()
            for (const [, record] of byDate) {
                if (accountsToFetch.length > 1 && record.campaigns.length > 0) {
                    const crossDedup = new Map<string, any>()
                    for (const c of record.campaigns) {
                        const key = c.campaign_id || `${c.account_id}:${c.name}`
                        crossDedup.set(key, c)
                    }
                    record.campaigns = Array.from(crossDedup.values())
                    // Recalcular la columna desde el array ya deduplicado cross-cuenta:
                    // si la misma cuenta estuviera configurada dos veces, `record.spend`
                    // (sumado por cuenta más arriba) la contaría doble mientras el array
                    // queda correcto. Recalcular garantiza columna == Σ array también
                    // en multi-cuenta, que es lo que muestra el dashboard.
                    record.spend = record.campaigns.reduce((s: number, c: { spend?: number }) => s + (c.spend || 0), 0)
                    record.impressions = record.campaigns.reduce((s: number, c: { impressions?: number }) => s + (c.impressions || 0), 0)
                    record.clicks = record.campaigns.reduce((s: number, c: { clicks?: number }) => s + (c.clicks || 0), 0)
                }
                record.campaigns.forEach((camp: any) => {
                    if (camp.custom_conversions) {
                        Object.keys(camp.custom_conversions).forEach((k) => allCustomKeys.add(k))
                    }
                })
            }
            // El enriquecimiento de targeting/geo ya se hizo por cuenta dentro de
            // fetchMetaSingleAccountRange (cacheado por actId), y el spread del merge
            // preserva `targeting_regions` en cada campaña.

            platformLogs.meta = !apiSuccess ? 'Error/Desconectado' : (anyData ? 'Conectado OK' : 'Sin Datos')
            log(`[Meta] ${startDate}..${endDate} Total consolidado — días con datos: ${byDate.size}`)

            // Auto-discover custom conversions → upsert into catalog (last_seen = fin del rango)
            if (allCustomKeys.size > 0) {
                const customConversionNames: Record<string, string> = {}
                await Promise.all(
                    accountsToFetch.map(async ({ account_id, token }) => {
                        try {
                            const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`
                            const ccUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/customconversions`)
                            ccUrl.searchParams.append('access_token', token)
                            ccUrl.searchParams.append('fields', 'id,name')
                            const res = await fetch(ccUrl.toString())
                            const ccData = await res.json()
                            if (ccData.data) {
                                ccData.data.forEach((cc: any) => {
                                    customConversionNames[cc.id] = cc.name
                                })
                            }
                        } catch (e: any) {
                            log(`[Meta] Error consultando customconversions (non-critical): ${e?.message}`)
                        }
                    })
                )

                const catalogRows = Array.from(allCustomKeys).map((key) => {
                    const isNumeric = /^\d+$/.test(key)
                    let label = ''
                    if (isNumeric && customConversionNames[key]) {
                        label = customConversionNames[key]
                    } else {
                        const cleanLabel = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
                        label = `Lead ${cleanLabel.replace('Lead', '').trim() || cleanLabel}`
                    }
                    return {
                        cliente_id: cliente.id,
                        conversion_key: key,
                        label: label,
                        field_id: `meta_custom_${key}`,
                        last_seen: endDate,
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

            return { byDate, apiSuccess, configured: true }
        }

        const emptyTikTokRecord = (apiSuccess: boolean) => ({
            spend: 0, impressions: 0, clicks: 0, conversions: 0, account_spend: 0,
            campaigns: [] as any[], tiktok_ads: [] as any[], tiktok_adgroups: [] as any[], apiSuccess,
        })

        // ─── Helper: Fetch TikTok Ads for a single advertiser account, RANGO COMPLETO ───
        // Pide TODO el rango en UNA llamada por nivel (añadiendo `stat_time_day` a las
        // dimensiones) en vez de una llamada por día → reduce drásticamente las llamadas.
        // Devuelve un Map<fecha, record> + apiSuccess del rango completo.
        async function fetchTikTokSingleAccountRange(startDate: string, endDate: string, advertiserId: string, token: string) {
            const byDate = new Map<string, any>()
            let apiSuccess = false
            log(`[TikTok] Rango ${startDate}..${endDate} Consultando advertiser_id: ${advertiserId}`)

            const ensureDay = (day: string) => {
                let rec = byDate.get(day)
                if (!rec) { rec = emptyTikTokRecord(true); byDate.set(day, rec) }
                return rec
            }

            try {
                // Catálogo de nombres (campaign/ad/adgroup) — cacheado por cuenta,
                // se carga UNA vez por rango (no por día). Ver loadTikTokNames.
                const tkNames = await loadTikTokNames(advertiserId, token)
                const campaignMap = tkNames.campaigns

                // ─── Helper: fetch ad/adgroup level para TODO el rango ─────
                // Devuelve Map<fecha, item[]> deduplicado por id dentro de cada día.
                async function fetchTikTokAtLevelRange(level: 'ad' | 'adgroup'): Promise<Map<string, any[]>> {
                    const flat = new Map<string, any[]>()
                    try {
                        const dataLevel = level === 'ad' ? 'AUCTION_AD' : 'AUCTION_ADGROUP'
                        const idDim     = level === 'ad' ? 'ad_id'      : 'adgroup_id'
                        const idKey     = level === 'ad' ? 'ad_id'      : 'adgroup_id'
                        const nameKey   = level === 'ad' ? 'ad_name'    : 'adgroup_name'

                        // Nombres ya cargados desde la caché por cuenta (no se vuelve a pedir)
                        const nameMap = level === 'ad' ? tkNames.ads : tkNames.adgroups
                        // Jerarquía: a qué campaña (y conjunto) pertenece cada entidad.
                        const padres = level === 'ad' ? tkNames.padresAds : tkNames.padresAdgroups

                        const dims = [idDim, 'stat_time_day']

                        const rptUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
                        rptUrl.searchParams.append('advertiser_id', advertiserId)
                        rptUrl.searchParams.append('report_type', 'BASIC')
                        rptUrl.searchParams.append('data_level', dataLevel)
                        rptUrl.searchParams.append('dimensions', JSON.stringify(dims))
                        rptUrl.searchParams.append('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']))
                        rptUrl.searchParams.append('start_date', startDate)
                        rptUrl.searchParams.append('end_date', endDate)

                        const rptPaged = await fetchTikTokPaged(rptUrl, token)
                        if (!rptPaged.ok) {
                            log(`[TikTok] fetchTikTokAtLevelRange(${level}) error: ${rptPaged.message}`)
                            return flat
                        }

                        // Dedup por id DENTRO de cada día (stat_time_day separa los días)
                        const perDay = new Map<string, Map<string, any>>()
                        rptPaged.list.forEach((item: any) => {
                            const d  = item.dimensions || {}
                            const m  = item.metrics    || {}
                            const day = String(d.stat_time_day || '').slice(0, 10)
                            if (!day) return
                            const id = String(d[idDim] || '')
                            const dayMap = perDay.get(day) || new Map<string, any>()
                            const padre = padres.get(id)
                            const campaignId = padre?.campaign_id ?? null
                            dayMap.set(id || nameMap.get(id) || 'Desconocido', {
                                [idKey]:     id || null,
                                [nameKey]:   nameMap.get(id) || id || 'Desconocido',
                                // Campaña padre: la necesita el filtro por keyword del
                                // dashboard y del motor BI, que casan por NOMBRE.
                                campaign_id:   campaignId,
                                campaign_name: campaignId ? (campaignMap.get(campaignId) || null) : null,
                                // Un anuncio cuelga además de un conjunto.
                                ...(level === 'ad' && padre?.adgroup_id ? {
                                    adset_id:   padre.adgroup_id,
                                    adset_name: tkNames.adgroups.get(padre.adgroup_id) || null,
                                } : {}),
                                spend:       parseFloat(m.spend       || '0'),
                                impressions: parseInt(m.impressions   || '0'),
                                clicks:      parseInt(m.clicks        || '0'),
                                conversions: parseInt(m.conversion    || '0'),
                                account_id:  advertiserId,
                            })
                            perDay.set(day, dayMap)
                        })
                        for (const [day, m] of perDay) flat.set(day, Array.from(m.values()))
                        log(`[TikTok] ${startDate}..${endDate} ${level}: ${flat.size} días con registros`)
                        return flat
                    } catch (e: any) {
                        log(`[TikTok] fetchTikTokAtLevelRange(${level}) catch: ${e.message}`)
                        return flat
                    }
                }

                // Reporte campaign-level para TODO el rango (clave: campaign_id + stat_time_day)
                const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
                url.searchParams.append('advertiser_id', advertiserId)
                url.searchParams.append('report_type', 'BASIC')
                url.searchParams.append('data_level', 'AUCTION_CAMPAIGN')
                url.searchParams.append('dimensions', JSON.stringify(['campaign_id', 'stat_time_day']))
                url.searchParams.append('metrics', JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']))
                url.searchParams.append('start_date', startDate)
                url.searchParams.append('end_date', endDate)

                const campReport = await fetchTikTokPaged(url, token)

                if (campReport.ok) {
                    apiSuccess = true
                    if (campReport.list.length > 0) {
                        log(`[TikTok] ${startDate}..${endDate} RAW primer resultado: ${JSON.stringify(campReport.list[0])}`)
                    }

                    campReport.list.forEach((camp: any) => {
                        const dims = camp.dimensions || {}
                        const mets = camp.metrics || {}
                        const day = String(dims.stat_time_day || '').slice(0, 10)
                        if (!day) return
                        const cSpend = parseFloat(mets.spend || '0')
                        const cImpr = parseInt(mets.impressions || '0')
                        const cClicks = parseInt(mets.clicks || '0')
                        const cConv = parseInt(mets.conversion || '0')

                        const rec = ensureDay(day)
                        rec.spend += cSpend
                        rec.impressions += cImpr
                        rec.clicks += cClicks
                        rec.conversions += cConv

                        const cId = (dims.campaign_id || '').toString()
                        rec.campaigns.push({
                            campaign_id: cId || null,
                            name: campaignMap.get(cId) || 'Desconocida',
                            spend: cSpend,
                            impressions: cImpr,
                            clicks: cClicks,
                            conversions: cConv,
                            account_id: advertiserId,
                        })
                    })

                    // ad-level y adgroup-level para TODO el rango, en paralelo
                    const [adsByDate, adgroupsByDate] = await Promise.all([
                        fetchTikTokAtLevelRange('ad'),
                        fetchTikTokAtLevelRange('adgroup'),
                    ])
                    for (const [day, ads] of adsByDate) ensureDay(day).tiktok_ads = ads
                    for (const [day, ag] of adgroupsByDate) ensureDay(day).tiktok_adgroups = ag

                    // Gasto a nivel de ANUNCIANTE: fuente de verdad para detectar que
                    // el desglose por campaña quedó incompleto. El dashboard suma el
                    // array, no la columna, así que un array a medias muestra de menos.
                    // Cuesta una fila por día.
                    try {
                        const advUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/')
                        advUrl.searchParams.append('advertiser_id', advertiserId)
                        advUrl.searchParams.append('report_type', 'BASIC')
                        advUrl.searchParams.append('data_level', 'AUCTION_ADVERTISER')
                        advUrl.searchParams.append('dimensions', JSON.stringify(['stat_time_day']))
                        advUrl.searchParams.append('metrics', JSON.stringify(['spend']))
                        advUrl.searchParams.append('start_date', startDate)
                        advUrl.searchParams.append('end_date', endDate)
                        const advReport = await fetchTikTokPaged(advUrl, token)
                        if (advReport.ok) {
                            for (const row of advReport.list) {
                                const day = String(row?.dimensions?.stat_time_day ?? '').slice(0, 10)
                                if (!day) continue
                                ensureDay(day).account_spend += parseFloat(row?.metrics?.spend || '0') || 0
                            }
                        }
                    } catch (_e) { /* non-critical: solo es control de integridad */ }

                    log(`[TikTok] ${startDate}..${endDate} [${advertiserId}] días con datos: ${byDate.size}`)
                } else {
                    log(`[TikTok] ${startDate}..${endDate} [${advertiserId}] Error de API: ${campReport.message}`)
                }
            } catch (e: any) {
                log(`[TikTok] [${advertiserId}] Catch Error: ${e.message}`)
            }
            return { byDate, apiSuccess }
        }

        // ─── Multi-account wrapper (RANGO): consolida todas las cuentas por fecha ───
        async function fetchTikTokRange(startDate: string, endDate: string) {
            const byDate = new Map<string, any>()

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

            // Dedup por advertiser_id: la misma cuenta repetida en la config sumaría
            // su gasto dos veces (aquí sí se suma por cuenta directamente).
            const seenAdvIds = new Set<string>()
            accountsToFetch = accountsToFetch.filter((a) => {
                if (seenAdvIds.has(a.advertiser_id)) return false
                seenAdvIds.add(a.advertiser_id)
                return true
            })

            if (accountsToFetch.length === 0) {
                platformLogs.tiktok = 'Sin configurar'
                log(`[TikTok] ${startDate}..${endDate} Sin cuentas configuradas`)
                return { byDate, apiSuccess: false, configured: false }
            }

            const results = await Promise.all(
                accountsToFetch.map(({ advertiser_id, token }) =>
                    fetchTikTokSingleAccountRange(startDate, endDate, advertiser_id, token)
                )
            )

            let apiSuccess = false
            for (const r of results) {
                if (r.apiSuccess) apiSuccess = true
                for (const [day, rec] of r.byDate as Map<string, any>) {
                    const acc = byDate.get(day) || emptyTikTokRecord(true)
                    acc.spend       += rec.spend
                    acc.impressions += rec.impressions
                    acc.clicks      += rec.clicks
                    acc.conversions += rec.conversions
                    acc.account_spend += (rec.account_spend || 0)  // control de integridad
                    acc.campaigns.push(...rec.campaigns)
                    acc.tiktok_ads.push(...rec.tiktok_ads)
                    acc.tiktok_adgroups.push(...rec.tiktok_adgroups)
                    byDate.set(day, acc)
                }
            }

            platformLogs.tiktok = !apiSuccess ? 'Error/Desconectado' : (byDate.size > 0 ? 'Conectado OK' : 'Sin Datos')
            log(`[TikTok] ${startDate}..${endDate} Total — días con datos: ${byDate.size}, Cuentas: ${accountsToFetch.length}`)
            return { byDate, apiSuccess, configured: true }
        }

        // ─── Helper: Fetch Hotmart for a single date ────────────────────────
        // Devuelve totales globales + desglose por funnel (tab) + extras.
        // Pagos iniciados se mide desde GA4 (no se consulta WAITING_PAYMENT).
        // ─── Hotmart ─────────────────────────────────────────────────────────
        //
        // Antes esto eran ~270 líneas inline: dos bucles de paginación con las
        // guardas duplicadas, la conversión de moneda, la clasificación por
        // nombre de producto y la acumulación, todo entrelazado. Ahora son dos
        // pasos separados en `src/lib/hotmart/sync.ts`:
        //
        //   1. sincronizarDiaHotmart → API → public.hotmart_ventas
        //   2. agregarDesdeHotmartVentas → tabla → este registro diario
        //
        // Separarlos permite reclasificar el histórico (cambiar el mapa de
        // ofertas y reagregar) sin gastar una sola petición a Hotmart.
        //
        // ── LA TRAMPA DE LA TABLA INTERMEDIA ────────────────────────────
        // Un fallo a media paginación deja `hotmart_ventas` PARCIALMENTE escrita.
        // Agregar entonces daría un número bajo pero DISTINTO DE CERO, que se
        // colaría por la guarda `hotmartInconsistent` (que solo mira si el conteo
        // es 0) y pisaría las ventas buenas con una cifra a medias.
        //
        // Por eso, si `completo === false` NO se agrega: se devuelve un registro
        // vacío con `apiSuccess: false` y la red de seguridad de siempre omite los
        // campos de Hotmart del upsert, preservando lo que ya había.
        async function fetchHotmart(targetDate: string): Promise<RegistroHotmart> {
            if (!hotmartAccessToken) {
                log(`[Hotmart] Sin accessToken generado.`)
                const r = registroVacio()
                for (const f of hotmartFunnels) r.by_tab[f.tab_id] = desgloseVacio()
                // Configurado pero sin token = fallo de auth, no "sin Hotmart":
                // devolver ceros pisaría las ventas ya guardadas.
                if (hotmartConfigured) r.apiSuccess = false
                return r
            }
            try {
                const sync = await sincronizarDiaHotmart(
                    adminSupabase, cliente.id, targetDate, hotmartAccessToken, hotmartFunnels, log,
                )

                if (!sync.completo) {
                    log(`[Hotmart] ${targetDate} sincronización INCOMPLETA (${sync.motivo ?? 'sin motivo'}) — no se agrega, se preservan los datos previos.`)
                    platformLogs.hotmart = 'Error API'
                    const r = registroVacio()
                    for (const f of hotmartFunnels) r.by_tab[f.tab_id] = desgloseVacio()
                    r.apiSuccess = false
                    r.familia = sync.familia
                    return r
                }

                const registro = await agregarDesdeHotmartVentas(
                    adminSupabase, cliente.id, targetDate, hotmartFunnels,
                )
                // Los importes sin tasa de cambio los detecta la agregación al leer
                // `bruto_usd IS NULL`, no la descarga: así también salen a la luz los
                // que quedaron sin convertir en corridas anteriores.
                if (registro.unconverted_count > 0) {
                    log(`[Hotmart] ${targetDate} ${registro.unconverted_count} importe(s) sin tasa de cambio (monedas: ${registro.monedas.join(', ')}) — quedaron fuera del total.`)
                }
                log(`[Hotmart] ${targetDate} ${sync.ventas} tx traídas (${sync.escritas} escritas, ${sync.descartadas} descartadas por orden), ${registro.ventas_count} cobradas, cobertura ${registro.cobertura_pct}%`)
                return registro
            } catch (e: any) {
                log(`[Hotmart] Catch Error: ${e.message}`)
                // Sin esto, una excepción a mitad de la paginación devolvía un record
                // parcial en ceros que se upserteaba sobre las ventas reales.
                const r = registroVacio()
                for (const f of hotmartFunnels) r.by_tab[f.tab_id] = desgloseVacio()
                r.apiSuccess = false
                platformLogs.hotmart = 'Error'
                return r
            }
        }

        // ─── Fetch GA4 ───
        // Devuelve métricas globales + page views por funnel (payment_page + upsell_page).
        type GARecord = {
            sessions: number
            bounceRate: number
            avgSessionDuration: number
            // Por tab_id: { payment_page_views, upsell_page_views, landing_sessions }
            funnel_pages: Record<string, { payment_page_views: number; upsell_page_views: number; landing_sessions: number }>
            /** false = GA4 falló → NO pisar la BD con ceros. */
            apiSuccess: boolean
            /** false = el cliente no tiene GA4 conectado (ceros son correctos). */
            configured: boolean
        }
        async function fetchGA4(targetDate: string): Promise<GARecord> {
            const record: GARecord = { sessions: 0, bounceRate: 0, avgSessionDuration: 0, funnel_pages: {}, apiSuccess: true, configured: false }
            // Necesita una propiedad. La autenticación puede venir de:
            //  1) OAuth de agencia (preferido) — solo hace falta ga_property_id
            //  2) Service account legacy por cliente (ga_client_email + ga_private_key)
            const useAgencyOAuth = await hasAgencyGoogleConnection()
            const hasServiceAccount = !!(config.ga_client_email && config.ga_private_key)
            if (!config.ga_property_id || (!useAgencyOAuth && !hasServiceAccount)) {
                platformLogs.ga4 = 'Sin configurar'
                return record
            }
            record.configured = true

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
                // Antes el record en ceros se upserteaba igual y borraba las sesiones
                // ya guardadas para esa fecha.
                record.apiSuccess = false
                platformLogs.ga4 = 'Error'
            }

            return record
        }

        /**
         * Records vacíos para plataformas excluidas por `?platforms=`.
         *
         * Van marcados con `apiSuccess: false` a propósito: es exactamente la señal
         * que el guard de preservación usa para OMITIR esos campos del upsert. Así
         * un backfill de Meta no toca las ventas ni las sesiones ya guardadas.
         */
        const skippedHotmartRecord = (): RegistroHotmart => {
            const r = registroVacio()
            r.apiSuccess = false
            return r
        }
        const skippedGaRecord = (): GARecord => ({
            sessions: 0, bounceRate: 0, avgSessionDuration: 0, funnel_pages: {},
            apiSuccess: false, configured: true,
        })

        // ─── Pre-fetch existing rows: sync_hash (idempotencia) + datos previos por
        // plataforma (para detectar inconsistencias: cero nuevo vs. valor previo > 0) ───
        const { data: existingHashRows } = await adminSupabase
            .from('metricas_diarias')
            .select('fecha, sync_hash, meta_spend, tiktok_spend, meta_campaigns, tiktok_campaigns, ventas_principal, ventas_bump, ventas_upsell, ventas_principal_count, ga_sessions, source_synced_at')
            .eq('cliente_id', cliente.id)
            .in('fecha', datesToSync)
        const existingHashMap = new Map<string, string>(
            (existingHashRows || []).map((r: any) => [r.fecha, r.sync_hash])
        )
        // Fila previa completa por fecha — para los guards de preservación/inconsistencia.
        const existingRowMap = new Map<string, any>(
            (existingHashRows || []).map((r: any) => [r.fecha, r])
        )
        const hasMetaData = (r: any) => Number(r?.meta_spend) > 0 || (Array.isArray(r?.meta_campaigns) && r.meta_campaigns.length > 0)
        /**
         * ¿El desglose por campaña de esta fila respalda su columna `meta_spend`?
         *
         * El dashboard NO usa la columna cuando una pestaña filtra por keyword:
         * suma `meta_campaigns[].spend` de las campañas que matchean. Una fila con
         * gasto en la columna pero el array truncado muestra $0 ese día — que es
         * como se perdieron ~$90k de un cliente en 3 días de julio.
         *
         * Sin esta comprobación, `hasMetaData` daba true para esas filas y
         * `effectiveStart` las saltaba para siempre.
         */
        const rowConsistent = (columna: any, campanas: any) => {
            const col = Number(columna) || 0
            if (col <= 0) return true // sin gasto: nada que respaldar
            if (!Array.isArray(campanas)) return false
            return importesCuadran(col, sumarCampanas(campanas).total)
        }
        const metaRowConsistent = (r: any) => !!r && rowConsistent(r.meta_spend, r.meta_campaigns)
        /**
         * Mismo criterio para TikTok. `enrichTikTokRow` suma `tiktok_campaigns[]`
         * igual que Meta, y `TIKTOK_REFRESH_DAYS` es solo 3, así que una fila
         * incompleta se congelaba aún más rápido que en Meta.
         */
        const tiktokRowConsistent = (r: any) => !!r && rowConsistent(r.tiktok_spend, r.tiktok_campaigns)
        const hasTikTokData = (r: any) => Number(r?.tiktok_spend) > 0 || (Array.isArray(r?.tiktok_campaigns) && r.tiktok_campaigns.length > 0)
        const hasHotmartData = (r: any) => Number(r?.ventas_principal) > 0 || Number(r?.ventas_bump) > 0
            || Number(r?.ventas_upsell) > 0 || Number(r?.ventas_principal_count) > 0
        const hasGa4Data = (r: any) => Number(r?.ga_sessions) > 0

        // ─── Ventana de refresco: NO re-descargar fechas ya guardadas ───
        // Las plataformas reajustan los datos recientes, así que los últimos N días
        // siempre se re-piden; las fechas más antiguas que YA tienen datos en BD se
        // saltan (no se llama a la API). datesToSync está ordenado viejo→nuevo y las
        // fechas ISO (YYYY-MM-DD) comparan cronológicamente como strings.
        // `refresh_days` permite ampliarlos (el cierre de mes pide 35 para recoger
        // la reatribución tardía de Meta, que llega hasta 28 días después).
        const META_REFRESH_DAYS = refreshDaysOverride ?? 7    // Meta reajusta atribución ~7 días
        const TIKTOK_REFRESH_DAYS = refreshDaysOverride ?? 3  // TikTok reajusta ~pocos días
        const metaConfigured = (Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) || (!!config.meta_token && !!config.meta_account_id)
        const tiktokConfigured = (Array.isArray(config.tiktok_accounts) && config.tiktok_accounts.length > 0) || (!!config.tiktok_access_token && !!config.tiktok_advertiser_id)

        // Primera fecha (más antigua) que cae en la ventana o que aún no tiene datos en BD.
        // null = todas las fechas viejas ya están descargadas y fuera de ventana → no se pide nada.
        const effectiveStart = (refreshDays: number, hasData: (r: any) => boolean): string | null => {
            if (forceRefresh) return datesToSync[0] ?? null
            for (const d of datesToSync) {
                const ageDays = differenceInDays(new Date(), parseISO(d))
                if (ageDays <= refreshDays || !hasData(existingRowMap.get(d))) return d
            }
            return null
        }
        // Para Meta, "ya descargada" exige además que el desglose por campaña
        // cuadre con la columna: si no, la fecha vuelve a pedirse aunque sea vieja.
        const metaStart = metaConfigured && wantsPlatform('meta')
            ? effectiveStart(META_REFRESH_DAYS, (r: any) => hasMetaData(r) && metaRowConsistent(r))
            : null
        const tiktokStart = tiktokConfigured && wantsPlatform('tiktok')
            ? effectiveStart(TIKTOK_REFRESH_DAYS, (r: any) => hasTikTokData(r) && tiktokRowConsistent(r))
            : null

        // Una sola llamada por nivel/cuenta para TODO el rango efectivo (en vez de 1/día).
        const emptyRangeMeta = { byDate: new Map<string, any>(), apiSuccess: true, configured: metaConfigured }
        const emptyRangeTikTok = { byDate: new Map<string, any>(), apiSuccess: true, configured: tiktokConfigured }
        // Última fecha efectiva del cliente (puede ser anterior a endDateStr si el
        // final del rango cae en un mes congelado).
        const rangeEndStr = datesToSync[datesToSync.length - 1]
        const [metaResult, tiktokResult] = await Promise.all([
            metaStart ? fetchMetaRange(metaStart, rangeEndStr) : Promise.resolve(emptyRangeMeta),
            tiktokStart ? fetchTikTokRange(tiktokStart, rangeEndStr) : Promise.resolve(emptyRangeTikTok),
        ])
        const metaByDate = metaResult.byDate as Map<string, any>
        const tiktokByDate = tiktokResult.byDate as Map<string, any>
        if (metaStart && metaStart !== datesToSync[0]) log(`[Meta] No re-descarga: se piden desde ${metaStart} (rango pedido empezaba en ${datesToSync[0]})`)
        if (tiktokStart && tiktokStart !== datesToSync[0]) log(`[TikTok] No re-descarga: se piden desde ${tiktokStart} (rango pedido empezaba en ${datesToSync[0]})`)
        if (!metaStart && metaConfigured) log(`[Meta] Todas las fechas ya descargadas y fuera de ventana — sin llamadas a la API`)
        if (!tiktokStart && tiktokConfigured) log(`[TikTok] Todas las fechas ya descargadas y fuera de ventana — sin llamadas a la API`)

        // ─── Process all dates: chunked in parallel (Batching) ───
        // Meta/TikTok ya vienen del Map por rango; aquí solo se piden Hotmart y GA4 por día.
        // El chunk es palanca de memoria/scheduling (el pool de rate-limit ya gobierna la TASA).
        const totalAccounts = Math.max(1, (metaConfigured ? 1 : 0) + (tiktokConfigured ? 1 : 0))
        const CHUNK_SIZE = Math.max(4, Math.min(15, Math.floor(45 / totalAccounts)));
        const upsertPayloads: any[] = [];
        /** Fechas sin cambios de datos, pero que sí se re-verificaron en esta corrida. */
        const freshnessOnlyDates: string[] = [];
        let budgetCut = false;
        /** Primera fecha NO procesada al cortar por presupuesto (para reanudar). */
        let resumeFromDate: string | null = null;

        for (let i = 0; i < datesToSync.length; i += CHUNK_SIZE) {
            // Presupuesto: al agotarse se persiste lo acumulado y se corta limpio.
            // Antes la función simplemente moría a los 60s y se perdía el chunk entero.
            if (budgetExhausted()) {
                budgetCut = true
                resumeFromDate = datesToSync[i]
                log(`[Batch] Presupuesto de tiempo agotado — se persisten ${upsertPayloads.length} fecha(s) y se corta en ${resumeFromDate}`)
                break
            }
            const chunk = datesToSync.slice(i, i + CHUNK_SIZE);
            log(`[Batch] Procesando chunk de fechas en paralelo: ${chunk.join(', ')}`);

            const chunkResults = await Promise.all(
                chunk.map(async (targetDate) => {
                    // Hotmart y GA4 por día; Meta/TikTok salen del Map por rango.
                    // Con `platforms` acotado se devuelve un record vacío marcado como
                    // fallido: el guard de preservación omite esos campos del upsert
                    // en vez de escribir ceros sobre los datos existentes.
                    const [hotmartRecord, gaRecord] = await Promise.all([
                        wantsPlatform('hotmart') ? fetchHotmart(targetDate) : Promise.resolve(skippedHotmartRecord()),
                        wantsPlatform('ga4') ? fetchGA4(targetDate) : Promise.resolve(skippedGaRecord()),
                    ]);
                    // ¿Se pidió esta plataforma para esta fecha? (false = fecha vieja ya descargada)
                    const metaFetched = !!metaStart && targetDate >= metaStart
                    const tiktokFetched = !!tiktokStart && targetDate >= tiktokStart
                    const metaRecord = metaFetched ? (metaByDate.get(targetDate) ?? emptyMetaRecord(metaResult.apiSuccess)) : emptyMetaRecord(true)
                    const tiktokRecord = tiktokFetched ? (tiktokByDate.get(targetDate) ?? emptyTikTokRecord(tiktokResult.apiSuccess)) : emptyTikTokRecord(true)

                    return { targetDate, metaRecord, tiktokRecord, hotmartRecord, gaRecord, metaFetched, tiktokFetched };
                })
            );

            // Collect the results for the mass upsert list
            for (const res of chunkResults) {
                const { targetDate, metaRecord, tiktokRecord, hotmartRecord, gaRecord, metaFetched, tiktokFetched } = res;

                const daysAgo = differenceInDays(new Date(), parseISO(targetDate))
                const prevRow = existingRowMap.get(targetDate)

                // ─── Red de seguridad per-plataforma (Meta + TikTok) ───
                // Se OMITEN los campos de una plataforma del upsert (preservando lo que ya hay
                // en BD) cuando:
                //   • NO se pidió en esta corrida (fecha vieja ya descargada, fuera de ventana), o
                //   • la API falló de verdad (apiSuccess=false: red caída, error, throttle agotado), o
                //   • devolvió CERO donde la BD ya tenía datos (inconsistencia/posible desconexión).
                // Solo el fallo real o la inconsistencia (con datos previos) generan ALERTA;
                // el skip por "ya descargado" es esperado y silencioso.
                const hasAnyTikTokConfig = (Array.isArray(config.tiktok_accounts) && config.tiktok_accounts.length > 0) || !!config.tiktok_access_token
                const tiktokApiFailed = tiktokFetched && hasAnyTikTokConfig && !tiktokRecord.apiSuccess
                const tiktokInconsistent = tiktokFetched && hasAnyTikTokConfig && !tiktokApiFailed && tiktokRecord.spend === 0 && hasTikTokData(prevRow)
                const tiktokFailed = !tiktokFetched || tiktokApiFailed || tiktokInconsistent

                const hasAnyMetaConfig = (Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) || !!config.meta_token
                const metaApiFailed = metaFetched && hasAnyMetaConfig && !metaRecord.apiSuccess
                const metaInconsistent = metaFetched && hasAnyMetaConfig && !metaApiFailed && metaRecord.spend === 0 && hasMetaData(prevRow)
                const metaFailed = !metaFetched || metaApiFailed || metaInconsistent

                // Control de integridad del desglose: el gasto que la plataforma
                // reporta a nivel de CUENTA/ANUNCIANTE es la fuente de verdad. Si la
                // suma por campaña no lo alcanza, el array quedó incompleto y el
                // dashboard mostrará de menos (suma el array, no la columna). Se
                // avisa pero NO se bloquea el upsert: lo recién bajado sigue siendo
                // lo mejor que hay, y la reconciliación se encarga de repararlo.
                const avisarDesvio = (plataforma: string, fetched: boolean, failed: boolean, rec: any) => {
                    if (!fetched || failed) return
                    const cuenta = Number(rec?.account_spend) || 0
                    const campanas = Number(rec?.spend) || 0
                    if (cuenta <= 0 || importesCuadran(cuenta, campanas)) return
                    const desvio = cuenta - campanas
                    log(`[${plataforma}] ${targetDate} ⚠ desglose incompleto: cuenta=${cuenta.toFixed(2)} vs campañas=${campanas.toFixed(2)} (faltan ${desvio.toFixed(2)})`)
                    inconsistencyAlerts.push({
                        cliente: cliente.nombre,
                        platform: plataforma,
                        fecha: targetDate,
                        reason: `spend_mismatch:${desvio.toFixed(2)}`,
                    })
                }
                avisarDesvio('Meta', metaFetched, metaFailed, metaRecord)
                avisarDesvio('TikTok', tiktokFetched, tiktokFailed, tiktokRecord)

                // ─── Misma red de seguridad para Hotmart y GA4 ───
                // Estas dos plataformas escribían SIEMPRE: un error transitorio (token
                // vencido, 500 de Hotmart, cuota de GA4) metía ceros encima de ventas y
                // sesiones ya buenas, y el sync_hash cambiaba, así que ni se saltaba.
                // `!wantsPlatform(...)` fuerza la preservación aunque el cliente no
                // tenga la plataforma configurada: un backfill acotado nunca debe
                // tocar columnas que no pidió.
                const hotmartApiFailed = (hotmartConfigured || !wantsPlatform('hotmart')) && !hotmartRecord.apiSuccess

                // Caída RELATIVA: la guarda nueva que la tabla intermedia hace
                // necesaria. La de siempre solo atrapa el cero absoluto, y ahora un
                // fallo parcial puede dar un número bajo pero distinto de cero.
                //
                // Se descuentan los reembolsos del día antes de comparar: si el
                // recuento baja porque hubo devoluciones, eso NO es una anomalía,
                // es exactamente lo que este trabajo pretende reflejar.
                const ventasPrevias = Number(prevRow?.ventas_principal_count ?? 0)
                    + Number(prevRow?.ventas_bump_count ?? 0)
                    + Number(prevRow?.ventas_upsell_count ?? 0)
                    + Number(prevRow?.ventas_downsell_count ?? 0)
                const ventasAhora = hotmartRecord.ventas_count + hotmartRecord.reembolsado_count
                const caidaRelativa = hotmartConfigured && !hotmartApiFailed
                    && ventasPrevias >= 5 && ventasAhora < ventasPrevias * 0.6

                const hotmartInconsistent = hotmartConfigured && !hotmartApiFailed
                    && ((hotmartRecord.ventas_count === 0 && hasHotmartData(prevRow)) || caidaRelativa)
                const hotmartFailed = hotmartApiFailed || hotmartInconsistent

                const ga4ApiFailed = gaRecord.configured && !gaRecord.apiSuccess
                const ga4Inconsistent = gaRecord.configured && !ga4ApiFailed
                    && gaRecord.sessions === 0 && hasGa4Data(prevRow)
                const ga4Failed = ga4ApiFailed || ga4Inconsistent

                if ((metaApiFailed || metaInconsistent) && hasMetaData(prevRow)) {
                    inconsistencyAlerts.push({ cliente: cliente.nombre, platform: 'Meta', fecha: targetDate, reason: metaApiFailed ? 'api_disconnected' : 'zero_vs_previous' })
                }
                if ((tiktokApiFailed || tiktokInconsistent) && hasTikTokData(prevRow)) {
                    inconsistencyAlerts.push({ cliente: cliente.nombre, platform: 'TikTok', fecha: targetDate, reason: tiktokApiFailed ? 'api_disconnected' : 'zero_vs_previous' })
                }
                if ((hotmartApiFailed || hotmartInconsistent) && hasHotmartData(prevRow)) {
                    inconsistencyAlerts.push({
                        cliente: cliente.nombre, platform: 'Hotmart', fecha: targetDate,
                        // `familia` distingue un 400 por parámetros de un 401 por
                        // credencial: sin ella todo se avisaba como "desconexión".
                        reason: hotmartApiFailed ? `api_${hotmartRecord.familia ?? 'disconnected'}`
                            : caidaRelativa ? `caida_relativa:${ventasAhora}/${ventasPrevias}`
                            : 'zero_vs_previous',
                    })
                }
                if ((ga4ApiFailed || ga4Inconsistent) && hasGa4Data(prevRow)) {
                    inconsistencyAlerts.push({ cliente: cliente.nombre, platform: 'GA4', fecha: targetDate, reason: ga4ApiFailed ? 'api_disconnected' : 'zero_vs_previous' })
                }
                if (hotmartRecord.unconverted_count > 0) {
                    inconsistencyAlerts.push({ cliente: cliente.nombre, platform: 'Hotmart', fecha: targetDate, reason: `sin_tasa_cambio:${hotmartRecord.monedas.join('/')}` })
                }

                // Guard: skip empty responses for dates older than 2 days
                // (prevents overwriting good data with stale empty API responses)
                const isEmptyMeta = metaRecord.campaigns.length === 0 && metaRecord.spend === 0
                const isEmptyTikTok = tiktokRecord.campaigns.length === 0 && tiktokRecord.spend === 0
                const isAllEmpty = isEmptyMeta && isEmptyTikTok && hotmartRecord.principal === 0 && hotmartRecord.ventas_count === 0 && gaRecord.sessions === 0
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
                    // El dato no cambió, pero SÍ se verificó ahora: sin esto el
                    // indicador de frescura mostraría la fecha del último cambio,
                    // no la de la última comprobación.
                    freshnessOnlyDates.push(targetDate)
                    results.push({ cliente_id: cliente.id, date: targetDate, status: 'skipped_hash', platform_status: { ...platformLogs } } as any)
                    continue
                }

                if (metaFailed && metaFetched) {
                    log(`[Meta] ${targetDate} ${metaApiFailed ? 'API falló' : 'devolvió cero con datos previos'} — se omiten campos Meta del upsert para preservar datos existentes`)
                }
                if (tiktokFailed && tiktokFetched) {
                    log(`[TikTok] ${targetDate} ${tiktokApiFailed ? 'API falló' : 'devolvió cero con datos previos'} — se omiten campos TikTok del upsert para preservar datos existentes`)
                }
                if (hotmartFailed) {
                    log(`[Hotmart] ${targetDate} ${hotmartApiFailed ? 'API falló' : 'devolvió cero con datos previos'} — se omiten campos Hotmart del upsert para preservar datos existentes`)
                }
                if (ga4Failed) {
                    log(`[GA4] ${targetDate} ${ga4ApiFailed ? 'API falló' : 'devolvió cero con datos previos'} — se omiten campos GA4 del upsert para preservar datos existentes`)
                }

                // Marca de frescura por fuente: solo se actualiza la clave de las
                // plataformas que SÍ trajeron datos buenos en esta corrida.
                const nowIso = new Date().toISOString()
                const prevSourceSynced = (prevRow?.source_synced_at && typeof prevRow.source_synced_at === 'object')
                    ? prevRow.source_synced_at as Record<string, string>
                    : {}
                const sourceSyncedAt: Record<string, string> = { ...prevSourceSynced }
                if (!metaFailed) sourceSyncedAt.meta = nowIso
                if (!tiktokFailed) sourceSyncedAt.tiktok = nowIso
                if (!hotmartFailed) sourceSyncedAt.hotmart = nowIso
                if (!ga4Failed) sourceSyncedAt.ga4 = nowIso

                upsertPayloads.push({
                    cliente_id: cliente.id,
                    fecha: targetDate,
                    sync_hash: payloadHash,
                    // Only include Meta fields when the API call actually succeeded and is consistent.
                    // On failure/inconsistency, preserve whatever is already in the DB for these columns.
                    ...(!metaFailed && {
                        meta_spend: metaRecord.spend,
                        meta_impressions: metaRecord.impressions,
                        meta_clicks: metaRecord.clicks,
                        meta_campaigns: metaRecord.campaigns,
                        meta_ads:      metaRecord.meta_ads,
                        meta_adsets:   metaRecord.meta_adsets,
                        meta_forms:    metaRecord.forms,
                    }),
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
                    // Hotmart totales globales (suma de funnels + extras).
                    // Se omiten si la API falló: preservar la venta real vale más que
                    // reflejar un cero transitorio.
                    ...(!hotmartFailed && {
                        ventas_principal: hotmartRecord.principal,
                        ventas_bump: hotmartRecord.bump,
                        ventas_upsell: hotmartRecord.upsell,
                        ventas_downsell: hotmartRecord.downsell,
                        ventas_principal_count: hotmartRecord.principal_count,
                        ventas_bump_count: hotmartRecord.bump_count,
                        ventas_upsell_count: hotmartRecord.upsell_count,
                        ventas_downsell_count: hotmartRecord.downsell_count,
                        ventas_principal_bruto: hotmartRecord.principal_bruto,
                        ventas_bump_bruto: hotmartRecord.bump_bruto,
                        ventas_upsell_bruto: hotmartRecord.upsell_bruto,
                        ventas_downsell_bruto: hotmartRecord.downsell_bruto,
                        // Imputados a la fecha de la VENTA, no a la del reembolso.
                        ventas_reembolsado: hotmartRecord.reembolsado,
                        ventas_reembolsado_count: hotmartRecord.reembolsado_count,
                    }),
                    // Pagos iniciados sale de GA4 (suma de payment_page_views por funnel).
                    ...(!ga4Failed && {
                        hotmart_pagos_iniciados: totalPagosIniciados,
                        ga_sessions: gaRecord.sessions,
                        ga_bounce_rate: gaRecord.bounceRate,
                        ga_avg_session_duration: gaRecord.avgSessionDuration,
                    }),
                    // El desglose por funnel MEZCLA ventas (Hotmart) y páginas (GA4):
                    // si cualquiera de los dos falló, un dato viejo coherente es mejor
                    // que uno nuevo a medias.
                    ...(!hotmartFailed && !ga4Failed && {
                        hotmart_funnel_data: funnelDataPayload,
                    }),
                    synced_at: nowIso,
                    source_synced_at: sourceSyncedAt,
                    is_partial: targetDate === todayStr,
                });

                results.push({
                    cliente_id: cliente.id,
                    date: targetDate,
                    localLog: `Principal: ${hotmartRecord.principal} (${hotmartRecord.principal_count}), Bump: ${hotmartRecord.bump} (${hotmartRecord.bump_count}), Upsell: ${hotmartRecord.upsell} (${hotmartRecord.upsell_count}), Bruto: ${hotmartRecord.principal_bruto}, Pagos: ${totalPagosIniciados}`,
                    platform_status: { ...platformLogs }
                } as any);
            }
        }
        
        // ─── Mass Upsert into Supabase (1 query por FORMA de fila) ───
        //
        // Las filas se agrupan por su conjunto de claves ANTES de enviarlas.
        //
        // La red de seguridad de arriba «preserva» los campos de una plataforma
        // omitiéndolos del objeto. Eso solo funciona si el lote es homogéneo:
        // PostgREST normaliza un insert masivo a UNA lista de columnas —la unión
        // de las claves de todas las filas— y a las filas que no traen una clave
        // les mete NULL, que el ON CONFLICT DO UPDATE escribe encima. Es decir,
        // en un lote mezclado omitir un campo no lo preservaba: lo BORRABA.
        //
        // Así se perdieron 4 días de Meta de Sur Profundo (24-27 jul 2026) con el
        // gasto y los leads ya descargados: la ventana de Meta (7 días) y la de
        // TikTok (3) no coinciden, así que hay fechas donde Meta no se re-pide
        // pero TikTok sí trae datos; esa fila entraba al lote sin las claves de
        // Meta y anulaba meta_spend/meta_campaigns. La corrida siguiente los
        // volvía a bajar y la de después los borraba otra vez, en bucle.
        //
        // Agrupando, cada upsert lleva filas con exactamente las mismas columnas
        // y lo omitido vuelve a significar «no tocar». Son 1-3 grupos por corrida.
        if (upsertPayloads.length > 0) {
            const gruposPorForma = agruparPorForma(upsertPayloads as Array<Record<string, unknown>>)

            log(`[DB] Ejecutando Mass Upsert de ${upsertPayloads.length} días de golpe para el cliente ${cliente.nombre} (${gruposPorForma.length} grupo(s) por forma de fila)...`);

            let batchError: { message: string } | null = null
            for (const filas of gruposPorForma) {
                // Rastro explícito: si un grupo no trae una plataforma, es que se
                // está preservando lo que ya hay en BD para esas fechas.
                const omitidas = plataformasOmitidas(filas[0])
                if (omitidas.length > 0) {
                    log(`[DB] ${filas.length} fecha(s) conservan ${omitidas.join(' y ')} de BD (no se re-pidió o falló): ${filas.map(f => f.fecha).join(', ')}`)
                }
                const { error } = await adminSupabase
                    .from('metricas_diarias')
                    .upsert(filas, { onConflict: 'cliente_id, fecha' });
                if (error) { batchError = error; break }
            }

            if (batchError) {
                log(`[DB] ❌ Error en Mass Upsert: ${batchError.message}`);
                results.forEach((r: any) => { if (r.cliente_id === cliente.id) r.status = 'failed' });
            } else {
                log(`[DB] ✓ Mass Upsert exitoso. ${upsertPayloads.length} filas actualizadas/insertadas procesadas rapidísimo.`);
                results.forEach((r: any) => { if (r.cliente_id === cliente.id) r.status = 'ok' });

                // ─── Escritura espejo en public.ads_daily ───────────────────
                // Los mismos datos, normalizados a una fila por
                // (fecha, plataforma, nivel, entidad). No cuesta ni una llamada
                // extra a la API: se expande el payload que ya está en memoria.
                //
                // NO FATAL a propósito. `metricas_diarias` sigue siendo la fuente
                // de verdad y el motor todavía lee de sus JSONB, así que un fallo
                // aquí no puede marcar el cliente como fallido ni tumbar el sync.
                // Se avisa y se sigue.
                try {
                    const inicioEspejo = new Date().toISOString();
                    const payloadsAds = upsertPayloads as Array<Record<string, unknown>>;
                    const filasAds = payloadsAds.flatMap(p =>
                        expandirFila(
                            {
                                cliente_id: String(p.cliente_id),
                                fecha: String(p.fecha),
                                meta_campaigns: p.meta_campaigns,
                                meta_adsets: p.meta_adsets,
                                meta_ads: p.meta_ads,
                                tiktok_campaigns: p.tiktok_campaigns,
                                tiktok_adgroups: p.tiktok_adgroups,
                                tiktok_ads: p.tiktok_ads,
                            },
                            { hoy: todayStr, origen: 'worker' }
                        ).map(f => ({ ...f, synced_at: inicioEspejo }))
                    );

                    if (filasAds.length > 0) {
                        const { error: eAds } = await adminSupabase
                            .from('ads_daily')
                            .upsert(filasAds, {
                                onConflict: 'cliente_id,fecha,plataforma,nivel,entidad_key',
                            });
                        if (eAds) throw new Error(eAds.message);

                        // Limpieza de lo que la plataforma dejó de reportar: si una
                        // campaña desaparece del array de un día, su fila quedaría
                        // con el gasto viejo e inflaría los totales. Se borra por
                        // `synced_at` anterior a esta corrida, y DESPUÉS del upsert
                        // para que nunca haya un hueco: como mucho hay un instante
                        // con datos de más, nunca de menos.
                        //
                        // ACOTADO POR PLATAFORMA: una fecha que conserva Meta de BD
                        // (porque no se re-pidió o falló) no trae filas Meta nuevas,
                        // así que un borrado por fecha a secas se llevaba por delante
                        // el espejo bueno y dejaba el día solo con TikTok. Solo se
                        // limpia la plataforma que SÍ se acaba de escribir.
                        const fechasPorPlataforma: Record<'meta' | 'tiktok', string[]> = { meta: [], tiktok: [] }
                        for (const p of payloadsAds) {
                            const fecha = String(p.fecha)
                            if ('meta_campaigns' in p) fechasPorPlataforma.meta.push(fecha)
                            if ('tiktok_campaigns' in p) fechasPorPlataforma.tiktok.push(fecha)
                        }
                        for (const plataforma of ['meta', 'tiktok'] as const) {
                            const fechas = [...new Set(fechasPorPlataforma[plataforma])]
                            if (fechas.length === 0) continue
                            const { error: eLimpieza } = await adminSupabase
                                .from('ads_daily')
                                .delete()
                                .eq('cliente_id', cliente.id)
                                .eq('plataforma', plataforma)
                                .in('fecha', fechas)
                                .lt('synced_at', inicioEspejo);
                            if (eLimpieza) throw new Error(eLimpieza.message);
                        }

                        const fechasTocadas = [...new Set(payloadsAds.map(p => String(p.fecha)))];
                        log(`[DB] ✓ ads_daily: ${filasAds.length} filas espejo en ${fechasTocadas.length} día(s).`);
                    }
                } catch (e) {
                    // Un espejo desactualizado es un problema; un sync caído, peor.
                    log(`[DB] ⚠ ads_daily no se pudo actualizar (metricas_diarias SÍ se guardó): ${(e as Error)?.message ?? e}`);
                }
            }
        }

        // Fechas verificadas cuyo contenido no cambió: solo se refresca la marca de
        // frescura, en una sola query (no reescriben datos).
        if (freshnessOnlyDates.length > 0) {
            await adminSupabase
                .from('metricas_diarias')
                .update({ synced_at: new Date().toISOString() })
                .eq('cliente_id', cliente.id)
                .in('fecha', freshnessOnlyDates)
        }

        if (budgetCut) {
            partialClientes.push(cliente.nombre)
            if (resumeFromDate && (!resumeFrom || resumeFromDate < resumeFrom)) {
                resumeFrom = resumeFromDate
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

    // Aviso in-app a admins de desconexión/inconsistencia de API (un aviso agregado por corrida).
    // Estos casos NO sobrescribieron la BD (se preservaron los datos previos), pero requieren
    // revisión humana: una API caída o un cero que contradice datos ya descargados.
    if (inconsistencyAlerts.length > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        // ── DEDUPE ────────────────────────────────────────────────────────
        // Sin esto, cada pasada del worker (cron diario + reintentos + el
        // fallback de GitHub Actions cada 30 min) emitía un aviso NUEVO del
        // MISMO fallo: 95 notificaciones en 3 días durante la caída de Hotmart
        // del 18-ago, que es como no tener ninguna. Mismo patrón que ya usa
        // `/api/worker/health`.
        const { data: avisoReciente } = await adminSupabase
            .from('notifications')
            .select('id')
            .eq('type', 'sync_failed')
            .eq('metadata->>reason', 'api_disconnected_or_inconsistent')
            .gte('created_at', new Date(Date.now() - ALERTA_API_DEDUPE_MS).toISOString())
            .limit(1)

        if (!avisoReciente || avisoReciente.length === 0) {
            // Agrupar por familia: "3 por credenciales" y "3 por parámetros"
            // llevan a acciones distintas, y el texto anterior ("por API caída")
            // los describía igual a los dos.
            const porFamilia = new Map<string, number>()
            for (const a of inconsistencyAlerts) {
                const etiqueta = ETIQUETA_RAZON[a.reason] ?? ETIQUETA_RAZON[a.reason.split(':')[0]] ?? 'inconsistencia'
                porFamilia.set(etiqueta, (porFamilia.get(etiqueta) ?? 0) + 1)
            }
            const desglose = Array.from(porFamilia.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([etiqueta, n]) => `${n} por ${etiqueta}`)
                .join(', ')
            const summary = inconsistencyAlerts
                .slice(0, 12)
                .map((a) => `${a.cliente}: ${a.platform} ${a.fecha}`)
                .join(', ')

            await notifyUsers({
                db: adminSupabase,
                type: 'sync_failed',
                severity: 'warning',
                audience: 'admins',
                title: `Sincronización incompleta: ${desglose} (${inconsistencyAlerts.length} caso${inconsistencyAlerts.length > 1 ? 's' : ''})`,
                message: `Se preservaron los datos existentes. ${summary}`.slice(0, 300),
                link: '/admin/sync',
                metadata: { reason: 'api_disconnected_or_inconsistent', alerts: inconsistencyAlerts.slice(0, 100), range: { start: startDateStr, end: endDateStr } },
            })
        } else {
            log(`[worker] ${inconsistencyAlerts.length} alerta(s) de API omitidas: ya hay un aviso de las últimas ${ALERTA_API_DEDUPE_MS / 3_600_000} h.`)
        }
    }

    // Diagnóstico: action_types que Meta envió y no mapeamos a ninguna métrica.
    // Si aquí aparece un evento que el cliente sí usa, hay que añadirlo a
    // META_ACTION_FAMILIES (es la causa de métricas que salen siempre en 0).
    if (unmappedActionTypes.size > 0) {
        log(`[Meta] action_types sin mapear (${unmappedActionTypes.size}): ${Array.from(unmappedActionTypes).sort().join(', ')}`)
        unmappedActionTypes.clear()
    }

    // Evaluar reglas de alertas condicionales
    let alertsEvaluated = 0
    let alertsTriggered = 0
    try {
        const evalRes = await evaluateAlertRules(adminSupabase)
        alertsEvaluated = evalRes.evaluated
        alertsTriggered = evalRes.triggered
        log(`[Alerts Engine] ✓ Evaluated ${alertsEvaluated} rules, triggered ${alertsTriggered} alerts.`)
    } catch (err) {
        log(`[Alerts Engine] ❌ Error running rules engine: ${err}`)
    }

    return NextResponse.json({
        message: partialClientes.length > 0 ? 'Sync parcial (presupuesto de tiempo agotado)' : 'Sync complete',
        partial: partialClientes.length > 0,
        partialClientes,
        resumeFrom,
        results,
        debugLogs,
        alerts: { evaluated: alertsEvaluated, triggered: alertsTriggered },
    })
}