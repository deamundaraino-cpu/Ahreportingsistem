/**
 * Línea base ("golden file") del motor del BI contra datos REALES.
 *
 * Es la red de seguridad del refactor del motor. El módulo ya sufrió una
 * auditoría por subconteo de leads (topes de filas, Top-N rompiendo el fetch,
 * fechas desalineadas) y una serie temporal desordenada que salió a la luz solo
 * al verificar. Cualquier reescritura del motor tiene que demostrar que produce
 * los MISMOS números ANTES de sustituir al actual, no después.
 *
 * Uso:
 *
 *   # 1. Capturar la línea base con el motor actual (hazlo ANTES de tocarlo)
 *   npx tsx scripts/verify-bi-golden.ts --capturar
 *
 *   # 2. Tras cualquier cambio en el motor: comparar
 *   npx tsx scripts/verify-bi-golden.ts
 *
 * Opciones:
 *   --capturar          escribe la línea base en scripts/golden/bi-baseline.json
 *   --desde=YYYY-MM-DD  inicio del rango (por defecto: mes pasado completo)
 *   --hasta=YYYY-MM-DD  fin del rango
 *   --clientes=3        cuántos clientes muestrear
 *   --tolerancia=0.01   diferencia numérica admitida (céntimos de redondeo)
 *
 * Nota sobre el rango: se FIJA en el archivo de línea base, no se recalcula, o
 * la comparación cambiaría sola cada mes.
 */

import { config as loadEnv } from 'dotenv'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

loadEnv({ path: '.env.local' })

const BASELINE = join(process.cwd(), 'scripts', 'golden', 'bi-baseline.json')

// ── Argumentos ──────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const opt = (n: string, def?: string) => {
    const a = args.find(x => x.startsWith(`--${n}=`))
    return a ? a.slice(n.length + 3) : def
}
const CAPTURAR = flag('capturar')
const TOLERANCIA = Number(opt('tolerancia', '0.01'))
const N_CLIENTES = Number(opt('clientes', '3'))

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ── La matriz de casos ──────────────────────────────────────────────────
// Se eligen a propósito los casos que ya fallaron alguna vez en este módulo:
// dimensión `date` (que se ordenaba por VALOR y descolocaba las gráficas),
// Top-N (que recortaba las filas CRUDAS y subcontaba), el cruce por campaña, y
// las métricas que dependen de fuentes distintas.
interface Caso {
    nombre: string
    metrics: string[]
    dimension: string
    limit?: number
    sort?: 'asc' | 'desc'
    date_grouping?: 'day' | 'week' | 'month'
}

const CASOS: Caso[] = [
    { nombre: 'leads total',              metrics: ['leads_count'], dimension: 'none' },
    { nombre: 'gasto total',              metrics: ['spend', 'meta_spend', 'tiktok_spend'], dimension: 'none' },
    { nombre: 'cruce gasto×leads',        metrics: ['spend', 'leads_count', 'cpl'], dimension: 'none' },
    { nombre: 'ventas y retorno',         metrics: ['sales_count', 'revenue', 'roas', 'cpa'], dimension: 'none' },
    { nombre: 'rendimiento de anuncios',  metrics: ['impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'reach', 'frequency'], dimension: 'none' },
    { nombre: 'hotmart',                  metrics: ['hotmart_revenue', 'hotmart_sales', 'hotmart_roas', 'hotmart_cpa', 'hotmart_roi'], dimension: 'none' },
    { nombre: 'ga4',                      metrics: ['ga_sessions', 'ga_bounce_rate', 'ga_avg_session_duration'], dimension: 'none' },
    { nombre: 'offline',                  metrics: ['offline_leads', 'offline_ventas', 'offline_revenue'], dimension: 'none' },
    { nombre: 'suscripciones (foto)',     metrics: ['subs_active', 'subs_mrr'], dimension: 'none' },
    // Serie temporal: el orden importa y ya se rompió una vez.
    { nombre: 'serie por día',            metrics: ['leads_count', 'spend'], dimension: 'date', date_grouping: 'day' },
    { nombre: 'serie por semana',         metrics: ['leads_count'], dimension: 'date', date_grouping: 'week' },
    { nombre: 'serie por mes',            metrics: ['spend'], dimension: 'date', date_grouping: 'month' },
    // El cruce, que es el corazón del módulo.
    { nombre: 'por campaña (cruzada)',    metrics: ['spend', 'leads_count', 'cpl', 'sales_count'], dimension: 'utm_campaign', limit: 20, sort: 'desc' },
    { nombre: 'por campaña CRUDA',        metrics: ['leads_count'], dimension: 'utm_campaign_raw', limit: 20, sort: 'desc' },
    { nombre: 'por anuncio',              metrics: ['spend', 'impressions'], dimension: 'ad', limit: 10, sort: 'desc' },
    { nombre: 'por conjunto',             metrics: ['spend'], dimension: 'adset', limit: 10, sort: 'desc' },
    // Dimensiones que NO cruzan con el gasto: el caso "sale 0" que hay que
    // congelar tal cual antes de convertirlo en "—".
    { nombre: 'por país (gasto no cruza)', metrics: ['leads_count', 'spend', 'cpl'], dimension: 'ip_country', limit: 15, sort: 'desc' },
    { nombre: 'por source',               metrics: ['leads_count', 'sales_count', 'conversion_rate'], dimension: 'utm_source', limit: 15, sort: 'desc' },
    { nombre: 'por formulario',           metrics: ['leads_count'], dimension: 'form_name', limit: 15, sort: 'desc' },
    // Top-N: separar el fetch del recorte fue un arreglo de exactitud.
    { nombre: 'Top-3 campañas',           metrics: ['leads_count'], dimension: 'utm_campaign', limit: 3, sort: 'desc' },
]

interface FilaGuardada { [k: string]: string | number | null }
interface ResultadoCaso {
    caso: string
    filas: FilaGuardada[]
    error?: string
}
interface Snapshot {
    generado: string
    rango: { desde: string; hasta: string }
    clientes: Array<{ id: string; nombre: string; publicLink: boolean }>
    resultados: Record<string, ResultadoCaso[]>   // clienteId → casos
    extras: Record<string, Record<string, unknown>>
}

/** Redondea para que el snapshot no dependa de la basura de coma flotante. */
function limpiar(v: unknown): string | number | null {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null
    return String(v)
}

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const { runBiQuery, runFunnelQuery, runComparison, runDistinctValues } =
        await import('../src/lib/report-utm/bi-query')

    const db = await createAdminClient()

    // ── Rango ────────────────────────────────────────────────────────
    // Si ya hay línea base, se REUTILIZA su rango: comparar contra otro rango
    // no probaría nada.
    let desde = opt('desde')
    let hasta = opt('hasta')
    const previo: Snapshot | null =
        existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null

    if (!desde || !hasta) {
        if (previo && !CAPTURAR) {
            desde = previo.rango.desde
            hasta = previo.rango.hasta
        } else {
            // Mes pasado completo: es un rango cerrado, así que no cambia por
            // que entren datos nuevos hoy.
            const hoy = new Date()
            const finMesPasado = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0))
            const iniMesPasado = new Date(Date.UTC(finMesPasado.getUTCFullYear(), finMesPasado.getUTCMonth(), 1))
            desde = iniMesPasado.toISOString().slice(0, 10)
            hasta = finMesPasado.toISOString().slice(0, 10)
        }
    }
    console.log(`\nRango: ${desde} → ${hasta}${CAPTURAR ? '   [CAPTURA]' : '   [COMPARACIÓN]'}`)

    // ── Clientes ─────────────────────────────────────────────────────
    // Se prefieren los que tienen enlace público (ven todas las fuentes) y se
    // incluye uno SIN enlace si existe, porque es el caso del cero silencioso.
    let clientes: Array<{ id: string; nombre: string; publicLink: boolean }>
    if (previo && !CAPTURAR) {
        clientes = previo.clientes
    } else {
        const { data, error } = await db.schema('report_utm')
            .from('clientes')
            .select('id,nombre,public_cliente_id')
            .order('nombre')
        if (error) throw new Error(`No se pudieron listar clientes: ${error.message}`)
        const todos = (data ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>
        const conEnlace = todos.filter(c => c.public_cliente_id)
        const sinEnlace = todos.filter(c => !c.public_cliente_id)
        clientes = [
            ...conEnlace.slice(0, Math.max(1, N_CLIENTES - (sinEnlace.length ? 1 : 0))),
            ...sinEnlace.slice(0, sinEnlace.length ? 1 : 0),
        ].map(c => ({ id: c.id, nombre: c.nombre, publicLink: !!c.public_cliente_id }))
    }

    if (!clientes.length) {
        console.log('\n⚠ No hay clientes en report_utm.clientes: no se puede capturar línea base.')
        process.exit(1)
    }
    console.log(`Clientes: ${clientes.map(c => `${c.nombre}${c.publicLink ? '' : ' (sin enlace)'}`).join(', ')}\n`)

    // ── Ejecución de la matriz ───────────────────────────────────────
    const resultados: Snapshot['resultados'] = {}
    const extras: Snapshot['extras'] = {}

    for (const cliente of clientes) {
        process.stdout.write(`  ${cliente.nombre}: `)
        const deCliente: ResultadoCaso[] = []

        for (const caso of CASOS) {
            try {
                const rows = await runBiQuery({
                    cliente_id: cliente.id,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    metrics: caso.metrics as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    dimension: caso.dimension as any,
                    date_from: desde,
                    date_to: hasta,
                    date_grouping: caso.date_grouping,
                    limit: caso.limit,
                    sort: caso.sort,
                })
                // Se guarda la fila COMPLETA y en ORDEN: el orden es parte del
                // resultado (una serie temporal descolocada es un bug).
                const filas = rows.map(r => {
                    // `dimension_value`, no `dimension`: es la clave real de
                    // `BiQueryRow`. Sin ella el snapshot no detectaría una serie
                    // temporal descolocada, que es justo uno de los bugs que
                    // este arnés existe para cazar.
                    const out: FilaGuardada = { __dim: limpiar((r as Record<string, unknown>).dimension_value) }
                    for (const m of caso.metrics) out[m] = limpiar((r as Record<string, unknown>)[m])
                    return out
                })
                deCliente.push({ caso: caso.nombre, filas })
                process.stdout.write('.')
            } catch (e) {
                deCliente.push({ caso: caso.nombre, filas: [], error: (e as Error).message })
                process.stdout.write('!')
            }
        }

        // ── Los otros tres caminos del motor ─────────────────────────
        const otros: Record<string, unknown> = {}
        try {
            otros.funnel = (await runFunnelQuery({
                cliente_id: cliente.id, date_from: desde, date_to: hasta,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                metrics: ['impressions', 'clicks', 'leads_count', 'sales_count'] as any,
            })).map(s => ({ ...s, value: limpiar((s as Record<string, unknown>).value) }))
            process.stdout.write('.')
        } catch (e) { otros.funnel = { error: (e as Error).message }; process.stdout.write('!') }

        try {
            otros.comparacion = await runComparison({
                cliente_id: cliente.id,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                metrics: ['leads_count', 'spend', 'cpl'] as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dimension: 'none' as any,
                date_from: desde, date_to: hasta,
            })
            process.stdout.write('.')
        } catch (e) { otros.comparacion = { error: (e as Error).message }; process.stdout.write('!') }

        try {
            otros.distinct_campanas = (await runDistinctValues({
                cliente_id: cliente.id,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                dimension: 'utm_campaign' as any,
                date_from: desde, date_to: hasta,
            })).slice(0, 40)
            process.stdout.write('.')
        } catch (e) { otros.distinct_campanas = { error: (e as Error).message }; process.stdout.write('!') }

        resultados[cliente.id] = deCliente
        extras[cliente.id] = otros
        console.log(' listo')
    }

    const snapshot: Snapshot = {
        generado: new Date().toISOString(),
        rango: { desde: desde!, hasta: hasta! },
        clientes, resultados, extras,
    }

    // ── Capturar ─────────────────────────────────────────────────────
    if (CAPTURAR) {
        mkdirSync(dirname(BASELINE), { recursive: true })
        writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2), 'utf8')
        const nFilas = Object.values(resultados).flat().reduce((a, r) => a + r.filas.length, 0)
        console.log(`\n✓ Línea base guardada en scripts/golden/bi-baseline.json`)
        console.log(`  ${clientes.length} clientes × ${CASOS.length} casos = ${nFilas} filas congeladas`)
        const conError = Object.values(resultados).flat().filter(r => r.error)
        if (conError.length) {
            console.log(`\n  ⚠ ${conError.length} caso(s) dieron error y se guardaron como tal:`)
            for (const r of conError.slice(0, 8)) console.log(`    · ${r.caso}: ${r.error}`)
        }
        console.log('')
        return
    }

    // ── Comparar ─────────────────────────────────────────────────────
    if (!previo) {
        console.log('\n⚠ No hay línea base. Ejecuta primero:')
        console.log('    npx tsx scripts/verify-bi-golden.ts --capturar\n')
        process.exit(1)
    }

    seccion('Comparación contra la línea base')
    console.log(`  base generada: ${previo.generado}`)

    for (const cliente of clientes) {
        const base = previo.resultados[cliente.id]
        const ahora = resultados[cliente.id]
        if (!base) { check(`${cliente.nombre}: presente en la base`, false, 'no estaba'); continue }

        for (const caso of CASOS) {
            const b = base.find(r => r.caso === caso.nombre)
            const a = ahora.find(r => r.caso === caso.nombre)
            const etiqueta = `${cliente.nombre} · ${caso.nombre}`
            if (!b || !a) { check(etiqueta, false, 'caso ausente'); continue }

            if (b.error || a.error) {
                check(etiqueta, b.error === a.error,
                    `error base «${b.error ?? '—'}» vs ahora «${a.error ?? '—'}»`)
                continue
            }
            if (b.filas.length !== a.filas.length) {
                check(etiqueta, false, `${b.filas.length} filas → ${a.filas.length}`)
                continue
            }

            const difs: string[] = []
            for (let i = 0; i < b.filas.length; i++) {
                // El ORDEN cuenta: comparar fila i con fila i, no por clave.
                if (b.filas[i].__dim !== a.filas[i].__dim) {
                    difs.push(`fila ${i}: dim «${b.filas[i].__dim}» → «${a.filas[i].__dim}»`)
                    continue
                }
                for (const m of caso.metrics) {
                    const vb = b.filas[i][m], va = a.filas[i][m]
                    if (vb === null || va === null) {
                        if (vb !== va) difs.push(`${b.filas[i].__dim}.${m}: ${vb} → ${va}`)
                    } else if (Math.abs(Number(vb) - Number(va)) > TOLERANCIA) {
                        difs.push(`${b.filas[i].__dim}.${m}: ${vb} → ${va}`)
                    }
                }
            }
            check(etiqueta, difs.length === 0, difs.slice(0, 4).join(' | '))
        }

        // Embudo, comparación y valores distintos.
        const be = previo.extras[cliente.id] ?? {}
        const ae = extras[cliente.id] ?? {}
        for (const k of ['funnel', 'comparacion', 'distinct_campanas']) {
            check(`${cliente.nombre} · ${k}`,
                JSON.stringify(be[k]) === JSON.stringify(ae[k]),
                'difiere del snapshot')
        }
    }

    console.log(`\n${fallos === 0 ? '✓ El motor produce los MISMOS números que la línea base' : `✗ ${fallos} DIFERENCIA(S) — investigar antes de seguir`}\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => {
    console.error('\n✗ Fallo del arnés:', e?.message ?? e)
    process.exit(1)
})
