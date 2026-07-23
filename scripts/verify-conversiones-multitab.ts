/**
 * Comprobaciones de la lógica pura del sync multi-pestaña de conversiones
 * offline y de los tokens de columnas de Sheet en el BI.
 *
 * Cubre lo verificable sin Google ni Postgres: normalización de configs
 * (incluida la retrocompatibilidad con el formato plano anterior), parseo de
 * filas con su reporte de calidad, agregación diaria y los tokens
 * `offfield:<tipo>:<clave>`. El replace por sheet y el log de sync requieren
 * base de datos y se verifican con el sync manual desde /admin/settings.
 *
 *   npx tsx scripts/verify-conversiones-multitab.ts
 */

import {
    normalizeSheetConfigs,
    normalizeTabs,
    mergeTabCustomColumns,
    parseRowsForTab,
    computeConversionesAggregates,
    sanitizeColName,
} from '../src/lib/integrations/google-sheets-conversiones'
import type {
    ConversionesConfig, SheetTabConfig, CustomColumnDef, SheetRowLike,
} from '../src/lib/integrations/google-sheets-conversiones'
import {
    makeOfflineFieldMetric, parseOfflineFieldMetric, isOfflineFieldMetric,
    offlineFieldAlias, extractOfflineFieldAliases, offlineFieldFormat, offlineFieldLabel,
} from '../src/lib/report-utm/bi-metadata'

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

/** Construye filas falsas al estilo de google-spreadsheet (row.get(columna)). */
function fakeRows(headers: string[], data: (string | number)[][]): SheetRowLike[] {
    return data.map(vals => ({
        get: (col: string) => {
            const i = headers.indexOf(col)
            return i === -1 ? undefined : vals[i]
        },
    }))
}

// ─── Normalización de configs ───────────────────────────────────────────────
// Producción tiene configs en tres formatos: objeto legacy, array con mapeo
// plano y el nuevo array con `tabs`. Los tres deben sincronizar igual.

sec('normalizeSheetConfigs / normalizeTabs — retrocompatibilidad')

{
    const legacyObj = { enabled: true, sheet_url: 'https://docs.google.com/spreadsheets/d/AAA', sheet_name: 'Hoja1', col_fecha: 'Día' }
    const cfgs = normalizeSheetConfigs(legacyObj)
    check('objeto legacy → un sheet', cfgs.length === 1, `salieron ${cfgs.length}`)
    check('objeto legacy recibe id estable', cfgs[0].id === 'legacy', cfgs[0].id)
    check('objeto legacy → una pestaña', cfgs[0].tabs?.length === 1, String(cfgs[0].tabs?.length))
    check('la pestaña hereda el nombre', cfgs[0].tabs?.[0].sheet_name === 'Hoja1', cfgs[0].tabs?.[0].sheet_name)
    check('la pestaña hereda el mapeo', cfgs[0].tabs?.[0].col_fecha === 'Día', cfgs[0].tabs?.[0].col_fecha)
}

{
    // Array del formato anterior, sin `id` ni `tabs`: el id se deriva de la
    // posición porque es la clave de partición del replace por sheet.
    const arr = [
        { enabled: true, sheet_url: 'https://docs.google.com/spreadsheets/d/AAA', col_valor: 'Monto' },
        { enabled: true, sheet_url: 'https://docs.google.com/spreadsheets/d/BBB' },
    ]
    const cfgs = normalizeSheetConfigs(arr)
    check('array legacy conserva ambos sheets', cfgs.length === 2)
    check('ids derivados de la posición', cfgs[0].id === 'sheet_0' && cfgs[1].id === 'sheet_1', `${cfgs[0].id}/${cfgs[1].id}`)
    check('ids únicos entre sheets', cfgs[0].id !== cfgs[1].id)
    check('cada sheet estrena una pestaña', cfgs.every(c => c.tabs?.length === 1))
    check('la pestaña legacy hereda col_valor', cfgs[0].tabs?.[0].col_valor === 'Monto')
}

{
    const nuevo: ConversionesConfig = {
        id: 'uuid-1', name: 'Ventas', enabled: true,
        sheet_url: 'https://docs.google.com/spreadsheets/d/AAA',
        tabs: [
            { id: 't1', sheet_name: 'Enero', enabled: true, col_fecha: 'Fecha' },
            { id: 't2', sheet_name: 'Febrero', enabled: false },
        ],
    }
    const tabs = normalizeTabs(nuevo)
    check('formato nuevo conserva las 2 pestañas', tabs.length === 2, String(tabs.length))
    check('respeta enabled:false', tabs[1].enabled === false)
    check('no inventa mapeo donde no lo hay', tabs[1].col_fecha === undefined)

    const conConfigVacia = normalizeSheetConfigs([nuevo])[0]
    check('normalizeSheetConfigs preserva tabs existentes', conConfigVacia.tabs?.length === 2)
}

{
    const tabs: SheetTabConfig[] = [
        { id: 't1', sheet_name: 'A', enabled: true, custom_columns: { citas: { col_name: 'Citas', type: 'count', label: 'Citas', include: true } } },
        { id: 't2', sheet_name: 'B', enabled: true, custom_columns: { ticket: { col_name: 'Ticket', type: 'currency', label: 'Ticket', include: true } } },
    ]
    const merged = mergeTabCustomColumns(tabs)
    check('mergeTabCustomColumns une columnas de varias pestañas',
        Object.keys(merged).sort().join(',') === 'citas,ticket', Object.keys(merged).join(','))
}

// ─── Parseo de filas y reporte de calidad ───────────────────────────────────
// Antes las filas descartadas desaparecían sin dejar rastro: ahora cada motivo
// se cuenta para poder mostrarlo en la UI.

sec('parseRowsForTab — filas válidas y descartadas')

{
    const headers = ['fecha', 'tipo', 'cantidad', 'valor', 'fuente', 'notas', 'Citas Agendadas']
    const rows = fakeRows(headers, [
        ['2026-07-01', 'Lead',  '2', '100,50', 'whatsapp', 'ok', '3'],
        ['02/07/2026', 'venta', '1', '$1.200', 'llamada',  '',   '1'],
        ['no-es-fecha', 'lead', '5', '10',     'x',        '',   '0'],   // fecha inválida
        ['2026-07-03', 'lead',  '0', '10',     'x',        '',   '0'],   // cantidad <= 0
        ['', '', '', '', '', '', ''],                                     // fila vacía de relleno
    ])
    const tab: SheetTabConfig = { id: 't1', sheet_name: 'Datos', enabled: true }
    const { rows: parsed, quality } = parseRowsForTab(headers, rows, tab, 'sheet-a', 'Datos')

    check('solo entran las filas válidas', parsed.length === 2, `entraron ${parsed.length}`)
    check('cuenta la fecha inválida', quality.fecha_invalida === 1, String(quality.fecha_invalida))
    check('cuenta la cantidad <= 0', quality.cantidad_invalida === 1, String(quality.cantidad_invalida))
    check('la fila vacía no se reporta como error', quality.fecha_invalida === 1)
    check('rows_ok coincide con lo insertado', quality.rows_ok === parsed.length)
    check('normaliza el tipo a minúsculas', parsed[0].tipo === 'lead', parsed[0].tipo)
    check('DD/MM/YYYY → ISO', parsed[1].fecha === '2026-07-02', parsed[1].fecha)
    check('decimal con coma', parsed[0].valor === 100.5, String(parsed[0].valor))
    // "$1.200" es mil doscientos, no 1,2 (punto de miles al estilo es-CO).
    check('punto de miles', parsed[1].valor === 1200, String(parsed[1].valor))
    check('marca el sheet de origen', parsed.every(r => r.sheet_id === 'sheet-a'))
    check('marca la pestaña de origen', parsed.every(r => r.tab_name === 'Datos'))
    check('columna extra detectada por defecto', parsed[0].custom_fields[sanitizeColName('Citas Agendadas')] === 3)
}

{
    // Mapeo propio de la pestaña + aviso cuando una columna mapeada no existe.
    const headers = ['Día', 'Clase', 'Cant', 'Ticket']
    const rows = fakeRows(headers, [['2026-07-01', 'venta', '2', '50']])
    const tab: SheetTabConfig = {
        id: 't2', sheet_name: 'Otra', enabled: true,
        col_fecha: 'Día', col_tipo: 'Clase', col_cantidad: 'Cant', col_valor: 'Ticket',
        custom_columns: { inexistente: { col_name: 'No Existe', type: 'count', label: 'X', include: true } },
    }
    const { rows: parsed, quality } = parseRowsForTab(headers, rows, tab, 'sheet-b', 'Otra')
    check('usa el mapeo propio de la pestaña', parsed.length === 1 && parsed[0].tipo === 'venta')
    check('avisa de columnas estándar ausentes', quality.warnings.some(w => w.includes('fuente')), quality.warnings.join(' | '))
    check('avisa de columna adicional ausente', quality.warnings.some(w => w.includes('No Existe')), quality.warnings.join(' | '))
}

{
    // Sin columna de fecha la pestaña no se puede leer: debe fallar fuerte para
    // que el sheet quede marcado como error y sus datos anteriores se conserven.
    const headers = ['algo', 'otro']
    let lanzó = false
    try {
        parseRowsForTab(headers, fakeRows(headers, [['a', 'b']]), { id: 't', sheet_name: 'X', enabled: true }, 's', 'X')
    } catch {
        lanzó = true
    }
    check('sin columna de fecha lanza error', lanzó)
}

{
    // Ambas convenciones de separadores conviven en los Sheets de los clientes.
    const headers = ['fecha', 'cantidad', 'valor']
    const casos: [string, number][] = [
        ['1.000,50', 1000.5],
        ['1,000.50', 1000.5],
        ['12,5', 12.5],
        ['$ 2.500', 2500],
        ['10.50', 10.5],
        ['1200', 1200],
    ]
    let ok = true
    const detalles: string[] = []
    for (const [texto, esperado] of casos) {
        const rows = fakeRows(headers, [['2026-07-01', '1', texto]])
        const { rows: parsed } = parseRowsForTab(headers, rows, { id: 't', sheet_name: 'V', enabled: true }, 's', 'V')
        if (parsed[0]?.valor !== esperado) { ok = false; detalles.push(`${texto} → ${parsed[0]?.valor} (esperado ${esperado})`) }
    }
    check('toNumber cubre ambas convenciones de separadores', ok, detalles.join('; '))
}

{
    // Export de formulario de Meta: una fila = un lead, sin columnas de cantidad
    // ni de tipo, y con `created_time` en "YYYY-MM-DD HH:MM:SS".
    const headers = ['id', 'created_time', 'campaign_name', 'full_name', 'email']
    const rows = fakeRows(headers, [
        ['1001', '2026-04-15 13:22:05', 'Abril V2', 'Ana', 'ana@x.com'],
        ['1002', '2026-04-15 09:10:00', 'Abril V2', 'Beto', 'beto@x.com'],
        ['1003', '2026-04-16T08:00:00+0000', 'Abril V2', 'Cami', 'cami@x.com'],
    ])

    // Sin la configuración adecuada: todo se descarta (el síntoma reportado).
    const crudo = parseRowsForTab(headers, rows, { id: 't', sheet_name: 'F', enabled: true, col_fecha: 'created_time' }, 's', 'F')
    check('sin cantidad se descartan todas las filas', crudo.rows.length === 0, String(crudo.rows.length))
    check('el descarte se explica en los avisos',
        crudo.quality.warnings.some(w => w.includes('cantidad 0 o vacía')), crudo.quality.warnings.join(' | '))

    // Con "cada fila es una conversión" + tipo fijo.
    const tab: SheetTabConfig = {
        id: 't', sheet_name: 'F', enabled: true,
        col_fecha: 'created_time', count_rows: true, tipo_fijo: 'lead',
    }
    const { rows: parsed, quality } = parseRowsForTab(headers, rows, tab, 's', 'F')
    check('count_rows importa todas las filas', parsed.length === 3, String(parsed.length))
    check('cada fila cuenta como 1', parsed.every(r => r.cantidad === 1))
    check('tipo_fijo marca las filas como lead', parsed.every(r => r.tipo === 'lead'))
    check('fecha con espacio se recorta a YYYY-MM-DD', parsed[0].fecha === '2026-04-15', parsed[0].fecha)
    check('fecha ISO con T también', parsed[2].fecha === '2026-04-16', parsed[2].fecha)
    check('no avisa de cantidad cuando count_rows está activo',
        !quality.warnings.some(w => w.includes('cantidad')), quality.warnings.join(' | '))
    check('no avisa de tipo cuando hay tipo_fijo',
        !quality.warnings.some(w => w.includes('de tipo')), quality.warnings.join(' | '))

    const agg = computeConversionesAggregates(parsed)
    const d15 = agg.find(a => a.fecha === '2026-04-15')!
    check('agrega 2 leads el 15 de abril', d15.total_cantidad === 2, String(d15.total_cantidad))
    check('el tipo lead permite que sume en offline_leads', agg.every(a => a.tipo === 'lead'))
}

// ─── Agregación diaria ──────────────────────────────────────────────────────

sec('computeConversionesAggregates — sumas y porcentajes ponderados')

{
    const headers = ['fecha', 'tipo', 'cantidad', 'valor', 'fuente', 'Tasa Cierre', 'Ticket']
    const rows = fakeRows(headers, [
        ['2026-07-01', 'venta', '2', '100', 'meta', '50', '10'],
        ['2026-07-01', 'venta', '8', '400', 'meta', '100', '20'],
        ['2026-07-02', 'lead',  '3', '',    'meta', '0',  '5'],
    ])
    const custom: Record<string, CustomColumnDef> = {
        tasa_cierre: { col_name: 'Tasa Cierre', type: 'percentage', label: 'Tasa', include: true },
        ticket:      { col_name: 'Ticket',      type: 'currency',   label: 'Ticket', include: true },
    }
    const tab: SheetTabConfig = { id: 't', sheet_name: 'D', enabled: true, custom_columns: custom }
    const { rows: parsed } = parseRowsForTab(headers, rows, tab, 's', 'D')
    const agg = computeConversionesAggregates(parsed, custom)

    const dia1 = agg.find(a => a.fecha === '2026-07-01')!
    const dia2 = agg.find(a => a.fecha === '2026-07-02')!
    check('agrupa por fecha+tipo+fuente', agg.length === 2, String(agg.length))
    check('suma cantidades', dia1.total_cantidad === 10, String(dia1.total_cantidad))
    check('suma valores', dia1.total_valor === 500, String(dia1.total_valor))
    check('suma columnas de moneda', dia1.custom_fields.ticket === 30, String(dia1.custom_fields.ticket))
    // (50*2 + 100*8) / 10 = 90 — no el promedio simple 75.
    check('promedia porcentajes ponderando por cantidad', dia1.custom_fields.tasa_cierre === 90, String(dia1.custom_fields.tasa_cierre))
    check('día sin valor suma 0 en revenue', dia2.total_valor === 0, String(dia2.total_valor))
}

{
    // Filas de dos pestañas del mismo sheet caen en el mismo agregado si
    // comparten fecha/tipo/fuente: el agregado es por sheet, no por pestaña.
    const headers = ['fecha', 'tipo', 'cantidad', 'valor', 'fuente']
    const tabA: SheetTabConfig = { id: 'a', sheet_name: 'A', enabled: true }
    const tabB: SheetTabConfig = { id: 'b', sheet_name: 'B', enabled: true }
    const a = parseRowsForTab(headers, fakeRows(headers, [['2026-07-01', 'lead', '2', '0', 'wa']]), tabA, 's1', 'A').rows
    const b = parseRowsForTab(headers, fakeRows(headers, [['2026-07-01', 'lead', '3', '0', 'wa']]), tabB, 's1', 'B').rows
    const agg = computeConversionesAggregates([...a, ...b])
    check('dos pestañas → un agregado por (fecha,tipo,fuente)', agg.length === 1, String(agg.length))
    check('el agregado suma ambas pestañas', agg[0].total_cantidad === 5, String(agg[0].total_cantidad))
    check('las filas conservan su pestaña de origen',
        a[0].tab_name === 'A' && b[0].tab_name === 'B')
}

// ─── Tokens de columnas de Sheet en el BI ───────────────────────────────────
// El tipo viaja en el token para que los widgets formateen sin releer la config.

sec('bi-metadata — tokens offfield:<tipo>:<clave>')

{
    const tok = makeOfflineFieldMetric('currency', 'ticket_promedio')
    check('token con formato esperado', tok === 'offfield:currency:ticket_promedio', tok)
    check('se reconoce como token offline', isOfflineFieldMetric(tok))
    const p = parseOfflineFieldMetric(tok)
    check('parsea tipo y clave', p?.type === 'currency' && p?.key === 'ticket_promedio', JSON.stringify(p))
    check('formato de moneda', offlineFieldFormat(tok) === 'currency')
    check('formato de porcentaje', offlineFieldFormat(makeOfflineFieldMetric('percentage', 'tasa')) === 'percent')
    check('formato de conteo', offlineFieldFormat(makeOfflineFieldMetric('count', 'citas')) === 'number')
    check('no confunde métricas normales', parseOfflineFieldMetric('offline_leads') === null)
    check('rechaza tipo desconocido', parseOfflineFieldMetric('offfield:raro:x') === null)
    check('etiqueta legible sin catálogo', offlineFieldLabel(tok) === 'Ticket promedio (Sheet)', String(offlineFieldLabel(tok)))
    check('etiqueta usa el label configurado',
        offlineFieldLabel(tok, [{ key: 'ticket_promedio', label: 'Ticket $', type: 'currency', sources: [] }]) === 'Ticket $ (Sheet)')
    check('etiqueta null para no-tokens', offlineFieldLabel('spend') === null)
}

{
    const alias = offlineFieldAlias('citas_agendadas')
    check('alias identificador-safe', alias === 'off__citas_agendadas', alias)
    const found = extractOfflineFieldAliases('meta_spend / off__citas_agendadas + off__ticket')
    check('extrae los alias de la expresión', found.length === 2, String(found.length))
    check('extrae las claves correctas',
        found.map(f => f.key).sort().join(',') === 'citas_agendadas,ticket', found.map(f => f.key).join(','))
    check('no extrae identificadores normales', extractOfflineFieldAliases('spend / leads_count').length === 0)
}

// ─── Resumen ────────────────────────────────────────────────────────────────

console.log(`\n${fallidas === 0 ? '✓' : '✗'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas`)
process.exit(fallidas === 0 ? 0 : 1)
