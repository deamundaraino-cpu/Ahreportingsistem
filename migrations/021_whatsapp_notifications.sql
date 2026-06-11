-- ════════════════════════════════════════════════════════════════
-- Migration 021: WhatsApp notifications (Baileys gateway)
-- ════════════════════════════════════════════════════════════════
-- Notificaciones a GRUPOS de WhatsApp vía un microservicio externo
-- (gateway Baileys, fuera de Vercel). La app NO mantiene la conexión:
-- el gateway expone una API REST y persiste su sesión en
-- `whatsapp_session`. Aquí viven el catálogo de grupos, el ruteo
-- (por cliente y/o por tipo de notificación) y el log de envíos.
--
-- Todo en `public` (ya expuesto a supabase-js). Admin-only vía RLS,
-- reusando public.user_profiles.role (mismo criterio que el resto).
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- Helper: ¿el usuario actual es admin/superadmin?
-- (no asumimos que exista uno previo en public; lo creamos idempotente)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles
        WHERE id = auth.uid()
          AND role IN ('admin', 'superadmin')
    );
$$;

-- ────────────────────────────────────────────────────────────────
-- 1. Sesión del gateway (la lee/escribe SOLO el gateway con service_role)
--    Fila única (el número de la agencia). `creds`/`keys` = auth state Baileys.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_session (
    id TEXT PRIMARY KEY DEFAULT 'agency',          -- una sola sesión por ahora
    creds JSONB,                                    -- authState.creds
    keys JSONB DEFAULT '{}'::jsonb NOT NULL,        -- signal keys serializadas
    me JSONB,                                       -- { id, name } del número conectado
    connected BOOLEAN DEFAULT FALSE NOT NULL,
    last_connected_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.whatsapp_session ENABLE ROW LEVEL SECURITY;
-- Sin policies de SELECT/INSERT para authenticated: solo service_role
-- (gateway) la toca. service_role bypassa RLS.

-- ────────────────────────────────────────────────────────────────
-- 2. Catálogo de grupos (cacheado desde GET /groups del gateway)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id TEXT UNIQUE NOT NULL,                  -- jid "...@g.us"
    group_name TEXT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE NOT NULL,
    synced_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_groups_enabled ON public.whatsapp_groups(enabled);

ALTER TABLE public.whatsapp_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage wa_groups"
    ON public.whatsapp_groups
    FOR ALL
    USING (public.wa_is_admin())
    WITH CHECK (public.wa_is_admin());

-- ────────────────────────────────────────────────────────────────
-- 3. Ruteo: (cliente, tipo) → grupo. cliente_id NULL = ruta global por tipo.
--    Una ruta = un grupo; varias filas = varios grupos para el mismo par.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE, -- NULL = global
    notification_type TEXT NOT NULL,                -- metrics_summary | alert_threshold | report_ready | sale.approved | sale.refunded | manual
    group_id TEXT NOT NULL REFERENCES public.whatsapp_groups(group_id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Unicidad robusta tratando NULL como "global" (Postgres permite múltiples
-- NULL en UNIQUE normal; usamos índice con COALESCE para evitar duplicados).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wa_routes
    ON public.whatsapp_routes (
        COALESCE(cliente_id, '00000000-0000-0000-0000-000000000000'::uuid),
        notification_type,
        group_id
    );
CREATE INDEX IF NOT EXISTS idx_wa_routes_lookup
    ON public.whatsapp_routes(notification_type, cliente_id) WHERE enabled = TRUE;

ALTER TABLE public.whatsapp_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage wa_routes"
    ON public.whatsapp_routes
    FOR ALL
    USING (public.wa_is_admin())
    WITH CHECK (public.wa_is_admin());

-- ────────────────────────────────────────────────────────────────
-- 4. Log de envíos (espejo de report_utm.outbound_deliveries)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
    notification_type TEXT NOT NULL,
    group_id TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,          -- pending | sent | error
    gateway_message_id TEXT,
    error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_cliente ON public.whatsapp_messages(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON public.whatsapp_messages(status);

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin read wa_messages"
    ON public.whatsapp_messages
    FOR SELECT
    USING (public.wa_is_admin());
-- Insert/update lo hace el server con service_role (bypassa RLS).

-- ────────────────────────────────────────────────────────────────
-- 5. Trigger updated_at para routes
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_routes_updated ON public.whatsapp_routes;
CREATE TRIGGER trg_wa_routes_updated
    BEFORE UPDATE ON public.whatsapp_routes
    FOR EACH ROW EXECUTE FUNCTION public.wa_set_updated_at();
