# Construir desde la RAÍZ del repo:
#   docker build -f sync-worker/Dockerfile -t sync-worker .
#
# El contexto es la raíz porque el worker compila `src/lib/sync/*` de la app
# (la lógica de la cola no se duplica aquí).

FROM node:20-alpine AS build
WORKDIR /repo

COPY sync-worker/package*.json sync-worker/
RUN cd sync-worker && npm install

COPY sync-worker/tsconfig.json sync-worker/
COPY sync-worker/src sync-worker/src
COPY src/lib/sync src/lib/sync

RUN cd sync-worker && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY sync-worker/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /repo/sync-worker/dist ./dist

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/sync-worker/src/index.js"]
