-- ============================================================
-- 034_utm_campaign_map.sql
-- Mapeo manual UTM → campaña, para el cruce leads/ventas ↔ gasto.
-- ------------------------------------------------------------
-- Cuando el cruce automático (por utm_id=campaign_id/ad_id, o por
-- nombre normalizado) no resuelve, este diccionario permite asignar
-- manualmente un valor UTM a una campaña real de Meta/TikTok.
--
-- match_field: qué campo UTM del lead se compara (utm_id, utm_campaign,
--   utm_content, utm_source…). match_value: el valor exacto a mapear.
-- Resultado: campaign_id + campaign_name + platform de la campaña real.
-- ============================================================

CREATE TABLE IF NOT EXISTS report_utm.utm_campaign_map (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id    UUID        REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
    match_field   TEXT        NOT NULL DEFAULT 'utm_campaign',
    match_value   TEXT        NOT NULL,
    platform      TEXT        NOT NULL DEFAULT 'meta',   -- 'meta' | 'tiktok'
    campaign_id   TEXT,
    campaign_name TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cliente_id, match_field, match_value)
);

CREATE INDEX IF NOT EXISTS utm_campaign_map_cliente_idx
    ON report_utm.utm_campaign_map(cliente_id);
