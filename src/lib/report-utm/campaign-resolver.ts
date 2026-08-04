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
//   • el diagnóstico de /report-utm/cruce-campanas
//
// Antes vivía dentro de `campaign-data.ts` junto a un motor de consulta paralelo
// (`runCampaignQuery`) que solo sabía emitir ~20 de las 72 métricas e ignoraba
// los campos calculados. Al extraerlo, el motor principal puede usar el mismo
// cruce sin heredar aquellas limitaciones.

import { createAdminClient } from '@/utils/supabase/server'
import { AD_JSONB_METRICS, normLabel } from './bi-metadata'

// ============================================================
// Cruce leads/ventas ↔ campañas (gasto).
// Estrategia en cascada porque los UTMs son inconsistentes.
// Prioridad (todos los matches de aquí son EXACTOS = automáticos):
//   1. overrides manuales (report_utm.utm_campaign_map) → el trafficker manda
//   2. utm_id === campaign_id (Meta dinámico)
//   3. utm_id === ad_id (sube a su campaña)
//   4. utm_campaign normalizado === nombre de campaña
//   5. utm_content normalizado === nombre de ad (o de campaña)
//   6. utm_term normalizado === nombre de adset
//   7. sin match → sin campaña
// Lo que no cruza exacto se ofrece como SUGERENCIA por similitud
// (ver campaign-data.ts) para que el trafficker confirme — nunca se aplica solo.
// ============================================================

export type MatchMethod =
    | 'override'
    | 'utm_id_campaign'
    | 'utm_id_ad'
    | 'name'
    | 'content_ad'
    | 'term_adset'
    | 'none'

// Margen extra (días) para el índice de campañas respecto al rango de leads:
// registra campañas cuyo gasto cayó justo fuera del rango exacto, sin sumar su
// gasto al periodo (el gasto solo se acumula dentro de [dateFrom, dateTo]).
const INDEX_MARGIN_DAYS = 30

function shiftDate(isoDate: string, deltaDays: number): string {
    const d = new Date(isoDate + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + deltaDays)
    return d.toISOString().slice(0, 10)
}

export function zeroAdMetrics(): Record<string, number> {
    const e: Record<string, number> = {}
    for (const k of AD_JSONB_METRICS) e[k] = 0
    return e
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Number(n) : 0
}

export interface CampaignAgg {
    key: string
    campaign_id: string | null
    name: string
    platform: 'meta' | 'tiktok'
    spend: number
    impressions: number
    clicks: number
    platform_leads: number   // leads reportados por la plataforma (referencia)
    extra: Record<string, number>   // métricas de campaña aditivas (alcance, video, compras…)
}

export interface CampaignIndex {
    campaigns: Map<string, CampaignAgg>     // key → agg
    byCampaignId: Map<string, string>        // campaign_id → key
    byAdId: Map<string, string>              // ad_id → key (de la campaña)
    byName: Map<string, string>              // nombre de campaña normalizado → key
    byAdName: Map<string, string>            // nombre de ad normalizado → key (campaña)
    byAdsetName: Map<string, string>         // nombre de adset normalizado → key (campaña)
    // ── Canónicos: normalizado → nombre REAL tal como lo escribió el anunciante ──
    // Son los que permiten que la fila del informe se titule "Promo Verano" (el
    // nombre del anuncio) y no "promo_verano" (lo que venía en el UTM), y que esa
    // clave coincida exactamente con la que emite el desglose del gasto.
    adCanonicalByName: Map<string, string>   // normLabel(ad_name) → ad_name
    adByAdId: Map<string, string>            // ad_id → ad_name
    adsetCanonicalByName: Map<string, string> // normLabel(adset_name) → adset_name
    adsetByAdId: Map<string, string>         // ad_id → adset_name
    // ── Con actividad DENTRO del rango exacto ──
    // El índice se construye con un margen de ±30 días para poder resolver un UTM
    // que apunta a algo que gastó justo antes. Pero esas entidades no producen
    // ninguna fila en el informe: ofrecerlas en un desplegable daba opciones
    // fantasma que dejaban el widget vacío. Estos conjuntos son los que sí.
    adsActivos: Set<string>                  // ad_name con gasto en el rango
    adsetsActivos: Set<string>               // adset_name con gasto en el rango
}

export interface Override {
    match_field: string
    match_value: string
    campaign_id: string | null
    campaign_name: string | null
    platform: string
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
    }
}

/**
 * Carga y agrega las campañas (Meta + TikTok) de metricas_diarias para
 * el cliente público en el rango, e indexa por id, ad_id y nombre.
 */
export async function loadCampaignIndex(
    publicClienteId: string,
    dateFrom: string,
    dateTo: string
): Promise<CampaignIndex | null> {
    const supabase = await createAdminClient()
    // Ventana ampliada para registrar claves de campañas/ads/adsets que pudieron
    // gastar justo fuera del rango. El gasto solo se acumula dentro del rango exacto.
    const keyFrom = shiftDate(dateFrom, -INDEX_MARGIN_DAYS)

    // ── Lectura por tramos de fechas ───────────────────────────────────
    // Cada fila lleva el desglose por anuncio del día entero: para un cliente con
    // cientos de anuncios activos son cientos de KB por fila. Pedir 120 días de
    // golpe producía respuestas de varios MB que PostgREST devolvía TRUNCADAS de
    // forma intermitente —sin error—, y un índice a medias mapea unos leads sí y
    // otros no, en silencio: el mismo informe daba 1.315 leads en una carga y 57
    // en la siguiente. Troceando, cada respuesta es pequeña y el resultado es
    // determinista.
    const CHUNK_DAYS = 10
    const tramos: { from: string; to: string }[] = []
    for (let cursor = keyFrom; cursor <= dateTo; cursor = shiftDate(cursor, CHUNK_DAYS)) {
        const fin = shiftDate(cursor, CHUNK_DAYS - 1)
        tramos.push({ from: cursor, to: fin > dateTo ? dateTo : fin })
    }

    const respuestas = await Promise.all(tramos.map(t =>
        supabase
            .from('metricas_diarias')
            .select('fecha,meta_campaigns,meta_ads,meta_adsets,tiktok_campaigns,tiktok_ads,tiktok_adgroups')
            .eq('cliente_id', publicClienteId)
            .gte('fecha', t.from)
            .lte('fecha', t.to)
    ))

    const idx = emptyIndex()
    // Un tramo fallido daría un índice PARCIAL, que es peor que no tener índice:
    // parte de los leads cruzaría y parte no, sin forma de notarlo. Se aborta para
    // degradar de forma consistente (el motor cae a los UTM crudos).
    if (respuestas.some(r => r.error)) return null
    const data = respuestas.flatMap(r => r.data ?? [])

    function upsert(platform: 'meta' | 'tiktok', campId: string | null, name: string, addSpend: boolean, m: { spend: number; impressions: number; clicks: number; leads: number }) {
        const key = `${platform}:${campId ?? normLabel(name)}`
        let agg = idx.campaigns.get(key)
        if (!agg) {
            agg = { key, campaign_id: campId, name: name || '(sin nombre)', platform, spend: 0, impressions: 0, clicks: 0, platform_leads: 0, extra: zeroAdMetrics() }
            idx.campaigns.set(key, agg)
            if (campId) idx.byCampaignId.set(campId, key)
            if (name) idx.byName.set(normLabel(name), key)
        }
        if (addSpend) {
            agg.spend += m.spend
            agg.impressions += m.impressions
            agg.clicks += m.clicks
            agg.platform_leads += m.leads
        }
        return key
    }

    for (const row of data as Record<string, unknown>[]) {
        const inRange = typeof row.fecha === 'string' ? row.fecha >= dateFrom : true
        const metaCamps = (row.meta_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of metaCamps) {
            const key = upsert('meta', (c.campaign_id as string) ?? null, (c.name as string) ?? '', inRange, {
                spend: num(c.spend), impressions: num(c.impressions), clicks: num(c.clicks), leads: num(c.leads),
            })
            if (inRange) {
                const agg = idx.campaigns.get(key)!
                for (const k of AD_JSONB_METRICS) agg.extra[k] += num(c[k])
            }
        }
        // Indexa ad_id y nombre de ad/adset → campaña (para cruzar utm_id=ad_id,
        // utm_content=ad_name, utm_term=adset_name).
        const metaAds = (row.meta_ads as Record<string, unknown>[] | null) ?? []
        for (const a of metaAds) {
            const adId = a.ad_id as string | null
            const adName = a.ad_name as string | null
            const adsetName = a.adset_name as string | null
            // Los canónicos NO dependen de que la campaña esté indexada: sirven para
            // titular la fila aunque el ad venga de una campaña fuera del rango.
            const activo = inRange && num(a.spend) > 0
            if (adName) {
                idx.adCanonicalByName.set(normLabel(adName), adName)
                if (adId) idx.adByAdId.set(adId, adName)
                if (activo) idx.adsActivos.add(adName)
            }
            if (adsetName) {
                idx.adsetCanonicalByName.set(normLabel(adsetName), adsetName)
                if (adId) idx.adsetByAdId.set(adId, adsetName)
            }
            const campId = a.campaign_id as string | null
            const campKey = campId ? idx.byCampaignId.get(campId) : undefined
            if (!campKey) continue
            if (adId) idx.byAdId.set(adId, campKey)
            if (adName) idx.byAdName.set(normLabel(adName), campKey)
            if (adsetName) idx.byAdsetName.set(normLabel(adsetName), campKey)
        }
        const metaAdsets = (row.meta_adsets as Record<string, unknown>[] | null) ?? []
        for (const a of metaAdsets) {
            const adsetName = a.adset_name as string | null
            if (adsetName) {
                idx.adsetCanonicalByName.set(normLabel(adsetName), adsetName)
                if (inRange && num(a.spend) > 0) idx.adsetsActivos.add(adsetName)
            }
            const campId = a.campaign_id as string | null
            const campKey = campId ? idx.byCampaignId.get(campId) : undefined
            if (!campKey) continue
            if (adsetName) idx.byAdsetName.set(normLabel(adsetName), campKey)
        }
        const ttCamps = (row.tiktok_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of ttCamps) {
            upsert('tiktok', (c.campaign_id as string) ?? null, (c.name as string) ?? '', inRange, {
                spend: num(c.spend), impressions: num(c.impressions), clicks: num(c.clicks), leads: num(c.conversions),
            })
        }
        // TikTok solo aporta canónicos de nombre: sus objetos de anuncio/adgroup no
        // llevan campaign_id, así que no se pueden colgar de una campaña.
        for (const a of (row.tiktok_ads as Record<string, unknown>[] | null) ?? []) {
            const adName = a.ad_name as string | null
            if (!adName) continue
            if (!idx.adCanonicalByName.has(normLabel(adName))) {
                idx.adCanonicalByName.set(normLabel(adName), adName)
            }
            if (inRange && num(a.spend) > 0) idx.adsActivos.add(adName)
        }
        for (const a of (row.tiktok_adgroups as Record<string, unknown>[] | null) ?? []) {
            const gName = a.adgroup_name as string | null
            if (!gName) continue
            if (!idx.adsetCanonicalByName.has(normLabel(gName))) {
                idx.adsetCanonicalByName.set(normLabel(gName), gName)
            }
            if (inRange && num(a.spend) > 0) idx.adsetsActivos.add(gName)
        }
    }

    return idx
}

/** Cascada de matching de un registro (lead/venta) a una campaña. */
export function matchToCampaign(
    rec: { utm_id?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null; utm_source?: string | null },
    idx: CampaignIndex,
    overrides: Override[]
): { key: string | null; method: MatchMethod } {
    // 1. overrides manuales → máxima prioridad (el trafficker corrige el motor)
    for (const ov of overrides) {
        const val = (rec as Record<string, unknown>)[ov.match_field] as string | undefined
        if (val && normLabel(val) === normLabel(ov.match_value)) {
            const key = ov.campaign_id
                ? `${ov.platform}:${ov.campaign_id}`
                : ov.campaign_name ? `${ov.platform}:${normLabel(ov.campaign_name)}` : null
            if (key) return { key, method: 'override' }
        }
    }
    // 2. utm_id === campaign_id
    if (rec.utm_id && idx.byCampaignId.has(rec.utm_id)) {
        return { key: idx.byCampaignId.get(rec.utm_id)!, method: 'utm_id_campaign' }
    }
    // 3. utm_id === ad_id → su campaña
    if (rec.utm_id && idx.byAdId.has(rec.utm_id)) {
        return { key: idx.byAdId.get(rec.utm_id)!, method: 'utm_id_ad' }
    }
    // 4. utm_campaign === nombre de campaña (normalizado)
    if (rec.utm_campaign) {
        const k = idx.byName.get(normLabel(rec.utm_campaign))
        if (k) return { key: k, method: 'name' }
    }
    // 5. utm_content === nombre de ad (o de campaña) → su campaña
    if (rec.utm_content) {
        const n = normLabel(rec.utm_content)
        const k = idx.byAdName.get(n) ?? idx.byName.get(n)
        if (k) return { key: k, method: 'content_ad' }
    }
    // 6. utm_term === nombre de adset → su campaña
    if (rec.utm_term) {
        const k = idx.byAdsetName.get(normLabel(rec.utm_term))
        if (k) return { key: k, method: 'term_adset' }
    }
    return { key: null, method: 'none' }
}

export async function loadOverrides(clienteId: string): Promise<Override[]> {
    const supabase = await createAdminClient()
    const { data } = await supabase
        .schema('report_utm')
        .from('utm_campaign_map')
        .select('match_field,match_value,campaign_id,campaign_name,platform')
        .eq('cliente_id', clienteId)
        .limit(2000)
    return (data as Override[] | null) ?? []
}

/** Resuelve el public cliente_id enlazado a un cliente report_utm (o null). */
// El enlace cliente report_utm → cliente público cambia muy de vez en cuando
// (solo al vincular a mano), pero se pregunta varias veces por consulta: una en
// `queryAdsDirect`, otra en `loadResolver` y otra en el diagnóstico. Con 12
// widgets por informe eso son decenas de viajes idénticos a la base. TTL igual
// que el del resolver, por coherencia.
const PUBLIC_ID_TTL_MS = 60_000
const publicIdCache = new Map<string, { value: string | null; ts: number }>()

export async function resolvePublicClienteId(rtmClienteId: string): Promise<string | null> {
    const now = Date.now()
    const hit = publicIdCache.get(rtmClienteId)
    if (hit && now - hit.ts <= PUBLIC_ID_TTL_MS) return hit.value

    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .schema('report_utm').from('clientes')
        .select('public_cliente_id').eq('id', rtmClienteId).maybeSingle()
    // Un error de red NO se cachea: cachear el null convertiría un fallo puntual
    // en un minuto entero de informes en blanco.
    if (error) return null

    const value = data?.public_cliente_id ?? null
    if (publicIdCache.size > 500) publicIdCache.clear()
    publicIdCache.set(rtmClienteId, { value, ts: now })
    return value
}

// ── API pública del resolver ──────────────────────────────────────────

/** Registro mínimo (lead o venta) que el resolver sabe cruzar. */
export interface UtmRecord {
    utm_id?: string | null
    utm_campaign?: string | null
    utm_content?: string | null
    utm_term?: string | null
    utm_source?: string | null
    utm_medium?: string | null
}

/** Etiqueta resuelta + si cruzó con una entidad real del reporting. */
export interface ResolvedLabel {
    label: string
    matched: boolean
}

export const SIN_CAMPANA = '(sin campaña)'
export const SIN_ANUNCIO = '(sin anuncio)'
export const SIN_CONJUNTO = '(sin conjunto)'

export interface CampaignResolver {
    /** Campaña real a la que pertenece el registro, o su utm_campaign crudo. */
    campaignOf(rec: UtmRecord): ResolvedLabel
    /** Nombre real del anuncio (utm_content canonizado), o el valor crudo. */
    adOf(rec: UtmRecord): ResolvedLabel
    /** Nombre real del conjunto (utm_term canonizado), o el valor crudo. */
    adsetOf(rec: UtmRecord): ResolvedLabel
    /** Nombres de campaña conocidos, para poblar desplegables. */
    campaignLabels(): string[]
    /** Nombres de anuncio conocidos. */
    adLabels(): string[]
    /** Nombres de conjunto conocidos. */
    adsetLabels(): string[]
    /** Nombre real de una campaña a partir de cualquier variante de escritura. */
    canonicalCampaign(name: string): string | null
    /** Índice crudo, para quien necesite el gasto agregado por campaña. */
    index: CampaignIndex
}

function buildResolver(idx: CampaignIndex, overrides: Override[]): CampaignResolver {
    return {
        campaignOf(rec) {
            const m = matchToCampaign(rec, idx, overrides)
            if (m.key) {
                const agg = idx.campaigns.get(m.key)
                if (agg) return { label: agg.name, matched: true }
                // Un override puede apuntar a una campaña sin gasto en el rango: se
                // respeta su nombre igualmente, que para eso lo escribió el trafficker.
                const ov = overrides.find(o => o.campaign_name && m.key ===
                    (o.campaign_id ? `${o.platform}:${o.campaign_id}` : `${o.platform}:${normLabel(o.campaign_name)}`))
                if (ov?.campaign_name) return { label: ov.campaign_name, matched: true }
            }
            // Sin cruce, cada UTM huérfano es su PROPIA fila (con gasto 0), no un
            // cubo común: fundirlos escondía justo el problema que hay que arreglar.
            const raw = (rec.utm_campaign ?? '').trim()
            return { label: raw || SIN_CAMPANA, matched: false }
        },

        adOf(rec) {
            if (rec.utm_id) {
                const real = idx.adByAdId.get(rec.utm_id)
                if (real) return { label: real, matched: true }
            }
            const raw = (rec.utm_content ?? '').trim()
            if (raw) {
                const real = idx.adCanonicalByName.get(normLabel(raw))
                if (real) return { label: real, matched: true }
            }
            return { label: raw || SIN_ANUNCIO, matched: false }
        },

        adsetOf(rec) {
            if (rec.utm_id) {
                const real = idx.adsetByAdId.get(rec.utm_id)
                if (real) return { label: real, matched: true }
            }
            const raw = (rec.utm_term ?? '').trim()
            if (raw) {
                const real = idx.adsetCanonicalByName.get(normLabel(raw))
                if (real) return { label: real, matched: true }
            }
            return { label: raw || SIN_CONJUNTO, matched: false }
        },

        // Solo entidades con actividad DENTRO del rango: son las únicas que
        // producen una fila en el informe. Las del margen de indexación siguen
        // sirviendo para resolver un UTM, pero no se ofrecen para elegir.
        campaignLabels() {
            return Array.from(idx.campaigns.values())
                .filter(c => c.spend > 0 || c.impressions > 0 || c.clicks > 0)
                .sort((a, b) => b.spend - a.spend)
                .map(c => c.name)
        },
        adLabels() {
            return Array.from(idx.adsActivos)
        },
        adsetLabels() {
            return Array.from(idx.adsetsActivos)
        },
        canonicalCampaign(name) {
            const key = idx.byName.get(normLabel(name))
            return key ? (idx.campaigns.get(key)?.name ?? null) : null
        },
        index: idx,
    }
}

// ── Caché de módulo ───────────────────────────────────────────────────
// Un informe con 12 widgets dispara 12 consultas independientes, cada una con su
// propio rango pero casi siempre el MISMO. Sin caché eso son 12 lecturas de
// `metricas_diarias` (hasta 2000 filas cada una) para construir el mismo índice.
// TTL corto: el índice solo cambia cuando el worker sincroniza.

const RESOLVER_TTL_MS = 60_000

interface CacheEntry { resolver: CampaignResolver; ts: number }
const resolverCache = new Map<string, CacheEntry>()

/** Vacía las entradas expiradas (evita que el mapa crezca sin fin). */
function pruneCache(now: number): void {
    for (const [k, v] of resolverCache) {
        if (now - v.ts > RESOLVER_TTL_MS) resolverCache.delete(k)
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
    const key = `${clienteId}|${dateFrom}|${dateTo}`
    const now = Date.now()
    const hit = resolverCache.get(key)
    if (hit && now - hit.ts <= RESOLVER_TTL_MS) return hit.resolver

    const publicId = await resolvePublicClienteId(clienteId)
    if (!publicId) return null

    const [idx, overrides] = await Promise.all([
        loadCampaignIndex(publicId, dateFrom, dateTo),
        loadOverrides(clienteId),
    ])
    // Sin índice fiable no se resuelve nada: el motor degrada a los UTM crudos,
    // que es coherente aunque sea peor, y no se cachea para reintentar enseguida.
    if (!idx) return null
    const resolver = buildResolver(idx, overrides)

    pruneCache(now)
    resolverCache.set(key, { resolver, ts: now })
    return resolver
}
