-- ════════════════════════════════════════════════════════════════════════════
-- 099 · Fuera `clientes.user_id`
-- ════════════════════════════════════════════════════════════════════════════
--
-- Segunda mitad de la 098. Aplicar SOLO cuando esté desplegado el código que ya
-- no lee la columna (/api/v1/clients|metrics|campaigns, `deleteUser`,
-- `resolverClientesVisibles`). Con el código anterior, borrarla rompe esas
-- rutas.
--
-- La 098 ya recreó las políticas que la nombraban; si alguna quedara, el DROP
-- falla (sin CASCADE a propósito) en vez de llevarse políticas por delante.
--
-- Idempotente.
--
--   npx tsx scripts/sql-remoto.ts migrations/097_quitar_clientes_user_id.sql

BEGIN;

DROP INDEX IF EXISTS public.idx_clientes_user_id;
ALTER TABLE public.clientes DROP CONSTRAINT IF EXISTS clientes_user_id_fkey;
ALTER TABLE public.clientes DROP COLUMN IF EXISTS user_id;

COMMIT;
