-- ════════════════════════════════════════════════════════════════
-- 101 · Salud de la base: latido de las purgas y muestras de tamaño
-- ════════════════════════════════════════════════════════════════
--
-- Nada avisaba si la base se saturaba, si las purgas dejaban de correr o si el
-- tamaño se disparaba. La 061 existe porque la base llegó a 539 MB sin que
-- nadie lo viera, y las purgas cuelgan del plan diario de la mañana: si el plan
-- no corre, tampoco ellas, y no hay síntoma hasta que falta espacio.
--
--   · `mantenimiento_log`: bitácora de solo añadir. `limpiarHistorial` deja una
--     fila `purga` cada vez que termina y `/api/worker/health` una fila `tamano`
--     al día. De ahí salen «hace cuánto que no se purga» y «cuánto ha crecido
--     en 7 días». Se recorta sola a 90 días desde la propia purga.
--   · `salud_base()`: tamaño de la base, conexiones y las 8 tablas más grandes.
--     Solo lectura de catálogo; la llama `/api/worker/health` cada 30 minutos.
--
-- Sin `cliente_id`: no es dato de cliente, así que no lleva FK ni política con
-- `puede_ver_cliente`. RLS activada y sin políticas = solo la service role.
--
-- Solo añade: se puede aplicar antes de desplegar el código. Sin ella el código
-- sigue funcionando y `/api/worker/health` responde `base.disponible: false`.
--
-- Idempotente.
--
-- Reversión:
--   DROP FUNCTION IF EXISTS public.salud_base();
--   DROP TABLE IF EXISTS public.mantenimiento_log;
--
--   npx tsx scripts/sql-remoto.ts migrations/101_salud_base.sql

CREATE TABLE IF NOT EXISTS public.mantenimiento_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tipo TEXT NOT NULL CHECK (tipo IN ('purga', 'tamano')),
    ocurrido_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    detalle JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mantenimiento_log_tipo_fecha
    ON public.mantenimiento_log (tipo, ocurrido_at DESC);

ALTER TABLE public.mantenimiento_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.mantenimiento_log IS
    'Bitácora de mantenimiento: una fila `purga` por corrida de limpiarHistorial y una `tamano` al día. La lee /api/worker/health para alertar. Retención: 90 días.';

-- SECURITY INVOKER a propósito: `pg_database_size`, `pg_total_relation_size` y
-- el recuento de `pg_stat_activity` no necesitan privilegios de más, así que no
-- hay motivo para que la función corra como su dueño.
CREATE OR REPLACE FUNCTION public.salud_base()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'db_bytes', pg_database_size(current_database()),
        'conexiones', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
        'max_conexiones', current_setting('max_connections')::int,
        'tablas', (
            SELECT coalesce(jsonb_agg(t), '[]'::jsonb)
            FROM (
                SELECT n.nspname AS esquema,
                       c.relname AS tabla,
                       pg_total_relation_size(c.oid) AS bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'r'
                  AND n.nspname IN ('public', 'report_utm')
                ORDER BY pg_total_relation_size(c.oid) DESC
                LIMIT 8
            ) t
        )
    );
$$;

COMMENT ON FUNCTION public.salud_base() IS
    'Tamaño de la base, conexiones en uso y las 8 tablas más grandes (con índices y TOAST). Solo lectura.';

REVOKE ALL ON FUNCTION public.salud_base() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salud_base() TO service_role;

NOTIFY pgrst, 'reload schema';
