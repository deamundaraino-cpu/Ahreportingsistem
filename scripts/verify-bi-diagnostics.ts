/**
 * Comprobaciones del diagnóstico de consultas del BI, contra datos REALES.
 *
 * Lo que se prueba es el invariante «cero ≠ desconocido»: cuando el motor
 * devuelve 0 porque no PUDO medir, la respuesta tiene que decir por qué.
 *
 * El caso que más dinero cuesta es `no_public_link`: si
 * `report_utm.clientes.public_cliente_id` es NULL, el gasto, GA4, Hotmart, las
 * conversiones offline y los campos de Sheet devuelven 0 —media plataforma— y
 * hoy NADA en el constructor de informes lo dice. Este script busca un cliente
 * real sin enlace y comprueba que ahora sí se explica.
 *
 *   npx tsx scripts/verify-bi-diagnostics.ts
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

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const { dispatchBiQuery } = await import('../src/lib/report-utm/bi-dispatch')
    const { parseBiQueryParams } = await import('../src/lib/report-utm/bi-query-params')
    const { explainSkipReason, sanitizeForClient } = await import('../src/lib/report-utm/bi/diagnostics')

    const db = await createAdminClient()
    const { data, error } = await db.schema('report_utm')
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    if (error) throw new Error(error.message)

    const todos = (data ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>
    const conEnlace = todos.find(c => c.public_cliente_id)
    const sinEnlace = todos.find(c => !c.public_cliente_id)

    console.log(`\nClientes: ${todos.length} · con enlace: ${todos.filter(c => c.public_cliente_id).length} · sin enlace: ${todos.filter(c => !c.public_cliente_id).length}`)

    /** Lanza una consulta como lo haría un widget y devuelve `{data, meta}`. */
    const consultar = (qs: Record<string, string>) =>
        dispatchBiQuery(parseBiQueryParams(new URLSearchParams(qs)))

    const RANGO = { date_from: '2026-07-01', date_to: '2026-07-31' }

    // ════════════════════════════════════════════════════════════
    seccion('Cliente CON enlace: nada que explicar en el gasto')
    // ════════════════════════════════════════════════════════════
    if (!conEnlace) {
        check('hay un cliente con enlace para probar', false, 'ninguno en la base')
    } else {
        const r = await consultar({
            cliente_id: conEnlace.id, metrics: 'spend,leads_count,cpl',
            dimension: 'none', ...RANGO,
        })
        check(`«${conEnlace.nombre.trim()}» devuelve filas`, Array.isArray(r.data) && r.data.length > 0)
        check('el diagnóstico viaja en la respuesta', r.meta !== undefined)
        check('hasPublicLink = true', r.meta?.hasPublicLink === true)
        check('el gasto NO se marca como no disponible',
            r.meta?.unavailable['spend'] === undefined,
            JSON.stringify(r.meta?.unavailable))
        check('ninguna fuente se descarta',
            (r.meta?.skipped.length ?? 0) === 0,
            JSON.stringify(r.meta?.skipped))
    }

    // ════════════════════════════════════════════════════════════
    seccion('Cliente SIN enlace: el cero silencioso queda explicado')
    // ════════════════════════════════════════════════════════════
    if (!sinEnlace) {
        console.log('  (no hay ningún cliente sin enlace en la base; se omite)')
    } else {
        const r = await consultar({
            cliente_id: sinEnlace.id, metrics: 'spend,leads_count,cpl',
            dimension: 'none', ...RANGO,
        })
        check(`«${sinEnlace.nombre.trim()}» sigue devolviendo filas`, Array.isArray(r.data))
        check('hasPublicLink = false', r.meta?.hasPublicLink === false)
        // ESTO es lo que hoy no existe: el 0 del gasto tiene una causa nombrada.
        check('el gasto se marca como no disponible',
            r.meta?.unavailable['spend']?.kind === 'no_public_link',
            JSON.stringify(r.meta?.unavailable))
        check('CPL hereda el motivo (no muestra un 0 inventado)',
            r.meta?.unavailable['cpl']?.kind === 'no_public_link')
        check('los leads NO se marcan (sí se pueden medir)',
            r.meta?.unavailable['leads_count'] === undefined)
        check('la fuente de anuncios se reporta como descartada',
            r.meta?.skipped.some(s => s.sourceId === 'ads' && s.reason.kind === 'no_public_link') === true)

        const motivo = r.meta?.skipped.find(s => s.sourceId === 'ads')
        check('el motivo tiene texto en español para la UI',
            !!motivo && explainSkipReason(motivo.reason, motivo.sourceLabel).includes('no está enlazado'),
            motivo ? explainSkipReason(motivo.reason, motivo.sourceLabel) : '—')

        // Y comprobamos empíricamente que el gasto era, en efecto, 0.
        const gasto = (r.data?.[0] as Record<string, unknown> | undefined)?.spend
        check('y en efecto el gasto salía 0 (de ahí el problema)', gasto === 0 || gasto === undefined,
            String(gasto))

        seccion('Saneado para el enlace público del cliente')
        const limpio = sanitizeForClient(r.meta)
        check('el motivo interno se neutraliza a «no configurado»',
            limpio?.unavailable['spend']?.kind === 'not_configured')
        check('no se filtra el estado del enlace interno', limpio?.hasPublicLink === true)
    }

    // ════════════════════════════════════════════════════════════
    seccion('Desajuste de grano: agrupar por país no reparte el gasto')
    // ════════════════════════════════════════════════════════════
    if (conEnlace) {
        const r = await consultar({
            cliente_id: conEnlace.id, metrics: 'leads_count,spend,cpl',
            dimension: 'ip_country', ...RANGO,
        })
        check('el gasto se marca con grain_mismatch',
            r.meta?.unavailable['spend']?.kind === 'grain_mismatch',
            JSON.stringify(r.meta?.unavailable))
        check('los leads sí se desglosan por país',
            r.meta?.unavailable['leads_count'] === undefined)
        const m = r.meta?.skipped.find(s => s.sourceId === 'ads')
        check('el texto explica qué hacer en su lugar',
            !!m && explainSkipReason(m.reason, m.sourceLabel).includes('Fecha'),
            m ? explainSkipReason(m.reason, m.sourceLabel) : '—')
    }

    // ════════════════════════════════════════════════════════════
    seccion('Agrupar por campaña SÍ cruza (no se avisa en falso)')
    // ════════════════════════════════════════════════════════════
    if (conEnlace) {
        const r = await consultar({
            cliente_id: conEnlace.id, metrics: 'leads_count,spend,cpl',
            dimension: 'utm_campaign', limit: '10', sort: 'desc', ...RANGO,
        })
        check('no se marca nada como no disponible',
            Object.keys(r.meta?.unavailable ?? {}).length === 0,
            JSON.stringify(r.meta?.unavailable))
    }

    // ════════════════════════════════════════════════════════════
    seccion('Filtro no atribuible: se nombra el campo culpable')
    // ════════════════════════════════════════════════════════════
    if (conEnlace) {
        const r = await consultar({
            cliente_id: conEnlace.id, metrics: 'leads_count,spend,cpl',
            dimension: 'none', 'filters[ip_country]': 'CO', ...RANGO,
        })
        const u = r.meta?.unavailable['spend']
        check('el gasto se marca como no atribuible', u?.kind === 'unattributable_filter',
            JSON.stringify(u))
        check('y se dice QUÉ filtro lo provoca',
            u?.kind === 'unattributable_filter' && u.fields.includes('ip_country'),
            JSON.stringify(u))
    }

    // ════════════════════════════════════════════════════════════
    seccion('Métricas de grano diario y de foto')
    // ════════════════════════════════════════════════════════════
    if (conEnlace) {
        const porCampana = await consultar({
            cliente_id: conEnlace.id, metrics: 'ga_sessions',
            dimension: 'utm_campaign', ...RANGO,
        })
        check('GA4 agrupado por campaña se marca (es día×cliente)',
            porCampana.meta?.unavailable['ga_sessions']?.kind === 'grain_mismatch')

        const porFecha = await consultar({
            cliente_id: conEnlace.id, metrics: 'ga_sessions', dimension: 'date', ...RANGO,
        })
        check('GA4 por fecha NO se marca',
            porFecha.meta?.unavailable['ga_sessions'] === undefined)

        const subsPorFecha = await consultar({
            cliente_id: conEnlace.id, metrics: 'subs_active', dimension: 'date', ...RANGO,
        })
        check('las suscripciones por fecha se marcan (son una foto)',
            subsPorFecha.meta?.unavailable['subs_active']?.kind === 'grain_mismatch')
    }

    // ════════════════════════════════════════════════════════════
    seccion('El diagnóstico nunca tumba una consulta')
    // ════════════════════════════════════════════════════════════
    const sinCliente = await consultar({ metrics: 'leads_count', dimension: 'none', ...RANGO })
    check('sin cliente: responde sin diagnóstico, no revienta',
        sinCliente.error === undefined && sinCliente.meta === undefined)

    const inventada = await consultar({
        cliente_id: conEnlace?.id ?? '', metrics: 'metrica_que_no_existe',
        dimension: 'none', ...RANGO,
    })
    check('métrica inventada: no revienta el diagnóstico', inventada.error === undefined)

    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => {
    console.error('\n✗ Fallo:', e?.message ?? e)
    process.exit(1)
})
