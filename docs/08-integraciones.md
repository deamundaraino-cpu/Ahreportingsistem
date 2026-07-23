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

## Google Sheets (conversiones offline)

Integración **independiente** de la de leads: importa leads y ventas que no
captura el píxel (WhatsApp, llamadas, cierres manuales). Código en
`src/lib/integrations/google-sheets-conversiones.ts`.

**Auth**: la conexión OAuth de la agencia (`app_integrations`) si existe; si no,
cuenta de servicio. Un solo login de Google sirve para todos los clientes.

### Configuración (por cliente)
En `config_api.google_sheets_conversiones` — un **array** de sheets, cada uno con
sus **pestañas**:

```jsonc
[{
  "id": "uuid",                 // clave de partición: el replace es por sheet
  "name": "Leads WhatsApp",
  "enabled": true,
  "sheet_url": "https://docs.google.com/spreadsheets/d/...",
  "tabs": [{
    "id": "uuid",
    "sheet_name": "Enero",      // vacío = primera pestaña del doc
    "enabled": true,
    "col_fecha": "Fecha", "col_tipo": "Tipo", "col_cantidad": "Cantidad",
    "col_valor": "Valor", "col_fuente": "Fuente", "col_notas": "Notas",
    "custom_columns": {         // columnas extra de ESTA pestaña
      "citas_agendadas": { "col_name": "Citas Agendadas", "type": "count", "label": "Citas", "include": true }
    }
  }]
}]
```

Las configs anteriores (mapeo plano a nivel de sheet, una sola pestaña) siguen
funcionando: `normalizeTabs` las convierte en una pestaña única al leerlas, y la
UI las guarda en formato `tabs` la primera vez que se editan.

### Flujo
`syncClienteConversiones` → por sheet: `fetchConversionesFromSheet` (abre el doc
una vez e itera sus pestañas habilitadas, cada una con su mapeo) →
`computeConversionesAggregates` → `saveConversionesSheetToDb` (replace por sheet)
→ `logSyncResult`. Al final, `cleanupOrphanConversiones`.

### Disparadores
- **Automático**: `GET /api/worker/google-sheets-conversiones` (job `sheets_conversiones`).
- **Manual**: `POST /api/admin/sync-conversiones-offline` desde la UI.
- **Descubrimiento**: `POST /api/admin/list-sheet-tabs` (pestañas del doc) y
  `POST /api/admin/detect-sheet-columns` (encabezados + columnas extra de una pestaña).

### Dónde se usan los datos
- Dashboard y motor de fórmulas: `offline_leads/ventas/revenue/total` y las
  columnas extra como `sheet_<clave>`.
- BI builder e informes programados: las mismas cuatro métricas más las columnas
  extra como `offfield:<tipo>:<clave>` (alias `off__<clave>` en campos
  calculados). El catálogo lo sirve `/api/report-utm/bi/offline-fields`.

---

## WhatsApp (notificaciones a grupos · Baileys)

Notificaciones a **grupos de WhatsApp**, ruteables **por cliente** o **por tipo de notificación**.

### Arquitectura

WhatsApp necesita un proceso persistente (WebSocket vivo + sesión), incompatible con Vercel
serverless. La app nunca importa Baileys; solo habla con `src/lib/whatsapp/gateway.ts`, que
enruta a uno de **dos proveedores** según `WHATSAPP_PROVIDER`:

- **`baileys`** (default): microservicio propio `whatsapp-gateway/` (Node + Baileys), desplegado
  en Railway/Render/Fly/VPS. Auth `Bearer`. Sesión en `public.whatsapp_session`.
- **`evolution`**: [Evolution API v2](https://doc.evolution-api.com/v2) self-hosted (Docker +
  Postgres + Redis), que ya envuelve Baileys con multi-instancia. Auth header `apikey`. Evolution
  gestiona su propia sesión (no usa `whatsapp_session` ni `whatsapp-gateway/`).

```
[Next.js/Vercel] --HTTP--> [gateway.ts dispatcher] --> [whatsapp-gateway propio | Evolution API] --WS--> WhatsApp
       |                                                          |
       +---------------------- Supabase --------------------------+   (ruteo, logs; sesión solo en baileys)
```

Cambiar de proveedor es solo variables de entorno; `notify.ts`, el ruteo, la UI, el cron y el
disparador de ventas no cambian. Mapeo de endpoints en `src/lib/whatsapp/providers/`:

| Operación | `baileys` (gateway propio) | `evolution` (v2) |
|-----------|----------------------------|------------------|
| Estado | `GET /status` | `GET /instance/connectionState/{instance}` |
| QR | `GET /qr` | `GET /instance/connect/{instance}` (`base64`) |
| Grupos | `GET /groups` | `GET /group/fetchAllGroups/{instance}?getParticipants=false` |
| Enviar | `POST /send` | `POST /message/sendText/{instance}` (`{ number: jid, text }`) |

### Componentes

- **Proveedores**: `src/lib/whatsapp/providers/baileys.ts` (microservicio `whatsapp-gateway/`,
  sesión en `public.whatsapp_session`) y `src/lib/whatsapp/providers/evolution.ts` (Evolution API v2).
- **Dispatcher / cliente HTTP**: `src/lib/whatsapp/gateway.ts` (elige proveedor por `WHATSAPP_PROVIDER`).
- **Lógica de envío**: `src/lib/whatsapp/notify.ts` → `sendWhatsAppNotification({ clienteId, notificationType, message })`.
  Resuelve grupos por `whatsapp_routes` (ruta del cliente → fallback global por tipo) y loguea en `whatsapp_messages`.
- **UI admin**: `/admin/whatsapp` (QR/estado, sincronizar grupos, editor de rutas, envío manual, log).

### Disparadores
- **Manual**: acción `sendManualWhatsApp` desde `/admin/whatsapp`.
- **Cron**: `GET /api/cron/whatsapp-digest` (diario) → resumen de métricas, tipo `metrics_summary`.
- **Ventas**: el webhook de Hotmart de Report-UTM dispara `sale.approved` / `sale.refunded`
  tras emitir los webhooks salientes.

### Tipos de notificación
`metrics_summary`, `alert_threshold`, `report_ready`, `sale.approved`, `sale.refunded`, `manual`
(ver `src/lib/whatsapp/types.ts`).

> Config: `WHATSAPP_GATEWAY_URL` + `WHATSAPP_GATEWAY_API_KEY` en Vercel. Ver el README de
> `whatsapp-gateway/` para desplegar y emparejar el número de la agencia.

---

## Resumen

| Integración | Auth | Configuración | Tablas/columnas destino |
|-------------|------|---------------|-------------------------|
| Meta Ads | OAuth (env app + token por cliente) | `/admin/settings/[id]` | `meta_*`, `meta_campaigns/ads/adsets/forms` |
| TikTok Ads | OAuth (env app + token por cliente) | `/admin/settings/[id]` | `tiktok_*`, `tiktok_campaigns/ads/adgroups` |
| GA4 | Cuenta de servicio por cliente | `config_api.ga_*` | `ga_sessions` |
| Hotmart (reporting) | Basic/API key por cliente | `config_api.hotmart_*` + funnel por tab | `ventas_*`, `hotmart_funnel_data` |
| Google Sheets (leads) | Cuenta de servicio (global o por cliente) | `config_api.google_sheets` | `leads`, `leads_diarios` |
| Google Sheets (conversiones offline) | OAuth de la agencia (o cuenta de servicio) | `config_api.google_sheets_conversiones[].tabs[]` | `conversiones_offline`, `conversiones_offline_diarias`, `conversiones_offline_sync_log` |
| Hotmart (Report-UTM) | Webhook HMAC | `report_utm.integrations` | `report_utm.sales_events` |
| WhatsApp | Gateway Baileys (Bearer) **o** Evolution API (apikey), según `WHATSAPP_PROVIDER` | `/admin/whatsapp` + envs del proveedor | `whatsapp_groups/routes/messages` (+ `session` solo en baileys) |
