# 12 · Tracking y atribución (lo que fue Report-UTM)

Nació como un módulo **aislado** dentro del mismo proyecto: sidebar propio,
route group propio y un feature flag que lo apagaba entero. Ya no. Sus páginas
son secciones del reporting y su configuración vive en la ficha del cliente.
Lo que queda de aquella separación es dónde están las cosas, no cómo se usan.

Su objetivo no ha cambiado: rastrear de dónde viene cada lead y atribuir las
ventas (webhooks) a la fuente que las originó.

## Qué se movió y qué no

| Concepto                  | Dónde está ahora                                                                |
| ------------------------- | ------------------------------------------------------------------------------- |
| Páginas                   | `/leads`, `/ventas`, `/informes`, `/cruce-campanas`, `/admin/salud` en `(app)/` |
| Configuración por cliente | `/admin/settings/[id]`, en pestañas por plataforma                              |
| Navegación                | El sidebar único (`src/components/layout/AppSidebar.tsx`), grupo «Análisis»     |
| Tablas                    | Sin cambios: schema `report_utm.*`                                              |
| API                       | Sin cambios: `src/app/api/report-utm/**`                                        |
| Cliente Supabase          | Sin cambios: `src/lib/report-utm/client.ts`                                     |
| Tipos y lógica            | Sin cambios: `src/lib/report-utm/*`, `src/components/report-utm/*`              |

Las rutas de `/api/report-utm/**` **no se tocan a propósito**: hay webhooks
registrados con esas URLs en Hotmart, GoHighLevel y Meta, y renombrarlas rompe
la ingesta en vivo. Las carpetas `lib/` y `components/` tampoco, porque medio
reporting las importa (`lib/report-utm/auth.ts` autentica todo `/api/admin/*`).

`report_utm.clientes` sigue siendo una tabla aparte, enlazada a
`public.clientes` por `public_cliente_id`. El espejo se crea solo
(`asegurarEspejoUtm`, en `src/lib/clientes/ciclo-de-vida.ts`) y el usuario nunca
lo ve: para él solo existe «el cliente».

## Requisito de instalación

En **Supabase Studio → Settings → API → Exposed schemas** tiene que estar
`report_utm`. Sin eso, las páginas de análisis cargan vacías.

## Retirado

- **Overview `/report-utm`** — su roadmap seguía anunciando como pendientes cosas hechas hacía meses, la cifra de clientes estaba capada a 5 por un `.limit(5)` y el «Revenue (7d)» sumaba monedas distintas sin convertir.
- **Enlaces de tracking `/t/[slug]`** y la tabla `tracking_links` — ninguna pantalla creaba enlaces desde que se retiró `/report-utm/links`.
- **`hourly_metrics`** y su cron — se recalculaba a diario y no la leía nadie.
- **Pantallas de clientes del módulo** — eran un espejo de `/admin/settings`.

El **pixel** (`public/report-utm-pixel.js`, `/api/report-utm/pixel/*`) sigue
vivo: lo usa `wordpress-plugin/report-utm/report-utm.php`.

## Las dos piezas de tracking

### 1. Pixel JavaScript

Snippet (`public/report-utm-pixel.js`) que el cliente embebe en su sitio. Envía eventos a `POST /api/report-utm/pixel/event` (público, CORS `*`):

- Tipos: `pageview` (automático), `click`, `custom`.
- Datos: `cliente_slug`, `visitor_id`, `session_id`, `page_url`, `referrer`, UTMs, `click_id`, `custom_data`.
- El endpoint resuelve el slug → cliente, valida que esté `active`, y guarda en `report_utm.pixel_events` (captura IP/país/User-Agent de cabeceras).

El snippet lo instala el plugin de WordPress (`wordpress-plugin/report-utm/`); la pantalla que lo mostraba se retiró.

El plugin empaquetado vive en `public/report-utm.zip` —lo regenera `wordpress-plugin/build.ps1`, que escribe ahí directamente— y se descarga desde la tarjeta **Pixel S2S** de la ficha del cliente, junto al slug y la URL base que hay que pegar en WordPress. No está en `isPublicPath`, así que la descarga exige sesión: un anónimo que pida `/report-utm.zip` termina en `/login`.

### 2. Webhook de ventas (Hotmart)

`POST /api/report-utm/webhooks/hotmart/[clienteId]`:

1. Valida el **hottok** de Hotmart (ver auth abajo).
2. Parsea el payload con el parser compartido (`src/lib/hotmart/parser.ts`).
3. Guarda en `public.hotmart_ventas`, la verdad de dinero y clasificación, y reagrega `metricas_diarias`.
4. Solo si el evento se aplicó como el más reciente, hace `upsert` en `report_utm.sales_events` (dedupe por `cliente_id + platform + platform_sale_id`): un reintento viejo no pisa el status.
5. **Resuelve atribución** multi-touch (ver abajo).
6. Emite **webhooks salientes** y notificaciones, una vez por estado.

Códigos: 201 ok · 200 evento que no es venta o evento antiguo · 400 cuerpo vacío o JSON inválido · 404 sin integración · 403 pausada · 401 hottok inválido · 413 cuerpo grande · 422 payload ilegible · 429 rate limit · 500 error BD. `GET` es health-check de la URL. Log de ventas en `/ventas`. Alta paso a paso en [doc 08](./08-integraciones.md#webhook-ventas-en-vivo).

## Cookies de atribución

`src/lib/report-utm/attribution-cookies.ts`. Son cookies de **primera parte**, accesibles por JS (`httpOnly: false`):

| Cookie     | Contenido                                                    | Duración              |
| ---------- | ------------------------------------------------------------ | --------------------- |
| `rutm_vid` | Visitor ID persistente                                       | 90 días               |
| `rutm_sid` | Session ID                                                   | 30 min de inactividad |
| `rutm_ft`  | First-touch (JSON: source, campaign, click_id, ts, referrer) | persistente           |
| `rutm_lt`  | Last-touch (se sobrescribe en cada toque)                    | persistente           |

`buildTouchFromUrl()` extrae UTMs + click IDs (`fbclid`, `gclid`, `ttclid`, `click_id`) y solo registra un "touch" si hay señal de atribución.

## Resolución de atribución

`src/lib/report-utm/attribution-resolver.ts` → `resolveAttribution(db, sale)`. Cascada por prioridad:

1. **`click_id`** (máxima prioridad) — busca `pixel_events` con el mismo `click_id` para identificar al visitante.
2. **`visitor_cookie`** — si se identificó al visitante, toma todos sus `pixel_events` previos a la venta y extrae first/last touch con señal.
3. **`utm_only`** (fallback) — usa los UTMs de la propia venta como first/last touch.
4. **`none`** — sin señales.

`applyAttributionToSale()` guarda en la venta: `visitor_id`, `first_touch`, `last_touch`, `attribution_method`, `attribution_resolved_at`.

```ts
AttributionResult = {
  visitor_id: string | null
  first_touch: Touch | null
  last_touch: Touch | null
  attribution_method: 'click_id' | 'visitor_cookie' | 'utm_only' | 'none'
  pixel_events_matched: number
}
```

## Verificación de firma (webhook entrante)

`src/lib/report-utm/webhook-auth.ts` → `verifyWebhookSignature()`. En el webhook de Hotmart:

- **Hottok de Hotmart** (la vía normal): `x-hotmart-hottok` o `body.hottok` comparado con el hottok que genera Hotmart —uno fijo por cuenta, no editable— y que el usuario pega en la tarjeta (`integrations.config.hottok_enc`, cifrado).
- **HMAC** (heredado, para integraciones propias; Hotmart no firma así): `x-hotmart-signature` = `HMAC-SHA256(secret, rawBody)` con **nuestro** secreto.
- **`?hottok=<secreto>`** en la URL, contra nuestro secreto (heredado, no se anuncia: el secreto acaba en los logs).

Hasta el 2026-09-25 la cabecera se comparaba con nuestro secreto, que Hotmart no conoce: ningún evento real podía validar y `sales_events` no tenía filas de Hotmart. Para GHL y S2S (sin hottok de Hotmart) se conserva lo de siempre: cabecera, query o body contra nuestro secreto.

La comparación es en tiempo constante y tampoco filtra la longitud (compara los SHA-256 de ambos lados). `generateWebhookSecret()` crea secretos de 32 bytes.

## Parser de Hotmart

El parser es `src/lib/hotmart/parser.ts` (el mismo de la API; ver [doc 08](./08-integraciones.md#hotmart)). `src/lib/report-utm/hotmart-parser.ts` solo traduce la venta al formato heredado de `sales_events` (`aEventoLegacy`) y aloja las decisiones puras del webhook (qué se espeja, qué se avisa). El `status` de `sales_events`:

- `PURCHASE_APPROVED`/`COMPLETE` → `approved` (el `COMPLETE` no vuelve a avisar)
- `PURCHASE_BILLET_PRINTED`/`DELAYED`/`WAITING_PAYMENT`/`EXPIRED` → `pending`
- `PURCHASE_REFUNDED` → `refunded`
- `PURCHASE_CANCELED` → `canceled` (antes `refunded`: inflaba la tasa de devoluciones y avisaba «Venta reembolsada»). No tiene webhook saliente ni notificación
- `PURCHASE_CHARGEBACK` → `chargeback`

`PURCHASE_PROTEST`, el carrito abandonado, las suscripciones y Hotmart Club no son ventas: 200 y se ignoran. Sin divisa en el payload, `currency` es `null` (antes se asumía BRL). A Google Ads solo va un `gclid` explícito y a Meta CAPI solo un `fbclid` explícito (`clickIdsExplicitos`).

## Webhooks salientes

`src/lib/report-utm/outbound-emitter.ts` → `emitOutboundForSale()`. Para cada webhook habilitado que coincida con el `event_type`:

1. Firma el payload (HMAC-SHA256 con el secreto del suscriptor).
2. POST con cabeceras `X-Rutm-Signature`, `X-Rutm-Event`, `X-Rutm-Delivery-Id`.
3. Registra el intento en `outbound_deliveries` (status, error, `duration_ms`).
4. Actualiza contadores `success_count`/`failure_count` del webhook.

Tipos de evento: `sale.approved`, `sale.pending`, `sale.refunded`, `sale.chargeback`. Configuración en `report_utm.outbound_webhooks`; UI en `OutboundWebhooksCard.tsx`.
