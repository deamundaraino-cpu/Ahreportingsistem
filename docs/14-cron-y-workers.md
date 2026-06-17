# 14 · Cron jobs y workers

Las sincronizaciones y tareas de mantenimiento corren como **tareas programadas**. Hay dos orquestadores: **Vercel Cron** (definido en `vercel.json`) y una **GitHub Action** (`.github/workflows/budget-check.yml`).

## Autenticación de los workers

Todos los endpoints de cron/worker exigen:

```
Authorization: Bearer $CRON_SECRET
```

La verificación está en `src/lib/cron-auth.ts` (`authenticateCron`), con comparación de **tiempo constante** para evitar timing attacks.

## Zona horaria

La operación es en **Colombia (`America/Bogota` = UTC−5 fijo, sin horario de verano)**. Vercel Cron **solo acepta UTC**, así que los horarios en `vercel.json` están en UTC pero se diseñaron alrededor de horas Colombia (UTC+5h). El cálculo de fechas de calendario ("ayer"/"hoy") en el código usa los helpers `colombiaToday()` / `colombiaYesterday()` de `src/lib/date-utils.ts`, para que el día sea correcto sin importar a qué hora se dispare el cron. El límite diario de Hotmart ya se calcula con offset `-05:00` en `/api/worker`.

## Vercel Cron (`vercel.json`)

Horario diario, secuenciado: **refrescar tokens → sync principal → agregaciones → imports → digest**.

```jsonc
{
  "crons": [
    { "path": "/api/cron/refresh-meta-tokens",              "schedule": "0 7 * * *" },   // 02:00 🇨🇴  · 07:00 UTC
    { "path": "/api/cron/refresh-hotmart-tokens",           "schedule": "0 7 * * *" },   // 02:00 🇨🇴  · 07:00 UTC
    { "path": "/api/worker",                                "schedule": "0 10 * * *" },  // 05:00 🇨🇴  · 10:00 UTC
    { "path": "/api/cron/report-utm/aggregate",             "schedule": "0 11 * * *" },  // 06:00 🇨🇴  · 11:00 UTC
    { "path": "/api/worker/google-sheets",                  "schedule": "30 11 * * *" }, // 06:30 🇨🇴  · 11:30 UTC
    { "path": "/api/worker/google-sheets-conversiones",     "schedule": "0 12 * * *" },  // 07:00 🇨🇴  · 12:00 UTC
    { "path": "/api/cron/whatsapp-digest",                  "schedule": "0 13 * * *" }   // 08:00 🇨🇴  · 13:00 UTC
  ]
}
```

> `vercel.json` es JSON puro (sin comentarios); las anotaciones de hora de arriba son solo para esta doc. Asegúrate de que `CRON_SECRET` esté disponible y que los crons estén habilitados en el plan de Vercel.

**Por qué este orden:** los tokens se refrescan a las 02:00 🇨🇴 para que estén vigentes cuando corre el sync principal a las 05:00 🇨🇴 (≈5 h después del cierre del día anterior, dando margen a que Meta/TikTok consoliden los datos de "ayer"). Las agregaciones e imports corren después, y el digest de WhatsApp al final (08:00 🇨🇴), cuando ya hay datos consolidados y la gente está despierta para recibirlo.

## Workers

### `/api/worker` — sincronizador principal (05:00 🇨🇴 / 10:00 UTC)
El más importante. Para cada cliente y cada día del rango:
1. **Meta Ads**: insights a nivel campaña/anuncio/conjunto, formularios de leads, demografía; calcula conversiones custom y enriquece con targeting.
2. **TikTok Ads**: reportes a nivel campaña/anuncio/grupo.
3. **Hotmart**: ventas (APPROVED/COMPLETE) + comisiones; clasifica por embudo según patrones del tab.
4. **GA4**: sesiones y eventos (si está configurado).
5. `upsert` en `metricas_diarias` con totales + desgloses JSONB.

Params: `date` | (`start` + `end`) | `client_id`. Sin params, sincroniza **"ayer" en hora Colombia** (`colombiaYesterday()`). `maxDuration` = 300s. Usa `SUPABASE_SERVICE_ROLE_KEY` (omite RLS). Devuelve un resumen por cliente con estado de cada plataforma.

### `/api/worker/google-sheets` — leads (06:30 🇨🇴 / 11:30 UTC)
Importa leads desde las Google Sheets de cada cliente y upserta `leads` y `leads_diarios`. Param `client_id` opcional. Detalle en [doc 08](./08-integraciones.md).

### `/api/worker/google-sheets-conversiones` — conversiones offline (07:00 🇨🇴 / 12:00 UTC)
Sincroniza conversiones offline (leads/ventas manuales) desde las Google Sheets del cliente hacia `conversiones_offline` y `conversiones_offline_diarias` (full-replace por cliente). Soporta múltiples sheets por cliente. Param `client_id` opcional. Config en `clientes.config_api.google_sheets_conversiones`.

### `/api/worker/backfill-campaign-ids` — utilidad puntual
Rellena `campaign_id` faltantes en métricas históricas. Params: `client_id` (req.), `days` (def. 90, máx. 365). Delega en `/api/worker`.

### `/api/cron/refresh-meta-tokens` — renovación de tokens Meta (02:00 🇨🇴 / 07:00 UTC)
Renueva los tokens de Meta que expiran en < 10 días (grant `fb_exchange_token`, usando `META_APP_ID`/`META_APP_SECRET`). Marca `meta_connection_status = expired` si falla. Devuelve `{ ok, refreshed, failed, total, results[] }`.

### `/api/cron/refresh-hotmart-tokens` — renovación de tokens Hotmart (02:00 🇨🇴 / 07:00 UTC)
Renueva los tokens de Hotmart (HotConnect) que expiran en < 30 min. Los tokens duran ~6 h. Corre antes del sync principal para que estén vigentes cuando `/api/worker` consulte la API de Hotmart.

### `/api/cron/report-utm/aggregate` — agregación UTM (06:00 🇨🇴 / 11:00 UTC)
Reagrega `report_utm.sales_events` en `hourly_metrics`. Params: `hours` (def. 24, máx. 720), `cliente_id`. Devuelve `{ ok, window_hours, rows_written, completed_at }`. Ver [doc 12](./12-modulo-report-utm.md).

### `/api/cron/whatsapp-digest` — resumen diario WhatsApp (08:00 🇨🇴 / 13:00 UTC)
Para cada cliente con datos en `metricas_diarias` de **"ayer" en hora Colombia** (`colombiaYesterday()`), arma un resumen corto (inversión, clicks, pagos, ventas, ROAS) y lo envía vía `sendWhatsAppNotification(type='metrics_summary')`. Corre al final del pipeline, cuando los datos ya están consolidados.

## GitHub Action — chequeo de presupuesto

`.github/workflows/budget-check.yml`. Corre **cada 4 horas** (`0 */4 * * *`) y también permite disparo manual (`workflow_dispatch`). Llama a:

```
GET https://reportes.adshouse.cloud/api/cron/budget-check
Authorization: Bearer ${{ secrets.CRON_SECRET }}
```

Verifica el estado HTTP, parsea la respuesta y reporta cuántos tabs se revisaron y qué alertas se enviaron. Las alertas de presupuesto aparecen en el `/dashboard` (`getActiveAlerts`).

> El endpoint `/api/cron/budget-check` es invocado por esta Action y referenciado indirectamente, pero su `route.ts` no figura en el árbol de archivos listado del repo. Verifica su presencia en tu instancia desplegada.

## Tabla resumen

| Tarea | Orquestador | Hora 🇨🇴 | UTC | Auth |
|-------|-------------|---------|-----|------|
| Refrescar tokens Meta | Vercel Cron | 02:00 | 07:00 | CRON_SECRET |
| Refrescar tokens Hotmart | Vercel Cron | 02:00 | 07:00 | CRON_SECRET |
| Sync principal (Meta/TikTok/Hotmart/GA4) | Vercel Cron | 05:00 | 10:00 | CRON_SECRET |
| Agregación Report-UTM | Vercel Cron | 06:00 | 11:00 | CRON_SECRET |
| Importar leads (Google Sheets) | Vercel Cron | 06:30 | 11:30 | CRON_SECRET |
| Conversiones offline (Google Sheets) | Vercel Cron | 07:00 | 12:00 | CRON_SECRET |
| Digest WhatsApp | Vercel Cron | 08:00 | 13:00 | CRON_SECRET |
| Chequeo de presupuesto | GitHub Actions | cada 4 h | cada 4 h | CRON_SECRET |
| Backfill campaign IDs | manual | — | — | CRON_SECRET |

## Disparo manual

Cualquier worker puede invocarse manualmente (útil para backfills o pruebas):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker?start=2026-05-01&end=2026-05-31&client_id=<uuid>"
```
