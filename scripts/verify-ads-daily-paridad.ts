/**
 * Paridad entre los dos caminos del gasto, contra datos REALES.
 *
 * La Fase 3 hace que el motor lea `ads_daily` en vez de los JSONB de
 * `metricas_diarias` cuando la tabla cubre el rango. Eso solo es aceptable si
 * los dos caminos dan EXACTAMENTE el mismo número: si difieren, cambiar de
 * tabla movería cifras ya publicadas sin que nadie se entere, que es peor que
 * seguir con el camino lento.
 *
 * Por eso esta comprobación es la puerta de la fase, no un extra. Compara, por
 * cliente y por nivel, el total del rango salido de cada sitio.
 *
 * Un fallo aquí NO significa «el código está mal»: casi siempre significa que
 * a `ads_daily` le faltan días y hay que reponerlos con
 * `npx tsx scripts/backfill-ads-daily.ts`. El script dice cuáles.
 *
 *   npx tsx scripts/verify-ads-daily-paridad.ts
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}
const money = (n: number) => n.toLocaleString('es-CL', { maximumFractionDigits: 2 })

// Rango CERRADO y ya cerrado en el calendario: con un rango que llegue a hoy, el
// worker puede escribir entre una consulta y la otra y la paridad fallaría por
// un motivo falso.
const DESDE = '2026-07-01'
const HASTA = '2026-07-31'

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const db = await createAdminClient()

    const { data: clientesRaw } = await db.from('clientes').select('id,nombre').order('nombre')
    const clientes = (clientesRaw ?? []) as Array<{ id: string; nombre: string }>

    // ════════════════════════════════════════════════════════════
    seccion('La RPC se niega a sumar sin fijar el nivel')
    // ════════════════════════════════════════════════════════════
    // Es la defensa que impide el fallo más caro de esta tabla: sumar los tres
    // niveles triplica el gasto y el número parece plausible.
    {
        const { error } = await db.rpc('ads_daily_resumen', {
            p_cliente_id: clientes[0]?.id, p_nivel: null,
            p_desde: DESDE, p_hasta: HASTA,
        })
        check('p_nivel = NULL da error explícito, no un total triplicado',
            Boolean(error), error ? '' : 'la llamada devolvió datos')
    }
    {
        const { error } = await db.rpc('ads_daily_resumen', {
            p_cliente_id: clientes[0]?.id, p_nivel: 'todos',
            p_desde: DESDE, p_hasta: HASTA,
        })
        check('un nivel inventado da error', Boolean(error))
    }

    // ════════════════════════════════════════════════════════════
    seccion(`Paridad de gasto por cliente (${DESDE} → ${HASTA})`)
    // ════════════════════════════════════════════════════════════

    const sinCobertura: string[] = []

    for (const c of clientes) {
        // ── Camino JSONB: sumar meta_campaigns día a día ──────────────
        const { data: mdRaw } = await db.from('metricas_diarias')
            .select('fecha, meta_campaigns, tiktok_campaigns')
            .eq('cliente_id', c.id).gte('fecha', DESDE).lte('fecha', HASTA)
        const md = (mdRaw ?? []) as Array<{
            fecha: string
            meta_campaigns: Array<Record<string, unknown>> | null
            tiktok_campaigns: Array<Record<string, unknown>> | null
        }>

        let jsonbSpend = 0
        const diasJsonb = new Set<string>()
        for (const r of md) {
            let delDia = 0
            for (const e of r.meta_campaigns ?? []) delDia += Number(e.spend ?? 0)
            for (const e of r.tiktok_campaigns ?? []) delDia += Number(e.spend ?? 0)
            jsonbSpend += delDia
            if (delDia > 0) diasJsonb.add(String(r.fecha).slice(0, 10))
        }

        // ── Camino ads_daily: la RPC ─────────────────────────────────
        const { data: rpcRaw, error } = await db.rpc('ads_daily_resumen', {
            p_cliente_id: c.id, p_nivel: 'campaign',
            p_desde: DESDE, p_hasta: HASTA, p_por_fecha: true,
        })
        if (error) { check(`${c.nombre.trim()} — la RPC responde`, false, error.message); continue }

        const rpc = (rpcRaw ?? []) as Array<{ fecha: string; spend: number }>
        const dailySpend = rpc.reduce((s, r) => s + Number(r.spend ?? 0), 0)
        const diasDaily = new Set(rpc.filter(r => Number(r.spend) > 0).map(r => String(r.fecha).slice(0, 10)))

        if (jsonbSpend === 0 && dailySpend === 0) {
            console.log(`  · ${c.nombre.trim()} — sin gasto en el rango, se omite`)
            continue
        }

        // Tolerancia de un céntimo: los dos caminos redondean en sitios
        // distintos y una diferencia de ese orden no es una discrepancia real.
        const dif = Math.abs(dailySpend - jsonbSpend)
        const ok = dif < 0.01

        if (!ok) {
            const faltan = [...diasJsonb].filter(d => !diasDaily.has(d)).sort()
            sinCobertura.push(c.nombre.trim())
            check(`${c.nombre.trim()} — el gasto coincide`, false,
                `jsonb=${money(jsonbSpend)} ads_daily=${money(dailySpend)} · ` +
                (faltan.length
                    ? `faltan ${faltan.length} día(s) en ads_daily: ${faltan.slice(0, 5).join(', ')}${faltan.length > 5 ? '…' : ''}`
                    : 'mismos días, importes distintos'))
        } else {
            check(`${c.nombre.trim()} — el gasto coincide (${money(dailySpend)})`, true)
        }
    }

    if (sinCobertura.length > 0) {
        console.log(
            `\n  ⚠ ${sinCobertura.length} cliente(s) con huecos en ads_daily.\n` +
            '    El motor NO usará la tabla para esos rangos: `adsDailyCubre` exige el\n' +
            '    rango completo y cae al JSONB, así que los informes siguen bien.\n' +
            '    Para cerrarlos: npx tsx scripts/backfill-ads-daily.ts'
        )
    }

    // ════════════════════════════════════════════════════════════
    seccion('Paridad A TRAVÉS DEL MOTOR, no solo de la base')
    // ════════════════════════════════════════════════════════════
    // Las comprobaciones de arriba comparan dos consultas SQL. Esto compara las
    // dos lecturas del MOTOR —la única prueba que descarta que ambos caminos
    // compartan el mismo error de interpretación al agrupar y filtrar—.
    //
    // Se ejecuta en un proceso aparte con `BI_ADS_SOURCE=jsonb` porque la
    // elección se hace por variable de entorno al arrancar.
    {
        const { execSync } = await import('node:child_process')
        const correr = (forzarJsonb: boolean): Record<string, number> => {
            const out = execSync(
                `npx tsx --conditions=react-server scripts/_bi-gasto-por-campana.ts ${DESDE} ${HASTA}`,
                {
                    encoding: 'utf8',
                    maxBuffer: 32 * 1024 * 1024,
                    env: { ...process.env, ...(forzarJsonb ? { BI_ADS_SOURCE: 'jsonb' } : {}) },
                }
            )
            const linea = out.split('\n').find(l => l.startsWith('{'))
            return linea ? JSON.parse(linea) : {}
        }

        const conDaily = correr(false)
        const conJsonb = correr(true)

        const claves = new Set([...Object.keys(conDaily), ...Object.keys(conJsonb)])
        const distintas: string[] = []
        for (const k of claves) {
            const a = conDaily[k] ?? 0
            const b = conJsonb[k] ?? 0
            if (Math.abs(a - b) >= 0.01) distintas.push(`${k}: daily=${money(a)} jsonb=${money(b)}`)
        }
        check(`el motor da el mismo gasto por campaña por los dos caminos (${claves.size} campaña(s))`,
            distintas.length === 0, distintas.slice(0, 4).join(' | '))
    }

    // ════════════════════════════════════════════════════════════
    seccion('Agregar en la base da lo mismo que agregar por día')
    // ════════════════════════════════════════════════════════════
    // `p_por_fecha=false` es la optimización que convierte 30 días × N entidades
    // en N filas. Tiene que ser una diferencia de forma, no de número.
    for (const c of clientes.slice(0, 3)) {
        const [{ data: porDia }, { data: agregado }] = await Promise.all([
            db.rpc('ads_daily_resumen', { p_cliente_id: c.id, p_nivel: 'campaign', p_desde: DESDE, p_hasta: HASTA, p_por_fecha: true }),
            db.rpc('ads_daily_resumen', { p_cliente_id: c.id, p_nivel: 'campaign', p_desde: DESDE, p_hasta: HASTA, p_por_fecha: false }),
        ])
        const a = ((porDia ?? []) as Array<{ spend: number }>).reduce((s, r) => s + Number(r.spend ?? 0), 0)
        const b = ((agregado ?? []) as Array<{ spend: number }>).reduce((s, r) => s + Number(r.spend ?? 0), 0)
        if (a === 0 && b === 0) continue
        check(`${c.nombre.trim()} — mismo total agregado o por día`, Math.abs(a - b) < 0.01,
            `porDia=${money(a)} agregado=${money(b)}`)
    }
}

main()
    .then(() => {
        console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} comprobación(es) fallida(s)`)
        process.exit(fallos === 0 ? 0 : 1)
    })
    .catch(err => {
        console.error('\n✗ Error inesperado:', err)
        process.exit(1)
    })
