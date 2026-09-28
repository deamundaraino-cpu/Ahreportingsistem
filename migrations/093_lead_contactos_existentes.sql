-- ════════════════════════════════════════════════════════════════
-- Migration 093: duplicados de lead al ingresar («cuenta el primero»)
-- ════════════════════════════════════════════════════════════════
-- La regla de exclusión del cliente (`lead-exclusion.ts`, ficha del cliente →
-- «Qué leads cuentan») gana la casilla «Excluir duplicados»: un lead cuyo email
-- o teléfono ya tiene un lead ANTERIOR que cuenta se guarda marcado con
-- `excluido_motivo = 'duplicado'`.
--
-- En el histórico lo decide Node recorriendo los leads por fecha
-- (`lead-exclusion-db.ts`), sin esta migración. Al ingresar, en cambio, hay que
-- preguntar a la base si el contacto ya existe, y PostgREST no puede filtrar por
-- `lower(lead_email)` ni por los dígitos del teléfono. Para eso es esta RPC.
--
-- Las claves son EXACTAMENTE las de `lead-duplicados.ts`:
--     email     lower(btrim(lead_email))
--     teléfono  right(regexp_replace(lead_phone, '\D', '', 'g'), 9)
-- Si una cambia, cambia la otra.
--
-- ── Índices ──────────────────────────────────────────────────────
-- Dos índices de expresión PARCIALES sobre los leads que cuentan (`NOT
-- excluido`), que es justo lo que pregunta la RPC. Sobre ~93k filas son unos
-- pocos MB. Sin ellos la RPC recorre los leads del cliente por
-- `(cliente_id, created_at)`: funciona, pero en cada lead que entra.
--
-- ── OJO: los índices NO se crean aplicando este archivo a pelo ───
-- Un `CREATE INDEX` normal bloquea los INSERT de leads y el rol `authenticator`
-- tiene `lock_timeout = 8s`: un lead que no espera se PIERDE (lección de las
-- migraciones 086 y 088). `CREATE INDEX CONCURRENTLY` no puede ir dentro de la
-- transacción implícita de un archivo, así que se lanzan una a una:
--
--     npx tsx scripts/sql-remoto.ts --query="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_events_email_norm ON report_utm.lead_events (cliente_id, lower(btrim(lead_email))) WHERE lead_email IS NOT NULL AND NOT excluido"
--     npx tsx scripts/sql-remoto.ts --query="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lead_events_telefono_norm ON report_utm.lead_events (cliente_id, right(regexp_replace(lead_phone, '\D', '', 'g'), 9)) WHERE lead_phone IS NOT NULL AND NOT excluido"
--
-- y DESPUÉS este archivo, que crea la función (y deja los índices como no-op
-- gracias al IF NOT EXISTS). Si un CONCURRENTLY se corta deja el índice con
-- `indisvalid = false`: tirarlo con DROP INDEX CONCURRENTLY y reintentar.
--
-- El código funciona ANTES y DESPUÉS: sin la función, la ingesta no marca
-- duplicados (el lead entra normal) y la ficha del cliente lo avisa.
--
-- Idempotente.
--
-- REVERSIBLE:
--   DROP FUNCTION IF EXISTS report_utm.lead_contactos_existentes(UUID, TEXT[], TEXT[]);
--   DROP INDEX CONCURRENTLY IF EXISTS report_utm.idx_lead_events_email_norm;
--   DROP INDEX CONCURRENTLY IF EXISTS report_utm.idx_lead_events_telefono_norm;
-- ════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_lead_events_email_norm
    ON report_utm.lead_events (cliente_id, lower(btrim(lead_email)))
    WHERE lead_email IS NOT NULL AND NOT excluido;

CREATE INDEX IF NOT EXISTS idx_lead_events_telefono_norm
    ON report_utm.lead_events (cliente_id, right(regexp_replace(lead_phone, '\D', '', 'g'), 9))
    WHERE lead_phone IS NOT NULL AND NOT excluido;

CREATE OR REPLACE FUNCTION report_utm.lead_contactos_existentes(
    p_cliente_id UUID,
    p_emails     TEXT[],
    p_telefonos  TEXT[]
)
RETURNS TABLE (tipo TEXT, clave TEXT)
LANGUAGE sql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
    SELECT DISTINCT 'e'::TEXT, lower(btrim(e.lead_email))
      FROM report_utm.lead_events e
     WHERE e.cliente_id = p_cliente_id
       AND e.lead_email IS NOT NULL
       AND NOT e.excluido
       AND lower(btrim(e.lead_email)) = ANY (COALESCE(p_emails, '{}'))
    UNION
    SELECT DISTINCT 't'::TEXT, right(regexp_replace(e.lead_phone, '\D', '', 'g'), 9)
      FROM report_utm.lead_events e
     WHERE e.cliente_id = p_cliente_id
       AND e.lead_phone IS NOT NULL
       AND NOT e.excluido
       AND right(regexp_replace(e.lead_phone, '\D', '', 'g'), 9) = ANY (COALESCE(p_telefonos, '{}'));
$$;

GRANT EXECUTE ON FUNCTION report_utm.lead_contactos_existentes(UUID, TEXT[], TEXT[])
    TO authenticated, service_role;

COMMENT ON FUNCTION report_utm.lead_contactos_existentes(UUID, TEXT[], TEXT[]) IS
    'Qué emails (tipo e) y teléfonos (tipo t, últimos 9 dígitos) del cliente ya tienen un lead que cuenta. La usa la ingesta para marcar duplicados (lead-duplicados.ts). Ver migración 093.';

COMMENT ON COLUMN report_utm.lead_events.excluido_motivo IS
    'sin_atribucion | source_excluida | formulario_excluido | campana_excluida | medio_excluido | pais_excluido | respuesta_excluida | etiqueta_excluida | contacto_excluido | duplicado | manual';

-- Sin esto PostgREST no ve la función nueva hasta que recarga solo el esquema.
NOTIFY pgrst, 'reload schema';
