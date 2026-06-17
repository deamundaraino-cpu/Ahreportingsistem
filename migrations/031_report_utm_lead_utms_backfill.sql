-- ============================================================
-- 031_report_utm_lead_utms_backfill.sql
-- Backfill de UTMs en lead_events a partir de page_url.
-- ------------------------------------------------------------
-- El plugin WordPress envía page_url (la landing con sus UTMs en
-- la query string) pero no los UTMs como columnas separadas, así
-- que utm_source/campaign/click_id quedaban NULL. El endpoint S2S
-- ya parsea page_url para leads nuevos (ver src/app/api/report-utm/
-- pixel/s2s/route.ts); esta migración recupera los leads históricos.
-- ============================================================

-- Helper: decodifica percent-encoding (%5B → '[') y '+' → espacio.
-- Itera byte a byte para soportar UTF-8 multibyte (acentos, emojis).
CREATE OR REPLACE FUNCTION report_utm.url_decode(input text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    bin  bytea = '';
    tok  text;
BEGIN
    FOR tok IN
        SELECT (regexp_matches(replace(input, '+', ' '), '(%[0-9a-fA-F]{2}|.)', 'g'))[1]
    LOOP
        IF left(tok, 1) = '%' AND length(tok) = 3 THEN
            bin := bin || decode(substring(tok from 2 for 2), 'hex');
        ELSE
            bin := bin || convert_to(tok, 'utf8');
        END IF;
    END LOOP;
    RETURN convert_from(bin, 'utf8');
END;
$$;

-- Backfill: rellena columnas UTM (NULL) desde page_url.
-- No toca lead_name, lead_email, lead_phone ni raw_fields.
UPDATE report_utm.lead_events
SET
    utm_source   = report_utm.url_decode((regexp_match(page_url, '[?&]utm_source=([^&]*)'))[1]),
    utm_medium   = report_utm.url_decode((regexp_match(page_url, '[?&]utm_medium=([^&]*)'))[1]),
    utm_campaign = report_utm.url_decode((regexp_match(page_url, '[?&]utm_campaign=([^&]*)'))[1]),
    utm_content  = report_utm.url_decode((regexp_match(page_url, '[?&]utm_content=([^&]*)'))[1]),
    utm_term     = report_utm.url_decode((regexp_match(page_url, '[?&]utm_term=([^&]*)'))[1]),
    utm_id       = (regexp_match(page_url, '[?&]utm_id=([^&]*)'))[1],
    click_id     = COALESCE(
                       (regexp_match(page_url, '[?&]fbclid=([^&]*)'))[1],
                       (regexp_match(page_url, '[?&]gclid=([^&]*)'))[1]
                   ),
    attribution_method = CASE
        WHEN page_url ~ '[?&](fbclid|gclid)=' THEN 'click_id'
        WHEN page_url ~ '[?&]utm_source='     THEN 'utm_only'
        ELSE 'none'
    END,
    attribution_resolved_at = NOW()
WHERE (page_url ~ '[?&]utm_source=' OR page_url ~ '[?&](fbclid|gclid)=')
  AND utm_source IS NULL;   -- solo los que aún no fueron parseados
