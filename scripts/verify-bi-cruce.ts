/**
 * Comprobaciones de la cobertura del cruce UTM ↔ campañas, contra datos REALES.
 *
 * El cruce es automático a propósito (nadie configura claves de unión), pero
 * tiene que rendir cuentas. Aquí se comprueba el número que hasta ahora NO se
 * calculaba en ninguna parte: qué porcentaje del GASTO pertenece a campañas con
 * al menos un lead atribuido.
 *
 * Son dos números distintos y los dos importan:
 *   · leads cruzados — ¿están bien etiquetados los contactos?
 *   · gasto cruzado  — ¿cuánto de lo invertido tiene contactos atribuidos?
 *
 * 100% de leads y 40% de gasto NO es un error de etiquetado: es que el 60% de la
 * inversión no produjo ni un contacto. Al revés sí es un problema de UTM. Con un
 * solo porcentaje no se distinguen.
 *
 *   npx tsx scripts/verify-bi-cruce.ts
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
const money = (n: number) => `$${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const { getCrossDiagnostics } = await import('../src/lib/report-utm/campaign-data')

    const db = await createAdminClient()
    const { data } = await db.schema('report_utm')
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    const todos = (data ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>

    // Rango CERRADO a propósito: si acaba hoy, entran leads durante la prueba y
    // los totales se mueven entre una consulta y la siguiente.
    const RANGO = { date_from: '2026-07-01', date_to: '2026-07-31' }

    // ════════════════════════════════════════════════════════════
    seccion('Cliente sin enlace: no se inventa un 0%')
    // ════════════════════════════════════════════════════════════
    const sinEnlace = todos.find(c => !c.public_cliente_id)
    if (!sinEnlace) {
        console.log('  (no hay cliente sin enlace; se omite)')
    } else {
        const d = await getCrossDiagnostics({ cliente_id: sinEnlace.id, ...RANGO })
        // Decir «0% cruzado» sería mentir: no es que cruzara mal, es que no se
        // puede saber. Misma doctrina que `lib/fx.ts`.
        check(`«${sinEnlace.nombre.trim()}» → spend = null, no 0%`, d.spend === null)
    }

    // ════════════════════════════════════════════════════════════
    seccion('Clientes con enlace: los dos porcentajes')
    // ════════════════════════════════════════════════════════════
    const conEnlace = todos.filter(c => c.public_cliente_id).slice(0, 4)
    let algunoConGasto = false

    for (const c of conEnlace) {
        const d = await getCrossDiagnostics({ cliente_id: c.id, ...RANGO })
        const nombre = c.nombre.trim()

        if (!d.spend) {
            console.log(`  · ${nombre}: sin índice de campañas en el rango`)
            continue
        }

        const leadsTotal = d.coverage.total
        const leadsSin = d.coverage.methods.none ?? 0
        const leadsPct = leadsTotal > 0 ? ((leadsTotal - leadsSin) / leadsTotal) * 100 : null
        const s = d.spend

        console.log(
            `  · ${nombre}: leads ${leadsPct === null ? 'n/a' : leadsPct.toFixed(1) + '%'}` +
            ` (${leadsTotal - leadsSin}/${leadsTotal})` +
            ` · gasto ${s.pct === null ? 'n/a' : s.pct + '%'} (${money(s.matched)}/${money(s.total)})` +
            ` · ${s.orphans.length} campañas sin leads`
        )

        // ── Invariantes que deben cumplirse SIEMPRE ──────────────
        check(`${nombre}: el gasto cruzado no supera el total`,
            s.matched <= s.total + 0.01, `${s.matched} > ${s.total}`)
        check(`${nombre}: el porcentaje está entre 0 y 100`,
            s.pct === null || (s.pct >= 0 && s.pct <= 100), String(s.pct))
        check(`${nombre}: sin gasto → pct null (no 0%)`,
            s.total > 0 ? s.pct !== null : s.pct === null)

        if (s.total > 0) {
            algunoConGasto = true
            // Las huérfanas son campañas con gasto y sin leads: su gasto tiene
            // que caber en la parte NO cruzada.
            const gastoHuerfano = s.orphans.reduce((a, o) => a + o.spend, 0)
            check(`${nombre}: el gasto de las campañas sin leads cabe en lo no cruzado`,
                gastoHuerfano <= s.total - s.matched + 0.01,
                `huérfanas ${money(gastoHuerfano)} > no cruzado ${money(s.total - s.matched)}`)
            check(`${nombre}: ninguna huérfana tiene gasto 0`,
                s.orphans.every(o => o.spend > 0))
            check(`${nombre}: las huérfanas vienen ordenadas por gasto`,
                s.orphans.every((o, i) => i === 0 || s.orphans[i - 1].spend >= o.spend))
        }

        // Coherencia con el desglose que ya existía: los métodos suman el total.
        const sumaMetodos = Object.values(d.coverage.methods).reduce((a, b) => a + b, 0)
        check(`${nombre}: los métodos de cruce suman el total de leads`,
            sumaMetodos === leadsTotal, `${sumaMetodos} ≠ ${leadsTotal}`)
    }

    check('al menos un cliente tenía gasto para medir', algunoConGasto)

    // ════════════════════════════════════════════════════════════
    seccion('Las dos mitades del problema quedan separadas')
    // ════════════════════════════════════════════════════════════
    // Un macro sin renderizar (`{{campaign.name}}`) abarca muchas campañas: NO se
    // puede mapear, hay que arreglarlo en el anuncio. Ofrecer un mapeo ahí sería
    // ofrecer un arreglo que no existe.
    let vistosMapeables = 0
    let vistosInvalidos = 0
    for (const c of conEnlace) {
        const d = await getCrossDiagnostics({ cliente_id: c.id, ...RANGO })
        vistosMapeables += d.suggestions.length
        vistosInvalidos += d.invalid.length
        check(`${c.nombre.trim()}: ningún valor está a la vez en mapeables e inválidos`,
            !d.suggestions.some(s => d.invalid.some(i => i.value === s.value)))
    }
    console.log(`  · en total: ${vistosMapeables} valores mapeables · ${vistosInvalidos} no mapeables`)

    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => {
    console.error('\n✗ Fallo:', e?.message ?? e)
    process.exit(1)
})
