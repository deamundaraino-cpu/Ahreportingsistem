/**
 * Plantillas de arranque del BI, ya con las dimensiones unificadas.
 *
 * Las cuatro plantillas originales (migración 032) se escribieron cuando el
 * gasto no cruzaba con los leads: por eso sus tablas por campaña mezclaban
 * columnas que salían siempre en 0. Estas tres usan el cruce real y solo
 * métricas recomendadas, de modo que un informe nuevo arranca mostrando datos.
 *
 * Este script es la ÚNICA fuente de verdad: genera la migración
 * `migrations/062_bi_plantillas_unificadas.sql` y aplica las mismas filas al
 * proyecto, así el repo y producción no pueden divergir.
 *
 *   npx tsx scripts/seed-bi-plantillas.ts          (escribe la migración y aplica)
 *   npx tsx scripts/seed-bi-plantillas.ts --dry    (solo escribe la migración)
 */

import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'fs'
import type { BiWidget } from '../src/components/report-utm/bi/BiTypes'
import {
    METRIC_META, DIMENSION_META, FUNNEL_STAGE_METRICS, metricCrossesDimension,
} from '../src/lib/report-utm/bi-metadata'

loadEnv({ path: '.env.local' })

interface Plantilla {
    nombre: string
    descripcion: string
    layout: BiWidget[]
}

/** Scorecard con comparación vs período anterior (el semáforo lo pone la meta del cliente). */
const kpi = (id: string, title: string, metric: string): BiWidget => ({
    id, type: 'scorecard', title, w: 1, h: 1,
    config: { metric, dimension: 'none', compare_period: true },
})

const titulo = (id: string, title: string, level: 1 | 2 = 2, accent?: string): BiWidget => ({
    id, type: 'heading', title, w: 4, h: 1,
    config: { heading_level: level, ...(accent ? { accent } : {}) },
})

const PLANTILLAS: Plantilla[] = [
    {
        nombre: 'Rendimiento por campaña',
        descripcion: 'Qué campaña trae los contactos y a qué costo. Cruza leads, gasto y ventas por el nombre real de la campaña.',
        layout: [
            titulo('h-resumen', 'Resumen del período', 1, '#10b981'),
            kpi('kpi-spend', 'Inversión', 'spend'),
            kpi('kpi-leads', 'Contactos', 'leads_count'),
            kpi('kpi-cpl', 'Costo por contacto', 'cpl'),
            kpi('kpi-roas', 'Retorno (ROAS)', 'roas'),
            { id: 'sum-1', type: 'summary', title: 'Cómo fue el período', w: 4, h: 1, config: {} },
            titulo('h-campanas', 'Detalle por campaña'),
            {
                id: 'tbl-campanas', type: 'table', title: 'Campañas', w: 4, h: 2,
                config: {
                    metric: 'spend,leads_count,cpl,sales_count,roas',
                    dimension: 'utm_campaign',
                    limit: 20, sort: 'desc', show_totals: true,
                },
            },
            titulo('h-evolucion', 'Evolución y creatividades'),
            {
                id: 'line-leads', type: 'line', title: 'Contactos por día', w: 2, h: 2,
                config: { metric: 'leads_count', dimension: 'date', date_grouping: 'day', color: '#10b981' },
            },
            {
                id: 'bar-ads', type: 'bar', title: 'Inversión por anuncio', w: 2, h: 2,
                config: { metric: 'spend', dimension: 'ad', limit: 10, sort: 'desc', color: '#8b5cf6' },
            },
        ],
    },
    {
        nombre: 'Origen y atribución',
        descripcion: 'De dónde vienen los contactos y cómo avanzan hasta la venta. Source, medium y embudo completo.',
        layout: [
            titulo('h-origen', 'De dónde vienen los contactos', 1, '#06b6d4'),
            kpi('kpi-leads', 'Contactos', 'leads_count'),
            kpi('kpi-sales', 'Ventas', 'sales_count'),
            kpi('kpi-conv', 'Tasa de conversión', 'conversion_rate'),
            {
                id: 'slicer-campana', type: 'slicer', title: 'Filtrar por campaña', w: 1, h: 1,
                config: { dimension: 'utm_campaign', slicer_mode: 'dropdown', source: 'leads' },
            },
            {
                id: 'bar-source', type: 'bar', title: 'Contactos por Source', w: 2, h: 2,
                config: { metric: 'leads_count', dimension: 'utm_source', limit: 10, sort: 'desc', color: '#06b6d4' },
            },
            {
                id: 'pie-medium', type: 'pie', title: 'Reparto por Medium', w: 2, h: 2,
                config: { metric: 'leads_count', dimension: 'utm_medium', limit: 8, sort: 'desc' },
            },
            titulo('h-embudo', 'Del anuncio al cliente'),
            {
                id: 'funnel-1', type: 'funnel', title: 'Embudo de conversión', w: 2, h: 3,
                config: { metrics: ['impressions', 'clicks', 'leads_count', 'sales_count'] },
            },
            {
                id: 'tbl-source', type: 'table', title: 'Rendimiento por Source', w: 2, h: 3,
                config: {
                    metric: 'leads_count,sales_count,conversion_rate',
                    dimension: 'utm_source',
                    limit: 15, sort: 'desc', show_totals: true,
                },
            },
        ],
    },
    {
        nombre: 'Cierre de mes',
        descripcion: 'Informe para enviar al cliente: resumen en lenguaje simple, comparación con el período anterior y detalle por campaña.',
        layout: [
            titulo('h-cierre', 'Cierre del período', 1, '#f59e0b'),
            { id: 'sum-1', type: 'summary', title: 'Resumen', w: 4, h: 1, config: {} },
            kpi('kpi-spend', 'Inversión', 'spend'),
            kpi('kpi-leads', 'Contactos', 'leads_count'),
            kpi('kpi-cpl', 'Costo por contacto', 'cpl'),
            kpi('kpi-roas', 'Retorno (ROAS)', 'roas'),
            titulo('h-evolucion', 'Cómo evolucionó el mes'),
            {
                id: 'line-mes', type: 'line', title: 'Contactos por día', w: 4, h: 2,
                config: { metric: 'leads_count', dimension: 'date', date_grouping: 'day', color: '#f59e0b' },
            },
            titulo('h-detalle', 'Detalle por campaña'),
            {
                id: 'tbl-cierre', type: 'table', title: 'Campañas del período', w: 4, h: 2,
                config: {
                    metric: 'spend,leads_count,cpl,sales_count,revenue,roas',
                    dimension: 'utm_campaign',
                    limit: 25, sort: 'desc', show_totals: true,
                },
            },
            {
                id: 'nota-final', type: 'text', title: 'Notas del equipo', w: 4, h: 1,
                config: { text: 'Escribe aquí el comentario que acompaña al informe: qué se probó este mes, qué funcionó y qué sigue.' },
            },
        ],
    },
]

// ── Migración (fuente de verdad del repo) ─────────────────────────────

const MIGRACION = 'migrations/062_bi_plantillas_unificadas.sql'

function generarSql(): string {
    const filas = PLANTILLAS.map(p => `(
    ${sq(p.nombre)},
    ${sq(p.descripcion)},
    ${sq(JSON.stringify(p.layout, null, 4))}::jsonb,
    '{}'::jsonb,
    true,
    NULL,
    NULL
)`).join(',\n')

    return `-- ============================================================
-- 062_bi_plantillas_unificadas.sql
-- Plantillas de arranque del BI con las dimensiones unificadas.
-- ------------------------------------------------------------
-- GENERADO por scripts/seed-bi-plantillas.ts — no editar a mano.
--
-- Las cuatro plantillas de la migración 032 se escribieron cuando el gasto
-- no cruzaba con los leads: sus tablas por campaña mezclaban columnas que
-- salían siempre en 0. Estas tres usan el cruce real (utm_campaign ya
-- resuelve contra las campañas del reporting) y solo métricas recomendadas,
-- así que un informe nuevo arranca mostrando datos.
--
-- IDEMPOTENTE: reejecutarla actualiza el layout en vez de fallar por nombre
-- duplicado. La cláusula de conflicto reproduce el predicado EXACTO del índice
-- que hay en producción:
--
--   CREATE UNIQUE INDEX bi_reports_system_template_nombre_uq
--       ON public.bi_reports (nombre)
--       WHERE (is_template IS TRUE AND created_by IS NULL)
--
-- Ese índice NO está en ninguna migración de este repo: se creó directo en la
-- base (ver docs/04-modelo-de-datos.md, "objetos sin migración"). Por eso las
-- filas se insertan con created_by = NULL explícito, que es lo que las mete
-- dentro del alcance del índice y hace que el ON CONFLICT las alcance.
-- ============================================================

INSERT INTO public.bi_reports
    (nombre, descripcion, layout, filters, is_template, cliente_id, created_by)
VALUES
${filas}
ON CONFLICT (nombre) WHERE (is_template IS TRUE AND created_by IS NULL)
DO UPDATE SET
    descripcion = EXCLUDED.descripcion,
    layout      = EXCLUDED.layout,
    filters     = EXCLUDED.filters;
`
}

/** Escapa una cadena para SQL (comillas simples dobladas). */
function sq(s: string): string {
    return `'${s.replace(/'/g, "''")}'`
}

// ── Validación ────────────────────────────────────────────────────────
// Una plantilla mal formada es peor que no tener plantilla: se propaga a cada
// informe que la clone. Se comprueba antes de escribir nada.

const TIPOS_CON_DATOS = new Set(['scorecard', 'line', 'area', 'bar', 'combo', 'pie', 'scatter', 'table', 'funnel'])

function validar(): string[] {
    const errores: string[] = []
    for (const p of PLANTILLAS) {
        const ids = new Set<string>()
        for (const w of p.layout) {
            const donde = `${p.nombre} → ${w.id}`
            if (ids.has(w.id)) errores.push(`${donde}: id duplicado`)
            ids.add(w.id)
            if ((w.w ?? 1) < 1 || (w.w ?? 1) > 4) errores.push(`${donde}: ancho fuera de 1-4`)
            if ((w.h ?? 1) < 1 || (w.h ?? 1) > 3) errores.push(`${donde}: alto fuera de 1-3`)

            const dim = w.config.dimension
            if (dim && !DIMENSION_META[dim as keyof typeof DIMENSION_META]) {
                errores.push(`${donde}: dimensión desconocida "${dim}"`)
            }
            if (!TIPOS_CON_DATOS.has(w.type)) continue

            if (w.type === 'funnel') {
                for (const m of w.config.metrics ?? []) {
                    if (!(FUNNEL_STAGE_METRICS as readonly string[]).includes(m)) {
                        errores.push(`${donde}: "${m}" no vale como etapa de embudo`)
                    }
                }
                continue
            }

            const metricas = String(w.config.metric ?? '').split(',').map(s => s.trim()).filter(Boolean)
            if (!metricas.length) { errores.push(`${donde}: sin métrica`); continue }
            for (const m of metricas) {
                if (!METRIC_META[m as keyof typeof METRIC_META]) {
                    errores.push(`${donde}: métrica desconocida "${m}"`)
                } else if (dim && !metricCrossesDimension(m, dim)) {
                    // Esto es exactamente lo que el editor marca como "no cruza":
                    // una plantilla no debe nacer con una columna condenada a 0.
                    errores.push(`${donde}: "${m}" no se desglosa por "${dim}" (saldría en la fila total)`)
                }
            }
        }
    }
    return errores
}

// ── Aplicación al proyecto ────────────────────────────────────────────

async function main() {
    const errores = validar()
    if (errores.length) {
        console.log('✗ Plantillas inválidas, no se escribe nada:')
        for (const e of errores) console.log(`   · ${e}`)
        process.exitCode = 1
        return
    }
    console.log(`· ${PLANTILLAS.length} plantillas válidas (${PLANTILLAS.reduce((n, p) => n + p.layout.length, 0)} widgets)`)

    writeFileSync(MIGRACION, generarSql(), 'utf8')
    console.log(`· Migración escrita: ${MIGRACION}`)

    if (process.argv.includes('--dry')) {
        console.log('· --dry: no se toca la base.')
        return
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
        console.log('⚠ Sin credenciales en .env.local: no se aplica nada.')
        process.exitCode = 1
        return
    }
    const db = createClient(url, key)

    // Prueba real: cada widget de datos se ejecuta contra el cliente con más
    // volumen. Una plantilla que valida pero devuelve tablas vacías no sirve de
    // arranque a nadie, y eso solo se ve consultando.
    if (process.argv.includes('--probe')) {
        await probar(db)
        return
    }

    for (const p of PLANTILLAS) {
        const { data: existente } = await db.from('bi_reports')
            .select('id').eq('nombre', p.nombre).eq('is_template', true).maybeSingle()

        const fila = {
            nombre: p.nombre,
            descripcion: p.descripcion,
            layout: p.layout,
            filters: {},
            is_template: true,
            cliente_id: null,
        }

        if (existente) {
            const { error } = await db.from('bi_reports').update(fila).eq('id', existente.id)
            console.log(error ? `  ✗ ${p.nombre}: ${error.message}` : `  ✓ ${p.nombre} (actualizada)`)
        } else {
            const { error } = await db.from('bi_reports').insert(fila)
            console.log(error ? `  ✗ ${p.nombre}: ${error.message}` : `  ✓ ${p.nombre} (creada)`)
        }
    }

    const { data: todas } = await db.from('bi_reports')
        .select('nombre').eq('is_template', true).order('nombre')
    console.log(`\n· Plantillas en el sistema (${todas?.length ?? 0}): ${(todas ?? []).map(t => t.nombre).join(' · ')}`)
}

/** Ejecuta cada widget de datos contra el cliente con más leads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function probar(db: any) {
    const desde = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const hasta = new Date().toISOString().slice(0, 10)

    const { data: cs } = await db.schema('report_utm').from('clientes')
        .select('id,nombre').not('public_cliente_id', 'is', null).limit(50)
    let cid = '', nombre = '', best = 0
    for (const c of cs ?? []) {
        const { count } = await db.schema('report_utm').from('lead_events')
            .select('id', { count: 'exact', head: true })
            .eq('cliente_id', c.id).gte('created_at', desde + 'T00:00:00')
        if ((count ?? 0) > best) { best = count ?? 0; cid = c.id; nombre = c.nombre }
    }
    if (!cid) { console.log('⚠ sin clientes con leads'); return }
    console.log(`\n· Probando contra ${nombre} (${best} leads, ${desde} → ${hasta})\n`)

    const { runBiQuery, runFunnelQuery } = await import('../src/lib/report-utm/bi-query')
    let vacios = 0
    for (const p of PLANTILLAS) {
        console.log(`  ${p.nombre}`)
        for (const w of p.layout) {
            if (!TIPOS_CON_DATOS.has(w.type)) continue
            const base = { cliente_id: cid, date_from: desde, date_to: hasta }
            let n = 0, muestra = ''
            if (w.type === 'funnel') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const etapas = await runFunnelQuery({ ...base, metrics: w.config.metrics as any })
                n = etapas.filter(e => e.value > 0).length
                muestra = etapas.map(e => `${e.label}=${e.value}`).join(' → ')
            } else {
                const rows = await runBiQuery({
                    ...base,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    metrics: String(w.config.metric).split(',').map(s => s.trim()) as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    dimension: (w.config.dimension ?? 'none') as any,
                    date_grouping: w.config.date_grouping,
                    limit: w.config.limit,
                    sort: w.config.sort,
                })
                n = rows.length
                const primera = rows[0]
                muestra = primera
                    ? Object.entries(primera).filter(([k]) => k !== 'dimension_value' && k !== '__nocross')
                        .map(([k, v]) => `${k}=${v}`).join(' ')
                    : ''
            }
            if (n === 0) vacios++
            console.log(`    ${n > 0 ? '✓' : '✗'} ${w.title.padEnd(26)} ${String(n).padStart(4)} · ${muestra.slice(0, 90)}`)
        }
    }
    console.log(vacios === 0
        ? '\n✅ Todos los widgets devuelven datos\n'
        : `\n⚠ ${vacios} widget(s) sin datos para este cliente\n`)
}

main().catch(e => { console.error('ERROR', e); process.exitCode = 1 })
