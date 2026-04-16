-- Migration 003: Attribution Strategy
-- Adds attribution_strategy column to global and per-client layouts.
-- Run this in Supabase SQL Editor before deploying LayoutBuilder changes.

ALTER TABLE public.layouts_reporte
    ADD COLUMN IF NOT EXISTS attribution_strategy TEXT DEFAULT 'custom';

ALTER TABLE public.clientes_layouts
    ADD COLUMN IF NOT EXISTS attribution_strategy TEXT DEFAULT 'custom';

COMMENT ON COLUMN public.layouts_reporte.attribution_strategy IS
    'Preset strategy: custom | hybrid | full_meta | full_hotmart. Controls alias source resolution fallback.';

COMMENT ON COLUMN public.clientes_layouts.attribution_strategy IS
    'Preset strategy: custom | hybrid | full_meta | full_hotmart. Controls alias source resolution fallback.';
