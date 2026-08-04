// Fuente `sheet` — `public.sheet_campo_valores_diarios`.
//
// Es la ÚNICA de las familias de tokens dinámicos que apunta a una tabla propia
// con grano propio (`campo_id, fecha, valor`); las otras tres (`field:`,
// `leadfield:`, `offfield:`) son columnas JSONB de fuentes que ya existen, y por
// eso se registran dentro de ellas.
//
// Todos sus campos son dinámicos: no hay ninguno fijo. Se cargan por cliente
// desde `sheet_campos` (definición y buckets) y `sheet_campo_vistas` (recortes
// guardados que se comportan como una métrica más).
//
// ── El límite que hay que reportar, no ocultar ───────────────────────────
// `joinAxes` incluye `sheet_value` y `date`, pero NO `campaign` ni
// `lead_column`: el Sheet no guarda a qué lead corresponde cada fila, así que su
// desglose no se puede repartir entre campañas. Consecuencia declarada: al
// agrupar por un campo de Sheet las demás fuentes no cruzan, y filtrar por él
// anula el gasto (no sería atribuible). Antes esto se avisaba con tres banners
// escritos a mano; ahora sale del grano.

import type { DataSource } from '../registry-types'

export const SHEET_SOURCE: DataSource = {
    id: 'sheet',
    label: 'Campos de Sheet',
    location: { kind: 'table', schema: 'public', table: 'sheet_campo_valores_diarios' },
    clientKey: { scope: 'public', via: 'public_cliente_id' },
    grainKind: 'daily',
    grain: ['campo_id', 'fecha', 'valor'],
    joinAxes: ['date', 'sheet_value'],
    dateColumn: 'fecha',
    dateType: 'date',
    dynamicLoader: ['sheet_campo', 'sheet_vista'],
    // Sin campos fijos: el catálogo entero es por cliente.
    fields: [],
}
