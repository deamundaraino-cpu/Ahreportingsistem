-- ════════════════════════════════════════════════════════════════
-- Migration 068: RLS en InitPlan, policies fusionadas e índices
-- ════════════════════════════════════════════════════════════════
-- Medición que motiva esta migración (pg_stat_user_tables, 2026-08-11):
--
--   clientes → 3.441.223 index scans sobre una tabla de ~40 filas.
--
-- El culpable es la forma en que están escritas las policies de lectura:
--
--   cliente_id IN (SELECT id FROM clientes WHERE user_id = auth.uid())
--
-- `auth.uid()` es STABLE, no IMMUTABLE, así que el planner NO puede sacar la
-- subconsulta del bucle: queda como SubPlan correlacionado y se re-ejecuta una
-- vez POR CADA FILA candidata. Leer 72.000 filas de `ads_daily` dispara 72.000
-- consultas a `clientes`. De ahí los 3,4 millones.
--
-- Envolverlo en `(SELECT auth.uid())` lo convierte en InitPlan: se evalúa UNA
-- vez por consulta y el IN pasa a resolverse contra un hash ya materializado.
-- Es el arreglo que documenta Supabase (lint 0003_auth_rls_initplan) y no
-- cambia el resultado de la policy: mismo valor, evaluado una sola vez.
--
-- La migración tiene cinco bloques independientes:
--   1. Reescritura mecánica de las 52 policies con auth.uid()/auth.jwt().
--   2. Fusión de las policies permisivas duplicadas en las 6 tablas calientes.
--   3. Baja de dos índices sin un solo uso sobre las tablas de más escritura.
--   4. Alta de índices para las FK que se recorren en cascada.
--   5. Autovacuum agresivo para las tablas pequeñas que nunca lo alcanzan.
--
-- IDEMPOTENTE: los cinco bloques se pueden re-aplicar sin efecto. El 1
-- desenvuelve antes de envolver, el 2 borra también las policies nuevas antes
-- de recrearlas, y el 3/4/5 usan IF EXISTS / IF NOT EXISTS / SET.
--
-- REVERSIBLE: los bloques 1 y 2 se revierten volviendo a aplicar las
-- migraciones que crearon cada policy; el 3 recreando los dos índices (su DDL
-- va en el comentario); el 4 con DROP INDEX; el 5 con RESET.
--
-- NO INCLUYE VACUUM: no puede correr dentro de una transacción. Se ejecuta
-- aparte, después de aplicar esta migración (ver el comentario del bloque 5).
-- ════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════
-- 1. auth.uid() / auth.jwt() / is_superadmin() dentro de un InitPlan
-- ════════════════════════════════════════════════════════════════
-- Se hace en bucle y no policy a policy a propósito: son 52 expresiones, y
-- transcribirlas a mano es una invitación a colar una errata en una condición
-- de seguridad. `pg_policies` ya devuelve la expresión normalizada por el
-- propio Postgres, así que la única transformación es textual y acotada.
--
-- El bloque es IDEMPOTENTE: primero desenvuelve lo ya envuelto (Postgres
-- renderiza `(SELECT auth.uid())` como `( SELECT auth.uid() AS uid)`) y
-- después vuelve a envolver todo. Correrlo dos veces da el mismo resultado.
--
-- `is_superadmin()` entra también aunque el linter no lo marque: es una
-- función SQL STABLE que hace un EXISTS sobre user_profiles, así que sin
-- envolver se paga por fila igual que auth.uid().
DO $$
DECLARE
    p        RECORD;
    v_qual   TEXT;
    v_check  TEXT;
    v_fn     TEXT;
    v_sql    TEXT;
    n        INT := 0;
BEGIN
    FOR p IN
        SELECT schemaname, tablename, policyname, qual, with_check
        FROM pg_policies
        WHERE schemaname IN ('public', 'report_utm')
          AND (COALESCE(qual, '') || COALESCE(with_check, ''))
              ~ '(auth\.(uid|jwt)\(\)|is_superadmin\(\))'
        ORDER BY schemaname, tablename, policyname
    LOOP
        v_qual  := p.qual;
        v_check := p.with_check;

        -- Desenvolver (idempotencia) y volver a envolver.
        FOREACH v_fn IN ARRAY ARRAY['uid', 'jwt'] LOOP
            v_qual  := replace(v_qual,  format('( SELECT auth.%s() AS %s)', v_fn, v_fn),
                                        format('auth.%s()', v_fn));
            v_check := replace(v_check, format('( SELECT auth.%s() AS %s)', v_fn, v_fn),
                                        format('auth.%s()', v_fn));
        END LOOP;
        v_qual  := replace(v_qual,  '( SELECT is_superadmin() AS is_superadmin)', 'is_superadmin()');
        v_check := replace(v_check, '( SELECT is_superadmin() AS is_superadmin)', 'is_superadmin()');

        v_qual  := replace(replace(replace(v_qual,
                      'auth.uid()',      '(SELECT auth.uid())'),
                      'auth.jwt()',      '(SELECT auth.jwt())'),
                      'is_superadmin()', '(SELECT is_superadmin())');
        v_check := replace(replace(replace(v_check,
                      'auth.uid()',      '(SELECT auth.uid())'),
                      'auth.jwt()',      '(SELECT auth.jwt())'),
                      'is_superadmin()', '(SELECT is_superadmin())');

        -- USING y WITH CHECK son excluyentes según el comando (SELECT/DELETE no
        -- admiten WITH CHECK, INSERT no admite USING). `pg_policies` ya devuelve
        -- NULL en el que no aplica, así que basta con omitir la cláusula.
        v_sql := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
        IF v_qual  IS NOT NULL THEN v_sql := v_sql || format(' USING (%s)', v_qual);      END IF;
        IF v_check IS NOT NULL THEN v_sql := v_sql || format(' WITH CHECK (%s)', v_check); END IF;

        EXECUTE v_sql;
        n := n + 1;
    END LOOP;

    RAISE NOTICE 'Policies reescritas a InitPlan: %', n;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 2. Policies permisivas duplicadas en las tablas calientes
-- ════════════════════════════════════════════════════════════════
-- Cada una de estas tablas tenía dos policies PERMISSIVE solapadas:
--
--   «Admin full access X»  → FOR ALL     (incluye SELECT)
--   «Clients view own X»   → FOR SELECT
--
-- En un SELECT, Postgres evalúa AMBAS y las une con OR. Es decir: cada lectura
-- de un cliente paga también la comprobación de administrador, y viceversa.
--
-- La forma correcta es escribir ese OR explícitamente en una única policy de
-- SELECT, y dejar la parte de administrador en policies separadas de INSERT /
-- UPDATE / DELETE. No se puede seguir usando FOR ALL para la escritura: FOR ALL
-- vuelve a cubrir SELECT y el solapamiento reaparece.
--
-- El permiso resultante es exactamente el mismo conjunto que antes:
--   SELECT → admin OR cliente-dueño   (el OR que ya hacía Postgres)
--   write  → solo admin               (lo que ya decía la policy FOR ALL)
--
-- Solo se tocan las 6 tablas que domina el dashboard. Las demás mantienen su
-- par de policies: el linter las seguirá marcando, pero se leen poco y cada
-- DROP/CREATE sobre una condición de seguridad es riesgo que no compensa.
DO $$
DECLARE
    t          RECORD;
    v_admin    TEXT;
    v_cliente  TEXT;
BEGIN
    FOR t IN
        SELECT * FROM (VALUES
            -- tabla,                        policy admin vieja,                                policy cliente vieja,                              expresión de admin
            ('metricas_diarias',             'Admins and Traffickers full access metrics',       'Clients view own metrics',
             'EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.id = (SELECT auth.uid()) AND up.role = ANY (ARRAY[''admin''::user_role, ''trafficker''::user_role]))'),
            ('ads_daily',                    'Admin full access ads_daily',                      'Clients view own ads_daily',
             '(SELECT is_superadmin())'),
            ('conversiones_offline',         'Admin full access conversiones_offline',           'Clients view own conversiones_offline',
             '((SELECT auth.jwt()) ->> ''email''::text) = ''robinson@adshouse.com''::text'),
            ('conversiones_offline_diarias', 'Admin full access conversiones_offline_diarias',   'Clients view own conversiones_offline_diarias',
             '((SELECT auth.jwt()) ->> ''email''::text) = ''robinson@adshouse.com''::text'),
            ('sheet_filas',                  'Admin full access sheet_filas',                    'Clients view own sheet_filas',
             '((SELECT auth.jwt()) ->> ''email''::text) = ''robinson@adshouse.com''::text'),
            ('sheet_campo_valores_diarios',  'Admin full access sheet_campo_valores_diarios',    'Clients view own sheet_campo_valores_diarios',
             '((SELECT auth.jwt()) ->> ''email''::text) = ''robinson@adshouse.com''::text')
        ) AS v(tabla, pol_admin, pol_cliente, expr_admin)
    LOOP
        v_admin   := t.expr_admin;
        v_cliente := format(
            'cliente_id IN (SELECT c.id FROM public.clientes c WHERE c.user_id = (SELECT auth.uid()))'
        );

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.pol_admin,   t.tabla);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.pol_cliente, t.tabla);

        -- Y también las nuevas: sin esto, re-aplicar la migración aborta con
        -- «policy "<tabla>_select" already exists». Se recrean idénticas justo
        -- debajo, así que el DROP no deja ninguna ventana sin RLS: todo el
        -- bloque va dentro de la misma transacción del runner.
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tabla || '_select', t.tabla);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tabla || '_insert', t.tabla);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tabla || '_update', t.tabla);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t.tabla || '_delete', t.tabla);

        -- Una sola policy de lectura con el OR ya explícito.
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR SELECT USING (%s OR %s)',
            t.tabla || '_select', t.tabla, v_admin, v_cliente
        );

        -- Escritura: solo administrador, un comando por policy para no volver a
        -- solapar SELECT. La FOR ALL original no tenía WITH CHECK, así que
        -- Postgres usaba su USING como check; se reproduce igual.
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s)',
            t.tabla || '_insert', t.tabla, v_admin
        );
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)',
            t.tabla || '_update', t.tabla, v_admin, v_admin
        );
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR DELETE USING (%s)',
            t.tabla || '_delete', t.tabla, v_admin
        );
    END LOOP;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 3. Índices sin un solo uso sobre las tablas de más escritura
-- ════════════════════════════════════════════════════════════════
-- Ambos llevan `idx_scan = 0` desde que existen, y ambos viven en tablas que
-- reciben cientos de miles de escrituras: cada INSERT paga su mantenimiento
-- para nada. Son 3,7 MB entre los dos.
--
-- Solo se retiran estos: el resto de índices sin uso que reporta el linter
-- pesan ≤ 64 kB y varios pertenecen a features recién desplegadas (hotmart,
-- envíos programados de BI) que todavía no han recibido tráfico real. Cero uso
-- ahí significa "sin estrenar", no "sobra".
--
-- Para revertir:
--   CREATE INDEX idx_ads_daily_campana ON public.ads_daily
--       USING btree (cliente_id, campana_id, fecha DESC) WHERE (campana_id IS NOT NULL);
--   CREATE INDEX idx_conv_offline_tipo ON public.conversiones_offline
--       USING btree (cliente_id, tipo, fecha DESC);
DROP INDEX IF EXISTS public.idx_ads_daily_campana;
DROP INDEX IF EXISTS public.idx_conv_offline_tipo;


-- ════════════════════════════════════════════════════════════════
-- 4. FKs sin índice de cobertura que sí se recorren
-- ════════════════════════════════════════════════════════════════
-- El linter reporta 22 FKs sin índice. La mayoría están sobre tablas vacías o
-- de decenas de filas, donde el índice nunca se usaría —un seq scan de 40 filas
-- es más barato—. Se indexan solo aquellas cuyo padre se borra de verdad, que
-- es cuando la ausencia del índice obliga a un seq scan completo del hijo:
--
--   · clientes → cliente_tabs, notifications, sheet_campo_valores  (borrar un cliente)
--   · sync_jobs → sync_runs                                        (purga del planner)
--   · cliente_tabs → hotmart_ventas                                (borrar una pestaña)
CREATE INDEX IF NOT EXISTS idx_cliente_tabs_cliente
    ON public.cliente_tabs (cliente_id);
CREATE INDEX IF NOT EXISTS idx_notifications_cliente
    ON public.notifications (cliente_id);
CREATE INDEX IF NOT EXISTS idx_sheet_campo_valores_cliente
    ON public.sheet_campo_valores (cliente_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_job
    ON public.sync_runs (job_id);
CREATE INDEX IF NOT EXISTS idx_hotmart_ventas_tab
    ON public.hotmart_ventas (tab_id);


-- ════════════════════════════════════════════════════════════════
-- 5. Autovacuum para las tablas pequeñas que nunca lo alcanzan
-- ════════════════════════════════════════════════════════════════
-- El umbral por defecto es `50 + 0,2 × filas_vivas`. En una tabla de 56 filas
-- eso son ~61 tuplas muertas... pero el contador de filas vivas que usa el
-- cálculo viene del último ANALYZE, y en estas tablas ANALYZE tampoco ha
-- corrido nunca. Resultado medido:
--
--   metricas_diarias → 56 vivas, 650 muertas, autovacuum_count = 0
--   clientes         → n_live_tup = 0 (¡falso!), y la leen 3,4 M de veces
--   cliente_tabs     → 41 vivas, 54 muertas, autovacuum_count = 0
--
-- `clientes` con n_live_tup = 0 es lo más grave: el planner cree que la tabla
-- está vacía y planifica en consecuencia toda consulta que la toque, incluidas
-- las subconsultas de RLS del bloque 1.
--
-- Con scale_factor = 0 el umbral pasa a ser fijo, que es lo que quieren las
-- tablas pequeñas y muy actualizadas.
ALTER TABLE public.metricas_diarias SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 50,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 25
);
ALTER TABLE public.clientes SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 25,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 10
);
ALTER TABLE public.cliente_tabs SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 50,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 25
);
ALTER TABLE public.sheet_campos SET (
    autovacuum_vacuum_scale_factor  = 0.0,
    autovacuum_vacuum_threshold     = 50,
    autovacuum_analyze_scale_factor = 0.0,
    autovacuum_analyze_threshold    = 25
);

-- ── Ejecutar A MANO tras aplicar esta migración ─────────────────
-- VACUUM no corre dentro de una transacción, y el runner de migraciones
-- envuelve el fichero en una. Estas tres líneas son las que limpian el atraso
-- acumulado; a partir de ahí el autovacuum de arriba lo mantiene solo:
--
--   VACUUM (ANALYZE) public.metricas_diarias;
--   VACUUM (ANALYZE) public.clientes;
--   VACUUM (ANALYZE) public.cliente_tabs;
--   ANALYZE public.sheet_campos;
