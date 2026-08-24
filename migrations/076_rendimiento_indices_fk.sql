-- ============================================================================
-- 076 · Rendimiento en base de datos
--
--   1. Índices de cobertura para las 17 claves foráneas que no tenían.
--   2. La política de `hotmart_ventas` reevaluaba `auth.<fn>()` por fila.
--
-- Los 64 "unused_index" que también marca el advisor NO se tocan aquí: llevan
-- poco tiempo y varios cubren rutas que solo se ejercitan en cierres de mes,
-- así que borrarlos ahora sería a ciegas. Se revisan tras un ciclo completo.
-- ============================================================================

-- ── 1. Claves foráneas sin índice ───────────────────────────────────────────
-- Sin índice, cada DELETE/UPDATE en la tabla referenciada tiene que hacer un
-- seq scan de la que referencia para comprobar la restricción.
CREATE INDEX IF NOT EXISTS idx_bitacoras_author_id                  ON public.bitacoras (author_id);
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_plantilla_id            ON public.cliente_tabs (plantilla_id);
CREATE INDEX IF NOT EXISTS idx_clientes_layout_id                   ON public.clientes (layout_id);
CREATE INDEX IF NOT EXISTS idx_clientes_user_id                     ON public.clientes (user_id);
CREATE INDEX IF NOT EXISTS idx_clientes_layouts_base_layout_id      ON public.clientes_layouts (base_layout_id);
CREATE INDEX IF NOT EXISTS idx_monthly_reports_template_id          ON public.monthly_reports (template_id);
CREATE INDEX IF NOT EXISTS idx_notif_rule_cooldowns_cliente_id      ON public.notification_rule_cooldowns (cliente_id);
CREATE INDEX IF NOT EXISTS idx_notif_rule_cooldowns_tab_id          ON public.notification_rule_cooldowns (tab_id);
CREATE INDEX IF NOT EXISTS idx_notification_rules_cliente_id        ON public.notification_rules (cliente_id);
CREATE INDEX IF NOT EXISTS idx_notification_rules_tab_id            ON public.notification_rules (tab_id);
CREATE INDEX IF NOT EXISTS idx_soporte_tickets_cliente_id           ON public.soporte_tickets (cliente_id);
CREATE INDEX IF NOT EXISTS idx_system_settings_updated_by           ON public.system_settings (updated_by);
CREATE INDEX IF NOT EXISTS idx_tab_templates_created_by             ON public.tab_templates (created_by);
CREATE INDEX IF NOT EXISTS idx_user_client_assign_assigned_by       ON public.user_client_assignments (assigned_by);
CREATE INDEX IF NOT EXISTS idx_user_client_assign_client_id         ON public.user_client_assignments (client_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_routes_cliente_id           ON public.whatsapp_routes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_routes_group_id             ON public.whatsapp_routes (group_id);


-- ── 2. auth_rls_initplan en hotmart_ventas ──────────────────────────────────
-- `auth.uid()` sin envolver se reevalúa una vez POR FILA. Metido en un
-- subselect, Postgres lo calcula una sola vez como InitPlan. Misma semántica,
-- coste constante en vez de lineal.
DO $$
DECLARE
  v_qual text;
BEGIN
  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'hotmart_ventas'
    AND policyname = 'Clients view own hotmart_ventas';

  IF v_qual IS NULL THEN
    RAISE NOTICE 'La política "Clients view own hotmart_ventas" no existe; no se reescribe.';
    RETURN;
  END IF;

  -- Solo envolvemos si aún está sin envolver.
  IF v_qual ~* '\(\s*select\s+auth\.' THEN
    RAISE NOTICE 'La política ya usa subselect; nada que hacer.';
    RETURN;
  END IF;

  v_qual := regexp_replace(v_qual, 'auth\.uid\(\)', '(select auth.uid())', 'gi');
  v_qual := regexp_replace(v_qual, 'auth\.role\(\)', '(select auth.role())', 'gi');
  v_qual := regexp_replace(v_qual, 'auth\.jwt\(\)', '(select auth.jwt())', 'gi');

  EXECUTE format(
    'ALTER POLICY %I ON public.hotmart_ventas USING (%s)',
    'Clients view own hotmart_ventas', v_qual
  );
  RAISE NOTICE 'Política reescrita con subselect.';
END $$;
