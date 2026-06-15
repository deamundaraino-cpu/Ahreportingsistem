-- Fase 6: Índice compuesto para búsquedas de integración por cliente + tipo
CREATE INDEX IF NOT EXISTS idx_rutm_integrations_cliente_tipo
    ON report_utm.integrations(cliente_id, tipo);
