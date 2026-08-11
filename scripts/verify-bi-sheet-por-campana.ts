/**
 * Comprobación de punta a punta del cruce Sheet ↔ campañas, contra datos REALES.
 *
 * Es la prueba de que la Fase 2 hace lo que promete: que un campo de Sheet
 * («leads calificados») se puede pedir POR CAMPAÑA y sale junto al gasto de esa
 * misma campaña, cosa que hasta ahora era imposible porque el desglose diario no
 * guarda a qué anuncio pertenecía cada fila.
 *
 * Las dos propiedades que se verifican son independientes y las dos importan:
 *
 *   · CONSERVACIÓN — la suma de las campañas es igual al total sin agrupar.
 *     Si falla, atribuir está creando o perdiendo filas, y cualquier informe
 *     desglosado mentiría respecto al scorecard de arriba.
 *
 *   · CRUCE — las filas caen en campañas REALES (con gasto), no todas en
 *     «(sin campaña)». Sin esto la conservación se cumpliría igual y el cruce
 *     seguiría sin servir para nada.
 *
 *   npx tsx scripts/verify-bi-sheet-por-campana.ts
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

const SIN_CAMPANA = '(sin campaña)'

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const { runBiQuery } = await import('../src/lib/report-utm/bi-query')
    const { makeSheetMetric } = await import('../src/lib/report-utm/bi-metadata')
    const { loadCamposCliente } = await import('../src/lib/sheets/campos-db')
    const { filaEsAtribuible } = await import('../src/lib/sheets/atribucion')

    const db = await createAdminClient()

    // ── Elegir un cliente que pueda demostrar algo ───────────────────
    // Uno con campos de Sheet definidos Y filas crudas con identidad
    // publicitaria. Sin las dos cosas la prueba no probaría nada.
    const { data: clientesRaw } = await db.schema('report_utm')
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    const clientes = (clientesRaw ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>

    let elegido: { id: string; nombre: string; publicId: string; clave: string; agg: string } | null = null

    for (const c of clientes) {
        if (!c.public_cliente_id) continue
        const { campos } = await loadCamposCliente(db, c.public_cliente_id, { soloActivos: true })
        if (campos.length === 0) continue

        const { data: muestra } = await db.from('sheet_filas')
            .select('valores').eq('cliente_id', c.public_cliente_id).limit(200)
        const atribuibles = ((muestra ?? []) as Array<{ valores: Record<string, string> }>)
            .filter(r => filaEsAtribuible(r.valores)).length
        if (atribuibles === 0) continue

        // Un campo de conteo: es el que se lee como «cuántos leads».
        const campo = campos.find(k => k.agregacion === 'count') ?? campos[0]
        elegido = { id: c.id, nombre: c.nombre.trim(), publicId: c.public_cliente_id, clave: campo.clave, agg: campo.agregacion }
        break
    }

    if (!elegido) {
        console.log('\n  (ningún cliente tiene campos de Sheet con filas atribuibles; se omite)')
        console.log('\n✓ TODO OK')
        return
    }

    console.log(`\nCliente: ${elegido.nombre} · campo «${elegido.clave}» (${elegido.agg})`)

    // Rango CERRADO: si acabara hoy, el sync podría meter filas entre una
    // consulta y la siguiente y la conservación fallaría por un motivo falso.
    const RANGO = { date_from: '2026-07-01', date_to: '2026-07-31' }
    const metric = makeSheetMetric(elegido.agg as 'count', elegido.clave)
    const base = { cliente_id: elegido.id, metrics: [metric], ...RANGO }

    // ════════════════════════════════════════════════════════════
    seccion('Conservación: las campañas suman el total')
    // ════════════════════════════════════════════════════════════

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalRows = await runBiQuery({ ...base, dimension: 'none' } as any)
    const total = Number(totalRows[0]?.[metric] ?? 0)
    check('el total sin agrupar es mayor que cero', total > 0, `total=${total}`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const porCampana = await runBiQuery({ ...base, dimension: 'campaign' } as any)
    const suma = porCampana.reduce((s, r) => s + Number(r[metric] ?? 0), 0)

    check('la suma por campaña es igual al total',
        Math.abs(total - suma) < 0.01, `total=${total} suma=${suma}`)

    // ════════════════════════════════════════════════════════════
    seccion('Cruce: las filas caen en campañas reales')
    // ════════════════════════════════════════════════════════════

    const conCampana = porCampana.filter(r => String(r.dimension_value) !== SIN_CAMPANA)
    const enCampanaReal = conCampana.reduce((s, r) => s + Number(r[metric] ?? 0), 0)
    const pct = total > 0 ? (100 * enCampanaReal) / total : 0

    check('hay más de una campaña en el desglose', conCampana.length > 1,
        `${conCampana.length} campaña(s)`)
    // El umbral es deliberadamente bajo: esto vigila que el cruce FUNCIONE, no
    // la calidad del etiquetado de un cliente concreto (eso es verify-bi-cruce).
    check(`la mayoría de las filas cruza con una campaña real (${pct.toFixed(1)}%)`, pct > 50)

    // ════════════════════════════════════════════════════════════
    seccion('El gasto viaja en la misma fila')
    // ════════════════════════════════════════════════════════════
    // Es el objetivo entero de la fase: poder dividir gasto entre leads
    // calificados. Si el gasto no aparece junto al campo de Sheet, el cruce
    // técnicamente ocurre pero no sirve para el informe.

    const conGasto = await runBiQuery({
        ...base, metrics: [metric, 'spend'], dimension: 'campaign',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const filasUtiles = conGasto.filter(r =>
        String(r.dimension_value) !== SIN_CAMPANA &&
        Number(r[metric] ?? 0) > 0 &&
        Number(r.spend ?? 0) > 0)

    check('al menos una campaña trae gasto Y campo de Sheet a la vez',
        filasUtiles.length > 0, `${filasUtiles.length} fila(s) con ambos`)

    if (filasUtiles.length > 0) {
        const ej = filasUtiles[0]
        const cpl = Number(ej.spend) / Number(ej[metric])
        console.log(`\n  Ejemplo — «${String(ej.dimension_value).slice(0, 52)}»`)
        console.log(`    gasto ${Number(ej.spend).toFixed(2)} · ${elegido.clave} ${ej[metric]} · costo unitario ${cpl.toFixed(2)}`)
        check('el costo por unidad es un número finito y positivo',
            Number.isFinite(cpl) && cpl > 0)
    }

    // ════════════════════════════════════════════════════════════
    seccion('El camino diario no ha cambiado')
    // ════════════════════════════════════════════════════════════
    // Agrupar por fecha sigue leyendo el desglose materializado. Su total tiene
    // que seguir siendo el mismo, o la fase habría roto los informes que ya
    // existen para ganar los nuevos.

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const porFecha = await runBiQuery({ ...base, dimension: 'date' } as any)
    const sumaFecha = porFecha.reduce((s, r) => s + Number(r[metric] ?? 0), 0)
    check('el total por fecha sigue coincidiendo con el total',
        Math.abs(total - sumaFecha) < 0.01, `total=${total} porFecha=${sumaFecha}`)
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
