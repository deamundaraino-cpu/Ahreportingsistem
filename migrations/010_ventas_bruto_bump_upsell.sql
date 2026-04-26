-- Migration 010: Add gross (bruto) columns for bump and upsell ventas
ALTER TABLE public.metricas_diarias
    ADD COLUMN IF NOT EXISTS ventas_bump_bruto   numeric DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_upsell_bruto numeric DEFAULT 0;
