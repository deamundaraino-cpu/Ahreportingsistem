# 02 · Arquitectura

## Stack tecnológico

| Capa                 | Tecnología                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Framework            | **Next.js 16** (App Router, React Server Components)                                            |
| UI                   | **React 19**, **Tailwind CSS 4**, **Radix UI** / shadcn, **lucide-react**, **@heroicons/react** |
| Gráficos             | **Recharts**                                                                                    |
| Formularios          | **react-hook-form** + **Zod**                                                                   |
| Drag & drop          | **@dnd-kit** (core, sortable, utilities)                                                        |
| Fechas               | **date-fns**, **react-day-picker**                                                              |
| Base de datos / Auth | **Supabase** (Postgres + Auth + RLS) vía `@supabase/ssr`                                        |
| Integraciones        | `@google-analytics/data`, `google-auth-library`, `google-spreadsheet`                           |
| PDF / export         | `jspdf`, `html2canvas`                                                                          |
| Validación           | **Zod**                                                                                         |
| Lenguaje             | **TypeScript 5.9**                                                                              |
| Deploy               | **Vercel** (con Vercel Cron) + GitHub Actions                                                   |

El servidor de desarrollo corre en el **puerto 3001** (`next dev -p 3001`).

## Estructura de carpetas

```
Ahreportingsistem/
├── docs/                      # Esta documentación
├── migrations/                # Migraciones SQL (001 … 020)
├── schema.sql                 # Esquema base (clientes, métricas, grupos)
├── public/                    # Assets estáticos, landing, report-utm-pixel.js
├── Dockerfile                 # Imagen de la app (output standalone) para Dokploy
├── next.config.ts             # Config Next.js + headers de seguridad (CSP)
├── .github/workflows/         # GitHub Action de chequeo de presupuesto
└── src/
    ├── proxy.ts               # Middleware de Next.js (auth + RBAC)
    ├── app/
    │   ├── (app)/             # Route group AUTENTICADO (dashboard, admin, soporte)
    │   ├── (report-utm)/      # Route group del módulo Report-UTM (feature-flagged)
    │   ├── report/            # Reportes PÚBLICOS (sin login)
    │   ├── p/[token]/         # Dashboard espejo público por token
    │   ├── t/[slug]/          # Redirección de enlaces de tracking
    │   ├── api/               # Endpoints HTTP (REST, webhooks, cron, MCP)
    │   ├── login, signup      # Auth
    │   ├── privacy, terms     # Páginas legales
    │   └── layout.tsx         # Layout raíz (tema oscuro, fuentes Geist)
    ├── components/
    │   ├── ui/                # Primitivos shadcn (button, card, dialog, …)
    │   ├── layout/            # AppSidebar
    │   ├── api-tokens/        # Gestor de tokens
    │   └── report-utm/        # Componentes del módulo Report-UTM
    ├── lib/                   # Lógica de negocio y utilidades
    │   ├── formula-engine.ts  # Motor de fórmulas (núcleo del producto)
    │   ├── campaign-filter.ts # Filtrado/agregación de campañas
    │   ├── ranking-aggregation.ts
    │   ├── country-parser.ts
    │   ├── layout-types.ts    # Tipos del sistema de layouts
    │   ├── api-token-auth.ts  # Auth por token de API
    │   ├── cron-auth.ts       # Auth de cron jobs
    │   ├── error-handler.ts   # Errores y logging estructurado
    │   ├── validation.ts      # Validación con Zod
    │   ├── integrations/google-sheets.ts
    │   └── report-utm/        # Lógica del módulo de atribución
    └── utils/supabase/        # Clientes Supabase (browser, server, middleware)
```

## Modelo de renderizado

La aplicación es **híbrida**:

- **Server Components** por defecto: las páginas (`page.tsx`) son asíncronas y obtienen datos directamente desde Supabase en el servidor.
- **Server Actions** (`_actions.ts` con `'use server'`): mutaciones tipo RPC invocadas desde formularios; usan `revalidatePath()` para refrescar.
- **Client Components** (`'use client'`): toda la interactividad (filtros, modales, drag&drop, gráficos). Los componentes terminados en `*Client.tsx` son la versión cliente de una página.
- **API Routes** (`route.ts`): endpoints HTTP para webhooks, cron, API pública v1, MCP y OAuth.

## Route groups

Next.js agrupa rutas con paréntesis (no afectan la URL, solo el layout):

| Route group    | URL                                                                    | Layout / propósito                                      |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `(app)`        | `/dashboard`, `/admin/*`, `/soporte`                                   | Autenticado. Renderiza `AppSidebar`. RBAC por rol.      |
| `(report-utm)` | `/report-utm/*`                                                        | Autenticado + feature flag. Sidebar propio. Solo admin. |
| (raíz)         | `/report/*`, `/p/*`, `/t/*`, `/login`, `/signup`, `/privacy`, `/terms` | Públicas o de auth.                                     |

Ver el mapa completo en [doc 06 · Rutas y páginas](./06-rutas-y-paginas.md).

## Flujo de datos principal (reporting)

```
┌─────────────┐   Vercel Cron (diario)   ┌──────────────────┐
│ Meta / TikTok│ ───────────────────────►│  /api/worker     │
│ GA4 / Hotmart│                          │  (sincronizador) │
└─────────────┘                          └────────┬─────────┘
                                                   │ upsert
                                                   ▼
                                      ┌─────────────────────────┐
                                      │  metricas_diarias        │
                                      │  (1 fila/cliente/día +   │
                                      │   desgloses JSONB)       │
                                      └────────────┬────────────┘
                                                   │ lee
                  ┌────────────────────────────────┼──────────────────────┐
                  ▼                                 ▼                       ▼
         ┌────────────────┐              ┌──────────────────┐    ┌──────────────────┐
         │ formula-engine │◄─ layouts ─►│  DashboardClient  │    │ /api/reports/    │
         │ (evalúa KPIs)  │              │  (UI interactiva) │    │   monthly        │
         └────────────────┘              └──────────────────┘    └──────────────────┘
                                                   │                       │
                                          enlaces públicos          reporte mensual
                                          /report, /p/[token]       /report/.../monthly
```

1. Los **workers** (cron) consultan las APIs de cada plataforma y hacen `upsert` en `metricas_diarias`, guardando totales y desgloses JSONB (`meta_campaigns`, `meta_ads`, `tiktok_campaigns`, etc.).
2. Las páginas de dashboard leen esas filas y, junto con el **layout** del cliente, usan el **motor de fórmulas** para calcular cada KPI/columna/gráfico.
3. Los datos se exponen en la UI autenticada, en enlaces públicos y en reportes mensuales.

## Flujo de datos del módulo Report-UTM

```
Visitante  ──►  /t/[slug]  ──► (cookies de atribución) ──► destino con UTMs
   │                                                            │
   │ pixel JS (report-utm-pixel.js)                             │
   ▼                                                            ▼
/api/report-utm/pixel/event ──► pixel_events            Compra en Hotmart
                                     │                          │
                                     │                          ▼
                                     │       /api/report-utm/webhooks/hotmart/[clienteId]
                                     │                          │
                                     └──── attribution-resolver ┤
                                                                ▼
                                                          sales_events
                                                       (con first/last touch)
                                                                │
                                            ┌───────────────────┼──────────────┐
                                            ▼                   ▼              ▼
                                     hourly_metrics    dashboard atribución  outbound webhooks
```

Detalle completo en [doc 12 · Módulo Report-UTM](./12-modulo-report-utm.md).

## Seguridad transversal

- **RLS (Row Level Security)** en Postgres: cada cliente solo ve sus filas; los workers usan la _service role key_ que omite RLS. Ver [doc 04](./04-modelo-de-datos.md).
- **Middleware** (`src/proxy.ts` → `utils/supabase/middleware.ts`): protege rutas, gestiona sesión y aplica RBAC. Ver [doc 05](./05-autenticacion-y-roles.md).
- **Headers de seguridad** (`next.config.ts`): HSTS, X-Content-Type-Options, CSP, X-Frame-Options (con excepción para rutas públicas embebibles). Ver [doc 15](./15-despliegue.md).
- **Autenticación por capas**: sesión Supabase (UI), tokens de API (`/api/v1`, MCP), secreto de cron (`CRON_SECRET`), firma HMAC (webhooks).

## Convenciones de código

- Idioma del dominio en **español** (nombres de columnas, métricas, UI): `clientes`, `metricas_diarias`, `ventas_principal`, etc.
- Tipos centralizados en `src/lib/layout-types.ts` y `src/lib/report-utm/types.ts`.
- Errores y logging mediante `src/lib/error-handler.ts` (`ApiError`, `logger`).
- Validación de entradas con Zod (`src/lib/validation.ts`).
- Existe una guía de refactorización en [`REFACTORING_GUIDE.md`](../REFACTORING_GUIDE.md) con el patrón recomendado para endpoints (validar → fetch con timeout → fetchers modulares → try/catch → tipado).
