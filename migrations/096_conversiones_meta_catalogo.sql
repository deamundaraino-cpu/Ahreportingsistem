-- ════════════════════════════════════════════════════════════════
-- Migration 096: catálogo de conversiones personalizadas de Meta
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría del 2026-09-28 de la tarjeta «Conversiones
-- Personalizadas». El catálogo (081) solo guardaba una etiqueta que el sync
-- inventaba («Lead s Trilogia») y pisaba en cada corrida, y `last_seen`
-- retrocedía con cada resincronización histórica. Esta migración añade:
--
--   - Lo que manda Meta: `origen` ('cc' = regla de Events Manager, 'evento' =
--     evento personalizado del píxel), `nombre_meta` (nombre real de la CC o el
--     evento con sus mayúsculas), `regla`, `custom_event_type`, `cuenta_id`.
--   - Lo que decide el usuario, que el sync NUNCA toca: `label_manual`,
--     `tipo`, `es_resultado` (cuenta como «resultado principal» del cliente) y
--     `archivada`.
--   - `ultima_actividad`: último día con conversiones (no retrocede).
--
-- `label` sigue existiendo y un disparador la mantiene como la etiqueta
-- efectiva (manual > Meta > clave): los lectores actuales no cambian.
--
-- La RPC `upsert_meta_conversiones` es el único camino de escritura del sync.
-- El código sondea la RPC y cae al upsert antiguo si falta, así que funciona
-- con o sin la migración.
--
-- Idempotente. REVERSIBLE:
--   DROP FUNCTION public.upsert_meta_conversiones(UUID, JSONB);
--   DROP TRIGGER meta_conversiones_catalogo_label ON public.meta_conversiones_catalogo;
--   DROP FUNCTION public.meta_conversiones_catalogo_label();
--   ALTER TABLE public.meta_conversiones_catalogo DROP COLUMN origen, … (las de abajo);
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Columnas
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.meta_conversiones_catalogo
  ADD COLUMN IF NOT EXISTS origen            TEXT,
  ADD COLUMN IF NOT EXISTS nombre_meta       TEXT,
  ADD COLUMN IF NOT EXISTS label_manual      TEXT,
  ADD COLUMN IF NOT EXISTS tipo              TEXT NOT NULL DEFAULT 'otro',
  ADD COLUMN IF NOT EXISTS es_resultado      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archivada         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS regla             JSONB,
  ADD COLUMN IF NOT EXISTS custom_event_type TEXT,
  ADD COLUMN IF NOT EXISTS cuenta_id         TEXT,
  ADD COLUMN IF NOT EXISTS ultima_actividad  DATE,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'meta_conversiones_catalogo_tipo_check') THEN
    ALTER TABLE public.meta_conversiones_catalogo
      ADD CONSTRAINT meta_conversiones_catalogo_tipo_check
      CHECK (tipo IN ('lead', 'registro', 'agenda', 'compra', 'otro')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'meta_conversiones_catalogo_origen_check') THEN
    ALTER TABLE public.meta_conversiones_catalogo
      ADD CONSTRAINT meta_conversiones_catalogo_origen_check
      CHECK (origen IS NULL OR origen IN ('cc', 'evento')) NOT VALID;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────
-- 2) Relleno (antes del disparador: aquí `label` aún es la antigua)
-- ────────────────────────────────────────────────────────────────
-- Una etiqueta que no es la inventada «Lead …» en una CC es el nombre real de
-- Meta: se conserva como `nombre_meta`.
UPDATE public.meta_conversiones_catalogo
   SET nombre_meta = label
 WHERE nombre_meta IS NULL
   AND conversion_key ~ '^[0-9]+$'
   AND label NOT LIKE 'Lead %';

UPDATE public.meta_conversiones_catalogo
   SET origen = CASE WHEN conversion_key ~ '^[0-9]+$' THEN 'cc' ELSE 'evento' END
 WHERE origen IS NULL;

UPDATE public.meta_conversiones_catalogo
   SET ultima_actividad = last_seen
 WHERE ultima_actividad IS NULL;

-- Tipo sugerido por el nombre (mismo criterio que `inferirTipo`), solo donde
-- nadie lo ha elegido aún.
UPDATE public.meta_conversiones_catalogo
   SET tipo = CASE
     WHEN lower(coalesce(nombre_meta, conversion_key)) ~ '(compra|purchase|venta|pago|order|upsell)' THEN 'compra'
     WHEN lower(coalesce(nombre_meta, conversion_key)) ~ '(agenda|reuni|meeting|cita|schedul|llamada)' THEN 'agenda'
     WHEN lower(coalesce(nombre_meta, conversion_key)) ~ '(registr|inscri|signup|sign_up)' THEN 'registro'
     WHEN lower(coalesce(nombre_meta, conversion_key)) ~ 'lead' THEN 'lead'
     ELSE 'otro'
   END
 WHERE tipo = 'otro' AND label_manual IS NULL AND NOT es_resultado;

ALTER TABLE public.meta_conversiones_catalogo VALIDATE CONSTRAINT meta_conversiones_catalogo_tipo_check;
ALTER TABLE public.meta_conversiones_catalogo VALIDATE CONSTRAINT meta_conversiones_catalogo_origen_check;

-- ────────────────────────────────────────────────────────────────
-- 3) `label` = etiqueta efectiva
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.meta_conversiones_catalogo_label()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.label := COALESCE(
    NULLIF(btrim(NEW.label_manual), ''),
    NULLIF(btrim(NEW.nombre_meta), ''),
    NEW.conversion_key
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meta_conversiones_catalogo_label ON public.meta_conversiones_catalogo;
CREATE TRIGGER meta_conversiones_catalogo_label
  BEFORE INSERT OR UPDATE ON public.meta_conversiones_catalogo
  FOR EACH ROW EXECUTE FUNCTION public.meta_conversiones_catalogo_label();

-- Recalcula las etiquetas existentes: las «Lead …» inventadas pasan a la clave
-- (o al nombre real de Meta) hasta que el próximo sync traiga `nombre_meta`.
UPDATE public.meta_conversiones_catalogo SET updated_at = now();

-- ────────────────────────────────────────────────────────────────
-- 4) Escritura del sync
-- ────────────────────────────────────────────────────────────────
-- `p_filas`: [{conversion_key, field_id, origen, nombre_meta, regla,
--              custom_event_type, cuenta_id, tipo, ultima_actividad}, …]
-- `tipo` solo se escribe al insertar. Las fechas nunca retroceden.
CREATE OR REPLACE FUNCTION public.upsert_meta_conversiones(p_cliente_id UUID, p_filas JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT;
BEGIN
  INSERT INTO public.meta_conversiones_catalogo AS t (
    cliente_id, conversion_key, label, field_id, last_seen, origen, nombre_meta,
    regla, custom_event_type, cuenta_id, tipo, ultima_actividad
  )
  SELECT
    p_cliente_id,
    f->>'conversion_key',
    f->>'conversion_key',                        -- el disparador pone la efectiva
    COALESCE(f->>'field_id', 'meta_custom_' || (f->>'conversion_key')),
    COALESCE((f->>'ultima_actividad')::date, CURRENT_DATE),
    f->>'origen',
    NULLIF(f->>'nombre_meta', ''),
    CASE WHEN jsonb_typeof(f->'regla') = 'string'
         THEN (f->>'regla')::jsonb
         ELSE NULLIF(f->'regla', 'null'::jsonb) END,
    f->>'custom_event_type',
    f->>'cuenta_id',
    COALESCE(NULLIF(f->>'tipo', ''), 'otro'),
    (f->>'ultima_actividad')::date
  FROM jsonb_array_elements(p_filas) AS f
  WHERE COALESCE(f->>'conversion_key', '') <> ''
  ON CONFLICT (cliente_id, conversion_key) DO UPDATE SET
    origen            = COALESCE(EXCLUDED.origen, t.origen),
    nombre_meta       = COALESCE(EXCLUDED.nombre_meta, t.nombre_meta),
    regla             = COALESCE(EXCLUDED.regla, t.regla),
    custom_event_type = COALESCE(EXCLUDED.custom_event_type, t.custom_event_type),
    cuenta_id         = COALESCE(EXCLUDED.cuenta_id, t.cuenta_id),
    last_seen         = GREATEST(t.last_seen, EXCLUDED.last_seen),
    ultima_actividad  = GREATEST(t.ultima_actividad, EXCLUDED.ultima_actividad);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_meta_conversiones(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_meta_conversiones(UUID, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
