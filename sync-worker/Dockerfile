# Construir desde la RAÍZ del repo:
#   docker build -f sync-worker/Dockerfile -t sync-worker .
#
# El contexto es la raíz porque el worker compila `src/lib/sync/*` de la app
# (la lógica de la cola no se duplica aquí).

FROM node:22-alpine AS build
WORKDIR /repo

COPY sync-worker/package*.json sync-worker/
RUN cd sync-worker && npm install

# Los archivos que se compilan de la app viven en `/repo/src/lib/...`, y la
# resolución de módulos sube por el árbol desde el archivo que importa: desde
# ahí `/repo/sync-worker/node_modules` no está en el camino, así que
# `notify.ts` no encontraba `@supabase/supabase-js`.
#
# En local esto no se nota porque la raíz del repo tiene su propio
# `node_modules` (el de la app), que sí está en el camino — de ahí que
# `npm run typecheck` pasara mientras la imagen no construía. El enlace
# reproduce esa disposición con las dependencias del worker.
RUN ln -s sync-worker/node_modules node_modules

COPY sync-worker/tsconfig.json sync-worker/
COPY sync-worker/src sync-worker/src
COPY src/lib/sync src/lib/sync
# runner.ts avisa a admins al agotar reintentos → arrastra el módulo de notificaciones.
COPY src/lib/notifications src/lib/notifications
# Módulos sueltos de `src/lib` que la cola importa por ruta relativa. Van uno a
# uno y no como `COPY src/lib`: eso arrastraría media app (y con ella Next, que
# aquí no existe) al contexto del worker.
#
# Faltaban, y por eso esta imagen NUNCA llegó a construirse: `tsc` moría con
# "Cannot find module '../colombia-date'". Como el fallo ocurría en el build,
# el worker no llegaba a desplegarse y toda la cola quedaba en manos del
# ejecutor de respaldo, con su presupuesto corto. Si vuelves a añadir un import
# relativo fuera de `src/lib/sync`, añádelo también aquí.
COPY src/lib/colombia-date.ts src/lib/
COPY src/lib/fetch-json.ts src/lib/

RUN cd sync-worker && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY sync-worker/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /repo/sync-worker/dist ./dist

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/sync-worker/src/index.js"]
