import type { FormFilterSpec, CampaignFilterOperator } from './layout-types'

function formValueMatchesOperator(
    value: string,
    operator: CampaignFilterOperator,
    filterValue: string | string[]
): boolean {
    const v = value.toLowerCase()
    switch (operator) {
        case 'includes':    return typeof filterValue === 'string' && v.includes(filterValue.toLowerCase())
        case 'excludes':    return typeof filterValue === 'string' && !v.includes(filterValue.toLowerCase())
        case 'exact':       return typeof filterValue === 'string' && v === filterValue.toLowerCase()
        case 'not_exact':   return typeof filterValue === 'string' && v !== filterValue.toLowerCase()
        case 'starts_with': return typeof filterValue === 'string' && v.startsWith(filterValue.toLowerCase())
        case 'ends_with':   return typeof filterValue === 'string' && v.endsWith(filterValue.toLowerCase())
        case 'any_of':      return Array.isArray(filterValue) && filterValue.some(fv => fv.toLowerCase() === v)
        case 'none_of':     return Array.isArray(filterValue) && !filterValue.some(fv => fv.toLowerCase() === v)
        default:            return true
    }
}

export function enrichFormRow(
    row: any,
    filter: FormFilterSpec | undefined
): any {
    if (!filter) return row
    const isEmpty = Array.isArray(filter.value) ? filter.value.length === 0 : filter.value === ''
    if (isEmpty) return row

    const forms: any[] = Array.isArray(row.meta_forms) ? row.meta_forms : []
    const op: CampaignFilterOperator = filter.operator ?? 'includes'

    const matching = forms.filter(f => {
        const fieldValue: string = filter.field === 'form_id'
            ? (f.form_id || '')
            : (f.form_name || '')
        return formValueMatchesOperator(fieldValue, op, filter.value)
    })

    const ri = (field: string) => matching.reduce((s: number, f: any) => s + (parseInt(f[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, f: any) => s + (parseFloat(f[field] || '0') || 0), 0)

    return {
        ...row,
        meta_leads_form:  ri('leads'),
        meta_leads:       ri('leads'),
        meta_spend:       rf('spend'),
        meta_impressions: ri('impressions'),
        meta_clicks:      ri('clicks'),
    }
}
