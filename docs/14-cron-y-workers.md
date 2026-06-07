# 14 · Cron jobs y workers

Las sincronizaciones y tareas de mantenimiento corren como **tareas programadas**. Hay dos orquestadores: **Vercel Cron** (definido en `vercel.json`) y una **GitHub Action** (`.github/workflows/budget-check.yml`).

## Autenticación de los workers

Todos los endpoints de cron/worker exigen:

```
Authorization: Bearer $CRON_SECRET
```

La verificación está en `src/lib/cron-auth.ts` (`authenticateCron`), con comparación de **tiempo constante** para evitar timing attacks.

## Vercel Cron (`vercel.json`)

```jsonc
{
  "crons": [
    { "path": "/api/worker",                    "schedule": "0 5 * * *" },  // 05:00 UTC
    { "path": "/api/worker/google-sheets",      "schedule": "0 13 * * *" }, // 13:00 UTC
    { "path": "/api/cron/report-utm/aggregate", "schedule": "0 6 * * *" },  // 06:00 UTC
    { "path": "/api/cron/refresh-meta-tokens",  "schedule": "0 4 * * *" }   // 04:00 UTC
  ]
}
```

> Vercel invoca estos paths con su propio mecanismo; asegúrate de que `CRON_SECRET` esté disponible y que los crons estén habilitados en el plan de Vercel.

## Workers

### `/api/worker` — sincronizador principal (05:00 UTC)
El más importante. Para cada cliente y cada día del rango:
1. **Meta Ads**: insights a nivel campaña/anuncio/conjunto, formularios de leads, demografía; calcula conversiones custom y enriquece con targeting.
2. **TikTok Ads**: reportes a nivel campaña/anuncio/grupo.
3. **Hotmart**: ventas (APPROVED/COMPLETE) + comisiones; clasifica por embudo según patrones del tab.
4. **GA4**: sesiones y eventos (si está configurado).
5. `upsert` en `metricas_diarias` con totales + desgloses JSONB.

Params: `date` | (`start` + `end`) | `client_id`. `maxDuration` = 300s. Usa `SUPABASE_SERVICE_ROLE_KEY` (omite RLS). Devuelve un resumen por cliente con estado de cada plataforma.

### `/api/worker/google-sheets` — leads (13:00 UTC)
Importa leads desde las Google Sheets de cada cliente y upserta `leads` y `leads_diarios`. Param `client_id` opcional. Detalle en [doc 08](./08-integraciones.md). (El comentario del código menciona ~08:00 hora Colombia, UTC-5, equivalente a 13:00 UTC.)

### `/api/worker/backfill-campaign-ids` — utilidad puntual
Rellena `campaign_id` faltantes en métricas históricas. Params: `client_id` (req.), `days` (def. 90, máx. 365). Delega en `/api/worker`.

### `/api/cron/refresh-meta-tokens` — renovación de tokens (04:00 UTC)
Renueva los tokens de Meta que expiran en < 10 días (grant `fb_exchange_token`, usando `META_APP_ID`/`META_APP_SECRET`). Marca `meta_connection_status = expired` si falla. Devuelve `{ ok, refreshed, failed, total, results[] }`.

### `/api/cron/report-utm/aggregate` — agregación UTM (06:00 UTC)
Reagrega `report_utm.sales_events` en `hourly_metrics`. Params: `hours` (def. 24, máx. 720), `cliente_id`. Devuelve `{ ok, window_hours, rows_written, completed_at }`. Ver [doc 12](./12-modulo-report-utm.md).

## GitHub Action — chequeo de presupuesto

`.github/workflows/budget-check.yml`. Corre **cada 4 horas** (`0 */4 * * *`) y también permite disparo manual (`workflow_dispatch`). Llama a:

```
GET https://reportes.adshouse.cloud/api/cron/budget-check
Authorization: Bearer ${{ secrets.CRON_SECRET }}
```

Verifica el estado HTTP, parsea la respuesta y reporta cuántos tabs se revisaron y qué alertas se enviaron. Las alertas de presupuesto aparecen en el `/dashboard` (`getActiveAlerts`).

> El endpoint `/api/cron/budget-check` es invocado por esta Action y referenciado indirectamente, pero su `route.ts` no figura en el árbol de archivos listado del repo. Verifica su presencia en tu instancia desplegada.

## Tabla resumen

| Tarea | Orquestador | Horario | Auth |
|-------|-------------|---------|------|
| Sync principal (Meta/TikTok/Hotmart/GA4) | Vercel Cron | 05:00 UTC diario | CRON_SECRET |
| Importar leads (Google Sheets) | Vercel Cron | 13:00 UTC diario | CRON_SECRET |
| Agregación Report-UTM | Vercel Cron | 06:00 UTC diario | CRON_SECRET |
| Refrescar tokens Meta | Vercel Cron | 04:00 UTC diario | CRON_SECRET |
| Chequeo de presupuesto | GitHub Actions | cada 4 h | CRON_SECRET |
| Backfill campaign IDs | manual | — | CRON_SECRET |

## Disparo manual

Cualquier worker puede invocarse manualmente (útil para backfills o pruebas):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker?start=2026-05-01&end=2026-05-31&client_id=<uuid>"
```
