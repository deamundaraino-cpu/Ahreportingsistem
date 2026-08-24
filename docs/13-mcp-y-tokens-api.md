# 13 · MCP y tokens de API

La aplicación expone sus datos de reporting a sistemas externos y a asistentes de IA mediante **tokens de API** y un **servidor MCP** (Model Context Protocol).

## Tokens de API

Código: `src/lib/api-token-auth.ts`. Tabla: `api_tokens`. UI: `/admin/api-tokens` (`ApiTokensManager`).

### Formato y almacenamiento

- El token tiene el formato `ads_<prefijo>_<secreto>`.
- En BD se guarda **solo el hash SHA-256** (`token_hash`) y un prefijo visible (`token_prefix`). El valor plano se muestra **una sola vez**, al crearlo.

### Permisos (`TokenPermission`)

| Permiso          | Habilita                  |
| ---------------- | ------------------------- |
| `read:metrics`   | Métricas y resúmenes      |
| `read:clients`   | Listar clientes           |
| `read:campaigns` | Grupos de campañas        |
| `read:reports`   | Reportes mensuales        |
| `write:sync`     | Disparar sincronizaciones |

### Autenticación

`authenticateApiToken(request)` acepta el token **solo** vía `Authorization: Bearer ads_…`. El fallback por query string se retiró: dejaba la credencial en logs de acceso y en la cabecera `Referer`. Verifica que esté activo y no expirado, y actualiza `last_used_at` de forma asíncrona. `requirePermission(context, permission)` lanza 403 si falta el scope.

### Ciclo de vida (endpoints)

- `GET /api/tokens` — listar (sin valor plano).
- `POST /api/tokens` — crear `{ name, permissions[], expires_at? }` → devuelve el token plano.
- `PATCH /api/tokens/[id]` — activar/desactivar `{ is_active }`.
- `DELETE /api/tokens/[id]` — revocar.

Ver [doc 07 · API REST](./07-api-rest.md) para la API pública v1 que consume estos tokens.

## Servidor MCP

Endpoint: `GET|POST /api/mcp` (`src/app/api/mcp/route.ts`). Permite que asistentes de IA (Claude, Cursor, etc.) consulten los datos del dashboard vía **JSON-RPC 2.0**.

### Conexión

- `GET /api/mcp` — info del servidor (sin auth):
  ```json
  {
    "name": "adshouse-reporting",
    "version": "1.1.0",
    "description": "AdsHouse Reporting Dashboard MCP Server",
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} }
  }
  ```
- `POST /api/mcp` — requiere token (solo `Authorization: Bearer`). Métodos JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`.

### Herramientas disponibles

| Herramienta    | Permiso        | Parámetros                              | Devuelve                                                                              |
| -------------- | -------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `list_clients` | `read:clients` | —                                       | Lista de clientes (`id`, `nombre`, `created_at`)                                      |
| `get_tabs`     | `read:clients` | `client_id`                             | Info del cliente + tabs (con `keyword_meta`, `orden`, `presupuesto_objetivo`)         |
| `get_metrics`  | `read:metrics` | `client_id`, `from?`, `to?`, `keyword?` | Serie diaria (spend, impressions, clicks, conversiones custom); filtrable por keyword |
| `get_summary`  | `read:metrics` | `client_id`, `from?`, `to?`, `keyword?` | Totales agregados (ROAS, CTR, CPC, CPL por tipo)                                      |

### Ejemplo de llamada

```bash
curl -X POST https://reportes.adshouse.cloud/api/mcp \
  -H "Authorization: Bearer ads_xxx_yyy" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_summary",
      "arguments": { "client_id": "uuid", "from": "2026-05-01", "to": "2026-05-31" }
    }
  }'
```

### Configuración como servidor MCP en un cliente

Apunta el cliente MCP al endpoint HTTP con el token en la cabecera. La página `/admin/api-tokens` muestra la URL base a usar (`NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_SUPABASE_URL`).

> El servidor MCP usa la _service role key_ para leer datos (omite RLS), por lo que el alcance real lo limitan los **permisos del token**, no las políticas RLS.
