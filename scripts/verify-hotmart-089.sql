-- ════════════════════════════════════════════════════════════════
-- Casos de la migración 089 (guarda por estado + atribución)
-- ════════════════════════════════════════════════════════════════
-- NO se ejecuta a pelo: lo lanza scripts/verify-hotmart-089.ts, que antepone
-- la migración entera y lo manda todo en UNA petición. El bloque termina con
-- RAISE EXCEPTION a propósito: la Management API ejecuta la petición como una
-- transacción, así que la excepción la aborta ENTERA (migración incluida) y el
-- resultado viaja en el mensaje de error. Nada queda escrito, se haya aplicado
-- la 089 o no.
--
-- Lo que comprueba, en el orden en que Hotmart lo rompía:
--   · webhook primero y API después: la API RELLENA las comisiones  (2)
--   · un APPROVED tardío no resucita una venta reembolsada           (4-5)
--   · un estado más avanzado de la API se aplica aunque sea viejo    (6)
--   · y después ningún reintento viejo lo deshace                    (7)
--   · un estado cobrado no vuelve a pendiente                        (8)
--   · el tracking no lo pisa un lead; un lead sí rellena una venta
--     sin tupla, y el tracking posterior lo sustituye                (9-11)
--   · una reversión limpia reembolsada_at                            (12)
--   · las dos funciones nuevas/ampliadas responden                   (13-14)
-- ════════════════════════════════════════════════════════════════

DO $prueba$
DECLARE
    -- Cris tributario (public.clientes). Las transacciones son inventadas.
    c        UUID := '1bf00bdb-38e7-4070-96b9-f00aa05db73f';
    rtm      UUID;
    r        RECORD;
    v        public.hotmart_ventas%ROWTYPE;
    k        BIGINT;
    res      JSONB := '[]'::jsonb;
    base     JSONB;
BEGIN
    SELECT id INTO rtm FROM report_utm.clientes WHERE public_cliente_id = c LIMIT 1;

    base := jsonb_build_object(
        'cliente_id', c, 'fecha_venta', '2026-08-10', 'moneda', 'CLP', 'bruto', 18684,
        'aprobada_at', '2026-08-10T15:00:00Z', 'orden_at', '2026-08-10T14:58:00Z',
        'tipo', 'principal', 'clasificacion_origen', 'oferta'
    );

    -- (1) Webhook APPROVED con tracking: inserta.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'aprobada', 'origen', 'webhook',
        'evento_ts', '2026-08-10T15:00:05Z', 'bruto_usd', 20.14,
        'utm_source', 'facebook', 'utm_campaign', 'CAMP_TRACK', 'utm_id', '120200000000000001',
        'atribucion_metodo', 'tracking'));
    res := res || jsonb_build_object('paso', 1, 'caso', 'webhook nuevo inserta',
        'ok', r.escrita IS TRUE);

    -- (2) API después, evento_ts = approved_date (más VIEJO): rellena comisiones.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z', 'neto_productor_usd', 9.70, 'bruto_usd', 20.14));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__A';
    res := res || jsonb_build_object('paso', 2,
        'caso', 'API vieja rellena la comisión sin mover estado ni UTM',
        'ok', r.escrita IS FALSE AND v.neto_productor_usd = 9.70 AND v.estado = 'aprobada'
              AND v.origen = 'webhook' AND v.utm_campaign = 'CAMP_TRACK');

    -- (3) Webhook REFUNDED más nuevo.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'reembolsada', 'origen', 'webhook',
        'evento_ts', '2026-08-15T10:00:00Z', 'reembolsada_at', '2026-08-15T10:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__A';
    res := res || jsonb_build_object('paso', 3, 'caso', 'webhook REFUNDED se aplica',
        'ok', r.escrita IS TRUE AND v.estado = 'reembolsada' AND v.reembolsada_at IS NOT NULL
              AND v.neto_productor_usd = 9.70);

    -- (4) Reintento tardío del webhook APPROVED: no resucita.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'aprobada', 'origen', 'webhook',
        'evento_ts', '2026-08-10T15:00:05Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__A';
    res := res || jsonb_build_object('paso', 4, 'caso', 'APPROVED tardío del webhook no resucita',
        'ok', r.escrita IS FALSE AND v.estado = 'reembolsada');

    -- (5) La API con approved_date tampoco.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__A';
    res := res || jsonb_build_object('paso', 5, 'caso', 'APPROVED de la API no resucita',
        'ok', r.escrita IS FALSE AND v.estado = 'reembolsada');

    -- (6) Solo API: aprobada y luego REFUNDED con el MISMO evento_ts viejo.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__B', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z'));
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__B', 'estado', 'reembolsada', 'origen', 'reconciliacion',
        'evento_ts', '2026-08-10T15:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__B';
    res := res || jsonb_build_object('paso', 6,
        'caso', 'reembolso de la API avanza y sube evento_ts a now()',
        'ok', r.escrita IS TRUE AND v.estado = 'reembolsada' AND v.evento_ts >= now() - interval '1 minute'
              AND v.reembolsada_at IS NOT NULL);

    -- (7) Y el siguiente APPROVED de la API (mismo approved_date) no lo deshace.
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__B', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__B';
    res := res || jsonb_build_object('paso', 7, 'caso', 'la API no deshace su propio reembolso',
        'ok', r.escrita IS FALSE AND v.estado = 'reembolsada');

    -- (8) Un evento más nuevo que acaba en «pendiente» no baja una venta cobrada.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__C', 'estado', 'aprobada', 'origen', 'webhook',
        'evento_ts', '2026-08-10T15:00:05Z'));
    SELECT * INTO r FROM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__C', 'estado', 'pendiente', 'origen', 'webhook',
        'evento_ts', '2026-08-20T10:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__C';
    res := res || jsonb_build_object('paso', 8, 'caso', 'cobrada no vuelve a pendiente',
        'ok', r.escrita IS FALSE AND v.estado = 'aprobada');

    -- (9) Un lead no pisa el tracking de A.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__A', 'estado', 'reembolsada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z',
        'utm_campaign', 'CAMP_LEAD', 'utm_source', 'google', 'atribucion_metodo', 'lead_email'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__A';
    res := res || jsonb_build_object('paso', 9, 'caso', 'un lead no pisa el tracking',
        'ok', v.utm_campaign = 'CAMP_TRACK' AND v.utm_source = 'facebook'
              AND v.atribucion_metodo = 'tracking');

    -- (10) Una venta sin tupla sí la hereda del lead, como bloque.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__D', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z', 'utm_source', 'hotmart_src'));
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__D', 'estado', 'aprobada', 'origen', 'api',
        'evento_ts', '2026-08-10T15:00:00Z',
        'utm_campaign', 'CAMP_LEAD', 'utm_content', 'AD_LEAD',
        'atribucion_metodo', 'lead_email', 'atribucion_lead_id', gen_random_uuid()));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__D';
    res := res || jsonb_build_object('paso', 10, 'caso', 'el lead aporta la tupla entera',
        'ok', v.utm_campaign = 'CAMP_LEAD' AND v.utm_content = 'AD_LEAD'
              AND v.utm_source IS NULL AND v.atribucion_metodo = 'lead_email'
              AND v.atribucion_lead_id IS NOT NULL AND v.atribucion_at IS NOT NULL);

    -- (11) Y el tracking que llega después sustituye a la del lead.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__D', 'estado', 'aprobada', 'origen', 'webhook',
        'evento_ts', '2026-08-10T15:00:05Z',
        'utm_campaign', 'CAMP_TRACK_D', 'atribucion_metodo', 'tracking'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__D';
    res := res || jsonb_build_object('paso', 11, 'caso', 'el tracking sustituye al lead',
        'ok', v.utm_campaign = 'CAMP_TRACK_D' AND v.utm_content IS NULL
              AND v.atribucion_metodo = 'tracking' AND v.atribucion_lead_id IS NULL);

    -- (12) Reversión: reembolsada → aprobada por un evento más nuevo limpia la fecha.
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__E', 'estado', 'reembolsada', 'origen', 'webhook',
        'evento_ts', '2026-08-15T10:00:00Z', 'reembolsada_at', '2026-08-15T10:00:00Z'));
    PERFORM public.guardar_hotmart_venta(base || jsonb_build_object(
        'transaction_id', '__PRUEBA089__E', 'estado', 'aprobada', 'origen', 'webhook',
        'evento_ts', '2026-08-16T10:00:00Z'));
    SELECT * INTO v FROM public.hotmart_ventas WHERE cliente_id = c AND transaction_id = '__PRUEBA089__E';
    res := res || jsonb_build_object('paso', 12, 'caso', 'una reversión limpia reembolsada_at',
        'ok', v.estado = 'aprobada' AND v.reembolsada_at IS NULL);

    -- (13) Candidatos de lead: responde (el número depende de los datos).
    SELECT count(*) INTO k FROM public.hotmart_leads_para_atribucion(
        rtm, ARRAY['__nadie__@ejemplo.invalid'], ARRAY['000000000'],
        '2026-01-01'::timestamptz, '2027-01-01'::timestamptz);
    res := res || jsonb_build_object('paso', 13, 'caso', 'hotmart_leads_para_atribucion responde',
        'ok', rtm IS NOT NULL AND k = 0);

    -- (14) La lista blanca ampliada admite utm_campaign y atribucion_metodo.
    SELECT count(*) INTO k FROM public.hotmart_valores_conteo(c, 'utm_campaign', '2026-08-01', '2026-08-31', 50);
    SELECT count(*) + k INTO k FROM public.hotmart_valores_conteo(c, 'atribucion_metodo', '2026-08-01', '2026-08-31', 50);
    res := res || jsonb_build_object('paso', 14, 'caso', 'hotmart_valores_conteo admite UTM',
        'ok', k >= 2);

    RAISE EXCEPTION 'RESULTADO089 %', res::text;
END
$prueba$;
