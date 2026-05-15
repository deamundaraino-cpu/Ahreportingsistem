-- Migration 015: Add archived column to cliente_tabs
-- Archived tabs are hidden from the main tab bar but accessible via the archive view.

ALTER TABLE public.cliente_tabs
ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
