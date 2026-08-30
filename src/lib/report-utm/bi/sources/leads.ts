// Fuente `leads` — `report_utm.lead_events`, una fila por contacto.
//
// Es la única fuente de grano `row` junto con `sales`, y de ahí salen dos cosas
// que ninguna otra puede hacer: contar filas y servir de eje a una tabla
// dinámica (`isPivotable`). Antes eso estaba cableado como
// `PIVOT_METRICS = ['leads_count','sales_count','revenue']`.
//
// Los campos de formulario (`raw_fields`) y los campos de lead unificados
// (`report_utm.lead_campos`) se AÑADEN a esta fuente en tiempo de ejecución:
// no son fuentes aparte porque no tienen grano propio, viven en una columna
// JSONB de estas mismas filas. Es lo que permite que el editor tenga un solo
// camino de código en vez de "métricas del catálogo" vs "campos dinámicos".

import type { DataSource } from '../registry-types';
import { measure, derived, dimension } from '../field-builders';

const S = 'leads';

export const LEADS_SOURCE: DataSource = {
  id: S,
  label: 'Leads (contactos)',
  location: { kind: 'table', schema: 'report_utm', table: 'lead_events' },
  clientKey: { scope: 'report_utm' },
  grainKind: 'row',
  grain: ['id'],
  joinAxes: ['date', 'platform', 'campaign', 'adset', 'ad', 'lead_column', 'lead_raw'],
  dateColumn: 'created_at',
  // timestamptz: hay que convertir a día local antes de agrupar. Lo hace el
  // motor con `colombiaDateOf` (bi-query.ts), y el recorte del rango con
  // `colombiaRangeBounds` — tope superior EXCLUSIVO. Así el día coincide con
  // `metricas_diarias.fecha`, que ya es día Colombia, y con las RPC del
  // dashboard, que usan `AT TIME ZONE 'America/Bogota'`.
  //
  // NO se usa `String(created_at).slice(0,10)`: eso sería el día UTC y movería
  // al día vecino los leads de las últimas 5 horas. Este comentario decía lo
  // contrario y mandó a perseguir un desfase de zona horaria que no existía; el
  // descuadre real era de paginación (ver migración 078).
  dateType: 'timestamptz',
  // `lead_segmento` es la ÚNICA medida dinámica de esta fuente: las otras dos
  // familias son dimensiones. Ver migración 073.
  dynamicLoader: ['raw_field', 'lead_campo', 'lead_segmento'],
  fields: [
    // ── Medidas ──────────────────────────────────────────────────────
    measure(
      S,
      'count',
      'Leads (contactos)',
      'Personas que dejaron sus datos durante el período, sumando formularios web y formularios de Meta. Es el conteo real de contactos: no se suma con “Leads del píxel de Meta” ni con “Leads offline”, que miden lo mismo desde otra fuente y se solapan.',
      'leads',
      {
        agg: 'count',
        column: 'id',
        recommended: true,
        funnelStage: 70,
        goal: 'leads_target',
        conflictsWith: ['ads.leads_form', 'offline.leads'],
      }
    ),

    // CPL cruza DOS fuentes. Antes esa relación estaba codificada por
    // repetición: `cpl` aparecía a la vez en la lista `needsLeads` y en la
    // lista `needsAds` del motor. Aquí se declara una vez y el plan la deduce.
    derived(
      S,
      'cpl',
      'CPL',
      'Costo por Lead: cuánto cuesta, en promedio, conseguir un contacto. Cuanto MÁS BAJO, mejor.',
      'leads',
      'ads.spend / leads.count',
      {
        format: 'currency',
        nullUnless: ['leads.count'],
        recommended: true,
        direction: 'down',
        goal: 'cpl_max',
      }
    ),

    derived(
      S,
      'conversion_rate',
      'Conv. Rate',
      'Porcentaje de leads que terminaron comprando.',
      'leads',
      'sales.count / leads.count',
      { format: 'percent', nullUnless: ['leads.count'] }
    ),

    // ── Dimensiones ──────────────────────────────────────────────────
    // Las de entidad se resuelven contra las campañas reales (cascada de 7
    // pasos). `utm_campaign` YA cruza con el gasto desde la unificación.
    dimension(S, 'campaign', 'Campaña', 'campaign', 'leads', {
      column: 'utm_campaign',
      resolve: 'entity',
    }),
    dimension(S, 'content', 'Contenido (anuncio)', 'ad', 'leads', {
      column: 'utm_content',
      resolve: 'entity',
    }),
    dimension(S, 'term', 'Término (conjunto)', 'adset', 'leads', {
      column: 'utm_term',
      resolve: 'entity',
    }),
    // Agrupa por la columna TAL CUAL, sin resolver. Solo para auditar los
    // UTM que llegan. La traducción nombre→columna vivía repetida en 5
    // sitios del motor; ahora está solo aquí.
    dimension(S, 'utm_campaign_raw', 'Campaña UTM (crudo)', 'lead_column', 'leads', {
      column: 'utm_campaign',
      resolve: 'entity_raw',
    }),
    dimension(S, 'utm_source', 'Source', 'lead_column', 'leads'),
    dimension(S, 'utm_medium', 'Medium', 'lead_column', 'leads'),
    dimension(S, 'utm_id', 'UTM ID', 'lead_column', 'leads', { highCardinality: true }),
    dimension(S, 'date', 'Fecha', 'date', 'leads', { column: 'created_at', resolve: 'date_trunc' }),
    dimension(S, 'ip_country', 'País', 'lead_column', 'leads'),
    dimension(S, 'form_name', 'Formulario', 'lead_column', 'leads'),
    dimension(S, 'form_plugin', 'Plugin', 'lead_column', 'leads'),
    dimension(S, 'attribution_method', 'Atribución', 'lead_column', 'leads'),
  ],
};
