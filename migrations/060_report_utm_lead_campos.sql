-- ════════════════════════════════════════════════════════════════
-- Migration 060: Campos de lead (catálogo por cliente)
-- ════════════════════════════════════════════════════════════════
-- Los formularios guardan TODAS sus respuestas en
-- `report_utm.lead_events.raw_fields` (JSONB plano {clave: valor}), y el BI ya
-- las ofrece como dimensión cruda `field:<clave>`. El problema es que el dato
-- crudo no cuadra para cruzarlo, y se ve en producción:
--
--   • La misma pregunta llega con claves distintas según el formulario:
--       Goodprop → "cual_es_tu_rango_de_ingresos"          (Meta Lead Ads)
--                  "¿cuál_es_tu_rango_aproximado_de_ingresos?" (web)
--     → hoy son DOS dimensiones y ningún informe suma los 12.129 leads.
--
--   • El mismo valor se escribe de dos formas y cuenta doble:
--       Sur Profundo → "Entre $2.000.000 a $3.000.000"  (424 leads)
--                      "Entre $2.000.000 – $3.000.000"  ( 30 leads)
--
--   • Meta normaliza a snake_case ("entre_$2.000.000_y_$4.000.000"), feo en un
--     informe de cliente, y los rangos se ordenan alfabéticamente en vez de de
--     menor a mayor.
--
-- Un "campo de lead" es la definición POR CLIENTE que arregla eso: nombre
-- visible, las claves crudas que unifica, el mapa de valores equivalentes y el
-- orden de presentación. El BI lo consume con el token `leadfield:<clave>`.
--
-- Es el mismo patrón de `public.sheet_campos` (migración 058) — que resolvió
-- este problema para las columnas de Google Sheets — con una diferencia que
-- simplifica mucho: aquí NO hace falta desglose diario derivado. Los leads se
-- consultan vivos desde `lead_events`, así que el catálogo se aplica en el
-- momento de la consulta y editarlo se refleja al instante, sin recálculo.
--
-- Por qué tabla propia y no `clientes.config`: `config` se lee entero en cada
-- carga del módulo, y el mapa de valores puede tener cientos de entradas por
-- campo. Además `clave` necesita unicidad real: es lo que queda guardado dentro
-- de los widgets de `bi_reports`.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS report_utm.lead_campos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id    UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,

    -- Slug estable [a-z0-9_]: es la parte pública del token `leadfield:<clave>`
    -- que queda guardado en los widgets. Renombrar `nombre` no lo toca, así que
    -- los informes ya creados no se rompen al cambiar la etiqueta.
    clave         TEXT NOT NULL,
    -- Nombre visible en el editor, en los filtros y en las columnas de tabla.
    nombre        TEXT NOT NULL,
    descripcion   TEXT,

    -- Claves de `raw_fields` que este campo unifica. Varias porque la misma
    -- pregunta cambia de nombre entre el formulario web y el de Meta.
    claves_origen TEXT[] NOT NULL DEFAULT '{}',

    -- Normalización de valores: { <valor crudo normalizado> : <bucket> }.
    -- Ej: { "entre $2.000.000 a $3.000.000": "$2M a $3M",
    --       "entre $2.000.000 - $3.000.000": "$2M a $3M" }
    valores_map   JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Orden de presentación de los buckets. Es lo que hace que los rangos
    -- salgan de menor a mayor y no alfabéticamente.
    valores_orden TEXT[] NOT NULL DEFAULT '{}',

    -- Qué hacer con un valor que no está en el mapa.
    sin_mapear    TEXT NOT NULL DEFAULT 'crudo'
                  CHECK (sin_mapear IN ('crudo', 'otros', 'ignorar')),

    -- Tope de buckets distintos: superarlo marca el campo como de alta
    -- cardinalidad y deja de ofrecerse como dimensión (un campo apuntado a un
    -- correo produciría un eje con miles de categorías).
    max_valores   INTEGER NOT NULL DEFAULT 200,

    activo        BOOLEAN NOT NULL DEFAULT TRUE,
    orden         INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (cliente_id, clave)
);

CREATE INDEX IF NOT EXISTS idx_rutm_lead_campos_cliente
    ON report_utm.lead_campos (cliente_id, activo, orden);

COMMENT ON TABLE report_utm.lead_campos IS
    'Catálogo por cliente que unifica campos de formulario equivalentes (raw_fields) bajo un nombre y unos valores únicos. Se aplica en tiempo de consulta: no hay dato derivado que recalcular.';
COMMENT ON COLUMN report_utm.lead_campos.clave IS
    'Slug inmutable tras el alta: es la parte pública del token leadfield:<clave> guardado en bi_reports.';
COMMENT ON COLUMN report_utm.lead_campos.claves_origen IS
    'Claves de raw_fields que el campo unifica. La comparación es insensible a mayúsculas y acentos.';

-- ────────────────────────────────────────────────────────────────
-- updated_at automático (misma función que usan los campos de Sheet)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rutm_lead_campos_updated ON report_utm.lead_campos;
CREATE TRIGGER trg_rutm_lead_campos_updated
    BEFORE UPDATE ON report_utm.lead_campos
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────────────────────────────
-- RLS — mismo patrón que el resto de report_utm (migración 030):
-- gestiona el admin, leen también los traffickers.
-- ────────────────────────────────────────────────────────────────
ALTER TABLE report_utm.lead_campos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin manage rutm_lead_campos" ON report_utm.lead_campos;
CREATE POLICY "Admin manage rutm_lead_campos"
    ON report_utm.lead_campos FOR ALL
    USING (report_utm.is_admin())
    WITH CHECK (report_utm.is_admin());

DROP POLICY IF EXISTS "Viewers read rutm_lead_campos" ON report_utm.lead_campos;
CREATE POLICY "Viewers read rutm_lead_campos"
    ON report_utm.lead_campos FOR SELECT
    USING (report_utm.can_view());
