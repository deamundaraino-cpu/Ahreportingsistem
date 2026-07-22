-- migrations/049_sales_events_bucket_index.sql
-- Índices para la re-lectura por hora-bucket de sales_events.
--
-- `aggregateHourlyMetrics` ahora vuelve a leer TODOS los eventos cuya hora-bucket
-- cae en el rango afectado (antes solo leía los recibidos en la ventana, y las
-- ventas viejas desaparecían del agregado al borrarse el rango). Esa consulta
-- filtra por cliente + sale_timestamp, con un fallback a received_at cuando la
-- venta no trae timestamp propio.

CREATE INDEX IF NOT EXISTS idx_sales_events_cliente_sale_ts
    ON report_utm.sales_events (cliente_id, sale_timestamp);

CREATE INDEX IF NOT EXISTS idx_sales_events_cliente_received
    ON report_utm.sales_events (cliente_id, received_at);
