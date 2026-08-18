-- ════════════════════════════════════════════════════════════════
-- Migration 073: Segmentos de campo de lead (una respuesta como MÉTRICA)
-- ════════════════════════════════════════════════════════════════
-- La migración 060 dejó los campos de lead como DIMENSIÓN: agrupan y filtran,
-- pero no devuelven un número. Eso deja sin respuesta la pregunta que el equipo
-- hace todos los días —«¿cuánto me cuesta un lead que gana más de 2 millones?»—
-- y, como no se puede pedir, se fabrica a mano. En producción:
--
--   • Goodprop tiene CUATRO campos sobre la MISMA pregunta
--     (`leads_totales`, `leads_desde_1_3m`, `leads_desde1_6m`, `leads_desde_2m`),
--     cada uno mapeando N valores a UN bucket. Son tres umbrales acumulados y un
--     total, modelados como cuatro dimensiones de un solo valor. Los dos con
--     `sin_mapear = 'crudo'` además dejan escapar el resto de respuestas como
--     buckets sueltos.
--
--   • Cris tributario tiene TRES campos sobre la misma clave con `valores_map`
--     vacío: hoy no hacen absolutamente nada.
--
-- Un "segmento" es un subconjunto con nombre de los buckets de un campo —
-- «Desde 2M» = estos tres buckets — que se ofrece como MÉTRICA en los informes
-- del BI y en el dashboard. Es el equivalente exacto de `public.sheet_campo_vistas`
-- (migración 058), que resolvió esto mismo para las columnas de Google Sheets.
--
-- Dos diferencias con las vistas de Sheet, y las dos simplifican:
--
--   • NO hay columna `agregacion`. Un segmento cuenta CONTACTOS; `lead_events` no
--     tiene ninguna columna numérica que sumar por bucket. Las agregaciones
--     numéricas de una respuesta ya existen como `fieldagg:<agg>:<clave>`. Como
--     `count` es aditivo entre días, el dashboard tampoco necesita los sumandos
--     `__num`/`__den`/`__min`/`__max` que sí llevan los campos de Sheet.
--
--   • NO hay columna `formato`. Un conteo de contactos siempre es un número; un
--     «% en 2M+» es la fórmula `lseg__x / utm_leads`, no un formato.
--
-- Un segmento SOLAPA buckets a propósito: es lo que resuelve los acumulados (≥X)
-- sin un campo por umbral. Por eso NO entra en la suma del dashboard
-- «respuestas + sin_respuesta = utm_leads», que sigue cerrando con los buckets.
--
-- Y por eso mismo un segmento es una MEDIDA y nunca un filtro: al no recortar el
-- ámbito de la consulta, `spend / lseg__desde_2m` es el costo por lead de ese
-- segmento y NO activa la regla del gasto no atribuible (que sigue anulando el
-- gasto cuando hay un filtro `leadfield:` activo). Ver docs 17 y 18.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS report_utm.lead_campo_segmentos (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id   UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
    campo_id     UUID NOT NULL REFERENCES report_utm.lead_campos(id) ON DELETE CASCADE,
    -- Token `leadseg:<clave>` / alias de fórmula `lseg__<clave>`.
    clave        TEXT NOT NULL,
    nombre       TEXT NOT NULL,
    descripcion  TEXT,
    operador     TEXT NOT NULL DEFAULT 'in'
                 CHECK (operador IN ('in', 'not_in')),
    -- Buckets del campo padre, tal como los produce su `valores_map`.
    valores      TEXT[] NOT NULL DEFAULT '{}',
    activo       BOOLEAN NOT NULL DEFAULT TRUE,
    orden        INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cliente_id, clave)
);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_segmentos_campo
    ON report_utm.lead_campo_segmentos (campo_id, activo);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_segmentos_cliente
    ON report_utm.lead_campo_segmentos (cliente_id, activo, orden);

COMMENT ON TABLE report_utm.lead_campo_segmentos IS
    'Subconjunto con nombre de los buckets de un campo de lead, ofrecido como MÉTRICA (token leadseg:<clave>, alias lseg__<clave>). Solapa buckets a propósito para resolver los acumulados (>=X), por lo que NO entra en la suma respuestas + sin_respuesta = utm_leads.';
COMMENT ON COLUMN report_utm.lead_campo_segmentos.clave IS
    'Slug inmutable tras el alta: es la parte pública del token leadseg:<clave> guardado en bi_reports y en las fórmulas de las pestañas.';
COMMENT ON COLUMN report_utm.lead_campo_segmentos.valores IS
    'Buckets del campo padre que el segmento incluye (operador=in) o excluye (not_in). Un lead que no respondió la pregunta nunca entra, ni siquiera con not_in.';

-- ────────────────────────────────────────────────────────────────
-- updated_at automático (la función la crea la migración 060)
-- ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_rutm_lead_segmentos_updated ON report_utm.lead_campo_segmentos;
CREATE TRIGGER trg_rutm_lead_segmentos_updated
    BEFORE UPDATE ON report_utm.lead_campo_segmentos
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────
-- RLS — mismo patrón que la 060: gestiona el admin, leen también los traffickers.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.lead_campo_segmentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage rutm_lead_segmentos" ON report_utm.lead_campo_segmentos;
CREATE POLICY "Admin manage rutm_lead_segmentos"
    ON report_utm.lead_campo_segmentos FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_segmentos" ON report_utm.lead_campo_segmentos;
CREATE POLICY "Viewers read rutm_lead_segmentos"
    ON report_utm.lead_campo_segmentos FOR SELECT
    USING (report_utm.can_view());
