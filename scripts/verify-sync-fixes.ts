/**
 * Comprobaciones de la lógica pura introducida por la refactorización del sync.
 *
 * Cubre lo que puede verificarse sin base de datos ni APIs externas: el troceado
 * de rangos de la cola y las fórmulas de KPI. Los guards de preservación y los
 * períodos congelados requieren Postgres y se verifican con las consultas
 * documentadas en docs/14-cron-y-workers.md.
 *
 *   npx tsx scripts/verify-sync-fixes.ts
 */

import { splitRange, DEFAULT_CHUNK_DAYS } from '../src/lib/sync/queue'
import { evaluateFormula } from '../src/lib/formula-engine'
import {
    importesCuadran,
    sumarCampanas,
    compararDias,
    agruparEnRangos,
    construirResumen,
    normalizarFilas,
} from '../src/lib/sync/reconcile'
import { metaRowIsIncomplete, tiktokRowIsIncomplete } from '../src/lib/campaign-filter'

let pasadas = 0
let fallidas = 0

function check(nombre: string, condicion: boolean, detalle?: string) {
    if (condicion) {
        pasadas++
        console.log(`  ✓ ${nombre}`)
    } else {
        fallidas++
        console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
}

function sec(titulo: string) {
    console.log(`\n${titulo}`)
}

// ─── splitRange: el troceado no puede dejar huecos ni solapes ────────────────
// Un hueco significaría días que nunca se sincronizan; un solape, trabajo
// duplicado contra las APIs externas.

sec('splitRange — troceado de rangos de la cola')

{
    const chunks = splitRange('2026-01-01', '2026-01-31', 14)
    check('un mes en 14 días → 3 trozos', chunks.length === 3, `salieron ${chunks.length}`)
    check('empieza en el primer día', chunks[0]?.start === '2026-01-01', chunks[0]?.start)
    check('termina en el último día', chunks[chunks.length - 1]?.end === '2026-01-31', chunks[chunks.length - 1]?.end)

    let contiguo = true
    for (let i = 1; i < chunks.length; i++) {
        const finAnterior = Date.parse(`${chunks[i - 1].end}T00:00:00Z`)
        const inicioActual = Date.parse(`${chunks[i].start}T00:00:00Z`)
        if (inicioActual - finAnterior !== 86_400_000) contiguo = false
    }
    check('trozos contiguos: sin huecos ni solapes', contiguo)

    const dias = chunks.reduce((s, c) => {
        return s + (Date.parse(`${c.end}T00:00:00Z`) - Date.parse(`${c.start}T00:00:00Z`)) / 86_400_000 + 1
    }, 0)
    check('cubre exactamente 31 días', dias === 31, `cubrió ${dias}`)
}

{
    const chunks = splitRange('2026-03-10', '2026-03-10', DEFAULT_CHUNK_DAYS)
    check('un solo día → 1 trozo', chunks.length === 1)
    check('ese trozo es el día pedido', chunks[0]?.start === '2026-03-10' && chunks[0]?.end === '2026-03-10')
}

{
    // 365 días es el rango del preset "Máximo" del dashboard.
    const chunks = splitRange('2025-07-22', '2026-07-22', DEFAULT_CHUNK_DAYS)
    check('un año se trocea (no cabe en una invocación de 60s)', chunks.length >= 26, `${chunks.length} trozos`)
    check('el último trozo llega al final', chunks[chunks.length - 1]?.end === '2026-07-22')
}

{
    check('rango invertido → sin trozos', splitRange('2026-05-10', '2026-05-01').length === 0)
    check('fecha inválida → sin trozos', splitRange('no-es-fecha', '2026-05-01').length === 0)
}

// ─── KPIs: el ROAS total debe incluir la inversión de TikTok ─────────────────
// Antes total_roas era idéntica a meta_roas: un cliente con las dos plataformas
// veía un ROAS inflado porque el numerador incluía ventas traídas por TikTok
// pero el denominador solo contaba lo gastado en Meta.

sec('formula-engine — ROAS total vs ROAS de Meta')

{
    const fila = {
        meta_spend: 100,
        tiktok_spend: 100,
        ventas_principal: 300,
        ventas_bump: 0,
        ventas_upsell: 0,
        ventas_principal_count: 3,
    }

    const metaRoas = evaluateFormula('meta_roas', fila)
    const totalRoas = evaluateFormula('total_roas', fila)
    const totalSpend = evaluateFormula('total_spend', fila)

    check('total_spend suma Meta + TikTok', totalSpend === 200, String(totalSpend))
    check('meta_roas sigue midiendo solo Meta (300/100 = 3)', metaRoas === 3, String(metaRoas))
    check('total_roas usa la inversión total (300/200 = 1.5)', totalRoas === 1.5, String(totalRoas))
    check('total_roas ya NO es igual a meta_roas', metaRoas !== totalRoas)

    const totalRoi = evaluateFormula('total_roi', fila)
    check('total_roi descuenta la inversión total ((300-200)/200 = 0.5)', totalRoi === 0.5, String(totalRoi))

    const bolsa = evaluateFormula('total_dinero_bolsa', fila)
    check('total_dinero_bolsa resta la inversión total (300-200 = 100)', bolsa === 100, String(bolsa))

    const costoCompra = evaluateFormula('total_costo_compra', fila)
    check('total_costo_compra usa la inversión total (200/3)', Math.abs((costoCompra ?? 0) - 200 / 3) < 1e-9, String(costoCompra))
}

{
    // Cliente que solo usa Meta: el comportamiento no debe cambiar.
    const soloMeta = {
        meta_spend: 50,
        tiktok_spend: 0,
        ventas_principal: 200,
        ventas_bump: 0,
        ventas_upsell: 0,
    }
    check(
        'sin TikTok, total_roas y meta_roas coinciden (no hay regresión)',
        evaluateFormula('total_roas', soloMeta) === evaluateFormula('meta_roas', soloMeta)
    )
}

// ─── Reconciliación de gasto Meta ────────────────────────────────────────────
// El dashboard suma `meta_campaigns[]` filtrado por keyword, no la columna
// `meta_spend`. Un array truncado hace que el día se muestre en $0 con gasto
// real, y el worker no lo re-pide porque la fila "tiene datos".

sec('reconcile — tolerancia de importes')

{
    check('importes idénticos cuadran', importesCuadran(1000, 1000))
    check('diferencia del 0,5% cuadra', importesCuadran(1000, 995))
    check('diferencia del 5% NO cuadra', !importesCuadran(1000, 950))
    check('céntimos en importes pequeños cuadran (piso de 1)', importesCuadran(10, 10.5))
    check('ambos en cero cuadran', importesCuadran(0, 0))
    check('gasto real vs cero NO cuadra', !importesCuadran(31000, 0))
}

sec('reconcile — suma de campañas')

{
    const { total, count } = sumarCampanas([{ spend: '100.50' }, { spend: 200 }, { spend: null }])
    check('suma mezclando string, número y null', Math.abs(total - 300.5) < 1e-9, String(total))
    check('cuenta los elementos', count === 3)
    check('array ausente → cero', sumarCampanas(undefined).total === 0)
    check('no-array → cero', sumarCampanas('nope' as unknown).total === 0)
}

sec('reconcile — clasificación de días (caso real: 12-14 jul)')

{
    // Reproduce el patrón observado: días con gasto en la cuenta pero cuyo
    // desglose por campaña llegó vacío → el dashboard los pintaba en $0.
    const cuenta = [
        { fecha: '2026-07-11', spend: 31187 },
        { fecha: '2026-07-12', spend: 30500 },
        { fecha: '2026-07-13', spend: 29800 },
        { fecha: '2026-07-14', spend: 31000 },
        { fecha: '2026-07-15', spend: 34675 },
    ]
    const guardado = [
        { fecha: '2026-07-11', spend: 31187, campaigns: [{ spend: 31187 }] },
        { fecha: '2026-07-12', spend: 30500, campaigns: [] },
        { fecha: '2026-07-13', spend: 29800, campaigns: [] },
        { fecha: '2026-07-14', spend: 31000, campaigns: [] },
        { fecha: '2026-07-15', spend: 34675, campaigns: [{ spend: 34675 }] },
    ]

    const dias = compararDias(cuenta, guardado)
    const porFecha = Object.fromEntries(dias.map(d => [d.fecha, d.status]))

    check('11 jul correcto', porFecha['2026-07-11'] === 'ok', porFecha['2026-07-11'])
    check('12 jul → array_incompleto', porFecha['2026-07-12'] === 'array_incompleto', porFecha['2026-07-12'])
    check('13 jul → array_incompleto', porFecha['2026-07-13'] === 'array_incompleto', porFecha['2026-07-13'])
    check('14 jul → array_incompleto', porFecha['2026-07-14'] === 'array_incompleto', porFecha['2026-07-14'])
    check('15 jul correcto', porFecha['2026-07-15'] === 'ok', porFecha['2026-07-15'])

    const resumen = construirResumen(cuenta, guardado)
    check('detecta exactamente 3 días problemáticos', resumen.problematicos.length === 3, String(resumen.problematicos.length))
    check(
        'cuantifica lo que falta en el dashboard (91.300)',
        Math.abs(resumen.totales.faltanteEnDashboard - 91300) < 1e-6,
        String(resumen.totales.faltanteEnDashboard)
    )
    check('agrupa los 3 días en UN solo rango contiguo', resumen.rangosAReparar.length === 1)
    check(
        'el rango va del 12 al 14',
        resumen.rangosAReparar[0]?.start === '2026-07-12' && resumen.rangosAReparar[0]?.end === '2026-07-14'
    )
}

{
    // Fila ausente en la BD pero con gasto en la cuenta.
    const dias = compararDias([{ fecha: '2026-07-20', spend: 500 }], [])
    check('sin fila y con gasto → fila_faltante', dias[0]?.status === 'fila_faltante', dias[0]?.status)

    // Columna desactualizada respecto a la cuenta (reajuste de Meta posterior).
    const desfase = compararDias(
        [{ fecha: '2026-07-20', spend: 500 }],
        [{ fecha: '2026-07-20', spend: 400, campaigns: [{ spend: 400 }] }]
    )
    check('columna que no alcanza a la cuenta → spend_desactualizado', desfase[0]?.status === 'spend_desactualizado', desfase[0]?.status)

    // Días sin gasto en la cuenta no generan trabajo.
    const cero = compararDias([{ fecha: '2026-07-21', spend: 0 }], [])
    check('día sin gasto y sin fila se ignora', cero.length === 0)
}

sec('reconcile — agrupado en rangos contiguos')

{
    const r = agruparEnRangos(['2026-07-12', '2026-07-13', '2026-07-14', '2026-07-20', '2026-07-21'])
    check('dos bloques separados', r.length === 2, String(r.length))
    check('primer bloque 12→14', r[0].start === '2026-07-12' && r[0].end === '2026-07-14')
    check('segundo bloque 20→21', r[1].start === '2026-07-20' && r[1].end === '2026-07-21')

    check('lista vacía → sin rangos', agruparEnRangos([]).length === 0)
    check('un día suelto → un rango de un día', (() => {
        const x = agruparEnRangos(['2026-07-05'])
        return x.length === 1 && x[0].start === x[0].end
    })())
    check('desordenado y con duplicados se normaliza', (() => {
        const x = agruparEnRangos(['2026-07-03', '2026-07-01', '2026-07-02', '2026-07-01'])
        return x.length === 1 && x[0].start === '2026-07-01' && x[0].end === '2026-07-03'
    })())
}

sec('campaign-filter — marca de día incompleto en la UI')

{
    check(
        'Meta: gasto con array vacío se marca incompleto',
        metaRowIsIncomplete({ meta_spend: 30500, meta_campaigns: [] })
    )
    check(
        'Meta: gasto respaldado por campañas NO se marca',
        !metaRowIsIncomplete({ meta_spend: 31187, meta_campaigns: [{ spend: 31187 }] })
    )
    check(
        'Meta: día sin gasto NO se marca (un cero legítimo no es un fallo)',
        !metaRowIsIncomplete({ meta_spend: 0, meta_campaigns: [] })
    )
    check(
        'Meta: fila antigua sin array NO se marca (no hay con qué comparar)',
        !metaRowIsIncomplete({ meta_spend: 500 })
    )
    check(
        'Meta: desfase de redondeo NO se marca',
        !metaRowIsIncomplete({ meta_spend: 1000, meta_campaigns: [{ spend: 999.5 }] })
    )
}

// ─── TikTok: mismo camino de datos, misma vulnerabilidad ─────────────────────
// `enrichTikTokRow` suma `tiktok_campaigns[]` igual que Meta, y su ventana de
// refresco es de solo 3 días, así que una fila incompleta se congela aún antes.

sec('TikTok — desglose incompleto y normalización de filas')

{
    check(
        'TikTok: gasto con array vacío se marca incompleto',
        tiktokRowIsIncomplete({ tiktok_spend: 12000, tiktok_campaigns: [] })
    )
    check(
        'TikTok: gasto respaldado por campañas NO se marca',
        !tiktokRowIsIncomplete({ tiktok_spend: 12000, tiktok_campaigns: [{ spend: 12000 }] })
    )
    check(
        'TikTok: día sin gasto NO se marca',
        !tiktokRowIsIncomplete({ tiktok_spend: 0, tiktok_campaigns: [] })
    )
    check(
        'una fila con Meta sana y TikTok roto NO se da por buena',
        tiktokRowIsIncomplete({
            meta_spend: 500, meta_campaigns: [{ spend: 500 }],
            tiktok_spend: 800, tiktok_campaigns: [],
        })
    )
}

{
    // normalizarFilas es lo que permite reutilizar toda la comparación para las
    // dos plataformas sin duplicar la lógica.
    const crudas = [
        { fecha: '2026-07-12', meta_spend: 100, meta_campaigns: [{ spend: 100 }], tiktok_spend: 800, tiktok_campaigns: [] },
    ]

    const comoMeta = normalizarFilas(crudas, 'meta')
    check('normaliza la columna de Meta', comoMeta[0].spend === 100, String(comoMeta[0].spend))
    check('normaliza el array de Meta', sumarCampanas(comoMeta[0].campaigns).total === 100)

    const comoTikTok = normalizarFilas(crudas, 'tiktok')
    check('normaliza la columna de TikTok', comoTikTok[0].spend === 800, String(comoTikTok[0].spend))
    check('normaliza el array de TikTok (vacío)', sumarCampanas(comoTikTok[0].campaigns).total === 0)

    // La misma fila: sana desde la óptica de Meta, rota desde la de TikTok.
    const dMeta = compararDias([{ fecha: '2026-07-12', spend: 100 }], comoMeta)
    const dTikTok = compararDias([{ fecha: '2026-07-12', spend: 800 }], comoTikTok)
    check('la fila es "ok" para Meta', dMeta[0].status === 'ok', dMeta[0].status)
    check('la MISMA fila es "array_incompleto" para TikTok', dTikTok[0].status === 'array_incompleto', dTikTok[0].status)
    check('cuantifica los 800 que faltan en TikTok', dTikTok[0].desvio === 800, String(dTikTok[0].desvio))
}

// ─── Gasto acumulado de una pestaña: Meta + TikTok ───────────────────────────
// getTabTotalSpend ignoraba `tiktok_campaigns` por completo, así que la tarjeta
// "Gasto Acumulado" omitía el 100% de lo invertido en TikTok.

sec('getTabTotalSpend — suma ambas plataformas')

{
    // Réplica de la lógica del server action (que necesita Supabase para correr).
    const sumarPestana = (rows: any[], kw: string) => {
        const k = kw?.toLowerCase() ?? ''
        const spendDe = (columna: any, campanas: any) => {
            if (!k || !Array.isArray(campanas)) return parseFloat(columna || '0') || 0
            return campanas
                .filter((c: any) => c.name?.toLowerCase().includes(k))
                .reduce((s: number, c: any) => s + (parseFloat(c.spend || '0') || 0), 0)
        }
        return rows.reduce(
            (t, r) => t + spendDe(r.meta_spend, r.meta_campaigns) + spendDe(r.tiktok_spend, r.tiktok_campaigns),
            0,
        )
    }

    const filas = [{
        meta_spend: 1000,
        meta_campaigns: [{ name: '[WEBINAR] Captación', spend: 700 }, { name: 'Remarketing', spend: 300 }],
        tiktok_spend: 500,
        tiktok_campaigns: [{ name: '[WEBINAR] TikTok', spend: 400 }, { name: 'Otra', spend: 100 }],
    }]

    // Comportamiento anterior: solo Meta. Sirve de referencia para medir el hueco.
    const soloMeta = (rows: any[], kw: string) => {
        const k = kw.toLowerCase()
        return rows.reduce((t, r) => t + (Array.isArray(r.meta_campaigns)
            ? r.meta_campaigns.filter((c: any) => c.name?.toLowerCase().includes(k))
                .reduce((s: number, c: any) => s + (parseFloat(c.spend || '0') || 0), 0)
            : parseFloat(r.meta_spend || '0') || 0), 0)
    }

    check('con keyword suma Meta + TikTok (700 + 400)', sumarPestana(filas, 'webinar') === 1100, String(sumarPestana(filas, 'webinar')))
    check('sin keyword usa las columnas agregadas (1000 + 500)', sumarPestana(filas, '') === 1500, String(sumarPestana(filas, '')))
    check(
        'recupera exactamente los 400 de TikTok que antes se perdían',
        sumarPestana(filas, 'webinar') - soloMeta(filas, 'webinar') === 400,
        `${sumarPestana(filas, 'webinar')} vs ${soloMeta(filas, 'webinar')}`
    )
    check('un cliente solo-Meta no cambia', sumarPestana([{ meta_spend: 900, meta_campaigns: null, tiktok_spend: 0, tiktok_campaigns: null }], '') === 900)
}

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log(`\n${fallidas === 0 ? '✅' : '❌'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas\n`)
process.exit(fallidas === 0 ? 0 : 1)
