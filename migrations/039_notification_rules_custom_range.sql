-- Migración para añadir soporte de rango personalizado de fechas a notification_rules
-- Ejecutar en Supabase SQL Editor

ALTER TABLE public.notification_rules
  ADD COLUMN IF NOT EXISTS custom_start DATE,
  ADD COLUMN IF NOT EXISTS custom_end DATE;

COMMENT ON COLUMN public.notification_rules.custom_start IS 'Fecha de inicio para time_window=custom_range (yyyy-MM-dd)';
COMMENT ON COLUMN public.notification_rules.custom_end IS 'Fecha de fin para time_window=custom_range (yyyy-MM-dd)';
