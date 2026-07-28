// ¿Qué métricas tienen datos reales para este cliente y rango?
//
// El catálogo del BI expone métricas de cinco fuentes distintas (leads, ventas,
// gasto Meta/TikTok, GA4/Hotmart, offline, suscripciones) y ninguna aplica a
// todos los clientes: un cliente que solo corre TikTok no tiene alcance ni
// eventos de píxel; uno sin webhooks de venta no tiene revenue ni ROAS. Antes
// esas métricas se elegían igual y el widget mostraba 0 sin explicación.
//
// Este módulo devuelve un mapa métrica → ¿hay datos?, que el editor usa para
// marcarlas (no las oculta: el trafficker puede querer dejarlas configuradas
// para cuando la fuente empiece a alimentarse).

import { createAdminClient } from '@/utils/supabase/server'
import {
    METRIC_META, AD_JSONB_METRICS, AD_SCALAR_METRICS, MANUAL_JSONB_METRICS,
    OFFLINE_METRICS, SUBS_METRICS, makeOfflineFieldMetric, isOfflineFieldMetric,
    makeSheetDim, makeSheetMetric, makeSheetView, isSheetToken,
} from './bi-metadata'
import type { BiMetric } from './bi-metadata'
import { loadCamposCliente } from '@/lib/sheets/campos-db'

export interface AvailabilityParams {
    cliente_id?: string
    date_from?: string
    date_to?: string
}

export type MetricAvailability = Record<string, boolean>

function num(v: unknown): number {
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
}

type HasFn = (k: string) => boolean

/** La facturación Hotmart suma los tres tipos de venta: basta con que haya uno. */
const hasHotmartRevenue = (has: HasFn) =>
    has('ventas_principal') || has('ventas_bump') || has('ventas_upsell')

const hasHotmartSales = (has: HasFn) =>
    has('ventas_principal_count') || has('ventas_bump_count') || has('ventas_upsell_count')

export async function getMetricAvailability(params: AvailabilityParams): Promise<MetricAvailability> {
    const db = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    // Acumuladores: 0 = sin datos en el rango.
    const totals: Record<string, number> = {}
    const bump = (k: string, v: number) => { totals[k] = (totals[k] ?? 0) + v }

    // ── Gasto y métricas de campaña (public.metricas_diarias) ────────────
    let publicClienteId: string | null = null
    if (params.cliente_id) {
        const { data } = await db.schema('report_utm').from('clientes')
            .select('public_cliente_id').eq('id', params.cliente_id).maybeSingle()
        publicClienteId = data?.public_cliente_id ?? null
    }

    if (!params.cliente_id || publicClienteId) {
        let q = db.from('metricas_diarias')
            .select([
                'meta_spend', 'tiktok_spend', 'meta_clicks', 'tiktok_clicks',
                'meta_impressions', 'tiktok_impressions',
                ...AD_SCALAR_METRICS, 'ga_bounce_rate', 'ga_avg_session_duration',
                'metricas_manuales', 'meta_campaigns',
            ].join(','))
            .gte('fecha', dateFrom)
            .lte('fecha', dateTo)
            .limit(2000)
        if (publicClienteId) q = q.eq('cliente_id', publicClienteId)

        const { data } = await q
        for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
            bump('meta_spend', num(r.meta_spend))
            bump('tiktok_spend', num(r.tiktok_spend))
            bump('spend', num(r.meta_spend) + num(r.tiktok_spend))
            bump('clicks', num(r.meta_clicks) + num(r.tiktok_clicks))
            bump('impressions', num(r.meta_impressions) + num(r.tiktok_impressions))
            bump('ga_bounce_rate', num(r.ga_bounce_rate))
            bump('ga_avg_session_duration', num(r.ga_avg_session_duration))
            for (const k of AD_SCALAR_METRICS) bump(k, num(r[k]))
            const manuales = (r.metricas_manuales ?? {}) as Record<string, unknown>
            for (const { metric, jsonKey } of MANUAL_JSONB_METRICS) bump(metric, num(manuales[jsonKey]))
            for (const c of (r.meta_campaigns as Record<string, unknown>[] | null) ?? []) {
                for (const k of AD_JSONB_METRICS) bump(k, num(c[k]))
            }
        }
    }

    // ── Leads, ventas, offline y suscripciones ───────────────────────────
    const rtm = db.schema('report_utm')

    const leadsQ = rtm.from('lead_events').select('id', { count: 'exact', head: true })
        .gte('created_at', dateFrom + 'T00:00:00').lte('created_at', dateTo + 'T23:59:59')
    const salesQ = rtm.from('sales_events').select('amount')
        .gte('created_at', dateFrom + 'T00:00:00').lte('created_at', dateTo + 'T23:59:59')
        .eq('status', 'approved').limit(1000)
    let offlineQ = db.from('conversiones_offline_diarias').select('tipo, total_cantidad, total_valor, custom_fields')
        .gte('fecha', dateFrom).lte('fecha', dateTo).limit(1000)
    let subsQ = db.from('hotmart_subscriptions_snapshot')
        .select('active_count, delayed_count, canceled_count, total_count, active_recurring_value')
        .lte('captured_date', dateTo).order('captured_date', { ascending: false }).limit(1)

    if (params.cliente_id) {
        leadsQ.eq('cliente_id', params.cliente_id)
        salesQ.eq('cliente_id', params.cliente_id)
    }
    if (publicClienteId) {
        offlineQ = offlineQ.eq('cliente_id', publicClienteId)
        subsQ = subsQ.eq('cliente_id', publicClienteId)
    }

    const [leadsRes, salesRes, offlineRes, subsRes] = await Promise.all([
        leadsQ, salesQ, offlineQ, subsQ,
    ])

    bump('leads_count', leadsRes.count ?? 0)
    for (const s of (salesRes.data ?? []) as unknown as Record<string, unknown>[]) {
        bump('sales_count', 1)
        bump('revenue', num(s.amount))
    }
    for (const o of (offlineRes.data ?? []) as unknown as Record<string, unknown>[]) {
        const cant = num(o.total_cantidad)
        bump('offline_total', cant)
        bump('offline_revenue', num(o.total_valor))
        if (o.tipo === 'lead')  bump('offline_leads', cant)
        if (o.tipo === 'venta') bump('offline_ventas', cant)
        // Columnas adicionales del Sheet: disponibles si traen algún valor. El
        // token lleva el tipo y los datos no lo guardan, así que se marcan las
        // tres variantes (solo una existirá en el catálogo del cliente).
        for (const [k, v] of Object.entries((o.custom_fields ?? {}) as Record<string, unknown>)) {
            for (const t of ['count', 'currency', 'percentage'] as const) {
                bump(makeOfflineFieldMetric(t, k), num(v))
            }
        }
    }
    // ── Campos de Sheet ──────────────────────────────────────────────────
    // A diferencia de los offfield:*, aquí el desglose diario dice la verdad
    // sobre si hay datos, así que no hace falta marcar variantes a ciegas: se
    // marca exactamente el token que existe.
    if (publicClienteId) {
        const { campos, vistas } = await loadCamposCliente(db, publicClienteId, { soloActivos: true })
        if (campos.length > 0) {
            const { data: desglose } = await db.from('sheet_campo_valores_diarios')
                .select('campo_id, valor, filas, suma')
                .eq('cliente_id', publicClienteId)
                .gte('fecha', dateFrom).lte('fecha', dateTo)

            const filasPorCampo = new Map<string, number>()
            const valoresPorCampo = new Map<string, Set<string>>()
            for (const r of (desglose ?? []) as unknown as Record<string, unknown>[]) {
                const id = String(r.campo_id)
                filasPorCampo.set(id, (filasPorCampo.get(id) ?? 0) + num(r.filas))
                const set = valoresPorCampo.get(id) ?? new Set<string>()
                set.add(String(r.valor ?? ''))
                valoresPorCampo.set(id, set)
            }

            for (const campo of campos) {
                const filas = filasPorCampo.get(campo.id) ?? 0
                bump(makeSheetDim(campo.clave), filas)
                for (const agg of ['count', 'sum', 'avg', 'min', 'max'] as const) {
                    bump(makeSheetMetric(agg, campo.clave), filas)
                }
            }
            for (const vista of vistas) {
                // Una vista solo está disponible si alguno de sus valores existe en
                // el rango: si no, mostraría un 0 que se lee como "no hubo", cuando
                // lo que pasa es que ese bucket ya no aparece en los datos.
                const valores = valoresPorCampo.get(vista.campo_id)
                const hayAlguno = !valores ? false
                    : vista.operador === 'not_in'
                        ? Array.from(valores).some(v => !vista.valores.includes(v))
                        : vista.valores.some(v => valores.has(v))
                bump(makeSheetView(vista.clave), hayAlguno ? 1 : 0)
            }
        }
    }

    const subs = (subsRes.data ?? [])[0] as Record<string, unknown> | undefined
    if (subs) {
        bump('subs_active', num(subs.active_count))
        bump('subs_delayed', num(subs.delayed_count))
        bump('subs_canceled', num(subs.canceled_count))
        bump('subs_total', num(subs.total_count))
        bump('subs_mrr', num(subs.active_recurring_value))
    }

    // ── Derivadas: disponibles si lo están sus componentes ───────────────
    const has = (k: string) => (totals[k] ?? 0) > 0
    const out: MetricAvailability = {}
    for (const metric of Object.keys(METRIC_META) as BiMetric[]) {
        switch (metric) {
            case 'cpl':             out[metric] = has('spend') && has('leads_count'); break
            case 'cpa':             out[metric] = has('spend') && has('sales_count'); break
            case 'roas':            out[metric] = has('spend') && has('revenue'); break
            case 'conversion_rate': out[metric] = has('leads_count') && has('sales_count'); break
            case 'cpc':             out[metric] = has('spend') && has('clicks'); break
            case 'cpm':             out[metric] = has('spend') && has('impressions'); break
            case 'ctr':             out[metric] = has('clicks') && has('impressions'); break
            case 'frequency':       out[metric] = has('impressions') && has('reach'); break
            case 'hotmart_revenue': out[metric] = hasHotmartRevenue(has); break
            case 'hotmart_sales':   out[metric] = hasHotmartSales(has); break
            case 'hotmart_roas':    out[metric] = has('spend') && hasHotmartRevenue(has); break
            case 'hotmart_roi':     out[metric] = has('spend') && hasHotmartRevenue(has); break
            case 'hotmart_cpa':     out[metric] = has('spend') && hasHotmartSales(has); break
            default:                out[metric] = has(metric)
        }
    }
    // Se declaran explícitamente para no depender del orden del switch.
    for (const k of [...OFFLINE_METRICS, ...SUBS_METRICS]) out[k] = has(k)
    // Tokens dinámicos: columnas de Sheet (offfield:*) y campos de Sheet
    // (sheetdim:/sheetagg:/sheetview:) vistos en el rango.
    for (const k of Object.keys(totals)) {
        if (isOfflineFieldMetric(k) || isSheetToken(k)) out[k] = has(k)
    }

    return out
}
