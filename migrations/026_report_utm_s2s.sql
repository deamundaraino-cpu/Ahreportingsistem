-- Fase 5: Pixel Server-to-Server (S2S)
-- Agrega autenticación S2S a integraciones y columna source en pixel_events

ALTER TABLE report_utm.integrations
    ADD COLUMN IF NOT EXISTS s2s_token TEXT;

ALTER TABLE report_utm.pixel_events
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'js';

CREATE INDEX IF NOT EXISTS idx_rutm_pixel_source
    ON report_utm.pixel_events(source);

-- El s2s_token se almacena en una fila de integrations con tipo='s2s'
-- El resto de integraciones tendrán s2s_token=NULL
