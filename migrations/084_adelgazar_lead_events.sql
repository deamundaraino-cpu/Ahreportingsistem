-- ════════════════════════════════════════════════════════════════
-- Migration 084: adelgazar `report_utm.lead_events`
-- ════════════════════════════════════════════════════════════════
-- Sale del diagnóstico de la caída del 2026-09-20: 543 MB de datos contra
-- 224 MB de caché. La misma consulta tardaba 1.085 ms en frío y 4,2 ms en
-- caliente —258×, mismo plan—, así que lo que decide el rendimiento no es el
-- SQL sino cuánto cabe en memoria.
--
-- `lead_events` era 223 MB, el 41 % de la base. De sus 144 MB de columnas, dos
-- concentraban el 56 %, y las dos guardaban información que YA estaba en otras
-- columnas de la misma fila:
--
--   · `page_url`    42 MB (29 %) — 486 caracteres de media; la query string
--                                  repetía las UTM y el click id
--   · `first_touch` 39 MB (27 %) — JSONB con source/medium/campaign/content/term
--
-- Medido antes de tocar nada: de 89.489 filas con `first_touch`, `campaign`
-- coincidía con `utm_campaign` en 89.486 y `content` con `utm_content` en
-- 89.486. Era una copia, no un dato.
--
-- Idempotente. El código que la acompaña funciona ANTES y DESPUÉS de aplicarla
-- (dejar de escribir una columna nullable no rompe nada), así que no hace falta
-- coordinar despliegue y migración.

-- ── 1. Fuera `first_touch` y `last_touch` ────────────────────────
-- `last_touch` ya venía casi vacío: 180 filas de 92.967, porque la 079 dejó de
-- duplicarlo cuando coincidía con el first. Ahora se van los dos.
--
-- Nada los lee: la página de leads los excluye a propósito de su SELECT, y los
-- webhooks salientes (`outbound_webhooks`) están a 0. La página de una venta sí
-- pinta touches, pero los suyos salen de `sales_events`, que NO se toca aquí.
ALTER TABLE report_utm.lead_events
    DROP COLUMN IF EXISTS first_touch,
    DROP COLUMN IF EXISTS last_touch;

-- ── 2. Limpieza de `page_url` ────────────────────────────────────
-- Quita solo los parámetros que tienen columna propia en la misma fila. Los
-- propios del cliente (`lpt`, `hsa_*`, `brid`, los de preview de WordPress) se
-- conservan: aparecen en 3.565 filas y guardarlos cuesta 684 kB sobre los
-- 5,4 MB que ocuparía dejar solo el path. No hay nada que ganar quitándolos.
--
-- Espejo exacto de `normalizarPageUrl` en src/lib/report-utm/page-url.ts.
CREATE OR REPLACE FUNCTION report_utm.limpiar_page_url(p_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = report_utm, pg_temp
AS $$
    SELECT CASE WHEN p_url IS NULL THEN NULL ELSE
        regexp_replace(                                   -- 3) separador colgando
            regexp_replace(                               -- 2) separadores repetidos
                regexp_replace(                           -- 1) los pares duplicados
                    p_url,
                    '([?&])(utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id)=[^&#]*',
                    '\1', 'gi'),
                '([?&])&+', '\1', 'g'),
            '[?&]+($|#)', '\1', 'g')
    END
$$;

COMMENT ON FUNCTION report_utm.limpiar_page_url(TEXT) IS
    'Quita de una page_url los parámetros que ya viven en columnas (utm_*, fbclid, gclid, ttclid...). Conserva los propios del cliente. Espejo de normalizarPageUrl en page-url.ts.';

-- ── 3. Backfill POR LOTES, no de golpe ───────────────────────────
-- La Management API envía el archivo entero como una transacción implícita, así
-- que un UPDATE de las 93.000 filas se ejecutaría de una sola vez: es
-- exactamente la clase de operación que tumbó la instancia. En vez de eso se
-- deja una función que limpia UN lote y devuelve cuántas filas tocó.
--
-- Se llama en bucle hasta que devuelva 0, desde fuera de esta transacción:
--
--     npx tsx scripts/backfill-page-url.ts
--
-- Es autoterminante: el WHERE deja de encontrar filas cuando ya están limpias,
-- así que repetirlo de más es gratis y reanudarlo tras un corte es seguro.
CREATE OR REPLACE FUNCTION report_utm.backfill_page_url(p_lote INTEGER DEFAULT 2000)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = report_utm, pg_temp
AS $$
DECLARE
    v_tocadas INTEGER;
BEGIN
    IF p_lote IS NULL OR p_lote < 1 THEN
        RAISE EXCEPTION 'backfill_page_url: p_lote debe ser >= 1 (recibido: %)',
            COALESCE(p_lote::text, 'NULL');
    END IF;

    UPDATE report_utm.lead_events
    SET page_url = report_utm.limpiar_page_url(page_url)
    WHERE id IN (
        SELECT id FROM report_utm.lead_events
        WHERE page_url ~* '[?&](utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id)='
        LIMIT p_lote
    );

    GET DIAGNOSTICS v_tocadas = ROW_COUNT;
    RETURN v_tocadas;
END;
$$;

COMMENT ON FUNCTION report_utm.backfill_page_url(INTEGER) IS
    'Limpia un lote de page_url y devuelve cuántas filas tocó. Llamar en bucle hasta que devuelva 0 (scripts/backfill-page-url.ts). Autoterminante e idempotente.';

REVOKE ALL ON FUNCTION report_utm.backfill_page_url(INTEGER) FROM PUBLIC;

-- ── 4. Sobre recuperar el espacio ────────────────────────────────
-- Borrar una columna no devuelve el disco: marca el atributo como eliminado y el
-- espacio se reutiliza según autovacuum vaya pasando. Para recuperarlo de
-- inmediato haría falta VACUUM FULL o pg_repack, y NINGUNO de los dos puede
-- correr desde aquí: esto es una transacción implícita y VACUUM no admite eso.
-- Si se quiere el espacio ya, va en una ventana aparte y con la base tranquila.
