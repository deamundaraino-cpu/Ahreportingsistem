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
// ── Dos tablas, un solo catálogo de campos ───────────────────────────────
// `location` apunta al desglose diario porque es de donde se sirve el caso
// normal (agrupar por fecha, por un campo de Sheet o por el total): está
// preagregado y es barato.
//
// Pero ese resumen es `campo_id × fecha × valor`: no guarda a qué anuncio
// pertenecía cada fila, así que por sí solo no se puede repartir entre campañas.
// La capa cruda (`public.sheet_filas`) SÍ conserva la exportación entera de Meta
// Lead Ads —`campaign_id`, `adset_id`, `ad_id` y sus nombres—, y el motor lee de
// ahí en cuanto se pide un eje de publicidad (`bi-query.querySheetLeadsDirect`).
//
// Por eso `joinAxes` incluye campaign/adset/ad: el eje ES alcanzable, solo que
// por la otra tabla. Declararlo aquí es lo que hace que el editor deje de marcar
// estos campos como incompatibles con el gasto, que era un límite real hasta
// ahora y ha dejado de serlo.
//
// Lo que sigue SIN cruzar, y por eso no está en la lista: `lead_column` y
// `sales_column`. Esas columnas no existen en el Sheet.

import type { DataSource } from '../registry-types';

export const SHEET_SOURCE: DataSource = {
  id: 'sheet',
  label: 'Campos de Sheet',
  location: { kind: 'table', schema: 'public', table: 'sheet_campo_valores_diarios' },
  clientKey: { scope: 'public', via: 'public_cliente_id' },
  grainKind: 'daily',
  grain: ['campo_id', 'fecha', 'valor'],
  // `campaign`/`adset`/`ad` se resuelven leyendo `sheet_filas`, no el desglose.
  joinAxes: ['date', 'sheet_value', 'campaign', 'adset', 'ad'],
  dateColumn: 'fecha',
  dateType: 'date',
  dynamicLoader: ['sheet_campo', 'sheet_vista'],
  // Sin campos fijos: el catálogo entero es por cliente.
  fields: [],
};
