-- ============================================================
-- 036_tab_templates.sql
-- Plantillas de pestañas reutilizables (globales, entre todos los clientes).
-- ------------------------------------------------------------
-- Guardan SOLO la parte de visualización de una pestaña
-- (tarjetas, gráficos, ranking, métricas custom, columnas y su orden),
-- NO el filtro de campaña (keyword_meta / fechas / presupuesto), que se
-- define nuevo en cada campaña. Permite configurar una pestaña una vez y
-- reutilizar su visualización al crear nuevas pestañas.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tab_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre          TEXT NOT NULL,
    descripcion     TEXT,
    -- Bloques de visualización (mismos formatos JSONB que cliente_tabs)
    columnas        JSONB,
    tarjetas        JSONB,
    graficos        JSONB,
    text_blocks     JSONB,
    custom_metrics  JSONB,
    ranking_tables  JSONB,
    blocks_order    JSONB,
    created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tab_templates IS
    'Plantillas globales de visualización para pestañas de cliente (cliente_tabs). Solo layout, sin filtro de campaña.';
