# 08 · Integraciones externas

La aplicación integra cinco fuentes de datos. Cada cliente configura sus credenciales en `config_api` desde `/admin/settings/[id]`. Meta y TikTok se conectan vía OAuth; GA4 y Hotmart con credenciales manuales; Google Sheets con cuenta de servicio.

El sincronizador principal (`/api/worker`) consulta todas estas APIs a diario y consolida en `metricas_diarias`. Ver [doc 14 · Cron y workers](./14-cron-y-workers.md).

---

## Meta Ads (Facebook / Instagram)

**API**: Facebook Graph API v19.0.

### Conexión (OAuth)
1. Desde `/admin/settings/[id]`, el usuario inicia OAuth → `GET /api/auth/meta?client_id=…`.
2. Facebook pide consentimiento (scopes `ads_read`, `business_management`, `leads_retrieval`).
3. `GET /api/auth/meta/callback` intercambia el código por un token de larga duración (~60 días) y guarda en `config_api`:
   - `meta_token`, `meta_token_expires_at`, `meta_connection_status`, `meta_account_id`.

### Renovación automática
`GET /api/cron/refresh-meta-tokens` (diario) renueva los tokens que expiran en menos de 10 días usando `META_APP_ID`/`META_APP_SECRET` (grant `fb_exchange_token`). Si falla, marca `meta_connection_status = expired`.

### Datos sincronizados
El worker consulta *insights* a nivel **campaña**, **anuncio** y **conjunto de anuncios**, además de **formularios de leads** y **demografía** (edad/género). Calcula conversiones personalizadas y enriquece con regiones de targeting. Se guardan en:
- Totales: `meta_spend`, `meta_impressions`, `meta_clicks`.
- JSONB: `meta_campaigns`, `meta_ads`, `meta_adsets`, `meta_forms`.

### Miniaturas
`GET /api/v1/ad-thumbnails` obtiene `thumbnail_url`, `effective_object_story_id` y `preview_shareable_link` de los anuncios.

---

## TikTok Ads

**API**: TikTok Business API v1.3.

### Conexión (OAuth)
1. `GET /api/auth/tiktok?client_id=…` redirige al consentimiento de TikTok.
2. `GET /api/auth/tiktok/callback` intercambia `auth_code` → `access_token`, extrae `advertiser_ids` y guarda en `config_api`:
   - `tiktok_access_token`, `tiktok_accounts: [{ advertiser_id, name }]`.
   - Los tokens de TikTok **no expiran** (a diferencia de Meta).

### Datos sincronizados
El worker llama a `report/integrated/get` a nivel campaña/anuncio/grupo. Se guardan en:
- Totales: `tiktok_spend`, `tiktok_impressions`, `tiktok_clicks`, `tiktok_conversions`.
- JSONB: `tiktok_campaigns`, `tiktok_ads`, `tiktok_adgroups`.

> El motor de fórmulas puede filtrar métricas TikTok por `advertiser_id` (cuando un cliente tiene varias cuentas). Ver `filterRowByTikTokAccount` en [doc 09](./09-motor-de-formulas.md).

---

## Google Analytics 4

**API**: `@google-analytics/data` (Data API). Declarado como `serverExternalPackages` en `next.config.ts`.

### Configuración (manual, por cliente)
En `config_api`:
- `ga_property_id` (p. ej. `properties/123456`)
- `ga_private_key` (clave privada de cuenta de servicio; el formulario valida y normaliza los `\n`)
- `ga_client_email`

### Datos sincronizados
El worker obtiene **sesiones** y eventos del sitio. Se guardan en `ga_sessions`. En el motor de fórmulas, el alias `$visitas` apunta por defecto a `ga_sessions`.

---

## Hotmart

**API**: Hotmart API (sales/history, sales/commissions).

### Configuración (manual, por cliente)
En `config_api`: `hotmart_basic` (basic auth) o `hotmart_api_key` (client credentials).

### Datos sincronizados
El worker obtiene ventas (estados `APPROVED`/`COMPLETE`) y comisiones, y las **clasifica por embudo** según los patrones configurados en cada tab (`hotmart_funnel`):
- `principal_names`, `bump_names`, `upsell_names` (soportan `%`/`_` tipo SQL LIKE).

Se consolidan en:
- Totales: `ventas_principal/bump/upsell` (neto), `*_bruto`, `*_count`, `hotmart_pagos_iniciados`.
- JSONB: `hotmart_funnel_data` (desglose `by_tab` + `extras`).

> Hotmart aparece **dos veces** en el sistema: (1) aquí como fuente de ventas agregadas en el reporting principal, y (2) en el módulo Report-UTM como webhook de eventos de venta con atribución. Son flujos independientes.

---

## Google Sheets (importación de leads)

**Librerías**: `google-spreadsheet`, `google-auth-library` (JWT). Código en `src/lib/integrations/google-sheets.ts`.

### Configuración (por cliente)
En `config_api.google_sheets`:
```jsonc
{
  "sheet_url": "https://docs.google.com/spreadsheets/d/…",
  "quality_field": "rango_de_ingresos",          // campo que define calificación
  "qualified_values": ["$5,000 - $20,000 USD"],  // valores que cuentan como calificado
  "enabled": true,
  "client_email": "…",   // opcional: credenciales por cliente
  "private_key": "…",
  "sheet_names": ["Hoja1"]
}
```
Si no hay credenciales por cliente, se usa la cuenta de servicio global (`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_SERVICE_ACCOUNT_KEY`).

### Flujo
`fetchLeadsFromSheet` → `filterQualifiedLeads` (compara `quality_field` contra `qualified_values`, case-insensitive) → `computeDailyAggregates` (agrupa por fecha, calcula tasa de calificación) → `saveLeadsToDb` (upsert por lotes a `leads` y `leads_diarios`).

### Disparadores
- **Automático**: `GET /api/worker/google-sheets` (cron diario).
- **Manual**: `POST /api/admin/sync-google-sheets` desde la UI.

En el dashboard, los leads se muestran en `GoogleSheetsLeadsCard`.

---

## Resumen

| Integración | Auth | Configuración | Tablas/columnas destino |
|-------------|------|---------------|-------------------------|
| Meta Ads | OAuth (env app + token por cliente) | `/admin/settings/[id]` | `meta_*`, `meta_campaigns/ads/adsets/forms` |
| TikTok Ads | OAuth (env app + token por cliente) | `/admin/settings/[id]` | `tiktok_*`, `tiktok_campaigns/ads/adgroups` |
| GA4 | Cuenta de servicio por cliente | `config_api.ga_*` | `ga_sessions` |
| Hotmart (reporting) | Basic/API key por cliente | `config_api.hotmart_*` + funnel por tab | `ventas_*`, `hotmart_funnel_data` |
| Google Sheets | Cuenta de servicio (global o por cliente) | `config_api.google_sheets` | `leads`, `leads_diarios` |
| Hotmart (Report-UTM) | Webhook HMAC | `report_utm.integrations` | `report_utm.sales_events` |
