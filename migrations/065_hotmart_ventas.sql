-- ════════════════════════════════════════════════════════════════
-- Migration 065: hotmart_ventas — tabla de hechos de ventas
-- ════════════════════════════════════════════════════════════════
-- Hotmart entraba al sistema por DOS caminos que no se hablaban, y cada uno
-- tiraba a la basura justo lo que el otro necesitaba:
--
--   VÍA A — pull de la API, inline en `src/app/api/worker/route.ts:1616-1886`.
--     Escribía agregados diarios en `metricas_diarias` (ventas_principal/bump/
--     upsell en USD). Solo retenía {transaction, price.value, currency_code}:
--     sin comprador, sin oferta, sin método de pago, SIN UTMs. Y filtraba a
--     `transaction_status=APPROVED&COMPLETE`, así que un reembolso NUNCA se veía:
--     una venta devuelta seguía contando como facturación para siempre.
--
--   VÍA B — webhook, en `report_utm.sales_events`.
--     Medido el 2026-08-10: **0 filas para todos los clientes**. El módulo
--     report-utm no ha reportado jamás una venta.
--
-- Y las dos clasificaban mal el embudo:
--   • El webhook buscaba `purchase.is_bump` / `is_upsell` — claves que NO
--     EXISTEN en el payload 2.0.0 (los campos reales son `purchase.offer.code` y
--     `purchase.order_bump.is_order_bump`). `transaction_type` era SIEMPRE
--     'principal'.
--   • El worker comparaba el NOMBRE del producto contra patrones tipo LIKE. En
--     cuanto alguien renombra un producto en Hotmart, sus ventas caen a
--     `extras[]` y desaparecen del desglose, sin ningún aviso.
--   • `downsell` no existía en ningún archivo del repositorio.
--
-- Esta tabla es la ÚNICA verdad de ventas. La alimentan el webhook (en vivo) y
-- la API (backfill y reconciliación) con el MISMO parser (`src/lib/hotmart/`), y
-- de ella leen tanto el reporting de clientes como el UTM report.
--
-- ── PRESUPUESTO DE ALMACENAMIENTO ───────────────────────────────
-- ATENCIÓN: la cabecera de la migración 063 dice 293 MB. Ya no es cierto.
-- Medido el 2026-08-10: la base está en **449 MB contra el tope de 500 MB del
-- plan**. Quedan 51 MB. La migración 061 existe porque se llegó a 539 MB y hubo
-- que soltar una tabla y seis índices.
--
-- Volumen real de Hotmart, medido sobre `metricas_diarias`:
--   671 transacciones en 5 meses (594 clasificadas + 77 en `extras`),
--   desde la primera venta el 2026-03-09 → ~134/mes ≈ 1.600 filas/año.
--
--   fila sin payload (~45 columnas)      ~600 B
--   raw_payload TOASTeado                ~1 KB
--   1.600 filas/año + 3 índices          ≈ 3 MB/año
--
-- Con esas cifras el `raw_payload` SÍ cabe, y en una integración que se está
-- rehaciendo vale su peso: permite depurar sin volver a pedirle nada a Hotmart.
-- Aun así lleva purga a 180 días como válvula, y esta migración añade la purga
-- del crudo de `sales_events`, que es lo que de verdad crecería sin techo en
-- cuanto los webhooks empiecen a entrar.
--
-- ── CONVIVENCIA CON report_utm.sales_events ─────────────────────
-- `sales_events` NO se retira: es el único hogar de Cartpanda y Shopify, y lo
-- leen `attribution-resolver.ts`, `aggregate.ts`, `salud-fuentes-db.ts`, la UI
-- de `/report-utm/ventas` y la fuente BI `sales`. El reparto es explícito:
--
--   hotmart_ventas → la verdad para DINERO y CLASIFICACIÓN.
--   sales_events   → el crudo, la atribución y el resto de pasarelas.
--
-- El webhook escribe en las dos y las enlaza (`sales_events.hotmart_venta_id`,
-- migración 066).
--
-- REVERSIBLE: es una tabla nueva y aditiva. No modifica ni borra nada existente.
--   DROP TABLE IF EXISTS public.hotmart_ventas CASCADE;
--   DROP FUNCTION IF EXISTS public.purgar_hotmart_raw(integer);
--   DROP FUNCTION IF EXISTS public.purgar_hotmart_pii(integer);
--   DROP FUNCTION IF EXISTS public.purgar_sales_events_raw(integer);
--   DROP FUNCTION IF EXISTS public.guardar_hotmart_venta(jsonb);
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.hotmart_ventas (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id            UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,

    -- ── Identidad ───────────────────────────────────────────────
    transaction_id        TEXT NOT NULL,
    -- Los upsells y los order bumps cuelgan de la compra principal. Es lo que
    -- permite reconstruir el ticket completo de un checkout.
    parent_transaction_id TEXT,

    -- ── Fecha ───────────────────────────────────────────────────
    -- Día de calendario COLOMBIA, materializado al escribir.
    --
    -- Resuelve las TRES definiciones de "fecha de venta" que competían en el
    -- módulo y que nunca cuadraban entre sí:
    --   BI              → created_at            (bi-query.ts:64-70)
    --   UI /ventas      → sale_timestamp        (ventas/page.tsx:50-54)
    --   hourly_metrics  → sale_timestamp ?? received_at (aggregate.ts:57,101)
    -- Al ser un DATE ya convertido, ninguna lectura vuelve a hacer aritmética de
    -- zona horaria: se filtra con >= y <= y se acabó.
    fecha_venta           DATE NOT NULL,
    aprobada_at           TIMESTAMPTZ,
    orden_at              TIMESTAMPTZ,

    -- ── Estado y ciclo de vida ──────────────────────────────────
    estado                TEXT NOT NULL CHECK (estado IN (
                              'aprobada', 'completa', 'pendiente',
                              'reembolsada', 'chargeback', 'cancelada', 'expirada')),
    -- Guarda de orden. Hotmart NO garantiza el orden de entrega ni entrega
    -- exactamente-una-vez: un reintento tardío del PURCHASE_APPROVED llegado
    -- después del PURCHASE_REFUNDED RESUCITABA la venta en el esquema anterior.
    -- `guardar_hotmart_venta` descarta todo evento con evento_ts más viejo.
    evento_ts             TIMESTAMPTZ NOT NULL,
    reembolsada_at        TIMESTAMPTZ,

    -- ── Clasificación del embudo ────────────────────────────────
    tipo                  TEXT NOT NULL DEFAULT 'sin_clasificar' CHECK (tipo IN (
                              'principal', 'bump', 'upsell', 'downsell',
                              'suscripcion', 'sin_clasificar')),
    -- CÓMO se decidió el tipo: oferta | order_bump | parent_tx | nombre |
    -- sin_clasificar. Se persiste para poder auditar por qué una venta cayó
    -- donde cayó y para medir la cobertura del mapa de ofertas ANTES de que el
    -- dashboard confíe en el número.
    clasificacion_origen  TEXT NOT NULL DEFAULT 'sin_clasificar',
    tab_id                UUID REFERENCES public.cliente_tabs(id) ON DELETE SET NULL,

    -- ── Producto y oferta ───────────────────────────────────────
    producto_id           TEXT,
    producto_nombre       TEXT,
    -- `purchase.offer.code`: el identificador ESTABLE de la oferta. Es lo que
    -- hace que renombrar un producto en Hotmart deje de romper la clasificación.
    oferta_codigo         TEXT,
    es_order_bump         BOOLEAN NOT NULL DEFAULT false,

    -- ── Dinero ──────────────────────────────────────────────────
    moneda                TEXT,
    bruto                 NUMERIC(14,4) NOT NULL DEFAULT 0,
    -- NULL cuando no hay tasa de cambio. NUNCA 0. Mismo criterio que
    -- `src/lib/fx.ts` y el worker: un cero se suma en silencio y hunde el ROAS;
    -- un NULL se puede contar y reportar.
    bruto_usd             NUMERIC(14,4),
    -- Comisión del PRODUCTOR: lo que de verdad se cobra tras la tarifa de
    -- Hotmart. Es el "neto" que alimenta ventas_principal/bump/upsell.
    neto_productor_usd    NUMERIC(14,4),
    -- Antes solo existían agregados dentro de `hotmart_funnel_data.affiliates`,
    -- sin desglose por transacción ni exposición en el BI.
    neto_afiliado_usd     NUMERIC(14,4),
    neto_coproductor_usd  NUMERIC(14,4),
    usd_rate              NUMERIC(18,8),
    pago_tipo             TEXT,      -- CREDIT_CARD | BILLET | PIX | PAYPAL…
    pago_cuotas           SMALLINT,

    -- ── Comprador ───────────────────────────────────────────────
    comprador_email       TEXT,
    comprador_nombre      TEXT,
    comprador_telefono    TEXT,
    -- Columna propia. Antes el documento se guardaba COMO TELÉFONO cuando no
    -- había teléfono, y ese valor se hasheaba y se enviaba a Meta CAPI: un
    -- CPF/CC nunca matchea, solo degradaba la calidad del evento.
    comprador_doc         TEXT,
    comprador_pais        TEXT,
    checkout_pais         TEXT,

    -- ── Atribución ──────────────────────────────────────────────
    utm_source            TEXT,
    utm_medium            TEXT,
    utm_campaign          TEXT,
    utm_content           TEXT,
    utm_term              TEXT,
    utm_id                TEXT,
    click_id              TEXT,
    -- Columnas propias: antes solo se usaban como relleno de utm_content /
    -- utm_source / click_id, así que era imposible distinguir un UTM real de un
    -- parámetro de Hotmart.
    src                   TEXT,
    sck                   TEXT,
    xcod                  TEXT,

    -- ── Idempotencia de conversiones salientes ──────────────────
    -- Se RECLAMAN antes de enviar (UPDATE ... WHERE ... IS NULL RETURNING), no
    -- después. El webhook anterior disparaba Meta CAPI y Google Ads sin
    -- consultarlas, así que cada reintento de Hotmart duplicaba la conversión.
    capi_enviado_at       TIMESTAMPTZ,
    gads_enviado_at       TIMESTAMPTZ,

    -- ── Trazabilidad ────────────────────────────────────────────
    raw_payload           JSONB,
    origen                TEXT NOT NULL DEFAULT 'webhook' CHECK (origen IN (
                              'webhook', 'api', 'backfill', 'reconciliacion')),
    sales_event_id        UUID,
    creado_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (cliente_id, transaction_id)
);

-- ────────────────────────────────────────────────────────────────
-- Índices. Tres, y cada uno justificado contra los 51 MB de margen.
-- ────────────────────────────────────────────────────────────────

-- (1) La lectura de TODO: el agregado diario a `metricas_diarias` y el motor BI.
CREATE INDEX IF NOT EXISTS idx_hotmart_ventas_lectura
    ON public.hotmart_ventas (cliente_id, fecha_venta DESC);

-- (2) Resolver un upsell/bump hacia su compra principal. Parcial porque la
--     inmensa mayoría de las ventas no cuelgan de nadie.
CREATE INDEX IF NOT EXISTS idx_hotmart_ventas_padre
    ON public.hotmart_ventas (cliente_id, parent_transaction_id)
    WHERE parent_transaction_id IS NOT NULL;

-- (3) Descubrimiento de ofertas para la UI de configuración del embudo y
--     agrupación por oferta en el BI.
CREATE INDEX IF NOT EXISTS idx_hotmart_ventas_oferta
    ON public.hotmart_ventas (cliente_id, oferta_codigo, fecha_venta DESC)
    WHERE oferta_codigo IS NOT NULL;

-- NO se crea índice sobre transaction_id: lo cubre el UNIQUE.
-- NO se crea índice sobre utm_campaign: el motor lee siempre acotado por
--   (cliente_id, fecha_venta) y cruza en memoria con el CampaignResolver. El
--   equivalente en sales_events (`idx_rutm_sales_utm`) lleva 0 scans.
-- NO se crea GIN sobre raw_payload: se lee por transacción, nunca por
--   contenido. Misma renuncia que la migración 063 con `eventos`.

-- ────────────────────────────────────────────────────────────────
-- Comentarios: son la documentación que sobrevive al repo.
-- ────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.hotmart_ventas IS
    'Ventas de Hotmart normalizadas: una fila por transacción. ÚNICA verdad de ventas del sistema, alimentada por el webhook (en vivo) y por la API (backfill y reconciliación) con el mismo parser (src/lib/hotmart/). De aquí leen tanto metricas_diarias como el BI de report-utm.';
COMMENT ON COLUMN public.hotmart_ventas.fecha_venta IS
    'Día de calendario en hora Colombia, materializado al escribir. Resuelve las tres definiciones de fecha de venta que competían (created_at, sale_timestamp, sale_timestamp ?? received_at). Ninguna lectura debe volver a convertir zonas.';
COMMENT ON COLUMN public.hotmart_ventas.evento_ts IS
    'Instante del evento. Guarda de orden: guardar_hotmart_venta descarta todo evento más viejo que el ya guardado. Sin esto, un reintento tardío del PURCHASE_APPROVED resucita una venta ya reembolsada.';
COMMENT ON COLUMN public.hotmart_ventas.oferta_codigo IS
    'purchase.offer.code. Identificador ESTABLE de la oferta: clasificar por él (en vez de por el nombre del producto) es lo que evita que renombrar un producto en Hotmart mande las ventas a extras sin aviso.';
COMMENT ON COLUMN public.hotmart_ventas.clasificacion_origen IS
    'oferta | order_bump | parent_tx | nombre | sin_clasificar. Permite auditar por qué una venta cayó en su tipo y medir la cobertura del mapa de ofertas antes de confiar en el desglose.';
COMMENT ON COLUMN public.hotmart_ventas.bruto_usd IS
    'NULL si no hay tasa de cambio para esa divisa y ese día. NUNCA 0: un cero se suma en silencio y hunde el ROAS.';
COMMENT ON COLUMN public.hotmart_ventas.neto_productor_usd IS
    'Comisión source=PRODUCER convertida a USD: lo que de verdad se cobra tras la tarifa de Hotmart. Es el importe que alimenta ventas_principal/bump/upsell de metricas_diarias.';
COMMENT ON COLUMN public.hotmart_ventas.comprador_doc IS
    'Documento fiscal del comprador, en columna propia. Antes se guardaba en customer_phone cuando faltaba el teléfono, y de ahí se enviaba hasheado a Meta CAPI como teléfono.';
COMMENT ON COLUMN public.hotmart_ventas.origen IS
    'webhook | api | backfill | reconciliacion. Permite re-ejecutar el backfill sin pisar lo que el webhook escribe en vivo, y auditar de dónde salió cada fila.';
COMMENT ON COLUMN public.hotmart_ventas.raw_payload IS
    'Crudo del webhook. Cabe en el presupuesto (~1 KB × ~1.600 filas/año) y permite depurar sin volver a pedirle nada a Hotmart. Se purga a 180 días con purgar_hotmart_raw.';

-- ────────────────────────────────────────────────────────────────
-- Escritura idempotente con guarda de orden
--
-- Sustituye al upsert de PostgREST que usaba el webhook
-- (`onConflict` con `ignoreDuplicates:false`), que tenía dos fallos:
--   • Un PURCHASE_REFUNDED MACHACABA la fila del PURCHASE_APPROVED y se perdía
--     el importe original, de modo que era imposible calcular la tasa de
--     reembolso.
--   • Un reintento tardío del PURCHASE_APPROVED devolvía la venta a 'aprobada'
--     aunque ya estuviera reembolsada.
--
-- Aquí un evento más viejo que el guardado NO escribe nada, y el reembolso
-- cambia el estado CONSERVANDO los importes.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guardar_hotmart_venta(p_fila JSONB)
RETURNS TABLE (id UUID, escrita BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_id       UUID;
    v_escrita  BOOLEAN := false;
BEGIN
    INSERT INTO public.hotmart_ventas AS hv (
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
        raw_payload, origen, sales_event_id
    )
    SELECT
        (p_fila->>'cliente_id')::uuid,
        p_fila->>'transaction_id',
        p_fila->>'parent_transaction_id',
        (p_fila->>'fecha_venta')::date,
        (p_fila->>'aprobada_at')::timestamptz,
        (p_fila->>'orden_at')::timestamptz,
        p_fila->>'estado',
        (p_fila->>'evento_ts')::timestamptz,
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
        COALESCE(p_fila->>'origen', 'webhook'),
        (p_fila->>'sales_event_id')::uuid
    ON CONFLICT (cliente_id, transaction_id) DO UPDATE SET
        parent_transaction_id = COALESCE(EXCLUDED.parent_transaction_id, hv.parent_transaction_id),
        fecha_venta           = EXCLUDED.fecha_venta,
        aprobada_at           = COALESCE(EXCLUDED.aprobada_at, hv.aprobada_at),
        orden_at              = COALESCE(EXCLUDED.orden_at, hv.orden_at),
        estado                = EXCLUDED.estado,
        evento_ts             = EXCLUDED.evento_ts,
        reembolsada_at        = COALESCE(EXCLUDED.reembolsada_at, hv.reembolsada_at),
        tipo                  = CASE WHEN EXCLUDED.tipo = 'sin_clasificar'
                                     THEN hv.tipo ELSE EXCLUDED.tipo END,
        clasificacion_origen  = CASE WHEN EXCLUDED.tipo = 'sin_clasificar'
                                     THEN hv.clasificacion_origen
                                     ELSE EXCLUDED.clasificacion_origen END,
        tab_id                = COALESCE(EXCLUDED.tab_id, hv.tab_id),
        producto_id           = COALESCE(EXCLUDED.producto_id, hv.producto_id),
        producto_nombre       = COALESCE(EXCLUDED.producto_nombre, hv.producto_nombre),
        oferta_codigo         = COALESCE(EXCLUDED.oferta_codigo, hv.oferta_codigo),
        es_order_bump         = EXCLUDED.es_order_bump OR hv.es_order_bump,
        moneda                = COALESCE(EXCLUDED.moneda, hv.moneda),
        -- Los importes NO se pisan con NULL: el webhook no trae comisiones y la
        -- API no trae UTMs. Cada origen aporta lo que sabe y conserva lo demás.
        bruto                 = CASE WHEN EXCLUDED.bruto > 0 THEN EXCLUDED.bruto ELSE hv.bruto END,
        bruto_usd             = COALESCE(EXCLUDED.bruto_usd, hv.bruto_usd),
        neto_productor_usd    = COALESCE(EXCLUDED.neto_productor_usd, hv.neto_productor_usd),
        neto_afiliado_usd     = COALESCE(EXCLUDED.neto_afiliado_usd, hv.neto_afiliado_usd),
        neto_coproductor_usd  = COALESCE(EXCLUDED.neto_coproductor_usd, hv.neto_coproductor_usd),
        usd_rate              = COALESCE(EXCLUDED.usd_rate, hv.usd_rate),
        pago_tipo             = COALESCE(EXCLUDED.pago_tipo, hv.pago_tipo),
        pago_cuotas           = COALESCE(EXCLUDED.pago_cuotas, hv.pago_cuotas),
        comprador_email       = COALESCE(EXCLUDED.comprador_email, hv.comprador_email),
        comprador_nombre      = COALESCE(EXCLUDED.comprador_nombre, hv.comprador_nombre),
        comprador_telefono    = COALESCE(EXCLUDED.comprador_telefono, hv.comprador_telefono),
        comprador_doc         = COALESCE(EXCLUDED.comprador_doc, hv.comprador_doc),
        comprador_pais        = COALESCE(EXCLUDED.comprador_pais, hv.comprador_pais),
        checkout_pais         = COALESCE(EXCLUDED.checkout_pais, hv.checkout_pais),
        utm_source            = COALESCE(EXCLUDED.utm_source, hv.utm_source),
        utm_medium            = COALESCE(EXCLUDED.utm_medium, hv.utm_medium),
        utm_campaign          = COALESCE(EXCLUDED.utm_campaign, hv.utm_campaign),
        utm_content           = COALESCE(EXCLUDED.utm_content, hv.utm_content),
        utm_term              = COALESCE(EXCLUDED.utm_term, hv.utm_term),
        utm_id                = COALESCE(EXCLUDED.utm_id, hv.utm_id),
        click_id              = COALESCE(EXCLUDED.click_id, hv.click_id),
        src                   = COALESCE(EXCLUDED.src, hv.src),
        sck                   = COALESCE(EXCLUDED.sck, hv.sck),
        xcod                  = COALESCE(EXCLUDED.xcod, hv.xcod),
        raw_payload           = COALESCE(EXCLUDED.raw_payload, hv.raw_payload),
        origen                = EXCLUDED.origen,
        sales_event_id        = COALESCE(EXCLUDED.sales_event_id, hv.sales_event_id),
        actualizado_at        = now()
    -- LA GUARDA. Un evento más viejo que el guardado no escribe NADA.
    WHERE EXCLUDED.evento_ts >= hv.evento_ts
    RETURNING hv.id INTO v_id;

    IF v_id IS NOT NULL THEN
        v_escrita := true;
    ELSE
        -- El WHERE del DO UPDATE rechazó la escritura: la fila existe pero es
        -- más reciente. Se devuelve su id para que el llamante pueda enlazarla.
        SELECT hv2.id INTO v_id
          FROM public.hotmart_ventas hv2
         WHERE hv2.cliente_id = (p_fila->>'cliente_id')::uuid
           AND hv2.transaction_id = p_fila->>'transaction_id';
    END IF;

    RETURN QUERY SELECT v_id, v_escrita;
END;
$$;

COMMENT ON FUNCTION public.guardar_hotmart_venta(JSONB) IS
    'Inserta o actualiza una venta con guarda de orden por evento_ts. Devuelve (id, escrita): escrita=false significa que llegó un evento más viejo que el guardado y se descartó. Cada origen aporta lo que sabe (el webhook los UTMs, la API las comisiones) sin pisar con NULL lo que aportó el otro.';

-- ────────────────────────────────────────────────────────────────
-- Purgas. Ninguna borra ventas: son la verdad del negocio.
-- Lo que caduca es el crudo y los datos personales.
--
-- Las llama el planificador del sync (`src/lib/sync/planner.ts`), igual que
-- `purgar_ads_daily` de la migración 063.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purgar_hotmart_raw(p_dias INTEGER DEFAULT 180)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_filas INTEGER;
BEGIN
    UPDATE public.hotmart_ventas
       SET raw_payload = NULL
     WHERE raw_payload IS NOT NULL
       AND fecha_venta < CURRENT_DATE - p_dias;
    GET DIAGNOSTICS v_filas = ROW_COUNT;
    RETURN v_filas;
END;
$$;

COMMENT ON FUNCTION public.purgar_hotmart_raw(INTEGER) IS
    'Vacía raw_payload de las ventas de más de N días (180 por defecto). La venta NO se borra: solo el crudo, que ya no sirve para depurar nada.';

CREATE OR REPLACE FUNCTION public.purgar_hotmart_pii(p_dias INTEGER DEFAULT 400)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_filas INTEGER;
BEGIN
    UPDATE public.hotmart_ventas
       SET comprador_email    = NULL,
           comprador_nombre   = NULL,
           comprador_telefono = NULL,
           comprador_doc      = NULL
     WHERE fecha_venta < CURRENT_DATE - p_dias
       AND (comprador_email IS NOT NULL OR comprador_nombre IS NOT NULL
            OR comprador_telefono IS NOT NULL OR comprador_doc IS NOT NULL);
    GET DIAGNOSTICS v_filas = ROW_COUNT;
    RETURN v_filas;
END;
$$;

COMMENT ON FUNCTION public.purgar_hotmart_pii(INTEGER) IS
    'Anonimiza los datos del comprador en ventas de más de N días (400 por defecto). Los importes y la atribución se conservan intactos: el informe histórico no cambia.';

-- Esta es la purga que PAGA el espacio de hotmart_ventas: el crudo de
-- sales_events crecería sin techo en cuanto los webhooks entren de verdad
-- (~4-6 KB por evento, y hoy la tabla está a 0 filas justo porque no entran).
-- Vive en `public` aunque opere sobre `report_utm`: el planificador la invoca por
-- RPC con el cliente por defecto, y una función en otro esquema exigiría
-- `.schema('report_utm')` en el único sitio del planner que no lo usa.
CREATE OR REPLACE FUNCTION public.purgar_sales_events_raw(p_dias INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_filas INTEGER;
BEGIN
    UPDATE report_utm.sales_events
       SET raw_payload = NULL
     WHERE raw_payload IS NOT NULL
       AND received_at < now() - (p_dias || ' days')::interval;
    GET DIAGNOSTICS v_filas = ROW_COUNT;
    RETURN v_filas;
END;
$$;

COMMENT ON FUNCTION public.purgar_sales_events_raw(INTEGER) IS
    'Vacía raw_payload de los eventos de venta de más de N días (90 por defecto). El crudo de Hotmart sobrevive en hotmart_ventas.raw_payload otros 90 días más.';

-- ────────────────────────────────────────────────────────────────
-- RLS
--
-- El módulo consulta con service role (`createAdminClient`), que salta RLS; se
-- habilita para que sea seguro si algún día se lee desde el cliente.
--
-- Se usa `public.is_superadmin()` (migración 041) en vez del correo cableado que
-- arrastran las políticas antiguas (`auth.jwt() ->> 'email' = '...'`): esa forma
-- deja de funcionar en cuanto cambia la persona.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.hotmart_ventas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Clients view own hotmart_ventas" ON public.hotmart_ventas;
CREATE POLICY "Clients view own hotmart_ventas" ON public.hotmart_ventas
    FOR SELECT
    USING (cliente_id IN (SELECT id FROM public.clientes WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Admin full access hotmart_ventas" ON public.hotmart_ventas;
CREATE POLICY "Admin full access hotmart_ventas" ON public.hotmart_ventas
    FOR ALL
    USING (public.is_superadmin());
