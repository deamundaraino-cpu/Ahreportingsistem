-- migrations/047_metricas_diarias_futuras.sql
-- Elimina las filas con fecha FUTURA y sin datos de metricas_diarias.
--
-- Un sync lanzado con un rango cuyo `end` iba más allá de hoy creaba una fila por
-- día×cliente para fechas que aún no existen: las APIs de Meta/TikTok no devuelven
-- nada para el futuro, así que quedaban filas todo en cero. En los informes eso
-- añade puntos vacíos a las gráficas por fecha y ensucia los conteos.
--
-- Solo se borran las que NO tienen dato alguno: si alguna fila futura tuviera
-- gasto o campañas (no debería), se conserva para revisarla a mano.
--
-- El worker ya no las crea: recorta el rango de sincronización contra hoy en hora
-- Colombia (src/app/api/worker/route.ts).

DELETE FROM public.metricas_diarias
WHERE fecha > CURRENT_DATE
  AND COALESCE(meta_spend, 0) = 0
  AND COALESCE(tiktok_spend, 0) = 0
  AND COALESCE(meta_impressions, 0) = 0
  AND COALESCE(tiktok_impressions, 0) = 0
  AND COALESCE(ga_sessions, 0) = 0
  AND COALESCE(jsonb_array_length(meta_campaigns), 0) = 0
  AND COALESCE(jsonb_array_length(tiktok_campaigns), 0) = 0
  AND COALESCE(metricas_manuales, '{}'::jsonb) = '{}'::jsonb;
