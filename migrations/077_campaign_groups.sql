-- ============================================================================
-- 077 · Crear campaign_groups y campaign_group_mappings
--
-- Estas dos tablas estaban declaradas en `schema.sql` desde el principio pero
-- NUNCA llegaron a existir en la base: ninguna migración las creó y el bootstrap
-- se hizo por migraciones, no por `schema.sql`. Comprobado el 2026-08-25 contra
-- `information_schema.tables`: cero filas en cualquier esquema.
--
-- El síntoma era invisible porque cada lectura las trata distinto:
--
--   · `dashboard/_actions.ts` (959, 2090) hace `campaignGroupsRes.data || []`,
--     así que los grupos de campaña salían siempre vacíos, sin ningún aviso.
--   · `lib/notifications/rules-engine.ts` y `admin/configuracion/_actions.ts`
--     ignoran el error igual.
--   · `api/v1/campaigns/route.ts` NO lo ignora: hace `if (error) throw` y
--     devolvía 500 a cualquier cliente de la API con token.
--
-- En `edge_logs` se veía como un 404 de PostgREST en cada carga de dashboard.
--
-- El DDL replica el de `schema.sql` salvo las políticas RLS, que allí colgaban
-- de un email en duro (`robinson@adshouse.com`) y de `clientes.user_id`, dos
-- criterios que la app ya no usa. Se sigue el patrón de la migración 075 para
-- `tab_templates`: RLS activada SIN políticas. Todas las lecturas van con el
-- service role, que se salta las RLS, así que esto no cambia el comportamiento
-- de la aplicación y cierra el acceso anónimo por PostgREST.
--
-- Idempotente: se puede aplicar dos veces sin efecto.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.campaign_groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  color TEXT DEFAULT 'blue',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE (cliente_id, nombre)
);

CREATE TABLE IF NOT EXISTS public.campaign_group_mappings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID REFERENCES public.campaign_groups(id) ON DELETE CASCADE NOT NULL,
  campaign_id TEXT,
  campaign_name_pattern TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE (group_id, campaign_id, campaign_name_pattern)
);

-- Índices sobre las FK, en la línea de la migración 076: ambas se filtran
-- siempre por la clave ajena (`.eq('cliente_id', …)` y el embed por `group_id`).
CREATE INDEX IF NOT EXISTS idx_campaign_groups_cliente
  ON public.campaign_groups (cliente_id);

CREATE INDEX IF NOT EXISTS idx_campaign_group_mappings_group
  ON public.campaign_group_mappings (group_id);

ALTER TABLE public.campaign_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_group_mappings ENABLE ROW LEVEL SECURITY;
