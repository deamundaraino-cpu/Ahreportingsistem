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

| Permiso          | Habilita                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `read:metrics`   | Métricas, leads, comparativas, análisis y estado de sincronización        |
| `read:clients`   | Clientes, pestañas, tareas, bitácoras y reglas de alerta                  |
| `read:campaigns` | Campañas de Meta y su evolución diaria                                    |
| `read:reports`   | Informes BI y plantillas                                                  |
| `read:context`   | Reservado; hoy no lo exige ninguna herramienta                            |
| `write:sync`     | Sincronizar un cliente: reciente al momento, un periodo con aprobación    |
| `write:context`  | Perfil de cliente, estrategia de pestaña y correcciones del agente        |
| `write:reports`  | Crear y editar informes (al momento), compartir y borrar (con aprobación) |
| `write:tasks`    | Tareas del roadmap y reglas de alerta                                     |
| `write:logs`     | Bitácoras de cliente                                                      |
| `write:clients`  | Alta y edición de clientes; consulta de usuarios y accesos                |
| `agent:chat`     | Conversar con el agente (endpoint de chat, no MCP)                        |

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
    "version": "2.1.0",
    "description": "AdsHouse Reporting Dashboard MCP Server",
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {}, "prompts": {} }
  }
  ```
- `POST /api/mcp` — `initialize`, `ping` y `notifications/initialized` son abiertos; `tools/list`, `tools/call`, `prompts/list` y `prompts/get` exigen token.
- `initialize` devuelve `instructions`: la guía corta de uso de los informes (`INSTRUCCIONES_MCP`). `prompts/list` ofrece `crear_informe` y `revisar_informe` a los tokens con `read:reports`.

Códigos de error: `-32001` token o permisos, `-32600` el cuerpo no declara `"jsonrpc": "2.0"`, `-32601` método desconocido, `-32602` falta el nombre de la herramienta o del prompt, `-32603` error interno. Si una herramienta falla por sus datos (un widget inválido, un informe que no existe), la respuesta es un `result` con `isError: true` y `{error: {code, message}}` en el texto, como pide la spec: así el asistente lee el motivo y se corrige.

### El catálogo sale del registro

Las herramientas **no se declaran aquí**. Salen de `ALL_TOOLS` (`src/lib/agent/registry.ts`), que concatena los archivos de `src/lib/agent/tools/` y los ordena alfabéticamente —el orden es estable a propósito: el catálogo encabeza el prefijo cacheado del prompt del agente, y reordenarlo invalida la caché—. El registro lo comparten el servidor MCP, el motor conversacional y la consola.

`tools/list` responde `toolsFor(ctx).map(aFormatoMcp)`: el JSON Schema de cada herramienta se deriva con `z.toJSONSchema` del mismo zod que valida su entrada, así que descripción y validación no pueden desincronizarse.

Esa misma fuente alimenta la documentación de la interfaz, a través de `catalogoPublico()` (`src/lib/agent/catalogo.ts`) y de `GET /api/agent/tools`. El panel listaba cuatro herramientas escritas a mano, una de ellas —`get_campaign_groups`— inexistente; derivarlo impide que vuelva a pasar. Lo cubre `scripts/verify-agent-catalogo.ts`.

Por dominio: `clientes` (4), `metricas` (5, incluidas las de leads), `analisis` (2), `campanas` (2, solo lectura), `contexto` (7), `informes` (19), `operaciones` (10), `administracion` (5).

### Autorización en tres ejes

Los tres se aplican a la vez y el resultado es siempre el más restrictivo.

1. **Scopes del token** — se exigen **todos** los que declara la herramienta.
2. **Nivel efectivo** — `consulta < operador < aprobador < admin`. Por MCP lo fija el techo del rol (`TECHO_POR_ROL`): viewer → `consulta`, trafficker → `operador`, admin y superadmin → `admin`. Ningún factor puede ampliarlo.
3. **Clientes visibles** — `allowedClientIds`. Pedir un cliente ajeno devuelve **404**, no 403: distinguirlos revelaría qué clientes existen.

`toolsFor` filtra el catálogo además de rechazar al ejecutar: ofrecerle al modelo una herramienta que va a ser rechazada solo sirve para que prometa lo que no puede.

### Las escrituras no se ejecutan desde MCP (salvo editar informes y sincronizar)

Una herramienta con `mutation` registra una propuesta en `agent_action_approvals` y devuelve `pendiente_de_aprobacion` con un resumen en lenguaje natural. Aprobar exige nivel `aprobador` (riesgo `low`) o `admin` (riesgo `high`), y **quien aprueba no puede ser quien propuso**. La propuesta caduca a las 24 h. Al aprobarse, la acción se ejecuta con la identidad del proponente.

La excepción son las escrituras con `mutation.approval: 'directa'` (solo admitido con riesgo `low`: el dominio `informes` y `sync_client`): crear, editar, duplicar, guardar como plantilla, retirar el enlace y restaurar un informe se aplican al momento y devuelven `estado: 'aplicado'`. Con aprobación por paso no se podía terminar ningún informe: `create_report` devolvía «pendiente» sin id al que añadir widgets. A cambio, cada una guarda antes el estado anterior en `bi_report_revisions` (migración 092) y devuelve un `revision_id` que `restore_report_revision` deshace; la escritura es condicionada a `updated_at` y responde `CONFLICT` si otro guardó entre medias. Publicar el enlace (`share_report`), borrar (`delete_report`) y cambiar el cliente (`set_report_client`) siguen siendo propuestas de riesgo alto.

### Sincronizar un cliente

`sync_client` encola al momento TODOS los canales conectados de un cliente con su ventana de refresco (`src/lib/sync/cliente.ts`): `metricas` ayer–hoy (Meta, TikTok y los agregados de Hotmart y GA4), `sheets_conversiones`, `ga4` de los últimos días, `hotmart_ventas` de 7 días y los leads de Meta Lead Ads, GoHighLevel (contactos y oportunidades) y TikTok. «Conectado» se decide con las mismas reglas que el planner (`tieneMeta`, `tieneSheets`, `tieneGa4`, `hotmartConectado`, integraciones de `report_utm`). Lleva un freno para la instancia Micro: no reencola lo que ya está en curso y no hace nada si el agente la lanzó hace menos de 10 minutos. Después despierta a `/api/worker/run-jobs`, como el botón del dashboard.

`trigger_sync` vuelve a traer un periodo (`desde`/`hasta`, hasta 90 días, troceado en tramos) y sigue siendo una propuesta.

Los jobs de leads por cliente llevan `params.rtm_cliente_id`: sus rutas filtran `report_utm.integrations` por el id de `report_utm.clientes`, y `sync_jobs.cliente_id` es el público. Antes de esto, un job de leads por cliente llegaba con el id público, no casaba ninguna integración y se daba por hecho sin sincronizar nada; ahora, si le falta el id, falla (`clienteDeLeads` en `src/lib/sync/runner.ts`).

`mutation.precheck` corre antes de registrar la propuesta, con los permisos de quien la pide: un informe ajeno o inexistente se rechaza al proponer, no al aprobar.

Cada llamada queda en `agent_audit_log` con herramienta, argumentos, resultado, duración y origen (`mcp`).

### Informes: ids de cliente y guía de uso

`bi_reports.cliente_id` apunta a `report_utm.clientes` (FK desde la 080), mientras que `list_clients` y `allowedClientIds` hablan de `public.clientes`. Las herramientas de informes aceptan y devuelven SIEMPRE el id público y traducen por `public_cliente_id` en `src/lib/agent/tools/informes/clientes-bi.ts`. Antes se mezclaban: `create_report` guardaba el id público (choca con la FK), a quien no era admin cualquier informe le daba 404, y `list_reports` sin cliente listaba los de todos.

Antes de guardar, cada widget se valida (`validacion.ts`): esquema alineado con `BiTypes` (secciones con `children`, `heading_level` 1-3), que métricas y dimensiones existan —también las del cliente, con `camposDinamicosCliente`—, que la fórmula se entienda (`validateRefs`) y que ninguna métrica se desglose por una dimensión que la dejaría en 0. `preview_widget` ejecuta la consulta del widget con el mismo `parseBiQueryParams` + `dispatchBiQuery` que el canvas (`src/lib/report-utm/bi/consulta-widget.ts`).

La guía de uso vive en `src/lib/agent/guias/informes.ts` y llega al prompt del agente, a las `instructions` y prompts del MCP y a dos skills generadas con `npm run skill:informes`: `.claude/skills/informes-bi/` (Claude Code) y `skills/informes-bi-mcp/` (para subir a claude.ai; `-- --zip` genera el zip). `scripts/verify-skill-informes.ts` falla si se desincronizan.

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
- Los importes (gasto, CPL, CPC, ventas de Hotmart) van en la **moneda de reporte** del cliente, que no siempre es USD: cada respuesta con dinero lleva `moneda` (código ISO) y las descripciones piden citarla con ese código. Las ventas de Hotmart se convierten con la tasa de cada día, como en el dashboard; un día sin tasa se queda en USD y se avisa en `warnings`.

> El servidor MCP usa la _service role key_ (omite RLS), así que el alcance real lo imponen los tres ejes de autorización del registro, no las políticas RLS. La paridad de cifras con el dashboard la comprueba `scripts/verify-mcp-paridad.ts`.
