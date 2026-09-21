-- ════════════════════════════════════════════════════════════════
-- Migration 086: buscar un lead por nombre, email o teléfono
-- ════════════════════════════════════════════════════════════════
-- La página de leads nunca tuvo buscador: se podía filtrar por UTM y por fecha,
-- pero no encontrar a una persona concreta. Cuando un cliente preguntaba «¿os
-- llegó el contacto de Fulano?», la única salida era exportar el CSV y abrirlo.
--
-- La migración 061 había borrado el único índice de contacto que existía:
--
--     -- Búsqueda de leads por email: la UI filtra por utm_* y fechas, nunca por email.
--     DROP INDEX IF EXISTS report_utm.idx_rutm_lead_events_email;
--
-- Esa premisa deja de ser cierta hoy, así que hay que volver a indexar — pero
-- para `ILIKE '%texto%'`, que un B-tree no puede servir.
--
-- ── Por qué el índice no es opcional ─────────────────────────────
-- Medido el 2026-09-21: `lead_events` son 171 MB (21.877 páginas, 93.152 filas) y
-- `shared_buffers` son 224 MB. El EXPLAIN de la búsqueda sin índice da un
-- `Seq Scan` de coste 23.507.
--
-- O sea: cada pulsación de tecla leería 171 MB y desalojaría prácticamente toda
-- la caché. Eso no es «una consulta lenta», es exactamente el modo de fallo del
-- 2026-09-20, provocado a voluntad y por cualquiera que teclee en un input.
--
-- ── Por qué TRES índices y no uno concatenado ────────────────────
-- Un GIN sobre `name || ' ' || email || ' ' || phone` genera la MISMA cantidad de
-- trigramas (ahorra unos 2 MB del árbol de entradas, nada más) y exige o una
-- columna generada o un trigger. Y `ADD COLUMN ... GENERATED ... STORED`
-- reescribe la tabla entera con ACCESS EXCLUSIVE: 171 MB bloqueando lecturas Y
-- escrituras, en una instancia de 1 GB que se cayó anteayer. No compensa.
--
-- Con tres índices el planner hace BitmapOr de los tres, que es justo lo que
-- produce el `.or()` de PostgREST que manda la app.
--
-- ── Por qué `fastupdate = off` ───────────────────────────────────
-- Con el valor por defecto, los INSERT van a una *pending list* y el INSERT
-- desafortunado que la desborda paga la fusión entera. Ese INSERT es el webhook
-- S2S de un lead, que corre con `statement_timeout` de 8 s: si se pasa, el lead
-- se pierde. A ~1.000 leads/día mantener el índice en cada INSERT (unas 40
-- entradas × 3 índices) no se nota, y a cambio la latencia es predecible.
--
-- ── Coste ────────────────────────────────────────────────────────
-- Estimado 12-20 MB para los tres (presupuesto: 25 MB), sobre 48 MB de índices
-- que la tabla ya tiene. `scripts/verify-busqueda-leads-db.ts` mide el tamaño
-- real y falla si se desmadra.
--
-- ── OJO: esto bloquea escrituras ─────────────────────────────────
-- Un `CREATE INDEX` normal toma un lock SHARE, que bloquea INSERT/UPDATE/DELETE
-- (los SELECT pasan). Y el rol `authenticator` tiene `lock_timeout = 8s`: los
-- INSERT de leads NO esperan a que termine, **fallan**. Con ~1-3 min de build son
-- uno o dos leads perdidos, y llegan a ráfagas.
--
-- Por eso el camino recomendado NO es aplicar este archivo a pelo:
--
--     npx tsx scripts/crear-indices-busqueda.ts
--
-- Ese script manda cada índice como CREATE INDEX CONCURRENTLY en su propia
-- petición (no bloquea escrituras) y luego esta migración queda como no-op: los
-- `IF NOT EXISTS` no vuelven a crear nada. Aplicar este archivo directamente sigue
-- siendo válido en un entorno nuevo, pequeño o parado.
--
-- Idempotente. El código que la acompaña funciona ANTES y DESPUÉS: sin los
-- índices el buscador da los mismos resultados, solo que con un seq scan.
--
-- REVERSIBLE:
--   DROP INDEX CONCURRENTLY IF EXISTS report_utm.idx_rutm_lead_events_nombre_trgm;
--   DROP INDEX CONCURRENTLY IF EXISTS report_utm.idx_rutm_lead_events_email_trgm;
--   DROP INDEX CONCURRENTLY IF EXISTS report_utm.idx_rutm_lead_events_tel_trgm;
--   -- y, si nada más lo usa:
--   DROP EXTENSION IF EXISTS pg_trgm;
-- ════════════════════════════════════════════════════════════════

-- ── 1. La extensión ──────────────────────────────────────────────
-- Es la primera CREATE EXTENSION del repo. Va al esquema `extensions`, que es
-- donde este proyecto ya tiene pgcrypto y uuid-ossp.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ── 2. Los índices ───────────────────────────────────────────────
-- Las tres columnas son exactamente las de COLUMNAS_BUSQUEDA en
-- src/lib/report-utm/leads-filtros.ts. Si una lista cambia sin la otra, el
-- buscador mira una columna sin indexar y vuelve el seq scan de 171 MB sin que
-- nadie se entere: `scripts/verify-leads-filtros.ts` compara las dos listas.

CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_nombre_trgm
    ON report_utm.lead_events USING gin (lead_name extensions.gin_trgm_ops)
    WITH (fastupdate = off);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_email_trgm
    ON report_utm.lead_events USING gin (lead_email extensions.gin_trgm_ops)
    WITH (fastupdate = off);

-- Parcial: el 78,9 % de los leads no trae teléfono, así que indexar solo los que
-- lo tienen baja el índice de 93.152 filas a ~19.600.
CREATE INDEX IF NOT EXISTS idx_rutm_lead_events_tel_trgm
    ON report_utm.lead_events USING gin (lead_phone extensions.gin_trgm_ops)
    WITH (fastupdate = off)
    WHERE lead_phone IS NOT NULL;

COMMENT ON INDEX report_utm.idx_rutm_lead_events_nombre_trgm IS
    'Buscador de /leads (?q=). Trigramas para ILIKE ''%texto%''. Ver migración 086.';
COMMENT ON INDEX report_utm.idx_rutm_lead_events_email_trgm IS
    'Buscador de /leads (?q=). Trigramas para ILIKE ''%texto%''. Ver migración 086.';
COMMENT ON INDEX report_utm.idx_rutm_lead_events_tel_trgm IS
    'Buscador de /leads (?q=). Parcial: el 78,9 % de los leads no trae teléfono.';

-- ── 3. Estadísticas ──────────────────────────────────────────────
-- Un índice recién creado sin estadísticas frescas puede no usarse: es lo que
-- diagnosticó la 085 (un «Index Only Scan» con 6.754 heap fetches que tardaba
-- 8 s y bajó a 36,7 ms tras un VACUUM). ANALYZE es barato y no bloquea.
ANALYZE report_utm.lead_events;

-- ── 4. Lo que esta migración NO hace ─────────────────────────────
-- No instala `unaccent`. `ILIKE` no pliega tildes, así que buscar «Jose» no
-- encuentra «José». Añadirlo obligaría a índices sobre `unaccent(col)`, que es
-- otra función y otros tres índices — el doble de disco para un caso que se
-- resuelve tecleando un trozo más corto. La limitación está escrita en el
-- placeholder del buscador, no escondida.
