# 07 · API REST

Todos los endpoints HTTP viven en `src/app/api/**/route.ts`. Cada uno aplica su **propia** autenticación (el middleware no protege `/api/*`).

## Autenticación por tipo de endpoint

| Tipo                                   | Mecanismo                                                                |
| -------------------------------------- | ------------------------------------------------------------------------ |
| API pública v1, MCP                    | `Authorization: Bearer ads_…` (token de API con permisos; solo cabecera) |
| Cron / workers                         | `Authorization: Bearer $CRON_SECRET`                                     |
| Webhook Hotmart                        | Hottok de Hotmart en `X-HOTMART-HOTTOK` (o HMAC / `?hottok=` heredados)  |
| Pixel, health                          | Público (sin auth)                                                       |
| Resto (sync, tokens, reports, reorder) | Sesión Supabase                                                          |

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
{
  "campaign_groups": [
    {
      "id": "uuid",
      "name": "…",
      "description": "…",
      "color": "blue",
      "client": { "id": "uuid", "name": "…" },
      "mappings": [{ "id": "uuid", "campaign_id": "…", "campaign_name_pattern": "…" }],
      "created_at": "…"
    }
  ]
}
```

### `GET /api/v1/metrics` — `read:metrics`

Métricas diarias, una fila por día en orden ascendente. Params: `client_id` (req., UUID), `from` (def. hoy − 30 días), `to` (def. hoy), `limit` (días, def. 90, máx. 365). «Hoy» es el de Colombia.

Las cifras salen de `getMetricasCliente` (`src/lib/metrics/client-metrics.ts`), el mismo camino que el dashboard, el MCP y el agente. Antes la ruta leía las columnas crudas de `metricas_diarias` y no cuadraba con ellos.

```json
{
  "client": { "id": "uuid", "name": "…" },
  "period": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" },
  "moneda": "CLP",
  "metrics": [
    {
      "fecha": "YYYY-MM-DD",
      "meta_spend": 0,
      "meta_impressions": 0,
      "meta_clicks": 0,
      "ga_sessions": 0,
      "hotmart_pagos_iniciados": 0,
      "ventas_principal": 0,
      "ventas_bump": 0,
      "ventas_upsell": 0,
      "ventas_cerradas": 0,
      "ventas_principal_usd": 0,
      "ventas_bump_usd": 0,
      "ventas_upsell_usd": 0
    }
  ],
  "warnings": []
}
```

Las claves de siempre se conservan, pero **cuatro cambiaron de significado**:

- `meta_spend`, `meta_impressions`, `meta_clicks` — suma del array `meta_campaigns[]`, como el dashboard, no la columna. Si la paginación de Meta se truncó y no cuadran, el día se avisa en `warnings`.
- `ventas_principal`, `ventas_bump`, `ventas_upsell` — en la **moneda de reporte** del cliente (`moneda`, código ISO), convertidas con la tasa de cada día. Antes iban en USD; el USD sigue en las nuevas `ventas_*_usd`. Un día sin tasa conocida se queda en USD y se avisa en `warnings`.
- `ventas_cerradas` — el valor cargado a mano (`metricas_manuales.VENTAS_CERRADAS`). La columna homónima está obsoleta desde la migración 045 y valía siempre 0.
- `period` — el rango **aplicado** (sin días futuros y como mucho `limit` días), no el eco de los parámetros. Si `limit` recorta el rango, también se avisa en `warnings`.

Errores: `client_id` ausente o que no es UUID, fechas que no existen (`2026-02-31`) o `limit` no positivo dan **400** `VALIDATION_ERROR` (antes, 500 de la base de datos). Un cliente ajeno al token, **404**.

### `GET /api/v1/ad-thumbnails`

Miniaturas de anuncios Meta. **Usa sesión Supabase** (no token de API). Params: `clienteId`, `adIds` (CSV, máx. 50). Consulta Graph API.

```json
{ "<adId>": { "thumbnail": "url|null", "previewUrl": "url|null" } }
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

Inicia OAuth de Meta. Param `client_id`. Exige sesión con rol admin/superadmin. Firma el `state` (HMAC, 10 min), deja su nonce en la cookie httpOnly `meta_oauth_state` y redirige al diálogo de Facebook. Graph API v19.0.

### `GET /api/auth/meta/callback`

Callback de Meta. Valida el `state` contra la cookie antes de nada; si no cuadra, redirige con `meta_error` sin tocar la base. Intercambia `code` → token corto → token largo (~60 días) y lo funde en `config_api.meta_token` + `meta_token_expires_at` (`fusionar_config_api`). El cliente sale del `state` verificado. Redirige a `/admin/settings/{clientId}`.

### `GET /api/auth/tiktok`

Inicia OAuth de TikTok. Param `client_id`. Exige rol admin/superadmin; `state` firmado con nonce en la cookie `tiktok_oauth_state`.

### `GET /api/auth/tiktok/callback`

Callback de TikTok. Valida el `state` contra la cookie, intercambia `auth_code` → `access_token` y lo funde en `config_api.tiktok_access_token`. Las cuentas se eligen después desde la UI. (Los tokens de TikTok no expiran.)

---

## Cron / workers

Requieren `Authorization: Bearer $CRON_SECRET`. Programación en [doc 14](./14-cron-y-workers.md).

### `GET /api/worker`

Sincronizador principal (Meta, TikTok, Hotmart, GA4). Params: `date` | (`start`+`end`) | `client_id`. Hace `upsert` en `metricas_diarias` con desgloses JSONB. Devuelve un resumen por cliente.

### `GET /api/worker/hotmart`

Job de Hotmart: `modo` = `backfill` | `reclasificar` | `reconciliar`, con `cliente_id`, `desde`, `hasta`. Escribe en `hotmart_ventas` y reagrega `metricas_diarias`. Devuelve `{ ok, errores, results[], debugLogs, filas_escritas, partial, resumeFrom, … }`. Detalle en [doc 14](./14-cron-y-workers.md#apiworkerhotmart--backfill-reclasificación-y-reconciliación-de-hotmart).

### `GET /api/worker/backfill-campaign-ids`

Utilidad para rellenar `campaign_id` faltantes en métricas históricas. Params: `client_id` (req.), `days` (def. 90). Delega en `/api/worker`.

### `GET /api/cron/refresh-meta-tokens`

Renueva tokens de Meta próximos a expirar (< 10 días). Usa `META_APP_ID`/`META_APP_SECRET`. Devuelve `{ ok, refreshed, failed, total, results[] }`.

### `GET|POST /api/cron/report-utm/aggregate`

Reagrega `sales_events` → `hourly_metrics`. Params: `hours` (def. 24, máx. 720), `cliente_id`. Devuelve `{ ok, window_hours, rows_written, completed_at }`.

> **Nota**: la documentación antigua citaba `/api/cron/budget-check`, invocado por la GitHub Action de chequeo de presupuesto. **Esa ruta no existe en el repositorio**: no hay `src/app/api/cron/budget-check/route.ts`. Si necesitas el chequeo de presupuesto, hay que escribirla.

---

## Webhooks y pixel (Report-UTM)

### `POST /api/report-utm/pixel/event`

**Público** (CORS `*`). Recibe eventos del pixel JS. Body principal: `cliente_slug` (req.), `event_type` (`pageview`|`click`|`custom`), más `visitor_id`, `session_id`, `page_url`, `referrer`, UTMs, `click_id`, `custom_data`. Inserta en `report_utm.pixel_events`. Responde `{ ok: true }` (incluso si el cliente está inactivo). Captura IP/país/User-Agent de las cabeceras.

### `POST /api/report-utm/webhooks/hotmart/[clienteId]`

Recibe ventas de Hotmart. Valida el hottok que genera Hotmart (cabecera `X-HOTMART-HOTTOK`, contra el que el usuario pegó en la tarjeta; HMAC y `?hottok=` quedan como vías heredadas), parsea con `src/lib/hotmart/parser.ts`, guarda en `public.hotmart_ventas` y reagrega `metricas_diarias`. Solo si el evento se aplicó como el más reciente lo espeja en `report_utm.sales_events` (dedupe por `cliente_id+platform+platform_sale_id`), resuelve atribución multi-touch y avisa (webhooks salientes y notificaciones, una vez por estado). Códigos: 201 ok · 200 evento que no es venta o evento antiguo (ignorado) · 400 cuerpo vacío o JSON inválido · 404 sin integración o sin credencial · 403 pausada · 401 hottok inválido · 413 cuerpo > 256 KB · 422 payload ilegible · 429 rate limit · 500 error BD. `GET` sirve como health-check de la URL. Alta y detalle en [doc 08](./08-integraciones.md#webhook-ventas-en-vivo).

### `POST /api/report-utm/webhooks/ghl/[clienteId]`

Recibe el aviso de _Contact Created_ de un Workflow de GoHighLevel. Autenticado con un token compartido por cliente en el header `X-Rutm-Ghl-Token` (también acepta HMAC-SHA256 del cuerpo en `X-Rutm-Ghl-Signature`, o el token en `?token=`). Del payload solo necesita `contact_id`: responde 200 y en `after()` relee el contacto completo con el Private Integration Token para insertarlo en `report_utm.lead_events` (dedupe por `external_id = ghl:<contactId>`). Códigos: 200 ok (también cuando ignora el evento por falta de `contact_id` o por location distinta), 404 sin integración, 403 pausada, 401 token inválido, 413 cuerpo grande, 429 rate limit. `GET` sirve de health-check. Guía de alta en [doc 20](./20-integracion-gohighlevel.md).

---

## Reportes y datos (sesión)

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

| Endpoint                                       | Métodos         | Auth                         |
| ---------------------------------------------- | --------------- | ---------------------------- |
| `/api/v1/clients`                              | GET             | token `read:clients`         |
| `/api/v1/campaigns`                            | GET             | token `read:campaigns`       |
| `/api/v1/metrics`                              | GET             | token `read:metrics`         |
| `/api/v1/ad-thumbnails`                        | GET             | sesión                       |
| `/api/mcp`                                     | GET/POST        | público (GET) / token (POST) |
| `/api/tokens`                                  | GET/POST        | sesión                       |
| `/api/tokens/[id]`                             | PATCH/DELETE    | sesión                       |
| `/api/auth/meta` `/callback`                   | GET             | admin / `state` firmado      |
| `/api/auth/tiktok` `/callback`                 | GET             | admin / `state` firmado      |
| `/api/worker`                                  | GET             | CRON_SECRET                  |
| `/api/worker/hotmart`                          | GET             | CRON_SECRET                  |
| `/api/worker/backfill-campaign-ids`            | GET             | CRON_SECRET                  |
| `/api/cron/refresh-meta-tokens`                | GET             | CRON_SECRET                  |
| `/api/cron/report-utm/aggregate`               | GET/POST        | CRON_SECRET                  |
| `/api/report-utm/pixel/event`                  | POST/OPTIONS    | público                      |
| `/api/report-utm/webhooks/hotmart/[clienteId]` | GET/POST        | hottok de Hotmart            |
| `/api/report-utm/webhooks/ghl/[clienteId]`     | GET/POST        | token compartido / HMAC      |
| `/api/cron/sync-ghl-leads`                     | GET/POST        | CRON_SECRET                  |
| `/api/admin/sync-conversiones-offline`         | GET/POST        | sesión                       |
| `/api/admin/sheet-campos`                      | GET/POST/DELETE | sesión                       |
| `/api/admin/sheet-campos/vistas`               | POST/DELETE     | sesión                       |
| `/api/admin/sheet-campos/valores`              | GET             | sesión                       |
| `/api/admin/sheet-campos/recalcular`           | POST            | sesión                       |
| `/api/admin/sheet-columnas`                    | GET             | sesión                       |
| `/api/report-utm/bi/sheet-fields`              | GET             | sesión                       |
| `/api/layouts/reorder`                         | POST            | sesión                       |
| `/api/backfill-forms`                          | POST            | sesión                       |
| `/api/health`                                  | GET/POST        | público                      |
