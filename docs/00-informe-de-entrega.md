# 00 · Informe de entrega del proyecto

> Para el equipo que continúa con AdsHouse Reporting. Fecha de corte: **2026-09-30**.
> Las cifras de base de datos de este documento se midieron contra producción ese mismo día.
>
> Léelo entero antes de tocar nada. Los apartados 3 (despliegue) y 4 (base de datos) son los que evitan romper producción.

---

## 1 · Resumen en un minuto

**Qué es.** Plataforma multi-cliente de la agencia que junta en un solo sitio las métricas de Meta Ads, TikTok Ads, GA4, Hotmart, Google Sheets y GoHighLevel. Ofrece dashboards por cliente, informes BI con enlace público, gestión de leads con atribución UTM y un agente conversacional (panel web + WhatsApp + servidor MCP).

**Stack.** Next.js 16.3 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage). Corre en contenedores Docker en un VPS con **Dokploy**. Un proceso aparte, `sync-worker/`, sincroniza los datos.

**Estado.** En producción y en uso diario con 6 clientes activos. Todo el trabajo está fusionado en `main`, que es la única rama, y desplegado. La sincronización está sana: 1 job en error de 1.389, y el plan diario ya encola todos los tipos de job, incluido `ga4`.

**Lo primero que hay que resolver** (detalle en el apartado 11):

1. **La base de datos está al límite de memoria.** El cómputo es Micro (1 GB de RAM) y la base pesa 580 MB. Ya se cayó una vez, el 2026-09-20. Subir el cómputo es la mejora más rentable del proyecto.
2. **Mantenimiento de la base pendiente:** aplicar la migración 085 y lanzar un `VACUUM (ANALYZE)` manual (`lead_events` y `pixel_events` no registran ningún vacuum), ejecutar el backfill de `page_url` de la 084, congelar las claves de respuestas de la 090 y hacer el backfill de conversiones personalizadas de Eduversio.
3. **Valorar la rotación de tokens.** Hasta el 2026-09-28 una política de RLS dejaba leer `clientes.config_api` con la clave anónima, que es pública. Ya está cerrada (migración 098), pero los tokens que estuvieran ahí sin cifrar pudieron quedar expuestos. Ver 4.2 y 4.10.
4. **Hay tareas operativas fuera del código:** plantilla de URL con IDs en los anuncios, webhook de Hotmart, permisos de GoHighLevel, Meta Lead Ads de Eduversio en error y **aviso a los clientes de las cifras que cambian**.
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

1. El **worker** encola y ejecuta los jobs (`src/lib/sync/planner.ts`, `runner.ts`, `queue.ts`). Cada job llama a un endpoint de la app (`/api/worker`, `/api/worker/hotmart`, `/api/worker/ga4`, `/api/worker/google-sheets-conversiones`, `/api/cron/sync-ghl-leads`…). La lógica de sincronización vive **solo en la app**; el worker la importa.
2. Las métricas diarias aterrizan en `public.metricas_diarias`: una fila por cliente y día, con desgloses JSONB (`meta_campaigns`, `meta_ads`…). También van a `public.ads_daily`, la versión en filas.
3. Los **leads** entran en tiempo real por webhooks (Meta Lead Ads, GoHighLevel, S2S de WordPress) hacia `report_utm.lead_events`, con sincronizaciones de respaldo. Los formularios de TikTok entran por el job `tiktok_leads`.
4. Las **ventas** de Hotmart se guardan en `public.hotmart_ventas`, convertidas a la moneda de reporte con `public.fx_rates`. Las ventas de GoHighLevel van a `report_utm.sales_events`.
5. **GA4** tiene dos caminos: el del sitio (`ga_*` en `metricas_diarias`) y el desglose por campaña y por página (`ga4_sesiones_diarias`, `ga4_eventos_clave_diarios`, `ga4_landing_diarios`, `ga4_vistas_diarias`).
6. Dos motores de lectura:
   - **Dashboard** (`src/app/(app)/dashboard`): layouts + motor de fórmulas propio (`src/lib/formula-engine.ts`, sin `eval`).
   - **Informes BI** (`src/lib/report-utm/bi-*`, `src/lib/report-utm/bi/sources/*`): widgets configurables con enlace público. `bi-metadata.ts` es el catálogo de métricas.
7. **Cruce lead ↔ campaña:** `src/lib/report-utm/campaign-resolver.ts`. Primero por ID (`utm_id`, `adset_id`, `ad_id`) y después por nombre, solo dentro de la plataforma de `utm_source`. Un nombre repetido da «ambiguo». Detalle en [doc 25](./25-auditoria-cruce-canales.md).
8. **Sincronización bajo demanda:** además del botón del dashboard, el agente y el MCP pueden lanzar la sincronización de un cliente (`src/lib/sync/cliente.ts`).

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
- `report_utm.clientes` es su **espejo**, enlazado por `public_cliente_id` (único desde la migración 098). Se crea, archiva y borra con él desde `src/lib/clientes/ciclo-de-vida.ts`. **No crees ni borres clientes por otra vía.**
- `report_utm.lead_events` usa el id de `report_utm.clientes`, **no** el de `public.clientes`. Cruzar mal esos ids da ceros en silencio.
- El módulo Report-UTM está absorbido en la app principal. Las URLs viejas `/report-utm/*` redirigen (`next.config.ts`).

### Mapa de carpetas que importa

| Carpeta                                 | Contenido                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(app)/`                        | UI autenticada: `dashboard`, `informes`, `leads`, `ventas`, `cruce-campanas`, `notificaciones`, `soporte`, `admin/{settings,sync,salud,agente,configuracion,layouts}` |
| `src/app/api/`                          | ~80 endpoints: `worker/*`, `cron/*`, `report-utm/*` (BI, webhooks, píxel, leads), `agent/*`, `mcp`, `v1/*` (API pública con token), `auth/*` (OAuth)                  |
| `src/app/p/`, `src/app/report/`         | Enlaces públicos (dashboard espejo, informes BI)                                                                                                                      |
| `src/lib/sync/`                         | Cola, planner (incluye las purgas diarias), runner, reconciliación, sync por cliente                                                                                  |
| `src/lib/hotmart/`                      | Cliente API, parser, clasificador, guarda anti-ceros, reagregado, atribución                                                                                          |
| `src/lib/report-utm/`                   | Leads, atribución, cruce de campañas, BI, campos de lead, exclusión, GHL, Meta Leads, TikTok Leads, alcance de campañas                                               |
| `src/lib/meta/`                         | Estado de las cuentas, alertas, conversiones personalizadas                                                                                                           |
| `src/lib/integrations/`, `src/lib/ga4/` | Google Sheets, GA4 (`ga4-cliente.ts` con `probarAccesoGa4`, `ga4-desglose.ts`), OAuth con `state` firmado                                                             |
| `src/lib/leads/`                        | Vocabulario de respuestas de formulario (`respuestas/claves.ts`), fuentes de lead                                                                                     |
| `src/lib/agent/`                        | Agente: registro de herramientas, LLM (OpenRouter), aprobaciones, WhatsApp                                                                                            |
| `src/lib/clientes/`                     | `ciclo-de-vida.ts` (crear, archivar y borrar clientes: único camino permitido) y `puesta-en-marcha.ts`                                                                |
| `src/lib/supabase-paginate.ts`          | `fetchAllRows`: la forma correcta de leer muchas filas. Ver 4.6                                                                                                       |
| `scripts/`                              | ~120 scripts: tests `verify-*`, backfills, diagnósticos, `auditoria-cruce.ts` y `sql-remoto.ts`                                                                       |
| `migrations/`                           | 102 archivos SQL, del 001 al 100                                                                                                                                      |
| `docs/`                                 | Documentación temática (índice en `docs/README.md`)                                                                                                                   |
| `skills/`, `.claude/skills/`            | Skill «informes-bi» para usar el MCP desde Claude                                                                                                                     |

---

## 3 · Estado de Git y despliegue

| Ref                    | Commit                                                           | Qué significa                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `main` = `origin/main` | `dc526d6` («Auditoría integración Google Analytics», 2026-09-29) | **Única rama.** En producción: el plan diario encola `ga4`, `ghl_leads`, `ghl_oportunidades`, `tiktok_leads` y `hotmart_reconciliar` |

La rama `unificacion-reporting-utm` se fusionó en `main` el 2026-09-28 y se borró. No queda trabajo sin subir ni sin desplegar.

**Lo último que entró** (28 y 29 de septiembre):

- Unificación de Report-UTM, MCP y skills, moneda de reporte por cuenta de Meta, Hotmart con todos los estados y reconciliación diaria.
- Auditoría del cruce por canal ([doc 25](./25-auditoria-cruce-canales.md)): zona horaria por cliente, alcance de la cuenta compartida, cruce por plataforma e ID, formularios de TikTok, oportunidades de GHL y arreglo del plan diario.
- Conversiones personalizadas de Meta, disponibles también en el BI.
- GA4 por campaña y por página ([doc 26](./26-auditoria-ga4.md)), migraciones 097 y 100.
- **Los clientes son de la empresa, no de un usuario** (migraciones 098 y 099). Ver 4.10.
- **OAuth con `state` firmado** en Google, Meta y TikTok (`src/lib/integrations/oauth-state-cliente.ts`).
- Se eliminó el funnel de Hotmart del motor de fórmulas y del constructor de layouts.
- El agente y el MCP pueden lanzar la sincronización de un cliente.

### Cómo se despliega

Todo está en [doc 15](./15-despliegue.md). Lo que más se olvida:

- Las `NEXT_PUBLIC_*` van **también en Build Args**: se incrustan en el bundle. Cambiar el dominio obliga a reconstruir.
- El worker necesita el **mismo `CRON_SECRET`**, carácter a carácter, que la app y que el secret de GitHub.
- **El worker se redespliega con la app** cuando cambia `src/lib/sync/` o el planificador.
- `next build` necesita ~2 GB de RAM.
- Si añades un import relativo fuera de `src/lib/sync` que use el worker, hay que añadirlo también a `sync-worker/Dockerfile`.
- **Nunca rotes `RUTM_ENCRYPTION_KEY`** sin migrar antes los secretos. Dejaría ilegibles todos los tokens guardados (Hotmart, GHL, integraciones).
- **Orden entre código y migración.** Una migración que añade algo va **antes** del código que lo usa. Una que quita algo va **después** del código que deja de usarlo (así se hizo con la 098 y la 099).

---

## 4 · Base de datos: errores, incidentes y cuidados

Este es el apartado más importante del informe. Casi todos los problemas serios del proyecto han sido de base de datos, y casi todos fueron **silenciosos**: la aplicación siguió en pie mostrando un cero, una lista vacía o un número más bajo.

### 4.1 Ficha técnica de la instancia

Medido en producción el 2026-09-30:

| Parámetro                                              | Valor                                                     | Qué implica                                                        |
| ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Plan y cómputo                                         | Pro, **sin add-on de cómputo** (Micro)                    | 1 GB de RAM y 2 núcleos compartidos                                |
| Tamaño de la base                                      | **580 MB**                                                | Crece ~3 MB al día                                                 |
| Índices                                                | **171 MB**                                                | Compiten con los datos por la misma memoria                        |
| `shared_buffers`                                       | 256 MB                                                    | Ni los índices más la tabla de leads caben en caché                |
| `work_mem`                                             | 3,5 MB                                                    | Ordenar o agrupar muchas filas va a disco                          |
| Conexiones                                             | 60 de máximo; ~13 en uso                                  | No es el cuello de botella. Si ves el pool lleno, es otro problema |
| Límite por consulta, rol `authenticator` (toda la app) | **8 s**                                                   | Lo que tarde más se cancela                                        |
| Límite por consulta, rol `anon`                        | **3 s**                                                   |                                                                    |
| Espera por bloqueo (`lock_timeout`)                    | **8 s**                                                   | Un INSERT que espera un bloqueo más de 8 s **falla**               |
| `safeupdate`                                           | Activo en `authenticator`                                 | Un `UPDATE` o `DELETE` sin `WHERE` por la API se rechaza           |
| Límite por consulta, conexión directa y Management API | 120 s                                                     | Es el que aplica a `scripts/sql-remoto.ts`                         |
| Filas por respuesta de PostgREST                       | ~1.000                                                    | Hay que paginar. Ver 4.6                                           |
| RLS                                                    | Activo en **todas** las tablas de `public` y `report_utm` | El servidor usa la _service role_, que se lo salta. Ver 4.10       |
| `pg_cron`                                              | **No instalado**                                          | Las purgas dependen del planificador de la app. Ver 4.7            |

Tablas más pesadas:

| Tabla                         | Tamaño | Nota                                                                                   |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `report_utm.lead_events`      | 250 MB | 100.202 filas, ~1.000 leads/día. Su índice `idx_rutm_lead_events_utm_cover` pesa 33 MB |
| `report_utm.pixel_events`     | 123 MB | 81.169 filas. Se purga a 90 días. Crecerá: el píxel ya envía pageviews                 |
| `public.ads_daily`            | 79 MB  | Campañas desde 2026-01-01, conjuntos desde 2026-02-04, **anuncios solo 30 días**       |
| `public.conversiones_offline` | 31 MB  | Filas de Google Sheets                                                                 |
| `public.sheet_filas`          | 30 MB  |                                                                                        |
| `public.metricas_diarias`     | 24 MB  | 2.111 filas. Poco heap y mucho TOAST (JSONB): leer los JSONB es lo caro                |

**Recomendación nº 1 del proyecto:** subir a cómputo Small o Medium. Resuelve de raíz los timeouts intermitentes, los tests que fallan a veces y el riesgo de otra caída. Ninguna optimización de SQL lo sustituye.

### 4.2 Historial de incidentes

Cada fila es algo que ya pasó. La última columna es la regla que dejó.

| Fecha              | Qué se vio                                                                                     | Causa real                                                                                                                                                                                                                       | Arreglo                                                                                             | Lección                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Julio 2026         | Un cliente «perdió» ~90.000 USD de gasto en 3 días: el dashboard mostraba 0                    | El worker leía solo la primera página de Meta (más de 500 campañas). La fila «tenía datos» y no se volvía a pedir                                                                                                                | Paginación completa y reconciliación semanal contra el gasto de la cuenta (`/api/worker/reconcile`) | Un desglose incompleto es peor que uno vacío: se ve creíble                                                                |
| Agosto 2026        | La base llegó a **539 MB contra el tope de 500 MB** del plan gratuito                          | ~295 MB eran basura: el `DELETE` del reemplazo de `sheet_filas` no cabía en 8 s por un índice GIN de 16 MB, **su error se descartaba** y los lotes viejos se acumulaban. Además, un cliente «Prueba» con el mismo Sheet que otro | Migración 061: fuera el índice, una tabla muerta y 5 índices sin uso                                | Un borrado grande por la API se hace por tramos y **se comprueba su error**                                                |
| 11–12 ago 2026     | Las hojas de Sheets escribieron 0 filas durante dos días, con la cola en verde                 | Se desplegó el código sin aplicar la migración 069: `Could not find the function …upsert_lote`. El worker devolvía 200 igualmente                                                                                                | El worker devuelve 500 si ningún cliente se completa                                                | El código y su migración van juntos; un 200 no prueba que se escribió algo                                                 |
| 25 ago 2026        | 404 en cada carga del dashboard y 500 en `/api/v1/campaigns`                                   | `campaign_groups` estaba en `schema.sql` pero nunca se creó en la base                                                                                                                                                           | Migración 077                                                                                       | `schema.sql` no es la verdad; la verdad es producción                                                                      |
| 25 ago 2026        | Los enlaces públicos `/p/<token>` de 46 pestañas no cargaban su pestaña                        | Embed ambiguo `cliente_tabs → clientes`: PostgREST responde **300 / PGRST201**, que supabase-js no lanza como excepción                                                                                                          | Nombrar la FK en el embed                                                                           | Un 300 no lanza; hay que mirar `error`                                                                                     |
| 14 sep 2026        | «Leads total: 26.691 → 0», dos veces seguidas                                                  | Un `count` exacto con `excluido = false` sin índice que lo cubra: 8,3 s. El `if (error) return []` lo convirtió en 0, sin una línea de log                                                                                       | Contar todo y restar los excluidos (índice parcial)                                                 | Un 0 sin rastro en el log es un error tragado                                                                              |
| 16 sep 2026        | El gasto por anuncio salía menor y creíble                                                     | `ads_daily` tiene huecos dentro de su rango, y solo se comprobaban el primer y el último día                                                                                                                                     | `adsDailySinHuecos`: exige filas en cada día con gasto; si no, usa el JSONB                         | «Hay filas» no es lo mismo que «están todos los días»                                                                      |
| **20–21 sep 2026** | **Caída total:** 503 en toda la Data API, después Auth y Storage                               | La instancia se quedó sin memoria. Entre 150 y 245 errores por hora de `statement timeout`                                                                                                                                       | Reinicio del proyecto (165 s) con el worker parado                                                  | La causa es la RAM. El panel decía `ACTIVE_HEALTHY` estando caída                                                          |
| 20–21 sep 2026     | La caída no remitía sola                                                                       | **Tormenta de reintentos:** 5.045 respuestas 503 en 6 h. El worker reintentaba cada 15 s sin espera, y cada 503 hacía a PostgREST recargar su caché de esquema (3,2 s y 21.228 filas por recarga; 325 recargas)                  | Parar el worker y el workflow de respaldo antes de reiniciar                                        | Ante un 503 masivo, lo primero es quitar presión                                                                           |
| 21 sep 2026        | Tras el reinicio, consultas de 8 s y el desplegable de campañas **vacío** en el cliente grande | El reinicio puso a cero las estadísticas. Autovacuum creía que `lead_events` tenía 201 filas. Con el mapa de visibilidad rancio, un «Index Only Scan» hacía 6.754 lecturas al heap                                               | `VACUUM (ANALYZE)` manual: de ~8.000 ms a 37 ms                                                     | Después de un reinicio, vacuum manual de las tablas grandes                                                                |
| 21 sep 2026        | `/leads` sin cliente elegido daba «0 registros»                                                | `ORDER BY created_at` sin `cliente_id` no podía usar ningún índice: 12–17 s                                                                                                                                                      | Migración 088 (índice creado con `CONCURRENTLY`) y conteo estimado                                  | Toda consulta sobre `lead_events` debe entrar por un índice                                                                |
| 28 sep 2026        | Nunca se había encolado un job `ghl_leads`, y Hotmart solo se reconciliaba los domingos        | El `CHECK` de `sync_jobs.tipo` no admitía el tipo nuevo. El INSERT fallaba y **abortaba el plan diario entero**                                                                                                                  | Migración 094 y un `try` por tipo en `planDiario`                                                   | Un tipo de job nuevo necesita su `CHECK`                                                                                   |
| 28 sep 2026        | **Seguridad:** con la clave anónima se podía leer `config_api` de todos los clientes           | Una política `USING (true)` en `public.clientes`, pensada para los enlaces públicos y que nadie usaba                                                                                                                            | Migración 098: política eliminada. Verificado: `anon` ve 0 filas                                    | Nunca una política `USING (true)` sobre una tabla con secretos. **Valorar rotar los tokens que estuvieran ahí sin cifrar** |
| 28 sep 2026        | «Database error deleting user» al borrar un usuario                                            | `bitacoras.author_id` era `NOT NULL` sin `ON DELETE`: cualquier autor de una bitácora era imborrable                                                                                                                             | Migración 098: `SET NULL`                                                                           | Toda FK hacia `auth.users` debe decir qué pasa al borrar                                                                   |
| 28 sep 2026        | GA4 con 0 sesiones durante 636 días                                                            | El ID de propiedad no era visible para la cuenta de la agencia. `PERMISSION_DENIED` solo iba a un log                                                                                                                            | ID corregido, errores visibles en `ga4_estado.ultimo_error`                                         | Un 0 permanente en una fuente es un error de acceso hasta que se demuestre lo contrario                                    |

### 4.3 Catálogo de errores: qué significa cada mensaje

| Lo que ves                                                                                              | Qué es                                                                                                       | Qué hacer                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `canceling statement due to statement timeout` (código `57014`)                                         | La consulta pasó de 8 s (3 s con `anon`)                                                                     | Repetirla 3 o 4 veces: si en caliente pasa, es caché fría. Si no, acotar por cliente y fechas, usar un índice o paginar |
| Un error con `message: ""`                                                                              | También es un timeout: PostgREST a veces lo devuelve sin texto                                               | Igual que el anterior                                                                                                   |
| `[paginate] página fallida tras 3 intentos con N filas ya traídas; el resultado va a quedar INCOMPLETO` | `fetchAllRows` se rindió a mitad. **El número que sale es menor que el real**                                | No fiarse de la cifra. Reintentar sin nada más tocando la base                                                          |
| `[bi-valores] <dónde>: la consulta falló, la lista sale VACÍA`                                          | Un desplegable del BI se quedó sin opciones por un fallo de consulta                                         | Buscar el error que acompaña a la línea; casi siempre un timeout                                                        |
| `motivo: error_consulta`                                                                                | Lo mismo, visto desde el motor del BI                                                                        | No recapturar el golden con ese resultado                                                                               |
| Un 0 o una lista vacía **sin nada en el log**                                                           | Un `if (error) return []` o un `res.data \|\| []` que se tragó el error                                      | Buscar el atajo en el código y hacer que registre el error                                                              |
| HTTP **503** con `PGRST002`                                                                             | PostgREST no puede cargar su caché de esquema: la base está saturada o caída                                 | Procedimiento de 4.8                                                                                                    |
| HTTP **522** (página de Cloudflare)                                                                     | El origen no responde                                                                                        | Procedimiento de 4.8. Ojo: `curl` a `/rest/v1/` devuelve 401 aunque la base esté caída, porque contesta la pasarela     |
| HTTP **300** con `PGRST201`                                                                             | Embed ambiguo: hay dos caminos de FK entre las tablas                                                        | Nombrar la FK: `clientes!cliente_tabs_cliente_id_fkey(...)`                                                             |
| `Could not find the function …` (`PGRST202`)                                                            | Falta aplicar la migración, o PostgREST no ha recargado el esquema                                           | Aplicar la migración; después `NOTIFY pgrst, 'reload schema'`                                                           |
| HTTP 404 sobre una tabla                                                                                | La tabla no existe en producción, aunque esté en `schema.sql`                                                | Comprobar en `information_schema` y crearla con una migración                                                           |
| `42725 function … is not unique`                                                                        | Hay dos sobrecargas de la función: se añadió un parámetro con `CREATE OR REPLACE`                            | `DROP FUNCTION` con la firma vieja exacta, recrear, `GRANT` y recargar el esquema                                       |
| `25001 CREATE INDEX CONCURRENTLY cannot run inside a transaction block`                                 | Se mandó dentro de un archivo, que va como una transacción                                                   | Mandarlo como sentencia suelta: `sql-remoto.ts --query="…"`                                                             |
| `23514 … violates check constraint "sync_jobs_tipo_check"`                                              | El tipo de job no está en el `CHECK`                                                                         | Ampliar el `CHECK` en una migración                                                                                     |
| `55P03 canceling statement due to lock timeout`                                                         | Algo esperó un bloqueo más de 8 s. Típico: un `CREATE INDEX` normal o un `ALTER TABLE` mientras entran leads | **Se pierden inserciones.** Cancelar la operación y rehacerla con `CONCURRENTLY` o fuera de horas                       |
| `UPDATE requires a WHERE clause` / `DELETE requires a WHERE clause`                                     | `safeupdate`                                                                                                 | Poner el `WHERE`. Es una protección, no un fallo                                                                        |
| `cannot drop column … because other objects depend on it`                                               | Una política de RLS o una vista nombra la columna                                                            | Recrear antes la política (así lo hizo la 098 para que la 099 pudiera borrar `user_id`). No usar `CASCADE` a ciegas     |
| `Database error deleting user`                                                                          | Una FK hacia `auth.users` sin `ON DELETE`                                                                    | Pasarla a `SET NULL` o `CASCADE` según el caso                                                                          |
| `P0001` en `bi_valores_*`                                                                               | Rechazo **legítimo**: la columna pedida no está en la lista blanca de la RPC                                 | No es un fallo. Cualquier otro código sí lo es                                                                          |
| `PERMISSION_DENIED` de GA4                                                                              | La cuenta de la agencia no ve esa propiedad                                                                  | `probarAccesoGa4`; no es un problema de la base                                                                         |
| Índice con `indisvalid = false`                                                                         | Un `CREATE INDEX CONCURRENTLY` se cortó a mitad                                                              | Cuesta en cada INSERT y no sirve para leer. `DROP INDEX CONCURRENTLY` y repetir. Hoy hay 0                              |
| Exit 127 con `Assertion failed … UV_HANDLE_CLOSING` al final de un test                                 | Cierre de Node en Windows; las comprobaciones habían pasado                                                  | No es la base. Ya está resuelto en `scripts/_salida.ts`                                                                 |

### 4.4 Estado de las migraciones

- **No hay registro de migraciones aplicadas.** No se usa el sistema de migraciones del CLI de Supabase. Se aplican a mano con `npx tsx scripts/sql-remoto.ts <archivo.sql>` (Management API, necesita `SUPABASE_ACCESS_TOKEN`) o desde el editor SQL.
- **Un archivo se envía como UNA sola transacción.** O entra todo o no entra nada, y no admite `CONCURRENTLY`.
- **Hay números repetidos:** 007, 009, 021, 030, 035 y 078.
- **Algunas cabeceras citan un nombre de archivo antiguo** en su línea de ejemplo (la 098 dice `096_…` y la 099 dice `097_…`). Usa el nombre real del archivo.
- `schema.sql` es el esquema **inicial** y está desactualizado. La verdad es la base de producción.

Estado verificado en producción el 2026-09-30:

| Migración                                                     | Estado                                                                              | Qué hacer                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 001–084, 086–100                                              | Aplicadas                                                                           | —                                                                                                       |
| 098 · clientes de la empresa · 099 · fuera `clientes.user_id` | Aplicadas (la 099, después de desplegar el código que ya no lee la columna)         | —                                                                                                       |
| 100 · GA4 por página                                          | Aplicada                                                                            | —                                                                                                       |
| **085** `autovacuum_tablas_de_evento`                         | **SIN aplicar** (`reloptions` de `lead_events` vacío)                               | Aplicarla. Es segura: solo cambia parámetros de almacenamiento, sin bloqueos. Ver 4.7                   |
| Backfill de la **084**                                        | **Nunca ejecutado**: 87.332 de 100.202 filas conservan las UTM dentro de `page_url` | `npx tsx scripts/backfill-page-url.ts`. Va por lotes de 2.000 **a propósito**. Libera ~40 MB            |
| Claves de respuestas (090)                                    | 7 de 10 `lead_campos` tienen `respuestas`                                           | `npx tsx scripts/migrar-respuestas-lead.ts` en seco y luego `--aplicar`                                 |
| Backfill de conversiones personalizadas                       | Pendiente                                                                           | `scripts/backfill-conversiones-meta.ts --ejecutar`, de madrugada. Cambia cifras publicadas de Eduversio |

### 4.5 Reglas al escribir migraciones

1. **Pregunta antes de aplicar nada en producción.** Hasta ahora las aplicaba el dueño del proyecto tras revisarlas. «Aplica todo el plan» no cuenta como permiso para una migración.
2. **`CREATE INDEX` normal bloquea las inserciones de leads.** Con `lock_timeout = 8s`, los INSERT fallan en vez de esperar, y **un lead perdido no vuelve**. Usa `CREATE INDEX CONCURRENTLY` como sentencia suelta con `sql-remoto.ts --query="…"` y comprueba después `indisvalid`. Ver las migraciones 086 y 088.
3. **Lo mismo vale para `ALTER TABLE`** sobre `lead_events` o `pixel_events`: toma un bloqueo exclusivo. Hazlo fuera de horas y que sea instantáneo (añadir una columna sin valor por defecto calculado).
4. **Añadir un parámetro a una función crea una sobrecarga, no la reemplaza.** Hay que hacer `DROP FUNCTION` con la firma exacta, recrearla, volver a dar los `GRANT` (no sobreviven al `DROP`) y ejecutar `NOTIFY pgrst, 'reload schema'`, todo en el mismo archivo.
5. **Al reescribir una función, compárala línea a línea contra la original.** Copiando a mano la 079 se perdieron una guarda y una lista blanca de columnas; lo cazó `verify-bi-valores-db.ts`, no la revisión.
6. **El código debe funcionar antes y después de la migración.** Si añade, la migración va primero. Si quita, el código va primero y la migración después, en dos pasos (098 → despliegue → 099).
7. **Toda tabla nueva con `cliente_id` lleva FK `ON DELETE CASCADE`**, y ninguna FK hacia `auth.users` puede ser `RESTRICT` ni quedar sin `ON DELETE`. `scripts/verify-borrado-cascada.ts` falla si no.
8. **Toda tabla nueva lleva RLS activado** y sus políticas usan `public.puede_ver_cliente(cliente_id)`. Nunca `USING (true)`.
9. **Nada de UPDATE/DELETE masivos de una vez.** Siempre por lotes. Un UPDATE de 93.000 filas de golpe es justo lo que tumbó la base.
10. **Un tipo de job nuevo necesita su `CHECK`.** Amplía `sync_jobs_tipo_check` y verifícalo con `pg_get_constraintdef`.
11. **Las funciones `SECURITY DEFINER` llevan `SET search_path = ''`** y nombres calificados con esquema (migración 075).
12. **Hazla idempotente** (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`) y escribe en la cabecera cómo se revierte.
13. **No generes el SQL con el shell.** Bash se come `$1`, `$f$`, las barras invertidas y los backticks. Escribe el archivo con el editor.
14. **Antes de fijar parámetros de una tabla, mira `reloptions` en `pg_class`.** Puede que otra migración ya los haya puesto (la 068 lo hizo con `metricas_diarias`).

### 4.6 Reglas al escribir consultas y código que toca la base

1. **El servidor usa la _service role_, que se salta RLS.** El filtro por cliente lo pone el código, siempre. Una consulta sin `cliente_id` agrega en silencio los datos de todos los clientes (ya pasó, ver la cabecera de `src/lib/metrics/client-metrics.ts`).
2. **Usa el id correcto.** `lead_events`, `sales_events` y los informes BI usan el id de `report_utm.clientes`; las métricas, el de `public.clientes`.
3. **Para leer más de 1.000 filas, `fetchAllRows`** (`src/lib/supabase-paginate.ts`). Pagina por cursor sobre `id`, no por `offset`, y reintenta 3 veces cada página. El `select` debe incluir `id`.
4. **Si con el resultado vas a REEMPLAZAR datos, usa `{ estricto: true }`.** Sin él, un fallo a mitad devuelve lo traído hasta ahí, y borrarías el lote bueno para guardar uno parcial.
5. **Mira siempre `error`.** supabase-js no lanza excepciones: ni con un timeout ni con un 300. Prohibido `res.data || []` sin registrar el error.
6. **Borra y actualiza por tramos** (por día o por lotes de id). Así lo hacen `eliminarClienteCompleto` y `purgarPixelEvents`. Un `DELETE` de rango abierto no cabe en 8 s.
7. **Acota toda consulta sobre `lead_events` por `cliente_id` y por fechas.** Sin `cliente_id` ningún índice sirve.
8. **Cuidado con `count: 'exact'`.** Con un filtro que el índice no cubre recorre la tabla. Alternativas: contar todo y restar, o conteo estimado.
9. **No pidas los JSONB de `metricas_diarias` si no los necesitas.** Las mismas filas cuestan 0,7 ms sin ellos y 36 ms con ellos. Agregarlos en SQL con `jsonb_array_elements` no lo mejora.
10. **Nombra la FK en todo embed de `cliente_tabs` hacia `clientes`.**
11. **Los vacíos de `lead_events` son `NULL`**, nunca cadena vacía: «está vacío» es `.is(col, null)`. Lo revalida `verify-leads-filtros-db.ts`.
12. **Piensa dos veces antes de añadir un índice.** Hay 171 MB de índices para 256 MB de caché. Cada índice nuevo encarece los INSERT de leads y quita memoria a los demás.
13. **Mide tres o cuatro veces** y quédate con la última. Una sola medición mide la caché, no la consulta.
14. **Al cortar días de un cliente, hazlo dentro de su zona horaria** (`conZonaDeCliente` y `p_zona` en las RPC).

### 4.7 Mantenimiento: purgas, vacuum e índices

**Purgas.** No hay `pg_cron`. Las lanza `limpiarHistorial` (`src/lib/sync/planner.ts`) una vez al día, en la franja de la mañana del plan diario. Si el plan diario no corre, **no se purga nada** y la base crece.

| Qué se purga                                                        | Retención                   | Estado hoy                                                                             |
| ------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `sync_jobs` terminados (`done`, `cancelled`, `error`) y `sync_runs` | 30 días                     | Funciona: `sync_runs` empieza el 2026-08-31                                            |
| `report_utm.pixel_events`                                           | 90 días, borrando día a día | Funciona: empieza el 2026-07-02                                                        |
| `public.ads_daily`, solo el nivel anuncio                           | 30 días                     | Funciona: los anuncios empiezan el 2026-08-31. Campañas y conjuntos no se purgan nunca |
| Crudo de Hotmart (`purgar_hotmart_raw`)                             | 180 días                    | **No borra ventas**, solo el payload                                                   |
| Datos personales de Hotmart (`purgar_hotmart_pii`)                  | 400 días                    |                                                                                        |
| Crudo de `sales_events`                                             | 90 días                     |                                                                                        |

`report_utm.lead_events` **no se purga**: es el histórico de negocio. Es la tabla que hará crecer la base.

**Vacuum.** Medido el 2026-09-30:

| Tabla                     | Último vacuum    | Filas muertas | Nota                                                                             |
| ------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------------- |
| `report_utm.lead_events`  | **Sin registro** | 3.521         | 6.215 inserciones sin vacuum. Con el umbral por defecto no le toca hasta ~21.000 |
| `report_utm.pixel_events` | **Sin registro** | 9.870         | La purga diaria genera filas muertas                                             |
| `public.ads_daily`        | 2026-09-28       | 6.138         |                                                                                  |
| `public.metricas_diarias` | 2026-09-30       | 6             | La 068 ya le fijó una cadencia agresiva                                          |

Qué hacer:

1. **Aplicar la migración 085.** Fija una cadencia de vacuum por número absoluto de inserciones (2.000 en `lead_events`, 10.000 en `pixel_events`) en lugar de un porcentaje que se degrada al crecer la tabla.
2. **Lanzar ahora un vacuum manual**, una tabla por vez y fuera de horas punta:
   `npx tsx scripts/sql-remoto.ts --query="VACUUM (ANALYZE) report_utm.lead_events"`
   y lo mismo con `report_utm.pixel_events`.
3. **`VACUUM` simple es seguro en caliente. `VACUUM FULL` no:** toma un bloqueo exclusivo y pararía la entrada de leads.
4. **Repetirlo después de cualquier reinicio, caída o restauración.**

**Índices.**

- `idx_rutm_pixel_click_id` pesa **25 MB y tiene 0 usos**. Es candidato a borrarse, pero la migración 061 lo conservó a propósito: lee su nota antes de decidir.
- Los contadores de uso se ponen a cero al reiniciar. Tres minutos después del reinicio del 21-sep, el asesor de Supabase daba 114 índices «sin usar». **No borres un índice por «sin uso» sin días de tráfico normal.**
- Los tres índices de búsqueda de leads (GIN trigram, migración 086) pesan ~18 MB de los 25 MB que se les presupuestaron.

**Copias de seguridad.** No hay entorno de staging ni copia propia. Antes de cualquier operación destructiva, comprueba en el panel de Supabase qué copias automáticas hay y de cuándo es la última. Para un borrado puntual, exporta antes las filas a CSV (así se hizo con `public.leads` en la 061).

### 4.8 Qué hacer si la base se cae

Síntomas: 503 masivos (`PGRST002`), 522 de Cloudflare, login que no funciona, dashboards con «This page couldn't load».

1. **Confirma que es la base.** Consulta `GET /v1/projects/{ref}/health?services=db&services=rest&services=auth` en la Management API. El panel puede decir `ACTIVE_HEALTHY` estando caída, y un `curl` a `/rest/v1/` devuelve 401 aunque el origen no responda.
2. **Quita presión.** En Dokploy, para la Application del `sync-worker` (la que no tiene dominio). En GitHub, deshabilita el workflow `sync-fallback`.
3. **Espera unos minutos.** Si no se recupera sola, reinicia el proyecto desde el panel de Supabase o con `POST /v1/projects/{ref}/restart`. La última vez tardó 165 segundos.
4. **Comprueba** que `db`, `rest`, `auth` y `storage` están sanos en el endpoint de salud.
5. **Lanza `VACUUM (ANALYZE)`** sobre `report_utm.lead_events`, `report_utm.pixel_events`, `public.ads_daily` y `public.metricas_diarias`.
6. **Vuelve a arrancar el worker** y habilita el workflow. No lo dejes parado más de un día: es el único que refresca los tokens de Meta (02:00, hora Colombia).
7. **Revisa los huecos.** Los leads que llegaron por webhook durante la caída se perdieron en la app, pero las sincronizaciones de respaldo (Meta Leads, GHL) los recuperan en el siguiente plan. Los de S2S dependen del reintento del plugin. Mira `/admin/salud` y `/admin/sync`.
8. **No te fíes del asesor de índices ni de `pg_stat_statements`** durante unos días: sus contadores arrancan de cero y la media de tiempos incluye la caída.

Cómo distinguir la saturación de otra cosa: fallan a la vez base, Auth y Storage; las conexiones **no** están agotadas; y operaciones triviales tardan segundos.

### 4.9 Trampas de datos conocidas

- **`ads_daily` tiene huecos por dentro de su rango.** `adsDailySinHuecos` (`src/lib/report-utm/bi-query.ts`) cae al JSONB de `metricas_diarias` si falta algún día con gasto. Para comparar las dos fuentes, fija `BI_ADS_SOURCE=jsonb`. Las conversiones personalizadas también fuerzan el camino JSONB.
- **El desglose por anuncio de más de 30 días solo está en el JSONB** de `metricas_diarias`, porque `ads_daily` purga ese nivel.
- **Los leads ya no escriben en `pixel_events`** ni pasan por `resolveAttribution`, porque `visitor_id` está vacío en el 100 % de las filas. El resolver sigue activo para ventas.
- **`page_url` se guarda sin los parámetros UTM** (`normalizarPageUrl`), pero conserva a propósito los parámetros propios del cliente. El 87 % del histórico todavía los tiene (backfill de la 084 pendiente).
- **Los meses cerrados están congelados** (`periodos_cerrados`, día 7 de cada mes): el worker no los reescribe. Para reabrir un mes, borra su fila; el snapshot queda en `metricas_snapshots`.
- **El worker no escribe ceros encima de datos.** Si una API falla o devuelve cero donde había datos, omite esas columnas del upsert. Un dato viejo puede ser eso y no un fallo de sync: mira `source_synced_at`.
- **Zona horaria:** leads y ventas van en el día del cliente, y el worker y el planificador en día de Colombia.
- **GA4 tiene dos familias que no se suman:** `ga_*` (sitio) y `ga4_*` (por campaña y por página).
- **`fx_rates` tiene 10 tasas CLP y 1 BOB mal fechadas que se dejan a propósito.** Corregirlas descuadraría las ventas ya guardadas.
- **«Somos rentable» y «Sur Profundo» comparten cuenta de Meta y Sheet.** Una auditoría de duplicados los señalará; no es un error.
- **`test:datos` lee producción.** Ejecutar la batería entera varias veces seguidas satura la instancia y devuelve números incompletos que parecen regresiones.

### 4.10 Acceso, RLS y borrado

- **Los clientes son de la empresa, no de un usuario** (decisión del 2026-09-28, migraciones 098 y 099). Ya no existe `clientes.user_id`.
- **Quién ve un cliente:** admin y superadmin ven todos; un trafficker, solo los de `user_client_assignments`. El mismo criterio se aplica en cuatro sitios y deben seguir alineados:
  - la UI;
  - `/api/v1`;
  - el MCP y el agente (`resolverClientesVisibles`);
  - RLS (`public.puede_ver_cliente`).
- **Verificado tras la 098:** `anon` ve 0 clientes, superadmin 6, un trafficker solo sus asignados y un viewer ninguno.
- **Los enlaces públicos** (`/p/<token>`, `/report/...`) no usan RLS: el servidor resuelve el token con la _service role_.
- **Borrar un usuario** funciona siempre y nunca toca clientes.
- **Borrar un cliente borra todo lo suyo** en los dos esquemas (decisión del 2026-09-14). Pasa siempre por `eliminarClienteCompleto`. Solo admin y superadmin. Archivar es la vía para ocultar sin perder datos. Se conserva a propósito `agent_audit_log`. Ver [doc 23](./23-runbook-empalme.md).
- **Los secretos de integraciones** de `report_utm` se cifran con `RUTM_ENCRYPTION_KEY`. Si se pierde la clave, quedan ilegibles.

### 4.11 Lista de comprobación antes de tocar producción

- [ ] ¿Tengo permiso del dueño para esta migración u operación?
- [ ] ¿Sé qué copia de seguridad hay y de cuándo?
- [ ] ¿La operación toma un bloqueo sobre `lead_events` o `pixel_events`? Si sí: `CONCURRENTLY`, o fuera de horas.
- [ ] ¿Toca muchas filas? Entonces va por lotes.
- [ ] ¿El código desplegado funciona antes y después?
- [ ] ¿Cambia la firma de una función? `DROP` + `CREATE` + `GRANT` + `NOTIFY pgrst`.
- [ ] ¿La tabla nueva tiene RLS, FK en cascada y política con `puede_ver_cliente`?
- [ ] ¿La he probado en solo lectura primero (el cuerpo como `SELECT`, o el script en seco)?
- [ ] ¿He verificado el resultado en `information_schema`, `pg_proc` o `pg_index` después de aplicarla?
- [ ] ¿Está el worker sano después? (`sync_runs` con `ejecutor = 'vps'` en la última hora).

---

## 5 · Integraciones

| Integración       | Autenticación                                                                   | Frecuencia                                        | Código                                                                   | Nota                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Meta Ads          | OAuth (`META_APP_ID/SECRET`)                                                    | 05:00 y 14:00; reconciliación los domingos        | `/api/worker`, `src/lib/sync/reconcile.ts`                               | Tokens de ~60 días que refresca el worker. Atribución fija `7d_click + 1d_view`. Multicuenta: todas o ninguna |
| Meta Lead Ads     | Webhook (`META_WEBHOOK_VERIFY_TOKEN`) + sync de respaldo                        | Tiempo real                                       | `/api/report-utm/webhooks/meta`, `src/lib/report-utm/meta-leads.ts`      | Redescubre formularios a diario; el cron reintenta también las integraciones en `error`                       |
| TikTok Ads        | OAuth                                                                           | Diaria                                            | `/api/worker`                                                            | Moneda y zona en `config_api.tiktok_cuentas_info`                                                             |
| TikTok Lead Forms | OAuth                                                                           | Job `tiktok_leads`                                | `src/lib/report-utm/tiktok-leads.ts`                                     | Se activa con `tiktok_leads: true` en la cuenta de `tiktok_accounts`                                          |
| Google Sheets     | Service account (`GOOGLE_SERVICE_ACCOUNT_*`)                                    | Diaria, un job por cliente                        | `src/lib/integrations/`                                                  | La clave PEM va con `\n` escapados; si no, da `invalid_grant`                                                 |
| GA4               | Service account u OAuth de la agencia                                           | Diaria; por campaña y por página con el job `ga4` | `src/lib/integrations/ga4-cliente.ts`, `ga4-desglose.ts`                 | Ver abajo                                                                                                     |
| Google Ads        | OAuth + developer token                                                         | —                                                 | `src/lib/report-utm/google-conversions.ts`                               | Conversiones offline                                                                                          |
| Hotmart           | OAuth HotConnect (tokens de vida corta, refresco cada 2 h) + webhook con hottok | Diaria + reconciliación diaria                    | `src/lib/hotmart/`, `/api/worker/hotmart`                                | Ver abajo                                                                                                     |
| GoHighLevel       | Token por location                                                              | Webhook + sync de leads y de oportunidades        | `src/lib/report-utm/ghl-*.ts`, [doc 20](./20-integracion-gohighlevel.md) | La venta hereda la atribución del último lead del contacto. Una oportunidad perdida revierte la venta         |
| WhatsApp          | Evolution API o `whatsapp-gateway`                                              | Alertas y agente                                  | `src/lib/whatsapp/`                                                      | Mensajes entrantes firmados con HMAC (`AGENT_INBOUND_SECRET`)                                                 |
| LLM del agente    | **OpenRouter** (`OPENROUTER_API_KEY`)                                           | Bajo demanda                                      | `src/lib/agent/llm/client.ts`                                            | 3 niveles de modelo con cadena de reserva, configurables desde la base sin desplegar                          |
| MCP               | Token de API                                                                    | Bajo demanda                                      | `/api/mcp`                                                               | El staff lo usa desde Claude sin coste de API. Puede lanzar sincronizaciones                                  |
| FX                | API pública (fawazahmed0)                                                       | Captura diaria                                    | `src/lib/fx.ts`                                                          | Tabla `fx_rates`                                                                                              |
| Correo            | Gmail con contraseña de aplicación                                              | —                                                 | `src/lib/email.ts`                                                       |                                                                                                               |

**Meta: conversiones personalizadas.** Las reglas de Events Manager (`offsite_conversion.custom.<id>`) llegan **solo en `actions`**, nunca en `conversions`. Antes del 2026-09-28 no se guardó ninguna, y Eduversio perdía unas 4.100 en 30 días. `resultados_custom` es `null`, no 0, si el cliente no marcó ninguna conversión como resultado.

**GA4: «en 0» casi nunca es falta de tráfico, es falta de acceso.**

- Cris llevaba 636 días con 0 sesiones porque tenía un ID de propiedad que la cuenta de la agencia no ve. Se corrigió a `524635063` y se hizo el backfill.
- Ante un GA4 vacío, usa «Probar conexión» o `probarAccesoGa4` antes de tocar código. El último error queda en `ga4_estado.ultimo_error`.
- La cuenta de la agencia solo ve 4 propiedades. La de Sur Profundo («Eventos SP Group») **no se asignó a propósito**.
- El hueco de junio de 2026 en el GA4 de Cris es del tag, no del sync.
- Detalle en [doc 26](./26-auditoria-ga4.md).

**Hotmart. Hechos verificados que no se deducen del código:**

- `sales/history` **sin lista de estados devuelve solo `COMPLETE`**. `ESTADOS_API_SYNC` debe quedarse. Un estado inválido tumba la petición entera (el correcto es `PRINTED_BILLET`, no `BILLET_PRINTED`).
- La API filtra por fecha de **orden**, no de aprobación. Por eso existe la reconciliación diaria.
- **El webhook de Hotmart no se configuró nunca** en ningún cliente.
- **Septiembre de 2026 sin ventas en Cris es real**, no un fallo.
- Las 88 ventas antiguas no tienen la tupla UTM. Para rellenarla: `npm run backfill:hotmart` sobre julio y agosto.
- Una venta se atribuye al **último lead antes de la venta**. Una macro sin rellenar no cuenta como tracking.

**Moneda.** Cris reporta en CLP. Antes de activar otra moneda en un cliente, rellena `fx_rates` con `scripts/backfill-fx-historico.ts`. El gasto no se convierte: cada informe avisa si una cuenta gasta en otra moneda.

**El agente no puede usar una suscripción de Claude.** Lo prohíben los términos de Anthropic. El coste de API irreducible es el de WhatsApp.

---

## 6 · Operación diaria

- **Pantallas de diagnóstico:** `/admin/salud`, `/admin/sync` y `/cruce-campanas`. Por consola: `npm run diagnostico` y `npx tsx --conditions=react-server scripts/auditoria-cruce.ts`. `/admin/salud` avisa también si dos clientes comparten cuenta sin alcance.
- **¿El worker está vivo?** Ejecuta `select ejecutor, count(*), max(started_at) from sync_runs where started_at > now() - interval '1 hour' group by 1;`. Debe aparecer `vps`.
- **Horarios del worker** (hora Colombia): 05:00 y 14:00 plan diario (métricas, Sheets, Meta Leads, GHL leads y oportunidades, TikTok Leads, GA4, reconciliación de Hotmart; a las 05:00 también las purgas) · 02:00 tokens de Meta · cada 2 h tokens de Hotmart · domingo 03:00 reconciliación · día 7, 03:00 cierre de mes.
- **Runbook de incidencias:** [doc 23](./23-runbook-empalme.md). Para una caída de la base, el apartado 4.8 de este informe.
- **Operaciones con `curl`:** [doc 14](./14-cron-y-workers.md), al final (encolar un plan, resincronizar un rango, cerrar un mes).

---

## 7 · Pruebas y calidad

- **No hay Jest ni Vitest.** Las pruebas son scripts `scripts/verify-*.ts` que se ejecutan con `npx tsx --conditions=react-server …`. Sin ese flag, `server-only` revienta (también en los `execSync` anidados).
- `npm run test:puro`: verificaciones sin base de datos (reglas, parsers, seguridad, agente, MCP, zona por cliente, conversiones de Meta, GA4, cruce por ID, sync por cliente, puesta en marcha).
- `npm run test:datos`: verificaciones **contra la base de PRODUCCIÓN, en solo lectura**.
  - Incluye `verify-paridad-superficies`: el mismo gasto y los mismos leads en BI, dashboard y API.
  - Incluye `verify-borrado-cascada`: FK, RLS y políticas del catálogo real.
  - Incluye el **golden** (`scripts/verify-bi-golden.ts` contra `scripts/golden/bi-baseline.json`), que congela cifras de informes reales.
  - Encadena los scripts con `&&`: un fallo transitorio aborta el resto.
  - Ante un fallo, **mira la línea anterior del log**. Si dice `statement timeout`, `[paginate]` o `INCOMPLETO`, el número no es real: ejecuta ese script solo.
  - **No lances la batería entera varias veces seguidas.** Satura la instancia.
  - **Nunca recaptures el golden entero** sin revisar el log, y compáralo dos veces después.
  - Los ingresos de Hotmart de Cris ×~920 son la conversión a CLP, no un error.
- `npm run validate`: type-check + ESLint (0 warnings) + Prettier. Es lo único que corre en el CI (`.github/workflows/validate.yml`).
  - En Windows con `core.autocrlf=true`, tras un merge o un checkout `format:check` puede fallar en cientos de archivos que nadie tocó: quedaron en CRLF. No es tu cambio. Pásalos a LF sin reformatear.
- Un `next build` que falla con timeouts de 60 s en páginas estáticas que no has tocado suele ser la caché fría: relánzalo antes de culpar a tu cambio.

---

## 8 · Decisiones de producto que NO hay que «arreglar»

| Parece un bug                                                                   | Por qué es así                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Somos rentable» y «Sur Profundo» leen el mismo Sheet y la misma cuenta de Meta | Es a propósito. El BI recorta el gasto de cada uno con `config_api.alcance_campanas`: Somos `somos rentable, [lsr]`; Sur Profundo, el resto. Una campaña que no siga esa convención cae en Sur Profundo |
| Los leads de Meta ≠ los contactos recibidos                                     | Son dos métricas distintas (atribuidos por Meta frente a `lead_events`) con rótulos propios (`src/lib/leads/fuentes-de-lead.ts`). No cuadran día a día                                                  |
| La pestaña del dashboard ya no se recorta a su «rango de captación»             | Decisión del 2026-09-28: manda el calendario. La ventana solo alimenta presupuesto y ritmo (`scripts/verify-rango-captacion.ts`)                                                                        |
| Filtrar o agrupar por una respuesta de formulario deja el gasto en «—»          | Es correcto: el gasto no se reparte por respuestas. Medir con la respuesta como métrica (`lf__…`) sí permite CPL. Ver [doc 24](./24-respuestas-de-formulario.md)                                        |
| Muchas métricas pasaron de «0» a «—»                                            | Una métrica sin fuente conectada (ROAS sin Hotmart, `ga_*` sin GA4, `tiktok_*` sin TikTok) o sin reparto posible sale «—». Un 0 significaría «medido y es cero»                                         |
| Un lead sale «ambiguo»                                                          | Dos campañas con el mismo nombre no se reparten por gasto: decisión del dueño. El ID o el anuncio pueden desempatar                                                                                     |
| Cambió la frecuencia de Meta, el rebote de GA4 o los % de Sheets en un rango    | Ahora se calculan desde sus bases (impresiones ÷ alcance, medias ponderadas). Antes se sumaban día a día, que era incorrecto                                                                            |
| Hay menos leads de los recibidos                                                | La regla «Qué leads cuentan» excluye los que no tienen atribución. Están en `/leads` → Excluidos                                                                                                        |
| Un cliente no tiene «dueño» y un trafficker no ve clientes que creó             | Los clientes son de la empresa. El acceso lo da la asignación, no quién lo creó                                                                                                                         |
| Ya no existe el funnel de Hotmart en los layouts                                | Se eliminó el 2026-09-28. Las ventas de Hotmart se miden con las métricas `hm_*`                                                                                                                        |
| `/p/<token>` no se puede embeber en un iframe                                   | La regla catch-all de `next.config.ts` gana a las de `/p/` y `/report/`. Se dejó así por seguridad (clickjacking); cambiarlo es decisión de producto                                                    |
| Los grupos de campaña siempre salen vacíos                                      | Las tablas existen (077), pero **no hay ni UI ni código de escritura**. Si se piden grupos, hay que construir la escritura entera                                                                       |
| Goodprop desconectado, Eduversio sin campos de lead                             | Intencional (sus formularios solo piden nombre y correo)                                                                                                                                                |

---

## 9 · Deuda técnica

| Área                                  | Problema                                                                                                                                                                                                        | Sugerencia                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Cómputo de la base**                | Micro con 1 GB para 580 MB de datos y 171 MB de índices                                                                                                                                                         | Subir a Small o Medium. Es la deuda nº 1                                                                                           |
| **Sin staging ni copia propia**       | Todo se prueba contra producción, incluidas las migraciones                                                                                                                                                     | Rama de Supabase o proyecto de staging con datos anonimizados                                                                      |
| Migraciones                           | Sin registro de aplicadas, con números duplicados y aplicadas a mano                                                                                                                                            | Adoptar `supabase migration` o una tabla `schema_migrations` propia                                                                |
| Fallos silenciosos                    | El patrón `res.data \|\| []` convierte errores y timeouts en vacíos. El BI ya avisa en sus widgets; el dashboard todavía no                                                                                     | Registrar el error y mostrar «no se pudo cargar» también en el dashboard                                                           |
| Purgas sin planificador propio        | Dependen de que corra el plan diario de la mañana                                                                                                                                                               | Activar `pg_cron`, o al menos una alerta si la purga no corre                                                                      |
| Observabilidad                        | Solo logs JSON, `sync_runs` y `ga4_estado.ultimo_error`; sin Sentry ni alertas de la base                                                                                                                       | Sentry + alerta de salud de Supabase + uptime de `/api/health` + alerta de tamaño de la base                                       |
| Reintentos del worker                 | Reintenta cada 15 s sin espera aunque la base esté caída                                                                                                                                                        | Espera creciente cuando `claim_sync_job` devuelva 503                                                                              |
| Componentes gigantes                  | `LayoutConfigModal.tsx` (~3.100 líneas), `DashboardClient.tsx` (~2.900), `MetricCharts.tsx` (~1.200). En `src/lib`: `bi-metadata.ts` (>2.100), `google-sheets-conversiones.ts` (>2.000), `bi-query.ts` (>2.300) | Trocear al tocar cada zona, sin gran refactor de golpe                                                                             |
| Dos motores de métricas               | El dashboard y el BI calculan lo mismo por caminos distintos. El dueño decidió alinearlos con tests de paridad y no con un motor único                                                                          | Mantener `verify-paridad-superficies` en verde con cada cambio de métrica                                                          |
| Pruebas                               | Scripts ad hoc; `test:datos` depende de producción                                                                                                                                                              | Runner estándar y datos de staging                                                                                                 |
| Atribución web                        | `visitor_id` vacío: la cascada multi-touch no funciona para leads                                                                                                                                               | Poblar `visitor_id` desde el píxel antes de reenchufar `resolveAttribution`                                                        |
| Formularios de TikTok                 | Sus preguntas no se guardan en `lead_preguntas` (el `CHECK` de `fuente` no admite `tiktok`); las respuestas sí están en `raw_fields`                                                                            | Ampliar el `CHECK` si se quieren como preguntas                                                                                    |
| Rebote de GA4 en el dashboard clásico | Va en fracción 0–1 con sufijo «%». Cambiarlo altera fórmulas guardadas                                                                                                                                          | Decisión del dueño; la métrica nueva `ga4_tasa_rebote` ya va en 0–100                                                              |
| Dependencias                          | Versiones mayores pendientes (recharts 3, react-day-picker 10, lucide 1.x)                                                                                                                                      | Revisar una por una. **Next 16.3 cambia APIs**: lee `node_modules/next/dist/docs/` antes de tocar código de Next (ver `AGENTS.md`) |
| Tipos                                 | `@types/node` 20 con motor 22                                                                                                                                                                                   | Subir a `@types/node` 22                                                                                                           |

---

## 10 · Documentación desactualizada

La carpeta `docs/` es buena y detallada, pero tiene restos de la época de Vercel y del estado anterior al 2026-09-28:

- `docs/02-arquitectura.md`: dice «Deploy: Vercel», «migraciones 001…020» y «van por la 081»; menciona el route group `(report-utm)`, que ya no existe.
- `docs/14-cron-y-workers.md`: dice que la zona por cliente «no está activada». Ya lo está. También le faltan los jobs nuevos en la lista de tipos (`ghl_oportunidades`, `tiktok_leads`, `ga4`).
- `docs/15-despliegue.md`: dice que «no hay suite de tests» (sí la hay) y que `/p/*` y `/report/*` son embebibles (no lo son, ver apartado 8).
- `docs/23-runbook-empalme.md`: la sección «No me deja eliminar un usuario» describe el bloqueo antiguo. Ya no existe: borrar un usuario funciona siempre.
- `sync-worker/README.md`: «La app está en Vercel plan Hobby»; faltan los horarios de tokens y reconciliación.
- `.github/workflows/validate.yml`: **Node 20**, cuando debe ser `22.12` o superior.
- `.env.example`: el comentario «Activa el módulo report-utm» no tiene variable debajo (restos).
- Comentarios de `maxDuration` y del límite de 60 s: inertes en Docker.
- Cabeceras de las migraciones 098 y 099: citan un nombre de archivo antiguo.

Están al día y conviene leerlas: [doc 04](./04-modelo-de-datos.md) y [doc 05](./05-autenticacion-y-roles.md) (actualizadas con la 098), [doc 25](./25-auditoria-cruce-canales.md) (cruce por canal) y [doc 26](./26-auditoria-ga4.md) (GA4).

---

## 11 · Plan recomendado para las dos primeras semanas

**Día 1 (sin tocar código)**

1. Recibir todos los accesos del apartado 12 y comprobar que funcionan.
2. Levantar el entorno local: Node ≥ 22.12, `git pull` en `main`, `.env.local` a partir de `.env.example`, `npm run dev`. Pasar `npm run validate` y `npm run test:puro`.
3. Leer el apartado 4 de este informe y los docs 23, 25 y 26.
4. Comprobar en el panel de Supabase qué copias de seguridad hay.

**Semana 1 · estabilizar la base**

5. Subir el cómputo de Supabase (Small o Medium). Pide aprobación del gasto al dueño.
6. Aplicar la **085** y lanzar `VACUUM (ANALYZE)` sobre `lead_events` y `pixel_events`.
7. Ejecutar el backfill de la **084** fuera de horas punta.
8. Ejecutar de madrugada `backfill-conversiones-meta.ts --ejecutar` y avisar a Eduversio.
9. Decidir con el dueño si se rotan los tokens que estuvieron en `config_api` (ver 4.2).
10. Cambiar el CI a Node 22.
11. Poner alertas ([doc 27](./27-alertas-y-staging.md)): aplicar la **101** (tamaño, crecimiento y purgas ya están en el código), dar de alta el monitor de uptime de `/api/health` y las alertas de cómputo de Supabase.

**Semana 2 · tareas operativas (fuera del código)**

12. **Avisar a los clientes** de las cifras que cambian ([doc 25 §4](./25-auditoria-cruce-canales.md) y [doc 26](./26-auditoria-ga4.md)): días en zona de Chile, «0» → «—», frecuencia y medias ponderadas, gasto recortado de Somos rentable y Sur Profundo, moneda.
13. **Plantilla de URL con IDs** en los anuncios activos. Es la mejora de precisión más grande pendiente:
    - Meta: `…&utm_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`
    - TikTok: `…&utm_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__`
14. **Webhook de Hotmart** en cada cliente que venda por Hotmart: URL de la tarjeta del cliente + hottok + `sck={{ad.id}}` en los checkouts.
15. **GoHighLevel:** dar al token el alcance `opportunities.readonly` y crear el Workflow «Opportunity Status Changed».
16. **Eduversio:** reconectar Meta con permiso de Páginas o desactivar su Meta Lead Ads (en `error` desde el 2026-06-22; sus leads entran por S2S).
17. **GA4 de otros clientes:** dar a la cuenta de la agencia acceso de Lector a sus propiedades y elegirlas en el selector.
18. `migrar-respuestas-lead.ts --aplicar`, Sentry y actualizar la documentación del apartado 10.
19. Decidir con el dueño: staging, registro de migraciones, embebido de `/p/`, grupos de campaña, unidades del rebote.

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
| Incidencias               | [23](./23-runbook-empalme.md) y el apartado 4.8 de este informe                                                                                                                                                                                   |

> Consejo: muchos archivos tienen una cabecera que explica **por qué** el código es así, con el incidente que lo motivó. Las migraciones 061, 084, 085, 088 y 098 son especialmente instructivas. Antes de simplificar algo que parece raro, lee su cabecera y la migración relacionada.
