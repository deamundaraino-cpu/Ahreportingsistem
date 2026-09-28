# 00 · Informe de entrega del proyecto

> Para el equipo que continúa con AdsHouse Reporting. Fecha de corte: **2026-09-28**.
> Las cifras de base de datos de este documento se midieron contra producción ese mismo día.
>
> Léelo entero antes de tocar nada. Los apartados 3 (despliegue) y 4 (base de datos) son los que evitan romper producción.

---

## 1 · Resumen en un minuto

**Qué es.** Plataforma multi-cliente de la agencia que junta en un solo sitio las métricas de Meta Ads, TikTok Ads, GA4, Hotmart, Google Sheets y GoHighLevel. Ofrece dashboards por cliente, informes BI con enlace público, gestión de leads con atribución UTM y un agente conversacional (panel web + WhatsApp + servidor MCP).

**Stack.** Next.js 16.3 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage). Corre en contenedores Docker en un VPS con **Dokploy**. Un proceso aparte, `sync-worker/`, sincroniza los datos.

**Estado.** En producción y en uso diario con 6 clientes activos. El sistema de sincronización está sano: en las últimas 24 h hubo 27 ejecuciones y solo 1 job en error de 2.356.

**Lo primero que hay que resolver** (detalle en el apartado 11):

1. **Hay trabajo sin desplegar ni subir.** La rama `unificacion-reporting-utm` lleva **14 commits por delante de `main`**, y los **8 últimos no están en GitHub**. Hay que empujarlos antes de nada, o se pierden con el portátil.
2. **La base de datos está al límite de memoria.** El cómputo es Micro (1 GB de RAM) y la base pesa 574 MB. Ya se cayó una vez, el 2026-09-20. Subir el cómputo es la mejora más rentable del proyecto.
3. **Hay tres tareas de base de datos pendientes:** la migración 085 (autovacuum), el backfill de `page_url` de la 084 y la migración 082 con su backfill.
4. **El CI valida con Node 20**, pero la app exige Node ≥ 22.12. Con Node 20 el dashboard devuelve 500.

---

## 2 · Arquitectura

### Piezas desplegadas

| Pieza | Código | Dónde corre | Qué hace |
| --- | --- | --- | --- |
| App web | raíz del repo, `Dockerfile` | Dokploy (VPS), puerto 3000, dominio `reportes.adshouse.cloud` | UI, API REST, webhooks, MCP, endpoints de worker |
| `sync-worker` | `sync-worker/` (`sync-worker/Dockerfile`) | Dokploy, mismo VPS, puerto 8080, **sin dominio** | Scheduler + drena la cola `sync_jobs` cada 15 s. **Es obligatorio**: es el único que refresca los tokens de Meta |
| Respaldo de la cola | `.github/workflows/sync-fallback.yml` | GitHub Actions, minutos :07 y :37 | Drena la cola si el worker cae, refresca tokens de Hotmart y abre una issue si el pipeline está parado |
| Gateway de WhatsApp | `whatsapp-gateway/` (Baileys) | Opcional; la alternativa es Evolution API (`WHATSAPP_PROVIDER`) | Envía alertas y recibe los mensajes que atiende el agente |
| Plugin de WordPress | `wordpress-plugin/report-utm/` | En los sitios de los clientes | Envía leads por S2S a `/api/report-utm/pixel/s2s` |
| Píxel JS | `public/report-utm-pixel.js` | En las landings | Envía eventos a `/api/report-utm/pixel/event` |
| Base de datos | `migrations/` | Supabase, proyecto `dfdeizrbkpdocgckqlel` («REPORTING APP»), plan Pro, cómputo Micro | Postgres + Auth + Storage |

> **Vercel ya no se usa.** Mucha documentación y muchos comentarios todavía lo mencionan (límite de 60 s, `maxDuration`, `vercel.json`). Todo eso es histórico. Ver el apartado 10.

### Flujo de datos

1. El **worker** encola y ejecuta los jobs (`src/lib/sync/planner.ts`, `runner.ts`, `queue.ts`). Cada job llama a un endpoint de la app (`/api/worker`, `/api/worker/hotmart`, `/api/worker/google-sheets-conversiones`, `/api/cron/sync-ghl-leads`…). La lógica de sincronización vive **solo en la app**; el worker la importa.
2. Las métricas diarias aterrizan en `public.metricas_diarias`: una fila por cliente y día, con desgloses JSONB (`meta_campaigns`, `meta_ads`…). También van a `public.ads_daily`, la versión en filas, desde 2026-01-01.
3. Los **leads** entran en tiempo real por webhooks (Meta Lead Ads, GoHighLevel, S2S de WordPress) hacia `report_utm.lead_events`, con sincronizaciones de respaldo.
4. Las **ventas** de Hotmart se guardan en `public.hotmart_ventas`, convertidas a la moneda de reporte con `public.fx_rates`.
5. Dos motores de lectura:
   - **Dashboard** (`src/app/(app)/dashboard`): layouts + motor de fórmulas propio (`src/lib/formula-engine.ts`, sin `eval`).
   - **Informes BI** (`src/lib/report-utm/bi-*`, `src/lib/report-utm/bi/sources/*`): widgets configurables con enlace público. `bi-metadata.ts` es el catálogo de métricas.

### Dos esquemas: `public` y `report_utm`

Es la mayor fuente de confusión del proyecto:

- `public.clientes` es la **fuente de verdad** del cliente.
- `report_utm.clientes` es su **espejo**, enlazado por `public_cliente_id`. Se crea, archiva y borra con él desde `src/lib/clientes/ciclo-de-vida.ts`. **No crees ni borres clientes por otra vía.**
- `report_utm.lead_events` usa el id de `report_utm.clientes`, **no** el de `public.clientes`. Cruzar mal esos ids da ceros en silencio.
- El módulo Report-UTM se absorbió en la app principal el 2026-09-20 («Reporting absorbe Report-UTM»). Las URLs viejas `/report-utm/*` redirigen (`next.config.ts`).

### Mapa de carpetas que importa

| Carpeta | Contenido |
| --- | --- |
| `src/app/(app)/` | UI autenticada: `dashboard`, `informes`, `leads`, `ventas`, `cruce-campanas`, `notificaciones`, `soporte`, `admin/{settings,sync,salud,agente,configuracion,layouts}` |
| `src/app/api/` | ~80 endpoints: `worker/*`, `cron/*`, `report-utm/*` (BI, webhooks, píxel, leads), `agent/*`, `mcp`, `v1/*` (API pública con token), `auth/*` (OAuth) |
| `src/app/p/`, `src/app/report/` | Enlaces públicos (dashboard espejo, informes BI) |
| `src/lib/sync/` | Cola, planner, runner, reconciliación |
| `src/lib/hotmart/` | Cliente API, parser, clasificador, guarda anti-ceros, reagregado, atribución |
| `src/lib/report-utm/` | Leads, atribución, BI, campos de lead, exclusión, GHL, Meta Leads, CAPI |
| `src/lib/leads/` | Vocabulario de respuestas de formulario (`respuestas/claves.ts`), fuentes de lead |
| `src/lib/agent/` | Agente: registro de herramientas, LLM (OpenRouter), aprobaciones, WhatsApp |
| `src/lib/clientes/ciclo-de-vida.ts` | Crear, archivar y borrar clientes. Es el único camino permitido |
| `scripts/` | ~106 scripts: tests `verify-*`, backfills, diagnósticos y `sql-remoto.ts` |
| `migrations/` | 095 archivos SQL, del 001 al 093 |
| `docs/` | Documentación temática (índice en `docs/README.md`) |
| `skills/`, `.claude/skills/` | Skill «informes-bi» para usar el MCP desde Claude |

---

## 3 · Estado de Git y despliegue (crítico)

| Ref | Commit | Qué significa |
| --- | --- | --- |
| `main` / `origin/main` | `bbf0005` («sheets», ~2026-09-16) | Lo que despliega Dokploy (rama configurada: `main`; **confírmalo en el panel**) |
| `origin/unificacion-reporting-utm` | `cae1657` | Lo último subido a GitHub |
| `unificacion-reporting-utm` (local) | `79dc694` («discrepancia de leads», 2026-09-28) | **8 commits sin subir** |

**Qué hay en la rama y no en producción** (14 commits):

- Unificación de Report-UTM dentro de Reporting (rutas nuevas, redirecciones).
- Servidor MCP y skills de informes BI.
- Moneda de reporte automática según la cuenta de Meta (Eduversio pasa a COP; Expo Renta Corta, Invest Brokers, Somos rentable y Sur Profundo pasan a CLP).
- Hotmart: estados completos, reconciliación diaria, atribución por lead.
- Respuestas de formulario como métricas (pestaña «Leads»), búsqueda y filtros de leads, detección de duplicados.
- Historial para deshacer las ediciones del agente en los informes.
- El dashboard deja de recortar las filas al «rango de captación» de la pestaña (decisión del 2026-09-28).

**Qué hacer:**

1. `git push origin unificacion-reporting-utm`, hoy mismo.
2. Revisar la rama (es grande), pasar `npm run validate`, `npm run test:puro` y `npm run test:datos`, y fusionar a `main`.
3. Al desplegar, avisar a los clientes de que **cambian las etiquetas de moneda** de 5 clientes.

La base de producción ya tiene aplicadas migraciones que solo usa la rama (089–093). El código está escrito para funcionar **antes y después** de cada migración, así que el `main` actual convive bien con esa base.

Hay además una rama local `claude/jovial-hopper-116a3d` y 5 ramas de Dependabot en remoto: revisarlas o borrarlas.

### Cómo se despliega

Todo está en [doc 15](./15-despliegue.md). Lo que más se olvida:

- Las `NEXT_PUBLIC_*` van **también en Build Args**: se incrustan en el bundle. Cambiar el dominio obliga a reconstruir.
- El worker necesita el **mismo `CRON_SECRET`**, carácter a carácter, que la app y que el secret de GitHub.
- `next build` necesita ~2 GB de RAM.
- Si añades un import relativo fuera de `src/lib/sync` que use el worker, hay que añadirlo también a `sync-worker/Dockerfile`.
- **Nunca rotes `RUTM_ENCRYPTION_KEY`** sin migrar antes los secretos. Dejaría ilegibles todos los tokens guardados (Hotmart, GHL, integraciones).

---

## 4 · Base de datos: con qué tener cuidado

### 4.1 La instancia está al límite

- Plan Pro, pero **sin add-on de cómputo**: Micro, con 1 GB de RAM, 2 núcleos compartidos y 60 conexiones.
- La base pesa **574 MB** y `shared_buffers` es de 224 MB, así que el conjunto de trabajo no cabe en memoria. El *hit ratio* medido es del 45–54 %.
- **Caída del 2026-09-20/21.** La instancia se quedó sin memoria, PostgREST devolvió 503 en toda la Data API y cayeron también Auth y Storage. Se recuperó con un reinicio.
- **La causa es la RAM, no las consultas.** Una consulta que tarda 1 s en frío tarda 4 ms en caliente, con el mismo plan. Antes de optimizar una consulta «lenta», ejecútala 3–4 veces y quédate con la última medición.

**Recomendación nº 1 del proyecto:** subir a cómputo Small o Medium. Resuelve de raíz los timeouts intermitentes, los tests de datos que fallan a veces y el riesgo de otra caída.

Tablas más pesadas:

| Tabla | Tamaño | Nota |
| --- | --- | --- |
| `report_utm.lead_events` | 250 MB | 99.129 filas, ~1.000 leads/día |
| `report_utm.pixel_events` | 123 MB | Crecerá mucho: el píxel v0.3.2 ya envía pageviews. Se purga a 90 días |
| `public.ads_daily` | 79 MB | Desde 2026-01-01. Tiene **huecos**, ver 4.5 |
| `public.conversiones_offline` | 31 MB | Filas de Google Sheets |
| `public.sheet_filas` | 30 MB | |
| `public.metricas_diarias` | 24 MB | Poco heap, mucho TOAST (JSONB). Leerla con los JSONB es lo caro |

### 4.2 Estado de las migraciones

- **No hay registro de migraciones aplicadas.** No se usa el sistema de migraciones del CLI de Supabase. Se aplican a mano con `npx tsx scripts/sql-remoto.ts <archivo.sql>` (Management API, necesita `SUPABASE_ACCESS_TOKEN`) o desde el editor SQL.
- **Hay números repetidos:** 007, 009, 021, 030, 035 y 078.
- `schema.sql` es el esquema **inicial** y está desactualizado. La verdad es la base de producción.

Estado verificado en producción a 2026-09-28:

| Migración | Estado | Qué hacer |
| --- | --- | --- |
| 001–081, 083, 084, 086–093 | Aplicadas | — |
| **085** `autovacuum_tablas_de_evento` | **SIN aplicar** (`reloptions` de `lead_events` vacío) | Aplicarla. Es segura (solo parámetros de almacenamiento, sin bloqueos) y evita que las consultas de leads vuelvan a degradarse |
| **082** `ids_publicitarios_en_leads` | **SIN aplicar** (no existen `campaign_id`/`adset_id`/`ad_id` en `lead_events`) | Aplicarla y luego ejecutar `npx tsx --conditions=react-server scripts/backfill-ids-leads.ts` (primero en seco, después con `--aplicar`). El código ya sondea si las columnas existen |
| Backfill de la **084** | **Nunca ejecutado**: 87.332 de 99.129 filas conservan las UTM dentro de `page_url` | `npx tsx scripts/backfill-page-url.ts`. Va por lotes de 2.000 **a propósito**: un UPDATE masivo es justo lo que tumbó la base. Libera ~40 MB |
| Claves de respuestas (090) | 7 de 10 `lead_campos` tienen `respuestas` | `npx tsx scripts/migrar-respuestas-lead.ts` en seco y luego `--aplicar` para congelar las que faltan |

### 4.3 Reglas al escribir migraciones

1. **Pregunta antes de aplicar nada en producción.** Hasta ahora las migraciones las aplicaba el dueño del proyecto, después de revisarlas.
2. **`CREATE INDEX` normal bloquea las inserciones de leads.** El rol `authenticator` tiene `lock_timeout = 8s`: los INSERT fallan en vez de esperar, y **un lead perdido no vuelve**. Usa `CREATE INDEX CONCURRENTLY` como sentencia suelta con `sql-remoto.ts --query="…"` (un archivo se manda como una transacción, y `CONCURRENTLY` no puede ir dentro de una). Comprueba después `indisvalid`. Ver las migraciones 086 y 088.
3. **Añadir un parámetro a una función crea una sobrecarga, no la reemplaza.** Las llamadas con la firma vieja pasan a dar `42725 function is not unique`. Hay que hacer `DROP FUNCTION` con la firma exacta, recrearla, volver a dar los `GRANT` y ejecutar `NOTIFY pgrst, 'reload schema'`, todo en el mismo archivo.
4. **Al reescribir una función, compárala línea a línea contra la original.** Copiando a mano la 079 se perdieron una guarda y una lista blanca de columnas; lo cazó un test, no la revisión.
5. **El código debe funcionar antes y después de la migración.** Un despliegue sin su migración ya dejó dos días de Sheets escribiendo cero filas (la 069, en agosto).
6. **Toda tabla nueva con `cliente_id` lleva FK `ON DELETE CASCADE`.** `scripts/verify-borrado-cascada.ts` falla si no.
7. **Nada de UPDATE/DELETE masivos de una vez.** Siempre por lotes.

### 4.4 Límites y timeouts

- **PostgREST corta cada consulta a los 8 s** (`statement_timeout`). Para leer muchas filas usa los helpers de paginación (`src/lib/supabase-paginate.ts`).
- Muchos lugares hacen `res.data || []`, y un timeout se convierte en **una lista vacía sin error**: un desplegable sin opciones, un informe en cero. Ante un «vacío raro», sospecha primero de un timeout (`motivo: error_consulta`).
- **Tras un reinicio o restauración de la base**, las estadísticas se resetean y autovacuum deja de visitar las tablas grandes. Ejecuta `VACUUM (ANALYZE)` sobre `report_utm.lead_events`, `report_utm.pixel_events`, `public.ads_daily` y `public.metricas_diarias`. VACUUM simple es seguro en caliente; **VACUUM FULL no**.
- **Si la Data API devuelve 503 en masa:** para primero el `sync-worker` (Dokploy → Stop) y pausa el workflow `sync-fallback`. Reintentan sin backoff y realimentan la caída. **No lo dejes parado más de un día**: es el único que refresca los tokens de Meta (02:00, hora Colombia). El estado real se comprueba en `/v1/projects/{ref}/health`; el panel puede decir `ACTIVE_HEALTHY` estando caído.

### 4.5 Trampas de datos conocidas

- **`ads_daily` tiene huecos por dentro de su rango.** `adsDailySinHuecos` (`src/lib/report-utm/bi-query.ts`) cae al JSONB de `metricas_diarias` si falta algún día con gasto. Para comparar las dos fuentes, fija `BI_ADS_SOURCE=jsonb`.
- **El embed `cliente_tabs → clientes` es ambiguo.** Nombra siempre la FK (`clientes!cliente_tabs_cliente_id_fkey`) o PostgREST devuelve 300.
- **Los vacíos de `lead_events` son `NULL`**, nunca cadena vacía.
- **Los leads ya no escriben en `pixel_events`** ni pasan por `resolveAttribution`, porque `visitor_id` está vacío en el 100 % de las filas. El resolver sigue activo para ventas. Su cabecera explica qué habría que hacer para reactivarlo en leads.
- **`page_url` se guarda sin los parámetros UTM** (`normalizarPageUrl`), pero conserva a propósito los parámetros propios del cliente.
- **Los meses cerrados están congelados** (`periodos_cerrados`, día 7 de cada mes): el worker no los reescribe. Para reabrir un mes, borra su fila.
- **Zona horaria:** todo el sistema agrupa por día de Colombia (UTC−5). Chile (Cris) va 1–2 h por delante. `src/lib/zona-horaria.ts` existe pero **no está activado**: activarlo es un cambio del módulo entero, con recálculo.

### 4.6 Borrado de clientes

Borrar un cliente borra **todo lo suyo** en los dos esquemas. Es una decisión explícita del 2026-09-14. Siempre pasa por `eliminarClienteCompleto`. Archivar es la vía para ocultar sin perder datos. Borrar un usuario dueño de clientes está **bloqueado** (FK `RESTRICT`, migración 081). Ver [doc 23](./23-runbook-empalme.md).

---

## 5 · Integraciones

| Integración | Autenticación | Frecuencia | Código | Nota |
| --- | --- | --- | --- | --- |
| Meta Ads | OAuth (`META_APP_ID/SECRET`) | 05:00 y 14:00; reconciliación los domingos | `/api/worker`, `src/lib/sync/reconcile.ts` | Tokens de ~60 días que refresca el worker. Atribución fija `7d_click + 1d_view` |
| Meta Lead Ads | Webhook (`META_WEBHOOK_VERIFY_TOKEN`) + sync de respaldo | Tiempo real | `/api/report-utm/webhooks/meta`, `src/lib/report-utm/meta-leads.ts` | Las Páginas se suscriben por cliente |
| TikTok Ads | OAuth | Diaria | `/api/worker` | |
| GA4 / Google Sheets | Service account (`GOOGLE_SERVICE_ACCOUNT_*`) | Diaria, un job por cliente | `src/lib/integrations/` | La clave PEM va con `\n` escapados; si no, da `invalid_grant` |
| Google Ads | OAuth + developer token | — | `src/lib/report-utm/google-conversions.ts` | Conversiones offline |
| Hotmart | OAuth HotConnect (tokens de vida corta, refresco cada 2 h) + webhook con hottok | Diaria + reconciliación diaria | `src/lib/hotmart/`, `/api/worker/hotmart` | Ver abajo |
| GoHighLevel | Token por location | Webhook + sync de respaldo | `src/lib/report-utm/ghl-*.ts`, [doc 20](./20-integracion-gohighlevel.md) | Ventas por Workflow «Opportunity Won» |
| WhatsApp | Evolution API o `whatsapp-gateway` | Alertas y agente | `src/lib/whatsapp/` | Mensajes entrantes firmados con HMAC (`AGENT_INBOUND_SECRET`) |
| LLM del agente | **OpenRouter** (`OPENROUTER_API_KEY`) | Bajo demanda | `src/lib/agent/llm/client.ts` | 3 niveles de modelo con cadena de reserva, configurables desde la base sin desplegar |
| MCP | Token de API | Bajo demanda | `/api/mcp` | El staff lo usa desde Claude sin coste de API |
| FX | API pública (fawazahmed0) | Captura diaria | `src/lib/fx.ts` | Tabla `fx_rates` |
| Correo | Gmail con contraseña de aplicación | — | `src/lib/email.ts` | |

**Hotmart. Hechos verificados que no se deducen del código:**

- `sales/history` **sin lista de estados devuelve solo `COMPLETE`**. `ESTADOS_API_SYNC` debe quedarse. Un estado inválido tumba la petición entera (el correcto es `PRINTED_BILLET`, no `BILLET_PRINTED`).
- La API filtra por fecha de **orden**, no de aprobación. Por eso existe la reconciliación diaria.
- **El webhook de Hotmart no se configuró nunca** en ningún cliente.
- **Septiembre de 2026 sin ventas en Cris es real**, no un fallo.
- Las 88 ventas antiguas no tienen la tupla UTM. Para rellenarla: `npm run backfill:hotmart` sobre julio y agosto.

**Moneda.** Cris reporta en CLP. Hay **10 tasas CLP antiguas mal fechadas que se dejan así a propósito**: corregirlas descuadraría las ventas ya guardadas. Antes de activar otra moneda en un cliente, rellena `fx_rates` con `scripts/backfill-fx-historico.ts`.

**El agente no puede usar una suscripción de Claude.** Lo prohíben los términos de Anthropic. El coste de API irreducible es el de WhatsApp.

---

## 6 · Operación diaria

- **Pantallas de diagnóstico:** `/admin/salud`, `/admin/sync` y `/cruce-campanas`. Por consola: `npm run diagnostico`.
- **¿El worker está vivo?** Ejecuta `select ejecutor, count(*), max(started_at) from sync_runs where started_at > now() - interval '1 hour' group by 1;`. Debe aparecer `vps`.
- **Horarios del worker** (hora Colombia): 05:00 y 14:00 plan diario · 02:00 tokens de Meta · cada 2 h tokens de Hotmart · domingo 03:00 reconciliación · día 7, 03:00 cierre de mes.
- **Runbook de incidencias:** [doc 23](./23-runbook-empalme.md). Cubre informes vacíos, leads excluidos, sync caída, cuenta de Meta parada y ventas del CRM.
- **Operaciones con `curl`:** [doc 14](./14-cron-y-workers.md), al final (encolar un plan, resincronizar un rango, cerrar un mes).

---

## 7 · Pruebas y calidad

- **No hay Jest ni Vitest.** Las pruebas son scripts `scripts/verify-*.ts` que se ejecutan con `npx tsx --conditions=react-server …`. Sin ese flag, `server-only` revienta (también en los `execSync` anidados).
- `npm run test:puro`: ~50 verificaciones sin base de datos (reglas, parsers, seguridad, agente, MCP).
- `npm run test:datos`: ~16 verificaciones **contra la base de PRODUCCIÓN, en solo lectura**. Incluye el **golden** (`scripts/verify-bi-golden.ts` contra `scripts/golden/bi-baseline.json`), que congela cifras de informes reales.
  - Si falla con `statement timeout` o `[paginate] página fallida`, es transitorio (instancia Micro): relánzalo.
  - **Nunca recaptures el golden entero** sin revisar el log.
  - Los ingresos de Hotmart de Cris ×~920 son la conversión a CLP, no un error.
- `npm run validate`: type-check + ESLint (0 warnings) + Prettier. Es lo único que corre en el CI (`.github/workflows/validate.yml`).
- Un `next build` que falla con timeouts de 60 s en páginas estáticas que no has tocado suele ser la caché fría: relánzalo antes de culpar a tu cambio.

---

## 8 · Decisiones de producto que NO hay que «arreglar»

| Parece un bug | Por qué es así |
| --- | --- |
| «Somos rentable» y «Sur Profundo» tienen cifras de Meta idénticas | Comparten Sheet y cuenta de Meta a propósito |
| Los leads de Meta ≠ los contactos recibidos | Son dos métricas distintas (atribuidos por Meta frente a `lead_events`) con rótulos propios (`src/lib/leads/fuentes-de-lead.ts`). No cuadran día a día |
| La pestaña del dashboard ya no se recorta a su «rango de captación» | Decisión del 2026-09-28: manda el calendario. La ventana solo alimenta presupuesto y ritmo (`scripts/verify-rango-captacion.ts`) |
| Filtrar o agrupar por una respuesta de formulario deja el gasto en «—» | Es correcto: el gasto no se reparte por respuestas. Medir con la respuesta como métrica (`lf__…`) sí permite CPL. Ver [doc 24](./24-respuestas-de-formulario.md) |
| Hay menos leads de los recibidos | La regla «Qué leads cuentan» excluye los que no tienen atribución. Están en `/leads` → Excluidos |
| `/p/<token>` no se puede embeber en un iframe | La regla catch-all de `next.config.ts` gana a las de `/p/` y `/report/`. Se dejó así por seguridad (clickjacking); cambiarlo es decisión de producto |
| Los grupos de campaña siempre salen vacíos | Las tablas existen (077), pero **no hay ni UI ni código de escritura**. Si se piden grupos, hay que construir la escritura entera |
| Goodprop desconectado, Eduversio sin campos de lead | Intencional (sus formularios solo piden nombre y correo) |

---

## 9 · Deuda técnica

| Área | Problema | Sugerencia |
| --- | --- | --- |
| Componentes gigantes | `LayoutConfigModal.tsx` (3.145 líneas), `DashboardClient.tsx` (2.920), `MetricCharts.tsx` (1.214), `QuickEditModal.tsx` (966), `TabConfigModal.tsx` (945). En `src/lib`: `bi-metadata.ts` (>2.100), `google-sheets-conversiones.ts` (>2.000), `bi-query.ts` (>1.700) | Trocear al tocar cada zona, sin gran refactor de golpe |
| Dos motores de métricas | El dashboard (`formula-engine` + `metric-catalog`) y el BI (`bi-metadata` + `bi/sources`) calculan lo mismo por caminos distintos. Los tests de paridad (`verify-lead-segmentos-db`, `verify-mcp-paridad`) los mantienen alineados | A medio plazo, un único catálogo de métricas |
| Fallos silenciosos | El patrón `res.data \|\| []` convierte errores y timeouts en vacíos | Registrar el error y mostrar «no se pudo cargar» |
| Pruebas | Scripts ad hoc; `test:datos` depende de producción | Base de staging o rama de Supabase con datos anonimizados; runner estándar |
| Migraciones | Sin registro de aplicadas y con números duplicados | Adoptar `supabase migration` o una tabla `schema_migrations` propia |
| Observabilidad | Solo logs JSON y `sync_runs`; sin Sentry ni alertas de la base | Sentry + alerta de salud de Supabase + uptime de `/api/health` |
| Atribución web | `visitor_id` vacío: la cascada multi-touch no funciona para leads | Poblar `visitor_id` desde el píxel antes de reenchufar `resolveAttribution` |
| Zona horaria por cliente | Preparada, sin activar | Solo con un plan de recálculo completo |
| Dependencias | 5 PR de Dependabot abiertas (recharts 3, react-day-picker 10, lucide 1.x: son versiones mayores) | Revisar una por una. **Next 16.3 cambia APIs**: lee `node_modules/next/dist/docs/` antes de tocar código de Next (ver `AGENTS.md`) |
| Tipos | `@types/node` 20 con motor 22 | Subir a `@types/node` 22 |

---

## 10 · Documentación desactualizada

La carpeta `docs/` es buena y detallada, pero tiene restos de la época de Vercel:

- `docs/02-arquitectura.md`: dice «Deploy: Vercel», «migraciones 001…020» y «van por la 081»; menciona el route group `(report-utm)`, que ya no existe.
- `docs/15-despliegue.md`: dice que «no hay suite de tests» (sí la hay) y que `/p/*` y `/report/*` son embebibles (no lo son, ver apartado 8).
- `sync-worker/README.md`: «La app está en Vercel plan Hobby»; faltan los horarios de tokens y reconciliación.
- `.github/workflows/validate.yml`: **Node 20**, cuando debe ser `22.12` o superior.
- `.env.example`: el comentario «Activa el módulo report-utm» no tiene variable debajo (restos).
- Comentarios de `maxDuration` y del límite de 60 s: inertes en Docker.

---

## 11 · Plan recomendado para las dos primeras semanas

**Día 1 (sin tocar código)**

1. Empujar la rama: `git push origin unificacion-reporting-utm`.
2. Recibir todos los accesos del apartado 12 y comprobar que funcionan.
3. Levantar el entorno local: Node ≥ 22.12, `.env.local` a partir de `.env.example`, `npm run dev`. Pasar `npm run validate` y `npm run test:puro`.

**Semana 1**

4. Subir el cómputo de Supabase (Small o Medium). Pide aprobación del gasto al dueño.
5. Aplicar la **085** (segura).
6. Ejecutar el backfill de la **084** (`scripts/backfill-page-url.ts`) fuera de horas punta.
7. Cambiar el CI a Node 22.
8. Revisar la rama `unificacion-reporting-utm`, pasar `test:datos` y fusionar a `main` con aviso a los clientes del cambio de moneda.

**Semana 2**

9. Aplicar la **082** + `backfill-ids-leads.ts`, y ejecutar `migrar-respuestas-lead.ts --aplicar`.
10. Poner monitorización (uptime de `/api/health`, alertas de Supabase, Sentry).
11. Actualizar la documentación del apartado 10.
12. Decidir con el dueño: webhook de Hotmart por cliente, embebido de `/p/`, grupos de campaña.

---

## 12 · Accesos y secretos a traspasar

Checklist. Pasadlos por un gestor de contraseñas, **nunca** por chat ni por el repositorio.

- [ ] **GitHub**: repositorio (admin) y secret `CRON_SECRET` de Actions.
- [ ] **Supabase**: organización y proyecto `dfdeizrbkpdocgckqlel` (facturación incluida), `SUPABASE_ACCESS_TOKEN` personal para `sql-remoto.ts`.
- [ ] **VPS + Dokploy**: acceso al panel y SSH; las dos Applications (app y worker) con sus variables.
- [ ] **Dominio y DNS** de `reportes.adshouse.cloud`.
- [ ] **Meta for Developers**: app, `META_APP_SECRET`, token de verificación del webhook.
- [ ] **TikTok for Business**: app.
- [ ] **Google Cloud**: service account (Sheets/GA4), cliente OAuth y developer token de Google Ads.
- [ ] **Hotmart**: app de HotConnect.
- [ ] **OpenRouter**: cuenta y API key (con límite de gasto).
- [ ] **WhatsApp**: Evolution API o el gateway, más el número y el grupo del equipo.
- [ ] **Gmail**: cuenta y contraseña de aplicación.
- [ ] **`RUTM_ENCRYPTION_KEY`**: **crítica**. Si se pierde, todos los tokens cifrados de la base quedan inservibles.
- [ ] Locations de GoHighLevel de cada cliente y sus Workflows.

---

## 13 · Dónde está cada tema

| Tema | Documento |
| --- | --- |
| Visión general y glosario | [01](./01-introduccion.md), [02](./02-arquitectura.md) |
| Instalación y variables | [03](./03-instalacion-y-configuracion.md), `.env.example`, `sync-worker/.env.example` |
| Modelo de datos | [04](./04-modelo-de-datos.md) + las cabeceras de cada migración (muy explicativas) |
| Auth y roles | [05](./05-autenticacion-y-roles.md) |
| Rutas y API | [06](./06-rutas-y-paginas.md), [07](./07-api-rest.md) |
| Integraciones | [08](./08-integraciones.md), [20](./20-integracion-gohighlevel.md), [21](./21-auditoria-utms-ghl.md) |
| Fórmulas y layouts | [09](./09-motor-de-formulas.md), [10](./10-sistema-de-layouts.md) |
| Leads, UTM, BI | [12](./12-modulo-report-utm.md), [16](./16-campos-de-sheet.md), [17](./17-campos-de-lead.md), [18](./18-fuentes-y-cruces.md), [19](./19-guia-segmentos-de-lead.md), [24](./24-respuestas-de-formulario.md) |
| MCP y agente | [13](./13-mcp-y-tokens-api.md), [22](./22-plantilla-agente-interno.md) |
| Workers y despliegue | [14](./14-cron-y-workers.md), [15](./15-despliegue.md) |
| Incidencias | [23](./23-runbook-empalme.md) |

> Consejo: muchos archivos tienen una cabecera que explica **por qué** el código es así, con el incidente que lo motivó. Antes de simplificar algo que parece raro, lee su cabecera y la migración relacionada. Casi todo lo raro tiene una historia detrás.
