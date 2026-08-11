/**
 * Invariantes de `public.hotmart_ventas` CONTRA LA BASE REAL.
 *
 * Complementa a `verify-hotmart-agregado.ts` (puro, con dobles): aquí se
 * comprueba lo que solo se puede afirmar mirando los datos de producción — que
 * la fecha materializada no se desincronizó, que no hay huérfanos y que nadie
 * lee la tabla sin acotar por cliente.
 *
 *   npx tsx scripts/verify-hotmart-ventas.ts
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { colombiaDateOf } from '../src/lib/colombia-date'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ════════════════════════════════════════════════════════════
// Guardarraíl estático — se comprueba SIEMPRE, haya datos o no.
//
// Mismo patrón que `verify-ads-daily.ts` con `.eq('nivel'`: una lectura de
// `hotmart_ventas` sin filtrar por cliente mezcla las ventas de todos los
// clientes y el número resultante parece perfectamente plausible.
//
// Se recorre el sistema de ficheros y no `git grep`: éste solo ve lo trackeado,
// así que con archivos nuevos sin añadir la comprobación pasaría por no
// encontrar nada.
// ════════════════════════════════════════════════════════════
seccion('Toda lectura de hotmart_ventas acota por cliente')

const archivos: string[] = []
function recorrer(dir: string) {
    let entradas: string[]
    try { entradas = readdirSync(dir) } catch { return }
    for (const e of entradas) {
        if (e === 'node_modules' || e === '.next' || e === '.git' || e === 'dist') continue
        const p = join(dir, e)
        let st: ReturnType<typeof statSync>
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { recorrer(p); continue }
        // Los propios scripts de verificación quedan fuera: auditan la tabla
        // ENTERA a propósito, que es justo lo que la regla prohíbe al resto.
        if (/^verify-.*\.ts$/.test(e)) continue
        if (/\.(ts|tsx)$/.test(e)) archivos.push(p)
    }
}
for (const raiz of ['src', 'sync-worker/src', 'scripts']) recorrer(raiz)
check('el recorrido encuentra archivos', archivos.length > 100, String(archivos.length))

const sinCliente: string[] = []
for (const f of archivos) {
    const texto = readFileSync(f, 'utf8')
    const re = /from\(['"]hotmart_ventas['"]\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(texto))) {
        // La sentencia encadenada ocupa varias líneas: se mira una ventana.
        const trozo = texto.slice(m.index, m.index + 600)
        if (/\.eq\(\s*['"]cliente_id['"]/.test(trozo)) continue
        // Una escritura o una actualización por id ya está acotada.
        if (/\.eq\(\s*['"]id['"]/.test(trozo)) continue
        if (/\.(upsert|insert)\(/.test(trozo)) continue
        sinCliente.push(`${f}:${texto.slice(0, m.index).split(/\r?\n/).length}`)
    }
}
check('ninguna lectura mezcla clientes', sinCliente.length === 0, sinCliente.join(', '))

// ════════════════════════════════════════════════════════════
async function main() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
        console.log('\n  (sin credenciales de Supabase: solo se corrieron las comprobaciones estáticas)\n')
        process.exit(fallos === 0 ? 0 : 1)
    }
    const db = createClient(url, key)

    seccion('Esquema aplicado')
    const { error: errTabla } = await db.from('hotmart_ventas').select('id').limit(1)
    check('la tabla existe y es legible', !errTabla, errTabla?.message)
    if (errTabla) {
        console.log(`\n✗ ${fallos} FALLO(S) — ¿falta aplicar la migración 065?\n`)
        process.exit(1)
    }

    // Las tres funciones que sostienen la integridad y el presupuesto de espacio.
    for (const fn of ['guardar_hotmart_venta', 'purgar_hotmart_raw', 'purgar_hotmart_pii', 'purgar_sales_events_raw', 'fusionar_config_api']) {
        const { error } = await db.rpc(fn, fn === 'guardar_hotmart_venta'
            ? { p_fila: {} }
            : fn === 'fusionar_config_api'
                ? { p_cliente_id: '00000000-0000-0000-0000-000000000000', p_parche: {} }
                : { p_dias: 100000 })
        // Un error de DATOS (fila vacía) demuestra que la función existe; solo
        // "could not find the function" significa que falta.
        const falta = error?.message?.includes('Could not find the function')
        check(`la función ${fn} existe`, !falta, error?.message)
    }

    seccion('Integridad de los datos')
    const { data: filas, error } = await db
        .from('hotmart_ventas')
        .select('id, cliente_id, transaction_id, fecha_venta, aprobada_at, estado, bruto, bruto_usd, tipo, clasificacion_origen, parent_transaction_id, reembolsada_at')
        .limit(5000)
    if (error) { check('lectura', false, error.message); process.exit(1) }

    const todas = filas ?? []
    console.log(`  (${todas.length} fila(s) en la muestra)`)
    if (todas.length === 0) {
        // Nada que comprobar todavía. No es un fallo: la tabla es nueva y hasta
        // que no corra el backfill o entre un webhook está legítimamente vacía.
        console.log('  · tabla vacía: se omiten las comprobaciones sobre datos.')
        console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
        process.exit(fallos === 0 ? 0 : 1)
    }

    // Duplicados: el UNIQUE debería impedirlos, pero comprobarlo detecta que
    // alguien lo haya soltado.
    const claves = new Set<string>()
    const dup: string[] = []
    for (const f of todas) {
        const k = `${f.cliente_id}|${f.transaction_id}`
        if (claves.has(k)) dup.push(k)
        claves.add(k)
    }
    check('no hay transacciones duplicadas por cliente', dup.length === 0, dup.slice(0, 3).join(', '))

    // LA comprobación de zona horaria. Si esto se rompe, las ventas empiezan a
    // caer en el día equivocado y el ROAS se compara contra el gasto de otro día.
    const desfase = todas.filter(f =>
        f.aprobada_at && colombiaDateOf(f.aprobada_at as string) !== f.fecha_venta)
    check('fecha_venta es el día Colombia de aprobada_at',
        desfase.length === 0,
        desfase.slice(0, 3).map(f => `${f.transaction_id}: ${f.fecha_venta} ≠ ${colombiaDateOf(f.aprobada_at as string)}`).join(' | '))

    // Un importe convertido a 0 por falta de tasa es el fallo silencioso que
    // `src/lib/fx.ts` existe para evitar.
    const ceroSospechoso = todas.filter(f =>
        Number(f.bruto) > 0 && Number(f.bruto_usd) === 0)
    check('ningún importe se convirtió a 0 teniendo bruto > 0',
        ceroSospechoso.length === 0,
        ceroSospechoso.slice(0, 3).map(f => String(f.transaction_id)).join(', '))

    // Coherencia estado ↔ marca de reembolso, en las dos direcciones.
    const devueltas = todas.filter(f => f.estado === 'reembolsada' || f.estado === 'chargeback')
    check('toda venta devuelta tiene reembolsada_at',
        devueltas.every(f => f.reembolsada_at !== null),
        String(devueltas.filter(f => !f.reembolsada_at).length))
    const vivasConMarca = todas.filter(f =>
        (f.estado === 'aprobada' || f.estado === 'completa') && f.reembolsada_at !== null)
    check('ninguna venta cobrada arrastra marca de reembolso',
        vivasConMarca.length === 0,
        vivasConMarca.slice(0, 3).map(f => String(f.transaction_id)).join(', '))

    // Coherencia tipo ↔ origen de la clasificación.
    const incoherentes = todas.filter(f =>
        (f.tipo === 'sin_clasificar') !== (f.clasificacion_origen === 'sin_clasificar'))
    check('tipo y clasificacion_origen coinciden', incoherentes.length === 0,
        incoherentes.slice(0, 3).map(f => `${f.transaction_id}: ${f.tipo}/${f.clasificacion_origen}`).join(' | '))

    seccion('Cobertura de la clasificación')
    // No es un assert: es la cifra que decide si el desglose por tipo del
    // dashboard es fiable. Se IMPRIME siempre, porque callarla haría creer que
    // todo está mapeado.
    const clasificadas = todas.filter(f => f.clasificacion_origen !== 'sin_clasificar').length
    const porOferta = todas.filter(f => f.clasificacion_origen === 'oferta').length
    const pct = Math.round((clasificadas / todas.length) * 1000) / 10
    console.log(`  clasificadas: ${clasificadas}/${todas.length} (${pct}%)`)
    console.log(`  por código de oferta: ${porOferta} (el mecanismo estable)`)
    console.log(`  por nombre de producto: ${clasificadas - porOferta} (se rompe si renombran el producto)`)
    if (pct < 95) {
        console.log(`  ⚠ Por debajo del 95%: revisa el mapa de ofertas antes de fiarte del desglose por tipo.`)
    }

    // Los upsells y bumps que apuntan a una compra fuera de la muestra no son un
    // error: solo significa que su padre está fuera del rango leído.
    const conPadre = todas.filter(f => f.parent_transaction_id)
    if (conPadre.length > 0) {
        const ids = new Set(todas.map(f => f.transaction_id))
        const huerfanos = conPadre.filter(f => !ids.has(f.parent_transaction_id as string))
        console.log(`  con compra padre: ${conPadre.length}, de los cuales ${huerfanos.length} apuntan fuera de la muestra`)
    }

    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
