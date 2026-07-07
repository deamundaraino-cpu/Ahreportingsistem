-- migrations/043_bi_reports_schedule.sql
-- Programación de envío automático de informes BI (Fase 4).
-- `schedule` guarda la config de envío periódico; `schedule_last_sent_at`
-- registra el último envío para no duplicar.
--
-- Shape de `schedule` (JSONB):
--   {
--     "enabled": true,
--     "frequency": "weekly" | "monthly",   -- semanal (lunes) o mensual (día 1)
--     "channels": { "whatsapp": true, "email": true },
--     "emails": ["cliente@dominio.com", ...]
--   }

ALTER TABLE public.bi_reports
    ADD COLUMN IF NOT EXISTS schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS schedule_last_sent_at TIMESTAMPTZ;

-- Índice parcial: el cron solo recorre informes con envío habilitado.
CREATE INDEX IF NOT EXISTS idx_bi_reports_schedule_enabled
    ON public.bi_reports ((schedule->>'enabled'))
    WHERE (schedule->>'enabled') = 'true';

COMMENT ON COLUMN public.bi_reports.schedule IS 'Config de envío automático: enabled, frequency (weekly|monthly), channels {whatsapp,email}, emails[].';
COMMENT ON COLUMN public.bi_reports.schedule_last_sent_at IS 'Último envío automático del informe (para evitar duplicados por corrida del cron).';
