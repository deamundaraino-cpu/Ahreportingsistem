# 15 · Despliegue y operación

## Plataforma

La aplicación está pensada para **Vercel** (Next.js nativo) + **Supabase** como base de datos/Auth. El dominio de producción referenciado en el código es `https://reportes.adshouse.cloud`.

## Pasos de despliegue

1. **Conectar el repo a Vercel** (framework Next.js detectado automáticamente).
2. **Configurar las variables de entorno** en Vercel (Production + Preview). Lista completa en [doc 03](./03-instalacion-y-configuracion.md):
   - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   - App: `NEXT_PUBLIC_APP_URL` (= dominio de producción).
   - Cron: `CRON_SECRET`.
   - OAuth: `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`.
   - Sheets: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_KEY`.
   - Report-UTM (opcional): `NEXT_PUBLIC_REPORT_UTM_ENABLED`.
3. **Aplicar el esquema y migraciones** en Supabase (`schema.sql` + `migrations/001…020`). Exponer `report_utm` si se usa el módulo.
4. **Configurar callbacks OAuth** en Meta y TikTok con el dominio de producción.
5. **Verificar los crons** definidos en `vercel.json` (ver [doc 14](./14-cron-y-workers.md)).
6. **Configurar el secreto de la GitHub Action** (`CRON_SECRET`) para el chequeo de presupuesto.

## Headers de seguridad (`next.config.ts`)

Se aplican a **todas** las respuestas:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### Content-Security-Policy

```
default-src 'self'
script-src 'self' 'unsafe-inline' ('unsafe-eval' solo en dev)
style-src 'self' 'unsafe-inline'
img-src 'self' data: blob: https:
font-src 'self' data:
connect-src 'self' https://*.supabase.co wss://*.supabase.co https:
object-src 'none'
base-uri 'self'
form-action 'self'
```

> `script-src` permite `'unsafe-inline'` porque el App Router usa scripts inline para hidratar y Recharts/Tailwind emiten estilos inline. Por la misma razón el código **no usa `eval`** y existe el motor de fórmulas propio ([doc 09](./09-motor-de-formulas.md)).

### Framing (clickjacking)

| Rutas | Política |
|-------|----------|
| `/p/*` y `/report/*` | `frame-ancestors *` — **embebibles** en portales de clientes |
| Resto | `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` |

## Paquetes externos del servidor

`serverExternalPackages: ['@google-analytics/data']` evita que el bundler empaquete el SDK de GA4 (debe correr en Node, no en el edge).

## Monitoreo

- **Health check**: `GET /api/health` (sin auth) verifica conexión a BD y variables de entorno. Responde 200 (`up`) o 503 (`degraded`/`down`). Útil como *uptime monitor*.
- **Logging**: `src/lib/error-handler.ts` provee `logger` (info/warn/error/debug) con salida JSON estructurada, listo para integrar Sentry u observabilidad posterior.
- **Errores de API**: `ApiError` + `apiErrorResponse` devuelven respuestas consistentes con código, mensaje y (solo en dev) detalles.

## Operación diaria

- Las métricas se actualizan automáticamente cada madrugada (ver [doc 14](./14-cron-y-workers.md)). Si un cliente aparece sin datos recientes, revisar el estado de sus integraciones en `/admin/settings/[id]` y el resultado del último `/api/worker`.
- Los **tokens de Meta** se renuevan solos; si `meta_connection_status = expired`, el cliente debe reconectar vía OAuth.
- Las **alertas de presupuesto** se generan cada 4 h y se muestran en `/dashboard`.
- Para reprocesar un periodo histórico, invocar `/api/worker` manualmente con `start`/`end`.

## Calidad antes de desplegar

```bash
npm run validate   # type-check + lint + format:check
npm run build      # build de producción
```

> No hay suite de tests todavía (`npm run test` es un placeholder). La guía [`REFACTORING_GUIDE.md`](../REFACTORING_GUIDE.md) describe el patrón objetivo (fetchers modulares, validación Zod, manejo de errores) para evolucionar los endpoints hacia un estado testeable.
