# Documentación — AdsHouse Reporting

Plataforma multi-cliente para agencias de publicidad que **consolida métricas de Meta Ads, TikTok Ads, Google Analytics 4, Hotmart y Google Sheets** en dashboards personalizables, reportes mensuales y enlaces públicos compartibles. Incluye además un módulo independiente de **tracking y atribución UTM** (`report-utm`).

> Aplicación Next.js 16 (App Router) + React 19 + Supabase (Postgres + Auth) + Tailwind 4, desplegada en Vercel.

---

## Índice de la documentación

| # | Documento | Contenido |
|---|-----------|-----------|
| 01 | [Introducción](./01-introduccion.md) | Qué resuelve la aplicación, conceptos clave y glosario |
| 02 | [Arquitectura](./02-arquitectura.md) | Stack tecnológico, estructura de carpetas, flujos de datos |
| 03 | [Instalación y configuración](./03-instalacion-y-configuracion.md) | Requisitos, variables de entorno, puesta en marcha local |
| 04 | [Modelo de datos](./04-modelo-de-datos.md) | Tablas, columnas, RLS, estructuras JSONB y migraciones |
| 05 | [Autenticación y roles](./05-autenticacion-y-roles.md) | Supabase Auth, roles, RBAC y middleware |
| 06 | [Rutas y páginas (UI)](./06-rutas-y-paginas.md) | Mapa completo de páginas, route groups y server actions |
| 07 | [API REST](./07-api-rest.md) | Todos los endpoints HTTP, métodos, auth y payloads |
| 08 | [Integraciones externas](./08-integraciones.md) | Meta, TikTok, Hotmart, GA4 y Google Sheets |
| 09 | [Motor de fórmulas](./09-motor-de-formulas.md) | Evaluación de métricas, macros y alias semánticos |
| 10 | [Sistema de layouts y dashboards](./10-sistema-de-layouts.md) | Layouts, tabs, tarjetas, gráficos y rankings |
| 11 | [Reportes mensuales](./11-reportes-mensuales.md) | Plantillas, generación y reportes públicos |
| 12 | [Módulo Report-UTM](./12-modulo-report-utm.md) | Tracking, pixel, webhooks y atribución multi-touch |
| 13 | [MCP y tokens de API](./13-mcp-y-tokens-api.md) | Servidor MCP y gestión de tokens programáticos |
| 14 | [Cron jobs y workers](./14-cron-y-workers.md) | Sincronizaciones automáticas y tareas programadas |
| 15 | [Despliegue y operación](./15-despliegue.md) | Vercel, crons, headers de seguridad y monitoreo |
| 16 | [Campos de Sheet](./16-campos-de-sheet.md) | Guía paso a paso: conectar un Google Sheet y convertir sus columnas en métricas |
| 17 | [Campos de lead](./17-campos-de-lead.md) | Convertir las respuestas de los formularios en dimensiones y filtros de los informes |
| 18 | [Fuentes de datos y cruces](./18-fuentes-y-cruces.md) | Qué cruza con qué y por qué, recetario de widgets y diagnóstico de informes vacíos |

---

## Inicio rápido

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno (ver doc 03)
cp .env.example .env.local   # crear y completar manualmente

# 3. Levantar el servidor de desarrollo (puerto 3001)
npm run dev
```

Abre [http://localhost:3001](http://localhost:3001).

Scripts útiles:

```bash
npm run dev          # Servidor de desarrollo en puerto 3001
npm run build        # Build de producción
npm run start        # Servidor de producción
npm run lint         # ESLint (0 warnings permitidos)
npm run type-check   # Verificación de tipos TypeScript
npm run format       # Prettier
npm run validate     # type-check + lint + format:check
```

---

## Mapa mental de un minuto

- **Workers (cron)** sincronizan a diario las métricas de cada plataforma hacia la tabla `metricas_diarias`.
- El **motor de fórmulas** evalúa esas métricas mediante fórmulas configurables (alias semánticos + macros) sin usar `eval`.
- Los **layouts** definen qué tarjetas, columnas, gráficos y rankings se muestran por cliente/tab.
- Los **enlaces públicos** (`/report/...`, `/p/[token]`) exponen los dashboards a los clientes sin login.
- El **módulo Report-UTM** es un universo aparte (schema `report_utm`) para rastrear clics, pixel y ventas con atribución multi-touch.

Para entender cómo encaja todo, empieza por [Introducción](./01-introduccion.md) y [Arquitectura](./02-arquitectura.md).
