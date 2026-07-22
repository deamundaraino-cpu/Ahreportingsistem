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
`utm_aggregate`, `cierre_mes`.

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
