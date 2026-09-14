-- ════════════════════════════════════════════════════════════════════════════
-- 081 · Borrar un usuario no borra clientes · DDL de cuatro tablas sin versionar
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. `public.clientes.user_id → auth.users` era ON DELETE CASCADE: eliminar al
--    usuario dueño de un cliente borraba el cliente y, por las cascadas de la
--    080, TODOS sus datos, sin confirmación y sin pasar por
--    `eliminarClienteCompleto` (ni Storage ni el alcance del agente se
--    limpiaban). Hoy (2026-09-14) cuatro de los seis clientes son del mismo
--    superadmin. Decisión del usuario: RESTRICT. Para borrar a un usuario dueño
--    de clientes hay que pasarlos antes a otro (/admin/users,
--    `reasignarDuenoClientes`); `deleteUser` lo comprueba antes de intentarlo.
--
-- 2. `cliente_tabs`, `clientes_layouts`, `user_client_assignments` y
--    `meta_conversiones_catalogo` existen en producción pero nunca tuvieron un
--    CREATE en el repo. Se copian aquí del catálogo de producción del
--    2026-09-14, con sus FK en cascada, índices y políticas, y todo con
--    IF NOT EXISTS: en producción no cambia nada; en una base nueva nacen igual.
--    (El trigger `trg_notify_budget_alert` de `cliente_tabs` es de la 022.)
--
-- `scripts/verify-borrado-cascada.ts` (test:datos) comprueba ambas cosas.
--
-- Idempotente.
--
--   npx tsx scripts/sql-remoto.ts migrations/081_duenos_y_ddl_versionado.sql

BEGIN;

-- 1. Dueño del cliente ──────────────────────────────────────────────────────
ALTER TABLE public.clientes DROP CONSTRAINT IF EXISTS clientes_user_id_fkey;
ALTER TABLE public.clientes
  ADD CONSTRAINT clientes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

-- 2. Tablas sin versionar ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cliente_tabs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  keyword_meta TEXT NOT NULL,
  plantilla_id UUID,
  columnas JSONB,
  tarjetas JSONB,
  orden INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  fecha_finalizacion DATE,
  presupuesto_objetivo NUMERIC,
  fecha_inicio DATE,
  graficos JSONB,
  position INTEGER DEFAULT 0,
  text_blocks JSONB DEFAULT '[]'::jsonb,
  blocks_order JSONB DEFAULT '[]'::jsonb,
  custom_metrics JSONB DEFAULT '[]'::jsonb,
  public_token UUID DEFAULT gen_random_uuid(),
  tablas JSONB DEFAULT '[]'::jsonb,
  hotmart_funnel JSONB,
  archived BOOLEAN NOT NULL DEFAULT false,
  alert_email TEXT,
  alert_sent_at_90 TIMESTAMPTZ,
  alert_sent_at_100 TIMESTAMPTZ,
  ranking_tables JSONB,
  lead_answer_blocks JSONB,
  estrategia_tipo_id UUID,
  metas JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cliente_tabs_pkey PRIMARY KEY (id),
  CONSTRAINT cliente_tabs_public_token_key UNIQUE (public_token),
  -- Nombre fijo: los embeds de PostgREST lo citan (`cliente_tabs_cliente_id_fkey`).
  CONSTRAINT cliente_tabs_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT cliente_tabs_plantilla_id_fkey
    FOREIGN KEY (plantilla_id) REFERENCES public.layouts_reporte(id) ON DELETE SET NULL,
  CONSTRAINT cliente_tabs_estrategia_tipo_id_fkey
    FOREIGN KEY (estrategia_tipo_id) REFERENCES public.estrategia_tipos(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_cliente ON public.cliente_tabs (cliente_id);
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_estrategia ON public.cliente_tabs (estrategia_tipo_id);
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_funnel ON public.cliente_tabs USING gin (hotmart_funnel);
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_plantilla_id ON public.cliente_tabs (plantilla_id);
ALTER TABLE public.cliente_tabs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.clientes_layouts (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL,
  base_layout_id UUID,
  nombre TEXT NOT NULL,
  columnas JSONB NOT NULL DEFAULT '[]'::jsonb,
  tarjetas JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  graficos JSONB,
  attribution_strategy TEXT DEFAULT 'custom'::text,
  text_blocks JSONB DEFAULT '[]'::jsonb,
  blocks_order JSONB DEFAULT '[]'::jsonb,
  custom_metrics JSONB DEFAULT '[]'::jsonb,
  tablas JSONB DEFAULT '[]'::jsonb,
  ranking_tables JSONB DEFAULT '[]'::jsonb,
  lead_answer_blocks JSONB DEFAULT '[]'::jsonb,
  CONSTRAINT clientes_layouts_pkey PRIMARY KEY (id),
  CONSTRAINT cliente_layout_unique UNIQUE (cliente_id),
  CONSTRAINT clientes_layouts_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT clientes_layouts_base_layout_id_fkey
    FOREIGN KEY (base_layout_id) REFERENCES public.layouts_reporte(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_clientes_layouts_base_layout_id
  ON public.clientes_layouts (base_layout_id);
ALTER TABLE public.clientes_layouts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.user_client_assignments (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  client_id UUID NOT NULL,
  assigned_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_client_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT user_client_assignments_user_id_client_id_key UNIQUE (user_id, client_id),
  CONSTRAINT user_client_assignments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT user_client_assignments_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES public.clientes(id) ON DELETE CASCADE,
  CONSTRAINT user_client_assignments_assigned_by_fkey
    FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_user_client_assign_assigned_by
  ON public.user_client_assignments (assigned_by);
CREATE INDEX IF NOT EXISTS idx_user_client_assign_client_id
  ON public.user_client_assignments (client_id);
ALTER TABLE public.user_client_assignments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.meta_conversiones_catalogo (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL,
  conversion_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_id TEXT NOT NULL,
  last_seen DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT meta_conversiones_catalogo_pkey PRIMARY KEY (id),
  CONSTRAINT meta_conversiones_catalogo_cliente_id_conversion_key_key
    UNIQUE (cliente_id, conversion_key),
  CONSTRAINT meta_conversiones_catalogo_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE
);
ALTER TABLE public.meta_conversiones_catalogo ENABLE ROW LEVEL SECURITY;

-- Políticas tal como están en producción (solo se crean si faltan).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'cliente_tabs'
                  AND policyname = 'Admins and Traffickers full access to tabs') THEN
    CREATE POLICY "Admins and Traffickers full access to tabs" ON public.cliente_tabs
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_profiles
                      WHERE user_profiles.id = (SELECT auth.uid())
                        AND user_profiles.role = ANY (ARRAY['admin'::user_role, 'trafficker'::user_role])));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'clientes_layouts'
                  AND policyname = 'Authenticated full access to clientes_layouts') THEN
    CREATE POLICY "Authenticated full access to clientes_layouts" ON public.clientes_layouts
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'meta_conversiones_catalogo'
                  AND policyname = 'Allow all') THEN
    CREATE POLICY "Allow all" ON public.meta_conversiones_catalogo
      FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'user_client_assignments'
                  AND policyname = 'superadmin_admin_manage_assignments') THEN
    CREATE POLICY superadmin_admin_manage_assignments ON public.user_client_assignments
      FOR ALL
      USING (EXISTS (SELECT 1 FROM public.user_profiles
                      WHERE user_profiles.id = (SELECT auth.uid())
                        AND user_profiles.role = ANY (ARRAY['superadmin'::user_role, 'admin'::user_role])));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                  AND tablename = 'user_client_assignments'
                  AND policyname = 'users_read_own_assignments') THEN
    CREATE POLICY users_read_own_assignments ON public.user_client_assignments
      FOR SELECT USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

COMMIT;
