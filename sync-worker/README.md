# sync-worker

Proceso persistente que ejecuta la cola `public.sync_jobs` y programa los crons
de la app. Corre como una Application propia de Dokploy, en el mismo VPS que la
app y **sin dominio**.

## Por qué existe

Sincronizar Meta + TikTok + Hotmart + GA4 para todos los clientes no cabe en una
petición HTTP a la app (Hotmart y GA4 se consultan día a día): moría a mitad del
recorrido y dejaba datos parciales sin dejar rastro de lo ocurrido. Además la
plataforma no programa nada: alguien tiene que disparar los crons.

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
| domingo, 03:00 | `reconciliacion` | Audita el gasto de Meta contra el real de cada cuenta y repara los días con desglose incompleto |
| cada 2 h | — | Llama a `/api/cron/refresh-hotmart-tokens` |
| 02:00 | — | Llama a `/api/cron/refresh-meta-tokens` (es el único sitio donde se programa) |

Además hace *poll* de la cola cada `POLL_SECONDS` (15s por defecto), que es lo
que hace que el botón "Sincronizar" del dashboard responda en segundos.

## Despliegue

En producción es una Application de Dokploy con **Dockerfile Path**
`sync-worker/Dockerfile` y **Context** `.` — ver
[docs/15-despliegue.md](../docs/15-despliegue.md). A mano:

### Docker

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

## Respaldo si el worker está caído

`POST /api/worker/run-jobs` en la app drena la misma cola por tandas. Los
dos ejecutores pueden convivir: `claim_sync_job` usa `FOR UPDATE SKIP LOCKED`, así
que nunca toman el mismo job.
