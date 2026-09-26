-- ════════════════════════════════════════════════════════════════
-- Migration 092: Revisiones de informes BI — deshacer lo que hizo el agente
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría de las herramientas de informes del agente/MCP del
-- 2026-09-26. Crear y editar un informe pasa a aplicarse AL MOMENTO (antes cada
-- paso quedaba como propuesta aprobable solo por WhatsApp, y `create_report`
-- devolvía «pendiente» sin id al que añadir widgets). A cambio, cada escritura
-- guarda aquí el estado ANTERIOR del informe, y `restore_report_revision` lo
-- devuelve.
--
-- `report_id` va SIN clave foránea a propósito: la revisión tiene que
-- sobrevivir a `delete_report` para poder recrear el informe. `cliente_id` sí
-- la lleva, en cascada, como toda tabla con cliente (migración 080): borrar un
-- cliente borra también el historial de sus informes.
--
-- La snapshot NO guarda `public_token` ni `schedule`: restaurar nunca vuelve a
-- publicar un enlace que alguien retiró, ni reactiva envíos.
--
-- Se podan a las últimas 30 por informe desde el código
-- (`src/lib/agent/tools/informes/revisiones.ts`).
--
-- RLS activado y sin políticas: solo el service role (el agente) la lee y la
-- escribe, igual que las tablas del agente de la migración 078.
--
-- REVERSIBLE:
--   DROP TABLE IF EXISTS public.bi_report_revisions;
--
--   npx tsx scripts/sql-remoto.ts migrations/092_bi_report_revisions.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bi_report_revisions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id       UUID        NOT NULL,
    cliente_id      UUID        REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
    snapshot        JSONB       NOT NULL,
    motivo          TEXT        NOT NULL,
    resumen         TEXT,
    created_by      UUID,
    origin          TEXT,
    conversation_id UUID,
    token_id        UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bi_report_revisions_snapshot_object_check
        CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS bi_report_revisions_report_idx
    ON public.bi_report_revisions (report_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bi_report_revisions_cliente_idx
    ON public.bi_report_revisions (cliente_id);

ALTER TABLE public.bi_report_revisions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.bi_report_revisions IS
    'Estado anterior de un informe BI antes de cada escritura del agente/MCP: {nombre, descripcion, cliente_id, layout, filters, calculated_fields, is_template}. Sin FK en report_id para sobrevivir al borrado. Migración 092.';
COMMENT ON COLUMN public.bi_report_revisions.motivo IS
    'Herramienta que provocó la escritura (create_report, add_report_widget…).';

NOTIFY pgrst, 'reload schema';
