-- ════════════════════════════════════════════════════════════════
-- Migration 067: downsell y reembolsos en metricas_diarias
-- ════════════════════════════════════════════════════════════════
-- Dos huecos del reporting de clientes que la tabla `hotmart_ventas`
-- (migración 065) permite por fin rellenar:
--
--   • DOWNSELL. El concepto no existía en NINGÚN archivo del repositorio: ni
--     columna, ni patrón de nombre, ni categoría, ni métrica. Un downsell se
--     registraba como venta principal o caía a `extras[]`.
--
--   • REEMBOLSOS. `fetchHotmart` pedía la API con
--     `transaction_status=APPROVED&COMPLETE` (`worker/route.ts:1656-1657`), así
--     que una venta devuelta al día siguiente seguía contando como facturación
--     PARA SIEMPRE. Ni siquiera el cierre de mes los veía: repide el mes con el
--     mismo filtro.
--
-- ── El reembolso se imputa a la FECHA DE LA VENTA ───────────────
-- No a la fecha del reembolso. Es lo que hace que el ROAS de una campaña de
-- julio refleje lo que esa campaña dejó de verdad. La consecuencia hay que
-- asumirla explícitamente: **las cifras de un mes ya cerrado pueden bajar
-- semanas después**. Por eso se guarda aparte en vez de restarse en silencio —
-- el dashboard puede mostrar «facturado» y «devuelto» y que el cambio sea
-- visible en lugar de misterioso.
--
-- ── COSTE ───────────────────────────────────────────────────────
-- 5 columnas numéricas sobre 8.203 filas ≈ 0,3 MB. La base está en 449 MB de
-- 500 MB (ver la cabecera de la migración 065): cabe, pero el margen es real.
--
-- REVERSIBLE:
--   ALTER TABLE public.metricas_diarias
--     DROP COLUMN IF EXISTS ventas_downsell,
--     DROP COLUMN IF EXISTS ventas_downsell_count,
--     DROP COLUMN IF EXISTS ventas_downsell_bruto,
--     DROP COLUMN IF EXISTS ventas_reembolsado,
--     DROP COLUMN IF EXISTS ventas_reembolsado_count;
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.metricas_diarias
    ADD COLUMN IF NOT EXISTS ventas_downsell          NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_downsell_count    INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_downsell_bruto    NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_reembolsado       NUMERIC DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ventas_reembolsado_count INTEGER DEFAULT 0;

COMMENT ON COLUMN public.metricas_diarias.ventas_downsell IS
    'Neto en USD (comisión PRODUCER) de las ventas clasificadas como downsell. Agregado desde public.hotmart_ventas.';
COMMENT ON COLUMN public.metricas_diarias.ventas_downsell_bruto IS
    'Bruto en USD de las ventas de downsell del día.';
COMMENT ON COLUMN public.metricas_diarias.ventas_reembolsado IS
    'Neto en USD de las ventas de ESTE día que acabaron reembolsadas o en chargeback. Se imputa a la fecha de la venta original, no a la del reembolso: es lo que hace que el ROAS de la campaña refleje lo que realmente dejó. Consecuencia asumida: un mes cerrado puede bajar semanas después.';
COMMENT ON COLUMN public.metricas_diarias.ventas_reembolsado_count IS
    'Número de ventas de este día que acabaron reembolsadas o en chargeback.';
