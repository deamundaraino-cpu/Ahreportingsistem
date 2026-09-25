-- ════════════════════════════════════════════════════════════════
-- Migration 089: ventas de Hotmart — atribución y guarda de orden por estado
-- ════════════════════════════════════════════════════════════════
-- Auditoría del 2026-09-25. Tres problemas con la misma raíz, la guarda de
-- `guardar_hotmart_venta` (065): `WHERE EXCLUDED.evento_ts >= hv.evento_ts`
-- descartaba el evento viejo ENTERO.
--
--   1. Comisiones perdidas. La API usa `approved_date` como `evento_ts`, que
--      siempre es anterior al `creation_date` del webhook. Si el webhook llegaba
--      primero, la escritura de la API se tiraba completa y con ella las
--      comisiones: `neto_productor_usd` quedaba NULL para siempre y se sumaba
--      como 0 en la facturación.
--   2. Reembolsos que vuelven a la vida. La reconciliación ponía
--      `evento_ts = approved_date`, o sea, lo movía HACIA ATRÁS; un reintento
--      tardío del PURCHASE_APPROVED pasaba entonces la guarda y devolvía la
--      venta a «aprobada».
--   3. Estados que retroceden. Un PURCHASE_PROTEST (o cualquier evento que
--      acabe en «pendiente») bajaba una venta ya cobrada a pendiente.
--
-- ── Qué cambia ───────────────────────────────────────────────────
-- La guarda ya no decide «todo o nada». Separa dos cosas:
--
--   • EL ESTADO (estado, fecha_venta, origen, evento_ts) solo se mueve si el
--     evento es más reciente, o si la API/reconciliación trae un estado MÁS
--     AVANZADO (pendiente < cancelada/expirada < aprobada < completa <
--     reembolsada/chargeback). Un estado cobrado nunca vuelve a «pendiente».
--     Cuando el avance lo trae la API, `evento_ts` sube a now(): así ningún
--     reintento viejo puede deshacerlo.
--   • EL RESTO DE COLUMNAS solo se RELLENA: un evento más viejo completa lo que
--     falta (comisiones, comprador…) y nunca pisa lo que ya hay.
--
-- Y añade la ATRIBUCIÓN. Hasta hoy las 88 ventas guardadas llegaron por la API,
-- ninguna con UTM, porque el webhook nunca se configuró. Las columnas nuevas
-- dicen DE DÓNDE sale la tupla UTM de cada venta:
--
--   tracking       la trajo Hotmart (webhook, o `sck`/`src` con un ID de anuncio)
--   lead_email     heredada del último lead del mismo email antes de la compra
--   lead_telefono  ídem por teléfono
--   padre          un bump/upsell que hereda la de su compra principal
--
-- La tupla se trata como BLOQUE: nunca se mezcla la campaña de un origen con el
-- anuncio de otro. El tracking siempre gana; un lead nunca pisa un tracking.
--
-- ── Compatibilidad ───────────────────────────────────────────────
-- La firma de `guardar_hotmart_venta(jsonb) RETURNS TABLE(id, escrita)` NO
-- cambia, así que CREATE OR REPLACE basta y ningún llamante se rompe. El código
-- ya envía las claves nuevas (`atribucion_*`, `estado_crudo`) antes de que esta
-- migración exista: la función vieja las ignora. `columnas089Disponibles()`
-- (src/lib/hotmart/esquema.ts) sondea si está aplicada.
--
-- `escrita` conserva su significado: «el evento se aplicó como el más
-- reciente». Una escritura que solo rellenó huecos devuelve false, y así el
-- webhook no reenvía notificaciones por ella.
--
-- CREATE OR REPLACE borra el `SET search_path` que la 075 puso con ALTER
-- FUNCTION: se vuelve a declarar aquí en las dos funciones reemplazadas.
--
-- NO crea índices: la base está cerca de su límite y el cruce con leads va
-- acotado por (cliente_id, created_at), que ya cubre idx_rutm_lead_events_cliente.
--
-- Se prueba ANTES de aplicarla con scripts/verify-hotmart-089.sql (todo dentro
-- de una transacción que termina en ROLLBACK).
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1) Columnas nuevas
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.hotmart_ventas
    ADD COLUMN IF NOT EXISTS atribucion_metodo  TEXT,
    ADD COLUMN IF NOT EXISTS atribucion_lead_id UUID,
    ADD COLUMN IF NOT EXISTS atribucion_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notificado_estado  TEXT,
    ADD COLUMN IF NOT EXISTS estado_crudo       TEXT;

DO $$
BEGIN
    ALTER TABLE public.hotmart_ventas
        ADD CONSTRAINT hotmart_ventas_atribucion_metodo_check
        CHECK (atribucion_metodo IN ('tracking', 'lead_email', 'lead_telefono', 'padre'));
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

COMMENT ON COLUMN public.hotmart_ventas.atribucion_metodo IS
    'De dónde sale la tupla UTM: tracking (Hotmart) | lead_email | lead_telefono (heredada del lead) | padre (bump/upsell que hereda de su principal). NULL = sin atribuir. El tracking siempre gana.';
COMMENT ON COLUMN public.hotmart_ventas.atribucion_lead_id IS
    'lead_events.id del que se heredó la tupla UTM. Sin FK: vive en otro esquema (report_utm) y el lead puede purgarse sin que la venta pierda su campaña.';
COMMENT ON COLUMN public.hotmart_ventas.notificado_estado IS
    'Último estado por el que ya se envió notificación y webhook de salida. Se reclama con un UPDATE condicional: dos reintentos del mismo evento no notifican dos veces.';
COMMENT ON COLUMN public.hotmart_ventas.estado_crudo IS
    'Status tal como lo manda Hotmart (APPROVED, PARTIALLY_REFUNDED, PROTESTED…). `estado` es la traducción; esto permite auditar la traducción.';

-- ────────────────────────────────────────────────────────────────
-- 2) guardar_hotmart_venta: guarda por estado + relleno + atribución
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guardar_hotmart_venta(p_fila JSONB)
RETURNS TABLE (id UUID, escrita BOOLEAN)
LANGUAGE plpgsql
SET search_path = public, report_utm, pg_temp
AS $$
DECLARE
    v_cliente     UUID        := (p_fila->>'cliente_id')::uuid;
    v_tx          TEXT        := p_fila->>'transaction_id';
    v_estado      TEXT        := p_fila->>'estado';
    v_ts          TIMESTAMPTZ := (p_fila->>'evento_ts')::timestamptz;
    v_origen      TEXT        := COALESCE(p_fila->>'origen', 'webhook');
    v_metodo      TEXT        := p_fila->>'atribucion_metodo';
    v_id          UUID;
    v_old         public.hotmart_ventas%ROWTYPE;
    v_mas_nuevo   BOOLEAN;
    v_regresa     BOOLEAN;
    v_avance      BOOLEAN;
    v_aplica      BOOLEAN;
    v_tupla       BOOLEAN;   -- true: tupla nueva · false: la vieja · NULL: por columna
    v_estado_fin  TEXT;
BEGIN
    INSERT INTO public.hotmart_ventas (
        cliente_id, transaction_id, parent_transaction_id,
        fecha_venta, aprobada_at, orden_at,
        estado, evento_ts, reembolsada_at,
        tipo, clasificacion_origen, tab_id,
        producto_id, producto_nombre, oferta_codigo, es_order_bump,
        moneda, bruto, bruto_usd,
        neto_productor_usd, neto_afiliado_usd, neto_coproductor_usd,
        usd_rate, pago_tipo, pago_cuotas,
        comprador_email, comprador_nombre, comprador_telefono,
        comprador_doc, comprador_pais, checkout_pais,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id,
        click_id, src, sck, xcod,
        raw_payload, origen, sales_event_id,
        atribucion_metodo, atribucion_lead_id, atribucion_at, estado_crudo
    )
    SELECT
        v_cliente,
        v_tx,
        p_fila->>'parent_transaction_id',
        (p_fila->>'fecha_venta')::date,
        (p_fila->>'aprobada_at')::timestamptz,
        (p_fila->>'orden_at')::timestamptz,
        v_estado,
        v_ts,
        (p_fila->>'reembolsada_at')::timestamptz,
        COALESCE(p_fila->>'tipo', 'sin_clasificar'),
        COALESCE(p_fila->>'clasificacion_origen', 'sin_clasificar'),
        (p_fila->>'tab_id')::uuid,
        p_fila->>'producto_id',
        p_fila->>'producto_nombre',
        p_fila->>'oferta_codigo',
        COALESCE((p_fila->>'es_order_bump')::boolean, false),
        p_fila->>'moneda',
        COALESCE((p_fila->>'bruto')::numeric, 0),
        (p_fila->>'bruto_usd')::numeric,
        (p_fila->>'neto_productor_usd')::numeric,
        (p_fila->>'neto_afiliado_usd')::numeric,
        (p_fila->>'neto_coproductor_usd')::numeric,
        (p_fila->>'usd_rate')::numeric,
        p_fila->>'pago_tipo',
        (p_fila->>'pago_cuotas')::smallint,
        p_fila->>'comprador_email',
        p_fila->>'comprador_nombre',
        p_fila->>'comprador_telefono',
        p_fila->>'comprador_doc',
        p_fila->>'comprador_pais',
        p_fila->>'checkout_pais',
        p_fila->>'utm_source',
        p_fila->>'utm_medium',
        p_fila->>'utm_campaign',
        p_fila->>'utm_content',
        p_fila->>'utm_term',
        p_fila->>'utm_id',
        p_fila->>'click_id',
        p_fila->>'src',
        p_fila->>'sck',
        p_fila->>'xcod',
        p_fila->'raw_payload',
        v_origen,
        (p_fila->>'sales_event_id')::uuid,
        v_metodo,
        (p_fila->>'atribucion_lead_id')::uuid,
        CASE WHEN v_metodo IS NOT NULL
             THEN COALESCE((p_fila->>'atribucion_at')::timestamptz, now()) END,
        p_fila->>'estado_crudo'
    ON CONFLICT (cliente_id, transaction_id) DO NOTHING
    RETURNING hotmart_ventas.id INTO v_id;

    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;

    -- La fila ya existía. Se bloquea para que dos eventos simultáneos de la
    -- misma transacción no decidan sobre la misma foto.
    SELECT * INTO v_old
      FROM public.hotmart_ventas hv
     WHERE hv.cliente_id = v_cliente
       AND hv.transaction_id = v_tx
     FOR UPDATE;

    IF NOT FOUND THEN
        -- Borrada entre el INSERT y el SELECT (borrado del cliente en curso).
        RETURN QUERY SELECT NULL::uuid, false;
        RETURN;
    END IF;

    v_mas_nuevo := v_ts >= v_old.evento_ts;
    -- Un estado cobrado o devuelto NUNCA vuelve a pendiente: un PROTEST o un
    -- reintento de WAITING_PAYMENT no es una venta sin cobrar.
    v_regresa := v_old.estado IN ('aprobada', 'completa', 'reembolsada', 'chargeback')
                 AND v_estado = 'pendiente';
    -- La API no tiene instante de evento propio (usa approved_date), así que un
    -- estado MÁS AVANZADO que traiga se aplica aunque su evento_ts sea viejo.
    v_avance := v_origen IN ('api', 'backfill', 'reconciliacion')
                AND (CASE v_estado
                        WHEN 'pendiente' THEN 0 WHEN 'cancelada' THEN 1 WHEN 'expirada' THEN 1
                        WHEN 'aprobada' THEN 2 WHEN 'completa' THEN 3
                        WHEN 'reembolsada' THEN 4 WHEN 'chargeback' THEN 4 ELSE -1 END)
                  > (CASE v_old.estado
                        WHEN 'pendiente' THEN 0 WHEN 'cancelada' THEN 1 WHEN 'expirada' THEN 1
                        WHEN 'aprobada' THEN 2 WHEN 'completa' THEN 3
                        WHEN 'reembolsada' THEN 4 WHEN 'chargeback' THEN 4 ELSE -1 END);
    v_aplica := NOT v_regresa AND (v_mas_nuevo OR v_avance);
    v_estado_fin := CASE WHEN v_aplica THEN v_estado ELSE v_old.estado END;

    -- La tupla UTM como bloque. El tracking siempre gana; un lead nunca pisa un
    -- tracking; un método explícito sustituye a una tupla sin método.
    v_tupla := CASE
        WHEN v_metodo = 'tracking'                THEN true
        WHEN v_old.atribucion_metodo = 'tracking' THEN false
        WHEN v_metodo IS NOT NULL                 THEN true
        ELSE NULL
    END;

    UPDATE public.hotmart_ventas hv SET
        -- ── Estado: solo si el evento se aplica ─────────────────────
        estado         = v_estado_fin,
        evento_ts      = CASE
                             WHEN NOT v_aplica THEN v_old.evento_ts
                             WHEN v_avance     THEN GREATEST(v_old.evento_ts, v_ts, now())
                             ELSE v_ts
                         END,
        fecha_venta    = CASE
                             WHEN v_aplica THEN (p_fila->>'fecha_venta')::date
                             -- Relleno: la venta no tenía aprobación y ahora sí.
                             WHEN v_old.aprobada_at IS NULL AND p_fila->>'aprobada_at' IS NOT NULL
                                 THEN (p_fila->>'fecha_venta')::date
                             ELSE v_old.fecha_venta
                         END,
        origen         = CASE WHEN v_aplica THEN v_origen ELSE v_old.origen END,
        estado_crudo   = CASE WHEN v_aplica
                              THEN COALESCE(p_fila->>'estado_crudo', v_old.estado_crudo)
                              ELSE COALESCE(v_old.estado_crudo, p_fila->>'estado_crudo') END,
        reembolsada_at = CASE
                             WHEN v_estado_fin IN ('reembolsada', 'chargeback')
                                 THEN COALESCE(v_old.reembolsada_at,
                                               (p_fila->>'reembolsada_at')::timestamptz, now())
                             ELSE NULL
                         END,

        -- ── Clasificación: la decide nuestro código, gana la última ──
        tipo                 = CASE WHEN COALESCE(p_fila->>'tipo', 'sin_clasificar') = 'sin_clasificar'
                                    THEN v_old.tipo ELSE p_fila->>'tipo' END,
        clasificacion_origen = CASE WHEN COALESCE(p_fila->>'tipo', 'sin_clasificar') = 'sin_clasificar'
                                    THEN v_old.clasificacion_origen
                                    ELSE COALESCE(p_fila->>'clasificacion_origen', v_old.clasificacion_origen) END,
        tab_id               = COALESCE((p_fila->>'tab_id')::uuid, v_old.tab_id),
        es_order_bump        = COALESCE((p_fila->>'es_order_bump')::boolean, false) OR v_old.es_order_bump,

        -- ── Relleno: el más nuevo manda, el más viejo solo completa ──
        parent_transaction_id = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'parent_transaction_id', v_old.parent_transaction_id)
            ELSE COALESCE(v_old.parent_transaction_id, p_fila->>'parent_transaction_id') END,
        aprobada_at = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'aprobada_at')::timestamptz, v_old.aprobada_at)
            ELSE COALESCE(v_old.aprobada_at, (p_fila->>'aprobada_at')::timestamptz) END,
        orden_at = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'orden_at')::timestamptz, v_old.orden_at)
            ELSE COALESCE(v_old.orden_at, (p_fila->>'orden_at')::timestamptz) END,
        producto_id = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'producto_id', v_old.producto_id)
            ELSE COALESCE(v_old.producto_id, p_fila->>'producto_id') END,
        producto_nombre = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'producto_nombre', v_old.producto_nombre)
            ELSE COALESCE(v_old.producto_nombre, p_fila->>'producto_nombre') END,
        oferta_codigo = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'oferta_codigo', v_old.oferta_codigo)
            ELSE COALESCE(v_old.oferta_codigo, p_fila->>'oferta_codigo') END,
        moneda = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'moneda', v_old.moneda)
            ELSE COALESCE(v_old.moneda, p_fila->>'moneda') END,
        bruto = CASE
            WHEN COALESCE((p_fila->>'bruto')::numeric, 0) > 0 AND (v_mas_nuevo OR v_old.bruto = 0)
                THEN (p_fila->>'bruto')::numeric
            ELSE v_old.bruto END,
        bruto_usd = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'bruto_usd')::numeric, v_old.bruto_usd)
            ELSE COALESCE(v_old.bruto_usd, (p_fila->>'bruto_usd')::numeric) END,
        -- Las comisiones SOLO las trae la API: aquí está el arreglo del punto 1.
        neto_productor_usd = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'neto_productor_usd')::numeric, v_old.neto_productor_usd)
            ELSE COALESCE(v_old.neto_productor_usd, (p_fila->>'neto_productor_usd')::numeric) END,
        neto_afiliado_usd = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'neto_afiliado_usd')::numeric, v_old.neto_afiliado_usd)
            ELSE COALESCE(v_old.neto_afiliado_usd, (p_fila->>'neto_afiliado_usd')::numeric) END,
        neto_coproductor_usd = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'neto_coproductor_usd')::numeric, v_old.neto_coproductor_usd)
            ELSE COALESCE(v_old.neto_coproductor_usd, (p_fila->>'neto_coproductor_usd')::numeric) END,
        usd_rate = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'usd_rate')::numeric, v_old.usd_rate)
            ELSE COALESCE(v_old.usd_rate, (p_fila->>'usd_rate')::numeric) END,
        pago_tipo = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'pago_tipo', v_old.pago_tipo)
            ELSE COALESCE(v_old.pago_tipo, p_fila->>'pago_tipo') END,
        pago_cuotas = CASE WHEN v_mas_nuevo
            THEN COALESCE((p_fila->>'pago_cuotas')::smallint, v_old.pago_cuotas)
            ELSE COALESCE(v_old.pago_cuotas, (p_fila->>'pago_cuotas')::smallint) END,
        comprador_email = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'comprador_email', v_old.comprador_email)
            ELSE COALESCE(v_old.comprador_email, p_fila->>'comprador_email') END,
        comprador_nombre = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'comprador_nombre', v_old.comprador_nombre)
            ELSE COALESCE(v_old.comprador_nombre, p_fila->>'comprador_nombre') END,
        comprador_telefono = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'comprador_telefono', v_old.comprador_telefono)
            ELSE COALESCE(v_old.comprador_telefono, p_fila->>'comprador_telefono') END,
        comprador_doc = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'comprador_doc', v_old.comprador_doc)
            ELSE COALESCE(v_old.comprador_doc, p_fila->>'comprador_doc') END,
        comprador_pais = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'comprador_pais', v_old.comprador_pais)
            ELSE COALESCE(v_old.comprador_pais, p_fila->>'comprador_pais') END,
        checkout_pais = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'checkout_pais', v_old.checkout_pais)
            ELSE COALESCE(v_old.checkout_pais, p_fila->>'checkout_pais') END,
        click_id = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'click_id', v_old.click_id)
            ELSE COALESCE(v_old.click_id, p_fila->>'click_id') END,
        src = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'src', v_old.src)
            ELSE COALESCE(v_old.src, p_fila->>'src') END,
        sck = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'sck', v_old.sck)
            ELSE COALESCE(v_old.sck, p_fila->>'sck') END,
        xcod = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->>'xcod', v_old.xcod)
            ELSE COALESCE(v_old.xcod, p_fila->>'xcod') END,
        raw_payload = CASE WHEN v_mas_nuevo
            THEN COALESCE(p_fila->'raw_payload', v_old.raw_payload)
            ELSE COALESCE(v_old.raw_payload, p_fila->'raw_payload') END,
        sales_event_id = COALESCE((p_fila->>'sales_event_id')::uuid, v_old.sales_event_id),

        -- ── Tupla UTM + atribución, como bloque ─────────────────────
        utm_source = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_source'
            WHEN false THEN v_old.utm_source
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_source', v_old.utm_source)
                      ELSE COALESCE(v_old.utm_source, p_fila->>'utm_source') END END,
        utm_medium = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_medium'
            WHEN false THEN v_old.utm_medium
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_medium', v_old.utm_medium)
                      ELSE COALESCE(v_old.utm_medium, p_fila->>'utm_medium') END END,
        utm_campaign = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_campaign'
            WHEN false THEN v_old.utm_campaign
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_campaign', v_old.utm_campaign)
                      ELSE COALESCE(v_old.utm_campaign, p_fila->>'utm_campaign') END END,
        utm_content = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_content'
            WHEN false THEN v_old.utm_content
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_content', v_old.utm_content)
                      ELSE COALESCE(v_old.utm_content, p_fila->>'utm_content') END END,
        utm_term = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_term'
            WHEN false THEN v_old.utm_term
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_term', v_old.utm_term)
                      ELSE COALESCE(v_old.utm_term, p_fila->>'utm_term') END END,
        utm_id = CASE v_tupla
            WHEN true  THEN p_fila->>'utm_id'
            WHEN false THEN v_old.utm_id
            ELSE CASE WHEN v_mas_nuevo THEN COALESCE(p_fila->>'utm_id', v_old.utm_id)
                      ELSE COALESCE(v_old.utm_id, p_fila->>'utm_id') END END,
        atribucion_metodo  = CASE WHEN v_tupla THEN v_metodo ELSE v_old.atribucion_metodo END,
        atribucion_lead_id = CASE WHEN v_tupla THEN (p_fila->>'atribucion_lead_id')::uuid
                                  ELSE v_old.atribucion_lead_id END,
        atribucion_at      = CASE WHEN v_tupla
                                  THEN COALESCE((p_fila->>'atribucion_at')::timestamptz, now())
                                  ELSE v_old.atribucion_at END,

        actualizado_at = now()
    WHERE hv.id = v_old.id;

    RETURN QUERY SELECT v_old.id, v_aplica;
END;
$$;

COMMENT ON FUNCTION public.guardar_hotmart_venta(JSONB) IS
    'Inserta o actualiza una venta. El ESTADO solo avanza (evento más reciente, o estado más avanzado traído por la API; nunca de cobrado a pendiente) y el RESTO de columnas solo se rellena desde eventos viejos. La tupla UTM va como bloque y el tracking de Hotmart siempre gana. Devuelve (id, escrita): escrita=true si el evento se aplicó como el más reciente. Migración 089.';

-- ────────────────────────────────────────────────────────────────
-- 3) Leads candidatos para heredar la tupla UTM
-- ────────────────────────────────────────────────────────────────
-- Devuelve SOLO los leads que sirven para atribuir: no excluidos y con campaña
-- (utm_campaign o utm_id). La normalización (email en minúsculas, últimos 9
-- dígitos del teléfono) es la misma que aplica src/lib/hotmart/atribucion.ts:
-- las dos tienen que coincidir o el cruce falla en silencio.
--
-- Solo service_role: por email se podrían leer leads de cualquier cliente.
CREATE OR REPLACE FUNCTION public.hotmart_leads_para_atribucion(
    p_cliente_rtm UUID,
    p_emails      TEXT[],
    p_tel9        TEXT[],
    p_desde       TIMESTAMPTZ,
    p_hasta       TIMESTAMPTZ
)
RETURNS TABLE (
    id           UUID,
    created_at   TIMESTAMPTZ,
    email_norm   TEXT,
    tel9         TEXT,
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    utm_id       TEXT
)
LANGUAGE sql
STABLE
SET search_path = public, report_utm, pg_temp
AS $$
    SELECT l.id,
           l.created_at,
           lower(btrim(l.lead_email)),
           right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9),
           l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.utm_id
      FROM report_utm.lead_events l
     WHERE l.cliente_id = p_cliente_rtm
       AND l.created_at >= p_desde
       AND l.created_at <  p_hasta
       AND NOT COALESCE(l.excluido, false)
       AND (l.utm_campaign IS NOT NULL OR l.utm_id IS NOT NULL)
       AND (
             lower(btrim(l.lead_email)) = ANY (COALESCE(p_emails, ARRAY[]::TEXT[]))
          OR (length(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g')) >= 8
              AND right(regexp_replace(COALESCE(l.lead_phone, ''), '\D', '', 'g'), 9)
                  = ANY (COALESCE(p_tel9, ARRAY[]::TEXT[])))
       )
$$;

COMMENT ON FUNCTION public.hotmart_leads_para_atribucion(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Leads no excluidos y con campaña cuyo email (minúsculas) o teléfono (últimos 9 dígitos) coincide con compradores de Hotmart. p_cliente_rtm es el id de report_utm.clientes. Lo usa src/lib/hotmart/atribucion-db.ts. Migración 089.';

REVOKE ALL ON FUNCTION public.hotmart_leads_para_atribucion(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hotmart_leads_para_atribucion(UUID, TEXT[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ)
    TO service_role;

-- ────────────────────────────────────────────────────────────────
-- 4) hotmart_valores_conteo: las UTM y el método de atribución
-- ────────────────────────────────────────────────────────────────
-- Mismo cuerpo que la 070, con la lista blanca ampliada para que los
-- segmentadores del BI puedan listar valores de UTM de las ventas.
CREATE OR REPLACE FUNCTION public.hotmart_valores_conteo(
    p_cliente_publico_id UUID,
    p_columna            TEXT,
    p_desde              DATE,
    p_hasta              DATE,
    p_limite             INT DEFAULT 200
)
RETURNS TABLE (valor TEXT, n BIGINT, total_distintos BIGINT)
LANGUAGE plpgsql
STABLE
SET search_path = public, report_utm, pg_temp
AS $$
DECLARE
    v_sql TEXT;
BEGIN
    -- Espejo de HOTMART_DIM_COL + HOTMART_FILTER_COL en bi-query.ts.
    IF p_columna NOT IN (
        'tipo', 'oferta_codigo', 'producto_nombre', 'comprador_pais', 'pago_tipo',
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
        'atribucion_metodo'
    ) THEN
        RAISE EXCEPTION 'hotmart_valores_conteo: columna % no permitida', p_columna;
    END IF;
    IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
        RAISE EXCEPTION 'hotmart_valores_conteo: p_limite fuera de rango 1..500 (recibido: %)', p_limite;
    END IF;

    v_sql := format($f$
        WITH grp AS (
            SELECT h.%I::TEXT AS valor, COUNT(*)::BIGINT AS n
            FROM public.hotmart_ventas h
            WHERE h.cliente_id = $1
              AND h.fecha_venta >= $2
              AND h.fecha_venta <= $3
              AND h.%I IS NOT NULL
              AND btrim(h.%I::TEXT) <> ''
            GROUP BY 1
        )
        SELECT valor, n, COUNT(*) OVER ()::BIGINT
        FROM grp
        ORDER BY n DESC, valor ASC
        LIMIT $4
    $f$, p_columna, p_columna, p_columna);

    RETURN QUERY EXECUTE v_sql USING p_cliente_publico_id, p_desde, p_hasta, p_limite;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hotmart_valores_conteo(UUID, TEXT, DATE, DATE, INT)
    TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
