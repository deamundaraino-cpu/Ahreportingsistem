-- ════════════════════════════════════════════════════════════════
-- Migration 066: soporte para la integración de Hotmart rehecha
-- ════════════════════════════════════════════════════════════════
-- Cambios pequeños y aditivos que la migración 065 necesita alrededor:
--
--   1. Tipos de job nuevos en la cola (`hotmart_ventas`, `hotmart_reconciliar`).
--      Hasta ahora Hotmart se sincronizaba DENTRO del job `metricas`, así que
--      no se podía re-pedir solo Hotmart ni reclasificar sin volver a llamar a
--      Meta, TikTok y GA4.
--
--   2. Puente `sales_events.hotmart_venta_id`. Las dos tablas conviven:
--      hotmart_ventas manda en dinero y clasificación, sales_events conserva el
--      crudo, la atribución y el resto de pasarelas (Cartpanda, Shopify).
--
--   3. `integrations.webhook_secret_enc`. El secreto del webhook se guardaba EN
--      CLARO (migración 012:69) aunque `src/lib/report-utm/encryption.ts`
--      (AES-256-GCM) existe desde entonces y hasta se importa en el archivo que
--      lo escribe, sin usarse para esto.
--
--   4. RPC `fusionar_config_api`. Tres sitios distintos hacían read-modify-write
--      sobre `clientes.config_api` (el callback de OAuth, el cron de refresco y
--      el worker). Los tres leían el JSONB entero, le añadían sus claves y lo
--      reescribían: dos que corrieran a la vez se pisaban, y el que perdía se
--      llevaba por delante el token recién refrescado del otro.
--
--   5. Documentar las claves nuevas de `cliente_tabs.hotmart_funnel`.
--
-- REVERSIBLE:
--   ALTER TABLE public.sync_jobs DROP CONSTRAINT sync_jobs_tipo_check;
--   ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo IN (
--       'metricas','sheets_leads','sheets_conversiones','meta_leads',
--       'utm_aggregate','cierre_mes','reconciliar'));
--   ALTER TABLE report_utm.sales_events DROP COLUMN IF EXISTS hotmart_venta_id;
--   ALTER TABLE report_utm.integrations DROP COLUMN IF EXISTS webhook_secret_enc;
--   DROP FUNCTION IF EXISTS public.fusionar_config_api(uuid, jsonb);
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Tipos de job de Hotmart
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_tipo_check;
ALTER TABLE public.sync_jobs ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo IN (
    'metricas', 'sheets_leads', 'sheets_conversiones',
    'meta_leads', 'utm_aggregate', 'cierre_mes',
    'reconciliar',
    -- Trae las ventas de Hotmart de un rango a `hotmart_ventas`. Con
    -- params.reclasificar = true solo reescribe tipo/tab_id, SIN llamar a la API.
    'hotmart_ventas',
    -- Reescanea una ventana móvil buscando reembolsos y chargebacks. Hace falta
    -- un job aparte porque `sales/history` filtra por FECHA DE COMPRA: un
    -- reembolso de hoy sobre una compra de hace un mes no aparece hoy.
    'hotmart_reconciliar'
));

-- ────────────────────────────────────────────────────────────────
-- 2. Puente hacia la tabla de hechos
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.sales_events
    ADD COLUMN IF NOT EXISTS hotmart_venta_id UUID;

COMMENT ON COLUMN report_utm.sales_events.hotmart_venta_id IS
    'Fila equivalente en public.hotmart_ventas, cuando platform = hotmart. Sin FK a propósito: cruza esquemas y no queremos acoplar los DROP de uno al otro.';

-- Sin índice: la navegación va de hotmart_ventas.sales_event_id hacia aquí (por
-- PK), no al revés. Un índice más son ~1 MB que no compra nada.

-- ────────────────────────────────────────────────────────────────
-- 3. Secreto del webhook cifrado
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.integrations
    ADD COLUMN IF NOT EXISTS webhook_secret_enc TEXT;

COMMENT ON COLUMN report_utm.integrations.webhook_secret_enc IS
    'webhook_secret cifrado con AES-256-GCM (src/lib/report-utm/encryption.ts). La columna en claro se conserva para la migración perezosa: se lee de la que haya y se reescribe cifrada. Cuando ninguna fila tenga ya webhook_secret, la columna vieja se puede soltar.';

-- ────────────────────────────────────────────────────────────────
-- 4. Fusión atómica de config_api
--
-- `config_api = config_api || parche` en UNA sentencia. Postgres resuelve el
-- conflicto en la fila bloqueada, así que dos escritores concurrentes ya no se
-- pisan: el segundo aplica su parche sobre el resultado del primero.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fusionar_config_api(
    p_cliente_id UUID,
    p_parche     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_config JSONB;
BEGIN
    UPDATE public.clientes
       SET config_api = COALESCE(config_api, '{}'::jsonb) || p_parche
     WHERE id = p_cliente_id
    RETURNING config_api INTO v_config;
    RETURN v_config;
END;
$$;

COMMENT ON FUNCTION public.fusionar_config_api(UUID, JSONB) IS
    'Aplica un parche a clientes.config_api en una sola sentencia. Sustituye al read-modify-write que hacían el callback de OAuth, el cron de refresco y el worker: los tres reescribían el JSONB entero y se pisaban entre sí, perdiendo tokens recién refrescados.';

-- ────────────────────────────────────────────────────────────────
-- 5. Claves nuevas del embudo
-- ────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.cliente_tabs.hotmart_funnel IS
    'Configuración del embudo Hotmart de la pestaña. Clasificación por CÓDIGO DE OFERTA (estable, sobrevive a renombrar el producto) con los nombres como red de seguridad:
{
  "enabled": true,
  "principal_offers": ["x7k2p9"], "bump_offers": [], "upsell_offers": [], "downsell_offers": [],
  "principal_names": ["Camaradictos%"], "bump_names": [], "upsell_names": [], "downsell_names": [],
  "landing_page_urls": [], "payment_page_url": "...", "upsell_page_url": "...",
  "principal_price_usd": 97
}
Los *_offers ganan sobre los *_names. Un funnel sin las claves nuevas clasifica exactamente igual que antes de la migración 065.';
