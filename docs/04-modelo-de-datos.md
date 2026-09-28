# 04 · Modelo de datos

La base de datos vive en **Supabase (PostgreSQL)** y se organiza en dos schemas:

- **`public`** — Reporting principal (clientes, métricas, layouts, reportes, soporte, tokens…).
- **`report_utm`** — Módulo aislado de tracking y atribución.

Todas las tablas usan **Row Level Security (RLS)**. La regla general:

- Los clientes son **de la empresa, no de un usuario** (migración 098). Un usuario ve un cliente si es admin/superadmin o si lo tiene asignado en `user_client_assignments`: es la función `public.puede_ver_cliente(cliente_id)`, que usan las políticas de las tablas por cliente.
- El email administrador (`robinson@adshouse.com` en `schema.sql`) tiene acceso total.
- Las tablas de `report_utm` están restringidas a administradores mediante la función `report_utm.is_admin()`.
- Los **workers** usan la _service role key_, que **omite RLS**.

> Algunas tablas (`user_profiles`, `user_client_assignments`, `layouts_reporte`, `clientes_layouts`, `cliente_tabs`) son referenciadas por el código y existen en la base de datos productiva, pero su `CREATE TABLE` no está en los archivos de migración del repo. Sus columnas aquí se documentan **inferidas del código**; verifícalas contra tu instancia real.

---

## Schema `public`

### `clientes`

Registro maestro de clientes del reporting principal.

```sql
CREATE TABLE public.clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- 098; se elimina en la 099: no hay dueño
  config_api  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  public_token UUID UNIQUE DEFAULT gen_random_uuid(),  -- migración 006
  layout_id   UUID REFERENCES layouts_reporte(id)      -- layout por defecto
);
```

- **`config_api`** (JSONB): contenedor de credenciales e integraciones. Ver estructura abajo.
- **`public_token`**: token para enlaces públicos/espejo.
- **RLS**: `puede_ver_cliente(id)` (admin/superadmin o trafficker asignado). Sin política pública: `config_api` guarda credenciales y el rol `anon` no ve ninguna fila (098 cerró `"Public view cliente via token" USING (true)`; `/p/` resuelve su token con el cliente de servicio).
- **Dueño**: ninguno. Borrar un usuario nunca bloquea ni borra clientes; solo se van sus datos personales (asignaciones, tokens de API, notificaciones) y sus autorías quedan a NULL (`bitacoras.author_id`, 098).
- **Alta**: `crearCliente` (`src/lib/clientes/ciclo-de-vida.ts`), todo o nada: cliente, espejo UTM, moneda, zona y traffickers, o nada. Solo admin/superadmin. Lo que falta por conectar lo lista la «Puesta en marcha» de la ficha (`src/lib/clientes/puesta-en-marcha.ts`).
- **Borrado**: toda tabla con `cliente_id` (en los dos esquemas) cae en cascada con
  el cliente (migraciones 080 y 081); `scripts/verify-borrado-cascada.ts` lo
  comprueba en el catálogo. Se borra con `eliminarClienteCompleto`, que limpia
  además lo que no tiene FK. Ver [doc 23](./23-runbook-empalme.md).

#### Estructura de `config_api`

```jsonc
{
  // Meta Ads
  "meta_token": "...",
  "meta_account_id": "act_123...",
  "meta_token_expires_at": "2026-08-01T00:00:00Z",
  "meta_connection_status": "connected | expired",

  // TikTok Ads
  "tiktok_access_token": "...",
  "tiktok_accounts": [{ "advertiser_id": "123", "name": "..." }],

  // Hotmart (ver doc 08). Los secretos van cifrados en las claves *_enc; las
  // planas (hotmart_basic, hotmart_client_secret, hotmart_token) son heredadas
  // y se migran a su *_enc la primera vez que se usan.
  "hotmart_auth_mode": "hotconnect", // ausente = credenciales
  "hotmart_client_id": "...", // en claro: identifica, no autoriza
  "hotmart_client_secret_enc": "...", // o bien:
  "hotmart_basic_enc": "...", // Basic ya armado
  "hotmart_access_token_enc": "...", // HotConnect
  "hotmart_refresh_token_enc": "...",
  "hotmart_token_expires_at": "2026-09-25T12:00:00Z",

  // Google Analytics 4 (con la conexión OAuth de la agencia basta la propiedad)
  "ga_property_id": "524635063",
  "ga_property_name": "cristributario.cl",
  "ga_account_name": "Cristributario.cl",
  // Legacy: service account por cliente, solo si no hay conexión de agencia
  "ga_private_key": "-----BEGIN PRIVATE KEY-----\n...",
  "ga_client_email": "...@....iam.gserviceaccount.com",

  // Google Sheets (importación de leads)
  "google_sheets": {
    "sheet_url": "https://docs.google.com/spreadsheets/d/...",
    "quality_field": "rango_de_ingresos",
    "qualified_values": ["$5,000 - $20,000 USD", "$20,000+ USD"],
    "enabled": true,
    "client_email": "...", // opcional: credenciales por cliente
    "private_key": "...",
    "sheet_names": ["Hoja1"],
  },
}
```

---

### `metricas_diarias`

**Tabla central del reporting.** Una fila por cliente por día con métricas consolidadas y desgloses JSONB.

```sql
CREATE TABLE public.metricas_diarias (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  fecha       DATE NOT NULL,

  -- Meta Ads
  meta_spend        DECIMAL DEFAULT 0,
  meta_impressions  INTEGER DEFAULT 0,
  meta_clicks       INTEGER DEFAULT 0,

  -- GA4
  ga_sessions       INTEGER DEFAULT 0,

  -- Hotmart
  hotmart_pagos_iniciados INTEGER DEFAULT 0,

  -- Ventas netas
  ventas_principal  DECIMAL DEFAULT 0,
  ventas_bump       DECIMAL DEFAULT 0,
  ventas_upsell     DECIMAL DEFAULT 0,
  -- Ventas brutas (migr. 010)
  ventas_principal_bruto DECIMAL DEFAULT 0,
  ventas_bump_bruto      NUMERIC DEFAULT 0,
  ventas_upsell_bruto    NUMERIC DEFAULT 0,
  -- Conteos de venta
  ventas_principal_count INTEGER DEFAULT 0,
  ventas_bump_count      INTEGER DEFAULT 0,
  ventas_upsell_count    INTEGER DEFAULT 0,
  -- Manual (migr. 011)
  ventas_cerradas   INTEGER DEFAULT 0,

  -- TikTok (migr. 016)
  tiktok_spend       DECIMAL DEFAULT 0,
  tiktok_impressions INTEGER DEFAULT 0,
  tiktok_clicks      INTEGER DEFAULT 0,
  tiktok_conversions INTEGER DEFAULT 0,

  sync_hash   TEXT,        -- idempotencia de sync (migr. 002)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE(cliente_id, fecha)
);
```

#### Columnas JSONB de desglose

| Columna               | Migración   | Contenido                                                  |
| --------------------- | ----------- | ---------------------------------------------------------- |
| `meta_campaigns`      | base/código | Array de campañas Meta con métricas y `custom_conversions` |
| `meta_ads`            | 017         | Array de anuncios Meta                                     |
| `meta_adsets`         | 017         | Array de conjuntos de anuncios Meta                        |
| `meta_forms`          | 020         | Array de formularios de leads Meta                         |
| `tiktok_campaigns`    | 016         | Array de campañas TikTok                                   |
| `tiktok_ads`          | 019         | Array de anuncios TikTok                                   |
| `tiktok_adgroups`     | 019         | Array de grupos de anuncios TikTok                         |
| `hotmart_funnel_data` | 008         | Desglose de embudo por tab (ver abajo)                     |

Estructura de `hotmart_funnel_data`:

```jsonc
{
  "by_tab": {
    "<tab_id>": {
      "principal": { "count": 19, "gross": 361, "net": 275.5 },
      "bump": { "count": 3, "net": 16.2 },
      "upsell": { "count": 1, "net": 18.99, "page_visits": 24 },
      "pagos_iniciados": 30,
    },
  },
  "extras": [{ "product_name": "Otro Producto", "count": 2, "gross": 38.0, "net": 35.4 }],
}
```

- **Índices**: `UNIQUE(cliente_id, fecha)`, índice por `sync_hash`, índice GIN sobre `hotmart_funnel_data`.
- **RLS**: cliente ve sus métricas + admin total.

---

### `hotmart_ventas` (migraciones 065 y 089)

**La única verdad de ventas de Hotmart**: una fila por transacción,
`UNIQUE (cliente_id, transaction_id)`, con `cliente_id` de `public.clientes`. La
escriben la API y el webhook con el mismo parser, y de ella salen `metricas_diarias`
(`agregarDesdeHotmartVentas`), el cubo `hm_*` de las pestañas y la fuente `hotmart`
del BI. Flujo completo en [doc 08](./08-integraciones.md#hotmart).

Columnas de la 065, por grupos: identidad (`transaction_id`,
`parent_transaction_id`); fecha (`fecha_venta`, DATE ya en día Colombia,
`aprobada_at`, `orden_at`); ciclo de vida (`estado`: `aprobada | completa |
pendiente | reembolsada | chargeback | cancelada | expirada`, `evento_ts`,
`reembolsada_at`); embudo (`tipo`, `clasificacion_origen`, `tab_id`); producto
(`producto_id`, `producto_nombre`, `oferta_codigo`, `es_order_bump`); dinero
(`moneda`, `bruto`, `bruto_usd`, `neto_productor_usd`, `neto_afiliado_usd`,
`neto_coproductor_usd`, `usd_rate` — sin tasa, NULL y nunca 0); comprador; atribución
(`utm_*`, `click_id`, y `src` / `sck` / `xcod` en columnas propias); envíos
(`capi_enviado_at`, `gads_enviado_at`) y trazabilidad (`raw_payload`, `origen`:
`webhook | api | backfill | reconciliacion`, `sales_event_id`).

**Migración 089 — pendiente de aplicar a 2026-09-25.** Añade:

| Columna              | Qué guarda                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atribucion_metodo`  | De dónde sale la tupla UTM: `tracking` (la trajo Hotmart), `lead_email` / `lead_telefono` (heredada del lead) o `padre` (bump/upsell que hereda de su principal). NULL = sin atribuir |
| `atribucion_lead_id` | `lead_events.id` del que se heredó. Sin FK: vive en `report_utm` y el lead puede purgarse sin que la venta pierda su campaña                                                          |
| `atribucion_at`      | Cuándo se atribuyó                                                                                                                                                                    |
| `notificado_estado`  | Último estado por el que ya se avisó (notificación y webhook saliente). Se reclama con un UPDATE condicional: dos reintentos no avisan dos veces                                      |
| `estado_crudo`       | El status tal cual lo manda Hotmart (`PARTIALLY_REFUNDED`, `PROTESTED`…); `estado` es su traducción                                                                                   |

Y reescribe o crea tres funciones:

- **`guardar_hotmart_venta(jsonb)`** — misma firma `(id, escrita)`. Antes descartaba
  entero todo evento con `evento_ts` más viejo, y con él las comisiones que solo trae
  la API (cuyo `evento_ts` es `approved_date`, anterior al del webhook). Ahora separa
  dos cosas: el **estado** (`estado`, `fecha_venta`, `origen`, `evento_ts`) solo se
  mueve si el evento es más reciente o si la API trae un estado más avanzado
  (`pendiente` < `cancelada`/`expirada` < `aprobada` < `completa` <
  `reembolsada`/`chargeback`); un estado cobrado o devuelto nunca vuelve a
  `pendiente`, y cuando el avance lo trae la API `evento_ts` sube a `now()` para que
  ningún reintento viejo lo deshaga. El **resto de columnas** solo se rellena desde
  eventos viejos. La tupla UTM va en bloque y el
  tracking siempre gana a la herencia de un lead. `escrita` sigue significando «se
  aplicó como el más reciente».
- **`hotmart_leads_para_atribucion(cliente_rtm, emails, tel9, desde, hasta)`** — leads
  no excluidos y con campaña cuyo email (minúsculas) o teléfono (últimos 9 dígitos)
  coincide con compradores. Solo `service_role`. Su normalización tiene que coincidir
  con la de `src/lib/hotmart/atribucion.ts`.
- **`hotmart_valores_conteo`** — la lista blanca de columnas admite ahora las `utm_*` y
  `atribucion_metodo`, para que los segmentadores del BI listen valores de UTM de las
  ventas.

El código envía las claves nuevas antes de que la 089 exista (la función vieja las
ignora) y `columnas089Disponibles()` (`src/lib/hotmart/esquema.ts`) sondea si está
aplicada. Se prueba sin dejar nada escrito con `npx tsx scripts/verify-hotmart-089.ts`.

---

### `campaign_groups` y `campaign_group_mappings`

Agrupan campañas relacionadas para reportes.

```sql
CREATE TABLE public.campaign_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  descripcion TEXT,
  color       TEXT DEFAULT 'blue',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE(cliente_id, nombre)
);

CREATE TABLE public.campaign_group_mappings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES public.campaign_groups(id) ON DELETE CASCADE,
  campaign_id           TEXT,   -- ID exacto de campaña
  campaign_name_pattern TEXT,   -- patrón tipo SQL LIKE (% _)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE(group_id, campaign_id, campaign_name_pattern)
);
```

Un mapeo puede coincidir por **ID exacto** o por **patrón de nombre** (`%` → cualquier secuencia, `_` → cualquier carácter).

---

### `leads` y `leads_diarios` (migración 001)

Importación y agregación de leads desde Google Sheets.

```sql
CREATE TABLE public.leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  lead_external_id TEXT,                 -- ID en la hoja
  lead_data        JSONB DEFAULT '{}',   -- registro completo
  is_qualified     BOOLEAN DEFAULT false,
  qualification_field TEXT,
  qualification_value TEXT,
  source           VARCHAR(50) DEFAULT 'google_sheets',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE(client_id, lead_external_id)
);

CREATE TABLE public.leads_diarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  leads_totales       INTEGER DEFAULT 0,
  leads_calificados   INTEGER DEFAULT 0,
  leads_no_calificados INTEGER DEFAULT 0,
  tasa_calificacion   DECIMAL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE(client_id, date)
);
```

---

### `report_templates` y `monthly_reports` (migración 004)

Motor de reportes mensuales. La interfaz se retiró al unificar Reporting y Report-UTM: la sustituyen los informes BI (`/informes`). Las tablas siguen en la base por si hace falta consultar el histórico.

```sql
CREATE TABLE public.report_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  tipo        TEXT CHECK (tipo IN ('captacion','infoproducto','hibrido')),
  descripcion TEXT,
  tarjetas    JSONB DEFAULT '[]',
  columnas    JSONB DEFAULT '[]',
  graficos    JSONB DEFAULT '[]',
  source_mapping JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.monthly_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.report_templates(id),
  periodo     TEXT NOT NULL,            -- 'YYYY-MM'
  estado      TEXT DEFAULT 'borrador'
              CHECK (estado IN ('borrador','revision','aprobado','publicado')),
  campaigns_discovered JSONB DEFAULT '[]',
  campaigns_included   JSONB DEFAULT '[]',
  kpis_snapshot        JSONB DEFAULT '{}',
  public_slug TEXT UNIQUE,
  pdf_url     TEXT,
  created_by  UUID,
  approved_by UUID,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(cliente_id, periodo)
);
```

La migración 004 inserta 3 plantillas: **Captación de Leads**, **Infoproducto Hotmart** e **Híbrido GA4 + Meta**.

---

### `soporte_tickets` (migración 005)

Tickets de soporte por cliente.

```sql
CREATE TABLE public.soporte_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_serial     SERIAL,
  id_ticket_display TEXT,                 -- p. ej. "#1001" (trigger)
  cliente_id    UUID NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  nombre_solicitante TEXT NOT NULL,
  fecha_solicitud TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  requerimiento TEXT NOT NULL,
  observaciones TEXT,
  responsable   TEXT,
  fecha_entrega DATE,
  prioridad     INTEGER DEFAULT 3 CHECK (prioridad IN (1,2,3)),  -- 1=alta
  estado        TEXT DEFAULT 'abierto'
                CHECK (estado IN ('abierto','en_progreso','completado','cancelado')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);
```

Trigger `trg_set_ticket_display_id` genera el display id a partir del serial + 1000.

---

### `api_tokens` (migración 007)

Tokens de API para acceso programático (API v1, MCP). Ver [doc 13](./13-mcp-y-tokens-api.md).

```sql
CREATE TABLE public.api_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_prefix TEXT NOT NULL,            -- primeros chars visibles ("ads_…")
  token_hash   TEXT NOT NULL UNIQUE,     -- SHA-256
  permissions  JSONB NOT NULL DEFAULT '["read:metrics","read:clients","read:campaigns"]',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);
```

---

### Tablas de Google Sheets (migraciones 023-025, 037, 050, 056, 057)

Ver [doc 08 · Integraciones](./08-integraciones.md#google-sheets--conversiones-offline) para el flujo completo.

**`conversiones_offline`** — una fila por entrada interpretada del Sheet:
`id`, `cliente_id`, `fecha`, `tipo` (`lead|venta|otro`), `cantidad`, `valor`, `fuente`, `notas`, `custom_fields` (JSONB, migr. 037), `sync_batch_id` (migr. 050), `sheet_id` + `tab_name` (migr. 056).

**`conversiones_offline_diarias`** — agregado por `(cliente_id, sheet_id, fecha, tipo, fuente)` con `total_cantidad`, `total_valor` y `custom_fields` (JSONB, migr. 024). Las columnas `percentage` se promedian ponderando por `cantidad`; las `count`/`currency` se suman.

**`conversiones_offline_sync_log`** (migr. 056) — últimos 20 resultados de sync por cliente+sheet: `status`, `rows_ok`, `rows_descartadas`, `detalle` (JSONB con la calidad por pestaña).

**`sheet_filas`** (migr. 057) — **capa cruda**: la fila del Sheet tal cual, sin
interpretar. `id`, `cliente_id`, `sheet_id`, `tab_name`, `fecha`, `fila_num`,
`valores` (JSONB `{ columna_sanitizada: texto }`), `sync_batch_id`. Es la fuente
de verdad para recalcular los campos de Sheet sin volver a llamar a Google.
Incluye filas que no llegan a ser conversión (`cantidad <= 0`). Índice GIN
`jsonb_path_ops` sobre `valores` para el filtrado por valor.

Las cuatro se reemplazan **por sheet** (no por cliente): se inserta el lote nuevo
con un `sync_batch_id` y solo entonces se borra el anterior de ese `sheet_id`, de
modo que un sheet que falla conserva sus datos.

---

### Campos de Sheet (migración 058)

Un **campo** unifica columnas equivalentes de varias pestañas bajo un nombre
visible único. Se define por cliente y se calcula desde `sheet_filas`.

**`sheet_campos`** — la definición: `clave` (slug **inmutable**, la parte pública de los tokens de informes y layouts), `nombre` (visible, renombrable sin romper nada), `rol` (`dimension|metrica|ambos`), `formato`, `agregacion` (`count|sum|avg|min|max`), `origenes` (JSONB: `[{sheet_id, tab_name, columnas[], combinar}]`, con `*` como comodín), `valores_map` (JSONB `{valor crudo normalizado: bucket}`), `valores_orden`, `sin_mapear` (`crudo|otros|ignorar`), `max_valores` + `alta_cardinalidad`, `legacy_offfield`, `recalculado_at`. `UNIQUE (cliente_id, clave)`.

**`sheet_campo_vistas`** — recortes con nombre propio ("Leads 20-100"): `campo_id`, `clave`, `nombre`, `agregacion`, `operador` (`in|not_in`), `valores[]` (buckets). Se evalúan sobre el desglose, así que crearlas o cambiarlas **no requiere recálculo**.

**`sheet_campo_valores`** — catálogo de valores crudos detectados (`valor_crudo`, `valor_norm`, `filas`, `origenes[]`, `ultima_fecha`). Alimenta el agrupador de la UI sin escanear `sheet_filas` en cada apertura del editor.

**`sheet_campo_valores_diarios`** — **el desglose diario por valor**, grano `(cliente, campo, fecha, bucket)`: `filas`, `suma`, `n_num`, `minimo`, `maximo`.
`suma` y `n_num` van separados a propósito: con ambos, un promedio agrega bien a cualquier grano (`sum(suma)/sum(n_num)`). Es lo que no ocurre con las columnas `percentage` de `conversiones_offline_diarias`, que guardan el promedio ya resuelto y acaban promediando promedios.

A diferencia de las tablas de sync, estas dos últimas son **100% derivables**: el
reemplazo es **por campo** (`delete where campo_id` + insert), no por sheet, así
que editar un campo recalcula solo lo suyo y en un instante. Si algo falla a
mitad, basta con volver a lanzar `recalcularCamposCliente`.

---

### Tablas de layouts y tabs (en BD productiva)

Estas tablas implementan el sistema de dashboards (ver [doc 10](./10-sistema-de-layouts.md)). Columnas inferidas del código:

**`layouts_reporte`** — plantillas de layout globales/reutilizables:
`id`, `nombre`, `columnas` (JSONB), `tarjetas`, `graficos`, `text_blocks`, `custom_metrics`, `blocks_order`, `source_mapping`, `attribution_strategy` (migr. 003), `created_at`, `updated_at`.

**`clientes_layouts`** — overrides de layout por cliente:
campos análogos a `layouts_reporte` + `cliente_id`, `layout_id`, `ranking_tables` (JSONB, migr. 018).

**`cliente_tabs`** — pestañas del dashboard de cada cliente:
`id`, `cliente_id`, `nombre`, `orden`, `position` (migr. 001), `public_token` (migr. 006), `archived` (migr. 015), `hotmart_funnel` (JSONB, migr. 008), `ranking_tables` (JSONB, migr. 018), referencias a layout global/custom, `created_at`, `updated_at`.

Estructura de `cliente_tabs.hotmart_funnel`:

```jsonc
{
  "enabled": true,
  "principal_names": ["Producto Pro", "Producto%"],
  "bump_names": ["Bump Producto"],
  "upsell_names": ["Upsell Producto"],
  "payment_page_url": "/checkout/producto",
  "upsell_page_url": "/upsell/producto",
}
```

---

### Tablas de usuarios/roles (en BD productiva)

**`user_profiles`** — `id` (FK `auth.users`), `role` (`superadmin|admin|trafficker|viewer`), metadatos.

**`user_client_assignments`** — relación trafficker ↔ cliente para RBAC: `user_id`, `client_id`.

Ver [doc 05 · Autenticación y roles](./05-autenticacion-y-roles.md).

---

## Schema `report_utm`

Módulo de tracking y atribución. Todas las tablas exigen rol admin (`report_utm.is_admin()`).

### `report_utm.clientes` (migración 012)

```sql
CREATE TABLE report_utm.clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  descripcion TEXT,
  color       TEXT DEFAULT 'blue',
  public_cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE,  -- 080
  config      JSONB NOT NULL DEFAULT '{}',
  status      TEXT DEFAULT 'active',     -- active | paused | archived
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`public_cliente_id` enlaza el cliente de tracking con su cliente del reporting, del que es espejo: se crea, archiva y borra con él (`src/lib/clientes/ciclo-de-vida.ts`). Los que lo tienen en NULL son huérfanos de antes de esa regla.

### `report_utm.integrations` (migración 012)

Secretos de webhook y credenciales por integración.

```sql
CREATE TABLE report_utm.integrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,            -- hotmart | meta | google | cartpanda | shopify
  webhook_secret           TEXT,
  access_token_encrypted   TEXT,
  refresh_token_encrypted  TEXT,
  config      JSONB NOT NULL DEFAULT '{}',
  status      TEXT DEFAULT 'active',
  last_sync_at TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cliente_id, tipo)
);
```

El secreto propio va cifrado en `webhook_secret_enc` (migración 066; el
`webhook_secret` en claro se migra al vuelo). En la integración `hotmart`, el hottok
que genera Hotmart y pega el usuario se guarda cifrado en `config.hottok_enc`, con
sus cuatro últimos caracteres en `config.hottok_final`.

### `report_utm.sales_events` (migraciones 012 + 014)

Tabla núcleo: cada evento de venta con UTMs y atribución.

```sql
CREATE TABLE report_utm.sales_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,            -- hotmart | cartpanda | shopify | manual…
  platform_sale_id TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency    TEXT DEFAULT 'BRL',
  status      TEXT DEFAULT 'approved',  -- approved | pending | refunded | chargeback | canceled (sin CHECK)
  -- UTMs
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_content TEXT, utm_term TEXT, utm_id TEXT,
  -- IDs de plataforma de anuncios
  ad_account_id TEXT, ad_campaign_id TEXT, ad_set_id TEXT, ad_id TEXT,
  placement TEXT, click_id TEXT,        -- fbclid/gclid/ttclid…
  -- Cliente final
  customer_id TEXT, customer_name TEXT, customer_email TEXT,
  customer_phone TEXT, customer_country TEXT,
  -- Producto
  product_id TEXT, product_name TEXT,
  transaction_type TEXT,                -- principal | bump | upsell | subscription
  raw_payload JSONB,
  -- Atribución (migr. 014)
  visitor_id TEXT,
  first_touch JSONB, last_touch JSONB,
  attribution_method TEXT,              -- click_id | visitor_cookie | utm_only | none
  attribution_resolved_at TIMESTAMPTZ,
  -- Tiempos
  sale_timestamp TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cliente_id, platform, platform_sale_id)
);
```

Índices por tiempo, UTM, plataforma, status, `click_id`, `visitor_id` y `attribution_method`.

Las filas de Hotmart son un **espejo** de `hotmart_ventas` (enlazadas por
`hotmart_venta_id`, migración 066): el webhook solo las escribe cuando el evento se
aplicó allí como el más reciente, un pedido cancelado queda como `canceled` (no
`refunded`) y sin divisa en el payload `currency` es NULL. El BI no las cuenta en
`sales.*`: esas ventas se miden en la fuente `hotmart`.

### `report_utm.tracking_links` (migración 012)

Enlaces cortos `/t/:slug` con UTMs predefinidos.

```sql
CREATE TABLE report_utm.tracking_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  slug        TEXT UNIQUE NOT NULL,
  nome        TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_content TEXT, utm_term TEXT,
  clicks_count INTEGER DEFAULT 0,
  last_click_at TIMESTAMPTZ,
  enabled     BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `report_utm.pixel_events` (migración 013)

Eventos del pixel JS (pageview, click, custom).

```sql
CREATE TABLE report_utm.pixel_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  link_id     UUID REFERENCES report_utm.tracking_links(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,            -- click | pageview | custom
  event_name  TEXT,
  visitor_id  TEXT, session_id TEXT,
  page_url TEXT, page_title TEXT, referrer TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_content TEXT, utm_term TEXT, click_id TEXT,
  user_agent TEXT, ip_country TEXT, ip_address INET,
  custom_data JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `report_utm.hourly_metrics` (migración 012)

Agregado horario de ventas por fuente/campaña.

```sql
CREATE TABLE report_utm.hourly_metrics (
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  hour        TIMESTAMPTZ NOT NULL,
  utm_source  TEXT DEFAULT '',
  utm_campaign TEXT DEFAULT '',
  sales_count INTEGER DEFAULT 0,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  refunds_count INTEGER DEFAULT 0,
  refunds_amount NUMERIC(12,2) DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cliente_id, hour, utm_source, utm_campaign)
);
```

### `report_utm.outbound_webhooks` y `outbound_deliveries` (migración 014)

Reenvío en tiempo real de eventos de venta a sistemas externos, con bitácora de entregas.

```sql
CREATE TABLE report_utm.outbound_webhooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID NOT NULL REFERENCES report_utm.clientes(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,            -- clave HMAC
  event_types TEXT[] NOT NULL DEFAULT ARRAY['sale.approved'],
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at TIMESTAMPTZ, last_status INTEGER, last_error TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE report_utm.outbound_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id  UUID NOT NULL REFERENCES report_utm.outbound_webhooks(id) ON DELETE CASCADE,
  sale_event_id UUID REFERENCES report_utm.sales_events(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  response_status INTEGER, response_body TEXT, error TEXT, duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Historial de migraciones

| Migración | Cambios                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| **001**   | `position` en `cliente_tabs`; crea `leads` y `leads_diarios`                              |
| **002**   | `sync_hash` en `metricas_diarias` (idempotencia)                                          |
| **003**   | `attribution_strategy` en layouts                                                         |
| **004**   | `report_templates` y `monthly_reports` + 3 plantillas seed                                |
| **005**   | `soporte_tickets` (con serial y trigger de display id)                                    |
| **006**   | `public_token` en `clientes` y `cliente_tabs` (enlaces públicos)                          |
| **007**   | `api_tokens`                                                                              |
| **008**   | `hotmart_funnel` en `cliente_tabs`; `hotmart_funnel_data` + conteos en `metricas_diarias` |
| **009**   | Seed de 2 plantillas de layout                                                            |
| **010**   | `ventas_bump_bruto`, `ventas_upsell_bruto` (ventas brutas)                                |
| **011**   | `ventas_cerradas` (ventas manuales)                                                       |
| **012**   | Schema `report_utm`: clientes, integrations, sales_events, tracking_links, hourly_metrics |
| **013**   | `report_utm.pixel_events`                                                                 |
| **014**   | Atribución en `sales_events`; `outbound_webhooks`, `outbound_deliveries`                  |
| **015**   | `archived` en `cliente_tabs`                                                              |
| **016**   | Métricas TikTok + `tiktok_campaigns` (JSONB)                                              |
| **017**   | `meta_ads`, `meta_adsets` (JSONB)                                                         |
| **018**   | `ranking_tables` (JSONB) en layouts y tabs                                                |
| **019**   | `tiktok_ads`, `tiktok_adgroups` (JSONB)                                                   |
| **020**   | `meta_forms` (JSONB)                                                                      |
| 021–088   | Ver la cabecera de cada archivo. Hotmart: 065 (`hotmart_ventas`), 066, 067, 070           |
| **089**   | Atribución y guarda por estado en `hotmart_ventas` (**pendiente de aplicar**)             |

---

## Resumen de políticas RLS

| Tabla                           | Condición de acceso                              |
| ------------------------------- | ------------------------------------------------ |
| `clientes`                      | `puede_ver_cliente(id)` (rol o asignación)       |
| `metricas_diarias`              | `puede_ver_cliente(cliente_id)`                  |
| `campaign_groups` / `_mappings` | propiedad por jerarquía de cliente · admin total |
| `leads` / `leads_diarios`       | `puede_ver_cliente(client_id)`                   |
| `soporte_tickets`               | `puede_ver_cliente(cliente_id)` (SELECT/INSERT)  |
| `api_tokens`                    | `auth.uid() = user_id` · admin total             |
| `report_utm.*`                  | solo admin (`report_utm.is_admin()`)             |
