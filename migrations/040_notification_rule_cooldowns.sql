-- Migración: tabla de cooldowns por regla + cliente + pestaña
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.notification_rule_cooldowns (
    rule_id    UUID NOT NULL REFERENCES public.notification_rules(id) ON DELETE CASCADE,
    cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    tab_id     UUID NOT NULL REFERENCES public.cliente_tabs(id) ON DELETE CASCADE,
    last_triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rule_id, cliente_id, tab_id)
);

ALTER TABLE public.notification_rule_cooldowns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin manage rule cooldowns"
    ON public.notification_rule_cooldowns
    FOR ALL
    USING (public.wa_is_admin())
    WITH CHECK (public.wa_is_admin());

-- Índice para consultas rápidas por rule_id
CREATE INDEX IF NOT EXISTS idx_rule_cooldowns_rule_id
    ON public.notification_rule_cooldowns(rule_id);
