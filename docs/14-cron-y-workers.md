# 14 · Cron jobs y workers

## El problema que resuelve esta arquitectura

Sincronizar Meta + TikTok + Hotmart + GA4 para todos los clientes no cabe en una
petición HTTP: Hotmart y GA4 se consultan **día a día**, así que un rango de un
mes son cientos de peticiones. Cuando se intentaba de una sola vez, la petición
se cortaba por tiempo y, en lugar de terminar ordenadamente, el proceso moría a
mitad del upsert y dejaba datos parciales sin rastro. Además, la plataforma no
programa crons: alguien tiene que dispararlos.

La solución tiene tres piezas:

1. **Cola en Postgres** (`public.sync_jobs`) — el trabajo se trocea en unidades
   reanudables con cursor persistido.
2. **Worker self-hosted** (`sync-worker/`) — proceso permanente en el VPS, sin
   límite de tiempo, que drena la cola y ejecuta el scheduler.
3. **Endpoint de respaldo en la propia app** — por si el worker está caído.

> **La plataforma (Dokploy) no impone ningún límite de tiempo.** Los topes que
> existen son presupuestos propios del código: cada ruta de sync corta limpio y
> persiste su cursor, y el techo del ejecutor de respaldo lo fija
> `RUNJOBS_BUDGET_MS` (ver abajo).

## Quién ejecuta: `sync_runs.ejecutor`

Es el termómetro de si el worker principal está vivo, y la primera consulta que
hay que hacer cuando la cola se llena de errores:

```sql
select ejecutor, count(*), max(started_at)
from sync_runs where started_at > now() - interval '1 hour' group by 1;
```

| Valor | Quién                                                            |
| ----- | ---------------------------------------------------------------- |
| `vps` | `sync-worker/` — el ejecutor **principal**, sin límite de tiempo |
| `app` | `/api/worker/run-jobs` — el ejecutor de **respaldo**             |

Cualquier otro valor sólo puede salir en filas antiguas, anteriores a la
migración 102: no debería aparecer en filas nuevas.

Si sólo aparece `app`, el worker no está drenando y toda la carga recae en el
respaldo. Eso no rompe nada de inmediato, pero es lo que precedió a los 183
timeouts de julio–agosto de 2026: el respaldo trabaja a tandas cortas y los
rangos largos no le caben.

## Presupuestos del ejecutor de respaldo

| Variable                     | Default | Para qué                                                              |
| ---------------------------- | ------- | --------------------------------------------------------------------- |
| `RUNJOBS_BUDGET_MS`          | 240000  | Techo REAL del ciclo de drenado                                       |
| `RUNJOBS_REQUEST_TIMEOUT_MS` | 120000  | Timeout de cada llamada a un endpoint de sync                         |
| `RUNJOBS_LEASE_SECONDS`      | 300     | Debe **superar** al budget (si no, dos ejecutores toman el mismo job) |

El runner acota el timeout de cada job a lo que queda del budget, así que el
budget no puede convertirse en budget+timeout. Y no reclama un job si no le
quedan al menos 60 s: por debajo de eso el aborto era seguro y sólo servía para
quemarle un intento a un job sano.

### Plazo de reintentos por petición (`conDeadline`)

Los reintentos ante 429/5xx (`withRetry`, `src/lib/rate-limit.ts`) paran al llegar a
un plazo. Ese plazo era una variable **global del proceso**: `/api/worker` la fijaba
a ahora + 50 s y, en el servidor de larga duración del VPS, `/api/worker/hotmart`
—que nunca la toca— heredaba el plazo ya vencido y se quedaba sin reintentos. Ahora
cada ruta abre el suyo con `conDeadline(instante, fn)` (un `AsyncLocalStorage`):
50 s en `/api/worker`, 45 s en `/api/worker/hotmart` y en `/api/worker/reconcile`.
`setRetryDeadline` dentro de ese contexto solo ajusta el de la petición; fuera, sigue
siendo global, así que el código nuevo debe usar `conDeadline`.

Además, cada **intento** de una llamada a Hotmart lleva su propio timeout de 20 s
(`HOTMART_TIMEOUT_MS`) y la petición de token uno de 15 s (`TIMEOUT_TOKEN_MS`): sin
ellos, una conexión que Hotmart dejaba colgada colgaba la corrida entera en el VPS,
que no tiene el tope de 60 s. Y el memo de tasas de cambio (`getUsdRate`) solo
recuerda **10 minutos** un resultado sin la tasa del día (`none` o `stale`): antes, una
API de FX caída cinco minutos dejaba esa moneda sin convertir hasta el siguiente
reinicio del proceso.

## Autenticación

Todos los endpoints de cron/worker exigen:

```
Authorization: Bearer $CRON_SECRET
```

El mismo secreto va configurado en el entorno de la app (Dokploy) y en el `.env`
del `sync-worker`. Debe coincidir **carácter a carácter**: si no, el worker
reclama jobs y todos le responden 401.

## Zona horaria

La operación es en **Colombia (`America/Bogota` = UTC−5 fijo, sin horario de
verano)**. El scheduler del `sync-worker` acepta la zona horaria directamente
(`TZ_OPERACION`), así que los horarios se escriben en hora local sin convertir. El cálculo de fechas de calendario
usa `colombiaToday()` / `colombiaYesterday()` de `src/lib/date-utils.ts`, y los
presets del dashboard hacen lo mismo — antes usaban la hora del navegador, así
que un usuario fuera de UTC−5 pedía días que en Colombia aún no existían.

`src/lib/zona-horaria.ts` prepara una zona **por cliente** (`config.zona_horaria`),
pero **no está activada** y no tiene consumidores. La cuenta de Meta de Cris
tributario está en `America/Santiago`, así que sus ventas entre las 22:00 y las
24:00 de Chile caen en el día siguiente respecto al gasto. No se arregla solo para
Hotmart: los leads se agrupan en SQL con `AT TIME ZONE 'America/Bogota'`, y cambiar
solo las ventas desalinearía ventas y leads del mismo día. Activarlo es un cambio de
todo el módulo a la vez, con recálculo de `hotmart_ventas.fecha_venta` y reagregado.

## Componentes

| Componente                  | Dónde corre | Qué hace                                                         |
| --------------------------- | ----------- | ---------------------------------------------------------------- |
| `sync-worker/`              | VPS         | Scheduler + drena la cola continuamente. **Ejecutor principal.** |
| `POST /api/worker/enqueue`  | app         | Crea los jobs (planner). No ejecuta nada.                        |
| `POST /api/worker/run-jobs` | app         | Drena la cola. **Ejecutor de respaldo.**                         |
| `GET /api/worker`           | app         | Sincroniza métricas de un rango. Lo invoca el runner.            |
| Webhooks `report_utm`       | app         | Tiempo real: ventas de Hotmart y GHL, leads de Meta y GHL.       |

## Quién dispara los crons

La plataforma no programa nada: no hay ningún archivo de crons en el
repositorio. Los dos que sostienen el sistema:

| Endpoint                        | Quién lo dispara                                        |
| ------------------------------- | ------------------------------------------------------- |
| `/api/cron/refresh-meta-tokens` | Scheduler del `sync-worker` (`0 2 * * *`, hora 🇨🇴)      |
| `/api/worker/run-jobs`          | Poll continuo del `sync-worker` + el workflow de GitHub |

`refresh-meta-tokens` es el crítico: sólo está programado en el scheduler del
worker, y sin él los tokens caducan a los ~60 días y todos los clientes de Meta
quedan desconectados sin aviso. Ver
[doc 15](./15-despliegue.md#6--quién-dispara-los-crons).

## Horarios del sync-worker (hora Colombia)

| Hora           | Plan             | Encola                                                                                                                                                                          |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 05:00          | `diario`         | Métricas de ayer y hoy (todos los clientes) + Sheets (**un job por cliente**) + Meta Leads + leads y oportunidades de GoHighLevel + leads de TikTok + reconciliación de Hotmart |
| 14:00          | `diario`         | Segunda pasada: recoge las correcciones de atribución del día                                                                                                                   |
| día 7, 03:00   | `cierre_mes`     | Re-descarga forzada del mes anterior (ventana de 35 días) y congelado                                                                                                           |
| domingo, 03:00 | `reconciliacion` | Audita el gasto de Meta contra el real de cada cuenta y repara los días con desglose incompleto                                                                                 |

Los planes `diario` y `reconciliacion` encolan además un `hotmart_reconciliar` por
cliente con Hotmart: la reconciliación de Hotmart es **diaria** desde el 2026-09-25
(antes solo el domingo). Ver [`/api/worker/hotmart`](#apiworkerhotmart--backfill-reclasificación-y-reconciliación-de-hotmart).

Y dos entradas que no encolan nada: llaman directamente a un endpoint de cron.

| Hora     | Endpoint                           | Para qué                                                                      |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| cada 2 h | `/api/cron/refresh-hotmart-tokens` | Los tokens de HotConnect son de vida corta                                    |
| 02:00    | `/api/cron/refresh-meta-tokens`    | Único planificador de este endpoint; sin él los tokens caducan a los ~60 días |

Además hace _poll_ de la cola cada 15s, que es lo que hace que el botón
"Sincronizar" del dashboard responda en segundos.

## Cómo funciona la cola

`claim_sync_job()` usa `FOR UPDATE SKIP LOCKED`: si el worker y el ejecutor de
respaldo intentan tomar un job a la vez, el segundo salta al siguiente en lugar
de duplicar el trabajo. Es el mutex que faltaba entre el sync manual y el cron.

Si un ejecutor muere (deploy, OOM, corte del proxy), el **lease** del job vence
y vuelve a la cola. Como el cursor está persistido y los upserts son
idempotentes, solo se repite la unidad en curso.

Estados: `pending` → `running` → `done` | `error`. Un fallo con intentos
restantes vuelve a `pending`; al agotar `max_intentos` queda en `error` y genera
notificación.

El runner descarta de entrada un job cuyos `intentos` ya superen `max_intentos`.
Hace falta porque `claim_sync_job` incrementa el contador **también** al recuperar
un job con el lease vencido, y ese camino no pasa por `failJob`, que es quien
decide el salto a `error`: un ejecutor que muere sin responder dejaba el job
girando y el contador crecía sin techo (se vio un `7/3` en el panel).

Un job vale como `done` solo si el worker devuelve 2xx **y** el cuerpo no trae
`ok: false`. Los workers que iteran clientes por dentro atrapan el fallo de cada
uno para que un cliente roto no tumbe a los demás, así que un 200 no prueba que
se haya escrito nada: cuando ninguno se completa lo declaran con `ok: false` y
el runner lo trata como fallo.

`limpiarHistorial` purga a los 30 días los jobs `done`, `cancelled` **y**
`error`. Los fallidos se incluyen porque el planner encola uno nuevo en cada
franja: pasado su día ya no son accionables y solo entierran el problema de hoy
bajo las lápidas de las semanas anteriores.

Al terminar deja una fila `purga` en `public.mantenimiento_log` (migración 101).
`/api/worker/health` alerta si pasan más de 36 h sin ella, y también por tamaño y
crecimiento de la base: ver [doc 27](./27-alertas-y-staging.md).

Tipos de job: `metricas`, `sheets_conversiones`, `meta_leads`, `ghl_leads`,
`utm_aggregate`, `cierre_mes`, `reconciliar`, `hotmart_ventas` (backfill o
reclasificación) y `hotmart_reconciliar`; los dos últimos van a
`/api/worker/hotmart`. El tipo `sheets_leads` ya no se
encola (migración 059) pero sigue reconocido: `sync_jobs` puede tener filas
históricas con él y el runner las enruta al worker de conversiones.

`ghl_leads` (migración 074) trae los contactos de GoHighLevel a
`report_utm.lead_events` vía `/api/cron/sync-ghl-leads`. No lleva rango de
fechas: su cursor es el `dateAdded` del último contacto visto y vive en
`integrations.config.sync_cursor`, no en el job. Es la red de seguridad del
webhook por cliente y el backfill de 90 días.

## Workers

### `/api/worker` — sincronizador de métricas

Para cada cliente y cada día del rango:

1. **Meta Ads**: insights a nivel campaña/anuncio/conjunto, formularios de leads,
   demografía. Ventana de atribución fija en `7d_click` + `1d_view` para que el
   número signifique lo mismo en todas las cuentas.
2. **TikTok Ads**: reportes a nivel campaña/anuncio/grupo.
3. **Hotmart**: historial en **todos los estados** (`ESTADOS_API_SYNC`; sin esa
   lista la API solo devuelve los `COMPLETE`, ver
   [doc 08](./08-integraciones.md#estados-que-se-piden-a-la-api)) + comisiones. Se
   guardan en `hotmart_ventas` y el día se agrega desde la tabla, **convertido a
   USD** con las tasas de `fx_rates`. Si una aprobación movió una venta a otro día,
   la fecha vieja se reagrega al final de la corrida (`fechasTocadas`): si no, la
   venta contaba en los dos días.
4. **GA4**: sesiones y eventos (si está configurado).
5. `upsert` en `metricas_diarias`.

Params: `date` | (`start` + `end`) | `client_id` | `force=1` | `refresh_days=N`.
Sin params sincroniza "ayer" en hora Colombia.

**Red de seguridad**: si una API falla o devuelve cero donde la BD ya tenía
datos, los campos de esa fuente se **omiten** del upsert en lugar de escribir
ceros. Aplica a las cuatro fuentes (antes solo a Meta y TikTok, así que un fallo
de Hotmart o GA4 borraba ventas y sesiones reales).

En Hotmart la decisión vive en `src/lib/hotmart/guarda.ts` (`decidirGuardaHotmart`,
pura y probada). Si la descarga no vino completa, no se agrega nada. Si vino
completa, para las fechas que `hotmart_ventas` ya cubre (desde la primera
`fecha_venta` del cliente) **la tabla manda y su cero es real**: un día cuyo único
pedido se reembolsó, o del que una venta se movió al aprobarse. La guarda de
cero/caída (cero con datos previos, o menos del 60 % de 5 o más transacciones
previas) solo protege las fechas anteriores, heredadas del worker viejo. Los
reembolsos cuentan como «hubo datos»: antes un día con solo reembolsos se tomaba por
fallo y conservaba para siempre la facturación devuelta.

### `/api/worker/google-sheets-conversiones` — conversiones offline

Sincroniza conversiones offline hacia `conversiones_offline` y
`conversiones_offline_diarias`.

Params: `client_id` (lo que encola el planner: **un job por cliente**) y
`sheet_id` para acotarlo a un documento. El rango de fechas del job **no se
usa** — un Sheet se lee entero siempre, porque su verdad es el documento y no
una ventana temporal; el rango viaja en el job solo para situar la corrida en el
panel.

Escribe por **UPSERT** contra la clave natural `(cliente_id, sheet_id, tab_name,
fila_num)` comparando un hash del contenido (migración 069): la fila que no
cambió no se toca, así que un sync sobre un Sheet estable escribe cero filas. El
borrado ya no es "todo lo que no lleve el lote de hoy" sino "las filas de esta
pestaña cuyo número ya no existe", y solo se poda una pestaña que se haya leído
entera. `conversiones_offline_diarias` sí conserva el reemplazo por
`sync_batch_id`: son pocas filas y su clave única propia lo hace barato.

> ⚠ El código y la migración 069 son inseparables: sin las RPC en la base, cada
> escritura falla con `Could not find the function ...upsert_lote`. Ocurrió entre
> el 11 y el 12 de agosto de 2026 — el código se desplegó y la migración no se
> aplicó, y las tres hojas estuvieron dos días escribiendo cero filas.

Devuelve **500** si ningún cliente se completó y 200 con `parcial: true` si unos
sí y otros no. Antes devolvía 200 pasara lo que pasara: el runner solo mira el
estado HTTP, así que marcaba el job `done` y la cola se veía verde mientras no se
escribía una sola fila.

Cada cliente puede tener **varios sheets** y cada sheet **varias pestañas**, con
su propio mapeo de columnas (`config_api.google_sheets_conversiones[].tabs[]`;
las configs con el mapeo plano anterior se convierten al vuelo en `normalizeTabs`
y siguen funcionando sin migrar el JSONB).

El reemplazo es **por sheet**, no por cliente: las filas llevan `sheet_id` y
`tab_name` y el borrado del lote anterior filtra por `sheet_id`. Antes, si un
sheet fallaba en un sync con varios, el replace se hacía igual con las filas de
los demás y los datos del sheet caído se borraban en silencio. Al final del
cliente, `cleanupOrphanConversiones` retira lo que ya no pertenece a ningún sheet
configurado (incluidas las filas previas a la trazabilidad, con `sheet_id` NULL).

Cada corrida deja un registro en `conversiones_offline_sync_log` (filas ok,
descartadas por fecha inválida o cantidad ≤ 0, y avisos por pestaña), que la UI
de `/admin/settings` muestra bajo cada sheet.

### `/api/worker/hotmart` — backfill, reclasificación y reconciliación de Hotmart

Params: `cliente_id`, `desde` (def. `hasta` − 30 días), `hasta` (def. hoy) y `modo`,
que el runner pone según el job:

| Modo           | Job                                        | Qué hace                                                                                  |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `backfill`     | `hotmart_ventas`                           | Descarga el rango a `hotmart_ventas`, día a día y **hacia delante**                       |
| `reclasificar` | `hotmart_ventas` con `params.reclasificar` | Reescribe `tipo`/`tab_id` leyendo la tabla. Cero peticiones a la API                      |
| `reconciliar`  | `hotmart_reconciliar`                      | Reembolsos de 90 días + barrido de aprobaciones tardías + atribución por lead (ver abajo) |

**Los tres reagregan** `metricas_diarias` en las fechas que cambian
(`reagregarFechasHotmart`), salvo los meses de `periodos_cerrados` y sin tocar los
campos de GA4 que conviven en `hotmart_funnel_data`. Antes solo tocaban
`hotmart_ventas` y el dashboard seguía con la foto vieja; la reconciliación incluso
devolvía las fechas a reagregar y nadie las usaba.

**La reconciliación corre a diario**, no solo el domingo: `sales/history` filtra por
fecha de **orden**, así que un reembolso de hoy sobre una compra de hace dos semanas
no aparece nunca en la sync del día, y esperar al domingo dejaba hasta siete días
de facturación inflada. En cada corrida:

1. **Reembolsos** (`reconciliarReembolsos`, 90 días): compara el estado de la API con
   el guardado, leyendo por lotes de 200 en vez de un SELECT por transacción. El
   UPDATE es condicional sobre el estado leído (si el webhook lo cambió entre medias,
   no lo pisa), **`evento_ts` nunca retrocede** —antes se escribía `approved_date` y un
   reintento tardío del `PURCHASE_APPROVED` resucitaba la venta— y `reembolsada_at` es
   la fecha en que se **ve** reembolsada (la API no da la del reembolso), conservando
   la primera.
2. **Aprobaciones tardías** (`barrerAprobacionesTardias`): vuelve a pedir los últimos
   3 días. Un pago aprobado días después de la orden (boleto, pix, transferencia) no
   entraba nunca por la sync diaria, que solo re-pide ayer y hoy.
3. **Atribución por lead** de los últimos 30 días (`reatribuirGuardadas`), para las
   ventas cuyo lead llegó después. Solo con la migración 089 aplicada; no cambia los
   totales diarios.

**Respuesta.** Habla el idioma del runner: `results` (uno por cliente, con `status`
`ok` | `error` | `skipped_budget`), `debugLogs`, `filas_escritas`, `partial` y
`resumeFrom`. Antes devolvía `resultados`/`logs` y `sync_runs` marcaba 0 filas
escritas en todas las corridas; el runner ahora toma `filas_escritas` del cuerpo
cuando el worker lo trae. Devuelve `ok: false` si ningún cliente salió bien (antes,
`ok: true` aunque fallaran todos). Presupuesto de 45 s: al agotarse, los clientes que
faltan salen como `skipped_budget`, y un backfill de un solo cliente cortado a medias
devuelve `resumeFrom` para que el runner reencole `resumeFrom → fecha_fin` sin
repetir lo hecho.

### `/api/cron/refresh-meta-tokens` / `refresh-hotmart-tokens`

Renuevan tokens antes de que caduquen (Meta < 10 días, Hotmart < 30 min). En Hotmart,
un refresco fallido relee la config antes de marcar la conexión como `expired`: si
otro proceso (el refresco en línea del worker) ya rotó el refresh token, el cliente
sale como `skipped_concurrent` y no como caído.

### Agregación UTM (retirada)

La ruta `/api/cron/report-utm/aggregate` ya no existe y el planificador no encola
`utm_aggregate` (el tipo se conserva en `sync_jobs_tipo_check` por las filas
históricas). Los informes leen `sales_events` y `lead_events` directamente.

### Leads de GoHighLevel, oportunidades de GHL y leads de TikTok

El plan diario encola además `ghl_leads`, `ghl_oportunidades` y `tiktok_leads`
(`src/lib/sync/planner.ts`). **Requiere la migración 094**: el `CHECK` de
producción no los admitía (ni siquiera `ghl_leads`) y el INSERT rechazado abortaba
el plan entero, así que la reconciliación diaria de Hotmart tampoco se encolaba.
Desde la auditoría del 2026-09-28 cada tipo se encola en su propio `try`: uno
rechazado se anota en `detalle` (`<tipo>_error`) y el resto sigue.

### `/api/cron/cierre-mes`

Congela un mes: copia las filas a `metricas_snapshots` y pone el candado en
`periodos_cerrados`.

### `/api/worker/reconcile` — auditoría del gasto (Meta y TikTok)

**El problema que resuelve.** Ninguna cifra de gasto del dashboard sale de las
columnas `meta_spend` / `tiktok_spend`: cuando una pestaña filtra por keyword, se
suman los elementos de `meta_campaigns[]` / `tiktok_campaigns[]` cuyo nombre
matchea (`src/lib/campaign-filter.ts`). Si un array quedó incompleto, el día
muestra **$0 aunque la cuenta sí gastó**, y como la fila "tiene datos" el worker
no la vuelve a pedir nunca. Así se perdieron ~$90.000 de un cliente en 3 días de
julio.

Dos orígenes conocidos de arrays incompletos:

1. Antes del 2026-06-23 el worker leía solo la **primera página** de Meta insights
   sin seguir `paging.next`: cualquier día con más de 500 filas de campaña perdía
   el resto en silencio. **TikTok nunca tuvo este fallo** — `fetchTikTokPaged`
   siguió `page_info.total_page` desde el principio y, ante un error, descarta la
   lista parcial en lugar de guardarla.
2. Una página que falla a mitad del rango deja ese día a medias.

Aunque TikTok no arrastra daño histórico conocido, comparte la misma estructura y
su ventana de refresco es de solo 3 días (frente a 7 de Meta), así que una fila
incompleta se congelaría aún antes. Por eso la auditoría cubre las dos.

**Cómo funciona.** Una sola llamada a nivel de cuenta por plataforma devuelve el
gasto real por día (1 fila/día, muy barato):

- Meta → `level=account, fields=spend, time_increment=1`
- TikTok → `data_level=AUCTION_ADVERTISER, dimensions=["stat_time_day"]`

Se compara con lo guardado y cada día se clasifica en `ok`, `fila_faltante`,
`array_incompleto` o `spend_desactualizado`. Con `heal=1` los días malos se
agrupan en rangos contiguos y se reencolan con `force=1&platforms=<plataforma>`
— así reparar 120 días de Meta no
arrastra 120 días de Hotmart (paginado) ni de GA4 (varias queries por día).

```bash
# Solo diagnóstico (no escribe nada)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker/reconcile?client_id=<uuid>&start=2026-07-01&end=2026-07-22"

# Diagnóstico + reparación
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker/reconcile?client_id=<uuid>&start=2026-07-01&end=2026-07-22&heal=1"

# Auditar solo una plataforma
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker/reconcile?client_id=<uuid>&platforms=tiktok"

# Todos los clientes, últimos 120 días (vía la cola)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker/enqueue?plan=reconciliacion"
```

La respuesta incluye `faltante_total_en_dashboard` (cuánto gasto real no está
reflejado) y desglosa el informe por plataforma. El día en curso se excluye de la
reparación: la plataforma va en vivo y la BD es del último sync, así que siempre
diverge.

**Prevención continua.** El worker ya no considera "ya descargada" una fecha cuyo
desglose no cuadre con su columna (`metaRowConsistent` / `tiktokRowConsistent`),
pide el gasto a nivel de cuenta en cada sync para detectar desvíos al vuelo
(alerta `spend_mismatch`), y el scheduler del VPS corre la reconciliación cada
domingo a las 03:00. En la Vista de Embudo Diaria los días afectados llevan un ⚠
en lugar de mostrar un $0 creíble.

### Parámetro `platforms` del worker

`GET /api/worker?...&platforms=meta` limita el sync a las fuentes indicadas (CSV:
`meta`, `tiktok`, `hotmart`, `ga4`). Las excluidas se marcan como fallidas, lo que
hace que el guard de preservación **omita sus columnas del upsert** en lugar de
escribir ceros. Es lo que hace viable un backfill amplio de una sola plataforma.

## Sync manual desde el dashboard

- **≤ 7 días** → ejecución directa, el usuario ve el resultado al momento.
- **> 7 días** → se encola troceado en unidades de 14 días. El botón muestra
  "En cola" y el trabajo continúa en segundo plano.

## Períodos congelados

El día 7 de cada mes se cierra el mes anterior: re-descarga forzada con
`refresh_days=35` (para recoger la reatribución tardía de Meta), copia de las
filas a `metricas_snapshots` y candado en `periodos_cerrados`. A partir de ahí el
worker **omite** esas fechas: un informe ya entregado no cambia.

Reabrir un período: borrar su fila en `periodos_cerrados` (el snapshot queda como
respaldo).

## Frescura de los datos

`metricas_diarias` guarda:

- `synced_at` — última verificación (cambiara el dato o no)
- `source_synced_at` — última verificación **exitosa por fuente**; si Meta
  funcionó pero Hotmart falló, solo avanza la clave `meta`. `/admin/salud` mide la
  frescura de Hotmart («Sync Hotmart») por `source_synced_at.hotmart`, no por la
  última venta: un mes sin ventas no es una fuente parada
- `is_partial` — la fecha es hoy, el día no ha cerrado y las cifras cambiarán

## Observabilidad

`sync_runs` guarda una fila por unidad ejecutada: duración, filas escritas,
estado por fuente y los `debugLogs` truncados. Antes esos logs solo viajaban en
la respuesta HTTP del cron, que nadie leía.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://reportes.adshouse.cloud/api/worker/run-jobs
curl http://vps:8080/status
```

## Operaciones frecuentes

```bash
# Forzar el plan del día
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker/enqueue?plan=diario"

# Re-sincronizar un rango concreto de un cliente
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"tipo":"metricas","cliente_id":"<uuid>","start":"2026-06-01","end":"2026-06-30"}' \
  "https://reportes.adshouse.cloud/api/worker/enqueue"

# Cerrar un mes a mano
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/cron/cierre-mes?start=2026-06-01&end=2026-06-30"

# Sync directo de un rango corto (sin pasar por la cola)
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://reportes.adshouse.cloud/api/worker?start=2026-05-01&end=2026-05-03&client_id=<uuid>"
```

## Por qué la cola sigue haciendo falta sin límite de tiempo

En Dokploy el ejecutor de respaldo ya puede correr minutos, y es tentador
apoyarse sólo en él. La cola sigue siendo la pieza central: es lo que da el
mutex entre ejecutores, la reanudación por tramos y el historial de
`sync_runs`. Subir presupuestos no sustituye nada de eso.
