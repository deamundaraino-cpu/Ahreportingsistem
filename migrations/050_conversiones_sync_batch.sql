-- migrations/050_conversiones_sync_batch.sql
-- Hace idempotente el sync de conversiones offline desde Google Sheets.
--
-- `saveConversionesToDb` borraba TODAS las filas del cliente y luego insertaba
-- las nuevas por lotes de 500. Si el insert fallaba a mitad (timeout de Vercel,
-- error de red, hoja mal formada), el cliente se quedaba sin conversiones hasta
-- que alguien reintentara el sync a mano.
--
-- Con `sync_batch_id` el orden se invierte: primero se inserta el lote nuevo,
-- y solo cuando está completo se borran los lotes anteriores.

ALTER TABLE public.conversiones_offline
    ADD COLUMN IF NOT EXISTS sync_batch_id uuid;

ALTER TABLE public.conversiones_offline_diarias
    ADD COLUMN IF NOT EXISTS sync_batch_id uuid;

COMMENT ON COLUMN public.conversiones_offline.sync_batch_id IS 'Lote de sincronización; las filas de lotes viejos se borran al completar el nuevo.';
COMMENT ON COLUMN public.conversiones_offline_diarias.sync_batch_id IS 'Lote de sincronización; las filas de lotes viejos se borran al completar el nuevo.';

-- El borrado final filtra por (cliente_id, sync_batch_id <> nuevo).
CREATE INDEX IF NOT EXISTS idx_conversiones_offline_batch
    ON public.conversiones_offline (cliente_id, sync_batch_id);

CREATE INDEX IF NOT EXISTS idx_conversiones_offline_diarias_batch
    ON public.conversiones_offline_diarias (cliente_id, sync_batch_id);

-- Las filas ya existentes no tienen lote: se les asigna uno para que el primer
-- sync posterior (con un batch nuevo) las retire limpiamente.
UPDATE public.conversiones_offline
SET sync_batch_id = '00000000-0000-0000-0000-000000000000'
WHERE sync_batch_id IS NULL;

UPDATE public.conversiones_offline_diarias
SET sync_batch_id = '00000000-0000-0000-0000-000000000000'
WHERE sync_batch_id IS NULL;
