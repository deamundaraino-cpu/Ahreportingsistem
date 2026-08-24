# AdsHouse Reporting — Auditoría de UI y Plan de Wireframes

> Documento de handoff para **Claude Design**. Contiene la auditoría completa de la plataforma actual (todas las rutas, funcionalidades y elementos) y la especificación de wireframes de cada página. Producción: https://reportes.adshouse.cloud/

---

## 1. Contexto del producto

**AdsHouse Reporting** es un SaaS multi-cliente para agencias de marketing de performance. Unifica métricas de Meta Ads, TikTok Ads, Google Analytics 4, Hotmart y Google Sheets en dashboards configurables por cliente, reportes mensuales y enlaces públicos compartibles.

Contiene **dos productos** en una sola app:

1. **Reporting principal** — clientes, métricas diarias, layouts configurables, reportes mensuales, enlaces espejo públicos.
2. **Report-UTM** — módulo aislado de tracking y atribución: enlaces cortos con UTMs, pixel JS, webhooks de venta (Hotmart) y atribución multi-touch. Tiene sidebar y navegación propios.

**Stack:** Next.js App Router · Supabase (auth + Postgres) · Tailwind (tema oscuro) · shadcn/ui · Recharts · dnd-kit.

### Roles (RBAC)

| Rol                    | Acceso                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| `superadmin` / `admin` | Todo: clientes, usuarios, tokens, reportes, layouts, WhatsApp, Report-UTM     |
| `trafficker`           | Solo clientes asignados; puede configurar settings y layouts de esos clientes |
| `viewer`               | Solo dashboards en lectura                                                    |

---

## 2. Sistema de diseño actual (a respetar/evolucionar)

- **Tema:** dark-only. Fondos `zinc-900/950`, bordes `zinc-800`, texto `zinc-100/200`, labels `zinc-400` en `text-xs/sm`.
- **Marca:** gradiente rojo `#E53529` → azul `#1E6AB5` (logo y nav activa). Report-UTM usa identidad propia emerald → violet.
- **Acentos semánticos:** emerald (positivo/conectado), red/rose (negativo/borrar), amber (advertencia/pendiente), blue/indigo (informativo), zinc (neutro).
- **Tipografía:** Geist; valores numéricos en `font-mono` tabular.
- **Grid de dashboard:** 4 columnas en desktop, 1 en mobile. Cards KPI = 1 col; gráficos, tablas y rankings = 4 col (full width); bloques de texto = 1–4 col configurable.
- **Patrones recurrentes:** stat-cards (icono + label + valor), empty states (icono + texto + CTA), tablas con header sticky + hover + paginación Anterior/Siguiente, modales para configuración profunda, drag & drop para reordenar, badges de estado tipo "pill".

---

## 3. Mapa del sitio

```
PÚBLICO (sin login)
├── /                      Landing (hero, features, CTA)
├── /login                 Ingreso
├── /signup                Registro
├── /privacy · /terms      Legales
├── /p/[token]             Dashboard espejo público (solo lectura, embebible)
├── /report/[clientId]     Reporte público del cliente
├── /report/monthly/[slug] Reporte mensual por slug público
└── /t/[slug]              Redirect de tracking link (sin UI)

APP AUTENTICADA — sidebar "AdsHouse Reporting"
├── /dashboard             Home: KPIs globales, grilla de clientes, alertas, soporte
├── /dashboard/[clientId]  Dashboard del cliente (corazón del producto)
├── /soporte               Roadmap / tickets de soporte
└── /admin
    ├── /admin/settings            Lista de clientes + integraciones
    ├── /admin/settings/[id]       Configuración de credenciales del cliente
    ├── /admin/users               Gestión de usuarios y roles
    ├── /admin/layouts             Constructor de layouts (drag & drop)
    ├── /admin/reports             Reportes mensuales (workflow)
    ├── /admin/reports/[id]        Editor/visor de reporte mensual
    ├── /admin/api-tokens          Tokens de API
    └── /admin/whatsapp            Notificaciones WhatsApp (grupos)

REPORT-UTM (feature flag, solo admin) — sidebar propio
├── /report-utm                Overview del módulo
├── /report-utm/clientes       Clientes del módulo (+ detalle [clienteId])
├── /report-utm/ventas         Log de ventas (+ detalle [saleId])
├── /report-utm/atribucion     Analítica de atribución
├── /report-utm/links          Tracking links
├── /report-utm/pixel          Pixel & eventos
└── /report-utm/integraciones  Stub de integraciones futuras
```

---

## 4. Navegación global

### 4.1 AppSidebar (app principal)

```
┌──────────────────────────┐
│ ◆ AdsHouse Reporting     │  ← logo gradiente rojo→azul, h-68px
├──────────────────────────┤
│ [→ Ir a Report-UTM]      │  ← solo si flag activo (borde dashed emerald)
├──────────────────────────┤
│ DASHBOARD                │
│  ▸ General Overview      │  → /dashboard
│                          │
│ CONFIGURACIÓN            │
│  ▸ Ajustes de Sistema    │  → /admin/settings   (todos los roles equipo)
│  ▸ Constructor Layouts   │  → /admin/layouts
│  ▸ Reportes Mensuales    │  → /admin/reports    (admin+)
│  ▸ Gestión de Usuarios   │  → /admin/users      (admin+)
│  ▸ API & Integraciones   │  → /admin/api-tokens (admin+)
│  ▸ WhatsApp              │  → /admin/whatsapp   (admin+)
│                          │
│ [🗺️ Roadmap]             │  → /soporte
├──────────────────────────┤
│ 🛡 [badge rol]  [Salir]  │
└──────────────────────────┘
```

- Desktop: fija a la izquierda (w-64). Mobile: overlay con hamburguesa.
- Ítem activo: gradiente de marca. Ítems ocultos por rol (viewer solo ve Dashboard).

### 4.2 ReportUtmSidebar

Misma estructura, identidad emerald/violet: logo "Report-UTM", switcher de workspace (→ volver a Reporting), secciones **Panel** (Overview, Clientes), **Tracking** (Ventas, Atribución UTM, Tracking Links, Pixel & Eventos), **Configuración** (Integraciones), footer con badge de rol y logout.

---

## 5. Wireframes por página

### 5.1 `/login` y `/signup`

```
        (glow ámbar arriba-izq)              (glow azul abajo-der)
                    ┌────────────────────────────┐
                    │  📊 AdsHouse | Reporting    │
                    │ ┌────────────────────────┐ │
                    │ │ Bienvenido             │ │
                    │ │ Ingresa a tu cuenta    │ │
                    │ │ Email     [__________] │ │
                    │ │ Password  [__________] │ │
                    │ │ [! error inline rojo ] │ │
                    │ │ [  Iniciar Sesión  ]   │ │
                    │ │ ¿No tienes cuenta? →   │ │
                    │ └────────────────────────┘ │
                    └────────────────────────────┘
```

- **Signup** agrega: nombre completo; estado de éxito (alert emerald + redirect 3 s).
- También existe conexión **Google OAuth** (commit reciente) — incluir botón "Continuar con Google" en el wireframe.

### 5.2 `/dashboard` — Home global

```
┌ Sidebar ┬──────────────────────────────────────────────────────────┐
│         │ Dashboard General                                        │
│         │ ┌─────────┐ ┌─────────────┐ ┌──────────┐ ┌────────────┐ │
│         │ │Clientes │ │Integraciones│ │ Alertas  │ │ Tickets    │ │
│         │ │   12    │ │ activas 8   │ │ ⚠ 2      │ │ abiertos 5 │ │
│         │ └─────────┘ └─────────────┘ └──────────┘ └────────────┘ │
│         │ Clientes                                  [buscar...]    │
│         │ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│         │ │ Cliente A  │ │ Cliente B  │ │ Cliente C  │  ← grilla  │
│         │ │ ●Meta ●HM  │ │ ●Meta ○TT  │ │ ...        │    cards   │
│         │ │ [Abrir →]  │ │ [Abrir →]  │ │            │            │
│         │ └────────────┘ └────────────┘ └────────────┘            │
│         │ Resumen de soporte (últimos tickets) ───────────────────│
└─────────┴──────────────────────────────────────────────────────────┘
```

### 5.3 `/dashboard/[clientId]` — Dashboard del cliente ⭐ (página núcleo)

La página más compleja. Sistema de pestañas + bloques configurables.

```
┌ Sidebar ┬────────────────────────────────────────────────────────────────┐
│         │ Cliente X            [Rango fechas ▾] [🔗 Link público] [Copiar]│
│         │ ┌──────────────────────────────────────────────────────────┐   │
│         │ │ [Vista General][Tab 2][Tab 3]…[📊 Rep. Mensual][🗺️ Road] │   │
│         │ │ [+ Nueva Pestaña] [🗄 Archivo (n)]                        │   │
│         │ ├──────────────────────────────────────────────────────────┤   │
│         │ │ ✦ Layout Personalizada  [buscar campaña… ×]               │   │
│         │ │     [+ Agregar ▾] [🧩 Rompecabezas] [⚙ Configurar Layout] │   │
│         │ ├── Cards de presupuesto (si la tab tiene fechas/budget) ──┤   │
│         │ │ [📅 Rango captación][⏱ Días faltantes][💰 Restante][📈/día]│  │
│         │ ├── GRID 4 COLS de bloques (drag & drop) ──────────────────┤   │
│         │ │ ┌KPI──┐ ┌KPI──┐ ┌KPI──┐ ┌KPI──┐                          │   │
│         │ │ │Spend│ │Leads│ │ CPL │ │ROAS │   ← cards 1 col          │   │
│         │ │ └─────┘ └─────┘ └─────┘ └─────┘                          │   │
│         │ │ ┌─ Gráfico (full width, alto 240px) ──────────────────┐  │   │
│         │ │ │  area / bar / line / donut / funnel / composed…     │  │   │
│         │ │ └─────────────────────────────────────────────────────┘  │   │
│         │ │ ┌─ Tabla Embudo Diario (full) ────────────────────────┐  │   │
│         │ │ │ [Ver Todo][Grupos 📊][Keywords]                      │  │   │
│         │ │ │ Fecha | Spend | Clicks | Leads | CPL | Ventas | ROAS │  │   │
│         │ │ │ … filas por día, totales por semana, celdas manuales │  │   │
│         │ │ └─────────────────────────────────────────────────────┘  │   │
│         │ │ ┌─ Ranking (full): Top campañas/anuncios/adsets ──────┐  │   │
│         │ │ │ # | Nombre (hover→thumbnail) | Spend | Leads | CPL   │  │   │
│         │ │ └─────────────────────────────────────────────────────┘  │   │
│         │ │ ┌─ Desglose por país (colapsable) ─┐ ┌─ Leads Sheets ─┐  │   │
│         │ │ └──────────────────────────────────┘ └────────────────┘  │   │
│         │ │ [Bloques de texto/separadores intercalados]              │   │
│         │ └──────────────────────────────────────────────────────────┘   │
└─────────┴────────────────────────────────────────────────────────────────┘
```

**Tipos de bloque (sistema de layouts):**

| Bloque                  | Span    | Contenido                                                                                                                                                  | Acciones hover                                            |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Card KPI**            | 1 col   | label + valor grande con color (emerald/red/blue/amber), prefijo/sufijo, decimales                                                                         | duplicar, editar, colapsar; en modo puzzle: drag + borrar |
| **Gráfico**             | 4 col   | 11 tipos: area, stacked_area, bar, stacked_bar, line, donut, pie, composed, radial, scatter, funnel; periodicidad día/semana/mes/año; data labels          | ídem                                                      |
| **Tabla embudo diario** | 4 col   | columnas con fórmulas, celdas manuales editables, highlight verde/rojo, totales semanales, fines de semana sombreados, columnas redimensionables           | filtros por grupo/keyword                                 |
| **Ranking**             | 4 col   | dimensión: campañas/anuncios/adsets (Meta) o campañas/ads/adgroups (TikTok); top-N, orden clickeable, preview de creativos al hover, consolidar por nombre | ídem cards                                                |
| **Texto / Separador**   | 1–4 col | h1/h2/h3/p, color, fuente, alineación; separador: línea/dashed/dots/espacio                                                                                | editar, duplicar                                          |
| **Productos Extras**    | 4 col   | tabla Producto / Ventas / Bruto / Neto + fila total (solo Vista General)                                                                                   | —                                                         |

**Modales del dashboard:**

1. **TabConfigModal** (crear/editar pestaña): nombre, keyword Meta, plantilla asociada, fecha inicio/cierre, presupuesto; sección colapsable **Funnel Hotmart** (productos principal/bump/upsell con wildcards, precios, landing/checkout/upsell pages); acciones Eliminar / Duplicar / Guardar.
2. **LayoutConfigModal** (configuración profunda): secciones drag&drop para Columnas (label, fórmula, tipo $/#/%, highlight, filtro de campañas, manual, ocultar), Tarjetas, Gráficos (tipo, métricas con color por serie, periodicidad, altura), Bloques de texto y Métricas personalizadas. Botones: Reset a plantilla / Aplicar.
3. **QuickEditModal** (lápiz sobre un bloque): editor contextual del bloque (card/chart/text/ranking) sin abrir la config completa.
4. **TabArchiveView**: lista de pestañas archivadas, expandir para ver sus cards, botón restaurar.

**Motor de fórmulas:** cada card/columna/serie usa expresiones como `meta_spend / meta_clicks`, con macros y alias (`$visitas`, `$ventas`). Métricas disponibles: meta_* (spend, impressions, reach, clicks, leads, purchases, roas…), tiktok__, ga__, hotmart (pagos iniciados, ventas principal/bump/upsell), funnel_* por tab, y leads de Sheets.

**Pestaña 📊 Reporte Mensual** (dentro del dashboard): selector de mes ◂ ▸, KPI cards con badges de variación vs mes anterior (▲▼), gráfico diario spend vs resultados, pie por campaña, demografía edad/género, top/bottom creativos con thumbnail, sección de notas editable (admin).

**Pestaña 🗺️ Roadmap** (SupportModule embebido): tickets del cliente — ver 5.5.

### 5.4 Variantes públicas del dashboard

- **`/p/[token]`** — espejo: header sticky con logo "AdsHouse | Mirror" + "Reporte de: {cliente}" + selector de fechas; mismo DashboardClient en modo `isPublic` (sin sidebar, sin botones de edición, sin modo puzzle). Embebible en iframes.
- **`/report/[clientId]`** — ídem con título "Reporte de Resultados".
- **`/report/monthly/[slug]`** — reporte mensual imprimible: header (título, cliente, período "Marzo 2025", badge de template), 4 stat-cards (Gasto, Leads, CPL, Impresiones), tabla desglose por campaña con totales en tfoot, footer "Generado por AdsHouse".

### 5.5 `/soporte` — Roadmap / Tickets

```
│ 🗺️ Roadmap            n pendientes · m total        [+ Nuevo ítem] │
│ ┌─ Form crear (expandible) ─────────────────────────────────────┐ │
│ │ Tipo: [🐛Bug][✨Feature][🔧Mejora][📋Tarea]  Cliente:[▾ Interno]│ │
│ │ Solicitante [____] Entrega [date]  Prioridad: [Alta|Media|Baja]│ │
│ │ Requerimiento [textarea]  Observaciones [textarea]             │ │
│ │                                       [Cancelar] [Enviar]      │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ [buscar…] [Tipo ▾] [Estado ▾ activos]                              │
│ ┌─ fila ticket ──────────────────────────────────────────────────┐ │
│ │ #ID · ClienteBadge      Requerimiento + obs        🐛 Alta      │ │
│ │ Solicitante · fecha     Responsable · deadline     [Estado ▾]   │ │
│ │                                          ⏱ abierto 3d · ✏ edit │ │
│ └────────────────────────────────────────────────────────────────┘ │
```

Estados: `abierto` → Planeado (azul), `en_progreso` → En desarrollo (ámbar), `completado` → Lanzado (emerald), `cancelado` → Descartado (zinc). Urgente = entrega ≤ 2 días.

### 5.6 `/admin/settings` — Clientes

Grid de 3 columnas de cards de cliente: nombre, 4 badges de integración (Meta Ads, Hotmart, TikTok, GA4 — ● verde "Conectado" / ● ámbar "Pendiente"), fecha de creación, botón "Grupos" (grupos de campañas). Header con botón **"Nuevo Cliente"** (diálogo: nombre, slug, descripción). Card de **conexión Google OAuth** (estado + conectar). Empty state con CTA.

### 5.7 `/admin/settings/[id]` — Configuración del cliente

Formulario centrado (max-w-3xl) `ClientConfigForm`: datos básicos + secciones de credenciales por integración (Meta token/account, Hotmart client id/secret/OAuth, TikTok, GA4 con clave privada de service account, Google Sheets), selección de layout asociado. Guardar/Cancelar.

### 5.8 `/admin/users` — Usuarios

Grid de cards de usuario: avatar, nombre, email, badge de rol (superadmin=amber, admin=purple, trafficker=blue, viewer=zinc), badge "Tú", botones **Clientes** (asignación, solo traffickers), **Rol** (dropdown) y borrar. Modal "Nuevo Usuario": nombre, email, contraseña (show/hide), selector de rol, multi-select de clientes con contador.

### 5.9 `/admin/layouts` — Constructor de layouts

`LayoutBuilderClient`: lista de plantillas + builder drag & drop de bloques (mismas secciones que LayoutConfigModal pero a nivel de plantilla reutilizable entre clientes).

### 5.10 `/admin/reports` y `/admin/reports/[id]`

- **Lista**: tabla cliente / período / template / estado (borrador=zinc, revisión=ámbar, aprobado=azul, publicado=emerald) / acciones.
- **Detalle**: layout 2 columnas (4:8). Izquierda: config (template, checklist de campañas descubiertas N/M, guardar). Derecha: preview del reporte (header cliente·período + badge estado, botones **PDF**, **Revertir**, y acción de workflow: Enviar a Revisión → Aprobar → Publicar; tabla de campañas con spend/leads/impresiones).

### 5.11 `/admin/api-tokens`

`ApiTokensManager`: tabla nombre / prefijo / permisos / creado / expira / acciones; modal crear token (mostrar token una sola vez + copiar); revocar con confirmación. Alimenta la API REST `/api/v1/*` y el MCP.

### 5.12 `/admin/whatsapp`

Estado de conexión (QR para vincular, conectado/desconectado/error), ruteo grupo de WhatsApp → cliente/tipo de notificación, historial de mensajes recientes. (Existe cron de digest diario.)

### 5.13 Report-UTM — Overview `/report-utm`

4 stat-cards (Clientes, Ventas trackeadas, Revenue 7d, Tracking links) + card "Clientes recientes" (5, con status pill y link Ver todos) + card "Roadmap del módulo" (fases 0–3).

### 5.14 `/report-utm/clientes` y `[clienteId]`

- **Lista**: form de alta inline (nombre, slug, color, descripción) + tabla Cliente / Slug / Status / Creado / Abrir.
- **Detalle**: header (nombre, slug, ID, link a ventas), 3 stats (Eventos, Revenue aprobado, Ticket promedio), card **Integración Hotmart** (estado, webhook URL copiable, secret), card **Webhooks salientes** (tabla nombre/URL/eventos/status/último disparo), tabla de últimas 10 ventas.

### 5.15 `/report-utm/ventas` y `[saleId]`

- **Lista**: barra de filtros (cliente, status approved/pending/refunded/chargeback, utm_source, desde/hasta, Limpiar/Aplicar) + tabla fecha / cliente / comprador / producto / source / campaign / tipo / status pill / badge atribución / monto / → detalle. Paginación de 50.
- **Detalle**: datos de la venta + atribución resuelta + payload JSON crudo.

### 5.16 `/report-utm/atribucion`

Filtros (cliente, rango 1h–90d, botón ejecutar agregación) → 4 stats (Eventos, Revenue, AOV, Sources) → gráfico de revenue diario (línea) + distribución por source (pie/bar) → tabla Top sources (con barra de % del total) → **matriz UTM** scrolleable (source × campaign: ventas, revenue, AOV, reembolsos).

### 5.17 `/report-utm/links`

Form de alta (cliente, nombre, URL destino, slug auto, los 5 UTMs) + tabla Link / slug→destino / UTMs / clicks / status / acciones. Los links redirigen vía `/t/[slug]` con cookie de atribución first/last-touch 90 días.

### 5.18 `/report-utm/pixel`

Selector de cliente → card **Snippet de instalación** (code block copiable + docs de eventos custom) → 4 stats (Eventos, Pageviews, Clicks, Visitors únicos) → stream de 50 eventos recientes (hora, cliente, tipo badge, página, UTM/click, visitor ID).

### 5.19 `/report-utm/integraciones`

Stub de fase futura: icono + título + bullets (Hotmart webhook, Meta OAuth, Google Ads OAuth, CartPanda/Shopify).

### 5.20 Landing `/` + legales

Hero + features + CTA (login/signup). `/privacy` y `/terms`: páginas legales tipo documento.

---

## 6. Hallazgos de la auditoría (oportunidades para el rediseño)

1. **Inconsistencia entre los dos módulos**: el reporting principal usa marca rojo→azul y Report-UTM emerald→violet; los patrones de tabla, filtros y stat-cards difieren ligeramente. → Unificar un design system con tokens compartidos y theming por módulo.
2. **Sobrecarga de la toolbar del dashboard del cliente**: hay ~7 acciones (Agregar, Puzzle, Sección, Separador, Guardar, Configurar, búsqueda) compitiendo en una fila. → Wireframe debería consolidar en un "modo edición" explícito con barra contextual.
3. **Tres niveles de edición superpuestos** (QuickEditModal, LayoutConfigModal, /admin/layouts) que hacen lo mismo a distinta profundidad. → Clarificar jerarquía visual: edición inline → panel lateral → constructor global.
4. **Formularios de alta inline vs modales** mezclados (Report-UTM crea inline; admin crea con diálogos). → Estandarizar.
5. **Sin estados de carga/skeleton documentados** ni manejo visual de errores de sync de integraciones más allá del badge Conectado/Pendiente. → Definir estados loading / error / empty / partial-data para cada bloque.
6. **Mobile**: el grid colapsa a 1 columna pero las tablas anchas (embudo diario, matriz UTM) no tienen patrón móvil definido. → Diseñar scroll horizontal con columna fija o vista de cards.
7. **El soporte vive en dos sitios** (`/soporte` global y pestaña Roadmap por cliente). → Unificar componente y diferenciar solo el filtro.
8. **Accesibilidad**: tema dark-only con varios grises de bajo contraste (`zinc-400` sobre `zinc-900`); revisar ratios AA.
9. **Páginas stub** (integraciones UTM, landing, legales) sin diseño real — incluirlas en el alcance de wireframes.

---

## 7. Instrucciones para Claude Design

1. **Alcance**: wireframes de las ~25 pantallas de la sección 5, más los 4 modales del dashboard (TabConfig, LayoutConfig, QuickEdit, Archivo) y los 3 estados base (loading, empty, error) de los bloques del dashboard.
2. **Prioridad**: ① `/dashboard/[clientId]` con sus modales (núcleo del producto), ② vistas públicas `/p/[token]` y reporte mensual, ③ admin (settings, users, reports), ④ Report-UTM, ⑤ landing y auth.
3. **Mantener**: tema oscuro, grid de 4 columnas, sistema de bloques drag & drop, identidad dual (marca principal / Report-UTM) pero sobre tokens comunes.
4. **Resolver**: los 9 hallazgos de la sección 6, especialmente el modo edición del dashboard y el patrón móvil de tablas.
5. **Breakpoints**: desktop ≥1280 (sidebar fija), tablet (sidebar colapsable), mobile (overlay + 1 col).
6. **Entregable sugerido**: wireframes de baja fidelidad por pantalla → flujo de edición de layout en alta fidelidad → design tokens (colores semánticos, tipografía, espaciado, estados).
