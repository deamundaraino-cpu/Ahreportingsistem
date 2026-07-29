/**
 * Respaldo de `public.leads` a CSV antes de retirarla (migración 061).
 *
 * La tabla quedó muerta tras la migración 059: no la lee ni la escribe nadie en
 * el repo, pero guarda el histórico de leads de Google Sheets anterior al cambio.
 * Este script lo baja a disco para poder soltar los ~45 MB que ocupa.
 *
 *   npx tsx scripts/backup-leads-legacy.ts [destino.csv]
 */

import { createClient } from '@supabase/supabase-js'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'

config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local')
    process.exit(1)
}

const COLUMNAS = [
    'id', 'client_id', 'date', 'source', 'lead_data', 'is_qualified',
    'qualification_field', 'qualification_value', 'lead_external_id', 'created_at',
] as const

/** Escapa un valor para CSV RFC 4180: comillas dobles duplicadas y campo entrecomillado. */
function csvCell(v: unknown): string {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `"${s.replace(/"/g, '""')}"`
}

async function main() {
    const destino = resolve(process.argv[2] ?? 'backups/leads-legacy.csv')
    const db = createClient(url!, key!, { auth: { persistSession: false } })

    const { count, error: countError } = await db
        .from('leads')
        .select('id', { count: 'exact', head: true })
    if (countError) throw new Error(`No se pudo contar: ${countError.message}`)

    console.log(`Respaldando ${count} filas de public.leads → ${destino}`)

    const out = createWriteStream(destino, { encoding: 'utf8' })
    out.write(COLUMNAS.join(',') + '\n')

    // Keyset por `id`: estable aunque la tabla cambie, y no degrada como el offset.
    const PAGINA = 1000
    let ultimo = ''
    let escritas = 0

    for (;;) {
        let q = db.from('leads').select(COLUMNAS.join(',')).order('id').limit(PAGINA)
        if (ultimo) q = q.gt('id', ultimo)

        const { data, error } = await q
        if (error) throw new Error(`Error leyendo: ${error.message}`)
        if (!data || data.length === 0) break

        for (const fila of data as unknown as Record<string, unknown>[]) {
            out.write(COLUMNAS.map(c => csvCell(fila[c])).join(',') + '\n')
        }

        escritas += data.length
        ultimo = String((data[data.length - 1] as unknown as Record<string, unknown>).id)
        process.stdout.write(`\r  ${escritas}/${count}`)
    }

    await new Promise<void>((ok, ko) =>
        out.end((err: NodeJS.ErrnoException | null | undefined) => (err ? ko(err) : ok())))
    console.log(`\nListo: ${escritas} filas.`)

    if (escritas !== count) {
        console.error(`AVISO: se esperaban ${count} filas y se escribieron ${escritas}. No sueltes la tabla.`)
        process.exit(1)
    }
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
