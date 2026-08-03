/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Comprueba el sync partido por pestañas CONTRA GOOGLE Y LA BASE REAL.
 *
 *   npx tsx scripts/verify-sync-por-pestana.ts --cliente=UUID
 *
 * No va en `npm test`: sincroniza de verdad. Verifica las tres propiedades que
 * hacen que trocear sea seguro:
 *
 *   1. Cada pestaña cabe holgada en el tiempo de una función (se cronometra).
 *   2. Al consolidar queda UN solo lote por sheet en las tres tablas — o sea, el
 *      reemplazo por pestañas no deja duplicados ni se come lo de las hermanas.
 *   3. Los agregados diarios suman lo mismo que las conversiones insertadas, que
 *      es lo que se rompería si dos pestañas del mismo día se pisaran en vez de
 *      sumarse (la clave única de `_diarias` no incluye la pestaña).
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import {
    normalizeSheetConfigs, normalizeTabs,
    syncTabConversiones, consolidarLoteSheet,
    mergeAgregadosParciales, finalizarAgregados,
    type ConversionDiariaParcial,
} from '../src/lib/integrations/google-sheets-conversiones'
import { randomUUID } from 'crypto'

config({ path: '.env.local' })

const CLIENTE = process.argv.find(a => a.startsWith('--cliente='))?.split('=')[1]
if (!CLIENTE) {
    console.error('Uso: npx tsx scripts/verify-sync-por-pestana.ts --cliente=UUID')
    process.exit(1)
}

const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
)

let fallos = 0
function check(ok: boolean, label: string, detalle = '') {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detalle ? ` — ${detalle}` : ''}`)
    if (!ok) fallos++
}

async function lotesDe(tabla: string, clienteId: string, sheetId: string) {
    const lotes = new Map<string, number>()
    for (let desde = 0; ; desde += 1000) {
        const { data, error } = await db.from(tabla).select('sync_batch_id')
            .eq('cliente_id', clienteId).eq('sheet_id', sheetId)
            .order('sync_batch_id', { ascending: true }).range(desde, desde + 999)
        if (error) throw new Error(`${tabla}: ${error.message}`)
        if (!data || data.length === 0) break
        for (const r of data as any[]) lotes.set(r.sync_batch_id, (lotes.get(r.sync_batch_id) ?? 0) + 1)
        if (data.length < 1000) break
    }
    return lotes
}

async function main() {
    const { data: cliente } = await db.from('clientes')
        .select('id, nombre, config_api').eq('id', CLIENTE).single()
    if (!cliente) throw new Error('Cliente no encontrado')

    const sheets = normalizeSheetConfigs((cliente as any).config_api?.google_sheets_conversiones)
        .filter(s => s.enabled && s.sheet_url)
    console.log(`\n${(cliente as any).nombre} — ${sheets.length} sheet(s) habilitados\n`)

    for (const sheetCfg of sheets) {
        const tabs = normalizeTabs(sheetCfg).filter(t => t.enabled !== false)
        console.log(`▸ "${sheetCfg.name}" — ${tabs.length} pestañas`)

        const batchId = randomUUID()
        const agregados: ConversionDiariaParcial[][] = []
        let filas = 0
        let crudas = 0
        let peorTiempo = 0

        for (const tab of tabs) {
            const t0 = Date.now()
            const res = await syncTabConversiones(db, cliente.id, sheetCfg, tab.id!, batchId)
            const segs = (Date.now() - t0) / 1000
            peorTiempo = Math.max(peorTiempo, segs)
            filas += res.rowsProcessed
            crudas += res.rawProcessed
            agregados.push(res.aggregates)
            console.log(`    ${tab.sheet_name}: ${res.rowsProcessed} filas · ${res.rawProcessed} crudas · ${segs.toFixed(1)}s`)
            if (res.rawError) console.log(`      ⚠ ${res.rawError}`)
        }

        const t0 = Date.now()
        const cerrado = await consolidarLoteSheet(
            db, cliente.id, sheetCfg.id!, batchId,
            finalizarAgregados(mergeAgregadosParciales(agregados))
        )
        const segsCierre = (Date.now() - t0) / 1000
        console.log(`    consolidación: ${cerrado.daysProcessed} días · ${segsCierre.toFixed(1)}s`)
        if (cerrado.replaceError) console.log(`      ⚠ ${cerrado.replaceError}`)

        console.log('\n  Comprobaciones:')
        check(peorTiempo < 45, 'la pestaña más lenta cabe en el límite de la función',
            `peor: ${peorTiempo.toFixed(1)}s de 60s`)
        check(segsCierre < 45, 'la consolidación cabe en el límite', `${segsCierre.toFixed(1)}s`)

        for (const tabla of ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas']) {
            const lotes = await lotesDe(tabla, cliente.id, sheetCfg.id!)
            check(lotes.size === 1, `${tabla}: queda un único lote`,
                `${lotes.size} lote(s): ${[...lotes.entries()].map(([id, n]) => `${id.slice(0, 8)}…=${n}`).join(', ')}`)
            check(lotes.has(batchId), `${tabla}: el lote que queda es el nuevo`)
        }

        const { count: nConv } = await db.from('conversiones_offline')
            .select('id', { count: 'exact', head: true })
            .eq('cliente_id', cliente.id).eq('sheet_id', sheetCfg.id!)
        check(nConv === filas, 'las conversiones guardadas son las leídas', `${nConv} vs ${filas}`)

        // Las diarias tienen que sumar lo mismo: si dos pestañas del mismo día se
        // pisaran en el upsert (en vez de sumarse), aquí faltaría el aporte de una.
        let sumaDiarias = 0
        for (let desde = 0; ; desde += 1000) {
            const { data } = await db.from('conversiones_offline_diarias')
                .select('total_cantidad').eq('cliente_id', cliente.id).eq('sheet_id', sheetCfg.id!)
                .range(desde, desde + 999)
            if (!data || data.length === 0) break
            for (const r of data as any[]) sumaDiarias += r.total_cantidad ?? 0
            if (data.length < 1000) break
        }
        let sumaConv = 0
        for (let desde = 0; ; desde += 1000) {
            const { data } = await db.from('conversiones_offline')
                .select('cantidad').eq('cliente_id', cliente.id).eq('sheet_id', sheetCfg.id!)
                .range(desde, desde + 999)
            if (!data || data.length === 0) break
            for (const r of data as any[]) sumaConv += r.cantidad ?? 0
            if (data.length < 1000) break
        }
        check(sumaDiarias === sumaConv, 'los agregados diarios suman lo mismo que las conversiones',
            `diarias=${sumaDiarias} conversiones=${sumaConv}`)
        console.log()
    }

    console.log(fallos === 0 ? '✅ Todas las comprobaciones pasan' : `❌ ${fallos} comprobación(es) fallida(s)`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => { console.error('\n', e.message); process.exit(1) })
