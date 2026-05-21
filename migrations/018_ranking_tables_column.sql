-- migrations/018_ranking_tables_column.sql
ALTER TABLE clientes_layouts ADD COLUMN IF NOT EXISTS ranking_tables JSONB DEFAULT '[]'::jsonb;
ALTER TABLE cliente_tabs     ADD COLUMN IF NOT EXISTS ranking_tables JSONB DEFAULT NULL;
