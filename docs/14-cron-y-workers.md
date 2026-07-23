# 14 · Cron jobs y workers

## El problema que resuelve esta arquitectura

La app corre en **Vercel plan Hobby**, que impone dos límites duros:

- **60 segundos** por invocación de función
- **2 crons diarios** por proyecto

`vercel.json` llegó a declarar 9 crons y varias rutas pedían `maxDuration = 300`.
Eso no alarga nada: la función se corta igual a los 60s, pero los presupuestos
internos (270s, 250s, 240s) nunca disparaban, así que en lugar de terminar
ordenadamente el proceso moría a mitad del upsert. Sincronizar Meta + TikTok +
Hotmart + GA4 para todos los clientes no cabe en 60s — Hotmart y GA4 se consultan
**día a día**, así que un rango de un mes son cientos de peticiones.

La solución tiene tres piezas:

1. **Cola en Postgres** (`public.sync_jobs`) — el trabajo se trocea en unidades
   reanudables con cursor persistido.
2. **Worker self-hosted** (`sync-worker/`) — proceso permanente en el VPS, sin
   límite de tiempo, que drena la cola y ejecuta el scheduler.
3. **Endpoints de respaldo en Vercel** — por si el VPS está caído.

## Autenticación

Todos los endpoints de cron/worker exigen:

```
Authorization: Bearer $CRON_SECRET
```

El mismo secreto va configurado en Vercel y en el `.env` del `sync-worker`.

## Zona horaria

La operación es en **Colombia (`America/Bogota` = UTC−5 fijo, sin horario de
verano)**. Vercel Cron solo acepta UTC; el scheduler del `sync-worker` sí acepta
zona horaria directamente (`TZ_OPERACION`). El cálculo de fechas de calendario
usa `colombiaToday()` / `colombiaYesterday()` de `src/lib/date-utils.ts`, y los
presets del dashboard hacen lo mismo — antes usaban la hora del navegador, así
que un usuario fuera de UTC−5 pedía días que en Colombia aún no existían.

## Componentes

| Componente | Dónde corre | Qué hace |
|---|---|---|
| `sync-worker/` | VPS | Scheduler + drena la cola continuamente. **Ejecutor principal.** |
| `POST /api/worker/enqueue` | Vercel | Crea los jobs (planner). No ejecuta nada. |
| `POST /api/worker/run-jobs` | Vercel | Drena la cola en tandas de ~40s. **Ejecutor de respaldo.** |
| `GET /api/worker` | Vercel | Sincroniza métricas de un rango. Lo invoca el runner. |
| Webhooks `report_utm` | Vercel | Ingesta en tiempo real de ventas (Hotmart, Shopify, Cartpanda). |

## Crons de Vercel (los 2 permitidos)

| Path | Schedule (UTC) | Hora 🇨🇴 | Para qué |
|---|---|---|---|
| `/api/cron/refresh-meta-tokens` | `0 7 * * *` | 02:00 | Renovar tokens antes de que caduquen |
| `/api/worker/run-jobs` | `0 10 * * *` | 05:00 | Red de seguridad: drena la cola si el VPS no responde |

Todo lo demás lo programa el scheduler del `sync-worker`.

## Horarios del sync-worker (hora Colombia)

| Hora | Plan | Encola |
|---|---|---|
| 05:00 | `diario` | Métricas de ayer y hoy (todos los clientes) + Sheets + Meta Leads + agregación UTM |
| 14:00 | `diario` | Segunda pasada: recoge las correcciones de atribución del día |
| día 7, 03:00 | `cierre_mes` | Re-descarga forzada del mes anterior (ventana de 35 días) y congelado |
| domingo, 03:00 | `reconciliacion` | Audita el gasto de Meta contra el real de cada cuenta y repara los días con desglose incompleto |

Además hace *poll* de la cola cada 15s, que es lo que hace que el botón
"Sincronizar" del dashboard responda en segundos.

## Cómo funciona la cola

`claim_sync_job()` usa `FOR UPDATE SKIP LOCKED`: si el VPS y Vercel intentan
tomar un job a la vez, el segundo salta al siguiente en lugar de duplicar el
trabajo. Es el mutex que faltaba entre el sync manual y el cron.

Si un ejecutor muere (deploy, OOM, corte de los 60s), el **lease** del job vence
y vuelve a la cola. Como el cursor está persistido y los upserts son
idempotentes, solo se repite la unidad en curso.

Estados: `pending` → `running` → `done` | `error`. Un fallo con intentos
restantes vuelve a `pending`; al agotar `max_intentos` queda en `error` y genera
notificación.

Tipos de job: `metricas`, `sheets_leads`, `sheets_conversiones`, `meta_leads`,
`utm_aggregate`, `cierre_mes`, `reconciliar`.

## Workers

### `/api/worker` — sincronizador de métricas
Para cada cliente y cada día del rango:
1. **Meta Ads**: insights a nivel campaña/anuncio/conjunto, formularios de leads,
   demografía. Ventana de atribución fija en `7d_click` + `1d_view` para que el
   número signifique lo mismo en todas las cuentas.
2. **TikTok Ads**: reportes a nivel campaña/anuncio/grupo.
3. **Hotmart**: ventas (APPROVED/COMPLETE) + comisiones, **convertidas a USD**
   con las tasas de `fx_rates`. Antes solo se sumaba lo facturado en USD y el
   resto entraba como 0.
4. **GA4**: sesiones y eventos (si está configurado).
5. `upsert` en `metricas_diarias`.

Params: `date` | (`start` + `end`) | `client_id` | `force=1` | `refresh_days=N`.
Sin params sincroniza "ayer" en hora Colombia.

**Red de seguridad**: si una API falla o devuelve cero donde la BD ya tenía
datos, los campos de esa fuente se **omiten** del upsert en lugar de escribir
ceros. Aplica a las cuatro fuentes (antes solo a Meta y TikTok, así que un fallo
de Hotmart o GA4 borraba ventas y sesiones reales).

### `/api/worker/google-sheets` — leads
Importa leads desde las Google Sheets de cada cliente hacia `leads` y
`leads_diarios`.

### `/api/worker/google-sheets-conversiones` — conversiones offline
Sincroniza conversiones offline hacia `conversiones_offline` y
`conversiones_offline_diarias`. Usa `sync_batch_id`: se inserta el lote nuevo y
solo al completarse se borra el anterior, de modo que un fallo a mitad deja los
datos viejos intactos.

### `/api/cron/refresh-meta-tokens` / `refresh-hotmart-tokens`
Renuevan tokens antes de que caduquen (Meta < 10 días, Hotmart < 30 min).

### `/api/cron/report-utm/aggregate`
Reagrega `report_utm.sales_events` en `hourly_metrics`. Recalcula el rango
horario completo afectado: antes seleccionaba por `received_at` pero borraba por
hora de venta, así que las ventas antiguas desaparecían y los conteos podían
**bajar** en cada corrida.

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
  funcionó pero Hotmart falló, solo avanza la clave `meta`
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

## Si algún día se pasa a Vercel Pro

Con Pro (funciones de 300s y crons ilimitados) se puede subir `maxDuration` y
apoyarse más en `run-jobs`, pero la cola sigue siendo útil: es lo que da el
mutex, la reanudación y el historial. No hace falta deshacer nada.
