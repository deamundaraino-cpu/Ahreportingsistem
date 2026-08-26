# 15 · Despliegue y operación

## Plataforma

La aplicación es un Next.js estándar contra **Supabase** (base de datos + Auth).
Corre en dos sitios sin cambiar una línea de código:

- **Dokploy** (o cualquier host de contenedores) con el `Dockerfile` de la raíz
  — ver [Despliegue en Dokploy](#despliegue-en-dokploy-autoalojado).
- **Vercel**, que fue el destino original — ver [Pasos de despliegue en Vercel](#pasos-de-despliegue-en-vercel).

El dominio de producción referenciado en el código es `https://reportes.adshouse.cloud`.

La diferencia operativa importante no es el hosting sino los **crons**: en Vercel
los declara `vercel.json`; fuera de Vercel ese archivo no lo lee nadie y hay que
cubrirlos desde el `sync-worker` ([doc 14](./14-cron-y-workers.md)).

## Versión de Node (obligatorio ≥ 22.12)

`package.json` declara `engines.node: ">=22.12.0"`, y **no es cosmético**: por debajo de esa versión el dashboard de cliente devuelve un 500 en producción.

La cadena es `sanitize-html.ts` → `isomorphic-dompurify` → `jsdom` → `html-encoding-sniffer@6`, que hace `require("@exodus/bytes/encoding-lite.js")`. Ese paquete es ESM puro en **todas** sus versiones publicadas, así que cargarlo con `require()` solo funciona en el Node que soporta `require(esm)` — desde 22.12. En Node 20 el módulo revienta con `ERR_REQUIRE_ESM` al instanciarse, antes de que la página ejecute una sola línea: no llega ni a consultar la base de datos, y el fallo se ve como "This page couldn't load".

Afecta a toda ruta que importe `sanitize-html`: `/dashboard/[clientId]` (vía `getBitacoras`), `/admin/settings/[id]` y `/p/[token]`.

Vercel resuelve `engines.node` contra las versiones que ofrece; conviene confirmar en el log de build cuál eligió y que la opción _Project Settings → Node.js Version_ no se quede en una anterior.

## Despliegue en Dokploy (autoalojado)

Dokploy corre contenedores Docker detrás de Traefik. La app se empaqueta con el
`Dockerfile` de la raíz, que usa `output: 'standalone'` de Next: el build deja
en `.next/standalone` un `server.js` y **solo** los módulos que la traza
encuentra, así que la imagen final no lleva `node_modules` completo (~67 MB en
lugar de ~1 GB).

### Qué se despliega

| Aplicación    | Dockerfile               | Puerto | Dominio           |
| ------------- | ------------------------ | ------ | ----------------- |
| app Next.js   | `Dockerfile`             | 3000   | público           |
| `sync-worker` | `sync-worker/Dockerfile` | 8080   | interno / ninguno |

Son **dos Applications distintas de Dokploy sobre el mismo repositorio**, cada
una con su `Dockerfile Path`. El worker no necesita dominio: solo llama hacia
afuera y expone un healthcheck.

### 1 · Crear la Application de la app

En Dokploy → _Create Application_:

- **Provider**: Git (repo + rama `main`).
- **Build Type**: `Dockerfile`.
- **Dockerfile Path**: `Dockerfile`.
- **Docker Context Path**: `.` (la raíz; el build necesita todo el repo).

### 2 · Build Args — el paso que más se olvida

Las variables `NEXT_PUBLIC_*` **se incrustan en el bundle del navegador durante
`next build`**. Configurarlas solo en el panel de _Environment_ no sirve: el
JavaScript que llega al cliente saldría con `undefined` y la sesión de Supabase
no arrancaría nunca. Hay que declararlas **también** en _Build Args_:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
NEXT_PUBLIC_APP_URL=https://reportes.adshouse.cloud
NEXT_PUBLIC_REPORT_UTM_ENABLED=true
```

Corolario: **cambiar el dominio obliga a reconstruir**, no basta con reiniciar.

Y al revés: los secretos de servidor (`SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, `META_APP_SECRET`, `GOOGLE_SERVICE_ACCOUNT_KEY`…) **no** van en
Build Args. Un `ARG` queda grabado en el historial de capas de la imagen y
cualquiera con acceso al registro puede leerlo.

### 3 · Environment

Pegar el contenido de [`.env.example`](../.env.example) con los valores reales.
Las `NEXT_PUBLIC_*` van aquí además de en Build Args (el servidor también las
lee). Detalle de cada variable en [doc 03](./03-instalacion-y-configuracion.md).

`GOOGLE_SERVICE_ACCOUNT_KEY` es la clave PEM completa con los saltos escapados
como `\n` y entre comillas dobles; si se pega en crudo, Google devuelve
`invalid_grant` en todas las sincronizaciones de Sheets y GA4.

### 4 · Dominio y red

- **Port**: `3000` (el contenedor ya trae `HOSTNAME=0.0.0.0`; sin eso Next
  escucharía en localhost y Traefik no lo alcanzaría).
- **Domain** + **HTTPS con Let's Encrypt** activado.
- No hace falta tocar la compresión: `compress: true` en `next.config.ts` ya
  hace gzip antes de Traefik.

Un detalle que muerde: **la app se llama a sí misma por HTTP**. El botón
"Sincronizar" del dashboard y `/api/worker/backfill-campaign-ids` hacen `fetch`
contra `NEXT_PUBLIC_APP_URL` con el `CRON_SECRET`. Eso obliga a que el
contenedor pueda resolver y alcanzar su propio dominio público. En la mayoría
de VPS funciona; si el firewall o el NAT no hacen _hairpin_, el sync manual
falla con un timeout mientras el resto de la app se ve perfecta. Se comprueba
con `docker exec <contenedor> wget -qO- https://TU-DOMINIO/api/health`.

Si delante hay un nginx propio en vez de Traefik, hay que desactivar el
_buffering_ (`proxy_buffering off` o cabecera `X-Accel-Buffering: no`) o el
streaming de la App Router se entregará de golpe al final.

### 5 · La Application del sync-worker

Misma receta con **Dockerfile Path** `sync-worker/Dockerfile` y **Context** `.`
(el contexto es la raíz a propósito: el worker compila `src/lib/sync` de la app
para no duplicar la lógica de sincronización). Variables en
[`sync-worker/.env.example`](../sync-worker/.env.example); `APP_URL` debe
apuntar al dominio nuevo y `CRON_SECRET` coincidir **carácter a carácter** con
el de la app.

### 6 · Los crons ya no los pone la plataforma

`vercel.json` solo lo lee Vercel. En Dokploy no se ejecuta nada de ahí, así que
sus dos crons hay que cubrirlos:

| Cron de `vercel.json`           | Quién lo cubre ahora                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `/api/cron/refresh-meta-tokens` | El scheduler del `sync-worker` (02:00 🇨🇴, entrada `0 2 * * *`) |
| `/api/worker/run-jobs`          | El poll continuo del `sync-worker` + el workflow de GitHub     |

El refresco de tokens de Meta se añadió al scheduler del worker justo por esto:
vivía **únicamente** como cron de Vercel, y sin él los tokens caducan a los ~60
días y todos los clientes de Meta quedan desconectados sin aviso.

Si se prefiere no depender del worker para eso, Dokploy tiene _Schedules_ por
aplicación; el equivalente es:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  "$NEXT_PUBLIC_APP_URL/api/cron/refresh-meta-tokens"
```

Ejecutar los dos a la vez es inocuo (el endpoint es idempotente), pero elegir
uno solo evita confusión al depurar.

### 7 · Lo que hay que reapuntar al dominio nuevo

Un despliegue que arranca bien puede seguir roto en las integraciones. Revisar,
una por una:

- `NEXT_PUBLIC_APP_URL` en Build Args **y** Environment.
- `APP_URL` del `sync-worker`.
- `env.APP_URL` en [`.github/workflows/sync-fallback.yml`](../.github/workflows/sync-fallback.yml).
- **Supabase → Authentication → URL Configuration**: Site URL y Redirect URLs
  (`/auth/callback`). Sin esto el login por correo redirige al dominio viejo.
- **Callbacks OAuth**: Meta, TikTok, Google Ads y Hotmart, cada uno en su panel
  de desarrollador.
- **Webhooks**: Meta Leads (`META_WEBHOOK_VERIFY_TOKEN`) y los de `report_utm`
  (Hotmart, Shopify, Cartpanda), que apuntan a URLs absolutas.

### 8 · Verificación tras el primer deploy

```bash
# 1. El contenedor responde y ve la base de datos → status "up".
curl -s https://TU-DOMINIO/api/health | jq

# 2. El worker está vivo y con la cola sana.
curl -s http://IP-DEL-VPS:8080/status | jq

# 3. Los endpoints protegidos exigen el secreto (debe dar 401 sin cabecera).
curl -s -o /dev/null -w '%{http_code}\n' https://TU-DOMINIO/api/worker/health
```

Después, entrar a `/admin/sync` y lanzar una sincronización manual: es la prueba
de extremo a extremo (la app encola, el worker reclama, los datos aterrizan).

### Notas de recursos

- `next build` necesita ~2 GB de RAM. En un VPS de 1 GB el build muere con
  `SIGKILL` y Dokploy lo reporta como un fallo genérico; si pasa, o se amplía la
  máquina o se construye la imagen fuera y se despliega desde un registro.
- La app no guarda estado en disco: no necesita volúmenes. Todo vive en
  Supabase.
- Sí conviene poner **límite a los logs** de Docker (`max-size`), como ya hace
  `sync-worker/docker-compose.yml`: los logs de sincronización son verbosos.

## Pasos de despliegue en Vercel

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

| Rutas                | Política                                                     |
| -------------------- | ------------------------------------------------------------ |
| `/p/*` y `/report/*` | `frame-ancestors *` — **embebibles** en portales de clientes |
| Resto                | `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`     |

## Paquetes externos del servidor

`serverExternalPackages: ['@google-analytics/data']` evita que el bundler empaquete el SDK de GA4 (debe correr en Node, no en el edge).

## Monitoreo

- **Health check**: `GET /api/health` (sin auth) verifica conexión a BD y variables de entorno. Responde 200 (`up`) o 503 (`degraded`/`down`). Útil como _uptime monitor_.
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
