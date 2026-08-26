# syntax=docker/dockerfile:1

# Imagen de la app Next.js. Pensada para Dokploy, pero no depende de él:
# es un contenedor Node normal que escucha en $PORT.
#
# Construir desde la RAÍZ del repo:
#   docker build -t adhouse-reporting \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
#     --build-arg NEXT_PUBLIC_APP_URL=https://reportes.adshouse.cloud .
#
# Node 22.12+ es OBLIGATORIO y no es cosmético: por debajo, la cadena
# sanitize-html → isomorphic-dompurify → jsdom → html-encoding-sniffer hace
# require() de un paquete ESM puro y el dashboard de cliente devuelve 500 antes
# de ejecutar una línea (ver docs/15-despliegue.md).

# ─── Dependencias ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# .npmrc trae legacy-peer-deps=true; sin él `npm ci` falla al resolver peers.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Las NEXT_PUBLIC_* se INCRUSTAN en el bundle del navegador durante
# `next build`: ponerlas solo en el panel de runtime no sirve de nada, el
# cliente saldría con `undefined` y la sesión de Supabase nunca arrancaría.
#
# El resto de variables (service role, secretos OAuth, CRON_SECRET…) se leen en
# el servidor en tiempo de ejecución y NO deben pasar por aquí: un ARG queda
# grabado en el historial de capas de la imagen.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_REPORT_UTM_ENABLED
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_REPORT_UTM_ENABLED=$NEXT_PUBLIC_REPORT_UTM_ENABLED

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Sin TZ a propósito: el contenedor corre en UTC, igual que Vercel. Toda la
# aritmética de fechas de Colombia es explícita (`colombia-date.ts` usa un
# offset fijo y lee en UTC), así que fijarla aquí no arreglaría nada y metería
# una diferencia más entre entornos. En alpine, además, sería silenciosamente
# inútil: la imagen no trae tzdata.

# `output: 'standalone'` deja en .next/standalone el server y solo los módulos
# que la traza encontró; no hace falta node_modules completo. Lo que Next NO
# copia es `public/` ni `.next/static`: sin estas dos líneas el sitio arranca
# pero sale sin CSS, sin JS de cliente y sin favicon.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# .next/cache lo escribe el server en runtime (fetch cache, ISR). Si el
# directorio no existe y /app es de root, el primer write falla.
RUN mkdir -p .next/cache && chown -R node:node .next

USER node
EXPOSE 3000

# Comprueba que el proceso responde HTTP, no que todo el sistema esté sano.
# `/api/health` devuelve 503 cuando Supabase no contesta, y eso no es motivo
# para marcar el contenedor como enfermo: el que falla es Supabase. Para
# vigilar la salud real está el uptime monitor apuntando a /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
