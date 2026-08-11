-- ════════════════════════════════════════════════════════════════
-- Migration 069: el sync de Sheets deja de reescribir el sheet entero
-- ════════════════════════════════════════════════════════════════
-- Medición que motiva esta migración (pg_stat_user_tables, 2026-08-11):
--
--   tabla                  INSERT acumulados   DELETE acumulados   filas vivas
--   ─────────────────────  ─────────────────   ─────────────────   ───────────
--   sheet_filas                    1.523.961           1.565.312        25.863
--   conversiones_offline           1.576.304           1.595.841        25.863
--
-- Unas 37 reescrituras completas por cada fila que sobrevive. La causa es el
-- ciclo de reemplazo: cada sync inserta el sheet ENTERO con un `sync_batch_id`
-- nuevo y después borra el lote anterior. Aunque el Sheet no haya cambiado una
-- coma, se pagan 25.000 INSERT y 25.000 DELETE.
--
-- El coste medido en pg_stat_statements:
--   INSERT sheet_filas            3.130 llamadas   646 s   (206 ms cada una)
--   INSERT conversiones_offline   3.238 llamadas   498 s   (154 ms)
--   DELETE sheet_filas              165 llamadas   236 s   (1.428 ms)
--   DELETE conversiones_offline     169 llamadas   166 s   (984 ms)
--   SELECT del bucle de consolidación 637 llamadas 249 s
--                                                 ────────
--                                                 ~1.800 s de CPU
--
-- Y el bloat que arrastra: 71 MB de heap en `sheet_filas` para 25.863 filas, con
-- 133 pasadas de autovacuum sólo para mantenerlo a raya.
--
-- ── Lo que cambia ───────────────────────────────────────────────
-- Se le da a las dos tablas la clave natural que siempre tuvieron implícita:
--
--   (cliente_id, sheet_id, tab_name, fila_num)
--
-- Con ella, el sync pasa a ser un UPSERT que además compara un hash del
-- contenido: si la fila no cambió, `DO UPDATE ... WHERE hash IS DISTINCT FROM`
-- no escribe NADA. Un sheet que no se ha tocado deja de generar escrituras.
--
-- Y el borrado deja de ser "todo lo que no lleve el lote de hoy" para pasar a
-- ser "las filas de esta pestaña cuyo número ya no existe en el Sheet", que es
-- lo que de verdad se quería expresar.
--
-- ── ⚠ ESTA MIGRACIÓN NO SE PUEDE APLICAR SOLA ───────────────────
-- El índice único es incompatible con el código de sync ACTUAL: mientras el
-- lote viejo y el nuevo conviven en la tabla, los dos tienen las mismas
-- (tab_name, fila_num) y el INSERT del lote nuevo chocaría con un duplicate key.
--
-- Aplicar SOLO junto al despliegue de google-sheets-conversiones.ts. En orden:
--   1. desplegar el código nuevo (usa las RPC de abajo; si no existen, falla)
--   2. aplicar esta migración
-- No: primero la migración y luego el código.
--
-- REVERSIBLE:
--   DROP FUNCTION public.sheet_filas_upsert_lote(uuid, text, uuid, jsonb);
--   DROP FUNCTION public.sheet_filas_podar_tab(uuid, text, text, int[]);
--   DROP FUNCTION public.conversiones_offline_upsert_lote(uuid, text, uuid, jsonb);
--   DROP FUNCTION public.conversiones_offline_podar_tab(uuid, text, text, int[]);
--   DROP FUNCTION public.sheet_podar_tabs(uuid, text, text[]);
--   DROP INDEX public.uq_sheet_filas_fila, public.uq_conv_offline_fila;
--   ALTER TABLE public.conversiones_offline DROP COLUMN fila_num;
--   ALTER TABLE public.sheet_filas DROP COLUMN contenido_hash;
--   ALTER TABLE public.conversiones_offline DROP COLUMN contenido_hash;
-- ════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════
-- 1. Clave natural y hash de contenido
-- ════════════════════════════════════════════════════════════════
-- `sheet_filas` ya guardaba `fila_num`; `conversiones_offline` no, porque hasta
-- ahora no lo necesitaba. Las dos salen del MISMO bucle del parser sobre la
-- misma fila del Sheet, así que el número de fila identifica a ambas.
ALTER TABLE public.conversiones_offline ADD COLUMN IF NOT EXISTS fila_num INTEGER;

-- El hash lo calcula la base, no Node: así no hay forma de que las dos partes
-- discrepen en el formato del número o en el orden de las claves del JSON.
ALTER TABLE public.sheet_filas          ADD COLUMN IF NOT EXISTS contenido_hash TEXT;
ALTER TABLE public.conversiones_offline ADD COLUMN IF NOT EXISTS contenido_hash TEXT;

-- Índices PARCIALES: las filas heredadas de `conversiones_offline` tienen
-- `fila_num` NULL y quedan fuera del único. No estorban —el primer sync las
-- retira, porque su clave no está en el Sheet— pero mientras tanto no impiden
-- crear el índice.
--
-- Verificado antes de crearlos: sheet_filas tiene 25.863 filas y 25.863 claves
-- distintas, así que el único entra sin conflictos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sheet_filas_fila
    ON public.sheet_filas (cliente_id, sheet_id, tab_name, fila_num)
    WHERE fila_num IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_offline_fila
    ON public.conversiones_offline (cliente_id, sheet_id, tab_name, fila_num)
    WHERE fila_num IS NOT NULL;


-- ════════════════════════════════════════════════════════════════
-- 2. Upsert de un tramo de filas crudas
-- ════════════════════════════════════════════════════════════════
-- Una sola sentencia por tramo, con el diff resuelto por Postgres:
--   · clave nueva          → INSERT
--   · clave con otro hash  → UPDATE
--   · clave con mismo hash → el WHERE del DO UPDATE la descarta: CERO escritura,
--                            y el JSONB grande ni se vuelve a comprimir ni se
--                            vuelve a escribir en el TOAST.
--
-- Devuelve cuántas filas se escribieron de verdad, que es la métrica que
-- interesa vigilar: en régimen estable debería tender a cero.
CREATE OR REPLACE FUNCTION public.sheet_filas_upsert_lote(
    p_cliente_id UUID,
    p_sheet_id   TEXT,
    p_batch      UUID,
    p_filas      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    n INTEGER;
BEGIN
    INSERT INTO public.sheet_filas
        (cliente_id, sheet_id, tab_name, fecha, fila_num, valores, contenido_hash, sync_batch_id)
    SELECT
        p_cliente_id, p_sheet_id, f.tab_name, f.fecha, f.fila_num, f.valores,
        md5(f.fecha::text || '|' || f.valores::text),
        p_batch
    FROM jsonb_to_recordset(p_filas)
         AS f(tab_name TEXT, fecha DATE, fila_num INTEGER, valores JSONB)
    ON CONFLICT (cliente_id, sheet_id, tab_name, fila_num) WHERE fila_num IS NOT NULL
    DO UPDATE SET
        fecha          = EXCLUDED.fecha,
        valores        = EXCLUDED.valores,
        contenido_hash = EXCLUDED.contenido_hash,
        sync_batch_id  = EXCLUDED.sync_batch_id
    WHERE public.sheet_filas.contenido_hash IS DISTINCT FROM EXCLUDED.contenido_hash;

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 3. Upsert de un tramo de conversiones
-- ════════════════════════════════════════════════════════════════
-- Mismo patrón. El hash cubre todos los campos que el parser deriva de la fila:
-- si cambia cualquiera, la fila se reescribe; si no, no se toca.
--
-- `valor` es NUMERIC y admite NULL, así que va por COALESCE a un centinela que
-- no puede confundirse con un importe real ('~'): sin él, un NULL anularía el
-- concat entero y dos filas distintas compartirían hash NULL.
CREATE OR REPLACE FUNCTION public.conversiones_offline_upsert_lote(
    p_cliente_id UUID,
    p_sheet_id   TEXT,
    p_batch      UUID,
    p_filas      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    n INTEGER;
BEGIN
    INSERT INTO public.conversiones_offline
        (cliente_id, sheet_id, tab_name, fila_num, fecha, tipo, cantidad, valor,
         fuente, notas, custom_fields, contenido_hash, sync_batch_id)
    SELECT
        p_cliente_id, p_sheet_id, f.tab_name, f.fila_num, f.fecha, f.tipo,
        f.cantidad, f.valor, f.fuente, f.notas, f.custom_fields,
        md5(concat_ws('|',
            f.fecha::text, f.tipo, f.cantidad::text,
            COALESCE(f.valor::text, '~'),
            COALESCE(f.fuente, '~'), COALESCE(f.notas, '~'),
            f.custom_fields::text)),
        p_batch
    FROM jsonb_to_recordset(p_filas)
         AS f(tab_name TEXT, fila_num INTEGER, fecha DATE, tipo TEXT,
              cantidad INTEGER, valor NUMERIC, fuente TEXT, notas TEXT,
              custom_fields JSONB)
    ON CONFLICT (cliente_id, sheet_id, tab_name, fila_num) WHERE fila_num IS NOT NULL
    DO UPDATE SET
        fecha          = EXCLUDED.fecha,
        tipo           = EXCLUDED.tipo,
        cantidad       = EXCLUDED.cantidad,
        valor          = EXCLUDED.valor,
        fuente         = EXCLUDED.fuente,
        notas          = EXCLUDED.notas,
        custom_fields  = EXCLUDED.custom_fields,
        contenido_hash = EXCLUDED.contenido_hash,
        sync_batch_id  = EXCLUDED.sync_batch_id
    WHERE public.conversiones_offline.contenido_hash IS DISTINCT FROM EXCLUDED.contenido_hash;

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 4. Poda: las filas de la pestaña que ya no existen en el Sheet
-- ════════════════════════════════════════════════════════════════
-- Sustituye a `borrarLotesAnteriores` para estas dos tablas. La diferencia es de
-- fondo, no de forma:
--
--   antes  → «borra todo lo que no lleve el lote de hoy»  (todo el sheet)
--   ahora  → «borra las filas cuyo número ya no está»     (sólo lo que sobra)
--
-- `p_vivas` son los `fila_num` que el parser acaba de producir para ESA pestaña.
-- El llamador sólo debe podar pestañas que haya leído entera: podar una pestaña
-- que falló a mitad borraría datos buenos.
--
-- `fila_num IS NULL` entra en la poda a propósito: son las filas heredadas de
-- antes de esta migración, y el Sheet ya no las respalda.
CREATE OR REPLACE FUNCTION public.sheet_filas_podar_tab(
    p_cliente_id UUID,
    p_sheet_id   TEXT,
    p_tab_name   TEXT,
    p_vivas      INTEGER[]
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    n INTEGER;
BEGIN
    DELETE FROM public.sheet_filas
    WHERE cliente_id = p_cliente_id
      AND sheet_id   = p_sheet_id
      AND tab_name   = p_tab_name
      AND (fila_num IS NULL OR NOT (fila_num = ANY (p_vivas)));

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.conversiones_offline_podar_tab(
    p_cliente_id UUID,
    p_sheet_id   TEXT,
    p_tab_name   TEXT,
    p_vivas      INTEGER[]
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    n INTEGER;
BEGIN
    DELETE FROM public.conversiones_offline
    WHERE cliente_id = p_cliente_id
      AND sheet_id   = p_sheet_id
      AND tab_name   = p_tab_name
      AND (fila_num IS NULL OR NOT (fila_num = ANY (p_vivas)));

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 5. Poda de pestañas que ya no están en la configuración
-- ════════════════════════════════════════════════════════════════
-- La poda por pestaña del punto 4 no puede limpiar una pestaña que ya nadie
-- sincroniza —nunca se la llama con ese `tab_name`—. Antes lo resolvía el
-- borrado del lote entero del sheet.
--
-- La lista viene de la CONFIGURACIÓN, no del resultado del sync: así una
-- pestaña que existe pero falló al leerse conserva sus datos, mientras que una
-- retirada o deshabilitada se limpia. Es el mismo criterio que aplicaba el
-- reemplazo por lotes.
--
-- Si `p_tabs` llega vacío no se borra nada: un array vacío casi siempre
-- significa "no pude leer la config", y en ese caso vaciar el sheet entero es
-- exactamente lo que no se quiere.
CREATE OR REPLACE FUNCTION public.sheet_podar_tabs(
    p_cliente_id UUID,
    p_sheet_id   TEXT,
    p_tabs       TEXT[]
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    n1 INTEGER := 0;
    n2 INTEGER := 0;
BEGIN
    IF p_tabs IS NULL OR array_length(p_tabs, 1) IS NULL THEN
        RETURN 0;
    END IF;

    DELETE FROM public.sheet_filas
    WHERE cliente_id = p_cliente_id AND sheet_id = p_sheet_id
      AND NOT (tab_name = ANY (p_tabs));
    GET DIAGNOSTICS n1 = ROW_COUNT;

    DELETE FROM public.conversiones_offline
    WHERE cliente_id = p_cliente_id AND sheet_id = p_sheet_id
      AND (tab_name IS NULL OR NOT (tab_name = ANY (p_tabs)));
    GET DIAGNOSTICS n2 = ROW_COUNT;

    RETURN n1 + n2;
END $$;


-- ════════════════════════════════════════════════════════════════
-- 6. Permisos
-- ════════════════════════════════════════════════════════════════
-- Sólo `service_role`: son el camino de escritura del sync, que corre en los
-- workers con la clave de servicio. Ningún usuario del navegador debe poder
-- llamarlas.
REVOKE ALL ON FUNCTION public.sheet_filas_upsert_lote(UUID, TEXT, UUID, JSONB)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conversiones_offline_upsert_lote(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sheet_filas_podar_tab(UUID, TEXT, TEXT, INTEGER[])          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.conversiones_offline_podar_tab(UUID, TEXT, TEXT, INTEGER[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sheet_podar_tabs(UUID, TEXT, TEXT[])                        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.sheet_filas_upsert_lote(UUID, TEXT, UUID, JSONB)          TO service_role;
GRANT EXECUTE ON FUNCTION public.conversiones_offline_upsert_lote(UUID, TEXT, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.sheet_filas_podar_tab(UUID, TEXT, TEXT, INTEGER[])          TO service_role;
GRANT EXECUTE ON FUNCTION public.conversiones_offline_podar_tab(UUID, TEXT, TEXT, INTEGER[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.sheet_podar_tabs(UUID, TEXT, TEXT[])                        TO service_role;


-- ════════════════════════════════════════════════════════════════
-- 7. Autovacuum: se puede relajar
-- ════════════════════════════════════════════════════════════════
-- Con 1,5 millones de tuplas muertas por tabla, estas dos necesitaban
-- autovacuum casi continuo (133 y 93 pasadas). Al desaparecer la reescritura
-- completa, el volumen de muertas cae a lo que cambie de verdad en los Sheets,
-- y los valores por defecto vuelven a ser suficientes.
--
-- No se tocan aquí: conviene medir una semana con el sync nuevo antes de
-- aflojar nada. Se deja anotado para no olvidarlo.
