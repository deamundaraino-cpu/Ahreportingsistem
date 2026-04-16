-- Migration 002: Campaign Integrity
-- Adds sync_hash column for idempotency checking on daily metric syncs.
-- Run this in Supabase SQL Editor before deploying worker changes.

ALTER TABLE public.metricas_diarias ADD COLUMN IF NOT EXISTS sync_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_metricas_sync_hash
    ON public.metricas_diarias(cliente_id, fecha, sync_hash);

COMMENT ON COLUMN public.metricas_diarias.sync_hash IS
    'Hash of the synced payload. Used to skip re-upserts when data has not changed.';
