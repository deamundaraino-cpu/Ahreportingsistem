-- Create Clientes table
CREATE TABLE public.clientes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  config_api JSONB DEFAULT '{}'::jsonb NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Protect Clientes Table
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

-- create policy so clients can view their own data
CREATE POLICY "Clientes view own row"
ON public.clientes
FOR SELECT USING (auth.uid() = user_id);

-- create policy for admin
CREATE POLICY "Admin full access (view/edit)"
ON public.clientes
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- Create Metricas_diarias table
CREATE TABLE public.metricas_diarias (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  fecha DATE NOT NULL,
  meta_spend DECIMAL DEFAULT 0,
  meta_impressions INTEGER DEFAULT 0,
  meta_clicks INTEGER DEFAULT 0,
  ga_sessions INTEGER DEFAULT 0,
  hotmart_pagos_iniciados INTEGER DEFAULT 0,
  ventas_principal DECIMAL DEFAULT 0,
  ventas_bump DECIMAL DEFAULT 0,
  ventas_upsell DECIMAL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(cliente_id, fecha)
);

-- Protect metricas_diarias
ALTER TABLE public.metricas_diarias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients view own metrics"
ON public.metricas_diarias
FOR ALL USING (
  cliente_id IN (
    SELECT id FROM public.clientes WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Admin full access metrics"
ON public.metricas_diarias
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- For background workers we will use Service Role Key which bypasses RLS.

-- ────────────────────────────────────────────────────────────────
-- Campaign Groups: Agrupar campañas relacionadas para reportes
-- ────────────────────────────────────────────────────────────────

CREATE TABLE public.campaign_groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  color TEXT DEFAULT 'blue',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(cliente_id, nombre)
);

ALTER TABLE public.campaign_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients view own campaign_groups"
ON public.campaign_groups
FOR ALL USING (
  cliente_id IN (
    SELECT id FROM public.clientes WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Admin full access campaign_groups"
ON public.campaign_groups
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- Mapeos: Qué campañas pertenecen a cada grupo
CREATE TABLE public.campaign_group_mappings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID REFERENCES public.campaign_groups(id) ON DELETE CASCADE NOT NULL,
  campaign_id TEXT,
  campaign_name_pattern TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(group_id, campaign_id, campaign_name_pattern)
);

ALTER TABLE public.campaign_group_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own mappings"
ON public.campaign_group_mappings
FOR ALL USING (
  group_id IN (
    SELECT id FROM public.campaign_groups
    WHERE cliente_id IN (
      SELECT id FROM public.clientes WHERE user_id = auth.uid()
    )
  )
);

CREATE POLICY "Admin full access mappings"
ON public.campaign_group_mappings
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');
