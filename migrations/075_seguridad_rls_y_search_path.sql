-- ============================================================================
-- 075 · Endurecimiento de seguridad en base de datos
--
-- Sale de los advisors de Supabase. Tres bloques:
--
--   1. RLS en `public.tab_templates` (era el único ERROR del linter).
--   2. Revocar EXECUTE público en las funciones SECURITY DEFINER que son
--      de trigger y no tienen por qué ser llamables por RPC.
--   3. Fijar `search_path` en las 33 funciones que lo tenían mutable.
--
-- Lo que deliberadamente NO se toca está explicado abajo.
-- ============================================================================

-- ── 1. RLS en tab_templates ─────────────────────────────────────────────────
-- Toda la app lee y escribe esta tabla con el service role
-- (`dashboard/_actions.ts`: 888, 1154, 1394 …), que se salta las RLS, así que
-- activar RLS sin políticas cierra el acceso anónimo por PostgREST sin cambiar
-- el comportamiento de la aplicación.
ALTER TABLE public.tab_templates ENABLE ROW LEVEL SECURITY;


-- ── 2. Funciones SECURITY DEFINER expuestas en /rest/v1/rpc/ ────────────────
-- Solo se revocan las que son funciones de trigger: PostgreSQL no comprueba el
-- privilegio EXECUTE al disparar un trigger, así que quitarlo no rompe nada y
-- sí cierra la llamada directa por RPC.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'notify_budget_alert'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.notify_budget_alert() FROM anon, authenticated, public';
  END IF;
END $$;

-- NO se revoca EXECUTE en `public.is_superadmin()`, `public.wa_is_admin()`,
-- `report_utm.can_view()` ni `report_utm.is_admin()`, aunque el advisor las
-- marque: se invocan DENTRO de expresiones de políticas RLS (6, 5, 4 y 16
-- políticas respectivamente) y ahí PostgreSQL sí comprueba EXECUTE contra el
-- rol que consulta. Revocarlo dejaría esas políticas sin poder evaluarse y
-- rompería el acceso legítimo. Además solo devuelven un booleano sobre el rol
-- de quien llama, así que la exposición por RPC no filtra datos de nadie.


-- ── 3. search_path fijo ─────────────────────────────────────────────────────
-- Sin `search_path` fijo, quien invoca la función puede anteponer un esquema
-- propio y secuestrar los nombres sin cualificar que haya en el cuerpo. Se fija
-- a `public, report_utm, pg_temp` en vez de a '' porque varios cuerpos usan
-- nombres sin cualificar y '' los rompería.

ALTER FUNCTION public.ads_daily_resumen(uuid, text, date, date, text, boolean)            SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.claim_sync_job(text, integer)                                        SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.conversiones_offline_podar_tab(uuid, text, text, integer[])          SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.conversiones_offline_upsert_lote(uuid, text, uuid, jsonb)            SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.fusionar_config_api(uuid, jsonb)                                     SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.guardar_hotmart_venta(jsonb)                                         SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.handle_new_user()                                                    SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.heartbeat_sync_job(uuid, text)                                       SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.hotmart_valores_conteo(uuid, text, date, date, integer)              SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.is_superadmin()                                                      SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.purgar_ads_daily(integer)                                            SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.purgar_hotmart_pii(integer)                                          SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.purgar_hotmart_raw(integer)                                          SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.purgar_sales_events_raw(integer)                                     SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.set_bi_reports_updated_at()                                          SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.set_ticket_display_id()                                              SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.set_updated_at_rules()                                               SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.sheet_filas_podar_tab(uuid, text, text, integer[])                   SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.sheet_filas_upsert_lote(uuid, text, uuid, jsonb)                     SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.sheet_podar_tabs(uuid, text, text[])                                 SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.touch_sync_jobs_updated_at()                                         SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.touch_updated_at()                                                   SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.wa_is_admin()                                                        SET search_path = public, report_utm, pg_temp;
ALTER FUNCTION public.wa_set_updated_at()                                                  SET search_path = public, report_utm, pg_temp;

ALTER FUNCTION report_utm.bi_leads_por_dia(uuid, timestamptz, timestamptz, integer)                       SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.bi_respuestas_por_dia(uuid, timestamptz, timestamptz, text[], integer)          SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.bi_valores_conteo(uuid, text, timestamptz, timestamptz, text, text[], integer)  SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.bi_valores_utm(uuid, text, timestamptz, timestamptz, integer)                   SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.can_view()                                                                      SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.is_admin()                                                                      SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.norm_clave(text)                                                                SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.set_updated_at()                                                                SET search_path = report_utm, public, pg_temp;
ALTER FUNCTION report_utm.url_decode(text)                                                                SET search_path = report_utm, public, pg_temp;
