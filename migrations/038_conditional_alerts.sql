-- 1. Actualizar el CHECK constraint de notifications.type para incluir alert_metric
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
    'alert_threshold', 'alert_metric', 'ticket_created', 'ticket_updated',
    'sale_approved', 'sale_refunded', 'sale_cancelled',
    'client_assigned', 'sync_failed', 'token_expiring', 'system'
));

-- 2. Crear tabla de reglas de alertas condicionales
CREATE TABLE IF NOT EXISTS public.notification_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE, -- NULL = global
    tab_id UUID REFERENCES public.cliente_tabs(id) ON DELETE CASCADE,  -- NULL = nivel cliente o general
    nombre TEXT NOT NULL,
    metric TEXT NOT NULL,                                              -- 'budget_percentage', 'roas', 'cpl', 'spend', 'revenue', 'leads'
    operator TEXT NOT NULL,                                            -- '>', '<', '>=', '<='
    value NUMERIC(12, 2) NOT NULL,
    time_window TEXT NOT NULL,                                         -- 'today', 'yesterday', 'last_7_days', 'last_30_days', 'current_tab_period'
    channels TEXT[] NOT NULL DEFAULT '{in_app}',                       -- Array: 'in_app', 'whatsapp'
    cooldown_hours INTEGER NOT NULL DEFAULT 24,                        -- Evitar spamming
    last_triggered_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 3. Habilitar RLS y políticas para Admin
ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage notification_rules"
    ON public.notification_rules
    FOR ALL
    USING (public.wa_is_admin())
    WITH CHECK (public.wa_is_admin());

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at_rules()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_rules_updated
    BEFORE UPDATE ON public.notification_rules
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_rules();
