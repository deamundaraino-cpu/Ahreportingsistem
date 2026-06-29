import type { SheetFilterSpec } from './layout-types'

export function offlineRowMatchesFilter(
    row: any,
    filter: SheetFilterSpec
): boolean {
    if (!filter || !filter.field) return true

    let colVal: any = ''
    if (filter.field === 'tipo') {
        colVal = row.tipo
    } else if (filter.field === 'fuente') {
        colVal = row.fuente
    } else if (filter.field === 'notas') {
        colVal = row.notas
    } else {
        // Buscar en custom fields
        const customFieldKey = filter.field.startsWith('sheet_')
            ? filter.field.replace('sheet_', '')
            : filter.field
        colVal = row.custom_fields?.[customFieldKey] ?? ''
    }

    const valStr = String(colVal).toLowerCase().trim()
    const filterVal = filter.value
    const operator = filter.operator

    if (operator === 'equals') {
        return typeof filterVal === 'string' && valStr === filterVal.toLowerCase().trim()
    }
    if (operator === 'not_equals') {
        return typeof filterVal === 'string' && valStr !== filterVal.toLowerCase().trim()
    }
    if (operator === 'includes') {
        return typeof filterVal === 'string' && valStr.includes(filterVal.toLowerCase().trim())
    }
    if (operator === 'excludes') {
        return typeof filterVal === 'string' && !valStr.includes(filterVal.toLowerCase().trim())
    }
    if (operator === 'any_of') {
        return Array.isArray(filterVal) && filterVal.some(v => valStr === String(v).toLowerCase().trim())
    }
    if (operator === 'none_of') {
        return Array.isArray(filterVal) && !filterVal.some(v => valStr === String(v).toLowerCase().trim())
    }

    // Numeric operators
    const n = Number(colVal)
    const fnVal = Number(filterVal)
    if (!isNaN(n) && !isNaN(fnVal)) {
        if (operator === 'greater_than') return n > fnVal
        if (operator === 'less_than') return n < fnVal
        if (operator === 'greater_equal') return n >= fnVal
        if (operator === 'less_equal') return n <= fnVal
    }

    return true
}

export function enrichOfflineRow(
    row: any,
    filter: SheetFilterSpec | undefined
): any {
    if (!filter) return row
    const offlineRows = Array.isArray(row.offline_rows) ? row.offline_rows : []
    const matching = offlineRows.filter((r: any) => offlineRowMatchesFilter(r, filter))

    let offline_leads = 0
    let offline_ventas = 0
    let offline_revenue = 0
    let offline_total = 0

    const nextCustomFields: Record<string, number> = {}

    for (const r of matching) {
        const qty = r.cantidad || 0
        const val = Number(r.valor) || 0
        if (r.tipo === 'lead') offline_leads += qty
        if (r.tipo === 'venta') offline_ventas += qty
        offline_revenue += val
        offline_total += qty

        // Agregar campos numéricos personalizados
        for (const [k, v] of Object.entries((r.custom_fields as Record<string, any>) || {})) {
            if (typeof v === 'number') {
                const key = `sheet_${k}`
                nextCustomFields[key] = (nextCustomFields[key] ?? 0) + Number(v)
            }
        }
    }

    const base = {
        ...row,
        offline_leads,
        offline_ventas,
        offline_revenue,
        offline_total,
        ...nextCustomFields
    }

    // Resetear campos sheet_ que no tengan coincidencias en la selección filtrada
    Object.keys(row).forEach(k => {
        if (k.startsWith('sheet_') && nextCustomFields[k] === undefined) {
            base[k] = 0
        }
    })

    return base
}
