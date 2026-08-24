# 06 · Rutas y páginas (UI)

Mapa completo de la interfaz. La app usa el **App Router** de Next.js con _route groups_ (carpetas entre paréntesis que agrupan layouts sin afectar la URL).

## Layout raíz

`src/app/layout.tsx` — Tema oscuro (`<html lang="es" className="dark">`), fuentes Geist, metadata "AdsHouse Reporting".

---

## Rutas públicas (sin login)

| Ruta                     | Archivo                                  | Descripción                                           |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| `/`                      | `src/app/page.tsx`                       | Landing con hero, features y CTA                      |
| `/login`                 | `src/app/login/page.tsx`                 | Ingreso (Supabase)                                    |
| `/signup`                | `src/app/signup/page.tsx`                | Registro (email, contraseña, nombre)                  |
| `/privacy`               | `src/app/privacy/page.tsx`               | Política de privacidad                                |
| `/terms`                 | `src/app/terms/page.tsx`                 | Términos de servicio                                  |
| `/p/[token]`             | `src/app/p/[token]/page.tsx`             | Dashboard **espejo** público por token (solo lectura) |
| `/report/[clientId]`     | `src/app/report/[clientId]/page.tsx`     | Reporte público del cliente (solo lectura)            |
| `/report/monthly/[slug]` | `src/app/report/monthly/[slug]/page.tsx` | Reporte mensual accesible por slug público            |
| `/t/[slug]`              | `src/app/t/[slug]/route.ts`              | Redirección de enlace de tracking (Report-UTM)        |

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
| `/admin/reports`       | `admin/reports/page.tsx`       | admin/superadmin | Listado de reportes mensuales; descubrimiento de campañas                 |
| `/admin/reports/[id]`  | `admin/reports/[id]/page.tsx`  | admin/superadmin | Editor/visor de un reporte mensual                                        |
| `/admin/layouts`       | `admin/layouts/page.tsx`       | admin/trafficker | Constructor de layouts (drag & drop de bloques)                           |

Componentes admin: `ClientConfigForm`, `NewClientDialog` (settings), `UserManagementClient` (users), `ReportsClient` (reports), `LayoutBuilderClient` (layouts), `ApiTokensManager`.

---

## Route group `(report-utm)` — módulo de tracking

Wrapper: `src/app/(report-utm)/layout.tsx`. Requiere sesión **+** `NEXT_PUBLIC_REPORT_UTM_ENABLED=true` (si no, redirige a `/dashboard`). Solo admin/superadmin. Sidebar propio (`ReportUtmSidebar`). Detalle funcional en [doc 12](./12-modulo-report-utm.md).

| Ruta                               | Archivo                             | Descripción                                                                |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `/report-utm`                      | `report-utm/page.tsx`               | Overview: nº clientes, ventas rastreadas, revenue 7 días, enlaces, roadmap |
| `/report-utm/clientes`             | `report-utm/clientes/page.tsx`      | Crear y listar clientes del módulo                                         |
| `/report-utm/clientes/[clienteId]` | `…/[clienteId]/page.tsx`            | Detalle del cliente: setup de webhook, edición                             |
| `/report-utm/atribucion`           | `report-utm/atribucion/page.tsx`    | Analítica de atribución: top sources, matriz UTM, tendencias               |
| `/report-utm/links`                | `report-utm/links/page.tsx`         | Crear y listar enlaces de tracking con UTMs                                |
| `/report-utm/pixel`                | `report-utm/pixel/page.tsx`         | Snippet del pixel + stream de eventos recientes                            |
| `/report-utm/ventas`               | `report-utm/ventas/page.tsx`        | Log de ventas (webhook Hotmart), con filtros y paginación                  |
| `/report-utm/ventas/[saleId]`      | `…/[saleId]/page.tsx`               | Detalle de venta + payload crudo + atribución                              |
| `/report-utm/integraciones`        | `report-utm/integraciones/page.tsx` | Setup de integraciones (stub / fases futuras)                              |

---

## Server Actions

Mutaciones tipo RPC (`'use server'` en archivos `_actions.ts`). Principales:

### `(app)/admin/settings/_actions.ts`

- `getClientes()` — lista clientes (filtra por asignación si trafficker).
- `createCliente(data)` — alta de cliente.
- `updateClienteConfig(id, config_api)` — guarda credenciales (valida clave privada GA4, maneja `\n`).
- `getActiveAlerts()` — alertas de presupuesto activas.

### `(app)/admin/users/_actions.ts`

- `getUsers()`, `getAllClients()`, `createUser()`, `updateUserRole()`, `assignClientToUser()`.

### `(app)/admin/reports/_actions.ts`

- `getMonthlyReports()`, `getMonthlyReport(id)`, `getReportTemplates()`, `discoverCampaigns()`, `createMonthlyReport()`, `updateMonthlyReport()`.

### `(app)/dashboard/_actions.ts`

- `getDashboardData(clientId, from, to)` — consolida Meta/Hotmart/GA4.
- `getLeadsDiarios(clientId)` — leads de Google Sheets.
- `getMirrorDashboardData(token, from, to)` — datos para el espejo público.

### Report-UTM

- `clientes/_actions.ts` → `createClienteAction()`.
- `clientes/[clienteId]/_actions.ts` → `updateClienteAction()`.
- `links/_actions.ts` → `createTrackingLinkAction()`.
- `atribucion/_actions.ts` → soporte para `RunAggregateButton`.

---

## Tabla resumen ruta → archivo

| Ruta                     | Archivo                                               |
| ------------------------ | ----------------------------------------------------- |
| `/`                      | `src/app/page.tsx`                                    |
| `/login`                 | `src/app/login/page.tsx`                              |
| `/signup`                | `src/app/signup/page.tsx`                             |
| `/dashboard`             | `src/app/(app)/dashboard/page.tsx`                    |
| `/dashboard/[clientId]`  | `src/app/(app)/dashboard/[clientId]/page.tsx`         |
| `/soporte`               | `src/app/(app)/soporte/page.tsx`                      |
| `/admin/settings`        | `src/app/(app)/admin/settings/page.tsx`               |
| `/admin/settings/[id]`   | `src/app/(app)/admin/settings/[id]/page.tsx`          |
| `/admin/users`           | `src/app/(app)/admin/users/page.tsx`                  |
| `/admin/api-tokens`      | `src/app/(app)/admin/api-tokens/page.tsx`             |
| `/admin/reports`         | `src/app/(app)/admin/reports/page.tsx`                |
| `/admin/reports/[id]`    | `src/app/(app)/admin/reports/[id]/page.tsx`           |
| `/admin/layouts`         | `src/app/(app)/admin/layouts/page.tsx`                |
| `/report/[clientId]`     | `src/app/report/[clientId]/page.tsx`                  |
| `/report/monthly/[slug]` | `src/app/report/monthly/[slug]/page.tsx`              |
| `/p/[token]`             | `src/app/p/[token]/page.tsx`                          |
| `/report-utm`            | `src/app/(report-utm)/report-utm/page.tsx`            |
| `/report-utm/clientes`   | `src/app/(report-utm)/report-utm/clientes/page.tsx`   |
| `/report-utm/atribucion` | `src/app/(report-utm)/report-utm/atribucion/page.tsx` |
| `/report-utm/links`      | `src/app/(report-utm)/report-utm/links/page.tsx`      |
| `/report-utm/pixel`      | `src/app/(report-utm)/report-utm/pixel/page.tsx`      |
| `/report-utm/ventas`     | `src/app/(report-utm)/report-utm/ventas/page.tsx`     |
| `/t/[slug]`              | `src/app/t/[slug]/route.ts`                           |
