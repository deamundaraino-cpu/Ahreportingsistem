-- migrations/055_reconciliar_tipo.sql
-- Añade el tipo de job 'reconciliar' al CHECK de sync_jobs.
--
-- SOLO ES NECESARIA si ya aplicaste la 051 antes de que incluyera este tipo.
-- Si aplicas la 051 en su versión actual, esta migración no hace nada (el
-- constraint se recrea idéntico) y es seguro ejecutarla igualmente.
--
-- Contexto: el job 'reconciliar' compara el gasto de Meta guardado contra el que
-- reporta la cuenta y reencola los días cuyo desglose por campaña esté
-- incompleto. Hace falta porque el dashboard suma `meta_campaigns[]` filtrado por
-- keyword —no la columna `meta_spend`—, así que un array truncado hace que un día
-- con gasto real se muestre en $0.

ALTER TABLE public.sync_jobs
    DROP CONSTRAINT IF EXISTS sync_jobs_tipo_check;

ALTER TABLE public.sync_jobs
    ADD CONSTRAINT sync_jobs_tipo_check CHECK (tipo IN (
        'metricas', 'sheets_leads', 'sheets_conversiones',
        'meta_leads', 'utm_aggregate', 'cierre_mes', 'reconciliar'
    ));
