-- ════════════════════════════════════════════════════════════════════════════
-- 098 · Los clientes son de la empresa, no de un usuario
-- ════════════════════════════════════════════════════════════════════════════
--
-- Decisión del usuario (2026-09-28), que sustituye a la de la 081: un cliente
-- no pertenece a ningún usuario. Borrar un usuario —aunque haya creado
-- clientes— tiene que poder hacerse siempre, sin «transferir» nada. El acceso
-- de un trafficker a un cliente lo da SOLO `user_client_assignments`, que cae
-- con el usuario.
--
-- 1. `puede_ver_cliente(cid)`: admin/superadmin, o asignación explícita. Es el
--    mismo criterio que la app aplica en código (`resolverClientesVisibles`).
-- 2. Las 17 políticas «Clients view own…» leían `clientes.user_id =
--    auth.uid()`: se recrean sobre `puede_ver_cliente`. Así además la 099 puede
--    borrar la columna (una política que la nombra bloquea el DROP).
-- 3. `public.clientes`:
--    · Fuera `"Public view cliente via token" USING (true)`: con la anon key
--      —pública, viaja en el navegador— se leía `config_api` de TODOS los
--      clientes (tokens de Meta, Hotmart, GA…). Nadie la usaba: `/p/` resuelve
--      el token con el cliente de servicio.
--    · `"Admins and Traffickers full access"` dejaba fuera al superadmin y
--      daba a cualquier trafficker todos los clientes: pasa a
--      `puede_ver_cliente(id)`.
-- 4. `clientes.user_id → auth.users` pasa de RESTRICT a SET NULL. La columna se
--    borra en la 099, DESPUÉS de desplegar el código que ya no la lee (el
--    desplegado hoy la consulta en /api/v1, en `deleteUser` y en el contexto
--    del agente: borrarla antes los rompería).
-- 5. `bitacoras.author_id` era NOT NULL y sin ON DELETE (NO ACTION): cualquier
--    autor de una bitácora era imborrable («Database error deleting user»).
--    Pasa a NULL-able y SET NULL; `author_name` conserva el nombre.
-- 6. `report_utm.clientes.public_cliente_id` pasa a único (parcial): dos
--    aperturas simultáneas de la ficha podían crear dos espejos del mismo
--    cliente. Antes se comprueba que no haya duplicados.
--
-- `scripts/verify-borrado-cascada.ts` (test:datos) comprueba 3, 4 y 5.
--
-- Idempotente.
--
--   npx tsx scripts/sql-remoto.ts migrations/096_clientes_de_la_empresa.sql

BEGIN;

-- 1. Criterio de acceso ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.puede_ver_cliente(cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles p
    WHERE p.id = (SELECT auth.uid())
      AND (
        p.role::text IN ('admin', 'superadmin')
        OR EXISTS (
          SELECT 1 FROM public.user_client_assignments a
          WHERE a.user_id = p.id AND a.client_id = cid
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.puede_ver_cliente(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_ver_cliente(uuid) TO authenticated, service_role;

-- 2. Políticas que leían clientes.user_id ───────────────────────────────────
DROP POLICY IF EXISTS "Clients view own ga4_estado" ON public.ga4_estado;
CREATE POLICY "Clients view own ga4_estado" ON public.ga4_estado
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios;
CREATE POLICY "Clients view own ga4_eventos_clave_diarios" ON public.ga4_eventos_clave_diarios
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias;
CREATE POLICY "Clients view own ga4_sesiones_diarias" ON public.ga4_sesiones_diarias
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own hotmart_ventas" ON public.hotmart_ventas;
CREATE POLICY "Clients view own hotmart_ventas" ON public.hotmart_ventas
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own leads_diarios" ON public.leads_diarios;
CREATE POLICY "Clients view own leads_diarios" ON public.leads_diarios
  FOR SELECT USING (public.puede_ver_cliente(client_id));

DROP POLICY IF EXISTS "Users view own meta_data_streams" ON public.meta_data_streams;
CREATE POLICY "Users view own meta_data_streams" ON public.meta_data_streams
  FOR ALL USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own sheet_campo_valores" ON public.sheet_campo_valores;
CREATE POLICY "Clients view own sheet_campo_valores" ON public.sheet_campo_valores
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own sheet_campo_vistas" ON public.sheet_campo_vistas;
CREATE POLICY "Clients view own sheet_campo_vistas" ON public.sheet_campo_vistas
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients view own sheet_campos" ON public.sheet_campos;
CREATE POLICY "Clients view own sheet_campos" ON public.sheet_campos
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients can view their own tickets" ON public.soporte_tickets;
CREATE POLICY "Clients can view their own tickets" ON public.soporte_tickets
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS "Clients can create their own tickets" ON public.soporte_tickets;
CREATE POLICY "Clients can create their own tickets" ON public.soporte_tickets
  FOR INSERT WITH CHECK (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS metricas_diarias_select ON public.metricas_diarias;
CREATE POLICY metricas_diarias_select ON public.metricas_diarias
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS ads_daily_select ON public.ads_daily;
CREATE POLICY ads_daily_select ON public.ads_daily
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS conversiones_offline_select ON public.conversiones_offline;
CREATE POLICY conversiones_offline_select ON public.conversiones_offline
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS conversiones_offline_diarias_select ON public.conversiones_offline_diarias;
CREATE POLICY conversiones_offline_diarias_select ON public.conversiones_offline_diarias
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS sheet_filas_select ON public.sheet_filas;
CREATE POLICY sheet_filas_select ON public.sheet_filas
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

DROP POLICY IF EXISTS sheet_campo_valores_diarios_select ON public.sheet_campo_valores_diarios;
CREATE POLICY sheet_campo_valores_diarios_select ON public.sheet_campo_valores_diarios
  FOR SELECT USING (public.puede_ver_cliente(cliente_id));

-- 3. public.clientes ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Public view cliente via token" ON public.clientes;

DROP POLICY IF EXISTS "Admins and Traffickers full access" ON public.clientes;
CREATE POLICY "Admins and Traffickers full access" ON public.clientes
  FOR ALL TO authenticated
  USING (public.puede_ver_cliente(id))
  WITH CHECK (public.puede_ver_cliente(id));

-- 4. Sin dueño ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.clientes DROP CONSTRAINT IF EXISTS clientes_user_id_fkey;
    ALTER TABLE public.clientes
      ADD CONSTRAINT clientes_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 5. Autoría de bitácoras ───────────────────────────────────────────────────
ALTER TABLE public.bitacoras ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE public.bitacoras DROP CONSTRAINT IF EXISTS bitacoras_author_id_fkey;
ALTER TABLE public.bitacoras
  ADD CONSTRAINT bitacoras_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 6. Un espejo por cliente ──────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM report_utm.clientes
    WHERE public_cliente_id IS NOT NULL
    GROUP BY public_cliente_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Hay clientes con más de un espejo en report_utm.clientes: resuélvelos antes de aplicar la 098.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS report_utm_clientes_public_cliente_id_key
  ON report_utm.clientes (public_cliente_id)
  WHERE public_cliente_id IS NOT NULL;

COMMIT;
