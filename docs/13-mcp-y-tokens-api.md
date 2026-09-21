# 13 · MCP y tokens de API

La aplicación expone sus datos de reporting a sistemas externos y a asistentes de IA mediante **tokens de API** y un **servidor MCP** (Model Context Protocol).

La guía de uso —cómo conectar Claude Code, Claude Desktop o Cursor, y el catálogo de herramientas con sus parámetros— está **dentro de la aplicación**, en Configuración y Alertas → «Servidor MCP & API» → pestaña «MCP Server». Este documento cubre cómo está construido.

## Tokens de API

Código: `src/lib/api-token-auth.ts`. Tabla: `api_tokens`. UI: `/admin/configuracion`, pestaña «Servidor MCP & API» (`ApiTokensManager`).

### Formato y almacenamiento

- El token es `ads_` seguido de 32 caracteres base64url (`generateApiToken`).
- En BD se guarda **solo el hash SHA-256** (`token_hash`) y un prefijo visible de 12 caracteres (`token_prefix`). El valor plano se muestra **una sola vez**, al crearlo.

### Permisos (`TokenPermission`)

La lista canónica es `ALL_PERMISSIONS`, en `src/lib/api-token-auth.ts`. El schema de `POST /api/tokens` la consume directamente: estuvo escrita a mano con cinco scopes mientras el formulario ofrecía los doce, así que marcar cualquiera de los otros siete devolvía un 400 sin explicación y no se podía crear un token capaz de escribir.

| Permiso          | Habilita                                                           |
| ---------------- | ------------------------------------------------------------------ |
| `read:metrics`   | Métricas, leads, comparativas, análisis y estado de sincronización |
| `read:clients`   | Clientes, pestañas, tareas, bitácoras y reglas de alerta           |
| `read:campaigns` | Campañas de Meta y su evolución diaria                             |
| `read:reports`   | Informes BI y plantillas                                           |
| `read:context`   | Reservado; hoy no lo exige ninguna herramienta                     |
| `write:sync`     | Encolar una sincronización                                         |
| `write:context`  | Perfil de cliente, estrategia de pestaña y correcciones del agente |
| `write:reports`  | Crear informes, añadir o quitar widgets, compartir                 |
| `write:tasks`    | Tareas del roadmap y reglas de alerta                              |
| `write:logs`     | Bitácoras de cliente                                               |
| `write:clients`  | Alta y edición de clientes; consulta de usuarios y accesos         |
| `agent:chat`     | Conversar con el agente (endpoint de chat, no MCP)                 |

Conceder un scope **no concede la capacidad**: ver «Autorización en tres ejes».

### Autenticación

`authenticateApiToken(request)` acepta el token **solo** vía `Authorization: Bearer ads_…`. El fallback por query string se retiró: dejaba la credencial en logs de acceso y en la cabecera `Referer`. Verifica que esté activo y no expirado, y actualiza `last_used_at` de forma asíncrona.

### Ciclo de vida (endpoints)

- `GET /api/tokens` — listar (sin valor plano).
- `POST /api/tokens` — crear `{ name, permissions[], expires_at? }` → devuelve el token plano.
- `PATCH /api/tokens/[id]` — activar/desactivar `{ is_active }`.
- `DELETE /api/tokens/[id]` — revocar.

Ver [doc 07 · API REST](./07-api-rest.md) para la API pública v1 que consume estos tokens.

## Servidor MCP

Endpoint: `GET|POST /api/mcp` (`src/app/api/mcp/route.ts`). JSON-RPC 2.0.

### Conexión

- `GET /api/mcp` — info del servidor (sin auth):
  ```json
  {
    "name": "adshouse-reporting",
    "version": "2.0.0",
    "description": "AdsHouse Reporting Dashboard MCP Server",
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} }
  }
  ```
- `POST /api/mcp` — `initialize`, `ping` y `notifications/initialized` son abiertos; `tools/list` y `tools/call` exigen token.

Códigos de error: `-32001` token o permisos, `-32600` el cuerpo no declara `"jsonrpc": "2.0"`, `-32601` método desconocido, `-32602` falta el nombre de la herramienta, `-32603` error al ejecutarla.

### El catálogo sale del registro

Las herramientas **no se declaran aquí**. Salen de `ALL_TOOLS` (`src/lib/agent/registry.ts`), que concatena los archivos de `src/lib/agent/tools/` y los ordena alfabéticamente —el orden es estable a propósito: el catálogo encabeza el prefijo cacheado del prompt del agente, y reordenarlo invalida la caché—. El registro lo comparten el servidor MCP, el motor conversacional y la consola.

`tools/list` responde `toolsFor(ctx).map(aFormatoMcp)`: el JSON Schema de cada herramienta se deriva con `z.toJSONSchema` del mismo zod que valida su entrada, así que descripción y validación no pueden desincronizarse.

Esa misma fuente alimenta la documentación de la interfaz, a través de `catalogoPublico()` (`src/lib/agent/catalogo.ts`) y de `GET /api/agent/tools`. El panel listaba cuatro herramientas escritas a mano, una de ellas —`get_campaign_groups`— inexistente; derivarlo impide que vuelva a pasar. Lo cubre `scripts/verify-agent-catalogo.ts`.

Por dominio: `clientes` (4), `metricas` (5, incluidas las de leads), `analisis` (2), `campanas` (2, solo lectura), `contexto` (7), `informes` (6), `operaciones` (9), `administracion` (5).

### Autorización en tres ejes

Los tres se aplican a la vez y el resultado es siempre el más restrictivo.

1. **Scopes del token** — se exigen **todos** los que declara la herramienta.
2. **Nivel efectivo** — `consulta < operador < aprobador < admin`. Por MCP lo fija el techo del rol (`TECHO_POR_ROL`): viewer → `consulta`, trafficker → `operador`, admin y superadmin → `admin`. Ningún factor puede ampliarlo.
3. **Clientes visibles** — `allowedClientIds`. Pedir un cliente ajeno devuelve **404**, no 403: distinguirlos revelaría qué clientes existen.

`toolsFor` filtra el catálogo además de rechazar al ejecutar: ofrecerle al modelo una herramienta que va a ser rechazada solo sirve para que prometa lo que no puede.

### Las escrituras no se ejecutan desde MCP

Una herramienta con `mutation` registra una propuesta en `agent_action_approvals` y devuelve `pendiente_de_aprobacion` con un resumen en lenguaje natural. Aprobar exige nivel `aprobador` (riesgo `low`) o `admin` (riesgo `high`), y **quien aprueba no puede ser quien propuso**. La propuesta caduca a las 24 h. Al aprobarse, la acción se ejecuta con la identidad del proponente.

Cada llamada queda en `agent_audit_log` con herramienta, argumentos, resultado, duración y origen (`mcp`).

### Ejemplo de llamada

```bash
curl -X POST https://reportes.adshouse.cloud/api/mcp \
  -H "Authorization: Bearer ads_xxx" \
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

### Detalles que cambian las cifras

- Fechas en **hora de Colombia (UTC−5)**, no del servidor.
- Sin periodo, casi todas usan `last_30_days`; `get_leads` usa `today` y `daily_traffic_report`, ayer.
- Rangos inclusivos y con hoy incluido: `last_7_days` son 7 días.
- Tope de **180 días**; un rango mayor o con fechas futuras se recorta y se avisa en `warnings` en vez de fallar.
- `warnings` distingue «no hubo inversión» de «no pude mirar».

> El servidor MCP usa la _service role key_ (omite RLS), así que el alcance real lo imponen los tres ejes de autorización del registro, no las políticas RLS. La paridad de cifras con el dashboard la comprueba `scripts/verify-mcp-paridad.ts`.
