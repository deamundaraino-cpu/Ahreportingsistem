# 12 · Módulo Report-UTM (tracking y atribución)

Módulo **aislado** dentro del mismo proyecto Next.js. Comparte auth, deploy e instancia de Supabase con el reporting principal, pero **no comparte tablas ni rutas**. Su objetivo: rastrear el recorrido del visitante (enlaces + pixel) y atribuir las ventas (webhooks) a la fuente que las originó.

## Activación

1. Aplicar la migración 012 (y 013, 014) que crean el schema `report_utm`.
2. En **Supabase Studio → Settings → API → Exposed schemas**, agregar `report_utm`.
3. En el entorno: `NEXT_PUBLIC_REPORT_UTM_ENABLED=true`.
4. Acceder a `/report-utm` (solo admin/superadmin).

Mientras la flag esté desactivada, el route group redirige a `/dashboard` y el switcher del sidebar queda oculto.

## Aislamiento

| Concepto | Ubicación |
|----------|-----------|
| Tablas | schema `report_utm.*` |
| Rutas UI | `src/app/(report-utm)/report-utm/**` |
| API | `src/app/api/report-utm/**` + `/t/[slug]` |
| Sidebar | `src/components/report-utm/ReportUtmSidebar.tsx` |
| Cliente Supabase | `src/lib/report-utm/client.ts` (`reportUtmClient`, `reportUtmAdminClient`) |
| Tipos | `src/lib/report-utm/types.ts` |
| Lógica | `src/lib/report-utm/*` |

`report_utm.clientes` tiene un FK opcional `public_cliente_id` para cruzar (si se quiere) con un cliente del reporting principal; por defecto son universos separados.

## Las tres piezas de tracking

### 1. Enlaces de tracking (`/t/[slug]`)
Enlaces cortos con UTMs predefinidos (`report_utm.tracking_links`). Cuando alguien visita `/t/[slug]` (`src/app/t/[slug]/route.ts`):
1. Resuelve el slug → `destination_url` + UTMs.
2. Setea **cookies de atribución** de primera parte (ver abajo).
3. Incrementa `clicks_count` y `last_click_at`.
4. Registra un evento de clic en `pixel_events`.
5. Hace **302** al destino, propagando UTMs y `click_id`.

Gestión en `/report-utm/links`.

### 2. Pixel JavaScript
Snippet (`public/report-utm-pixel.js`) que el cliente embebe en su sitio. Envía eventos a `POST /api/report-utm/pixel/event` (público, CORS `*`):
- Tipos: `pageview` (automático), `click`, `custom`.
- Datos: `cliente_slug`, `visitor_id`, `session_id`, `page_url`, `referrer`, UTMs, `click_id`, `custom_data`.
- El endpoint resuelve el slug → cliente, valida que esté `active`, y guarda en `report_utm.pixel_events` (captura IP/país/User-Agent de cabeceras).

Snippet y stream de eventos en `/report-utm/pixel`.

### 3. Webhook de ventas (Hotmart)
`POST /api/report-utm/webhooks/hotmart/[clienteId]`:
1. Valida la **firma** del webhook (ver auth abajo).
2. Parsea el payload tolerante a versiones (`hotmart-parser.ts`).
3. Hace `upsert` en `report_utm.sales_events` (dedupe por `cliente_id + platform + platform_sale_id`).
4. **Resuelve atribución** multi-touch (ver abajo).
5. Emite **webhooks salientes** a suscriptores (fire-and-forget).

Códigos: 201 ok · 404 sin integración · 403 pausada · 401 firma inválida · 422 payload inválido · 500 error BD. `GET` es health-check de la URL. Log de ventas en `/report-utm/ventas`.

## Cookies de atribución

`src/lib/report-utm/attribution-cookies.ts`. Son cookies de **primera parte**, accesibles por JS (`httpOnly: false`):

| Cookie | Contenido | Duración |
|--------|-----------|----------|
| `rutm_vid` | Visitor ID persistente | 90 días |
| `rutm_sid` | Session ID | 30 min de inactividad |
| `rutm_ft` | First-touch (JSON: source, campaign, click_id, ts, referrer) | persistente |
| `rutm_lt` | Last-touch (se sobrescribe en cada toque) | persistente |

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

`src/lib/report-utm/webhook-auth.ts` → `verifyWebhookSignature()`. Dos métodos:
- **HMAC** (recomendado): `x-hotmart-signature` = `HMAC-SHA256(secret, rawBody)`.
- **Hottok** (legacy): `x-hotmart-hottok`, `?hottok=` o `body.hottok` comparado contra el secreto.

Usa `crypto.timingSafeEqual` (anti timing-attack). `generateWebhookSecret()` crea secretos de 32 bytes.

## Parser de Hotmart

`src/lib/report-utm/hotmart-parser.ts` → `parseHotmartPayload()`. Tolerante a múltiples formas (v2 `data.purchase`, v1 `event.data.purchase`, `purchase` directo). Mapea el evento a `status`:
- `PURCHASE_APPROVED`/`COMPLETE` → `approved`
- `PURCHASE_BILLET_PRINTED`/`PROTEST`/`DELAYED` → `pending`
- `PURCHASE_REFUNDED`/`CANCELED` → `refunded`
- `PURCHASE_CHARGEBACK` → `chargeback`

Extrae monto, moneda, producto, comprador, `transaction_type` (bump/upsell/subscription) y UTMs/click IDs.

## Webhooks salientes

`src/lib/report-utm/outbound-emitter.ts` → `emitOutboundForSale()`. Para cada webhook habilitado que coincida con el `event_type`:
1. Firma el payload (HMAC-SHA256 con el secreto del suscriptor).
2. POST con cabeceras `X-Rutm-Signature`, `X-Rutm-Event`, `X-Rutm-Delivery-Id`.
3. Registra el intento en `outbound_deliveries` (status, error, `duration_ms`).
4. Actualiza contadores `success_count`/`failure_count` del webhook.

Tipos de evento: `sale.approved`, `sale.pending`, `sale.refunded`, `sale.chargeback`. Configuración en `report_utm.outbound_webhooks`; UI en `OutboundWebhooksCard.tsx`.

## Agregación horaria

`src/lib/report-utm/aggregate.ts` → `aggregateHourlyMetrics({ sinceISO, untilISO?, clienteId? })`:
- Agrupa `sales_events` por `(cliente_id, hora, utm_source, utm_campaign)`.
- Cuenta ventas aprobadas y reembolsos/chargebacks por separado.
- Borra los buckets afectados y reinserta (idempotente) en `hourly_metrics`.

Se ejecuta vía `GET/POST /api/cron/report-utm/aggregate` (cron diario). Botón manual: `RunAggregateButton`.

## Analítica de atribución (`/report-utm/atribucion`)

Dashboard que agrega `sales_events` en vivo:
- KPIs: eventos totales, revenue aprobado, AOV, fuentes distintas.
- Gráficos: tendencia de revenue diaria, distribución por fuente.
- Tablas: top sources (ventas, revenue, AOV, % del total) y **matriz UTM** (source × campaign con reembolsos).

Componentes en `src/components/report-utm/`: `AttributionCharts`, `AttributionBadge`, `TrackingLinkRow`, `PixelSnippet`, `HotmartIntegrationCard`, `OutboundWebhooksCard`, `RunAggregateButton`, `PhaseStub`.

## Roadmap (del README del módulo)

- **Fase 0** — Esqueleto ✅
- **Fase 1** — Webhook Hotmart + sales_events + listado de ventas
- **Fase 2** — Dashboard UTM + atribución + agregaciones
- **Fase 3** — Tracking links `/t/:slug` + pixel JS
- **Fase 4** — Meta CAPI outbound + reglas / automatizaciones

> Referencia original: [`src/app/(report-utm)/README.md`](../src/app/(report-utm)/README.md).
