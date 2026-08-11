/**
 * Comprobaciones del agregado diario de Hotmart.
 *
 * `agregarDesdeHotmartVentas` es la pieza que sustituye a las ~270 líneas
 * inline de `worker/route.ts`. Se prueba contra un doble de la base en memoria
 * —no contra Supabase— para poder cubrir los casos que en producción no ocurren
 * a diario: un reembolso, un importe sin tasa de cambio, un producto sin
 * clasificar.
 *
 *   npx tsx scripts/verify-hotmart-agregado.ts
 */

import { agregarDesdeHotmartVentas, registroVacio, desgloseVacio } from '../src/lib/hotmart/sync'
import type { FunnelHotmart } from '../src/lib/hotmart/clasificador'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

/** Doble mínimo del cliente de Supabase: solo lo que usa la función. */
function dbCon(filas: Array<Record<string, unknown>>) {
    return {
        from() {
            const q = {
                select: () => q,
                eq: () => q,
                then: (res: (v: { data: unknown[]; error: null }) => unknown) =>
                    res({ data: filas, error: null }),
            }
            return q
        },
    }
}

function venta(p: Record<string, unknown> = {}) {
    return {
        tipo: 'principal',
        tab_id: null,
        estado: 'aprobada',
        clasificacion_origen: 'oferta',
        producto_nombre: 'Curso',
        moneda: 'BRL',
        bruto: 100,
        bruto_usd: 20,
        neto_productor_usd: 15,
        neto_afiliado_usd: null,
        neto_coproductor_usd: null,
        ...p,
    }
}

const TAB = '11111111-1111-1111-1111-111111111111'
function funnel(p: Partial<FunnelHotmart> = {}): FunnelHotmart {
    return {
        tab_id: TAB,
        principal_patterns: [], bump_patterns: [], upsell_patterns: [], downsell_patterns: [],
        principal_offers: [], bump_offers: [], upsell_offers: [], downsell_offers: [],
        landing_page_urls: [],
        ...p,
    }
}

const agregar = (filas: Array<Record<string, unknown>>, funnels: FunnelHotmart[] = []) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agregarDesdeHotmartVentas(dbCon(filas) as any, 'cli', '2026-08-01', funnels)

// tsx compila a CJS, que no admite `await` de primer nivel: todo el cuerpo va
// dentro de una función asíncrona.
async function main() {
    // ════════════════════════════════════════════════════════════
    seccion('Registro vacío')
    // ════════════════════════════════════════════════════════════
    const vacio = registroVacio()
    // `apiSuccess: true` por defecto es correcto: un cliente sin Hotmart configurado
    // SÍ debe escribir ceros. Quien lo pone en false es el llamador cuando la
    // paginación quedó a medias.
    check('apiSuccess arranca en true', vacio.apiSuccess === true)
    check('todo a cero', vacio.principal === 0 && vacio.downsell === 0 && vacio.reembolsado === 0)
    check('sin ventas, la cobertura es 100 (no divide por cero)', vacio.cobertura_pct === 100)
    const d = desgloseVacio()
    check('el desglose incluye downsell', d.downsell.count === 0 && d.downsell.net === 0)

    // ════════════════════════════════════════════════════════════
    seccion('Los cuatro tipos suman donde toca')
    // ════════════════════════════════════════════════════════════
    const cuatro = await agregar([
        venta({ tipo: 'principal', neto_productor_usd: 10, bruto_usd: 20 }),
        venta({ tipo: 'bump', neto_productor_usd: 3, bruto_usd: 5 }),
        venta({ tipo: 'upsell', neto_productor_usd: 7, bruto_usd: 12 }),
        venta({ tipo: 'downsell', neto_productor_usd: 4, bruto_usd: 6 }),
    ])
    check('principal', cuatro.principal === 10 && cuatro.principal_count === 1 && cuatro.principal_bruto === 20)
    check('bump', cuatro.bump === 3 && cuatro.bump_count === 1 && cuatro.bump_bruto === 5)
    check('upsell', cuatro.upsell === 7 && cuatro.upsell_count === 1 && cuatro.upsell_bruto === 12)
    // El tipo que no existía en ninguna parte del repositorio.
    check('downsell', cuatro.downsell === 4 && cuatro.downsell_count === 1 && cuatro.downsell_bruto === 6)
    check('el conteo total incluye los cuatro', cuatro.ventas_count === 4)

    // ════════════════════════════════════════════════════════════
    seccion('Estados: qué cuenta como dinero y qué no')
    // ════════════════════════════════════════════════════════════
    const estados = await agregar([
        venta({ estado: 'aprobada', neto_productor_usd: 10 }),
        venta({ estado: 'completa', neto_productor_usd: 10 }),
        venta({ estado: 'pendiente', neto_productor_usd: 99 }),
        venta({ estado: 'expirada', neto_productor_usd: 99 }),
        venta({ estado: 'cancelada', neto_productor_usd: 99 }),
    ])
    check('aprobada y completa cuentan', estados.ventas_count === 2 && estados.principal === 20)
    // Un billete impreso que nadie pagó no es facturación.
    check('pendiente/expirada/cancelada NO cuentan', estados.principal === 20)

    // ════════════════════════════════════════════════════════════
    seccion('Reembolsos: el hueco que la API vieja nunca vio')
    // ════════════════════════════════════════════════════════════
    // La vía de pull filtraba a APPROVED+COMPLETE, así que una venta devuelta seguía
    // contando como facturación PARA SIEMPRE. Ni el cierre de mes la veía.
    const conReembolso = await agregar([
        venta({ estado: 'aprobada', neto_productor_usd: 10 }),
        venta({ estado: 'reembolsada', neto_productor_usd: 10 }),
        venta({ estado: 'chargeback', neto_productor_usd: 5 }),
    ])
    check('una venta devuelta no suma a la facturación', conReembolso.principal === 10)
    check('no cuenta como venta cobrada', conReembolso.ventas_count === 1)
    check('se acumula aparte', conReembolso.reembolsado === 15)
    check('se cuenta aparte', conReembolso.reembolsado_count === 2)
    // Se guardan por separado en vez de restarse en silencio para que el dashboard
    // pueda mostrar «facturado» y «devuelto» y el cambio sea visible.
    check('el chargeback cuenta como devolución', conReembolso.reembolsado_count === 2)

    // ════════════════════════════════════════════════════════════
    seccion('Importes sin tasa de cambio: null, nunca cero')
    // ════════════════════════════════════════════════════════════
    // Es el invariante que hereda de `src/lib/fx.ts`: un cero se suma en silencio y
    // hunde el ROAS; un null se puede contar y reportar.
    const sinTasa = await agregar([
        venta({ bruto: 500, bruto_usd: null, neto_productor_usd: null, moneda: 'COP' }),
        venta({ bruto: 100, bruto_usd: 20, neto_productor_usd: 15 }),
    ])
    check('se cuenta el importe no convertido', sinTasa.unconverted_count === 1)
    check('la moneda se reporta para la alerta', sinTasa.monedas.includes('COP'))
    check('lo convertible sí suma', sinTasa.principal === 15)
    // Un bruto de 0 no es una pérdida de información: convertir 0 da 0 en cualquier
    // moneda, así que no debe inflar el contador.
    const ceroSinTasa = await agregar([venta({ bruto: 0, bruto_usd: null, neto_productor_usd: 0 })])
    check('un importe de 0 sin tasa no cuenta como fallo', ceroSinTasa.unconverted_count === 0)

    // ════════════════════════════════════════════════════════════
    seccion('Productos sin clasificar → extras')
    // ════════════════════════════════════════════════════════════
    const extras = await agregar([
        venta({ tipo: 'sin_clasificar', producto_nombre: 'Ebook suelto', neto_productor_usd: 2, bruto_usd: 4, clasificacion_origen: 'sin_clasificar' }),
        venta({ tipo: 'sin_clasificar', producto_nombre: 'Ebook suelto', neto_productor_usd: 2, bruto_usd: 4, clasificacion_origen: 'sin_clasificar' }),
        venta({ tipo: 'sin_clasificar', producto_nombre: null, neto_productor_usd: 1, bruto_usd: 1, clasificacion_origen: 'sin_clasificar' }),
    ])
    check('los extras se agrupan por nombre', extras.extras.length === 2)
    const ebook = extras.extras.find(e => e.product_name === 'Ebook suelto')
    check('se acumulan sus importes', ebook?.count === 2 && ebook?.net === 4 && ebook?.gross === 8)
    check('un producto sin nombre no se pierde', extras.extras.some(e => e.product_name === '(Sin nombre)'))
    // Siguen contando como ventas del día aunque no entren en el desglose del embudo.
    check('los extras cuentan en el total', extras.ventas_count === 3)
    check('pero no suman a principal/bump/upsell', extras.principal === 0 && extras.bump === 0)

    // ════════════════════════════════════════════════════════════
    seccion('Cobertura de clasificación')
    // ════════════════════════════════════════════════════════════
    // Es la métrica que decide si el dashboard puede fiarse del desglose por tipo.
    const cob = await agregar([
        venta({ clasificacion_origen: 'oferta' }),
        venta({ clasificacion_origen: 'nombre' }),
        venta({ clasificacion_origen: 'sin_clasificar', tipo: 'sin_clasificar' }),
        venta({ clasificacion_origen: 'order_bump', tipo: 'bump' }),
    ])
    check('calcula el porcentaje clasificado', cob.cobertura_pct === 75, String(cob.cobertura_pct))

    // ════════════════════════════════════════════════════════════
    seccion('Desglose por pestaña')
    // ════════════════════════════════════════════════════════════
    const porTab = await agregar(
        [
            venta({ tipo: 'principal', tab_id: TAB, neto_productor_usd: 10, bruto_usd: 20 }),
            venta({ tipo: 'bump', tab_id: TAB, neto_productor_usd: 3, bruto_usd: 5 }),
            // Sin pestaña: suma al total pero no al desglose.
            venta({ tipo: 'principal', tab_id: null, neto_productor_usd: 7, bruto_usd: 14 }),
        ],
        [funnel()],
    )
    check('el desglose existe para la pestaña', Boolean(porTab.by_tab[TAB]))
    check('suma solo lo suyo', porTab.by_tab[TAB].principal.count === 1 && porTab.by_tab[TAB].bump.count === 1)
    check('el total incluye lo que no tiene pestaña', porTab.principal === 17 && porTab.principal_count === 2)

    // El precio configurado sustituye al bruto de la API. Comportamiento heredado
    // del worker (`principal_price_usd ?? grossVal`) que hay que conservar: cambiarlo
    // movería la facturación bruta de los clientes que lo usan.
    const conPrecio = await agregar(
        [venta({ tipo: 'principal', tab_id: TAB, neto_productor_usd: 10, bruto_usd: 20 })],
        [funnel({ principal_price_usd: 97 })],
    )
    check('el precio configurado manda sobre el bruto de la API',
        conPrecio.principal_bruto === 97, String(conPrecio.principal_bruto))
    check('y también en el desglose de la pestaña', conPrecio.by_tab[TAB].principal.gross === 97)
    check('el neto NO se toca', conPrecio.principal === 10)

    // ════════════════════════════════════════════════════════════
    seccion('Afiliados y coproductores')
    // ════════════════════════════════════════════════════════════
    // Antes solo existían como tres números agregados dentro de un JSONB, sin
    // desglose por transacción ni exposición en el BI.
    const comisiones = await agregar([
        venta({ neto_afiliado_usd: 5, neto_coproductor_usd: 2 }),
        venta({ neto_afiliado_usd: 3, neto_coproductor_usd: null }),
        venta({ neto_afiliado_usd: null, neto_coproductor_usd: 1 }),
    ])
    check('suma la comisión de afiliado', comisiones.affiliate_net === 8)
    check('cuenta las transacciones con afiliado', comisiones.affiliate_count === 2)
    check('suma la comisión de coproductor', comisiones.coproducer_net === 3)

    // ════════════════════════════════════════════════════════════
    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

