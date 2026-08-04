// Endpoint de datos para las vistas PÚBLICAS de un informe BI.
//
// Las páginas /report/bi/[token] y /report/bi/d/[token] se sirven sin sesión,
// pero sus widgets consultaban /api/report-utm/bi/query, que exige usuario →
// todos devolvían 401 y el cliente veía "Error al cargar". Este endpoint resuelve
// los datos validando ÚNICAMENTE el token del informe (link compartido) o el de
// una entrega del historial.
//
// El token es la credencial: todo lo que acota el alcance de la consulta se
// impone aquí en el servidor y NO se acepta del cliente.
//   • cliente_id → siempre el del informe (un token no puede leer otro cliente).
//   • filtros persistidos del informe (incluido el avanzado __adv) → siempre
//     aplicados; el visitante solo puede AÑADIR drill-downs, no quitarlos.
//   • token de entrega → rango de fechas congelado en el período entregado.
//   • type=distinct (valores de una dimensión) → solo para dimensiones que el
//     informe expone en un slicer.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import { parseBiQueryParams } from '@/lib/report-utm/bi-query-params'
import { dispatchBiQuery } from '@/lib/report-utm/bi-dispatch'
import { sanitizeForClient } from '@/lib/report-utm/bi/diagnostics'
import { ADVANCED_FILTER_KEY, parseAdvancedFilter, advancedFilterHasConditions } from '@/lib/report-utm/bi-metadata'
import type { BiDimension } from '@/lib/report-utm/bi-metadata'

export const dynamic = 'force-dynamic'

// Rate limit en memoria por token+IP. Es una mitigación básica de scraping del
// link público; en serverless cada instancia lleva su propio contador.
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 120
const hits = new Map<string, number[]>()

function rateLimited(key: string): boolean {
    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS)
    recent.push(now)
    hits.set(key, recent)
    if (hits.size > 5000) hits.clear()   // techo de memoria
    return recent.length > RATE_MAX
}

interface ReportRow {
    id: string
    cliente_id: string | null
    layout: unknown
    filters: Record<string, unknown> | null
}

/** Dimensiones que el informe expone en un slicer (únicas consultables con type=distinct). */
function slicerDimensions(layout: unknown): Set<string> {
    const dims = new Set<string>()
    const walk = (blocks: unknown) => {
        if (!Array.isArray(blocks)) return
        for (const b of blocks as Record<string, unknown>[]) {
            if (b?.type === 'slicer') {
                const cfg = (b.config ?? {}) as Record<string, unknown>
                if (cfg.dimension) dims.add(String(cfg.dimension))
            }
            if (b?.type === 'section') walk(b.children)
        }
    }
    walk(layout)
    return dims
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ token: string }> }
) {
    const { token } = await params
    if (!token) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (rateLimited(`${token}:${ip}`)) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    try {
        const db = await createAdminClient()

        // 1) ¿Es el token de un informe compartido?
        let report: ReportRow | null = null
        let lockedDates: { from: string; to: string } | null = null

        const { data: shared } = await db
            .from('bi_reports')
            .select('id, cliente_id, layout, filters')
            .eq('public_token', token)
            .maybeSingle()

        if (shared) {
            report = shared as ReportRow
        } else {
            // 2) ¿Es el token de una entrega del historial?
            const { data: delivery } = await db
                .from('bi_report_deliveries')
                .select('report_id, date_from, date_to')
                .eq('delivery_token', token)
                .maybeSingle()

            if (delivery) {
                const { data: parent } = await db
                    .from('bi_reports')
                    .select('id, cliente_id, layout, filters')
                    .eq('id', delivery.report_id)
                    .maybeSingle()
                if (parent) {
                    report = parent as ReportRow
                    lockedDates = { from: delivery.date_from, to: delivery.date_to }
                }
            }
        }

        // Token inválido → 404 (no 401: no se revela si el token existe o no).
        if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 })

        const parsed = parseBiQueryParams(req.nextUrl.searchParams)

        // ── Enforcement: el token manda sobre lo que pida el cliente ──────
        parsed.cliente_id = report.cliente_id ?? undefined

        if (lockedDates) {
            parsed.date_from = lockedDates.from
            parsed.date_to   = lockedDates.to
        }

        // Los filtros guardados del informe se re-aplican por encima de los del
        // visitante: puede añadir drill-downs, no puede levantar los fijos.
        const saved = (report.filters ?? {}) as Record<string, unknown>
        for (const [k, v] of Object.entries(saved)) {
            if (k === ADVANCED_FILTER_KEY || k === 'cliente_id') continue
            if (k === 'date_from' || k === 'date_to' || k === 'days') continue
            if (v !== null && v !== undefined && String(v)) parsed.filters[k] = String(v)
        }
        // El filtro guardado se FUSIONA en Y con el que trae el widget (su propio
        // filtro avanzado / filtro de campaña). Reemplazarlo perdía el filtro del
        // widget en la vista pública, así que un widget acotado a una campaña
        // mostraba los datos de todas. El visitante solo puede añadir condiciones,
        // nunca levantar las guardadas.
        const savedAdv = parseAdvancedFilter(saved[ADVANCED_FILTER_KEY])
        if (advancedFilterHasConditions(savedAdv)) {
            parsed.advancedFilter = {
                groups: [...(savedAdv.groups ?? []), ...(parsed.advancedFilter?.groups ?? [])],
            }
        }

        // Enumerar valores de una dimensión solo si el informe la expone en un slicer.
        if (parsed.type === 'distinct') {
            const allowed = slicerDimensions(report.layout)
            if (!allowed.has(parsed.dimension as BiDimension)) {
                return NextResponse.json({ data: [] })
            }
        }

        const result = await dispatchBiQuery(parsed)
        if (result.error) {
            return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
        }

        // `meta` saneado: el cliente ve POR QUÉ una celda está vacía, pero no el
        // estado del enlace interno entre los dos cliente_id de la plataforma.
        return NextResponse.json({ data: result.data, meta: sanitizeForClient(result.meta) }, {
            headers: { 'Cache-Control': 'private, max-age=30' },
        })
    } catch (err) {
        console.error('[bi/public/query]', err)
        return NextResponse.json({ error: 'Query error' }, { status: 500 })
    }
}
