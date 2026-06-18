-- ============================================================
-- 033_bi_reports_share.sql
-- Compartir reportes BI por link público + campos calculados.
-- ------------------------------------------------------------
-- public_token: token aleatorio para acceso de solo lectura sin auth
--   (igual patrón que los reportes mensuales públicos).
-- calculated_fields: definiciones de métricas personalizadas (JSONB array).
-- ============================================================

ALTER TABLE public.bi_reports
    ADD COLUMN IF NOT EXISTS public_token      TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS calculated_fields JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS bi_reports_public_token_idx
    ON public.bi_reports(public_token)
    WHERE public_token IS NOT NULL;

-- Política de lectura pública por token: cualquiera (anon) puede leer
-- un reporte que tenga public_token asignado. El acceso real se hace
-- desde el server con el service-role + filtro por token, así que esta
-- política es defensiva por si se consulta desde el cliente anon.
DROP POLICY IF EXISTS bi_reports_public_read ON public.bi_reports;
CREATE POLICY bi_reports_public_read ON public.bi_reports
    FOR SELECT TO anon
    USING (public_token IS NOT NULL);
