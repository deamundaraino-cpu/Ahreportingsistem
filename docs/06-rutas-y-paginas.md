# 06 · Rutas y páginas (UI)

Mapa completo de la interfaz. La app usa el **App Router** de Next.js con _route groups_ (carpetas entre paréntesis que agrupan layouts sin afectar la URL).

## Layout raíz

`src/app/layout.tsx` — Tema oscuro (`<html lang="es" className="dark">`), fuentes Geist, metadata "AdsHouse Reporting".

---

## Rutas públicas (sin login)

| Ruta                 | Archivo                              | Descripción                                           |
| -------------------- | ------------------------------------ | ----------------------------------------------------- |
| `/`                  | `src/app/page.tsx`                   | Landing con hero, features y CTA                      |
| `/login`             | `src/app/login/page.tsx`             | Ingreso (Supabase)                                    |
| `/signup`            | `src/app/signup/page.tsx`            | Registro (email, contraseña, nombre)                  |
| `/privacy`           | `src/app/privacy/page.tsx`           | Política de privacidad                                |
| `/terms`             | `src/app/terms/page.tsx`             | Términos de servicio                                  |
| `/p/[token]`         | `src/app/p/[token]/page.tsx`         | Dashboard **espejo** público por token (solo lectura) |
| `/report/[clientId]` | `src/app/report/[clientId]/page.tsx` | Reporte público del cliente (solo lectura)            |

Las rutas `/p/*` y `/report/*` permiten ser embebidas en portales de clientes (CSP `frame-ancestors *`). Ver [doc 15](./15-despliegue.md).

---

## Route group `(app)` — autenticado

Wrapper: `src/app/(app)/layout.tsx`. Requiere sesión, obtiene el rol de `user_profiles` y renderiza `AppSidebar`. UI según rol.

### Dashboard

| Ruta                    | Archivo                               | Descripción                                                                                                                                                                                |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard`            | `(app)/dashboard/page.tsx`            | Home: KPIs (clientes, integraciones activas, alertas), grilla de clientes, accesos rápidos, resumen de soporte                                                                             |
| `/dashboard/[clientId]` | `(app)/dashboard/[clientId]/page.tsx` | Dashboard del cliente: embudo consolidado (Meta/Hotmart/GA4), selector de fechas, tabs, enlaces interno/público, leads de Google Sheets. Los traffickers solo acceden a clientes asignados |

Componentes principales (`(app)/dashboard/components/`): `DashboardClient`, `DateRangeSelector`, `MetricCharts`, `RankingTableBlock`, `PuzzleComponents`, `CountryBreakdown`, `GoogleSheetsLeadsCard`, `LayoutConfigModal`, `TabConfigModal`, `QuickEditModal`, `TabArchiveView`, `SupportModule`, `CopyLinkButton`, `PublicLinkButton`.

### Soporte

| Ruta       | Archivo                  | Descripción                                                                                                      |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `/soporte` | `(app)/soporte/page.tsx` | Lista de tickets de todos los clientes: totales, abiertos, en progreso, completados, urgentes (entrega ≤ 2 días) |

### Admin

Wrapper: `src/app/(app)/admin/layout.tsx`. Requiere `superadmin`/`admin`/`trafficker` (los `viewer` se redirigen a `/dashboard`).

| Ruta                   | Archivo                        | Acceso           | Descripción                                                               |
| ---------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------- |
| `/admin/settings`      | `admin/settings/page.tsx`      | admin/trafficker | Lista de clientes con estado de integraciones; diálogo "Nuevo cliente"    |
| `/admin/settings/[id]` | `admin/settings/[id]/page.tsx` | admin/trafficker | Configurar credenciales del cliente (Meta, Hotmart, TikTok, GA4) y layout |
| `/admin/users`         | `admin/users/page.tsx`         | admin/superadmin | Gestión de usuarios, roles y asignación de clientes                       |
| `/admin/api-tokens`    | `admin/api-tokens/page.tsx`    | admin/superadmin | Generar/gestionar tokens de API                                           |
| `/admin/layouts`       | `admin/layouts/page.tsx`       | admin/trafficker | Constructor de layouts (drag & drop de bloques)                           |

Componentes admin: `ClientConfigForm`, `NewClientDialog` (settings), `UserManagementClient` (users), `ReportsClient` (reports), `LayoutBuilderClient` (layouts), `ApiTokensManager`.

---

### Análisis (lo que fue Report-UTM)

> Report-UTM dejó de ser un espacio aparte con su propio sidebar: sus páginas
> son secciones del reporting y su configuración vive en la ficha del cliente.
> El route group `(report-utm)` y el flag `NEXT_PUBLIC_REPORT_UTM_ENABLED` ya no
> existen. `next.config.ts` redirige las URLs viejas.
>
> Siguen donde estaban, a propósito: el schema Postgres `report_utm.*`, las
> rutas `/api/report-utm/**` (hay webhooks registrados con esas URLs en Hotmart,
> GoHighLevel y Meta) y las carpetas `src/lib/report-utm/` y
> `src/components/report-utm/`.

Acceso: sesión + rol `superadmin`, `admin` o `trafficker` (ver `AUTHENTICATED_ADMIN_ROUTES` en `src/utils/supabase/middleware.ts`).

| Ruta               | Archivo                          | Descripción                                                                                                                                                                                                            |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/leads`           | `(app)/leads/page.tsx`           | Leads con buscador (nombre/email/teléfono), pestañas Cuentan / Excluidos / Todos con desglose por motivo, filtros por cliente, origen, atribución, formulario, UTM y fecha; excluir o re-incluir en lote; exportar CSV |
| `/ventas`          | `(app)/ventas/page.tsx`          | Ventas (webhook de Hotmart y del CRM de GoHighLevel)                                                                                                                                                                   |
| `/ventas/[saleId]` | `(app)/ventas/[saleId]/page.tsx` | Detalle de venta + payload crudo + atribución                                                                                                                                                                          |
| `/informes`        | `(app)/informes/…`               | Informes BI: lista, nuevo desde plantilla, editor                                                                                                                                                                      |
| `/cruce-campanas`  | `(app)/cruce-campanas/page.tsx`  | Cruce de leads con campaña, conjunto y anuncio (por ID o nombre) y corrección manual por nivel                                                                                                                         |
| `/admin/salud`     | `(app)/admin/salud/page.tsx`     | Fuentes paradas, integraciones en error, cuentas de Meta que no pueden publicar                                                                                                                                        |

## Server Actions

Mutaciones tipo RPC (`'use server'` en archivos `_actions.ts`). Principales:

### `(app)/admin/settings/_actions.ts`

- `getClientes()` — lista clientes (filtra por asignación si trafficker).
- `createCliente(data)` — alta de cliente.
- `updateClienteConfig(id, config_api)` — guarda credenciales (valida clave privada GA4, maneja `\n`).
- `getActiveAlerts()` — alertas de presupuesto activas.

### `(app)/admin/users/_actions.ts`

- `getUsers()`, `getAllClients()`, `createUser()`, `updateUserRole()`, `assignClientToUser()`.

### `(app)/dashboard/_actions.ts`

- `getDashboardData(clientId, from, to)` — consolida Meta/Hotmart/GA4.
- `getLeadsDiarios(clientId)` — leads de Google Sheets.
- `getMirrorDashboardData(token, from, to)` — datos para el espejo público.

### Análisis

- `(app)/leads/_actions.ts` → `marcarLeadsAction()`, `guardarReglaExclusionAction()`, `reclasificarLeadsAction()`.
- `(app)/admin/settings/[id]/_actions-conexiones.ts` → las 23 acciones de las tarjetas de captación (Meta Lead Ads, CAPI, GoHighLevel, Hotmart, Google Ads, S2S, webhooks salientes).
- `(app)/admin/settings/[id]/_moneda.ts` → `guardarMonedaReporteAction()`.
