-- ════════════════════════════════════════════════════════════════
-- Migration 085: cadencia de autovacuum en las tablas de evento
-- ════════════════════════════════════════════════════════════════
-- Sale de perseguir por qué `verify-bi-golden` fallaba de forma intermitente
-- el 2026-09-21. La causa no era el test: era el *visibility map*.
--
-- ── El síntoma ───────────────────────────────────────────────────
-- `report_utm.bi_valores_conteo` sobre el cliente grande tardaba ~8 s contra el
-- `statement_timeout` de 8 s de PostgREST. Justo en el filo: pasaba con la
-- caché caliente y fallaba en frío. Cuando fallaba, el motor devolvía lista
-- VACÍA, así que el desplegable de campañas salía sin opciones y el informe no
-- decía nada. El EXPLAIN:
--
--     Index Only Scan using idx_rutm_lead_events_utm_cover
--       Heap Fetches: 6754        ← de 24.966 filas
--
-- Un «Index Only Scan» que va al heap 6.754 veces no es index-only: son 6.754
-- lecturas aleatorias. Tras un VACUUM manual: Heap Fetches 0, y la consulta
-- pasó de ~8.000 ms a 36,7 ms.
--
-- ── Por qué se repetiría sin esta migración ──────────────────────
-- La página de una tabla solo se marca «todo visible» cuando VACUUM pasa por
-- ella, y en una tabla de INSERCIONES casi puras el vacuum por filas muertas no
-- se dispara nunca. Para eso existe el disparador por inserciones, pero su
-- valor por defecto es proporcional:
--
--     1000 + 0,2 × n_live_tup
--
-- Con las 93.152 filas de `lead_events` eso son **19.630 inserciones**, o sea
-- un VACUUM cada ~20 días al ritmo actual de ~1.000 leads/día. Y empeora según
-- crece la tabla, porque es un porcentaje: al doble de filas, el doble de
-- espera. Entre medias, cada fila nueva es un Heap Fetch en potencia.
--
-- ── El arreglo: cadencia FIJA, no proporcional ───────────────────
-- `scale_factor = 0` y un umbral absoluto. Así la frecuencia no se degrada
-- conforme la tabla crece, que es justo lo que hacía el valor por defecto.
--
-- Idempotente: `ALTER TABLE ... SET (...)` sobrescribe. No toca datos ni toma
-- bloqueos exclusivos; solo cambia parámetros de almacenamiento.

-- ── lead_events ──────────────────────────────────────────────────
-- ~1.000 leads/día → vacuum cada ~2 días. Sus consultas dependen de que
-- `idx_rutm_lead_events_utm_cover` funcione de verdad como index-only.
ALTER TABLE report_utm.lead_events SET (
    autovacuum_vacuum_insert_scale_factor = 0,
    autovacuum_vacuum_insert_threshold    = 2000,
    autovacuum_analyze_scale_factor       = 0,
    autovacuum_analyze_threshold          = 2000
);

-- ── pixel_events ─────────────────────────────────────────────────
-- Umbral más alto porque su volumen va a ser MUY superior: hasta el 2026-09-21
-- el pixel JS del plugin estaba roto y no llegaba ni un pageview, pero la
-- v0.3.2 lo arregló. Con 270.000-336.000 clics a landing al mes medidos en
-- `ads_daily`, esta tabla pasa de ~1.000 filas/día a decenas de miles.
ALTER TABLE report_utm.pixel_events SET (
    autovacuum_vacuum_insert_scale_factor = 0,
    autovacuum_vacuum_insert_threshold    = 10000,
    autovacuum_analyze_scale_factor       = 0,
    autovacuum_analyze_threshold          = 10000
);

-- ── ads_daily ────────────────────────────────────────────────────
-- No es inserción pura: el sync la reescribe por upsert, así que sí genera
-- filas muertas y el vacuum normal sí se dispara. Aun así se le fija la
-- cadencia porque el motor del BI la recorre en cada informe.
--
-- Mismo patrón que la 068, que ya hizo esto con metricas_diarias, clientes,
-- cliente_tabs y sheet_campos: scale_factor 0 y umbral absoluto.
ALTER TABLE public.ads_daily SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 5000,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 2500
);

-- ── metricas_diarias NO se toca ──────────────────────────────────
-- La 068 ya le puso scale_factor 0 con umbral 50/25, que es MÁS agresivo que
-- cualquier cosa que tocara poner aquí. Una versión anterior de esta migración
-- le ponía 0.05 y habría empeorado lo que la 068 dejó bien. Antes de fijar
-- parámetros de una tabla, mira `reloptions` en `pg_class`: puede que ya estén.

-- ── Después de un reinicio o una restauración ────────────────────
-- Un reinicio resetea `pg_stat_user_tables`, y autovacuum decide a quién visitar
-- con esos contadores: el 2026-09-21 creía que `lead_events` tenía 201 filas
-- cuando tenía 93.152. Se recupera solo en ~1 día, pero para no esperar:
--
--     VACUUM (ANALYZE) report_utm.lead_events;
--
-- Se puede lanzar en caliente — VACUUM simple no toma bloqueos exclusivos.
-- VACUUM FULL sí los toma: ese NO.
