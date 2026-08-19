-- ════════════════════════════════════════════════════════════════
-- Migration 074: Leads de GoHighLevel en la tabla de leads de siempre
-- ════════════════════════════════════════════════════════════════
-- Hasta aquí solo había DOS caminos de escritura a `report_utm.lead_events`:
-- el endpoint S2S del plugin de WordPress y Meta Lead Ads (migración 035). Los
-- clientes que trabajan su captación en un CRM quedaban fuera del UTM report:
-- sus contactos no aparecían en `leads.count`, no tenían CPL y sus respuestas no
-- alimentaban los campos de lead. El hueco se tapaba a mano con un Google Sheet.
--
-- Esta migración NO crea una tabla de leads de GHL. Los contactos entran en la
-- MISMA `report_utm.lead_events` que el resto de fuentes, y por eso heredan
-- gratis `leads.count`, el CPL, `utm_leads`, los campos de lead (`leadfield:`),
-- los segmentos (`leadseg:`) y las RPC `bi_leads_por_dia` / `bi_respuestas_por_dia`.
-- Una tabla aparte habría obligado a duplicar las siete piezas anteriores.
--
-- ── Qué DDL hace falta, y qué no ────────────────────────────────
-- Sobre `lead_events` NADA: `external_id` y su índice único ya existen (035), y
-- `form_plugin`, `source` e `integrations.tipo` son TEXT libres. Los valores
-- nuevos son:
--
--   · lead_events.form_plugin = 'gohighlevel'
--   · lead_events.source      = 'gohighlevel'
--   · lead_events.external_id = 'ghl:<contactId>'
--   · integrations.tipo       = 'gohighlevel'
--
-- El prefijo `ghl:` del `external_id` no es decorativo: el índice único es
-- (cliente_id, external_id) y ya lo comparte Meta con sus `leadgen_id`. El
-- prefijo hace imposible una colisión y documenta el origen en la propia fila.
--
-- Lo que SÍ hace falta tocar es `public.sync_jobs.tipo`, que tiene un CHECK
-- cerrado (última vez en la 066). El planner encola un job `ghl_leads` en cada
-- pasada diaria: sin ampliar el CHECK, ese INSERT falla con 23514 y la
-- integración se queda sin su red de seguridad — el webhook seguiría entrando,
-- así que el fallo sería silencioso hasta que alguien mirara la cola.
--
-- ── La regla de oro del cruce con el gasto ──────────────────────
-- `utm_id = attributionSource.campaignId ?? attributionSource.adId`.
--
-- El `adId` que trae un contacto de GHL es el `ad_id` de Meta —los leads de
-- Click-to-WhatsApp lo llevan siempre— y entra por el paso 3 de la cascada de
-- `campaign-resolver.ts` (`utm_id === ad_id` → sube a su campaña), que es el
-- mismo mecanismo que sostiene a Meta Lead Ads. Sin él, cada lead del CRM caería
-- en `(sin campaña)` con gasto 0 y la integración no serviría para nada.
--
-- Corolario, y es el error fácil: `attributionSource.mediumId` es el id de la
-- CUENTA o PÁGINA de origen (p. ej. una cuenta de Instagram), no el de una
-- campaña ni el de un anuncio. Si acabara en `utm_id` no cruzaría con nada y
-- además ensuciaría el diagnóstico de `/report-utm/cruce-campanas` con un id que
-- parece bueno. Nunca va a `utm_id`.
--
-- Un contacto sin `adId` (tráfico orgánico) se queda con `utm_id = NULL` a
-- propósito: cae en `(sin campaña)` con gasto 0, que es lo correcto según el
-- doc 18. Sintetizar un id inventado sería peor que no tener ninguno.
--
-- ── GHL es FUENTE ÚNICA por cliente ─────────────────────────────
-- Al activar la integración se pausan (`status='inactive'`) las integraciones
-- `s2s` y `meta_lead_ads` de ese cliente. `lead_events` no deduplica por email
-- ni por teléfono: si el formulario web y el CRM quedaran activos a la vez, el
-- mismo humano entraría dos veces y `leads.count` quedaría inflado sin que nada
-- lo avisara. Se prefiere perder la atribución de píxel del formulario web
-- (que en estos clientes ya la resuelve el CRM) antes que una métrica que miente.
--
-- ── Qué cuenta como lead ────────────────────────────────────────
-- Un contacto creado. Opcionalmente acotado por etiquetas en
-- `integrations.config.filtro = {tags[], excluir_tags[]}`: una location con
-- chatbot mete miles de contactos que no son captación, y sin filtro el CPL se
-- hunde. El filtro se evalúa en Node al ingerir, no en SQL.
--
-- ── Campos personalizados ───────────────────────────────────────
-- GHL devuelve `customFields: [{id, value}]` con ids opacos. El catálogo
-- (`GET /locations/{id}/customFields`) se cachea en `integrations.config
-- .custom_fields` y la clave de `raw_fields` es el **`name`** del campo, no su
-- `fieldKey`: `name` normalizado por `normalizarClaveLead` da la misma clave
-- canónica que ve el analista en la tarjeta de campos de lead, mientras que
-- `fieldKey` pierde acentos de forma inconsistente (`Huéspedes` → `huspedes`).
--
-- Dos exclusiones deliberadas de `raw_fields`, ambas van a `custom_data`:
--   · los campos de texto largo (transcripciones, "Resumen IA"): un valor
--     distinto por lead haría que el detector los ofreciera con miles de
--     buckets, que es justo lo que un campo de lead no debe ser;
--   · los ids que el catálogo no resuelve: meter `7cedTg6j0qCWO0PNzmEg` como
--     nombre de pregunta sería basura permanente.
--
-- ── Fechas ──────────────────────────────────────────────────────
-- `created_at` = `dateAdded` del contacto, nunca `now()`. `bi_leads_por_dia`
-- agrupa en `America/Bogota`; sellar la fecha de ingesta movería de día a todo
-- el backfill.
--
-- REVERSIBLE:
--   ALTER TABLE public.sync_jobs DROP CONSTRAINT sync_jobs_tipo_check;
--   ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo IN (
--       'metricas','sheets_leads','sheets_conversiones','meta_leads',
--       'utm_aggregate','cierre_mes','reconciliar',
--       'hotmart_ventas','hotmart_reconciliar'));
--   DELETE FROM public.sync_jobs WHERE tipo = 'ghl_leads';
--   DELETE FROM report_utm.lead_events WHERE source = 'gohighlevel';
--   DELETE FROM report_utm.integrations WHERE tipo = 'gohighlevel';
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Tipo de job del polling
-- ────────────────────────────────────────────────────────────────
-- Se repite la lista entera porque un CHECK no se puede ampliar en sitio. Los
-- valores previos son los de la 066, sin cambios.
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_tipo_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo IN (
    'metricas', 'sheets_leads', 'sheets_conversiones',
    'meta_leads', 'utm_aggregate', 'cierre_mes',
    'reconciliar',
    'hotmart_ventas',
    'hotmart_reconciliar',
    -- Contactos de GoHighLevel → report_utm.lead_events. Sin rango de fechas: su
    -- cursor es el `dateAdded` del último contacto visto y vive en
    -- `integrations.config.sync_cursor`, no en el job.
    'ghl_leads'
));

-- ────────────────────────────────────────────────────────────────
-- 2. El external_id ahora lo comparten dos plataformas
-- ────────────────────────────────────────────────────────────────
-- El comentario de la 035 solo hablaba de Meta. El prefijo es lo que las mantiene
-- separadas dentro del mismo índice único.
COMMENT ON COLUMN report_utm.lead_events.external_id IS
    'ID del lead en la plataforma de origen, usado para deduplicar entre webhook y polling. Meta Lead Ads guarda el leadgen_id crudo; GoHighLevel guarda el contacto con el prefijo ghl:<contactId>, que evita cualquier colisión en el índice único (cliente_id, external_id).';
