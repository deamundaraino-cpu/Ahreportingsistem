-- ════════════════════════════════════════════════════════════════
-- Migration 091: Preguntas de formulario tal como las publica cada plataforma
-- ════════════════════════════════════════════════════════════════
-- Sale de la auditoría de respuestas de formulario del 2026-09-26.
--
-- Hasta hoy nada sabía QUÉ tipo de pregunta es cada clave de `raw_fields` ni
-- cuáles son sus opciones: se adivinaba con estadística (≤ 30 valores distintos
-- = desplegable), que falla con las opciones poco elegidas y con las preguntas
-- nuevas. Y la información existía en origen y se tiraba:
--
--   • Meta Lead Ads publica `questions` en cada formulario (clave, etiqueta,
--     tipo y opciones), pero `listLeadForms` solo pedía `id,name`.
--   • GoHighLevel devuelve `picklistOptions` en cada custom field, pero
--     `fetchCustomFields` solo guardaba id y nombre.
--   • El plugin de WordPress conoce el tipo y las opciones de cada campo
--     (Gravity Forms, WPForms, Elementor) y no las enviaba.
--
-- Esta tabla guarda esa definición, una fila por (fuente, formulario, clave).
-- La pantalla de Leads la usa para «Activar» una pregunta en un clic con sus
-- respuestas reales ya nombradas y ordenadas, y para añadir solas las opciones
-- nuevas (`lead_campos.sincronizar_opciones`, migración 090).
--
-- Es una tabla pequeña (decenas de filas por cliente) y se escribe solo cuando
-- la definición cambia (`firma`), no con cada lead.
--
-- REVERSIBLE:
--   DROP TABLE IF EXISTS report_utm.lead_preguntas;
--
--   npx tsx scripts/sql-remoto.ts migrations/091_lead_preguntas.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS report_utm.lead_preguntas (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id     UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
    fuente         TEXT NOT NULL CHECK (fuente IN ('meta', 'ghl', 'wordpress', 'detectado')),
    -- Formulario de origen ('' si la fuente no distingue formularios).
    form_id        TEXT NOT NULL DEFAULT '',
    form_name      TEXT,
    -- La clave tal como llega a raw_fields, y su forma canónica (norm_clave).
    clave_origen   TEXT NOT NULL,
    clave_norm     TEXT NOT NULL,
    etiqueta       TEXT,
    tipo           TEXT NOT NULL DEFAULT 'desconocido'
                   CHECK (tipo IN ('opcion', 'multiple', 'texto', 'numero', 'email',
                                   'telefono', 'fecha', 'desconocido')),
    -- [{valor, etiqueta}]: el valor que llega en raw_fields y su texto visible.
    opciones       JSONB NOT NULL DEFAULT '[]'::jsonb
                   CHECK (jsonb_typeof(opciones) = 'array'),
    -- Huella de la definición: solo se reescribe la fila si cambia.
    firma          TEXT,
    visto_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cliente_id, fuente, form_id, clave_norm)
);

CREATE INDEX IF NOT EXISTS idx_lead_preguntas_cliente
    ON report_utm.lead_preguntas (cliente_id, clave_norm);

COMMENT ON TABLE report_utm.lead_preguntas IS
    'Preguntas de formulario con su tipo y sus opciones, tal como las publica cada plataforma (Meta Lead Ads, GoHighLevel, plugin de WordPress). Alimenta la activación de un clic de la pantalla de Leads. Migración 091.';

-- RLS — mismo patrón que lead_campos (060) y lead_campo_segmentos (073):
-- gestiona el admin, leen también los traffickers. La escritura real la hace el
-- servidor con service_role al sincronizar formularios.
ALTER TABLE report_utm.lead_preguntas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage rutm_lead_preguntas" ON report_utm.lead_preguntas;
CREATE POLICY "Admin manage rutm_lead_preguntas"
    ON report_utm.lead_preguntas FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_preguntas" ON report_utm.lead_preguntas;
CREATE POLICY "Viewers read rutm_lead_preguntas"
    ON report_utm.lead_preguntas FOR SELECT
    USING (report_utm.can_view());

NOTIFY pgrst, 'reload schema';
