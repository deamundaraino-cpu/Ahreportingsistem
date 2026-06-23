# Changelog

Todas las versiones notables de **Ad House Reporting** se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/)
y el proyecto adhiere a [Versionado Semántico](https://semver.org/lang/es/):
`MAYOR.MENOR.PARCHE`.

## [1.0.0] - 2026-06-23

Primer release estable en producción (https://reportes.adshouse.cloud/).

### Plataformas y sincronización
- Integración con **Meta Ads** (OAuth, refresco automático de tokens, Meta Forms, leads).
- Integración con **TikTok Ads** con soporte multi-cuenta y filtrado por `account_id`.
- Integración con **Hotmart** (OAuth, funnels, suscripciones) y **Google Analytics 4**.
- Integración con **Google Sheets** para conversiones offline y leads por cliente.
- Worker de sincronización con procesamiento de clientes en paralelo y fetch por rango.

### Dashboards e informes
- Dashboard por cliente con **pestañas personalizables** (drag & drop, archivado).
- **Plantillas de pestañas** globales reutilizables: guarda la visualización de una
  pestaña y aplícala al crear nuevas pestañas en cualquier cliente. Gestión
  (renombrar/eliminar) desde **Constructor de Layouts**.
- **Constructor de Layouts**: plantillas de métricas asignables a clientes.
- **Motor de fórmulas** para métricas aritméticas y macros.
- Tarjetas (KPIs), gráficos, tablas de ranking y bloques de texto editables en línea.
- Filtros de campaña compuestos aplicados a tarjetas, gráficos y tablas.
- **Reportes Mensuales** y **Report-UTM** (informes BI, atribución, links, píxel).
- Enlaces públicos (mirror) por cliente y por pestaña.

### Operación y equipo
- Roles y permisos: superadmin, admin, trafficker, viewer.
- Módulo de **Roadmap / Soporte** con gestión de tickets.
- **Notificaciones** in-app (campanita) y por **WhatsApp** (Evolution API).
- **Bitácoras** y tema claro/oscuro.

[1.0.0]: https://reportes.adshouse.cloud/
