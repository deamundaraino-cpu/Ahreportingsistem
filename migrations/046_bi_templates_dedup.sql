-- migrations/046_bi_templates_dedup.sql
-- Deduplica las plantillas del SISTEMA y evita que se vuelvan a duplicar.
--
-- El seed de plantillas (032) se ejecutó dos veces, así que "Funnel Completo",
-- "Rendimiento por Fuente", "ROAS por Campaña" y "Tendencia de Leads" aparecían
-- por duplicado en el selector de "Nuevo informe": el usuario veía 8 plantillas
-- donde debía ver 4 (más "Reporte de Cliente", que sí es única).
--
-- Se conserva la copia MÁS ANTIGUA de cada nombre. Verificado antes de aplicar:
-- ninguna de las copias tiene link público (public_token) ni entregas asociadas
-- en bi_report_deliveries, así que borrar las recientes no rompe ningún enlace.
-- Solo afecta a plantillas del sistema (created_by IS NULL): las plantillas que
-- crea el equipo pueden repetir nombre libremente.

DELETE FROM public.bi_reports b
USING (
    SELECT id, row_number() OVER (PARTITION BY nombre ORDER BY created_at) AS rn
    FROM public.bi_reports
    WHERE is_template IS TRUE
      AND created_by IS NULL
) dup
WHERE b.id = dup.id
  AND dup.rn > 1
  AND b.public_token IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.bi_report_deliveries d WHERE d.report_id = b.id);

-- Blindaje: el seed vuelve a correr en cada despliegue de migraciones, así que
-- sin esto la duplicación reaparece. Los INSERT del seed usan
-- "WHERE NOT EXISTS (... nombre = ...)", que este índice respalda a nivel de BD.
CREATE UNIQUE INDEX IF NOT EXISTS bi_reports_system_template_nombre_uq
    ON public.bi_reports (nombre)
    WHERE is_template IS TRUE AND created_by IS NULL;
