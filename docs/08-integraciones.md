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

## GoHighLevel (leads del CRM · módulo Report-UTM)

**API**: LeadConnector v2 (`services.leadconnectorhq.com`), autenticada con un
**Private Integration Token** por location.

### Configuración (por cliente)
Desde la tarjeta *GoHighLevel · CRM* de `/report-utm/clientes/[clienteId]`. Pide
Location ID y PIT; el token se guarda cifrado en
`report_utm.integrations.access_token_encrypted` y el Location ID en
`config.location_id`. **Guía completa para el equipo: [doc 20](./20-integracion-gohighlevel.md).**

### Datos sincronizados
Contactos → `report_utm.lead_events` (la MISMA tabla que el formulario web y Meta
Lead Ads; no hay tabla ni fuente de BI nueva). Dos vías que se deduplican por
`external_id = 'ghl:<contactId>'`:

- **Webhook por cliente** (`/api/report-utm/webhooks/ghl/[clienteId]`) — tiempo
  real. El payload del Workflow es solo un aviso: se relee el contacto completo
  con el PIT, así la atribución y los campos personalizados llegan siempre.
  Autenticado con un token compartido en el header `X-Rutm-Ghl-Token`.
- **Polling** (`/api/cron/sync-ghl-leads`, job `ghl_leads`) — backfill de 90 días
  y red de seguridad.

Los campos personalizados se traducen con
`GET /locations/{id}/customFields` (cacheado en `config.custom_fields`) y entran
en `raw_fields` con el **nombre** del campo, de modo que se unifican con los de
Meta y los del formulario web desde `lead_campos.claves_origen`.

> **GHL es fuente única por cliente**: al activarlo se pausan sus integraciones
> `s2s` y `meta_lead_ads`. `lead_events` no deduplica por email ni teléfono, así
> que dos vías activas contarían dos veces a la misma persona.

Ver `migrations/074_report_utm_ghl_leads.sql` para el diseño y la regla del
cruce (`utm_id` = id de campaña o de anuncio; `mediumId` nunca).

---

## Google Sheets — Leads (RETIRADA, migración 059)

Existía una segunda integración de Google Sheets, separada de la de conversiones
offline: pedía un JSON de cuenta de servicio, importaba una hoja de leads de Meta
a `leads` / `leads_diarios` y calculaba una tasa de calificación. **Se retiró**:
su hoja se sincroniza ahora por el módulo unificado
(`config_api.google_sheets_conversiones`, con `count_rows: true` y
`tipo_fijo: 'lead'`), y su `quality_field` pasó a ser un campo de Sheet con una
vista.

Qué se borró: `src/lib/integrations/google-sheets.ts`,
`/api/worker/google-sheets`, `/api/admin/sync-google-sheets`,
`GoogleSheetsLeadsCard`, la card del formulario de cliente y la acción
`syncGoogleSheets`.

**Qué NO se borró, y por qué:**

- Los cuatro nombres de métrica —`leads_totales`, `leads_calificados`,
  `leads_no_calificados`, `tasa_calificacion`— siguen en `formula-engine` y en
  los catálogos de layouts. Hay tarjetas y columnas guardadas que los usan, así
  que ningún layout necesita edición: `getSheetCamposDelDia` los reconstruye
  desde el campo reservado `calidad_lead` y la vista `leads_calificados`.
- Las tablas `leads` y `leads_diarios`. El dashboard las sigue leyendo para las
  fechas anteriores a la migración —tienen **prioridad** sobre el pipeline
  nuevo—, de modo que la serie no da un escalón el día del cambio. Son además la
  referencia contra la que se cuadra.
- El tipo de job `sheets_leads`, porque `sync_jobs` puede tener filas históricas
  con ese valor; el runner las enruta al worker unificado.

**Cómo se migra un cliente:**

```bash
npx tsx scripts/migracion-leads-legacy.ts inventario   # quién la usa y con qué datos
# aplicar migrations/059 y sincronizar el sheet migrado desde /admin/settings
npx tsx scripts/migracion-leads-legacy.ts campos       # crea campo + vista y recalcula
npx tsx scripts/migracion-leads-legacy.ts cuadre 30    # GATE: legacy vs pipeline nuevo
```

El modo `campos` es idempotente y aborta solo si falta la migración 059. El
`cuadre` sale con código 1 mientras haya días que no coincidan.

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
    "custom_columns": {         // LEGACY, sin UI (ver abajo)
      "citas_agendadas": { "col_name": "Citas Agendadas", "type": "count", "label": "Citas", "include": true }
    },
    "raw_mode": "all",          // capa cruda: 'all' (defecto) | 'declared' | 'none'
    "raw_exclude": ["email"]    // columnas que nunca se guardan en crudo (PII)
  }]
}]
```

Las configs anteriores (mapeo plano a nivel de sheet, una sola pestaña) siguen
funcionando: `normalizeTabs` las convierte en una pestaña única al leerlas, y la
UI las guarda en formato `tabs` la primera vez que se editan.

> **`custom_columns` es legacy y ya no se puede editar.** Era el sistema de "una
> columna = una métrica" (bloque "Columnas adicionales" del formulario), que los
> **campos de Sheet** reemplazan: un campo une columnas equivalentes de varias
> pestañas, agrupa sus valores y se puede filtrar. Tener las dos formas a la vista
> confundía, así que se retiró el bloque de la UI.
>
> Lo que sigue vivo, para no romper lo ya construido: el sync respeta las
> `custom_columns` existentes, los tokens `offfield:*` siguen resolviéndose en el
> BI y las variables `sheet_*` en el dashboard. Simplemente no se pueden crear
> nuevas. `POST /api/admin/detect-sheet-columns` se conserva porque la validación
> del sheet lo usa para leer encabezados.

### Flujo
`syncClienteConversiones` → por sheet: `fetchConversionesFromSheet` (abre el doc
una vez e itera sus pestañas habilitadas, cada una con su mapeo) →
`computeConversionesAggregates` → `saveConversionesSheetToDb` (replace por sheet)
→ `logSyncResult`. Al final, `cleanupOrphanConversiones`.

### Las dos capas del sync
`parseTabPayload` recorre cada pestaña una sola vez y produce dos cosas:

| Capa | Tabla | Qué entra |
|---|---|---|
| Interpretada | `conversiones_offline` (+ `_diarias`) | El modelo de siempre: fecha/tipo/cantidad/valor/fuente/notas y las `custom_columns` ya tipadas. Solo filas con `cantidad > 0`. |
| Cruda | `sheet_filas` | La fila tal cual, con todas sus columnas sin convertir. Se guarda **aunque no sea conversión** (`cantidad <= 0`), porque igual tiene valores de campo. |

La capa cruda es la base de los **campos de Sheet**: permite definir un campo que
une columnas equivalentes de varias pestañas y recalcularlo leyendo solo de la
base, sin volver a llamar a Google. Qué columnas se guardan lo controla
`raw_mode` / `raw_exclude` por pestaña; `detectSheetColumns` marca las columnas
de PII o alta cardinalidad con `sensible: true` para proponerlas excluidas.

La fecha sigue siendo obligatoria en ambas capas: es el eje temporal del módulo.
Un fallo al escribir `sheet_filas` **no** tumba el sheet — las conversiones ya
están guardadas y el motivo queda como aviso en el log de sync.

### El `sheet_id` es la clave de partición
`conversiones_offline`, `conversiones_offline_diarias` y `sheet_filas` se
particionan por `sheet_id` (el `id` de la entrada en `config_api`, **no** el id
del documento de Google). De ahí tres reglas:

- **La URL se bloquea al guardar.** Apuntar una entrada existente a otro
  documento mezclaría dos documentos en la misma partición. Para cambiar de
  documento se elimina la entrada y se añade otra.
- **Eliminar un sheet borra sus datos en el acto**, vía
  `POST /api/admin/sheets-conversiones/eliminar`, que va por tandas y responde
  `done:false` mientras queden filas. Antes solo se quitaba del JSON y las filas
  esperaban a que un sync futuro las barriera como huérfanas — barrido que se
  hacía en una sola sentencia, no cabía en el `statement_timeout` y cuyo error se
  descartaba, así que en la práctica se quedaban para siempre.
- **Deshabilitar NO borra.** `cleanupOrphanConversiones` recibe todos los sheets
  configurados, no solo los habilitados; quitar la casilla pausa el sync y
  conserva la historia.

Para el residuo ya existente: `npx tsx scripts/limpiar-sheets-huerfanos.ts`
(informe; `--apply` para borrar).

### Disparadores
- **Automático**: `GET /api/worker/google-sheets-conversiones` (job `sheets_conversiones`).
- **Manual**: `POST /api/admin/sync-conversiones-offline`, con tres modos:

  | body | qué hace |
  |---|---|
  | `{ clientId, sheetId, tabId, batchId }` | sincroniza UNA pestaña dentro del lote |
  | `{ clientId, sheetId, batchId, consolidar, aggregates, quality }` | cierra el lote de ese sheet |
  | `{ clientId, sheetId?, recalcularCampos? }` | documento(s) enteros de una vez |

  **"Sincronizar todos ahora" va pestaña a pestaña.** Un documento de decenas de
  miles de filas no cabe en el `maxDuration`: leer las tres pestañas de un sheet
  real costaba 73 s (11,6 + 15,0 + 37,7 de lectura + 9,4 de cierre), la petición
  moría y devolvía la página de error de la plataforma en texto plano — no JSON.
  Troceado, la más lenta son 37,7 s.

  Todas las pestañas comparten `sync_batch_id` y **hasta la consolidación no se
  toca el dato anterior**: una corrida interrumpida deja un lote suelto, que el
  siguiente sync retira, pero nunca deja al cliente sin datos. Por eso la UI no
  consolida si ninguna pestaña salió bien.

  Los agregados viajan en su forma **parcial** (`ConversionDiariaParcial`, con las
  sumas de los porcentajes sin dividir) y se suman en la consolidación:
  `uq_conv_diarias_origen` es único por (cliente, sheet, fecha, tipo, fuente)
  **sin la pestaña**, así que dos pestañas que aporten al mismo día se pisarían si
  cada una escribiera su agregado, y promediar promedios ya calculados daría otro
  número. Lo verifica `npx tsx scripts/verify-sync-por-pestana.ts --cliente=UUID`.
- **Descubrimiento**: `POST /api/admin/list-sheet-tabs` (pestañas del doc) y
  `POST /api/admin/detect-sheet-columns` (encabezados de una pestaña; lo usa la
  validación del sheet para avisar de columnas mapeadas que no existen).

### Campos de Sheet

Sobre la capa cruda se definen los **campos**: el problema que resuelven es que
la misma pregunta se llama `rango de ingresos` en un formulario y
`cuál es tu rango de ingresos` en otro, y sus respuestas se escriben `20 a 100`
en una hoja y `20-100` en la otra.

Un campo se define por cliente (tabla `sheet_campos`, no en `config_api`) con:

- **nombre visible** — el que se ve en el BI, el Layout Builder y las tablas. La
  `clave` es un slug **inmutable**: renombrar el campo no rompe informes.
- **orígenes** — N pestañas × N columnas equivalentes, con `*` como comodín y una
  regla `combinar` (`primero` / `suma` / `concat`) cuando hay varias columnas.
- **mapa de valores** — junta las formas distintas de escribir lo mismo en un
  bucket con nombre propio.
- **agregación** — `count` / `sum` / `avg` / `min` / `max`.

El resultado es un **desglose diario por valor** (`sheet_campo_valores_diarios`),
que es lo que permite las tres cosas a la vez: usar el campo como métrica,
agrupar y graficar **por** él como dimensión, y filtrar por sus valores desde
cualquier widget. Encima se guardan **vistas** con nombre propio
(`sheet_campo_vistas`) del estilo "Leads 20-100", que se comportan como una
métrica sumable más.

**Flujo:** UI (`admin/settings/components/sheet-campos/`) → server actions →
`/api/admin/sheet-campos*` → `recalcularCamposCliente` (`lib/sheets/campos-db.ts`)
→ `computeCampoValoresDiarios` (`lib/sheets/campos.ts`, puro y client-safe).

Esa función pura es la única que sabe calcular un campo: la usan por igual el
recálculo bajo demanda, el sync diario y la vista previa del agrupador, así que
los tres no pueden dar números distintos.

**El recálculo nunca llama a Google.** Lee de `sheet_filas`, así que crear o
editar un campo y ver el resultado tarda un segundo. El sync diario lo dispara al
final, con la capa cruda ya reemplazada; si falla, no tumba el sync (las
conversiones ya están guardadas y el recálculo se puede repetir solo).

### Dónde se usan los datos
- Dashboard y motor de fórmulas: `offline_leads/ventas/revenue/total` y las
  columnas extra como `sheet_<clave>`.
- BI builder e informes programados: las mismas cuatro métricas más las columnas
  extra como `offfield:<tipo>:<clave>` (alias `off__<clave>` en campos
  calculados). El catálogo lo sirve `/api/report-utm/bi/offline-fields`.

### Tokens de los campos de Sheet

| Uso | Token del BI | Alias en fórmulas | Clave en el dashboard clásico |
|---|---|---|---|
| Dimensión (agrupar / filtrar) | `sheetdim:<clave>` | — | — |
| Métrica del campo | `sheetagg:<agg>:<clave>` | `sf__<clave>` | `sf_<clave>` |
| Vista guardada | `sheetview:<clave>` | `sv__<clave>` | `sv_<clave>` |

La agregación viaja dentro del token de métrica para que un widget ya guardado
siga midiendo lo mismo aunque después se cambie la agregación por defecto del
campo. Los prefijos planos son `sf_`/`sv_` y **no** `sheet_`, que ya lo produce
el aplanado de `custom_fields`: una colisión cambiaría en silencio los valores
de layouts existentes.

El catálogo lo sirve `/api/report-utm/bi/sheet-fields`; la disponibilidad sale
del propio desglose diario, así que dice la verdad sobre si hay datos.

**Lo que un campo de Sheet no puede hacer**, y por qué: el Sheet no guarda a qué
lead corresponde cada fila, así que su desglose no cruza con `lead_events` /
`sales_events` / `metricas_diarias`. En consecuencia, al agrupar por un campo de
Sheet las métricas de otras fuentes salen en cero (mismo criterio que ya seguía
el motor con las dimensiones de anuncio), un filtro por campo de Sheet cuenta
como **no atribuible** y anula el gasto, y no se admite como eje de tabla
dinámica. El editor avisa de los tres casos.

Las etapas de embudo con vistas de Sheet quedan pendientes: `runFunnelQuery`
consulta tres fuentes fijas y añadir una cuarta es trabajo aparte.

### En el dashboard clásico

Las claves planas `sf_<clave>` / `sv_<clave>` las inyecta
`cargarMetricasEnriquecidas` (`dashboard/_actions.ts`), el único camino que
comparten el dashboard, el espejo público por token, el archivo de pestañas y el
periodo anterior de los comparativos. El merge en sí es puro y vive en
`src/lib/dashboard/merge-metrics.ts`.

**Agregación por fechas.** Un campo con agregación no aditiva (promedio, mínimo,
máximo) lleva sus sumandos dentro de la propia fila (`sf_x__num` / `sf_x__den`, o
`__min` / `__max`, ver `clavesPlanasDelDia`). `aggregateFormula` los detecta por
el nombre y recalcula en vez de sumar. El convenio es libre de colisiones por
construcción: `sanitizarColumna` colapsa cualquier racha de símbolos en un solo
`_`, así que ninguna clave puede contener `__`.

El guard está acotado a `sf_`/`sv_` a propósito: `meta_frequency`,
`ga_bounce_rate` y `ga_avg_session_duration` también se suman mal al agrupar,
pero corregirlo cambiaría cifras de dashboards que los clientes ya validaron.
Hay una comprobación que falla si alguien lo "arregla" de paso.

El catálogo de métricas del dashboard vive en `src/lib/dashboard/metric-catalog.ts`
(puro, comprobable sin React); `LayoutConfigModal` lo reexporta.

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
| Google Sheets — Leads | RETIRADA (migración 059) | `config_api.google_sheets` (respaldo) | `leads`, `leads_diarios` (solo lectura) |
| Campos de Sheet | — (capa sobre lo anterior) | `sheet_campos`, `sheet_campo_vistas` | `sheet_campo_valores_diarios` |
| Google Sheets (conversiones offline) | OAuth de la agencia (o cuenta de servicio) | `config_api.google_sheets_conversiones[].tabs[]` | `conversiones_offline`, `conversiones_offline_diarias`, `conversiones_offline_sync_log` |
| Hotmart (Report-UTM) | Webhook HMAC | `report_utm.integrations` | `report_utm.sales_events` |
| WhatsApp | Gateway Baileys (Bearer) **o** Evolution API (apikey), según `WHATSAPP_PROVIDER` | `/admin/whatsapp` + envs del proveedor | `whatsapp_groups/routes/messages` (+ `session` solo en baileys) |
