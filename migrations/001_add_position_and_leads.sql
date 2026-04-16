-- Migration: Add position to cliente_tabs + Create leads table + Google Sheets config
-- Run this in Supabase SQL Editor

-- ============================================================
-- 1. Add 'position' column to cliente_tabs for drag & drop ordering
-- ============================================================
ALTER TABLE public.cliente_tabs
ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;

-- Fill initial positions based on existing 'orden' column
UPDATE public.cliente_tabs SET position = orden WHERE position = 0;

-- ============================================================
-- 2. Create leads table for Google Sheets integration
-- ============================================================
CREATE TABLE IF NOT EXISTS public.leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  lead_external_id TEXT,                              -- e.g. lead row ID from Google Sheets
  lead_data JSONB DEFAULT '{}'::jsonb,
  is_qualified BOOLEAN DEFAULT false,
  qualification_field TEXT,
  qualification_value TEXT,
  source VARCHAR(50) DEFAULT 'google_sheets',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(client_id, lead_external_id)
);

CREATE INDEX IF NOT EXISTS idx_leads_client_date ON public.leads(client_id, date);
CREATE INDEX IF NOT EXISTS idx_leads_qualified ON public.leads(client_id, is_qualified, date);

-- ============================================================
-- 3. Create daily lead aggregates table (for fast dashboard queries)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.leads_diarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  leads_totales INTEGER DEFAULT 0,
  leads_calificados INTEGER DEFAULT 0,
  leads_no_calificados INTEGER DEFAULT 0,
  tasa_calificacion DECIMAL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(client_id, date)
);

CREATE INDEX IF NOT EXISTS idx_leads_diarios_client_date ON public.leads_diarios(client_id, date);

-- ============================================================
-- 4. RLS Policies for leads tables
-- ============================================================
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads_diarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients view own leads"
ON public.leads FOR SELECT USING (
  client_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid())
);

CREATE POLICY "Admin full access leads"
ON public.leads FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

CREATE POLICY "Clients view own leads_diarios"
ON public.leads_diarios FOR SELECT USING (
  client_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid())
);

CREATE POLICY "Admin full access leads_diarios"
ON public.leads_diarios FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- ============================================================
-- 5. Note: Google Sheets config goes into clientes.config_api.google_sheets
-- Example structure:
-- {
--   "google_sheets": {
--     "sheet_url": "https://docs.google.com/spreadsheets/d/...",
--     "quality_field": "cual_es_tu_rango_de_ingresos",
--     "qualified_values": ["$5,000 - $20,000 USD", "$20,000+ USD"],
--     "enabled": true
--   }
-- }
-- ============================================================
