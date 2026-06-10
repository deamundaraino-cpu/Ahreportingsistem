-- ============================================================
-- Migration 009: Snapshot de suscripciones Hotmart
-- ============================================================
-- Las suscripciones de Hotmart son un ESTADO ACTUAL (no eventos por día),
-- por eso viven en su propia tabla — separadas de `metricas_diarias`.
-- El worker captura un snapshot por día (cliente_id, captured_date), lo que
-- genera una serie temporal de activas/canceladas/atrasadas y valor recurrente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hotmart_subscriptions_snapshot (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  captured_date DATE NOT NULL,
  captured_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),

  -- Conteos por grupo de estado
  active_count    INTEGER DEFAULT 0,   -- ACTIVE
  delayed_count   INTEGER DEFAULT 0,   -- DELAYED + OVERDUE
  inactive_count  INTEGER DEFAULT 0,   -- INACTIVE + STARTED
  canceled_count  INTEGER DEFAULT 0,   -- CANCELLED_BY_*
  total_count     INTEGER DEFAULT 0,   -- total de suscripciones devueltas

  -- Valor recurrente de las suscripciones ACTIVE (suma de price.value).
  -- OJO: NO está normalizado a mensual — mezcla periodicidades (mensual/anual/etc).
  -- Para MRR real, normalizar por recurrency_period en el dashboard.
  active_recurring_value DECIMAL DEFAULT 0,
  currency TEXT,

  -- Desgloses crudos para análisis flexible
  by_status  JSONB DEFAULT '{}'::jsonb,  -- { "ACTIVE": 120, "DELAYED": 8, ... }
  by_product JSONB DEFAULT '{}'::jsonb,  -- { "<product_name>": { active, recurring_value } }

  UNIQUE(cliente_id, captured_date)
);

COMMENT ON TABLE public.hotmart_subscriptions_snapshot IS
'Snapshot diario del estado de suscripciones Hotmart por cliente. Una fila por (cliente_id, captured_date).';

CREATE INDEX IF NOT EXISTS idx_hotmart_subs_cliente_date
ON public.hotmart_subscriptions_snapshot (cliente_id, captured_date DESC);

-- ============================================================
-- Migration completed
-- ============================================================
