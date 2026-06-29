-- Migración: crear tabla de configuración del sistema (branding, logo y colores)
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- RLS
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Helper to check if superadmin
CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid()
          AND role = 'superadmin'
    );
$$;

-- Policies:
-- 1. Read access for all authenticated and anonymous users (so branding is visible on login page)
DROP POLICY IF EXISTS "Allow public read of system settings" ON public.system_settings;
CREATE POLICY "Allow public read of system settings"
    ON public.system_settings
    FOR SELECT
    USING (true);

-- 2. Write access only for superadmins
DROP POLICY IF EXISTS "Superadmin manage system settings" ON public.system_settings;
CREATE POLICY "Superadmin manage system settings"
    ON public.system_settings
    FOR ALL
    USING (public.is_superadmin())
    WITH CHECK (public.is_superadmin());

-- Seed default branding
INSERT INTO public.system_settings (key, value)
VALUES (
    'branding',
    '{
        "logo_url": "",
        "colors": {
            "primary": "#1E6AB5",
            "secondary": "#E53529"
        }
    }'::jsonb
) ON CONFLICT (key) DO NOTHING;
