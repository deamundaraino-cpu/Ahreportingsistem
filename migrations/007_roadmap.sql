-- 007_roadmap.sql — Reconvierte soporte_tickets en ítems de Roadmap (bugs + implementaciones)

-- tipo (con default => backfill automático de filas existentes a 'tarea')
ALTER TABLE public.soporte_tickets
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'tarea';

ALTER TABLE public.soporte_tickets
  DROP CONSTRAINT IF EXISTS soporte_tickets_tipo_check;

ALTER TABLE public.soporte_tickets
  ADD CONSTRAINT soporte_tickets_tipo_check CHECK (tipo IN ('bug','feature','mejora','tarea'));

-- cliente_id pasa a opcional (ítems internos del producto)
ALTER TABLE public.soporte_tickets
  ALTER COLUMN cliente_id DROP NOT NULL;
