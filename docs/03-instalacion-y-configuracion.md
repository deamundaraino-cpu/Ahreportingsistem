# 03 · Instalación y configuración

## Requisitos previos

- **Node.js 20+** (ver `@types/node: ^20`).
- **npm** (el repo incluye `package-lock.json`).
- Un proyecto de **Supabase** (Postgres + Auth).
- Credenciales de las plataformas que se quieran integrar (Meta, TikTok, Hotmart, GA4, Google Sheets).

## 1. Clonar e instalar

```bash
git clone <repo>
cd Ahreportingsistem
npm install
```

## 2. Variables de entorno

Crea un archivo `.env.local` en la raíz. Estas son **todas** las variables que el código consume (`process.env.*`):

### Supabase (obligatorias)

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<proyecto>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # ¡secreta! usada por workers, omite RLS
```

> El *health check* (`/api/health`) verifica que estas tres estén presentes.

### Aplicación

```bash
NEXT_PUBLIC_APP_URL=https://reportes.adshouse.cloud   # URL base (OAuth callbacks, enlaces)
```

### Cron / workers

```bash
CRON_SECRET=<secreto-aleatorio>   # Bearer para /api/worker, /api/cron/*, etc.
```

### Meta Ads (OAuth + refresh de tokens)

```bash
META_APP_ID=<app-id>
META_APP_SECRET=<app-secret>
```

### TikTok Ads (OAuth)

```bash
TIKTOK_APP_ID=<app-id>
TIKTOK_APP_SECRET=<app-secret>
```

### Google Sheets (cuenta de servicio global, fallback)

```bash
GOOGLE_SERVICE_ACCOUNT_EMAIL=<service-account>@<proyecto>.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

> Las credenciales de Google Sheets también pueden definirse **por cliente** dentro de `config_api.google_sheets` (campos `client_email` y `private_key`). Si no, se usa esta cuenta de servicio global.

### Módulo Report-UTM (opcional, feature flag)

```bash
NEXT_PUBLIC_REPORT_UTM_ENABLED=true   # habilita las rutas /report-utm/*
```

> GA4 y Hotmart **no usan variables de entorno**: sus credenciales se configuran **por cliente** en `config_api` desde `/admin/settings/[id]`. Ver [doc 08 · Integraciones](./08-integraciones.md).

### Notificaciones de WhatsApp (Baileys)

```bash
WHATSAPP_GATEWAY_URL=https://whatsapp-gateway.example.com   # URL pública del microservicio
WHATSAPP_GATEWAY_API_KEY=<secreto-largo-compartido>         # debe coincidir con el del gateway
```

> Baileys **no corre en Vercel** (necesita un proceso persistente). Se despliega como
> microservicio aparte (carpeta `whatsapp-gateway/`, en Railway/Render/Fly/VPS) que mantiene
> la conexión y expone una API REST. La app solo lo llama por HTTP. Ver [doc 08 · Integraciones](./08-integraciones.md)
> y el README de `whatsapp-gateway/`.

### Resumen de variables

| Variable | Ámbito | Obligatoria | Uso |
|----------|--------|-------------|-----|
| `NEXT_PUBLIC_SUPABASE_URL` | público | ✅ | Conexión Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | público | ✅ | Cliente browser/SSR |
| `SUPABASE_SERVICE_ROLE_KEY` | servidor | ✅ | Workers, API v1, MCP (omite RLS) |
| `NEXT_PUBLIC_APP_URL` | público | ✅* | Callbacks OAuth, enlaces |
| `CRON_SECRET` | servidor | ✅* | Auth de cron/workers |
| `META_APP_ID` / `META_APP_SECRET` | servidor | si usas Meta OAuth | OAuth + refresh tokens |
| `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` | servidor | si usas TikTok OAuth | OAuth |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `_KEY` | servidor | si usas Sheets global | Importar leads |
| `NEXT_PUBLIC_REPORT_UTM_ENABLED` | público | no | Activa Report-UTM |
| `WHATSAPP_GATEWAY_URL` | servidor | si usas WhatsApp | URL del microservicio Baileys |
| `WHATSAPP_GATEWAY_API_KEY` | servidor | si usas WhatsApp | Bearer compartido con el gateway |

\* Necesarias para que funcionen OAuth, enlaces y crons en producción.

## 3. Base de datos

### Esquema base

Ejecuta `schema.sql` en el SQL Editor de Supabase. Crea las tablas base (`clientes`, `metricas_diarias`, `campaign_groups`, `campaign_group_mappings`) con sus políticas RLS.

### Migraciones

Aplica en orden los archivos de `migrations/` (001 → 020). Añaden columnas, tablas de leads, reportes mensuales, soporte, tokens de API y todo el schema `report_utm`. Ver el detalle migración por migración en [doc 04 · Modelo de datos](./04-modelo-de-datos.md).

```bash
# Ejemplo con la CLI de Supabase enlazada al proyecto
npx supabase db query --linked -f migrations/001_add_position_and_leads.sql
# … repetir en orden hasta 020
```

### Exponer el schema `report_utm`

Si vas a usar el módulo Report-UTM, en **Supabase Studio → Settings → API → Exposed schemas** agrega `report_utm` a la lista (junto a `public`).

### Email de administrador

Varias políticas RLS conceden acceso total al email administrador. En `schema.sql` está hardcodeado como `robinson@adshouse.com`. **Ajústalo** a tu administrador real o gestiona los permisos vía la tabla `user_profiles` (rol `superadmin`/`admin`). Ver [doc 05](./05-autenticacion-y-roles.md).

## 4. Levantar en desarrollo

```bash
npm run dev
```

Abre [http://localhost:3001](http://localhost:3001). Regístrate en `/signup` y asigna el rol adecuado en la tabla `user_profiles`.

## 5. Scripts disponibles

| Script | Acción |
|--------|--------|
| `npm run dev` | Servidor de desarrollo (puerto 3001) |
| `npm run build` | Build de producción |
| `npm run start` | Servidor de producción |
| `npm run lint` | ESLint (`--max-warnings 0`) |
| `npm run lint:fix` | ESLint con autofix |
| `npm run type-check` | `tsc --noEmit` |
| `npm run format` | Prettier (escribe) |
| `npm run format:check` | Prettier (verifica) |
| `npm run validate` | type-check + lint + format:check |
| `npm run test` | *(No implementado todavía)* |

## 6. Configurar OAuth (callbacks)

Para que Meta y TikTok funcionen, registra estas URLs de redirección en cada plataforma (usando tu `NEXT_PUBLIC_APP_URL`):

- Meta: `https://<tu-dominio>/api/auth/meta/callback`
- TikTok: `https://<tu-dominio>/api/auth/tiktok/callback`

Detalles en [doc 08 · Integraciones](./08-integraciones.md).

## Siguiente paso

- Para entender el esquema completo: [04 · Modelo de datos](./04-modelo-de-datos.md).
- Para desplegar a producción: [15 · Despliegue y operación](./15-despliegue.md).
