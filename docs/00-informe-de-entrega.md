# 00 · Informe de entrega del proyecto

> Para el equipo que continúa con AdsHouse Reporting. Fecha de corte: **2026-09-28**, actualizado al final del día.
> Las cifras de base de datos de este documento se midieron contra producción ese mismo día.
>
> Léelo entero antes de tocar nada. Los apartados 3 (despliegue) y 4 (base de datos) son los que evitan romper producción.

---

## 1 · Resumen en un minuto

**Qué es.** Plataforma multi-cliente de la agencia que junta en un solo sitio las métricas de Meta Ads, TikTok Ads, GA4, Hotmart, Google Sheets y GoHighLevel. Ofrece dashboards por cliente, informes BI con enlace público, gestión de leads con atribución UTM y un agente conversacional (panel web + WhatsApp + servidor MCP).

**Stack.** Next.js 16.3 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage). Corre en contenedores Docker en un VPS con **Dokploy**. Un proceso aparte, `sync-worker/`, sincroniza los datos.

**Estado.** En producción y en uso diario con 6 clientes activos. El 2026-09-28 se fusionó a `main` la rama de unificación (PR #10) y ya corre en producción. La sincronización está sana: 1 job en error de 1.387.

**Lo primero que hay que resolver** (detalle en el apartado 11):

1. **Quedan dos commits por fusionar:** conversiones personalizadas de Meta y GA4 por campaña. Están en GitHub, en la rama `unificacion-reporting-utm`, pero no en `main`. Al fusionarlos hay que redesplegar **la app y el `sync-worker`**.
2. **La base de datos está al límite de memoria.** El cómputo es Micro (1 GB de RAM) y la base pesa 577 MB. Ya se cayó una vez, el 2026-09-20. Subir el cómputo es la mejora más rentable del proyecto.
3. **Quedan tareas de base de datos:** la migración 085 (autovacuum), el backfill de `page_url` de la 084, las claves de respuestas de la 090 y, tras el despliegue, el backfill de conversiones personalizadas de Eduversio.
4. **Hay tareas operativas fuera del código:** plantilla de URL con IDs en los anuncios, webhook de Hotmart, permisos de GoHighLevel, Meta Lead Ads de Eduversio en error y **aviso a los clientes de las cifras que cambian**. Detalle en el apartado 11.
5. **El CI valida con Node 20**, pero la app exige Node ≥ 22.12. Con Node 20 el dashboard devuelve 500.

---

## 2 · Arquitectura

### Piezas desplegadas

| Pieza               | Código                                    | Dónde corre                                                                          | Qué hace                                                                                                                                                                                        |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App web             | raíz del repo, `Dockerfile`               | Dokploy (VPS), puerto 3000, dominio `reportes.adshouse.cloud`                        | UI, API REST, webhooks, MCP, endpoints de worker                                                                                                                                                |
| `sync-worker`       | `sync-worker/` (`sync-worker/Dockerfile`) | Dokploy, mismo VPS, puerto 8080, **sin dominio**                                     | Scheduler + drena la cola `sync_jobs` cada 15 s. **Es obligatorio**: es el único que refresca los tokens de Meta. Importa `src/lib/sync/runner.ts`, así que **se redespliega junto con la app** |
| Respaldo de la cola | `.github/workflows/sync-fallback.yml`     | GitHub Actions, minutos :07 y :37                                                    | Drena la cola si el worker cae, refresca tokens de Hotmart y abre una issue si el pipeline está parado                                                                                          |
| Gateway de WhatsApp | `whatsapp-gateway/` (Baileys)             | Opcional; la alternativa es Evolution API (`WHATSAPP_PROVIDER`)                      | Envía alertas y recibe los mensajes que atiende el agente                                                                                                                                       |
| Plugin de WordPress | `wordpress-plugin/report-utm/` (v0.5.0)   | En los sitios de los clientes                                                        | Envía leads por S2S a `/api/report-utm/pixel/s2s`, con reintento y `external_id`                                                                                                                |
| Píxel JS            | `public/report-utm-pixel.js`              | En las landings                                                                      | Envía eventos a `/api/report-utm/pixel/event`                                                                                                                                                   |
| Base de datos       | `migrations/`                             | Supabase, proyecto `dfdeizrbkpdocgckqlel` («REPORTING APP»), plan Pro, cómputo Micro | Postgres + Auth + Storage                                                                                                                                                                       |

> **Vercel ya no se usa.** Mucha documentación y muchos comentarios todavía lo mencionan (límite de 60 s, `maxDuration`, `vercel.json`). Todo eso es histórico. Ver el apartado 10.

### Flujo de datos

1. El **worker** encola y ejecuta los jobs (`src/lib/sync/planner.ts`, `runner.ts`, `queue.ts`). Cada job llama a un endpoint de la app (`/api/worker`, `/api/worker/hotmart`, `/api/worker/google-sheets-conversiones`, `/api/cron/sync-ghl-leads`…). La lógica de sincronización vive **solo en la app**; el worker la importa.
2. Las métricas diarias aterrizan en `public.metricas_diarias`: una fila por cliente y día, con desgloses JSONB (`meta_campaigns`, `meta_ads`…). También van a `public.ads_daily`, la versión en filas, desde 2026-01-01.
3. Los **leads** entran en tiempo real por webhooks (Meta Lead Ads, GoHighLevel, S2S de WordPress) hacia `report_utm.lead_events`, con sincronizaciones de respaldo. Los formularios de TikTok entran por el job `tiktok_leads`.
4. Las **ventas** de Hotmart se guardan en `public.hotmart_ventas`, convertidas a la moneda de reporte con `public.fx_rates`. Las ventas de GoHighLevel van a `report_utm.sales_events`.
5. Dos motores de lectura:
   - **Dashboard** (`src/app/(app)/dashboard`): layouts + motor de fórmulas propio (`src/lib/formula-engine.ts`, sin `eval`).
   - **Informes BI** (`src/lib/report-utm/bi-*`, `src/lib/report-utm/bi/sources/*`): widgets configurables con enlace público. `bi-metadata.ts` es el catálogo de métricas.
6. **Cruce lead ↔ campaña:** `src/lib/report-utm/campaign-resolver.ts`. Primero por ID (`utm_id`, `adset_id`, `ad_id`) y después por nombre, solo dentro de la plataforma de `utm_source`. Un nombre repetido da «ambiguo». Detalle en [doc 25](./25-auditoria-cruce-canales.md).

### Zona horaria por cliente (activada el 2026-09-28)

Los días de leads y ventas se cortan en la zona del cliente, la de su cuenta de Meta. Eduversio está en `America/Bogota`; los otros cinco clientes, en `America/Santiago`.

- **Orden de precedencia:** `config_api.zona_horaria` → zona de la cuenta de Meta → TikTok → Bogotá (`src/lib/zona-horaria.ts`).
- **Mecánica:** `src/lib/zona-activa.ts` guarda la zona en un `AsyncLocalStorage`. Los helpers de `colombia-date.ts` la usan si hay contexto, y las RPC por día reciben `p_zona` (migración 095).
- **Fuera del contexto de un cliente** (worker, planificador, navegador), todo sigue en Colombia.
- **Código nuevo** que corte días de un cliente debe correr dentro de `conZonaDeCliente`.
- `colombia-date.ts` **no puede importar nada**: lo compila el sync-worker.

### Dos esquemas: `public` y `report_utm`

Es la mayor fuente de confusión del proyecto:

- `public.clientes` es la **fuente de verdad** del cliente.
- `report_utm.clientes` es su **espejo**, enlazado por `public_cliente_id`. Se crea, archiva y borra con él desde `src/lib/clientes/ciclo-de-vida.ts`. **No crees ni borres clientes por otra vía.**
- `report_utm.lead_events` usa el id de `report_utm.clientes`, **no** el de `public.clientes`. Cruzar mal esos ids da ceros en silencio.
- El módulo Report-UTM se absorbió en la app principal («Reporting absorbe Report-UTM», desplegado el 2026-09-28). Las URLs viejas `/report-utm/*` redirigen (`next.config.ts`).

### Mapa de carpetas que importa

| Carpeta                             | Contenido                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(app)/`                    | UI autenticada: `dashboard`, `informes`, `leads`, `ventas`, `cruce-campanas`, `notificaciones`, `soporte`, `admin/{settings,sync,salud,agente,configuracion,layouts}` |
| `src/app/api/`                      | ~80 endpoints: `worker/*`, `cron/*`, `report-utm/*` (BI, webhooks, píxel, leads), `agent/*`, `mcp`, `v1/*` (API pública con token), `auth/*` (OAuth)                  |
| `src/app/p/`, `src/app/report/`     | Enlaces públicos (dashboard espejo, informes BI)                                                                                                                      |
| `src/lib/sync/`                     | Cola, planner, runner, reconciliación                                                                                                                                 |
| `src/lib/hotmart/`                  | Cliente API, parser, clasificador, guarda anti-ceros, reagregado, atribución                                                                                          |
| `src/lib/report-utm/`               | Leads, atribución, cruce de campañas, BI, campos de lead, exclusión, GHL, Meta Leads, TikTok Leads, alcance de campañas                                               |
| `src/lib/meta/`                     | Estado de las cuentas, alertas, conversiones personalizadas                                                                                                           |
| `src/lib/integrations/`             | Google Sheets, GA4 (`ga4-cliente.ts` con `probarAccesoGa4`), OAuth de Google                                                                                          |
| `src/lib/leads/`                    | Vocabulario de respuestas de formulario (`respuestas/claves.ts`), fuentes de lead                                                                                     |
| `src/lib/agent/`                    | Agente: registro de herramientas, LLM (OpenRouter), aprobaciones, WhatsApp                                                                                            |
| `src/lib/clientes/ciclo-de-vida.ts` | Crear, archivar y borrar clientes. Es el único camino permitido                                                                                                       |
| `scripts/`                          | ~115 scripts: tests `verify-*`, backfills, diagnósticos, `auditoria-cruce.ts` y `sql-remoto.ts`                                                                       |
| `migrations/`                       | 099 archivos SQL, del 001 al 097                                                                                                                                      |
| `docs/`                             | Documentación temática (índice en `docs/README.md`)                                                                                                                   |
| `skills/`, `.claude/skills/`        | Skill «informes-bi» para usar el MCP desde Claude                                                                                                                     |

---

## 3 · Estado de Git y despliegue (crítico)

| Ref                                | Commit                                           | Qué significa                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/main`                      | `177ca62` («Merge pull request #10», 2026-09-28) | En producción. Verificado: el plan diario de las 14:00 ya encoló los tipos nuevos (`ghl_leads`, `ghl_oportunidades`, `tiktok_leads`, `hotmart_reconciliar`) |
| `origin/unificacion-reporting-utm` | `52104c3` («auditoría Google G4a»)               | Subido a GitHub. **2 commits por delante de `main`**: `e60154a` conversiones personalizadas y `52104c3` GA4                                                 |
| `main` (local)                     | `bbf0005`                                        | Desactualizada: haz `git pull` en `main` antes de trabajar                                                                                                  |

**Qué ya está en producción** (PR #10):

- Unificación de Report-UTM dentro de Reporting (rutas nuevas y redirecciones).
- Servidor MCP y skills de informes BI.
- Moneda de reporte automática según la cuenta de Meta: Eduversio pasa a COP; Expo Renta Corta, Invest Brokers, Somos rentable y Sur Profundo, a CLP.
- Hotmart con todos los estados, reconciliación diaria y atribución por lead.
- Respuestas de formulario como métricas (pestaña «Leads»), búsqueda y filtros de leads, detección de duplicados.
- Historial para deshacer las ediciones del agente en los informes.
- El dashboard ya no recorta las filas al «rango de captación» de la pestaña.
- Auditoría del cruce por canal ([doc 25](./25-auditoria-cruce-canales.md)):
  - zona horaria por cliente;
  - alcance de campañas de la cuenta compartida;
  - cruce por plataforma y por ID;
  - formularios de TikTok y sync de oportunidades de GHL;
  - arreglo del plan diario;
  - pérdidas silenciosas de datos corregidas.

**Qué falta por fusionar y desplegar:**

- **Conversiones personalizadas de Meta** (`src/lib/meta/conversiones-personalizadas.ts`, migración 096 ya aplicada). Solo llegan en el array `actions` de Meta, que antes no se leía. Tras desplegar, ejecutar de madrugada `scripts/backfill-conversiones-meta.ts --ejecutar`. Hoy solo afecta a Eduversio, y **sus cifras publicadas cambiarán**.
- **GA4 por campaña** ([doc 26](./26-auditoria-ga4.md)): fuente nueva `ga4`, job `ga4`, `/api/worker/ga4` y migración 097 ya aplicada. Incluye un arreglo de seguridad del OAuth de Google. Hasta desplegar, el job `ga4` no existe en producción.

**Qué hacer:**

1. Abrir un PR `unificacion-reporting-utm` → `main` y pasar `npm run validate`, `npm run test:puro` y `npm run test:datos`.
2. Fusionar y redesplegar **la app y el `sync-worker`**.
3. Ejecutar el backfill de conversiones de Eduversio y avisar al cliente.

Hay además una rama local `claude/jovial-hopper-116a3d` y 5 ramas de Dependabot en remoto: revisarlas o borrarlas.

### Cómo se despliega

Todo está en [doc 15](./15-despliegue.md). Lo que más se olvida:

- Las `NEXT_PUBLIC_*` van **también en Build Args**: se incrustan en el bundle. Cambiar el dominio obliga a reconstruir.
- El worker necesita el **mismo `CRON_SECRET`**, carácter a carácter, que la app y que el secret de GitHub.
- **El worker se redespliega con la app** cuando cambia `src/lib/sync/` o el planificador.
- `next build` necesita ~2 GB de RAM.
- Si añades un import relativo fuera de `src/lib/sync` que use el worker, hay que añadirlo también a `sync-worker/Dockerfile`.
- **Nunca rotes `RUTM_ENCRYPTION_KEY`** sin migrar antes los secretos. Dejaría ilegibles todos los tokens guardados (Hotmart, GHL, integraciones).

---

## 4 · Base de datos: con qué tener cuidado

### 4.1 La instancia está al límite

- Plan Pro, pero **sin add-on de cómputo**: Micro, con 1 GB de RAM, 2 núcleos compartidos y 60 conexiones.
- La base pesa **577 MB** y `shared_buffers` es de 224 MB, así que el conjunto de trabajo no cabe en memoria. El _hit ratio_ medido es del 45–54 %.
- **Caída del 2026-09-20/21.** La instancia se quedó sin memoria, PostgREST devolvió 503 en toda la Data API y cayeron también Auth y Storage. Se recuperó con un reinicio.
- **La causa es la RAM, no las consultas.** Una consulta que tarda 1 s en frío tarda 4 ms en caliente, con el mismo plan. Antes de optimizar una consulta «lenta», ejecútala 3–4 veces y quédate con la última medición.

**Recomendación nº 1 del proyecto:** subir a cómputo Small o Medium. Resuelve de raíz los timeouts intermitentes, los tests de datos que fallan a veces y el riesgo de otra caída. Es más urgente ahora que GA4 añade backfills por tramos.

Tablas más pesadas:

| Tabla                         | Tamaño | Nota                                                            |
| ----------------------------- | ------ | --------------------------------------------------------------- |
| `report_utm.lead_events`      | 250 MB | 99.400 filas, ~1.000 leads/día                                  |
| `report_utm.pixel_events`     | 123 MB | Crecerá mucho: el píxel ya envía pageviews. Se purga a 90 días  |
| `public.ads_daily`            | 79 MB  | Desde 2026-01-01. Tiene **huecos**, ver 4.5                     |
| `public.conversiones_offline` | 31 MB  | Filas de Google Sheets                                          |
| `public.sheet_filas`          | 30 MB  |                                                                 |
| `public.metricas_diarias`     | 24 MB  | Poco heap, mucho TOAST (JSONB). Leerla con los JSONB es lo caro |

### 4.2 Estado de las migraciones

- **No hay registro de migraciones aplicadas.** No se usa el sistema de migraciones del CLI de Supabase. Se aplican a mano con `npx tsx scripts/sql-remoto.ts <archivo.sql>` (Management API, necesita `SUPABASE_ACCESS_TOKEN`) o desde el editor SQL.
- **Hay números repetidos:** 007, 009, 021, 030, 035 y 078.
- `schema.sql` es el esquema **inicial** y está desactualizado. La verdad es la base de producción.

Estado verificado en producción al final del 2026-09-28:

| Migración                                                      | Estado                                                                             | Qué hacer                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 001–084, 086–097                                               | Aplicadas                                                                          | —                                                                                                                                            |
| 082 · IDs publicitarios en leads                               | Aplicada y con backfill hecho (721 leads: 719 de Invest Brokers, 2 de Cris)        | —                                                                                                                                            |
| 094 · cruce por plataforma e IDs · 095 · zona por cliente      | Aplicadas; zonas de Meta capturadas y `fecha_venta` de Hotmart recalculada         | —                                                                                                                                            |
| 096 · catálogo de conversiones de Meta · 097 · GA4 por campaña | Aplicadas                                                                          | El código que las usa está en los 2 commits sin fusionar                                                                                     |
| **085** `autovacuum_tablas_de_evento`                          | **SIN aplicar** (`reloptions` de `lead_events` vacío)                              | Aplicarla. Es segura (solo parámetros de almacenamiento, sin bloqueos) y evita que las consultas de leads vuelvan a degradarse               |
| Backfill de la **084**                                         | **Nunca ejecutado**: 87.332 de 99.400 filas conservan las UTM dentro de `page_url` | `npx tsx scripts/backfill-page-url.ts`. Va por lotes de 2.000 **a propósito**: un UPDATE masivo es justo lo que tumbó la base. Libera ~40 MB |
| Claves de respuestas (090)                                     | 7 de 10 `lead_campos` tienen `respuestas`                                          | `npx tsx scripts/migrar-respuestas-lead.ts` en seco y luego `--aplicar` para congelar las que faltan                                         |
| Backfill de conversiones personalizadas                        | Pendiente de desplegar el código                                                   | `scripts/backfill-conversiones-meta.ts --ejecutar`, de madrugada                                                                             |

### 4.3 Reglas al escribir migraciones

1. **Pregunta antes de aplicar nada en producción.** Hasta ahora las migraciones las aplicaba el dueño del proyecto, después de revisarlas.
2. **`CREATE INDEX` normal bloquea las inserciones de leads.** El rol `authenticator` tiene `lock_timeout = 8s`: los INSERT fallan en vez de esperar, y **un lead perdido no vuelve**. Usa `CREATE INDEX CONCURRENTLY` como sentencia suelta con `sql-remoto.ts --query="…"` (un archivo se manda como una transacción, y `CONCURRENTLY` no puede ir dentro de una). Comprueba después `indisvalid`. Ver las migraciones 086 y 088.
3. **Añadir un parámetro a una función crea una sobrecarga, no la reemplaza.** Las llamadas con la firma vieja pasan a dar `42725 function is not unique`. Hay que hacer `DROP FUNCTION` con la firma exacta, recrearla, volver a dar los `GRANT` y ejecutar `NOTIFY pgrst, 'reload schema'`, todo en el mismo archivo.
4. **Al reescribir una función, compárala línea a línea contra la original.** Copiando a mano la 079 se perdieron una guarda y una lista blanca de columnas; lo cazó un test, no la revisión.
5. **El código debe funcionar antes y después de la migración.** Un despliegue sin su migración ya dejó dos días de Sheets escribiendo cero filas (la 069, en agosto).
6. **Toda tabla nueva con `cliente_id` lleva FK `ON DELETE CASCADE`.** `scripts/verify-borrado-cascada.ts` falla si no.
7. **Nada de UPDATE/DELETE masivos de una vez.** Siempre por lotes.
8. **Un tipo de job nuevo necesita su `CHECK`.** Si se añade a `SyncJobTipo` sin ampliar `sync_jobs_tipo_check`, el INSERT falla. Hasta el 2026-09-28 eso abortaba el plan diario entero en silencio: nunca se encoló un `ghl_leads` y la reconciliación de Hotmart solo corría los domingos. Verifícalo con `pg_get_constraintdef`.

### 4.4 Límites y timeouts

- **PostgREST corta cada consulta a los 8 s** (`statement_timeout`). Para leer muchas filas usa los helpers de paginación (`src/lib/supabase-paginate.ts`).
- Muchos lugares hacen `res.data || []`, y un timeout se convierte en **una lista vacía sin error**: un desplegable sin opciones, un informe en cero. Ante un «vacío raro», sospecha primero de un timeout (`motivo: error_consulta`). Los widgets del BI ya avisan cuando una lectura quedó incompleta.
- **Tras un reinicio o restauración de la base**, las estadísticas se resetean y autovacuum deja de visitar las tablas grandes. Ejecuta `VACUUM (ANALYZE)` sobre `report_utm.lead_events`, `report_utm.pixel_events`, `public.ads_daily` y `public.metricas_diarias`. VACUUM simple es seguro en caliente; **VACUUM FULL no**.
- **Si la Data API devuelve 503 en masa:** para primero el `sync-worker` (Dokploy → Stop) y pausa el workflow `sync-fallback`. Reintentan sin backoff y realimentan la caída. **No lo dejes parado más de un día**: es el único que refresca los tokens de Meta (02:00, hora Colombia). El estado real se comprueba en `/v1/projects/{ref}/health`; el panel puede decir `ACTIVE_HEALTHY` estando caído.

### 4.5 Trampas de datos conocidas

- **`ads_daily` tiene huecos por dentro de su rango.** `adsDailySinHuecos` (`src/lib/report-utm/bi-query.ts`) cae al JSONB de `metricas_diarias` si falta algún día con gasto. Para comparar las dos fuentes, fija `BI_ADS_SOURCE=jsonb`. Las conversiones personalizadas también fuerzan el camino JSONB.
- **El embed `cliente_tabs → clientes` es ambiguo.** Nombra siempre la FK (`clientes!cliente_tabs_cliente_id_fkey`) o PostgREST devuelve 300.
- **Los vacíos de `lead_events` son `NULL`**, nunca cadena vacía.
- **Los leads ya no escriben en `pixel_events`** ni pasan por `resolveAttribution`, porque `visitor_id` está vacío en el 100 % de las filas. El resolver sigue activo para ventas. Su cabecera explica qué habría que hacer para reactivarlo en leads.
- **`page_url` se guarda sin los parámetros UTM** (`normalizarPageUrl`), pero conserva a propósito los parámetros propios del cliente.
- **Los meses cerrados están congelados** (`periodos_cerrados`, día 7 de cada mes): el worker no los reescribe. Para reabrir un mes, borra su fila.
- **Zona horaria:** ver el apartado 2. Leads y ventas van en el día del cliente, y el worker y el planificador en día de Colombia.
- **GA4 tiene dos familias que no se suman:** `ga_*` es el GA4 del sitio, en `metricas_diarias`; `ga4_*` es por campaña, en `ga4_sesiones_diarias` y `ga4_eventos_clave_diarios`.

### 4.6 Borrado de clientes

Borrar un cliente borra **todo lo suyo** en los dos esquemas. Es una decisión explícita del 2026-09-14. Siempre pasa por `eliminarClienteCompleto`. Archivar es la vía para ocultar sin perder datos. Borrar un usuario dueño de clientes está **bloqueado** (FK `RESTRICT`, migración 081). Ver [doc 23](./23-runbook-empalme.md).

---

## 5 · Integraciones

| Integración       | Autenticación                                                                   | Frecuencia                                            | Código                                                                   | Nota                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Meta Ads          | OAuth (`META_APP_ID/SECRET`)                                                    | 05:00 y 14:00; reconciliación los domingos            | `/api/worker`, `src/lib/sync/reconcile.ts`                               | Tokens de ~60 días que refresca el worker. Atribución fija `7d_click + 1d_view`. Multicuenta: todas o ninguna |
| Meta Lead Ads     | Webhook (`META_WEBHOOK_VERIFY_TOKEN`) + sync de respaldo                        | Tiempo real                                           | `/api/report-utm/webhooks/meta`, `src/lib/report-utm/meta-leads.ts`      | Redescubre formularios a diario; el cron reintenta también las integraciones en `error`                       |
| TikTok Ads        | OAuth                                                                           | Diaria                                                | `/api/worker`                                                            | Moneda y zona en `config_api.tiktok_cuentas_info`                                                             |
| TikTok Lead Forms | OAuth                                                                           | Job `tiktok_leads`                                    | `src/lib/report-utm/tiktok-leads.ts`                                     | Se activa con `tiktok_leads: true` en la cuenta de `tiktok_accounts`                                          |
| Google Sheets     | Service account (`GOOGLE_SERVICE_ACCOUNT_*`)                                    | Diaria, un job por cliente                            | `src/lib/integrations/`                                                  | La clave PEM va con `\n` escapados; si no, da `invalid_grant`                                                 |
| GA4               | Service account o OAuth de la agencia                                           | Diaria; por campaña con el job `ga4` (tras desplegar) | `src/lib/integrations/ga4-cliente.ts`                                    | Ver abajo                                                                                                     |
| Google Ads        | OAuth + developer token                                                         | —                                                     | `src/lib/report-utm/google-conversions.ts`                               | Conversiones offline                                                                                          |
| Hotmart           | OAuth HotConnect (tokens de vida corta, refresco cada 2 h) + webhook con hottok | Diaria + reconciliación diaria                        | `src/lib/hotmart/`, `/api/worker/hotmart`                                | Ver abajo                                                                                                     |
| GoHighLevel       | Token por location                                                              | Webhook + sync de leads y de oportunidades            | `src/lib/report-utm/ghl-*.ts`, [doc 20](./20-integracion-gohighlevel.md) | La venta hereda la atribución del último lead del contacto. Una oportunidad perdida revierte la venta         |
| WhatsApp          | Evolution API o `whatsapp-gateway`                                              | Alertas y agente                                      | `src/lib/whatsapp/`                                                      | Mensajes entrantes firmados con HMAC (`AGENT_INBOUND_SECRET`)                                                 |
| LLM del agente    | **OpenRouter** (`OPENROUTER_API_KEY`)                                           | Bajo demanda                                          | `src/lib/agent/llm/client.ts`                                            | 3 niveles de modelo con cadena de reserva, configurables desde la base sin desplegar                          |
| MCP               | Token de API                                                                    | Bajo demanda                                          | `/api/mcp`                                                               | El staff lo usa desde Claude sin coste de API                                                                 |
| FX                | API pública (fawazahmed0)                                                       | Captura diaria                                        | `src/lib/fx.ts`                                                          | Tabla `fx_rates`                                                                                              |
| Correo            | Gmail con contraseña de aplicación                                              | —                                                     | `src/lib/email.ts`                                                       |                                                                                                               |

**Meta: conversiones personalizadas.** Las reglas de Events Manager (`offsite_conversion.custom.<id>`) llegan **solo en `actions`**, nunca en `conversions`. Antes del 2026-09-28 no se guardó ninguna, y Eduversio perdía unas 4.100 en 30 días. `resultados_custom` es `null`, no 0, si el cliente no marcó ninguna conversión como resultado.

**GA4: «en 0» casi nunca es falta de tráfico, es falta de acceso.**

- Cris llevaba 636 días con 0 sesiones porque tenía un ID de propiedad que la cuenta de la agencia no ve. El error solo iba a un log. Se corrigió a `524635063` y se hizo el backfill.
- Ante un GA4 vacío, usa «Probar conexión» o `probarAccesoGa4` antes de tocar código.
- La cuenta de la agencia solo ve 4 propiedades. La de Sur Profundo («Eventos SP Group») **no se asignó a propósito**.
- El hueco de junio de 2026 en el GA4 de Cris es del tag, no del sync.
- Detalle en [doc 26](./26-auditoria-ga4.md).

**Hotmart. Hechos verificados que no se deducen del código:**

- `sales/history` **sin lista de estados devuelve solo `COMPLETE`**. `ESTADOS_API_SYNC` debe quedarse. Un estado inválido tumba la petición entera (el correcto es `PRINTED_BILLET`, no `BILLET_PRINTED`).
- La API filtra por fecha de **orden**, no de aprobación. Por eso existe la reconciliación diaria, que desde el 2026-09-28 se encola de verdad cada día.
- **El webhook de Hotmart no se configuró nunca** en ningún cliente.
- **Septiembre de 2026 sin ventas en Cris es real**, no un fallo.
- Las 88 ventas antiguas no tienen la tupla UTM. Para rellenarla: `npm run backfill:hotmart` sobre julio y agosto.
- Una venta se atribuye al **último lead antes de la venta**. Una macro sin rellenar no cuenta como tracking.

**Moneda.** Cris reporta en CLP. Hay **10 tasas CLP antiguas mal fechadas que se dejan así a propósito**: corregirlas descuadraría las ventas ya guardadas. Antes de activar otra moneda en un cliente, rellena `fx_rates` con `scripts/backfill-fx-historico.ts`. El gasto no se convierte: cada informe avisa si una cuenta gasta en otra moneda.

**El agente no puede usar una suscripción de Claude.** Lo prohíben los términos de Anthropic. El coste de API irreducible es el de WhatsApp.

---

## 6 · Operación diaria

- **Pantallas de diagnóstico:** `/admin/salud`, `/admin/sync` y `/cruce-campanas`. Por consola: `npm run diagnostico` y `npx tsx --conditions=react-server scripts/auditoria-cruce.ts`. `/admin/salud` avisa también si dos clientes comparten cuenta sin alcance.
- **¿El worker está vivo?** Ejecuta `select ejecutor, count(*), max(started_at) from sync_runs where started_at > now() - interval '1 hour' group by 1;`. Debe aparecer `vps`.
- **Horarios del worker** (hora Colombia): 05:00 y 14:00 plan diario (métricas, Sheets, Meta Leads, GHL leads y oportunidades, TikTok Leads, reconciliación de Hotmart) · 02:00 tokens de Meta · cada 2 h tokens de Hotmart · domingo 03:00 reconciliación · día 7, 03:00 cierre de mes.
- **Runbook de incidencias:** [doc 23](./23-runbook-empalme.md). Cubre informes vacíos, leads excluidos, sync caída, cuenta de Meta parada y ventas del CRM.
- **Operaciones con `curl`:** [doc 14](./14-cron-y-workers.md), al final (encolar un plan, resincronizar un rango, cerrar un mes).

---

## 7 · Pruebas y calidad

- **No hay Jest ni Vitest.** Las pruebas son scripts `scripts/verify-*.ts` que se ejecutan con `npx tsx --conditions=react-server …`. Sin ese flag, `server-only` revienta (también en los `execSync` anidados).
- `npm run test:puro`: ~55 verificaciones sin base de datos (reglas, parsers, seguridad, agente, MCP, `verify-zona-cliente`, `verify-conversiones-meta`, `verify-ga4-desglose`, `verify-cruce-por-id`…).
- `npm run test:datos`: verificaciones **contra la base de PRODUCCIÓN, en solo lectura**.
  - Incluye `verify-paridad-superficies`: el mismo gasto y los mismos leads en BI, dashboard y API.
  - Incluye el **golden** (`scripts/verify-bi-golden.ts` contra `scripts/golden/bi-baseline.json`), que congela cifras de informes reales.
  - Si falla con `statement timeout` o `[paginate] página fallida`, es transitorio (instancia Micro): relánzalo.
  - **Nunca recaptures el golden entero** sin revisar el log.
  - Los ingresos de Hotmart de Cris ×~920 son la conversión a CLP, no un error.
- `npm run validate`: type-check + ESLint (0 warnings) + Prettier. Es lo único que corre en el CI (`.github/workflows/validate.yml`).
- Un `next build` que falla con timeouts de 60 s en páginas estáticas que no has tocado suele ser la caché fría: relánzalo antes de culpar a tu cambio.

---

## 8 · Decisiones de producto que NO hay que «arreglar»

| Parece un bug                                                                   | Por qué es así                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Somos rentable» y «Sur Profundo» leen el mismo Sheet y la misma cuenta de Meta | Es a propósito. Desde el 2026-09-28 el BI recorta el gasto de cada uno con `config_api.alcance_campanas`: Somos `somos rentable, [lsr]`; Sur Profundo, el resto. Una campaña que no siga esa convención cae en Sur Profundo |
| Los leads de Meta ≠ los contactos recibidos                                     | Son dos métricas distintas (atribuidos por Meta frente a `lead_events`) con rótulos propios (`src/lib/leads/fuentes-de-lead.ts`). No cuadran día a día                                                                      |
| La pestaña del dashboard ya no se recorta a su «rango de captación»             | Decisión del 2026-09-28: manda el calendario. La ventana solo alimenta presupuesto y ritmo (`scripts/verify-rango-captacion.ts`)                                                                                            |
| Filtrar o agrupar por una respuesta de formulario deja el gasto en «—»          | Es correcto: el gasto no se reparte por respuestas. Medir con la respuesta como métrica (`lf__…`) sí permite CPL. Ver [doc 24](./24-respuestas-de-formulario.md)                                                            |
| Muchas métricas pasaron de «0» a «—»                                            | Una métrica sin fuente conectada (ROAS sin Hotmart, `ga_*` sin GA4, `tiktok_*` sin TikTok) o sin reparto posible sale «—». Un 0 significaría «medido y es cero»                                                             |
| Un lead sale «ambiguo»                                                          | Dos campañas con el mismo nombre no se reparten por gasto: decisión del dueño. El ID o el anuncio pueden desempatar                                                                                                         |
| Cambió la frecuencia de Meta, el rebote de GA4 o los % de Sheets en un rango    | Ahora se calculan desde sus bases (impresiones ÷ alcance, medias ponderadas). Antes se sumaban día a día, que era incorrecto                                                                                                |
| Hay menos leads de los recibidos                                                | La regla «Qué leads cuentan» excluye los que no tienen atribución. Están en `/leads` → Excluidos                                                                                                                            |
| `/p/<token>` no se puede embeber en un iframe                                   | La regla catch-all de `next.config.ts` gana a las de `/p/` y `/report/`. Se dejó así por seguridad (clickjacking); cambiarlo es decisión de producto                                                                        |
| Los grupos de campaña siempre salen vacíos                                      | Las tablas existen (077), pero **no hay ni UI ni código de escritura**. Si se piden grupos, hay que construir la escritura entera                                                                                           |
| Goodprop desconectado, Eduversio sin campos de lead                             | Intencional (sus formularios solo piden nombre y correo)                                                                                                                                                                    |

---

## 9 · Deuda técnica

| Área                                  | Problema                                                                                                                                                                                                                                                             | Sugerencia                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Seguridad OAuth**                   | El OAuth de Google se corrigió el 2026-09-28 (el `state` era fijo y no se validaba). **Meta y TikTok siguen con el mismo `state` sin firmar**                                                                                                                        | Firmar y validar el `state` como en Google. Prioridad alta                                                                         |
| Componentes gigantes                  | `LayoutConfigModal.tsx` (3.145 líneas), `DashboardClient.tsx` (2.920), `MetricCharts.tsx` (1.214), `QuickEditModal.tsx` (966), `TabConfigModal.tsx` (945). En `src/lib`: `bi-metadata.ts` (>2.100), `google-sheets-conversiones.ts` (>2.000), `bi-query.ts` (>1.700) | Trocear al tocar cada zona, sin gran refactor de golpe                                                                             |
| Dos motores de métricas               | El dashboard (`formula-engine` + `metric-catalog`) y el BI (`bi-metadata` + `bi/sources`) calculan lo mismo por caminos distintos. El dueño decidió alinearlos con tests de paridad (`verify-paridad-superficies`) y no con un motor único                           | Mantener los tests de paridad en verde con cada cambio de métrica                                                                  |
| Fallos silenciosos                    | El patrón `res.data \|\| []` convierte errores y timeouts en vacíos. El BI ya avisa en sus widgets; el dashboard todavía no                                                                                                                                          | Registrar el error y mostrar «no se pudo cargar» también en el dashboard                                                           |
| Pruebas                               | Scripts ad hoc; `test:datos` depende de producción                                                                                                                                                                                                                   | Base de staging o rama de Supabase con datos anonimizados; runner estándar                                                         |
| Migraciones                           | Sin registro de aplicadas y con números duplicados                                                                                                                                                                                                                   | Adoptar `supabase migration` o una tabla `schema_migrations` propia                                                                |
| Observabilidad                        | Solo logs JSON, `sync_runs` y `ga4_estado.ultimo_error`; sin Sentry ni alertas de la base                                                                                                                                                                            | Sentry + alerta de salud de Supabase + uptime de `/api/health`                                                                     |
| Atribución web                        | `visitor_id` vacío: la cascada multi-touch no funciona para leads                                                                                                                                                                                                    | Poblar `visitor_id` desde el píxel antes de reenchufar `resolveAttribution`                                                        |
| Formularios de TikTok                 | Sus preguntas no se guardan en `lead_preguntas` (el `CHECK` de `fuente` no admite `tiktok`); las respuestas sí están en `raw_fields`                                                                                                                                 | Ampliar el `CHECK` si se quieren como preguntas                                                                                    |
| Rebote de GA4 en el dashboard clásico | Va en fracción 0–1 con sufijo «%». Cambiarlo altera fórmulas guardadas                                                                                                                                                                                               | Decisión del dueño; la métrica nueva `ga4_tasa_rebote` ya va en 0–100                                                              |
| Dependencias                          | 5 PR de Dependabot abiertas (recharts 3, react-day-picker 10, lucide 1.x: son versiones mayores)                                                                                                                                                                     | Revisar una por una. **Next 16.3 cambia APIs**: lee `node_modules/next/dist/docs/` antes de tocar código de Next (ver `AGENTS.md`) |
| Tipos                                 | `@types/node` 20 con motor 22                                                                                                                                                                                                                                        | Subir a `@types/node` 22                                                                                                           |

---

## 10 · Documentación desactualizada

La carpeta `docs/` es buena y detallada, pero tiene restos de la época de Vercel y del estado anterior al 2026-09-28:

- `docs/02-arquitectura.md`: dice «Deploy: Vercel», «migraciones 001…020» y «van por la 081»; menciona el route group `(report-utm)`, que ya no existe.
- `docs/14-cron-y-workers.md`: dice que la zona por cliente «no está activada». Ya lo está. También le faltan los jobs nuevos en la lista de tipos (`ghl_oportunidades`, `tiktok_leads`, `ga4`).
- `docs/15-despliegue.md`: dice que «no hay suite de tests» (sí la hay) y que `/p/*` y `/report/*` son embebibles (no lo son, ver apartado 8).
- `sync-worker/README.md`: «La app está en Vercel plan Hobby»; faltan los horarios de tokens y reconciliación.
- `.github/workflows/validate.yml`: **Node 20**, cuando debe ser `22.12` o superior.
- `.env.example`: el comentario «Activa el módulo report-utm» no tiene variable debajo (restos).
- Comentarios de `maxDuration` y del límite de 60 s: inertes en Docker.

Están al día y conviene leerlas: [doc 25](./25-auditoria-cruce-canales.md) (cruce por canal) y [doc 26](./26-auditoria-ga4.md) (GA4), las dos del 2026-09-28.

---

## 11 · Plan recomendado para las dos primeras semanas

**Día 1 (sin tocar código)**

1. Recibir todos los accesos del apartado 12 y comprobar que funcionan.
2. Levantar el entorno local: Node ≥ 22.12, `git pull` en `main` y en la rama, `.env.local` a partir de `.env.example`, `npm run dev`. Pasar `npm run validate` y `npm run test:puro`.
3. Leer los docs 23, 25 y 26.

**Semana 1 · estabilizar y terminar el despliegue**

4. Subir el cómputo de Supabase (Small o Medium). Pide aprobación del gasto al dueño.
5. Fusionar los 2 commits pendientes (conversiones de Meta y GA4). Redesplegar app y `sync-worker`. Comprobar que aparece el job `ga4` en `sync_jobs`.
6. Ejecutar de madrugada `backfill-conversiones-meta.ts --ejecutar` y avisar a Eduversio.
7. Aplicar la **085** (segura) y ejecutar el backfill de la **084** fuera de horas punta.
8. Cambiar el CI a Node 22.
9. **Firmar el `state` del OAuth de Meta y TikTok.**

**Semana 2 · tareas operativas (fuera del código)**

10. **Avisar a los clientes** de las cifras que cambian ([doc 25 §4](./25-auditoria-cruce-canales.md) y [doc 26](./26-auditoria-ga4.md)): días en zona de Chile, «0» → «—», frecuencia y medias ponderadas, gasto recortado de Somos rentable y Sur Profundo, moneda.
11. **Plantilla de URL con IDs** en los anuncios activos. Es la mejora de precisión más grande pendiente:
    - Meta: `…&utm_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`
    - TikTok: `…&utm_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__`
12. **Webhook de Hotmart** en cada cliente que venda por Hotmart: URL de la tarjeta del cliente + hottok + `sck={{ad.id}}` en los checkouts.
13. **GoHighLevel:** dar al token el alcance `opportunities.readonly` y crear el Workflow «Opportunity Status Changed».
14. **Eduversio:** reconectar Meta con permiso de Páginas o desactivar su Meta Lead Ads (en `error` desde el 2026-06-22; sus leads entran por S2S).
15. **GA4 de otros clientes:** dar a la cuenta de la agencia acceso de Lector a sus propiedades y elegirlas en el selector.
16. `migrar-respuestas-lead.ts --aplicar`, monitorización (uptime de `/api/health`, alertas de Supabase, Sentry) y actualizar la documentación del apartado 10.
17. Decidir con el dueño: embebido de `/p/`, grupos de campaña, unidades del rebote.

---

## 12 · Accesos y secretos a traspasar

Checklist. Pasadlos por un gestor de contraseñas, **nunca** por chat ni por el repositorio.

- [ ] **GitHub**: repositorio (admin) y secret `CRON_SECRET` de Actions.
- [ ] **Supabase**: organización y proyecto `dfdeizrbkpdocgckqlel` (facturación incluida), `SUPABASE_ACCESS_TOKEN` personal para `sql-remoto.ts`.
- [ ] **VPS + Dokploy**: acceso al panel y SSH; las dos Applications (app y worker) con sus variables.
- [ ] **Dominio y DNS** de `reportes.adshouse.cloud`.
- [ ] **Meta for Developers**: app, `META_APP_SECRET`, token de verificación del webhook.
- [ ] **TikTok for Business**: app (incluidos los permisos de formularios de leads).
- [ ] **Google Cloud**: service account (Sheets/GA4), cliente OAuth, developer token de Google Ads y la cuenta `cuentas@adshouseagencia.com` que ve las propiedades de GA4.
- [ ] **Hotmart**: app de HotConnect y el hottok de cada cliente.
- [ ] **OpenRouter**: cuenta y API key (con límite de gasto).
- [ ] **WhatsApp**: Evolution API o el gateway, más el número y el grupo del equipo.
- [ ] **Gmail**: cuenta y contraseña de aplicación.
- [ ] **`RUTM_ENCRYPTION_KEY`**: **crítica**. Si se pierde, todos los tokens cifrados de la base quedan inservibles.
- [ ] Locations de GoHighLevel de cada cliente, sus tokens y sus Workflows.

---

## 13 · Dónde está cada tema

| Tema                      | Documento                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visión general y glosario | [01](./01-introduccion.md), [02](./02-arquitectura.md)                                                                                                                                                                                            |
| Instalación y variables   | [03](./03-instalacion-y-configuracion.md), `.env.example`, `sync-worker/.env.example`                                                                                                                                                             |
| Modelo de datos           | [04](./04-modelo-de-datos.md) + las cabeceras de cada migración (muy explicativas)                                                                                                                                                                |
| Auth y roles              | [05](./05-autenticacion-y-roles.md)                                                                                                                                                                                                               |
| Rutas y API               | [06](./06-rutas-y-paginas.md), [07](./07-api-rest.md)                                                                                                                                                                                             |
| Integraciones             | [08](./08-integraciones.md), [20](./20-integracion-gohighlevel.md), [21](./21-auditoria-utms-ghl.md), [26 GA4](./26-auditoria-ga4.md)                                                                                                             |
| Fórmulas y layouts        | [09](./09-motor-de-formulas.md), [10](./10-sistema-de-layouts.md)                                                                                                                                                                                 |
| Leads, UTM, BI y cruce    | [12](./12-modulo-report-utm.md), [16](./16-campos-de-sheet.md), [17](./17-campos-de-lead.md), [18](./18-fuentes-y-cruces.md), [19](./19-guia-segmentos-de-lead.md), [24](./24-respuestas-de-formulario.md), [25](./25-auditoria-cruce-canales.md) |
| MCP y agente              | [13](./13-mcp-y-tokens-api.md), [22](./22-plantilla-agente-interno.md)                                                                                                                                                                            |
| Workers y despliegue      | [14](./14-cron-y-workers.md), [15](./15-despliegue.md)                                                                                                                                                                                            |
| Incidencias               | [23](./23-runbook-empalme.md)                                                                                                                                                                                                                     |

> Consejo: muchos archivos tienen una cabecera que explica **por qué** el código es así, con el incidente que lo motivó. Antes de simplificar algo que parece raro, lee su cabecera y la migración relacionada. Casi todo lo raro tiene una historia detrás.
