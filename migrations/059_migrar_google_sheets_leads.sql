-- ════════════════════════════════════════════════════════════════
-- Migration 059: retirar "Google Sheets — Leads" (integración legacy)
-- ════════════════════════════════════════════════════════════════
-- Convierte cada `config_api.google_sheets` en una entrada del módulo
-- unificado (`config_api.google_sheets_conversiones`), para que su hoja
-- se sincronice por el mismo camino que todo lo demás.
--
-- Equivalencias:
--   sheet_url          → sheet_url del sheet nuevo
--   sheet_names[]      → una pestaña por nombre
--   (una fila = un lead) → count_rows: true, tipo_fijo: 'lead'
--   quality_field /
--   qualified_values   → un campo de Sheet + una vista "Leads calificados",
--                        que crea `scripts/migracion-leads-legacy.ts campos`
--                        (necesita sanitizar nombres, no es trabajo de SQL).
--
-- La columna de fecha se deja vacía a propósito: el parser ya resuelve
-- `fecha` / `date` / `created_time` y acierta con los exports de Meta.
--
-- ADITIVA Y REPETIBLE: no borra nada y no vuelve a migrar un cliente que
-- ya tenga su sheet marcado con `migrado_de`. `config_api.google_sheets`
-- se conserva tal cual como respaldo — retirarlo es una decisión aparte,
-- cuando el cuadre de 30 días esté en verde.
--
-- Las tablas `leads` y `leads_diarios` TAMPOCO se tocan: el dashboard las
-- sigue leyendo para el histórico ya validado (ver getSheetCamposDelDia).
-- ════════════════════════════════════════════════════════════════

UPDATE public.clientes c
SET config_api = jsonb_set(
    c.config_api,
    '{google_sheets_conversiones}',
    COALESCE(c.config_api->'google_sheets_conversiones', '[]'::jsonb) ||
    jsonb_build_array(jsonb_build_object(
        'id',          gen_random_uuid()::text,
        'name',        'Leads (migrado)',
        'enabled',     COALESCE((c.config_api->'google_sheets'->>'enabled')::boolean, false),
        'sheet_url',   c.config_api->'google_sheets'->>'sheet_url',
        -- Marca de origen: hace la migración repetible y deja rastro de
        -- por qué existe este sheet.
        'migrado_de',  'google_sheets',
        'tabs', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id',         gen_random_uuid()::text,
                'sheet_name', s,
                'enabled',    true,
                'count_rows', true,      -- una fila = un lead
                'tipo_fijo',  'lead'     -- para que sume en offline_leads
            ))
            FROM jsonb_array_elements_text(c.config_api->'google_sheets'->'sheet_names') AS s
            WHERE COALESCE(s, '') <> ''
        ), jsonb_build_array(jsonb_build_object(
            -- Sin nombres declarados: la primera pestaña del documento.
            'id',         gen_random_uuid()::text,
            'sheet_name', '',
            'enabled',    true,
            'count_rows', true,
            'tipo_fijo',  'lead'
        )))
    ))
)
WHERE c.config_api ? 'google_sheets'
  AND COALESCE(c.config_api->'google_sheets'->>'sheet_url', '') <> ''
  AND NOT (COALESCE(c.config_api->'google_sheets_conversiones', '[]'::jsonb)
           @> '[{"migrado_de":"google_sheets"}]');

-- ────────────────────────────────────────────────────────────────
-- Marca las tablas legacy como de solo lectura. Se conservan: el
-- dashboard las usa para el histórico anterior a la migración, y son la
-- referencia contra la que se cuadra el pipeline nuevo.
-- ────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.leads IS
    'LEGACY (migración 059): el sync se retiró y ya no escribe aquí. Se conserva como histórico y como referencia de cuadre. No escribir.';
COMMENT ON TABLE public.leads_diarios IS
    'LEGACY (migración 059): sustituida por sheet_campo_valores_diarios. El dashboard la lee para las fechas anteriores a la migración. No escribir.';
