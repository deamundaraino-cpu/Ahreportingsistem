// ── Diagnóstico del cruce UTM ↔ campañas ──────────────────────────────
//
// Alimenta /report-utm/cruce-campanas: qué UTM de los leads cruzan con una
// campaña real, por qué método, cuáles no cruzan y qué campaña se les parece.
//
// El CRUCE en sí (índice de campañas, cascada de matching, overrides) vive en
// `campaign-resolver.ts`, que también usa el motor del BI. Aquí queda solo lo
// específico del diagnóstico: similitud por Dice, detección de UTM inválidos y
// los agregados que consume la UI.
//
// Este módulo tuvo además un motor de consulta propio (`runCampaignQuery`) para
// la dimensión "Campaña (cruzada)". Se eliminó: solo sabía emitir ~20 de las 72
// métricas del catálogo e ignoraba por completo los campos calculados. Hoy la
// dimensión "Campaña" del motor principal (`bi-query.ts`) hace el mismo cruce
// con todas las métricas.

import { createAdminClient } from '@/utils/supabase/server'
import type { AdvancedFilter } from './bi-metadata'
import { normLabel, round2 } from './bi-metadata'
import { fetchAllRows } from './bi-query'
import {
    loadCampaignIndex, loadOverrides, matchToCampaign, resolvePublicClienteId,
} from './campaign-resolver'
import type { CampaignIndex, MatchMethod, Override } from './campaign-resolver'

export type { MatchMethod } from './campaign-resolver'

// Coeficiente de Sørensen-Dice sobre bigramas de caracteres → [0,1].
// Sin dependencias; tolera tokens reordenados/parciales razonablemente.
function diceCoefficient(a: string, b: string): number {
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0
    const bigrams = (s: string) => {
        const m = new Map<string, number>()
        for (let i = 0; i < s.length - 1; i++) {
            const bg = s.slice(i, i + 2)
            m.set(bg, (m.get(bg) ?? 0) + 1)
        }
        return m
    }
    const ba = bigrams(a)
    const bb = bigrams(b)
    let inter = 0
    let total = 0
    for (const c of ba.values()) total += c
    for (const [bg, c] of bb) {
        total += c
        const av = ba.get(bg)
        if (av) inter += Math.min(av, c)
    }
    return total === 0 ? 0 : (2 * inter) / total
}

export interface CampaignCrossParams {
    cliente_id: string          // report_utm cliente id (requerido)
    date_from?: string
    date_to?: string
    filters?: Record<string, string>
    advancedFilter?: AdvancedFilter
    limit?: number
}

/** Lista las campañas disponibles (para poblar selectores de mapeo). */
export async function listCampaigns(
    clienteId: string,
    dateFrom?: string,
    dateTo?: string
): Promise<{ campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[]> {
    const from = dateFrom ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
    const to   = dateTo   ?? new Date().toISOString().slice(0, 10)

    const publicClienteId = await resolvePublicClienteId(clienteId)
    if (!publicClienteId) return []

    const idx = await loadCampaignIndex(publicClienteId, from, to)
    return idx ? campaignsFromIndex(idx) : []
}

// Umbral mínimo de similitud para ofrecer una sugerencia (no autoaplicar).
const SUGGEST_THRESHOLD = 0.45

export type InvalidUtmReason = 'macro_no_renderizado' | 'sin_utm'

// Valores vacíos/centinela que no representan ninguna campaña.
const EMPTY_UTM = new Set(['', '(vacío)', '(vacio)', '(empty)', '(none)', '(not set)', 'not set', 'null', 'undefined', 'n/a', 'na'])

/**
 * Detecta UTMs que NO son atribuibles a una campaña concreta:
 *  - macros sin renderizar de Meta/TikTok: {{campaign.name}}, {{ad.name}},
 *    {campaign.name}, __CAMPAIGN_NAME__, %campaign_name%…
 *  - valores vacíos o centinela.
 * Estas no deben ofrecerse para mapeo manual (un macro abarca muchas campañas).
 */
function classifyInvalidUtm(value: string): InvalidUtmReason | null {
    const v = value.trim()
    if (EMPTY_UTM.has(v.toLowerCase())) return 'sin_utm'
    // Macros sin sustituir en cualquiera de las sintaxis habituales.
    if (/\{\{.*?\}\}|\{[a-z0-9_.]+\}|__[A-Z0-9_]+__|%[a-z0-9_]+%/i.test(v)) return 'macro_no_renderizado'
    return null
}

interface CrossContext {
    idx: CampaignIndex
    overrides: Override[]
    leads: Record<string, unknown>[]
}

/** Resuelve cliente público, carga índice+overrides y los leads del rango. */
async function loadCrossContext(params: CampaignCrossParams): Promise<CrossContext | null> {
    const supabase = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    const publicClienteId = await resolvePublicClienteId(params.cliente_id)
    if (!publicClienteId) return null

    const [idx, overrides] = await Promise.all([
        loadCampaignIndex(publicClienteId, dateFrom, dateTo),
        loadOverrides(params.cliente_id),
    ])
    // Sin índice completo el diagnóstico mentiría: mostraría como "no cruza"
    // justo lo que no se pudo leer. Mejor no mostrar nada.
    if (!idx) return null

    const leads = await fetchAllRows(() =>
        supabase.schema('report_utm').from('lead_events')
            .select('id,utm_id,utm_campaign,utm_content,utm_term,utm_source')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('cliente_id', params.cliente_id)
    ) as Record<string, unknown>[]

    return { idx, overrides, leads }
}

export interface CampaignSuggestion {
    campaign_id: string | null
    campaign_name: string
    platform: 'meta' | 'tiktok'
    confidence: number   // 0-100
}

export interface UnmatchedRow {
    field: string
    value: string
    count: number
    suggestion: CampaignSuggestion | null
}

/** Mejor campaña candidata para un valor UTM por similitud de nombre. */
function bestSuggestion(value: string, idx: CampaignIndex): CampaignSuggestion | null {
    const v = normLabel(value)
    if (!v) return null
    let best: CampaignSuggestion | null = null
    let bestScore = 0
    for (const c of idx.campaigns.values()) {
        const score = diceCoefficient(v, normLabel(c.name))
        if (score > bestScore) {
            bestScore = score
            best = { campaign_id: c.campaign_id, campaign_name: c.name, platform: c.platform, confidence: Math.round(score * 100) }
        }
    }
    return best && bestScore >= SUGGEST_THRESHOLD ? best : null
}

export interface MatchCoverage {
    total: number
    methods: Record<MatchMethod, number>
}

export interface InvalidUtmRow {
    field: string
    value: string
    count: number
    reason: InvalidUtmReason
}

/**
 * (Puro) valores UTM de leads que NO cruzaron exacto, separados en:
 *  - `suggestions`: valores reales mapeables (con mejor candidato por similitud)
 *  - `invalid`: macros sin renderizar / vacíos (no mapeables, problema de datos)
 */
function computeUnmatched(ctx: CrossContext): { suggestions: UnmatchedRow[]; invalid: InvalidUtmRow[] } {
    const { idx, overrides, leads } = ctx
    const counts = new Map<string, number>()
    for (const l of leads) {
        const m = matchToCampaign(l, idx, overrides)
        if (m.key) continue
        const v = (l.utm_campaign as string) || (l.utm_id as string) || (l.utm_source as string) || '(vacío)'
        const field = l.utm_campaign ? 'utm_campaign' : l.utm_id ? 'utm_id' : 'utm_source'
        const k = `${field}||${v}`
        counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const suggestions: UnmatchedRow[] = []
    const invalid: InvalidUtmRow[] = []
    for (const [k, count] of counts) {
        const field = k.split('||')[0]
        const value = k.slice(field.length + 2)
        const bad = classifyInvalidUtm(value)
        if (bad) invalid.push({ field, value, count, reason: bad })
        else suggestions.push({ field, value, count, suggestion: bestSuggestion(value, idx) })
    }
    suggestions.sort((a, b) => b.count - a.count)
    invalid.sort((a, b) => b.count - a.count)
    return { suggestions: suggestions.slice(0, 200), invalid: invalid.slice(0, 50) }
}

export interface UtmCampaignRow {
    value: string                       // valor de utm_campaign (o '(vacío)')
    count: number                       // leads con ese utm_campaign
    matched_campaign: string | null     // campaña a la que cruzó (dominante)
    distinct_campaigns: number          // nº de campañas distintas a las que cruzó
    method: MatchMethod                 // método de match dominante
    invalid_reason: InvalidUtmReason | null
    suggestion: CampaignSuggestion | null   // solo si no cruzó y es mapeable
}

const ZERO_METHODS = (): Record<MatchMethod, number> => ({
    override: 0, utm_id_campaign: 0, utm_id_ad: 0, name: 0, content_ad: 0, term_adset: 0, none: 0,
})

function topEntry<T extends string>(m: Record<T, number> | Map<T, number>): T | null {
    const entries = m instanceof Map ? Array.from(m.entries()) : (Object.entries(m) as [T, number][])
    let best: T | null = null
    let bestC = -1
    for (const [k, c] of entries) { if (c > bestC) { bestC = c; best = k } }
    return best
}

/**
 * (Puro) desglose de TODOS los valores de utm_campaign de los leads con su estado
 * de cruce (a qué campaña, por qué método) — para que el trafficker confirme que
 * cada UTM de los leads se visualiza y, si no cruzó, lo pueda mapear.
 */
function computeUtmBreakdown(ctx: CrossContext): UtmCampaignRow[] {
    const { idx, overrides, leads } = ctx
    type G = { count: number; methods: Record<MatchMethod, number>; campaigns: Map<string, number> }
    const groups = new Map<string, G>()
    for (const l of leads) {
        const value = ((l.utm_campaign as string) || '').trim() || '(vacío)'
        const m = matchToCampaign(l, idx, overrides)
        const campName = m.key ? (idx.campaigns.get(m.key)?.name ?? null) : null
        let g = groups.get(value)
        if (!g) { g = { count: 0, methods: ZERO_METHODS(), campaigns: new Map() }; groups.set(value, g) }
        g.count += 1
        g.methods[m.method] += 1
        if (campName) g.campaigns.set(campName, (g.campaigns.get(campName) ?? 0) + 1)
    }
    return Array.from(groups.entries())
        .map(([value, g]) => {
            const crossed = g.count - g.methods.none
            const matched_campaign = crossed > 0 ? topEntry(g.campaigns) : null
            // Método dominante; si cruzó, excluye 'none' para no mostrar un badge contradictorio.
            const methodPool = crossed > 0 ? { ...g.methods, none: 0 } : g.methods
            const method = (topEntry(methodPool) ?? 'none') as MatchMethod
            const invalid_reason = crossed === 0 ? classifyInvalidUtm(value) : null
            const suggestion = crossed === 0 && !invalid_reason ? bestSuggestion(value, idx) : null
            return { value, count: g.count, matched_campaign, distinct_campaigns: g.campaigns.size, method, invalid_reason, suggestion }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 500)
}

/** (Puro) cobertura del cruce: total de leads y conteo por método de match. */
function computeCoverage(ctx: CrossContext): MatchCoverage {
    const methods = ZERO_METHODS()
    for (const l of ctx.leads) {
        const m = matchToCampaign(l, ctx.idx, ctx.overrides)
        methods[m.method] += 1
    }
    return { total: ctx.leads.length, methods }
}

/** (Puro) lista de campañas conocidas (para poblar selectores de mapeo). */
function campaignsFromIndex(idx: CampaignIndex): { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[] {
    return Array.from(idx.campaigns.values())
        .map(c => ({ campaign_id: c.campaign_id, name: c.name, platform: c.platform, spend: round2(c.spend) }))
        .sort((a, b) => b.spend - a.spend)
}

export interface CrossDiagnostics {
    campaigns: { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[]
    suggestions: UnmatchedRow[]
    invalid: InvalidUtmRow[]
    breakdown: UtmCampaignRow[]
    coverage: MatchCoverage
}

/**
 * Diagnóstico combinado para la UI de cruce: campañas, desglose de TODOS los
 * utm_campaign con su estado de match, sugerencias (no cruzados mapeables), UTMs
 * inválidas (macros/vacíos) y cobertura por método. Carga los leads y el índice
 * UNA sola vez.
 */
export async function getCrossDiagnostics(params: CampaignCrossParams): Promise<CrossDiagnostics> {
    const ctx = await loadCrossContext(params)
    if (!ctx) return { campaigns: [], suggestions: [], invalid: [], breakdown: [], coverage: { total: 0, methods: ZERO_METHODS() } }
    const { suggestions, invalid } = computeUnmatched(ctx)
    return {
        campaigns: campaignsFromIndex(ctx.idx),
        suggestions,
        invalid,
        breakdown: computeUtmBreakdown(ctx),
        coverage: computeCoverage(ctx),
    }
}
