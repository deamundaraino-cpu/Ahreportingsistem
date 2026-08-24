# 05 · Autenticación y roles

## Proveedor de autenticación

La aplicación usa **Supabase Auth**. La sesión se gestiona con cookies vía `@supabase/ssr`. Hay tres "sabores" de cliente Supabase:

| Cliente | Archivo | Uso |
|---------|---------|-----|
| Browser | `src/utils/supabase/client.ts` | Componentes cliente (`createBrowserClient`) |
| Server | `src/utils/supabase/server.ts` → `createClient()` | Server Components / actions, gestiona cookies de sesión |
| Admin | `src/utils/supabase/server.ts` → `createAdminClient()` | Usa `SUPABASE_SERVICE_ROLE_KEY`, **omite RLS** (workers, API v1, MCP) |

## Roles

Los roles se almacenan en la tabla **`user_profiles`** (`role`). Existen cuatro:

| Rol | Permisos |
|-----|----------|
| `superadmin` | Acceso total a todo el sistema |
| `admin` | Acceso total (clientes, usuarios, tokens, reportes, layouts, Report-UTM) |
| `trafficker` | Solo los clientes **asignados** (vía `user_client_assignments`); puede configurar settings y layouts de esos clientes |
| `viewer` | Solo dashboards en modo lectura; redirigido fuera de `/admin` |

> Adicionalmente, varias políticas RLS conceden acceso total a un **email administrador hardcodeado** en `schema.sql` (`robinson@adshouse.com`). Cámbialo por tu administrador real.

## Asignación de clientes a traffickers

La tabla **`user_client_assignments`** (`user_id`, `client_id`) define qué clientes ve un trafficker. Las consultas de clientes (`getClientes()`) filtran según este mapeo cuando el rol es `trafficker`. La gestión se hace desde `/admin/users`.

## Middleware y protección de rutas

El middleware vive en `src/proxy.ts`, que delega en `updateSession()` (`src/utils/supabase/middleware.ts`). En cada request:

1. Refresca la sesión Supabase desde las cookies.
2. Redirige a `/login` a los usuarios **no autenticados** que intentan entrar a rutas protegidas.
3. Redirige al `/dashboard` a los usuarios **ya autenticados** que visitan `/login`.
4. Para rutas `/admin/*`, consulta el rol en `user_profiles` y aplica RBAC.

### Categorías de rutas

| Categoría | Rutas | Requisito |
|-----------|-------|-----------|
| **Públicas** | `/login`, `/signup`, `/api/*`, `/report/*`, `/p/*`, `/t/*`, `/report-utm-pixel.js`, `/privacy`, `/terms` | Ninguno |
| **Autenticadas** | `/dashboard`, `/dashboard/[clientId]`, `/soporte` | Sesión válida |
| **Admin (solo admin/superadmin)** | `/admin/users`, `/admin/api-tokens`, `/admin/reports` | Rol admin/superadmin |
| **Admin (admin/superadmin/trafficker)** | `/admin/settings`, `/admin/layouts` | Uno de esos roles |
| **Report-UTM** | `/report-utm/*` | Sesión + rol admin + `NEXT_PUBLIC_REPORT_UTM_ENABLED=true` |

> Nota: las rutas `/api/*` no se bloquean en el middleware; **cada endpoint aplica su propia autenticación** (token de API, `CRON_SECRET`, firma HMAC o sesión). Ver [doc 07 · API REST](./07-api-rest.md).

## Mecanismos de autenticación por capa

La aplicación usa **distintos mecanismos según el consumidor**:

| Mecanismo | Dónde | Cómo |
|-----------|-------|------|
| **Sesión Supabase** | UI, server actions, algunos endpoints | Cookie de sesión |
| **Token de API** | `/api/v1/*`, `/api/mcp` | `Authorization: Bearer ads_…` (solo cabecera; ver `src/lib/api-token-auth.ts`) |
| **Secreto de cron** | `/api/worker*`, `/api/cron/*` | `Authorization: Bearer $CRON_SECRET` (comparación de tiempo constante, `src/lib/cron-auth.ts`) |
| **Firma HMAC** | Webhook Hotmart | `x-hotmart-signature` / `x-hotmart-hottok` (`src/lib/report-utm/webhook-auth.ts`) |
| **Token público** | `/p/[token]`, `/report/...` | `public_token` de cliente/tab; sin login |

### Tokens de API

Generados desde `/admin/api-tokens`. El token plano (`ads_…`) se muestra **solo al crearlo**; en BD se guarda únicamente su hash SHA-256 y un prefijo visible. Cada token tiene permisos (`read:metrics`, `read:clients`, `read:campaigns`, `read:reports`, `write:sync`) y, opcionalmente, fecha de expiración. Ver [doc 13](./13-mcp-y-tokens-api.md).

## Flujo de registro e ingreso

- **`/signup`**: registro con email, contraseña y nombre.
- **`/login`**: ingreso con email/contraseña (Supabase).
- **`/auth/callback`**: ruta de callback de Supabase Auth tras confirmar email u OAuth.
- **`/auth/signout`**: cierre de sesión.

Tras registrarse, asigna el rol del usuario en `user_profiles` (manualmente o desde `/admin/users` si ya eres admin).
