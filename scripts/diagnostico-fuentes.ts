/**
 * Diagnóstico de las fuentes de datos, cliente por cliente.
 *
 * Es la herramienta de las Fases 1 y 5 del plan:
 *
 *   · FASE 5 — qué fuente está parada, rota o desconectada, y desde cuándo.
 *     Los tres fallos que motivaron esto llevaban semanas sin que saltara nada,
 *     porque un informe con una fuente muerta no se ve roto: se ve vacío.
 *
 *   · FASE 1 — de dónde puede salir una venta para cada cliente. No hay una
 *     respuesta única, y es exactamente por eso que el asunto lleva parado: con
 *     pasarela se arregla el webhook; sin ella (un negocio que cierra en una
 *     reunión) la venta vive en el CRM del Sheet y ningún webhook la va a traer
 *     nunca.
 *
 * Solo LEE. No escribe nada ni toca ninguna integración.
 *
 *   npx tsx scripts/diagnostico-fuentes.ts
 *   npx tsx scripts/diagnostico-fuentes.ts --json
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

const JSON_OUT = process.argv.includes('--json')

const ICONO: Record<string, string> = {
    critico: '✗', aviso: '!', ok: '✓', no_aplica: '·',
}

async function main() {
    const { saludDeTodos } = await import('../src/lib/report-utm/salud-fuentes-db')
    const { createAdminClient } = await import('../src/utils/supabase/server')

    const salud = await saludDeTodos()

    if (JSON_OUT) {
        console.log(JSON.stringify(salud, null, 2))
        return
    }

    console.log('\n═══ Salud de las fuentes ═══\n')

    for (const c of salud) {
        console.log(`${ICONO[c.gravedad]} ${c.nombre}`)
        if (c.hallazgos.length === 0) {
            console.log('    todo en orden')
        }
        for (const h of c.hallazgos) {
            console.log(`    ${ICONO[h.gravedad]} [${h.ambito}] ${h.titulo}`)
            if (h.accion) console.log(`        → ${h.accion}`)
        }
        console.log('')
    }

    const criticos = salud.filter(c => c.gravedad === 'critico').length
    const avisos = salud.filter(c => c.gravedad === 'aviso').length
    console.log(`Resumen: ${criticos} cliente(s) con algo crítico · ${avisos} con avisos · ` +
        `${salud.length - criticos - avisos} en orden`)

    // ════════════════════════════════════════════════════════════
    // FASE 1 — de dónde sale una venta para cada cliente
    // ════════════════════════════════════════════════════════════
    console.log('\n═══ Origen de ventas (Fase 1) ═══\n')

    const db = await createAdminClient()
    const { data: clientesRaw } = await db.schema('report_utm')
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    const clientes = (clientesRaw ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>

    const PASARELAS = ['hotmart', 'cartpanda', 'shopify']

    for (const c of clientes) {
        const { count: ventas } = await db.schema('report_utm')
            .from('sales_events').select('id', { count: 'exact', head: true })
            .eq('cliente_id', c.id)

        const { data: integRaw } = await db.schema('report_utm')
            .from('integrations').select('tipo,status').eq('cliente_id', c.id)
        const integ = (integRaw ?? []) as Array<{ tipo: string; status: string }>
        const pasarelas = integ.filter(i => PASARELAS.includes(i.tipo)).map(i => i.tipo)

        // Hotmart puede estar dado de alta por DOS caminos: una fila en
        // `integrations` (el webhook del reporting) o las credenciales en
        // `config_api` (el sync del dashboard clásico). Mirar solo el primero
        // dejaba fuera a los clientes que sí tienen la pasarela conectada.
        if (c.public_cliente_id) {
            const { data: cfgRow } = await db.from('clientes')
                .select('config_api').eq('id', c.public_cliente_id).maybeSingle()
            const cfg = (cfgRow?.config_api ?? {}) as Record<string, unknown>
            if (cfg.hotmart_client_id && !pasarelas.includes('hotmart')) pasarelas.push('hotmart')
        }

        // ¿Su Sheet parece un CRM? Un CRM trae etapas de gestión (contacto,
        // asistencia, cierre) en vez de la exportación de un formulario.
        let pareceCrm = false
        if (c.public_cliente_id) {
            const { data: muestra } = await db.from('sheet_filas')
                .select('valores').eq('cliente_id', c.public_cliente_id).limit(50)
            const claves = new Set<string>()
            for (const f of (muestra ?? []) as Array<{ valores: Record<string, string> }>) {
                for (const k of Object.keys(f.valores ?? {})) claves.add(k)
            }
            pareceCrm = [...claves].some(k =>
                /cierre|asistencia|contacto|agenda|venta|monto|tipificacion/i.test(k))
        }

        const n = Number(ventas ?? 0)
        let ruta: string
        if (n > 0) {
            ruta = `${n} venta(s) registradas — nada que hacer`
        } else if (pasarelas.length > 0) {
            ruta = `webhook de ${pasarelas.join("/")} dado de alta pero sin entregar ` +
                '— revisar alta en la plataforma, secreto y URL'
        } else if (pareceCrm) {
            ruta = 'la venta se cierra fuera de una pasarela y vive en el CRM del Sheet ' +
                '— la ruta es la Fase 2, no un webhook'
        } else {
            ruta = 'sin pasarela ni CRM identificable — decidir de dónde debería salir la venta'
        }

        console.log(`  ${n > 0 ? '✓' : '·'} ${c.nombre.trim()}`)
        console.log(`      ${ruta}`)
    }
    console.log('')
}

main().catch(err => {
    console.error('\n✗ Error inesperado:', err)
    process.exit(1)
})
