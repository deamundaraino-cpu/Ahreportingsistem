// Fuente `offline` — `public.conversiones_offline_diarias`.
//
// Son las conversiones que el equipo carga por Google Sheet. Grano día×cliente,
// así que solo cruzan por fecha: no hay forma de repartir un lead cargado a mano
// entre campañas.
//
// Las columnas extra del Sheet (`custom_fields`) se añaden aquí en tiempo de
// ejecución. Son el legado `offfield:<tipo>:<clave>`, que la migración 058 ya
// previó absorber en el modelo de campos de Sheet mediante la columna
// `sheet_campos.legacy_offfield` — de ahí que no sean fuente aparte.

import type { DataSource } from '../registry-types'
import { measure, money } from '../field-builders'

const S = 'offline'

export const OFFLINE_SOURCE: DataSource = {
    id: S,
    label: 'Conversiones offline (Sheet)',
    location: { kind: 'table', schema: 'public', table: 'conversiones_offline_diarias' },
    clientKey: { scope: 'public', via: 'public_cliente_id' },
    grainKind: 'daily',
    grain: ['cliente_id', 'fecha', 'tipo'],
    joinAxes: ['date'],
    dateColumn: 'fecha',
    dateType: 'date',
    dynamicLoader: ['offline_custom'],
    fields: [
        measure(S, 'leads', 'Leads offline (Sheet)',
            'Leads que el equipo carga a mano en el Google Sheet del cliente. Se solapan con “Leads (contactos)” si el mismo contacto está en los dos sitios.',
            'offline',
            { column: 'total_cantidad', conflictsWith: ['leads.count', 'ads.leads_form'] }),
        measure(S, 'ventas', 'Ventas offline (Sheet)',
            'Ventas que el equipo carga a mano en el Google Sheet del cliente.', 'offline',
            { column: 'total_cantidad', conflictsWith: ['sales.count'] }),
        money(S, 'revenue', 'Revenue offline (Sheet)',
            'Dinero de las ventas cargadas a mano en el Google Sheet del cliente.', 'offline',
            { column: 'total_valor', conflictsWith: ['sales.revenue'] }),
        measure(S, 'total', 'Conversiones offline (Sheet)',
            'Todas las filas de conversión del Google Sheet, sin distinguir leads de ventas.', 'offline',
            { column: 'total_cantidad' }),
    ],
}
