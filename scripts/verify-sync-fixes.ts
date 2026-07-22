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

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log(`\n${fallidas === 0 ? '✅' : '❌'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas\n`)
process.exit(fallidas === 0 ? 0 : 1)
