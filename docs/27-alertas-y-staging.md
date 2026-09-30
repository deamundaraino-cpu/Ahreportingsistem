# 27 · Alertas y entorno de pruebas

Hasta el 2026-09-30 nada avisaba si la base se saturaba, si las purgas dejaban de
correr o si el tamaño se disparaba, y las migraciones se probaban contra
producción. Este documento recoge qué quedó resuelto en el código y qué hay que
configurar a mano fuera de él.

| Pieza                                   | Estado                                            |
| --------------------------------------- | ------------------------------------------------- |
| Alerta de tamaño, crecimiento y purgas  | En el código. Requiere la **migración 101**       |
| `/api/health` detecta la base saturada  | En el código                                      |
| Monitor de uptime externo               | **A mano** (apartado 2)                           |
| Alertas de Supabase (CPU, memoria, E/S) | **A mano** (apartado 3)                           |
| Entorno de pruebas                      | Herramienta lista; el proyecto está **por crear** |

## 1 · Salud de la base (en el código)

`/api/worker/health` devuelve ahora un bloque `base`. Lo llama el workflow
`sync-fallback` cada 30 minutos.

| Alerta        | Aviso             | Crítico         | Variable                                   |
| ------------- | ----------------- | --------------- | ------------------------------------------ |
| `tamano`      | ≥ 1.024 MB        | ≥ 2.048 MB      | `SALUD_DB_AVISO_MB`, `SALUD_DB_CRITICO_MB` |
| `crecimiento` | ≥ 10 % en 7 días  | ≥ 25 %          | `SALUD_DB_CRECIMIENTO_PCT` (el aviso)      |
| `conexiones`  | ≥ 80 % del máximo | ≥ 95 %          | —                                          |
| `purga`       | —                 | > 36 h sin ella | `SALUD_PURGA_MAX_HORAS`                    |

El 2026-09-30 la base pesaba 580 MB con 7 de 60 conexiones: ninguna alerta
dispara de entrada.

**Adónde llega cada una.** Todas van a la campanita de los administradores (tipo
«Sistema», como mucho una cada 12 h). Las **críticas** además hacen fallar el
workflow, que manda el correo de GitHub y abre la issue «Salud de la base en
estado crítico». Ese segundo canal es el que importa: con la base caída la
campanita no se puede ni pintar.

**Cómo funciona.**

- `public.salud_base()` lee el tamaño, las conexiones y las 8 tablas más grandes.
- `public.mantenimiento_log` es una bitácora de solo añadir. `limpiarHistorial`
  (`src/lib/sync/planner.ts`) deja una fila `purga` cada vez que termina, y el
  healthcheck una fila `tamano` al día. El crecimiento se mide contra la muestra
  de hace 7 días, así que **no se evalúa hasta que haya una semana de muestras**.
- Las reglas son puras (`evaluarSaludBase`, `src/lib/salud/base.ts`) y las
  comprueba `scripts/verify-salud-base.ts`, dentro de `npm run test:puro`.

**Sin la migración 101** el código funciona igual: `base` responde
`{ "disponible": false }` y no se evalúa nada.

**Límite conocido.** El latido dice que la purga _corrió_, no que _borró_: si una
de las funciones `purgar_*` falla, el planner lo escribe en el log y sigue. Ese
caso lo acaba cazando la alerta de crecimiento.

Para verlo a mano:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://reportes.adshouse.cloud/api/worker/health | jq .base
```

### `/api/health` y la saturación

La caída del 2026-09-20 no agotó conexiones: la base contestaba, pero una
consulta trivial tardaba segundos. `/api/health` ahora responde **503** si su
consulta de una fila tarda más de 3 s (`HEALTH_DB_SLOW_MS`) y la corta a los 8 s
en vez de quedarse colgada. El `HEALTHCHECK` del `Dockerfile` no cambia: sigue
aceptando cualquier respuesta, así que Dokploy no reinicia el contenedor por una
base lenta.

## 2 · Monitor de uptime (a mano)

El workflow de GitHub mira cada 30 minutos y su planificador es _best-effort_:
sirve de red, no de monitor. Hace falta uno externo (UptimeRobot, Better Stack o
similar; el plan gratuito de cualquiera basta).

| Campo              | Valor                                                           |
| ------------------ | --------------------------------------------------------------- |
| URL                | `https://reportes.adshouse.cloud/api/health`                    |
| Método             | `GET`, sin autenticación                                        |
| Intervalo          | 5 minutos                                                       |
| Timeout            | 15 s (por encima del corte de 8 s del endpoint)                 |
| Se considera caído | Cualquier estado distinto de 200                                |
| Confirmación       | 2 fallos seguidos antes de avisar (evita el ruido de un deploy) |
| Aviso              | Correo y, si el servicio lo permite, WhatsApp o Telegram        |

Un segundo monitor útil: `http://<vps>:8080/health` del `sync-worker`, si el
puerto es accesible desde fuera.

## 3 · Alertas de Supabase (a mano)

Lo que el código no puede ver es el **cómputo**: CPU, memoria y E/S de disco, que
es justo lo que se agota en una instancia Micro.

1. **Correos de uso.** En el panel, _Organization → Billing_ y _Account →
   Notifications_: comprueba que los avisos de uso llegan a un buzón que alguien
   lee.
2. **Métricas.** Cada proyecto expone un endpoint compatible con Prometheus:
   `https://dfdeizrbkpdocgckqlel.supabase.co/customer/v1/privileged/metrics`
   (Basic Auth, usuario `service_role`, contraseña una _Secret API key_). La vía
   sin servidores propios es la **integración de Grafana Cloud** que ofrece el
   panel de Supabase; trae el dashboard hecho y reglas de ejemplo en
   [supabase-grafana](https://github.com/supabase/supabase-grafana/blob/main/docs/example-alerts.md).
   Reglas mínimas: memoria libre baja, uso de swap, espera de E/S alta y
   conexiones cerca del máximo.
3. **Salud de los servicios.** `GET /v1/projects/{ref}/health?services=db&services=rest&services=auth`
   en la Management API, como en el apartado 4.8 del
   [informe de entrega](./00-informe-de-entrega.md). El panel puede decir
   `ACTIVE_HEALTHY` con la base caída.

## 4 · Entorno de pruebas

### Qué hay ya

`scripts/sql-remoto.ts` acepta `--staging`. Lee `.env.staging.local` en vez de
`.env.local` y **se niega a ejecutar** si ese archivo apunta al proyecto de
producción.

```bash
# 1. Primero en staging
npx tsx scripts/sql-remoto.ts --staging migrations/101_salud_base.sql
# 2. Después, con permiso del dueño, en producción
npx tsx scripts/sql-remoto.ts migrations/101_salud_base.sql
```

`.env.staging.local` lleva dos líneas (está cubierto por el `.gitignore`):

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref-de-staging>.supabase.co
SUPABASE_ACCESS_TOKEN=<el mismo token personal>
```

### Qué falta: crear el proyecto

Es una decisión del dueño porque tiene coste mensual. La opción recomendada:

**«Restore to a New Project»** (_Database → Backups_ en el panel). Clona esquema,
datos, roles y usuarios de Auth a un proyecto nuevo e independiente, con el mismo
tamaño de cómputo que el origen. Es la única vía que da el esquema **real**: el
repo no puede reconstruirlo desde cero (migraciones aplicadas a mano, números
duplicados, tablas que nunca tuvieron `CREATE`).

Un clon es una copia de producción, así que antes de usarlo:

- [ ] **Neutralizar los tokens.** `clientes.config_api` y
      `report_utm.integrations` traen los tokens reales de Meta, TikTok, Hotmart
      y GHL. Hay que vaciarlos en el clon, o un sync lanzado en staging pediría
      datos con credenciales de clientes.
- [ ] **Anonimizar los leads.** Nombre, correo y teléfono de
      `report_utm.lead_events` y de `hotmart_ventas`.
- [ ] **No desplegar worker ni crons contra el clon.** Staging sirve para probar
      migraciones y lecturas, no para sincronizar.
- [ ] **No configurar WhatsApp ni correo** en un entorno que apunte al clon.
- [ ] Si algún día se activa `pg_cron` o `pg_net` en producción, desactivarlos en
      el clon nada más crearlo.

Un clon no se puede volver a clonar, y no se refresca solo: para probar una
migración contra datos recientes hay que borrarlo y crear otro.

**Alternativas descartadas.** Las ramas de Supabase (_branching_) se construyen
desde `supabase/migrations/` y nacen sin datos: aquí no hay ese directorio ni
migraciones reproducibles. Un stack local (`supabase start`) necesita Docker y un
volcado del esquema que hoy no existe.
