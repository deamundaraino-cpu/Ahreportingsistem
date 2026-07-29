/**
 * Comprobaciones de mantenimiento CONTRA LA BASE REAL (y contra Google).
 *
 * A diferencia de los otros `verify-*`, este no es lógica pura: sincroniza de
 * verdad y escribe en la base. No va en `npm test` por eso — se lanza a mano.
 *
 *   npx tsx scripts/verify-sheet-replace.ts
 *
 * ── 1. El full-replace de un sheet NO deja lotes duplicados ──
 *
 * Es la verificación que faltaba y que habría cazado el bug en junio: el borrado
 * del lote anterior se hacía con un `.neq('sync_batch_id', ...)` que tocaba todas
 * las filas del sheet a la vez, no cabía en el `statement_timeout` de 8 s de
 * PostgREST y moría — pero su error se descartaba, así que el sync reportaba
 * éxito mientras `sheet_filas` acumulaba una copia entera del Sheet por corrida.
 * Se llegaron a juntar 6 lotes y 112.180 filas de más.
 *
 * Ejecuta el sync REAL contra Google dos veces seguidas y verifica que después de
 * la segunda sigue habiendo exactamente un lote por (cliente, sheet).
 *
 * ── 2. La purga de `pixel_events` respeta su ventana ──
 *
 * Esa tabla recibe una fila por pageview de todos los clientes y no tenía tope.
 * La purga debe llevarse todo lo anterior al corte y nada de lo posterior.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { syncClienteConversiones, normalizeSheetConfigs } from '../src/lib/integrations/google-sheets-conversiones'
import { purgarPixelEvents, PIXEL_EVENTS_RETENCION_DIAS } from '../src/lib/sync/planner'

config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local')
    process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

let fallos = 0
function check(ok: boolean, label: string, detalle = '') {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detalle ? ` — ${detalle}` : ''}`)
    if (!ok) fallos++
}

/**
 * Recorre una tabla entera por keyset sobre `id`.
 *
 * Keyset y no `range()`: paginar por offset SIN un `order` estable deja que
 * Postgres devuelva las páginas en distinto orden, así que unas filas salen dos
 * veces y otras ninguna. Con eso este mismo script llegó a reportar 6.727
 * "duplicados" que no existían.
 */
async function recorrer(tabla: string, columnas: string): Promise<Array<Record<string, string>>> {
    const todas: Array<Record<string, string>> = []
    let ultimo = ''
    for (;;) {
        let q = db.from(tabla).select(`id, ${columnas}`).order('id').limit(1000)
        if (ultimo) q = q.gt('id', ultimo)
        const { data, error } = await q
        if (error) throw new Error(`${tabla}: ${error.message}`)
        if (!data || data.length === 0) break
        todas.push(...(data as unknown as Array<Record<string, string>>))
        ultimo = String((data[data.length - 1] as unknown as Record<string, string>).id)
        if (data.length < 1000) break
    }
    return todas
}

/** Lotes y filas por (cliente, sheet) en las tablas del replace. */
async function estado() {
    const out: Record<string, { lotes: Set<string>; filas: number }> = {}
    for (const tabla of ['sheet_filas', 'conversiones_offline']) {
        for (const r of await recorrer(tabla, 'cliente_id, sheet_id, sync_batch_id')) {
            const k = `${tabla}|${r.cliente_id}|${r.sheet_id}`
            out[k] ??= { lotes: new Set(), filas: 0 }
            out[k].lotes.add(r.sync_batch_id)
            out[k].filas++
        }
    }
    return out
}

async function main() {
    const { data: clientes, error } = await db.from('clientes').select('id, nombre, config_api')
    if (error) throw new Error(error.message)

    // OJO: `syncClienteConversiones` espera SOLO `config_api.google_sheets_conversiones`,
    // no el `config_api` entero. Pasarle el objeto completo hace que no vea ningún
    // sheet y que `cleanupOrphanConversiones` borre todo por considerarlo huérfano.
    const conSheets = (clientes ?? [])
        .map(c => ({
            id: c.id as string,
            nombre: c.nombre as string,
            sheetsConfig: (c.config_api as Record<string, unknown> | null)?.google_sheets_conversiones,
        }))
        .filter(c => normalizeSheetConfigs(c.sheetsConfig).some(s => s.enabled && s.sheet_url))

    if (conSheets.length === 0) {
        console.log('No hay clientes con Google Sheets configurados. Nada que verificar.')
        return
    }
    console.log(`Clientes con sheets: ${conSheets.map(c => c.nombre).join(', ')}\n`)

    // ── Dos sincronizaciones seguidas ───────────────────────────────
    for (const pasada of [1, 2]) {
        console.log(`── Sincronización ${pasada}/2 ─────────────────────────────`)
        for (const c of conSheets) {
            const { results } = await syncClienteConversiones(db, c.id, c.sheetsConfig)
            for (const r of results) {
                const err = r.success ? '' : ` ERROR: ${r.error}`
                console.log(`  ${c.nombre} · ${r.name}: ${r.rowsProcessed} filas, ${r.rawProcessed} crudas${err}`)
                check(r.success, `sync ok (${c.nombre}/${r.name})`, r.error ?? '')
            }
        }
        console.log()
    }

    // ── La comprobación que importa ─────────────────────────────────
    console.log('── Estado tras las dos pasadas ────────────────────────────')
    const final = await estado()
    for (const [k, v] of Object.entries(final)) {
        const [tabla] = k.split('|')
        check(v.lotes.size === 1, `${tabla}: un solo lote`, `${v.lotes.size} lote(s), ${v.filas} filas`)
    }

    // Segunda red: aunque hubiera un solo lote, una fila repetida para la misma
    // coordenada (cliente, sheet, pestaña, nº de fila) delataría duplicación.
    const vistas = new Set<string>()
    let repetidas = 0
    for (const r of await recorrer('sheet_filas', 'cliente_id, sheet_id, tab_name, fila_num')) {
        const k = `${r.cliente_id}|${r.sheet_id}|${r.tab_name}|${r.fila_num}`
        if (vistas.has(k)) repetidas++
        vistas.add(k)
    }
    check(repetidas === 0, 'sheet_filas: sin coordenadas repetidas', `${repetidas} repetida(s) de ${vistas.size}`)

    // ── Purga de pixel_events ───────────────────────────────────────
    console.log()
    console.log(`── Retención de pixel_events (${PIXEL_EVENTS_RETENCION_DIAS} días) ──────────────`)
    const rutm = db.schema('report_utm')
    const antes = await rutm.from('pixel_events').select('id', { count: 'exact', head: true })
    const corte = new Date(Date.now() - PIXEL_EVENTS_RETENCION_DIAS * 86_400_000).toISOString()
    const viejos = await rutm.from('pixel_events')
        .select('id', { count: 'exact', head: true }).lt('created_at', corte)

    const borrados = await purgarPixelEvents(db)
    const despues = await rutm.from('pixel_events').select('id', { count: 'exact', head: true })

    check(borrados === (viejos.count ?? 0), 'borra exactamente los eventos fuera de retención',
        `${borrados} borrado(s), ${viejos.count} fuera de retención`)
    check((despues.count ?? 0) === (antes.count ?? 0) - borrados, 'no toca los eventos dentro de retención',
        `${antes.count} → ${despues.count}`)

    const quedanViejos = await rutm.from('pixel_events')
        .select('id', { count: 'exact', head: true }).lt('created_at', corte)
    check((quedanViejos.count ?? 0) === 0, 'no quedan eventos fuera de retención', String(quedanViejos.count))

    console.log()
    if (fallos > 0) {
        console.error(`❌ ${fallos} comprobación(es) fallida(s)`)
        process.exit(1)
    }
    console.log('✅ El full-replace no duplica: un lote por (cliente, sheet) tras dos syncs.')
    console.log('✅ La purga de pixel_events respeta la ventana de retención.')
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
