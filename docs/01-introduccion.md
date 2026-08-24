# 01 · Introducción

## ¿Qué es AdsHouse Reporting?

AdsHouse Reporting es una plataforma SaaS multi-cliente pensada para agencias de marketing de performance. Su objetivo es **unificar en un solo lugar las métricas dispersas en múltiples plataformas publicitarias y de ventas**, y presentarlas en dashboards configurables, reportes mensuales y enlaces compartibles con el cliente final.

La aplicación reemplaza el trabajo manual de descargar CSVs de Meta, TikTok, Google Analytics y Hotmart, cruzarlos en hojas de cálculo y armar reportes a mano. En su lugar:

1. **Sincroniza** automáticamente los datos de cada plataforma cada día.
2. **Consolida** todo en una tabla diaria por cliente (`metricas_diarias`).
3. **Calcula** métricas derivadas (CPL, CPA, ROAS, CTR, etc.) con un motor de fórmulas.
4. **Presenta** la información en dashboards personalizables por cliente.
5. **Comparte** los reportes con enlaces públicos o reportes mensuales en PDF.

## Plataformas y fuentes de datos soportadas

| Fuente                            | Qué aporta                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Meta Ads** (Facebook/Instagram) | Inversión, impresiones, clics, alcance, conversiones, formularios de leads, desgloses por campaña/anuncio/conjunto y demografía |
| **TikTok Ads**                    | Inversión, impresiones, clics, conversiones, desgloses por campaña/anuncio/grupo                                                |
| **Google Analytics 4**            | Sesiones y eventos del sitio web                                                                                                |
| **Hotmart**                       | Ventas (principal, order bump, upsell), pagos iniciados, comisiones, clasificación por embudo                                   |
| **Google Sheets**                 | Importación y calificación de leads desde hojas externas                                                                        |

## Dos módulos en una sola aplicación

La aplicación contiene **dos productos diferenciados** que comparten autenticación, deploy e instancia de Supabase, pero **no comparten tablas ni rutas**:

### 1. Reporting principal (`public` schema)

El producto central: clientes, métricas diarias, layouts, dashboards, reportes mensuales y enlaces públicos.

### 2. Report-UTM (`report_utm` schema)

Un módulo aislado de **tracking y atribución**. Genera enlaces cortos con UTMs, instala un pixel JavaScript en sitios del cliente, recibe ventas vía webhook (Hotmart) y resuelve la atribución multi-touch (qué clic/fuente generó cada venta). Está protegido por un _feature flag_ (`NEXT_PUBLIC_REPORT_UTM_ENABLED`) y es accesible solo para administradores. Ver [doc 12](./12-modulo-report-utm.md).

## Conceptos clave

- **Cliente (`cliente`)**: cada cuenta/marca de la agencia. Tiene su propia configuración de credenciales (`config_api`), tabs y layouts.
- **Métrica diaria (`metricas_diarias`)**: una fila por cliente por día, con columnas consolidadas y desgloses JSONB por campaña/anuncio.
- **Tab (`cliente_tabs`)**: una pestaña dentro del dashboard de un cliente. Cada tab puede tener su propio filtro de campañas, configuración de embudo Hotmart y rankings.
- **Layout (`layouts_reporte` / `clientes_layouts`)**: la definición visual de un dashboard: qué tarjetas (KPIs), columnas de tabla, gráficos y bloques de texto se muestran y con qué fórmulas.
- **Fórmula**: expresión aritmética que produce una métrica (p. ej. `meta_spend / meta_clicks` → CPC). Usa campos, _macros_ (métricas pre-definidas) y _alias semánticos_ (`$visitas`, `$ventas`). Ver [doc 09](./09-motor-de-formulas.md).
- **Embudo Hotmart (funnel)**: configuración por tab que clasifica las ventas de Hotmart en _principal_, _bump_ y _upsell_ según patrones de nombre de producto.
- **Enlace público / espejo (mirror)**: URL sin login que muestra el dashboard de un cliente en modo solo lectura (`/report/[clientId]`, `/p/[token]`).
- **Atribución (Report-UTM)**: proceso de determinar qué fuente/clic/campaña originó una venta, cruzando eventos de pixel con webhooks de venta.

## Glosario de métricas frecuentes

| Sigla    | Significado                          | Fórmula típica                 |
| -------- | ------------------------------------ | ------------------------------ |
| **CPC**  | Costo por clic                       | `spend / clicks`               |
| **CPM**  | Costo por mil impresiones            | `(spend / impressions) * 1000` |
| **CTR**  | Tasa de clics                        | `(clicks / impressions) * 100` |
| **CPL**  | Costo por lead                       | `spend / leads`                |
| **CPA**  | Costo por adquisición                | `spend / conversiones`         |
| **ROAS** | Retorno de la inversión publicitaria | `ingresos / spend`             |
| **ROI**  | Retorno sobre inversión              | `(ingresos - spend) / spend`   |
| **AOV**  | Ticket promedio (Report-UTM)         | `revenue / nº ventas`          |

## Roles de usuario

| Rol                    | Acceso                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `superadmin` / `admin` | Acceso total: clientes, usuarios, tokens, reportes, layouts, Report-UTM |
| `trafficker`           | Solo los clientes asignados; puede configurar settings y layouts        |
| `viewer`               | Solo dashboards (lectura)                                               |

Detalles en [doc 05 · Autenticación y roles](./05-autenticacion-y-roles.md).

## Siguiente paso

Continúa con [02 · Arquitectura](./02-arquitectura.md) para entender el stack y la organización del código.
