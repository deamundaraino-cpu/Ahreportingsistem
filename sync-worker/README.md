# sync-worker

Proceso persistente que ejecuta la cola `public.sync_jobs`. **No corre en Vercel**:
existe precisamente para escapar de sus límites.

## Por qué existe

La app está en Vercel plan Hobby:

- las funciones se cortan a **60 segundos**
- solo se admiten **2 crons diarios**, y `vercel.json` declaraba 9

Sincronizar Meta + TikTok + Hotmart + GA4 para todos los clientes no cabe en 60s
(Hotmart y GA4 se consultan día a día). El worker moría a mitad del recorrido y
dejaba datos parciales sin dejar rastro de lo ocurrido.

Este proceso reclama trabajos de la cola, los ejecuta sin prisa y persiste el
progreso. Si se cae, el *lease* del job vence y el trabajo vuelve a la cola: nada
se pierde y nada se duplica (los upserts son idempotentes).

## Qué NO hace

No reimplementa la sincronización. Importa `src/lib/sync/runner.ts` de la app,
que traduce cada job a una llamada a los endpoints que ya existen
(`/api/worker`, `/api/worker/google-sheets`, …). La lógica de Meta/TikTok/
Hotmart/GA4 sigue viviendo en un único sitio; duplicarla aquí garantizaría que
las dos copias divergieran.

## Setup local

```bash
cd sync-worker
npm install
cp .env.example .env   # completar valores
npm run dev
```

Comprobar que arrancó:

```bash
curl localhost:8080/status
```

Devuelve el estado de la cola (`pending` / `running` / `done` / `error`) y cuándo
fue la última pasada.

## API

| Método | Ruta      | Descripción |
|--------|-----------|-------------|
| GET    | `/health` | Health-check para el orquestador del host |
| GET    | `/status` | Estado del worker + conteos de la cola |
| POST   | `/run`    | Fuerza una pasada inmediata (depuración) |

## Horarios

Definidos en `src/index.ts`, en hora Colombia (`TZ_OPERACION`):

| Hora  | Plan | Qué encola |
|-------|------|-----------|
| 05:00 | `diario` | Métricas de ayer y hoy (todos los clientes) + Sheets + Meta Leads + agregación UTM |
| 14:00 | `diario` | Segunda pasada: recoge correcciones de atribución del día |
| día 7, 03:00 | `cierre_mes` | Re-descarga forzada del mes anterior (ventana de 35 días) y congelado del período |

Además hace *poll* de la cola cada `POLL_SECONDS` (15s por defecto), que es lo
que hace que el botón "Sincronizar" del dashboard responda en segundos.

## Despliegue

### Docker (recomendado en VPS)

Desde la **raíz del repo** (el `Dockerfile` necesita `src/lib/sync/`):

```bash
docker build -f sync-worker/Dockerfile -t sync-worker .
docker run -d --name sync-worker --restart always --env-file sync-worker/.env -p 8080:8080 sync-worker
```

O con `docker compose -f sync-worker/docker-compose.yml up -d`.

### PM2

```bash
npm install && npm run build
pm2 start dist/sync-worker/src/index.js --name sync-worker
pm2 save
```

### Railway / Render

- Root directory: la raíz del repo (no `sync-worker/`)
- Build: `cd sync-worker && npm install && npm run build`
- Start: `node sync-worker/dist/sync-worker/src/index.js`
- Exponer `$PORT`

En los planes gratuitos de Render el servicio se duerme por inactividad; para un
worker que debe despertar solo, un VPS pequeño o el plan de pago es más fiable.

## Respaldo si el worker está caído

`POST /api/worker/run-jobs` en Vercel drena la misma cola en tandas de ~40s. Los
dos ejecutores pueden convivir: `claim_sync_job` usa `FOR UPDATE SKIP LOCKED`, así
que nunca toman el mismo job.
