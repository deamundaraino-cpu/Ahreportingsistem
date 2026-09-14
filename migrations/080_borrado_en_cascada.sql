-- ════════════════════════════════════════════════════════════════════════════
-- 080 · Eliminar un cliente borra TODOS sus datos
-- ════════════════════════════════════════════════════════════════════════════
--
-- Decisión del 2026-09-14: borrar un cliente no deja nada suyo detrás. Hasta
-- aquí cuatro FK eran SET NULL y una columna no tenía FK:
--
--   · report_utm.clientes.public_cliente_id — SET NULL: borrar en el reporting
--     dejaba el espejo UTM huérfano, con todos sus leads. Así nacieron Goodprop,
--     CAMARADICTOS, Inspira, Lino Ratto y Peiurba.
--   · agent_channels.cliente_id — SET NULL, y además peligroso: un grupo fijado
--     a un cliente limita al agente a ese cliente; en null, el grupo pasaba a ver
--     todos los clientes del contacto.
--   · notifications.cliente_id y whatsapp_messages.cliente_id — SET NULL.
--   · bi_reports.cliente_id — sin FK (apunta a report_utm.clientes).
--
-- `eliminarClienteCompleto` (src/lib/clientes/ciclo-de-vida.ts) ya borra todo
-- esto a mano. La migración lo hace imposible de olvidar por cualquier otro
-- camino: SQL directo, el panel de Supabase, un script.
--
-- `agent_contacts.client_scope` es un array y no admite FK: lo cubre el código
-- (quitar el id solo si quedan otros; un array vacío significa «sin recorte»).
--
-- Idempotente. No toca filas existentes salvo los informes BI cuyo cliente ya
-- no existe (paso 3): con ellos la FK no se podría crear, y son precisamente lo
-- que esta decisión elimina. Hoy (2026-09-14) no hay ninguno.
--
--   npx tsx scripts/sql-remoto.ts migrations/080_borrado_en_cascada.sql

BEGIN;

-- 1. El espejo UTM cae con su cliente del reporting (y con él, por las cascadas
--    que ya existían, leads, ventas, integraciones, mapeos y campos de lead).
ALTER TABLE report_utm.clientes DROP CONSTRAINT IF EXISTS clientes_public_cliente_id_fkey;
ALTER TABLE report_utm.clientes
  ADD CONSTRAINT clientes_public_cliente_id_fkey
  FOREIGN KEY (public_cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;

-- 2. Canales del agente, notificaciones y mensajes de WhatsApp.
ALTER TABLE public.agent_channels DROP CONSTRAINT IF EXISTS agent_channels_cliente_id_fkey;
ALTER TABLE public.agent_channels
  ADD CONSTRAINT agent_channels_cliente_id_fkey
  FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;
-- Sin índice, cada borrado de cliente recorrería la tabla entera.
CREATE INDEX IF NOT EXISTS idx_agent_channels_cliente ON public.agent_channels (cliente_id);

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_cliente_id_fkey;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_cliente_id_fkey
  FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;

ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_cliente_id_fkey;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_cliente_id_fkey
  FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE CASCADE;

-- 3. Informes BI: FK a su cliente UTM. Sus envíos (bi_report_deliveries) ya
--    caían en cascada con el informe. El índice bi_reports_cliente_idx existe.
DELETE FROM public.bi_reports r
 WHERE r.cliente_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM report_utm.clientes c WHERE c.id = r.cliente_id);

ALTER TABLE public.bi_reports DROP CONSTRAINT IF EXISTS bi_reports_cliente_id_fkey;
ALTER TABLE public.bi_reports
  ADD CONSTRAINT bi_reports_cliente_id_fkey
  FOREIGN KEY (cliente_id) REFERENCES report_utm.clientes(id) ON DELETE CASCADE;

COMMIT;
