-- Migration 011: Add ventas_cerradas column for manual sales entry (asesorías, etc)
ALTER TABLE public.metricas_diarias
    ADD COLUMN IF NOT EXISTS ventas_cerradas INTEGER DEFAULT 0;
