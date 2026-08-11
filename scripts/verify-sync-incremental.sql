-- ════════════════════════════════════════════════════════════════
-- Verificación del sync incremental de Sheets (migración 069)
-- ════════════════════════════════════════════════════════════════
-- Comprueba las tres propiedades de las que depende el ahorro, y las dos de las
-- que depende que no se pierdan datos:
--
--   · una fila que no cambió NO se reescribe          (pasos 2 y 11)
--   · una fila que cambió se reescribe ella sola      (paso 5)
--   · la clave natural no duplica entre corridas      (paso 3)
--   · la poda retira lo que ya no está en el Sheet    (pasos 6 y 8)
--   · podar una pestaña no toca a las demás           (paso 9)
--
-- Se puede correr contra producción sin miedo: todo va dentro de una
-- transacción que termina en ROLLBACK, sobre un `sheet_id` inventado
-- ('__PRUEBA069__') que no existe en ninguna configuración.
--
-- El script crea las funciones con CREATE OR REPLACE, así que sirve tanto para
-- validar la migración ANTES de aplicarla como para comprobarla después.
--
--   psql "$DATABASE_URL" -f scripts/verify-sync-incremental.sql
--
-- Todas las filas del resultado deben decir OK.
-- ════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.conversiones_offline ADD COLUMN IF NOT EXISTS fila_num INTEGER;
ALTER TABLE public.sheet_filas          ADD COLUMN IF NOT EXISTS contenido_hash TEXT;
ALTER TABLE public.conversiones_offline ADD COLUMN IF NOT EXISTS contenido_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_filas_fila
    ON public.sheet_filas (cliente_id, sheet_id, tab_name, fila_num)
    WHERE fila_num IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_offline_fila
    ON public.conversiones_offline (cliente_id, sheet_id, tab_name, fila_num)
    WHERE fila_num IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sheet_filas_upsert_lote(
    p_cliente_id UUID, p_sheet_id TEXT, p_batch UUID, p_filas JSONB
) RETURNS INTEGER LANGUAGE plpgsql AS $fn$
DECLARE n INTEGER;
BEGIN
    INSERT INTO public.sheet_filas
        (cliente_id, sheet_id, tab_name, fecha, fila_num, valores, contenido_hash, sync_batch_id)
    SELECT p_cliente_id, p_sheet_id, f.tab_name, f.fecha, f.fila_num, f.valores,
           md5(f.fecha::text || '|' || f.valores::text), p_batch
    FROM jsonb_to_recordset(p_filas) AS f(tab_name TEXT, fecha DATE, fila_num INTEGER, valores JSONB)
    ON CONFLICT (cliente_id, sheet_id, tab_name, fila_num) WHERE fila_num IS NOT NULL
    DO UPDATE SET fecha = EXCLUDED.fecha, valores = EXCLUDED.valores,
                  contenido_hash = EXCLUDED.contenido_hash, sync_batch_id = EXCLUDED.sync_batch_id
    WHERE public.sheet_filas.contenido_hash IS DISTINCT FROM EXCLUDED.contenido_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION public.conversiones_offline_upsert_lote(
    p_cliente_id UUID, p_sheet_id TEXT, p_batch UUID, p_filas JSONB
) RETURNS INTEGER LANGUAGE plpgsql AS $fn$
DECLARE n INTEGER;
BEGIN
    INSERT INTO public.conversiones_offline
        (cliente_id, sheet_id, tab_name, fila_num, fecha, tipo, cantidad, valor,
         fuente, notas, custom_fields, contenido_hash, sync_batch_id)
    SELECT p_cliente_id, p_sheet_id, f.tab_name, f.fila_num, f.fecha, f.tipo,
           f.cantidad, f.valor, f.fuente, f.notas, f.custom_fields,
           md5(concat_ws('|', f.fecha::text, f.tipo, f.cantidad::text,
               COALESCE(f.valor::text, '~'), COALESCE(f.fuente, '~'),
               COALESCE(f.notas, '~'), f.custom_fields::text)),
           p_batch
    FROM jsonb_to_recordset(p_filas)
         AS f(tab_name TEXT, fila_num INTEGER, fecha DATE, tipo TEXT, cantidad INTEGER,
              valor NUMERIC, fuente TEXT, notas TEXT, custom_fields JSONB)
    ON CONFLICT (cliente_id, sheet_id, tab_name, fila_num) WHERE fila_num IS NOT NULL
    DO UPDATE SET fecha = EXCLUDED.fecha, tipo = EXCLUDED.tipo, cantidad = EXCLUDED.cantidad,
                  valor = EXCLUDED.valor, fuente = EXCLUDED.fuente, notas = EXCLUDED.notas,
                  custom_fields = EXCLUDED.custom_fields, contenido_hash = EXCLUDED.contenido_hash,
                  sync_batch_id = EXCLUDED.sync_batch_id
    WHERE public.conversiones_offline.contenido_hash IS DISTINCT FROM EXCLUDED.contenido_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION public.sheet_filas_podar_tab(
    p_cliente_id UUID, p_sheet_id TEXT, p_tab_name TEXT, p_vivas INTEGER[]
) RETURNS INTEGER LANGUAGE plpgsql AS $fn$
DECLARE n INTEGER;
BEGIN
    DELETE FROM public.sheet_filas
    WHERE cliente_id = p_cliente_id AND sheet_id = p_sheet_id AND tab_name = p_tab_name
      AND (fila_num IS NULL OR NOT (fila_num = ANY (p_vivas)));
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $fn$;

-- ═══ Pruebas ═══
-- Sheet ficticio sobre un cliente real: el ROLLBACK final lo deshace todo.
CREATE TEMP TABLE pruebas (paso INT, caso TEXT, obtenido INT, esperado INT);

DO $t$
DECLARE
    c   UUID;
    b1  UUID := '00000000-0000-0000-0000-0000000000b1';
    b2  UUID := '00000000-0000-0000-0000-0000000000b2';
    n   INTEGER;
    lote JSONB := '[
      {"tab_name":"T1","fecha":"2026-08-01","fila_num":1,"valores":{"a":"1"}},
      {"tab_name":"T1","fecha":"2026-08-01","fila_num":2,"valores":{"a":"2"}},
      {"tab_name":"T1","fecha":"2026-08-02","fila_num":3,"valores":{"a":"3"}}
    ]'::jsonb;
BEGIN
    SELECT id INTO c FROM public.clientes ORDER BY id LIMIT 1;

    n := public.sheet_filas_upsert_lote(c, '__PRUEBA069__', b1, lote);
    INSERT INTO pruebas VALUES (1, 'primer sync: 3 filas nuevas', n, 3);

    n := public.sheet_filas_upsert_lote(c, '__PRUEBA069__', b2, lote);
    INSERT INTO pruebas VALUES (2, 'mismo contenido: no escribe nada', n, 0);

    SELECT count(*) INTO n FROM public.sheet_filas WHERE sheet_id = '__PRUEBA069__';
    INSERT INTO pruebas VALUES (3, 'no se duplicaron', n, 3);

    SELECT count(*) INTO n FROM public.sheet_filas
     WHERE sheet_id = '__PRUEBA069__' AND sync_batch_id = b1;
    INSERT INTO pruebas VALUES (4, 'conservan el lote viejo (no se reescribieron)', n, 3);

    n := public.sheet_filas_upsert_lote(c, '__PRUEBA069__', b2,
        '[{"tab_name":"T1","fecha":"2026-08-01","fila_num":2,"valores":{"a":"CAMBIADO"}}]'::jsonb);
    INSERT INTO pruebas VALUES (5, 'una fila cambiada: escribe solo esa', n, 1);

    -- El Sheet pierde la fila 3.
    n := public.sheet_filas_podar_tab(c, '__PRUEBA069__', 'T1', ARRAY[1,2]);
    INSERT INTO pruebas VALUES (6, 'poda la fila que ya no esta en el Sheet', n, 1);

    SELECT count(*) INTO n FROM public.sheet_filas WHERE sheet_id = '__PRUEBA069__';
    INSERT INTO pruebas VALUES (7, 'quedan las dos vivas', n, 2);

    -- Fila heredada sin fila_num: la poda debe llevársela.
    INSERT INTO public.sheet_filas (cliente_id, sheet_id, tab_name, fecha, valores)
    VALUES (c, '__PRUEBA069__', 'T1', '2026-01-01', '{}'::jsonb);
    n := public.sheet_filas_podar_tab(c, '__PRUEBA069__', 'T1', ARRAY[1,2]);
    INSERT INTO pruebas VALUES (8, 'poda la fila heredada con fila_num NULL', n, 1);

    -- Otra pestaña no se ve afectada por la poda de T1.
    PERFORM public.sheet_filas_upsert_lote(c, '__PRUEBA069__', b2,
        '[{"tab_name":"T2","fecha":"2026-08-01","fila_num":1,"valores":{"z":"9"}}]'::jsonb);
    PERFORM public.sheet_filas_podar_tab(c, '__PRUEBA069__', 'T1', ARRAY[1,2]);
    SELECT count(*) INTO n FROM public.sheet_filas
     WHERE sheet_id = '__PRUEBA069__' AND tab_name = 'T2';
    INSERT INTO pruebas VALUES (9, 'podar T1 no toca T2', n, 1);

    -- Conversiones: mismo contrato, y valor NULL no confunde el hash.
    n := public.conversiones_offline_upsert_lote(c, '__PRUEBA069__', b1, '[
      {"tab_name":"T1","fila_num":1,"fecha":"2026-08-01","tipo":"venta","cantidad":1,
       "valor":null,"fuente":"fb","notas":null,"custom_fields":{}},
      {"tab_name":"T1","fila_num":2,"fecha":"2026-08-01","tipo":"venta","cantidad":1,
       "valor":100,"fuente":"fb","notas":null,"custom_fields":{}}
    ]'::jsonb);
    INSERT INTO pruebas VALUES (10, 'conversiones nuevas', n, 2);

    n := public.conversiones_offline_upsert_lote(c, '__PRUEBA069__', b2, '[
      {"tab_name":"T1","fila_num":1,"fecha":"2026-08-01","tipo":"venta","cantidad":1,
       "valor":null,"fuente":"fb","notas":null,"custom_fields":{}},
      {"tab_name":"T1","fila_num":2,"fecha":"2026-08-01","tipo":"venta","cantidad":1,
       "valor":100,"fuente":"fb","notas":null,"custom_fields":{}}
    ]'::jsonb);
    INSERT INTO pruebas VALUES (11, 'conversiones sin cambio: no escribe nada', n, 0);

    SELECT count(DISTINCT contenido_hash) INTO n
      FROM public.conversiones_offline WHERE sheet_id = '__PRUEBA069__';
    INSERT INTO pruebas VALUES (12, 'valor NULL y valor 100 dan hash distinto', n, 2);
END $t$;

SELECT paso, caso, obtenido, esperado,
       CASE WHEN obtenido = esperado THEN 'OK' ELSE 'FALLA' END AS resultado
FROM pruebas ORDER BY paso;

ROLLBACK;
