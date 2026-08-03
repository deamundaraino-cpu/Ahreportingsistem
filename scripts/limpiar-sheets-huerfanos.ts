/**
 * Retira de las tablas de Sheets las filas que ya no pertenecen a ninguna
 * configuración viva, en dos pasadas:
 *
 *   1. HUÉRFANAS — su `sheet_id` no está en la config del cliente (documento
 *      retirado, o entrada recreada con otro id), o es NULL (anterior a la
 *      trazabilidad por sheet).
 *   2. LOTES VIEJOS — dentro de un sheet vigente, los `sync_batch_id` que no son
 *      el que quedó activo en `conversiones_offline`. Aparecen cuando un sync
 *      muere después de insertar y antes de retirar el lote anterior.
 *
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts                 → informe, no toca nada
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts --apply         → borra
 *   npx tsx scripts/limpiar-sheets-huerfanos.ts --cliente=UUID  → acota a un cliente
 *
 * Un sheet DESHABILITADO no es huérfano: sigue en la config y su historia se
 * conserva. (`cleanupOrphanConversiones` sí lo trataba como huérfano — deshabilitar
 * borraba los datos. Aquí se cuenta como vigente a propósito.)
 *
 * El borrado va por páginas de ids y nunca por `.eq('sheet_id', …)` de golpe: con
 * el índice GIN de `sheet_filas.valores`, borrar decenas de miles de filas en una
 * sola sentencia no cabe en el `statement_timeout` de 8 s del rol de PostgREST.
 * Ese es justamente el motivo de que la basura se acumulara.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { normalizeSheetConfigs } from '../src/lib/integrations/google-sheets-conversiones'

config({ path: '.env.local' })

const APLICAR = process.argv.includes('--apply')
const CLIENTE = process.argv.find(a => a.startsWith('--cliente='))?.split('=')[1]

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local')
    process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const TABLAS = ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas'] as const
const PAGINA = 1000
const LOTE_BORRADO = 500

/** Lee una tabla entera para un cliente, paginando. */
async function leerTodo<T>(tabla: string, columnas: string, clienteId: string): Promise<T[]> {
    const todas: T[] = []
    for (let desde = 0; ; desde += PAGINA) {
        const { data, error } = await db.from(tabla).select(columnas)
            .eq('cliente_id', clienteId)
            .order('sync_batch_id', { ascending: true })
            .range(desde, desde + PAGINA - 1)
        if (error) throw new Error(`${tabla}: ${error.message}`)
        if (!data || data.length === 0) break
        todas.push(...(data as T[]))
        if (data.length < PAGINA) break
    }
    return todas
}

/** Borra por páginas de ids las filas que cumplan el filtro. */
async function borrarPorPaginas(
    tabla: string,
    aplicarFiltro: (q: any) => any
): Promise<number> {
    let total = 0
    for (;;) {
        const { data, error } = await aplicarFiltro(db.from(tabla).select('id')).limit(LOTE_BORRADO)
        if (error) throw new Error(`${tabla} select: ${error.message}`)
        if (!data || data.length === 0) return total

        const ids = (data as { id: string }[]).map(r => r.id)
        const { error: delErr } = await db.from(tabla).delete().in('id', ids)
        if (delErr) throw new Error(`${tabla} delete: ${delErr.message}`)
        total += ids.length
        process.stdout.write(`\r        ${tabla}: ${total} borradas…`)
    }
}

async function main() {
    let q = db.from('clientes').select('id, nombre, config_api')
    if (CLIENTE) q = q.eq('id', CLIENTE)
    const { data: clientes, error } = await q
    if (error) throw new Error(error.message)

    console.log(APLICAR
        ? '── MODO BORRADO ──\n'
        : '── Informe. No se toca nada. Añade --apply para borrar ──\n')

    let huerfanas = 0
    let lotesViejos = 0

    for (const cliente of (clientes ?? []) as { id: string; nombre: string; config_api: any }[]) {
        // Vigentes = TODOS los sheets configurados, habilitados o no.
        const configurados = new Set(
            normalizeSheetConfigs(cliente.config_api?.google_sheets_conversiones).map(s => s.id!)
        )

        const filas = await leerTodo<{ sheet_id: string | null; sync_batch_id: string }>(
            'sheet_filas', 'sheet_id, sync_batch_id', cliente.id
        )
        const conv = await leerTodo<{ sheet_id: string | null; sync_batch_id: string }>(
            'conversiones_offline', 'sheet_id, sync_batch_id', cliente.id
        )
        if (filas.length === 0 && conv.length === 0) continue

        // ── Pasada 1: sheets que ya no están en la config ────────────────────
        const vistos = new Set<string>()
        for (const f of [...filas, ...conv]) vistos.add(f.sheet_id ?? '∅')
        const retirados = [...vistos].filter(s => s === '∅' || !configurados.has(s))

        if (retirados.length > 0) {
            console.log(`\n${cliente.nombre}`)
            console.log(`  configurados: ${[...configurados].join(', ') || '(ninguno)'}`)
            for (const sheetId of retirados) {
                const nulo = sheetId === '∅'
                console.log(`  ▸ huérfano ${nulo ? '(sheet_id NULL, datos legacy)' : sheetId}`)
                for (const tabla of TABLAS) {
                    const filtro = (qq: any) => {
                        const base = qq.eq('cliente_id', cliente.id)
                        return nulo ? base.is('sheet_id', null) : base.eq('sheet_id', sheetId)
                    }
                    const { count } = await filtro(
                        db.from(tabla).select('id', { count: 'exact', head: true })
                    )
                    if (!count) continue
                    huerfanas += count
                    if (!APLICAR) { console.log(`      ${tabla}: ${count} filas`); continue }
                    const n = await borrarPorPaginas(tabla, filtro)
                    console.log(`\r      ${tabla}: ${n} borradas ✓                    `)
                }
                if (APLICAR) {
                    const l = db.from('conversiones_offline_sync_log').delete().eq('cliente_id', cliente.id)
                    await (nulo ? l.is('sheet_id', null) : l.eq('sheet_id', sheetId))
                }
            }
        }

        // ── Pasada 2: lotes anteriores dentro de un sheet vigente ────────────
        const lotesPorSheet = new Map<string, Map<string, number>>()
        for (const f of filas) {
            if (!f.sheet_id || !configurados.has(f.sheet_id)) continue
            if (!lotesPorSheet.has(f.sheet_id)) lotesPorSheet.set(f.sheet_id, new Map())
            const m = lotesPorSheet.get(f.sheet_id)!
            m.set(f.sync_batch_id, (m.get(f.sync_batch_id) ?? 0) + 1)
        }
        const vigentePorSheet = new Map<string, Set<string>>()
        for (const c of conv) {
            if (!c.sheet_id || !configurados.has(c.sheet_id)) continue
            if (!vigentePorSheet.has(c.sheet_id)) vigentePorSheet.set(c.sheet_id, new Set())
            vigentePorSheet.get(c.sheet_id)!.add(c.sync_batch_id)
        }

        for (const [sheetId, lotes] of lotesPorSheet) {
            if (lotes.size <= 1) continue
            const vig = [...(vigentePorSheet.get(sheetId) ?? [])]
            console.log(`\n${cliente.nombre} · sheet ${sheetId} — ${lotes.size} lotes en sheet_filas`)
            for (const [id, n] of [...lotes.entries()].sort((a, b) => b[1] - a[1])) {
                console.log(`     ${vig.includes(id) ? '✓ vigente' : '✗ sobra  '} ${id}: ${n}`)
            }
            if (vig.length !== 1 || !lotes.has(vig[0])) {
                console.log(`     ⚠ no hay un único lote vigente en conversiones_offline: lo dejo, hace falta un sync completo.`)
                continue
            }
            for (const [batchId, n] of lotes) {
                if (batchId === vig[0]) continue
                lotesViejos += n
                if (!APLICAR) { console.log(`     → borraría ${n} filas del lote ${batchId}`); continue }
                const borradas = await borrarPorPaginas('sheet_filas', (qq: any) =>
                    qq.eq('cliente_id', cliente.id).eq('sheet_id', sheetId).eq('sync_batch_id', batchId))
                console.log(`\r     lote ${batchId}: ${borradas} borradas ✓            `)
            }
        }
    }

    console.log(`\n\n${APLICAR ? 'Retiradas' : 'Sobran'}: ${huerfanas} filas huérfanas + ${lotesViejos} de lotes viejos = ${huerfanas + lotesViejos}`)
    if (!APLICAR) console.log('Vuelve a lanzarlo con --apply para borrarlas.')
}

main().catch(e => { console.error('\n', e.message); process.exit(1) })
