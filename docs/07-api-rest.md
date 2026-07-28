# 07 · API REST

Todos los endpoints HTTP viven en `src/app/api/**/route.ts`. Cada uno aplica su **propia** autenticación (el middleware no protege `/api/*`).

## Autenticación por tipo de endpoint

| Tipo | Mecanismo |
|------|-----------|
| API pública v1, MCP | `Authorization: Bearer ads_…` o `?token=` (token de API con permisos) |
| Cron / workers | `Authorization: Bearer $CRON_SECRET` |
| Webhook Hotmart | Firma HMAC (`x-hotmart-signature`) o token legacy (`x-hotmart-hottok`) |
| Pixel, health | Público (sin auth) |
| Resto (sync, tokens, reports, reorder) | Sesión Supabase |

---

## API pública v1 (token, solo lectura)

Base: `/api/v1`. Requieren `Authorization: Bearer <token>` con el permiso adecuado.

### `GET /api/v1/clients` — `read:clients`
Lista clientes accesibles.
```json
{ "clients": [{ "id": "uuid", "nombre": "…", "created_at": "…" }] }
```

### `GET /api/v1/campaigns` — `read:campaigns`
Grupos de campañas (filtrable por `?client_id=`).
```json
{ "campaign_groups": [{
  "id":"uuid","name":"…","description":"…","color":"blue",
  "client": { "id":"uuid","name":"…" },
  "mappings": [{ "id":"uuid","campaign_id":"…","campaign_name_pattern":"…" }],
  "created_at":"…"
}] }
```

### `GET /api/v1/metrics` — `read:metrics`
Métricas diarias. Params: `client_id` (req.), `from` (def. -30d), `to` (def. hoy), `limit` (def. 90, máx. 365).
```json
{
  "client": { "id":"uuid", "name":"…" },
  "period": { "from":"YYYY-MM-DD", "to":"YYYY-MM-DD" },
  "metrics": [{
    "fecha":"YYYY-MM-DD","meta_spend":0,"meta_impressions":0,"meta_clicks":0,
    "ga_sessions":0,"hotmart_pagos_iniciados":0,
    "ventas_principal":0,"ventas_bump":0,"ventas_upsell":0,"ventas_cerradas":0
  }]
}
```

### `GET /api/v1/ad-thumbnails`
Miniaturas de anuncios Meta. **Usa sesión Supabase** (no token de API). Params: `clienteId`, `adIds` (CSV, máx. 50). Consulta Graph API.
```json
{ "<adId>": { "thumbnail":"url|null", "previewUrl":"url|null" } }
```

---

## MCP — Model Context Protocol

### `GET|POST /api/mcp`
Servidor JSON-RPC 2.0 para asistentes IA (Claude, Cursor). `GET` devuelve info del servidor sin auth; `POST` requiere token. Detalle de herramientas en [doc 13](./13-mcp-y-tokens-api.md).

Herramientas: `list_clients`, `get_tabs`, `get_metrics`, `get_summary`.

---

## Gestión de tokens (sesión)

### `GET /api/tokens`
Lista tokens del usuario (sin el valor plano).

### `POST /api/tokens`
Crea un token. Body: `{ name, permissions[], expires_at? }`. **Devuelve el token plano una sola vez.**

### `PATCH /api/tokens/[id]`
Activa/desactiva: `{ is_active: boolean }`.

### `DELETE /api/tokens/[id]`
Revoca el token (204).

---

## OAuth

### `GET /api/auth/meta`
Inicia OAuth de Meta. Param `client_id`. Redirige al diálogo de Facebook (scopes `ads_read`, `business_management`, `leads_retrieval`). Graph API v19.0.

### `GET /api/auth/meta/callback`
Callback de Meta. Intercambia `code` → token corto → token largo (~60 días) y lo guarda en `config_api.meta_token` + `meta_token_expires_at`. Redirige a `/admin/settings/{clientId}`.

### `GET /api/auth/tiktok`
Inicia OAuth de TikTok. Param `client_id`.

### `GET /api/auth/tiktok/callback`
Callback de TikTok. Intercambia `auth_code` → `access_token`, extrae `advertiser_ids` y los guarda en `config_api.tiktok_accounts`. (Los tokens de TikTok no expiran.)

---

## Cron / workers

Requieren `Authorization: Bearer $CRON_SECRET`. Programación en [doc 14](./14-cron-y-workers.md).

### `GET /api/worker`
Sincronizador principal (Meta, TikTok, Hotmart, GA4). Params: `date` | (`start`+`end`) | `client_id`. `maxDuration` 300s. Hace `upsert` en `metricas_diarias` con desgloses JSONB. Devuelve un resumen por cliente.

### `GET /api/worker/google-sheets`
Importa leads desde Google Sheets de cada cliente. Param `client_id` opcional. Upserta `leads` y `leads_diarios`.

### `GET /api/worker/backfill-campaign-ids`
Utilidad para rellenar `campaign_id` faltantes en métricas históricas. Params: `client_id` (req.), `days` (def. 90). Delega en `/api/worker`.

### `GET /api/cron/refresh-meta-tokens`
Renueva tokens de Meta próximos a expirar (< 10 días). Usa `META_APP_ID`/`META_APP_SECRET`. Devuelve `{ ok, refreshed, failed, total, results[] }`.

### `GET|POST /api/cron/report-utm/aggregate`
Reagrega `sales_events` → `hourly_metrics`. Params: `hours` (def. 24, máx. 720), `cliente_id`. Devuelve `{ ok, window_hours, rows_written, completed_at }`.

> **Nota**: `vercel.json` también referencia `/api/cron/budget-check` (invocado por la GitHub Action de chequeo de presupuesto cada 4h), aunque su `route.ts` no figura en el árbol listado del repo. Verifica su existencia en tu instancia.

---

## Webhooks y pixel (Report-UTM)

### `POST /api/report-utm/pixel/event`
**Público** (CORS `*`). Recibe eventos del pixel JS. Body principal: `cliente_slug` (req.), `event_type` (`pageview`|`click`|`custom`), más `visitor_id`, `session_id`, `page_url`, `referrer`, UTMs, `click_id`, `custom_data`. Inserta en `report_utm.pixel_events`. Responde `{ ok: true }` (incluso si el cliente está inactivo). Captura IP/país/User-Agent de las cabeceras.

### `POST /api/report-utm/webhooks/hotmart/[clienteId]`
Recibe ventas de Hotmart. Valida firma (HMAC o hottok), parsea el payload (`hotmart-parser`), hace `upsert` en `report_utm.sales_events` (dedupe por `cliente_id+platform+platform_sale_id`), resuelve atribución multi-touch y emite webhooks salientes. Códigos: 201 ok, 404 sin integración, 403 pausada, 401 firma inválida, 422 payload inválido, 500 error BD. `GET` sirve como health-check de la URL. Detalle en [doc 12](./12-modulo-report-utm.md).

---

## Reportes y datos (sesión)

### `POST /api/admin/sync-google-sheets`
Sincroniza leads manualmente. Body `{ clientId }`. `GET ?clientId=` devuelve el estado de configuración.

### `POST /api/layouts/reorder`
Reordena tabs/bloques. Body `{ clienteId, tabOrder: [{ id, position }] }`.

### `POST /api/backfill-forms`
Backfill de formularios Meta (`meta_forms`) en métricas históricas.

---

## Salud y redirecciones

### `GET|POST /api/health`
Sin auth. Verifica conexión a BD y variables de entorno requeridas. Devuelve `{ status, timestamp, uptime, checks: { database, environment } }`. 200 si `up`, 503 si `degraded`/`down`.

### `GET /t/[slug]` (route handler, no `/api`)
Resuelve el slug de tracking → destino con UTMs. Setea cookies de atribución (visitor/first/last touch, 90 días), incrementa contador de clics, registra evento y hace 302. Ver [doc 12](./12-modulo-report-utm.md).

---

## Tabla resumen

| Endpoint | Métodos | Auth |
|----------|---------|------|
| `/api/v1/clients` | GET | token `read:clients` |
| `/api/v1/campaigns` | GET | token `read:campaigns` |
| `/api/v1/metrics` | GET | token `read:metrics` |
| `/api/v1/ad-thumbnails` | GET | sesión |
| `/api/mcp` | GET/POST | público (GET) / token (POST) |
| `/api/tokens` | GET/POST | sesión |
| `/api/tokens/[id]` | PATCH/DELETE | sesión |
| `/api/auth/meta` `/callback` | GET | OAuth |
| `/api/auth/tiktok` `/callback` | GET | OAuth |
| `/api/worker` | GET | CRON_SECRET |
| `/api/worker/google-sheets` | GET | CRON_SECRET |
| `/api/worker/backfill-campaign-ids` | GET | CRON_SECRET |
| `/api/cron/refresh-meta-tokens` | GET | CRON_SECRET |
| `/api/cron/report-utm/aggregate` | GET/POST | CRON_SECRET |
| `/api/report-utm/pixel/event` | POST/OPTIONS | público |
| `/api/report-utm/webhooks/hotmart/[clienteId]` | GET/POST | HMAC/hottok |
| `/api/admin/sync-google-sheets` | GET/POST | sesión |
| `/api/admin/sync-conversiones-offline` | GET/POST | sesión |
| `/api/admin/sheet-campos` | GET/POST/DELETE | sesión |
| `/api/admin/sheet-campos/vistas` | POST/DELETE | sesión |
| `/api/admin/sheet-campos/valores` | GET | sesión |
| `/api/admin/sheet-campos/recalcular` | POST | sesión |
| `/api/admin/sheet-columnas` | GET | sesión |
| `/api/layouts/reorder` | POST | sesión |
| `/api/backfill-forms` | POST | sesión |
| `/api/health` | GET/POST | público |
