# AdsHouse Reporting

Plataforma multi-cliente para agencias de publicidad: consolida métricas de Meta Ads, TikTok Ads, Google Analytics 4, Hotmart y Google Sheets en dashboards, informes BI y enlaces públicos compartibles.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Storage).

## Desarrollo

Requiere **Node ≥ 22.12**.

```bash
npm install
cp .env.example .env.local   # completar valores
npm run dev                  # http://localhost:3000
```

Antes de subir cambios:

```bash
npm run validate   # type-check + lint + format:check
npm run test       # scripts verify-*
npm run build
```

## Despliegue

Producción corre en contenedores Docker sobre un VPS con **Dokploy**: la app (`Dockerfile`) y el `sync-worker` (`sync-worker/Dockerfile`), que programa los crons y drena la cola de sincronización. Ver [docs/15-despliegue.md](./docs/15-despliegue.md).

## Documentación

Índice completo en [docs/README.md](./docs/README.md). Para una visión de conjunto, empieza por el [informe de entrega](./docs/00-informe-de-entrega.md).
