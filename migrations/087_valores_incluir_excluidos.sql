-- ════════════════════════════════════════════════════════════════
-- Migration 087: que las listas de valores puedan contar los excluidos
-- ════════════════════════════════════════════════════════════════
-- `/leads` ya no pide los valores a mano: los desplegables de UTM, campaña,
-- creativo y formulario se llenan con `bi_valores_conteo`. Pero esa función
-- inyecta SIEMPRE `AND NOT e.excluido` (migración 079):
--
--     v_excluir := CASE WHEN p_tabla = 'lead_events' THEN 'AND NOT e.excluido' ELSE '' END;
--
-- Para el BI eso es correcto —un informe cuenta lo que cuenta—, pero /leads
-- tiene tres pestañas, y en «Excluidos» y «Todos» la lista se vuelve engañosa:
-- ofrece exactamente los valores que NO están en la pestaña que se está mirando.
-- El caso concreto que lo motiva: filtrar los excluidos por su `utm_source` es
-- justo lo que se hace para auditar por qué se excluyeron, y ahí la fuente
-- «(sin source)» no aparecía nunca.
--
-- ── Por qué DROP y no CREATE OR REPLACE ──────────────────────────
-- Postgres identifica una función por su lista de argumentos, así que añadir un
-- parámetro con DEFAULT no reemplaza la de 7: crea una SOBRECARGA. A partir de
-- ahí cualquier llamada con 7 argumentos encaja en las dos y el servidor
-- responde `42725 function is not unique` — o sea, se rompen TODOS los
-- desplegables del BI, que es lo contrario de lo que busca esta migración.
--
-- Por eso hay que borrar la firma exacta de 7 argumentos antes de crear la de 8.
-- `sql-remoto.ts` manda el archivo entero en una sola petición, que la
-- Management API ejecuta como una transacción implícita: no hay un instante con
-- la función borrada y sin recrear.
--
-- ── Compatibilidad ───────────────────────────────────────────────
-- El parámetro nuevo va AL FINAL y con `DEFAULT false`, así que las llamadas
-- que ya existen (`bi-query.ts`, el endpoint público) siguen compilando y
-- devolviendo exactamente lo mismo. Nadie tiene que cambiar nada para seguir
-- igual; solo /leads pasa `true`, y solo en las pestañas que lo necesitan.
--
-- OJO al caché: `runValores` cachea la promesa 60 s con una clave compuesta. Si
-- el parámetro nuevo no entra en esa clave, cambiar de pestaña antes de un
-- minuto sirve la lista de «incluidos» a la pestaña «todos». Va en
-- `claveCache` de `src/lib/report-utm/bi-query.ts`.
--
-- Idempotente: `DROP ... IF EXISTS` + `CREATE OR REPLACE`.
--
-- REVERSIBLE:
--   DROP FUNCTION IF EXISTS report_utm.bi_valores_conteo(
--       UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT, BOOLEAN);
--   -- y volver a aplicar el bloque correspondiente de la migración 079.
-- ════════════════════════════════════════════════════════════════

-- ── 1. Fuera la firma de 7 argumentos ────────────────────────────
DROP FUNCTION IF EXISTS report_utm.bi_valores_conteo(
    UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT);

-- ── 2. La misma función, con un interruptor al final ─────────────
CREATE OR REPLACE FUNCTION report_utm.bi_valores_conteo(
    p_cliente_id         UUID,
    p_tabla              TEXT,
    p_desde              TIMESTAMPTZ,
    p_hasta              TIMESTAMPTZ,
    p_columna            TEXT    DEFAULT NULL,
    p_claves_json        TEXT[]  DEFAULT NULL,
    p_limite             INT     DEFAULT 200,
    p_incluir_excluidos  BOOLEAN DEFAULT false
)
RETURNS TABLE (valor TEXT, n BIGINT, total_distintos BIGINT)
LANGUAGE plpgsql
STABLE
SET search_path = report_utm, public, pg_temp
AS $$
DECLARE
    v_sql     TEXT;
    v_expr    TEXT;
    v_excluir TEXT;
BEGIN
    IF p_tabla NOT IN ('lead_events', 'sales_events') THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_tabla debe ser lead_events o sales_events (recibido: %)', p_tabla;
    END IF;
    IF (p_columna IS NULL) = (p_claves_json IS NULL) THEN
        RAISE EXCEPTION 'bi_valores_conteo: indica p_columna O p_claves_json, no ambos ni ninguno';
    END IF;
    IF p_claves_json IS NOT NULL AND coalesce(array_length(p_claves_json, 1), 0) = 0 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_claves_json no puede ser un array vacío';
    END IF;
    IF p_claves_json IS NOT NULL AND p_tabla <> 'lead_events' THEN
        RAISE EXCEPTION 'bi_valores_conteo: raw_fields solo existe en lead_events (pedido sobre %)', p_tabla;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
        RAISE EXCEPTION 'bi_valores_conteo: p_limite fuera de rango 1..500 (recibido: %)', p_limite;
    END IF;

    IF p_columna IS NOT NULL THEN
        IF p_tabla = 'lead_events' AND p_columna NOT IN (
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
            'utm_id', 'ip_country', 'form_name', 'form_plugin', 'attribution_method', 'source'
        ) THEN
            RAISE EXCEPTION 'bi_valores_conteo: columna % no permitida en lead_events', p_columna;
        END IF;
        IF p_tabla = 'sales_events' AND p_columna NOT IN (
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
            'utm_id', 'platform', 'product_name', 'transaction_type', 'customer_country', 'status'
        ) THEN
            RAISE EXCEPTION 'bi_valores_conteo: columna % no permitida en sales_events', p_columna;
        END IF;
        v_expr := format('e.%I::TEXT', p_columna);
    ELSE
        SELECT string_agg(format('NULLIF(btrim(e.raw_fields->>%L), '''')', k), ', ')
          INTO v_expr
          FROM unnest(p_claves_json) AS k;
        v_expr := format('COALESCE(%s)', v_expr);
    END IF;

    -- 079: `sales_events` no tiene la marca; solo los leads se excluyen. Es un
    -- literal fijo, no una entrada del usuario.
    -- 087: y ahora se puede pedir la lista SIN quitar los excluidos, para las
    -- pestañas de /leads que precisamente los enseñan.
    v_excluir := CASE
        WHEN p_tabla = 'lead_events' AND NOT p_incluir_excluidos THEN 'AND NOT e.excluido'
        ELSE ''
    END;

    v_sql := format($f$
        WITH base AS (
            SELECT %s AS valor
            FROM report_utm.%I e
            WHERE ($1::uuid IS NULL OR e.cliente_id = $1)
              AND e.created_at >= $2
              AND e.created_at <  $3
              %s
        ), grp AS (
            SELECT valor, COUNT(*)::BIGINT AS n
            FROM base
            WHERE valor IS NOT NULL AND btrim(valor) <> ''
            GROUP BY valor
        )
        SELECT valor, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC, valor ASC
        LIMIT $4
    $f$, v_expr, p_tabla, v_excluir);

    RETURN QUERY EXECUTE v_sql
        USING p_cliente_id, p_desde, p_hasta, p_limite;
END;
$$;

-- ── 3. Los permisos no sobreviven al DROP ────────────────────────
GRANT EXECUTE ON FUNCTION report_utm.bi_valores_conteo(
    UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT, BOOLEAN)
    TO authenticated, service_role;

COMMENT ON FUNCTION report_utm.bi_valores_conteo(
    UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], INT, BOOLEAN) IS
    'Valores distintos con su recuento. p_incluir_excluidos=true para las pestañas de /leads que enseñan los excluidos. Ver migración 087.';

-- ── 4. Que PostgREST se entere ───────────────────────────────────
-- Sin esto el schema cache sigue anunciando la firma vieja y las llamadas con
-- el parámetro nuevo dan PGRST202 hasta el siguiente reinicio.
NOTIFY pgrst, 'reload schema';
