-- migrations/048_fx_rates.sql
-- Tasas de cambio diarias para convertir ventas de Hotmart a USD.
--
-- El worker solo sumaba las comisiones y el bruto cuando la moneda era USD
-- (src/app/api/worker/route.ts): cualquier venta en COP, BRL, EUR, MXN… se
-- registraba como 0, dejando el ROAS en cero pese a haber facturado. Ahora se
-- convierte con la tasa del día, cacheada aquí para no volver a pedirla.
--
-- `usd_rate` = cuántos USD vale 1 unidad de `moneda`.
--   Ej.: moneda='COP', usd_rate=0.00025  →  100.000 COP = 25 USD
--   USD siempre vale 1 y se inserta como semilla.

CREATE TABLE IF NOT EXISTS public.fx_rates (
    fecha       date        NOT NULL,
    moneda      text        NOT NULL,
    usd_rate    numeric     NOT NULL CHECK (usd_rate > 0),
    fuente      text        NOT NULL DEFAULT 'open.er-api.com',
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (fecha, moneda)
);

COMMENT ON TABLE  public.fx_rates IS 'Tasas de cambio diarias a USD. Cache local de la API de FX.';
COMMENT ON COLUMN public.fx_rates.usd_rate IS 'USD por 1 unidad de la moneda. USD = 1.';

CREATE INDEX IF NOT EXISTS idx_fx_rates_moneda_fecha
    ON public.fx_rates (moneda, fecha DESC);

-- Semilla: USD siempre 1 para la fecha de instalación (el helper hace fallback a
-- la última tasa conocida, así que basta una fila para que USD nunca falle).
INSERT INTO public.fx_rates (fecha, moneda, usd_rate, fuente)
VALUES (CURRENT_DATE, 'USD', 1, 'seed')
ON CONFLICT (fecha, moneda) DO NOTHING;

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

-- Solo el service role (worker) escribe; lectura abierta a usuarios autenticados.
DROP POLICY IF EXISTS "fx_rates_read" ON public.fx_rates;
CREATE POLICY "fx_rates_read" ON public.fx_rates
    FOR SELECT TO authenticated USING (true);
