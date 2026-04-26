-- ============================================================
-- Migration 008: Sistema de Funnels Hotmart por pestaña
-- ============================================================
-- Convierte el modelo viejo (1 cliente = 1 funnel principal/bump/upsell
-- a nivel cliente) en un modelo donde cada `cliente_tab` es un funnel
-- independiente con su propia configuración de productos y URLs de GA4.
--
-- Limpieza: elimina las claves viejas de config_api (`hotmart_principal_names`,
-- `hotmart_bump_names`, `hotmart_upsell_names`) — partimos de cero.
-- ============================================================

-- ─── 1. cliente_tabs: nueva configuración de funnel por pestaña ──
ALTER TABLE public.cliente_tabs
ADD COLUMN IF NOT EXISTS hotmart_funnel JSONB;

COMMENT ON COLUMN public.cliente_tabs.hotmart_funnel IS
'Configuración del funnel Hotmart de la pestaña. Estructura:
{
  "enabled": true,
  "principal_names": ["Camaradictos Pro", "Camaradictos%"],
  "bump_names": ["Bump Camaradictos"],
  "upsell_names": ["Upsell Camaradictos"],
  "payment_page_url": "/checkout/camaradictos",
  "upsell_page_url": "/upsell/camaradictos"
}';

-- ─── 2. metricas_diarias: nuevo desglose granular por funnel ─────
ALTER TABLE public.metricas_diarias
ADD COLUMN IF NOT EXISTS hotmart_funnel_data JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.metricas_diarias.hotmart_funnel_data IS
'Desglose por funnel Hotmart del día. Estructura:
{
  "by_tab": {
    "<tab_id>": {
      "principal": { "count": 19, "gross": 361, "net": 275.5 },
      "bump":      { "count": 3,  "net": 16.2 },
      "upsell":    { "count": 1,  "net": 18.99, "page_visits": 24 },
      "pagos_iniciados": 30
    }
  },
  "extras": [
    { "product_name": "Otro Producto", "count": 2, "gross": 38.0, "net": 35.4 }
  ]
}';

-- ─── 3. metricas_diarias: nuevas columnas escalares para totales globales ──
ALTER TABLE public.metricas_diarias
ADD COLUMN IF NOT EXISTS ventas_principal_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ventas_bump_count      INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ventas_upsell_count    INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS ventas_principal_bruto DECIMAL DEFAULT 0;

COMMENT ON COLUMN public.metricas_diarias.ventas_principal_bruto IS
'Facturación bruta del producto principal (purchase.price.value × #ventas). Suma de todos los funnels + extras.';

-- ─── 4. Limpieza: eliminar config viejo a nivel cliente ──────────
UPDATE public.clientes
SET config_api = config_api
    - 'hotmart_principal_names'
    - 'hotmart_bump_names'
    - 'hotmart_upsell_names';

-- ─── 5. Index GIN para queries rápidas sobre funnel data ─────────
CREATE INDEX IF NOT EXISTS idx_metricas_diarias_funnel_data
ON public.metricas_diarias USING GIN (hotmart_funnel_data);

CREATE INDEX IF NOT EXISTS idx_cliente_tabs_funnel
ON public.cliente_tabs USING GIN (hotmart_funnel);

-- ============================================================
-- Migration completed
-- ============================================================
