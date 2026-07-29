-- ════════════════════════════════════════════════════════════════
-- Migration 061: Limpieza de almacenamiento
-- ════════════════════════════════════════════════════════════════
-- La base llegó a 539 MB contra el tope de 500 MB del plan gratuito. La auditoría
-- mostró que ~295 MB no eran datos: eran basura de un bug que fallaba en silencio,
-- una tabla muerta e índices que nadie ha usado nunca.
--
-- Los datos de negocio estaban BIEN: cero duplicados en `lead_events`, y los
-- totales por cliente de `conversiones_offline` cuadran antes y después. Esto es
-- un problema de almacenamiento, no de exactitud de los informes.
--
-- Lo que ya se hizo fuera de esta migración (operaciones sobre datos, no DDL):
--   • Se borró el cliente "Prueba", que tenía configurado el MISMO Google Sheet
--     que Goodprop y arrastraba 112.180 de las 130.895 filas de `sheet_filas`.
--   • Con él se fueron los 5 lotes de sync obsoletos que el full-replace no había
--     conseguido retirar. `sheet_filas` quedó en 1 lote y 18.715 filas.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. `public.leads` — tabla muerta (45 MB)
-- ────────────────────────────────────────────────────────────────
-- La migración 059 retiró la integración "Google Sheets — Leads" y dejó esta
-- tabla marcada por COMMENT como "No escribir". Hoy no tiene NI UNA referencia en
-- el repo: ni en src/, ni scripts/, ni sync-worker/, ni whatsapp-gateway/.
--
-- El histórico se respaldó a CSV antes de soltarla:
--   npx tsx scripts/backup-leads-legacy.ts backups/leads-legacy.csv
--   → 42.263 filas verificadas.
--
-- OJO: `leads_diarios` NO se toca. Esa sí se lee, en dashboard/_actions.ts y
-- tiene prioridad sobre el campo de Sheet en merge-metrics.ts. Y pesa 216 kB.
DROP TABLE IF EXISTS public.leads;

-- ────────────────────────────────────────────────────────────────
-- 2. Índices sin un solo uso (~32 MB)
-- ────────────────────────────────────────────────────────────────
-- Los contadores son fiables: `pg_stat_database.stats_reset` es NULL, o sea que
-- `idx_scan` acumula desde que se creó la base (26-feb-2026). Todos estos están
-- a cero.

-- GIN de 16 MB sobre `sheet_filas.valores`. Nunca se consultó por contenido:
-- `leerFilasCrudas` (campos-db.ts:118) filtra por cliente_id y fecha, que es lo
-- que sirve `idx_sheet_filas_cliente_fecha`.
--
-- Además era el causante del bug: obligaba al DELETE del full-replace a mantener
-- 16 MB de índice para ~80 mil filas, lo que no cabía en el statement_timeout de
-- 8 s del rol de PostgREST. El delete moría, su error se descartaba (ver el
-- arreglo en google-sheets-conversiones.ts) y el lote viejo se quedaba.
DROP INDEX IF EXISTS public.idx_sheet_filas_valores;

-- Búsqueda de leads por email: la UI filtra por utm_* y fechas, nunca por email.
DROP INDEX IF EXISTS report_utm.idx_rutm_lead_events_email;

-- Índices de `metricas_diarias` sobre jsonb que ninguna consulta aprovecha.
DROP INDEX IF EXISTS public.idx_metricas_diarias_meta_streams;
DROP INDEX IF EXISTS public.idx_metricas_sync_hash;
DROP INDEX IF EXISTS public.idx_metricas_diarias_funnel_data;

-- NOTA — los dos índices de `pixel_events` (`idx_rutm_pixel_click_id`, 10 MB, y
-- `idx_rutm_pixel_cliente_time`, 2,5 MB) también están a 0 scans, pero NO se
-- retiran aquí. Su cero es sospechoso: `pixel_events.visitor_id` es NULL en las
-- 35.884 filas, y attribution-resolver.ts:59 consulta justo por esa columna. O
-- sea que esa vía de atribución probablemente no está funcionando, y los índices
-- están a cero por el bug, no por sobrar. Retirarlos ahora taparía el problema.
-- Ver el aviso al final de esta migración.

COMMENT ON TABLE public.leads_diarios IS
    'LEGACY pero VIVA: la lee dashboard/_actions.ts y tiene prioridad sobre el campo de Sheet en merge-metrics.ts. No borrar (a diferencia de `leads`, retirada en la migración 061).';
