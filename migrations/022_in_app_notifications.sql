-- ════════════════════════════════════════════════════════════════
-- Migration 022: Notificaciones in-app (campanita)
-- ════════════════════════════════════════════════════════════════
-- Notificaciones por usuario dentro de la app: campanita con contador
-- en vivo (Supabase Realtime), historial en /notificaciones y
-- preferencias opt-out por tipo. Las inserta el server con
-- service_role (src/lib/notifications/notify.ts) salvo las alertas
-- de umbral de presupuesto, que escribe un worker externo en
-- cliente_tabs.alert_sent_at_90/100 y por eso se enganchan aquí con
-- un trigger de Postgres.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Notificaciones
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN (
        'alert_threshold', 'ticket_created', 'ticket_updated',
        'sale_approved', 'sale_refunded', 'sale_cancelled',
        'client_assigned', 'sync_failed', 'token_expiring', 'system')),
    severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'error')),
    title TEXT NOT NULL,
    message TEXT,
    link TEXT,                                      -- ruta interna, ej '/soporte' o '/dashboard/<id>'
    cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_user_created ON public.notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON public.notifications(user_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own notifications"
    ON public.notifications
    FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Users mark own notifications read"
    ON public.notifications
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());
-- Sin policy de INSERT: solo el server con service_role (bypassa RLS).

-- ────────────────────────────────────────────────────────────────
-- 2. Preferencias por usuario y tipo. Opt-out: sin fila = habilitado.
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_preferences (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    PRIMARY KEY (user_id, type)
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own notification prefs"
    ON public.notification_preferences
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────
-- 3. Realtime: la campanita escucha INSERTs en notifications.
--    postgres_changes respeta RLS, así que cada usuario solo recibe
--    eventos de sus propias filas (además del filter por user_id).
-- ────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ────────────────────────────────────────────────────────────────
-- 4. Trigger: alertas de umbral de presupuesto.
--    El worker externo marca cliente_tabs.alert_sent_at_90/100; al
--    pasar de NULL a valor se notifica a admins/superadmins y a los
--    traffickers asignados al cliente, respetando preferencias.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_budget_alert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_level INT;
    v_cliente_nombre TEXT;
BEGIN
    IF (NEW.alert_sent_at_100 IS NOT NULL AND OLD.alert_sent_at_100 IS NULL) THEN
        v_level := 100;
    ELSIF (NEW.alert_sent_at_90 IS NOT NULL AND OLD.alert_sent_at_90 IS NULL) THEN
        v_level := 90;
    ELSE
        RETURN NEW;
    END IF;

    SELECT nombre INTO v_cliente_nombre FROM public.clientes WHERE id = NEW.cliente_id;

    INSERT INTO public.notifications (user_id, type, severity, title, message, link, cliente_id, metadata)
    SELECT p.id,
           'alert_threshold',
           CASE WHEN v_level = 100 THEN 'error' ELSE 'warning' END,
           'Presupuesto al ' || v_level || '%',
           COALESCE(v_cliente_nombre, 'Cliente') || ' — pestaña "' || NEW.nombre || '" alcanzó el ' || v_level || '% del presupuesto',
           '/dashboard/' || NEW.cliente_id,
           NEW.cliente_id,
           jsonb_build_object('tab_id', NEW.id, 'level', v_level)
    FROM public.user_profiles p
    WHERE (p.role IN ('admin', 'superadmin')
           OR (p.role = 'trafficker' AND EXISTS (
                SELECT 1 FROM public.user_client_assignments a
                WHERE a.user_id = p.id AND a.client_id = NEW.cliente_id)))
      AND NOT EXISTS (
            SELECT 1 FROM public.notification_preferences np
            WHERE np.user_id = p.id
              AND np.type = 'alert_threshold'
              AND np.enabled = FALSE);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_budget_alert ON public.cliente_tabs;
CREATE TRIGGER trg_notify_budget_alert
    AFTER UPDATE OF alert_sent_at_90, alert_sent_at_100 ON public.cliente_tabs
    FOR EACH ROW EXECUTE FUNCTION public.notify_budget_alert();

-- ────────────────────────────────────────────────────────────────
-- 5. Backfill: las alertas ya activas (alert_sent_at_* marcado antes
--    de esta migración) no pasan por el trigger; se insertan una vez
--    aquí para que aparezcan en la campanita. Idempotente vía
--    NOT EXISTS sobre metadata->tab_id. created_at conserva la fecha
--    real de la alerta.
-- ────────────────────────────────────────────────────────────────
INSERT INTO public.notifications (user_id, type, severity, title, message, link, cliente_id, metadata, created_at)
SELECT p.id,
       'alert_threshold',
       CASE WHEN t.alert_sent_at_100 IS NOT NULL THEN 'error' ELSE 'warning' END,
       'Presupuesto al ' || CASE WHEN t.alert_sent_at_100 IS NOT NULL THEN 100 ELSE 90 END || '%',
       c.nombre || ' — pestaña "' || t.nombre || '" alcanzó el '
           || CASE WHEN t.alert_sent_at_100 IS NOT NULL THEN 100 ELSE 90 END || '% del presupuesto',
       '/dashboard/' || t.cliente_id,
       t.cliente_id,
       jsonb_build_object(
           'tab_id', t.id,
           'level', CASE WHEN t.alert_sent_at_100 IS NOT NULL THEN 100 ELSE 90 END,
           'backfill', TRUE),
       COALESCE(t.alert_sent_at_100, t.alert_sent_at_90)
FROM public.cliente_tabs t
JOIN public.clientes c ON c.id = t.cliente_id
CROSS JOIN public.user_profiles p
WHERE t.archived = FALSE
  AND t.presupuesto_objetivo IS NOT NULL
  AND (t.alert_sent_at_90 IS NOT NULL OR t.alert_sent_at_100 IS NOT NULL)
  AND (p.role IN ('admin', 'superadmin')
       OR (p.role = 'trafficker' AND EXISTS (
            SELECT 1 FROM public.user_client_assignments a
            WHERE a.user_id = p.id AND a.client_id = t.cliente_id)))
  AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
        WHERE n.user_id = p.id
          AND n.type = 'alert_threshold'
          AND n.metadata->>'tab_id' = t.id::text);
