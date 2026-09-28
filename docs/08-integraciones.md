# 08 · Integraciones externas

La aplicación integra cinco fuentes de datos. Cada cliente configura sus credenciales en `config_api` desde `/admin/settings/[id]`. Meta y TikTok se conectan vía OAuth; Hotmart vía OAuth (HotConnect) o con credenciales; GA4 con credenciales manuales; Google Sheets con cuenta de servicio.

El sincronizador principal (`/api/worker`) consulta todas estas APIs a diario y consolida en `metricas_diarias`. Ver [doc 14 · Cron y workers](./14-cron-y-workers.md).

---

## Meta Ads (Facebook / Instagram)

**API**: Facebook Graph API v19.0.

### Conexión (OAuth)

1. Desde `/admin/settings/[id]`, un admin/superadmin inicia OAuth → `GET /api/auth/meta?client_id=…`. Sin ese rol responde 401/403.
2. El `state` va firmado (HMAC con `CRON_SECRET`, caduca a los 10 min) y su nonce queda en la cookie httpOnly `meta_oauth_state` (`lib/integrations/oauth-state-cliente.ts`). Facebook pide consentimiento (scopes `ads_read`, `business_management`, `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`).
3. `GET /api/auth/meta/callback` valida el `state` contra la cookie **antes** de canjear el código; si no cuadra, vuelve con `meta_error` sin tocar la base. Después intercambia el código por un token de larga duración (~60 días) y lo funde en `config_api` con `fusionar_config_api`:
   - `meta_token`, `meta_token_expires_at`, `meta_connection_status`. Las cuentas no se importan: el admin las elige con «Elegir cuentas» (`meta_accounts`).

### Renovación automática

`GET /api/cron/refresh-meta-tokens` (diario) renueva los tokens que expiran en menos de 10 días usando `META_APP_ID`/`META_APP_SECRET` (grant `fb_exchange_token`). Si falla, marca `meta_connection_status = expired`.

### Datos sincronizados

El worker consulta _insights_ a nivel **campaña**, **anuncio** y **conjunto de anuncios**, además de **formularios de leads**. (No se piden desgloses demográficos de edad o género: ningún `breakdown` los solicita.) Calcula conversiones personalizadas y enriquece con regiones de targeting. Se guardan en:

- Totales: `meta_spend`, `meta_impressions`, `meta_clicks`.
- JSONB: `meta_campaigns`, `meta_ads`, `meta_adsets`, `meta_forms`.

### Miniaturas

`GET /api/v1/ad-thumbnails` obtiene `thumbnail_url`, `effective_object_story_id` y `preview_shareable_link` de los anuncios.

---

## TikTok Ads

**API**: TikTok Business API v1.3.

### Conexión (OAuth)

1. `GET /api/auth/tiktok?client_id=…` (solo admin/superadmin) firma el `state`, deja el nonce en la cookie httpOnly `tiktok_oauth_state` y redirige al consentimiento de TikTok.
2. `GET /api/auth/tiktok/callback` valida el `state` contra la cookie **antes** de canjear el código, intercambia `auth_code` → `access_token` y lo funde en `config_api` con `fusionar_config_api`:
   - `tiktok_access_token`. Las cuentas no se importan: el admin las elige con «Elegir cuentas» (`tiktok_accounts: [{ advertiser_id, name }]`).
   - Los tokens de TikTok **no expiran** (a diferencia de Meta).

### Datos sincronizados

El worker llama a `report/integrated/get` a nivel campaña/anuncio/grupo. Se guardan en:

- Totales: `tiktok_spend`, `tiktok_impressions`, `tiktok_clicks`, `tiktok_conversions`.
- JSONB: `tiktok_campaigns`, `tiktok_ads`, `tiktok_adgroups`.

> El motor de fórmulas puede filtrar métricas TikTok por `advertiser_id` (cuando un cliente tiene varias cuentas). Ver `filterRowByTikTokAccount` en [doc 09](./09-motor-de-formulas.md).

### Moneda y zona horaria de la cuenta

En cada sync de TikTok el worker llama a `/advertiser/info/` (una vez al día por cuenta, cacheado) y deja el resultado en `config_api.tiktok_cuentas_info`:

```json
{
  "7387511059776798737": {
    "currency": "CLP",
    "timezone": "America/Santiago",
    "display_timezone": "America/Santiago",
    "nombre": "…",
    "ts": "2026-09-28T…"
  }
}
```

Se escribe con `fusionar_config_api` (mismo camino que `meta_estado_cuentas`) y es clave **solo de servidor**: guardar la pestaña TikTok no la pisa. `timezone` es la zona con la que TikTok corta `stat_time_day`, que no tiene por qué ser la de Colombia. Helper: `tiktokInfoCuenta(advertiserId, token)` en `src/lib/tiktok/cuenta.ts`. Todavía no la consume nadie: queda lista para la conversión de moneda y la zona por cliente.

### Reconciliación

`/api/worker/reconcile` audita también TikTok (`AUCTION_ADVERTISER` por día) y el planner la encola para cualquier cliente con Meta **o** TikTok. TikTok rechaza informes diarios de más de 30 días, así que los 120 días por defecto se piden en ventanas de ≤30 (`trocearRangoDias`, `src/lib/tiktok/rangos.ts`). Si una ventana falla, sus días se descartan en vez de compararse a medias.

### Lead Generation (formularios instantáneos → Report-UTM)

Ingesta de los leads de los **Instant Forms** de TikTok en `report_utm.lead_events`, igual que Meta Lead Ads. Cada lead cuenta en `leads.count`, CPL, campos y segmentos de lead.

**Activación (por cuenta):** poner `"tiktok_leads": true` en la entrada de la cuenta dentro de `config_api.tiktok_accounts[]` (o en la raíz de `config_api` para activar todas / la config legacy de una cuenta). Todavía no hay interruptor en la UI; la pestaña TikTok conserva la clave al guardar. Para leads de EEE/Suiza/Reino Unido, añadir `"lead_region": "eu"` a la cuenta (TikTok exige la cabecera `x-lead-region`).

**Requisitos del token:** el usuario que conecta TikTok debe ser **Admin** del anunciante y la app de TikTok for Business debe tener concedido el alcance de **Lead management / Instant Page** (además de Ads Management y Reporting, que ya usa el sync de gasto). Si falta, el error de la integración lo dice explícitamente; hay que reconectar TikTok tras añadir el alcance en la app. Si los formularios se migraron a un _form library_ del Business Center (`/page/library/transfer/`), la descarga por `advertiser_id` deja de verlos: no está soportado todavía.

**Cómo funciona** (`src/lib/report-utm/tiktok-leads.ts`):

1. `GET /page/get/?business_type=LEAD_GEN` → formularios de cada cuenta (caché de 6 h).
2. Por formulario: `POST /page/lead/task/` crea una tarea de descarga, se sondea hasta `SUCCEED` y `GET /page/lead/task/download/` devuelve un CSV (UTC+0) con **todos** los leads que TikTok conserva (90 días).
3. Cada fila → `lead_events` con `external_id = tiktok:<lead_id>` (idempotente por el índice único `(cliente_id, external_id)`), `source = form_plugin = 'tiktok_lead_ads'`, UTMs sintetizadas (`utm_source=tiktok`, `utm_medium=paid_social`, `utm_campaign`=campaña, `utm_content`=anuncio, `utm_term`=conjunto, `utm_id`=campaign_id), los tres IDs publicitarios (082), `created_at` = hora del lead y las respuestas en `raw_fields` con la cabecera original. Se aplican la regla de exclusión y la de duplicados del cliente, igual que Meta. Los leads de prueba (`is_test`) se descartan.

**Estado:** `report_utm.integrations` con `tipo = 'tiktok_lead_ads'` (el cron la crea la primera vez que ve el flag; ponerla en `inactive` la pausa). En `config`: `sync_cursor` (unix del lead más reciente), `backfill_done`, `forms`, `forms_leidos`, `form_offset`.

**Disparo:** `GET|POST /api/cron/sync-tiktok-leads[?clienteId=<report_utm cliente>]`, protegido por `CRON_SECRET`. **No está en el plan diario**: `public.sync_jobs.tipo` tiene un CHECK que rechazaría un tipo `tiktok_leads`, y ampliarlo exige una migración. Hasta entonces, programar el endpoint aparte (GitHub Actions / cron externo).

**Límites:** si el CSV de un formulario supera 10 MB TikTok lo entrega en ZIP, que este importador no lee (error explícito en `last_error`); no hay webhook de TikTok configurado, así que la latencia es la del cron.

---

## Google Analytics 4

**API**: `@google-analytics/data` (Data API). Declarado como `serverExternalPackages` en `next.config.ts`.

### Configuración

- **Conexión de agencia (preferida).** Una sola cuenta de Google para toda la agencia (Ajustes → Conexión Google, `app_integrations.provider = 'google'`). El flujo `/api/auth/google` exige rol admin y un `state` firmado ligado a una cookie (`google-oauth-state.ts`).
- **Por cliente**, en `config_api`: `ga_property_id` (ID numérico, p. ej. `524635063`), `ga_property_name` y `ga_account_name`, que se rellenan con el **selector de propiedades**. No escribas el ID a mano: la cuenta de la agencia tiene que verla.
- **Service account (legacy):** `ga_client_email` + `ga_private_key`. Solo se usa si no hay conexión de agencia.
- **«Probar conexión»** (`probarAccesoGa4`) hace una consulta real. Si falla, dice si la cuenta de la agencia ve la propiedad y qué acceso darle.

La precedencia de credenciales vive en `lib/integrations/ga4-cliente.ts` (`crearClienteGa4`), compartida por el worker, el desglose y la prueba.

### Datos sincronizados

| Qué                                      | Dónde                                                                             | Cómo                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sesiones, rebote y duración del sitio    | `metricas_diarias.ga_sessions`, `ga_bounce_rate` (0-1), `ga_avg_session_duration` | Job `metricas`, un `runReport` por día sin dimensiones                                                                     |
| Vistas de las páginas del embudo         | `hotmart_funnel_data.by_tab.*` y `hotmart_pagos_iniciados`                        | Job `metricas`, `screenPageViews` por `pagePath`/`pageTitle` de las URL de cada pestaña (VISTAS, no sesiones)              |
| **Sesiones y eventos clave por campaña** | `ga4_sesiones_diarias`, `ga4_eventos_clave_diarios`, `ga4_estado` (migración 097) | Job `ga4` (`/api/worker/ga4`, `ga4-desglose.ts`): ventanas de 31 días con `date` + fuente/medio/campaña/`utm_id`, paginado |

El desglose se re-pide los últimos 4 días a diario (`planDiario`). Al guardar una propiedad nueva se encolan ~13 meses. El último error de GA4 queda en `ga4_estado.ultimo_error` y aparece en la salud de fuentes.

En el motor de fórmulas, el alias `$visitas` apunta por defecto a `ga_sessions`. En el BI, GA4 por campaña es la fuente `ga4` (tokens `ga4_*` y `ga4ev:<evento>`), que cruza con el gasto y los leads por campaña: ver el [doc 26](./26-auditoria-ga4.md).

---

## Hotmart

**API**: Hotmart Payments API (`/payments/api/v1/sales/history` y `sales/commissions`
en `developers.hotmart.com`; el token se pide a `api-sec-vlc.hotmart.com`). Código:
`src/lib/hotmart/`.

Las ventas viven en **`public.hotmart_ventas`**, una fila por transacción (ver
[doc 04](./04-modelo-de-datos.md#hotmart_ventas-migraciones-065-y-089)). La alimentan
la API (sync diaria, backfill y reconciliación) y el webhook (en vivo) con el mismo
parser (`src/lib/hotmart/parser.ts`), y `metricas_diarias` se agrega **desde la
tabla**, nunca desde la respuesta de la API.

### Conexión (por cliente)

Dos modos, según `config_api.hotmart_auth_mode`:

| Modo               | Claves en `config_api`                                                                     | Token                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| HotConnect (OAuth) | `hotmart_access_token_enc`, `hotmart_refresh_token_enc`, `hotmart_token_expires_at`        | Lo renueva `/api/cron/refresh-hotmart-tokens` (< 30 min del vencimiento) o `obtenerToken` en línea |
| Credenciales       | `hotmart_client_id` + `hotmart_client_secret_enc`, o `hotmart_basic_enc` (Basic ya armado) | `obtenerToken` pide uno nuevo en cada corrida                                                      |

- **Los secretos se guardan cifrados** (`*_enc`, con `RUTM_ENCRYPTION_KEY`).
  `hotmart_client_id` va en claro: identifica la credencial, no la autoriza. Las
  claves planas (`hotmart_client_secret`, `hotmart_basic`, `hotmart_token`) son las
  heredadas: se leen si existen y se migran a su `*_enc` la primera vez que consiguen
  token (`parcheMigracionCredenciales`), dejando la plana en `null`. La ficha del
  cliente nunca recibe los secretos: llegan enmascarados y solo se reescriben si se
  teclea uno nuevo.
- `hotmart_token_enc` (el «Access Token Temporal» del formulario) **no lo usa la
  sincronización**.
- **Probar conexión** parte de la config guardada con lo tecleado encima y usa el
  mismo `obtenerToken` que el worker. Antes leía el access token en claro —`null`
  tras el cifrado— y marcaba como caídas conexiones de HotConnect que funcionaban.
- **Carrera de refresco.** El cron y el refresco en línea pueden gastar el mismo
  refresh token, que Hotmart rota en cada uso: el segundo recibe `invalid_grant`
  aunque la conexión esté sana. Antes de darla por muerta, los dos releen
  `config_api` (`renovadoPorOtro`); el cron lo anota como `skipped_concurrent`.

### Estados que se piden a la API

`sales/history` **sin** `transaction_status` solo devuelve las ventas `COMPLETE`
(sondeo del 2026-09-25 con `diagnostico-hotmart --estados`: 88 de 88, ningún
reembolso), así que la sync diaria nunca veía una devolución. Ahora pide la lista
explícita `ESTADOS_API_SYNC` (`sync.ts`) con el parámetro repetido, y la API devuelve
la unión.

- **Un solo valor inválido tumba la petición entera** con 400 `invalid_parameter`:
  `BILLET_PRINTED` no existe (el válido es `PRINTED_BILLET`), y así empezó el
  incidente del 2026-08-18. Si vuelve a pasar, `sincronizarDiaHotmart` repite la
  petición sin filtro (solo `COMPLETE`, para no quedarse ciega) y lo deja en el log.
  La lista se revisa con `npm run diagnostico:hotmart -- --estados`.
- **Un status que no está en el mapa no cuenta.** `ESTADO_POR_STATUS_API`
  (`eventos.ts`) traduce cada status a un `estado`; uno desconocido se descarta y se
  avisa en el log. Antes caía a «aprobada», y `NO_FUNDS` o `BLOCKED` entraban como
  facturación cobrada. Las traducciones que no son obvias:

| Status de la API                                                                                  | `estado`    | Por qué                                                                           |
| ------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `PROTESTED`                                                                                       | `aprobada`  | En disputa: el dinero sigue cobrado hasta que Hotmart resuelva                    |
| `PARTIALLY_REFUNDED`                                                                              | `aprobada`  | La venta sigue en pie y el importe devuelto no se conoce; queda en `estado_crudo` |
| `NO_FUNDS`, `BLOCKED`                                                                             | `cancelada` | Rechazo del medio de pago: no se cobró ni se cobrará                              |
| `PRINTED_BILLET`, `PROCESSING_TRANSACTION`, `PRE_ORDER`, `OVERDUE`, `WAITING_PAYMENT`, `STARTED`… | `pendiente` | Todavía no es dinero                                                              |

En el webhook, `PURCHASE_PROTEST` y `PURCHASE_OUT_OF_SHOPPING_CART` **no son
ventas** (`EVENTOS_NO_VENTA`): se responden con 200 y no tocan nada. Antes el primero
bajaba una venta cobrada a pendiente y el segundo guardaba carritos abandonados.

### Datos sincronizados

El worker trae historial y comisiones de cada día, los guarda en `hotmart_ventas` y
agrega desde ella (`agregarDesdeHotmartVentas`). Cada venta se **clasifica por
embudo** con la configuración de la pestaña (`hotmart_funnel`), en cascada: código de
oferta mapeado, flag de order bump de Hotmart, transacción padre y, como red de
seguridad, los patrones de nombre `principal_names`, `bump_names`, `upsell_names`
(soportan `%`/`_` tipo SQL LIKE).

Se consolidan en:

- Totales: `ventas_principal/bump/upsell/downsell` (neto, solo lo cobrado),
  `*_bruto`, `*_count`, `ventas_reembolsado(_count)`, `hotmart_pagos_iniciados`.
- JSONB: `hotmart_funnel_data` (desglose `by_tab` + `extras`).

Quien cambie la tabla por otro camino (reclasificar, reconciliar, el webhook, una
aprobación que mueve la venta de día) **reagrega** esas fechas con
`reagregarFechasHotmart` (`src/lib/hotmart/reagregar.ts`). Antes el dashboard se
quedaba con la foto vieja hasta que el worker volviera a descargar ese día.

> La API y el webhook **ya no son flujos independientes**: los dos escriben en
> `hotmart_ventas`, y el webhook además espeja en `report_utm.sales_events` (crudo y
> atribución del píxel). Por eso las métricas `sales.*` del BI excluyen
> `platform = 'hotmart'`: esas ventas se cuentan en la fuente `hotmart` (`hm_*`), ya
> convertidas y con reembolsos. Los dos se configuran en la misma pantalla:
> `/admin/settings/[id]`, sección «Captación y atribución».

### Webhook (ventas en vivo)

Tarjeta **«Hotmart · Webhook»** de `/admin/settings/[id]`. **Hasta el 2026-09-25
ningún cliente llegó a configurarlo**: la tarjeta pedía registrar en Hotmart un
secreto nuestro como hottok, pero el hottok lo genera Hotmart (uno fijo por cuenta,
no editable), así que un evento real no podía pasar la validación. Alta en tres
pasos:

1. En Hotmart, **Herramientas → Webhook (API y notificaciones)** → nueva
   configuración, **versión 2.0.0**, con la URL que muestra la tarjeta
   (`/api/report-utm/webhooks/hotmart/{id}`, el id de `report_utm.clientes`). Eventos:
   `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_CANCELED`, `PURCHASE_REFUNDED`,
   `PURCHASE_CHARGEBACK`, `PURCHASE_EXPIRED`, `PURCHASE_DELAYED` y
   `PURCHASE_BILLET_PRINTED`. El resto se ignora con 200.
2. Copiar el **hottok** que muestra esa misma pantalla y pegarlo en la tarjeta
   **antes** de activar el webhook. Se guarda cifrado en
   `report_utm.integrations.config.hottok_enc` (más `hottok_final`, los cuatro
   últimos caracteres, para reconocerlo). Sin hottok los eventos se rechazan.
3. Esperar un evento real y comprobar «Último evento recibido». **No usar el envío de
   prueba de Hotmart**: manda una compra ficticia que entraría como venta.

**Autenticación** (`src/lib/report-utm/webhook-auth.ts`): la cabecera
`X-HOTMART-HOTTOK` (o `body.hottok`) se compara con el hottok pegado. Quedan dos vías
heredadas contra **nuestro** secreto, en «Avanzado» de la tarjeta: HMAC-SHA256 del
cuerpo en `X-Hotmart-Signature` (Hotmart no firma así; sirve para integraciones
propias) y `?hottok=<secreto>` en la URL, que no se anuncia porque el secreto acaba
en los logs.

Con cada evento:

- Escribe en `hotmart_ventas` (guarda de `guardar_hotmart_venta`) y reagrega en el
  acto las fechas afectadas de `metricas_diarias`.
- Espeja en `sales_events` **solo si el evento se aplicó como el más reciente**: un
  reintento viejo no pisa el status ni avisa a nadie.
- Notificación y webhooks salientes, **una vez por estado**: con la 089, reclamando
  `hotmart_ventas.notificado_estado` con un UPDATE condicional; sin ella, comparando
  con el status previo de `sales_events`. `PURCHASE_COMPLETE` ya no manda una segunda
  «Venta aprobada».
- `PURCHASE_CANCELED` queda como `status = 'canceled'` en `sales_events` (antes
  `refunded`): no cuenta como reembolso ni avisa «Venta reembolsada».
- Sin divisa en el payload, `currency` queda `null` (antes se asumía BRL) y no se
  envía la conversión a Meta CAPI ni a Google Ads.
- Google Ads solo recibe un `gclid` explícito, y Meta CAPI solo un `fbclid` explícito.

### Atribución: de dónde sale la campaña de una venta

Hotmart **no guarda las `utm_*` del checkout**: solo `src`, `sck` y `xcod` (en la
API, `tracking.source` es el `src` y `tracking.external_code` el `xcod`). El parser
(`extraerOrigen`) arma la tupla UTM así:

1. Las `utm_*` explícitas del payload, si las hay, mandan.
2. **`src` empaquetado.** Sin UTM explícitas, `desplegarSrc` despliega un `src` con la
   forma `campaña-ubicación-red-anuncio-conjunto` —la convención de las landings de
   Cris tributario,
   `{{campaign.name}}-{{placement}}-{{site_source_name}}-{{ad.name}}-{{adset.name}}`—
   en `utm_campaign`, `utm_source`, `utm_medium`, `utm_content` y `utm_term`. Es la
   misma convención de sus leads, así que ventas y leads cruzan con el mismo
   resolver. El ancla es la ubicación (`Instagram_Feed`) seguida de la red (`ig`,
   `fb`…); un `src` con otra forma se guarda tal cual en `utm_source`.
3. **`sck` (o `src`) con un ID de anuncio** —solo dígitos, 10 o más— va a `utm_id`, y
   el resolver lo cruza por ID exacto. **Recomendación: añadir `sck={{ad.id}}` al
   enlace del checkout en el anuncio**; es la forma de atribuir sin configurar nada
   más.
4. `click_id` solo sale de `fbclid` / `gclid` / `ttclid` / `click_id`. Ya **no** cae a
   `xcod`, que es un código libre del productor.

Una venta con campaña o ID de anuncio propios queda con
`atribucion_metodo = 'tracking'`. Sin ellos, **hereda la tupla de un lead**
(`src/lib/hotmart/atribucion.ts`):

- La del **último lead del mismo email** anterior a la compra (180 días atrás, con 5
  minutos de margen) → `lead_email`; si no hay, la del mismo teléfono (últimos 9
  dígitos) → `lead_telefono`. Solo leads no excluidos y con campaña.
- Un bump, upsell o downsell hereda la de **su compra principal** → `padre`.
- La tupla viaja en bloque (nunca la campaña de un origen con el anuncio de otro) y un
  lead nunca pisa un tracking.

Corre antes de guardar en la sync, el backfill y el webhook, y a diario sobre los
últimos 30 días (job `hotmart_reconciliar`) para las ventas cuyo lead llegó después.
Para el histórico:

```bash
npx tsx --conditions=react-server scripts/atribuir-hotmart-leads.ts            # en seco: cobertura, sin escribir
npx tsx --conditions=react-server scripts/atribuir-hotmart-leads.ts --aplicar  # escribe (exige la 089)
```

Admite `--cliente=<uuid de public.clientes>`, `--desde=` y `--hasta=` (por defecto,
el último año).

> **Migración 089 (`migrations/089_hotmart_atribucion_y_guarda.sql`): pendiente de
> aplicar** a 2026-09-25. Sin ella el código funciona como antes: las UTM de
> `src`/`sck` se guardan igual, pero la herencia del lead no escribe nada, la guarda
> de `guardar_hotmart_venta` sigue siendo «todo o nada» y los avisos se deduplican por
> el status previo de `sales_events`. Se prueba sin dejar rastro con
> `npx tsx scripts/verify-hotmart-089.ts`: la migración y sus casos corren en una
> transacción que se aborta.

### Moneda de reporte

Hotmart se guarda en USD y el gasto de Meta en la moneda de la cuenta. Cada cliente
tiene una **moneda de reporte** (ficha del cliente, `report_utm.clientes.config.moneda_reporte`)
y las ventas se convierten a ella al leer, con la tasa de `fx_rates` del día de
cada venta. Esa tasa no se reescribe una vez guardada, así que queda congelada;
solo el día en curso puede moverse. El sync diario de Hotmart deja cacheada la tasa
del día de todas las monedas de reporte. Para rellenar días pasados:
`scripts/backfill-fx-historico.ts`. Código: `src/lib/moneda-reporte.ts`.

### Métricas en el reporting clásico

Todo lo de Hotmart se etiqueta «Hotmart:» en los selectores, con unidades `(#)` e
importes `($)` separados. `hotmart_pagos_iniciados` se etiqueta «GA4: Pagos
iniciados»: son las vistas de la página de pago medidas por GA4, no un dato de
Hotmart. El downsell y los reembolsos se suman igual en el BI y en el dashboard.

Las `ventas_*` son de **cuenta**: no saben de campañas. Para ROAS, CPA o ticket
**por campaña** —en una pestaña filtrada o en un informe— están las claves `hm_*`,
que salen de `hotmart_ventas` y siguen el filtro de campañas. Ver
[doc 18](./18-fuentes-y-cruces.md#ventas-de-hotmart-por-campaña-hm_).

---

## Meta · estado de la cuenta publicitaria

En cada corrida que toca hoy o ayer, el worker pregunta a Meta el `account_status`
de cada cuenta del cliente (`src/lib/meta/alerta-cuenta.ts`). Si alguna no puede
publicar (pago rechazado, saldo pendiente, inhabilitada), lo guarda en
`config_api.meta_estado_cuentas`, lo muestra en `/admin/salud` y avisa en la
campana y en el grupo de WhatsApp del equipo, una vez cada 24 h por cliente. Al
elegir cuentas en Ajustes también se ve su estado y su moneda.

## Meta · conversiones personalizadas en Report-UTM

Las conversiones personalizadas que el worker guarda por campaña se ofrecen en el
editor de informes como «Conversiones personalizadas de Meta» (token
`metacc:<clave>`, nombre real del catálogo `meta_conversiones_catalogo`). Se
reparten por fecha y por campaña.

## Shopify y CartPanda (RETIRADAS, 2026-09-12)

La agencia no trabaja e-commerce y ningún cliente las tenía activas. Se borraron
sus webhooks, parsers, tarjetas y acciones. `sales_events` sigue recibiendo
Hotmart y las ventas del CRM de GoHighLevel.

---

## GoHighLevel (leads del CRM · módulo Report-UTM)

**API**: LeadConnector v2 (`services.leadconnectorhq.com`), autenticada con un
**Private Integration Token** por location.

### Configuración (por cliente)

Desde la tarjeta _GoHighLevel · CRM_ de `/admin/settings/[id]`. Pide
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
[
  {
    "id": "uuid", // clave de partición: el replace es por sheet
    "name": "Leads WhatsApp",
    "enabled": true,
    "sheet_url": "https://docs.google.com/spreadsheets/d/...",
    "tabs": [
      {
        "id": "uuid",
        "sheet_name": "Enero", // vacío = primera pestaña del doc
        "enabled": true,
        "col_fecha": "Fecha",
        "col_tipo": "Tipo",
        "col_cantidad": "Cantidad",
        "col_valor": "Valor",
        "col_fuente": "Fuente",
        "col_notas": "Notas",
        "custom_columns": {
          // LEGACY, sin UI (ver abajo)
          "citas_agendadas": {
            "col_name": "Citas Agendadas",
            "type": "count",
            "label": "Citas",
            "include": true,
          },
        },
        "raw_mode": "all", // capa cruda: 'all' (defecto) | 'declared' | 'none'
        "raw_exclude": ["email"], // columnas que nunca se guardan en crudo (PII)
      },
    ],
  },
]
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

| Capa         | Tabla                                 | Qué entra                                                                                                                                              |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interpretada | `conversiones_offline` (+ `_diarias`) | El modelo de siempre: fecha/tipo/cantidad/valor/fuente/notas y las `custom_columns` ya tipadas. Solo filas con `cantidad > 0`.                         |
| Cruda        | `sheet_filas`                         | La fila tal cual, con todas sus columnas sin convertir. Se guarda **aunque no sea conversión** (`cantidad <= 0`), porque igual tiene valores de campo. |

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

  | body                                                                    | qué hace                               |
  | ----------------------------------------------------------------------- | -------------------------------------- |
  | `{ clientId, sheetId, tabId, batchId }`                                 | sincroniza UNA pestaña dentro del lote |
  | `{ clientId, sheetId, batchId, consolidar, conservarCrudas?, quality }` | cierra el lote de ese sheet            |
  | `{ clientId, sheetId?, recalcularCampos? }`                             | documento(s) enteros de una vez        |

  **"Sincronizar todos ahora" va pestaña a pestaña.** Un documento de decenas de
  miles de filas no cabe en el `maxDuration`: leer las tres pestañas de un sheet
  real costaba 73 s (11,6 + 15,0 + 37,7 de lectura + 9,4 de cierre), la petición
  moría y devolvía la página de error de la plataforma en texto plano — no JSON.
  Troceado, la más lenta son 37,7 s.

  Todas las pestañas comparten `sync_batch_id`. Cada pestaña escribe y poda sus
  propias filas al momento (upsert por fila desde la migración 069); la
  consolidación cierra el sheet. La UI no consolida si ninguna pestaña salió bien.

  **Los agregados diarios se recalculan desde la base** en la consolidación
  (`consolidarLoteSheet`), leyendo `conversiones_offline` del sheet entero, no
  sumando lo leído en la corrida ni lo que mande el navegador.
  `uq_conv_diarias_origen` es único por (cliente, sheet, fecha, tipo, fuente)
  **sin la pestaña**: un agregado hecho solo con las pestañas que se pudieron leer
  pisaba el total del día y borraba del BI lo aportado por la pestaña caída, que
  el dashboard seguía contando. El orden es: podar pestañas retiradas → recalcular
  → upsert → retirar lotes anteriores. Si la lectura falla (paginación en modo
  `estricto`), se lanza sin escribir ni borrar: el BI conserva los totales
  anteriores. Los porcentajes se reconstruyen exactos, porque el ponderado solo
  necesita valor y cantidad de cada fila.

  Las pestañas retiradas o renombradas se podan con `sheet_podar_tabs` a partir
  de los títulos reales del documento (`resolverTitulosVivos`), calculados en el
  servidor. Si alguna pestaña habilitada no aparece, no se poda nada.

  Lo verifica `npx tsx --conditions=react-server scripts/verify-sync-por-pestana.ts --cliente=UUID`
  (escribe). Antes de desplegar un cambio en esta lógica,
  `scripts/verify-agregados-desde-db.ts` (solo lectura) muestra qué totales del BI
  cambiarían por sheet.

  **Celdas fuera de tipo.** `cantidad` es `INTEGER` y `valor` `NUMERIC(12,2)`: una
  sola celda fuera de rango hacía que Postgres rechazara el trozo de 500 filas y el
  sheet entero fallaba. Ahora una cantidad no entera («1,5», un teléfono) descarta
  esa fila con aviso (`cantidad_rechazada`) y un valor fuera de rango se guarda como
  null (`valor_fuera_de_rango`).

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

| Uso                           | Token del BI             | Alias en fórmulas | Clave en el dashboard clásico |
| ----------------------------- | ------------------------ | ----------------- | ----------------------------- |
| Dimensión (agrupar / filtrar) | `sheetdim:<clave>`       | —                 | —                             |
| Métrica del campo             | `sheetagg:<agg>:<clave>` | `sf__<clave>`     | `sf_<clave>`                  |
| Vista guardada                | `sheetview:<clave>`      | `sv__<clave>`     | `sv_<clave>`                  |

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

| Operación | `baileys` (gateway propio) | `evolution` (v2)                                              |
| --------- | -------------------------- | ------------------------------------------------------------- |
| Estado    | `GET /status`              | `GET /instance/connectionState/{instance}`                    |
| QR        | `GET /qr`                  | `GET /instance/connect/{instance}` (`base64`)                 |
| Grupos    | `GET /groups`              | `GET /group/fetchAllGroups/{instance}?getParticipants=false`  |
| Enviar    | `POST /send`               | `POST /message/sendText/{instance}` (`{ number: jid, text }`) |

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

| Integración                          | Auth                                                                             | Configuración                                    | Tablas/columnas destino                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Meta Ads                             | OAuth (env app + token por cliente)                                              | `/admin/settings/[id]`                           | `meta_*`, `meta_campaigns/ads/adsets/forms`                                             |
| TikTok Ads                           | OAuth (env app + token por cliente)                                              | `/admin/settings/[id]`                           | `tiktok_*`, `tiktok_campaigns/ads/adgroups`                                             |
| GA4                                  | OAuth de agencia (service account por cliente como legacy)                       | `config_api.ga_property_id` (selector)           | `ga_*`, `ga4_sesiones_diarias`, `ga4_eventos_clave_diarios`, `ga4_estado`               |
| Hotmart (API)                        | HotConnect (OAuth) o client id + secret / Basic, cifrados                        | `config_api.hotmart_*` + funnel por tab          | `hotmart_ventas` → `ventas_*`, `hotmart_funnel_data`                                    |
| Google Sheets — Leads                | RETIRADA (migración 059)                                                         | `config_api.google_sheets` (respaldo)            | `leads`, `leads_diarios` (solo lectura)                                                 |
| Campos de Sheet                      | — (capa sobre lo anterior)                                                       | `sheet_campos`, `sheet_campo_vistas`             | `sheet_campo_valores_diarios`                                                           |
| Google Sheets (conversiones offline) | OAuth de la agencia (o cuenta de servicio)                                       | `config_api.google_sheets_conversiones[].tabs[]` | `conversiones_offline`, `conversiones_offline_diarias`, `conversiones_offline_sync_log` |
| Hotmart (webhook)                    | Hottok de Hotmart en `X-HOTMART-HOTTOK`                                          | `report_utm.integrations` (`config.hottok_enc`)  | `hotmart_ventas` + espejo en `report_utm.sales_events`                                  |
| WhatsApp                             | Gateway Baileys (Bearer) **o** Evolution API (apikey), según `WHATSAPP_PROVIDER` | `/admin/whatsapp` + envs del proveedor           | `whatsapp_groups/routes/messages` (+ `session` solo en baileys)                         |
