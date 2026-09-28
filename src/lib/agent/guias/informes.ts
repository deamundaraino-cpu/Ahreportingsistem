import 'server-only';

/**
 * Guía de uso de las herramientas de informes BI — la fuente única.
 *
 * El mismo texto llega a cuatro sitios, y por eso vive aquí y no copiado en
 * cada uno:
 *
 *   · el prompt del agente web/WhatsApp (`runner.ts construirSystem`),
 *   · las `instructions` y los prompts del servidor MCP (`/api/mcp`),
 *   · la skill de Claude Code (`.claude/skills/informes-bi/`),
 *   · la skill para subir a claude.ai (`skills/informes-bi-mcp/`).
 *
 * Las dos skills se GENERAN con `npm run skill:informes`
 * (`scripts/generar-skill-informes.ts`) y `scripts/verify-skill-informes.ts`
 * falla si el archivo en disco no coincide con lo que sale de aquí, o si la
 * guía nombra una herramienta que no existe en el registro.
 */

/**
 * Versión corta: el flujo y las reglas que no se pueden saltar. Va en cada
 * petición al modelo, así que se mantiene breve.
 */
export const GUIA_INFORMES_CORTA = [
  'Informes BI — cómo crearlos y editarlos:',
  '1. Cliente: `list_clients` o `resolve_client` da el `client_id`. Es el único id de cliente que aceptan las herramientas de informes.',
  '2. Antes de crear, `list_reports` (¿ya existe? ¿hay una plantilla?). `create_report` lo crea vacío, desde plantilla (`source_report_id`) o con `layout`, y devuelve el id al momento.',
  '3. Campos: `list_report_fields` con el `client_id`. Usa SOLO sus ids —`id` de métricas y dimensiones, `token` de respuestas, segmentos y campos de Sheet, `alias_formula` dentro de fórmulas—. Un id inventado se rechaza.',
  '4. Antes de guardar un widget, pruébalo con `preview_widget`. Si sale `todo_cero` o con `no_disponibles`, corrígelo antes de guardarlo.',
  '5. Guarda con `add_report_widget` o `update_report_widget` y revisa el resultado con `get_report`.',
  '6. Crear y editar se aplica AL MOMENTO (`estado: aplicado`) y devuelve un `revision_id`; `restore_report_revision` lo deshace. Publicar el enlace (`share_report`), borrar (`delete_report`) y cambiar de cliente (`set_report_client`) quedan `pendiente_de_aprobacion` hasta que un administrador los apruebe: dilo así, sin darlos por hechos.',
  '7. Termina siempre con el `url` del informe.',
].join('\n');

export type SeccionGuia = { id: string; titulo: string; cuerpo: string };

/** Versión larga, por secciones: la usan las skills y el prompt MCP `crear_informe`. */
export const GUIA_INFORMES_SECCIONES: SeccionGuia[] = [
  {
    id: 'flujo',
    titulo: 'Flujo de trabajo',
    cuerpo: `
1. **Identifica el cliente.** \`resolve_client\` con el nombre que diga la persona («Goodprop», «Cris») o \`list_clients\`. Guarda el \`client_id\`: es el que piden todas las herramientas de informes.
2. **Mira qué hay.** \`list_reports\` con ese \`client_id\` (y \`list_reports\` con \`solo_plantillas: true\`). Si ya existe un informe parecido, edítalo en vez de crear otro; si hay una plantilla que encaja, parte de ella.
3. **Crea el informe.** \`create_report\` con \`nombre\`, \`client_id\` y, opcionalmente, \`source_report_id\` (plantilla) o \`periodo\`. Devuelve \`informe.id\` y \`url\` al momento.
4. **Consulta los campos.** \`list_report_fields\` con el \`client_id\`. Por defecto trae las métricas recomendadas; \`buscar\` o \`solo_recomendadas: false\` amplían. Con \`dimension\` marca con \`cruza: false\` las métricas que mostrarían 0 desglosadas por ella.
5. **Prueba cada widget.** \`preview_widget\` con \`report_id\` + \`widget\` (el borrador) antes de guardarlo. Mira \`valido\`, \`todo_cero\`, \`no_disponibles\` y \`warnings\`.
6. **Guárdalo.** \`add_report_widget\` (con \`seccion_id\` para meterlo en una sección). Para retocar uno existente, \`update_report_widget\` con solo las claves que cambian.
7. **Revisa.** \`get_report\` devuelve el layout y un \`indice\` con el id de cada widget.
8. **Entrega** el \`url\` del informe y un resumen de lo que contiene. Si la persona quiere compartirlo fuera, \`share_report\` (queda pendiente de aprobación).
`.trim(),
  },
  {
    id: 'widgets',
    titulo: 'Widgets: tipos, tamaños y config',
    cuerpo: `
El layout es una lista de widgets. Cada uno: \`{type, title, w, h, config}\`; \`id\` se genera solo. \`w\` = ancho en columnas (1-4, la fila tiene 4), \`h\` = alto (1-3).

| type | Para qué | config mínima |
|---|---|---|
| \`scorecard\` | Un KPI | \`metric\` o \`formula\`; \`compare_period: true\` añade la variación |
| \`line\`, \`area\` | Evolución | \`metric\`, \`dimension: "date"\`, \`date_grouping: day/week/month\` |
| \`bar\`, \`combo\`, \`pie\`, \`scatter\` | Comparar categorías | \`metric\`, \`dimension\`, \`limit\`, \`sort\` |
| \`table\` | Varias métricas por fila | \`metric\` con columnas separadas por comas, \`dimension\`, \`show_totals\` |
| \`funnel\` | Embudo | \`metrics\`: 2 o más etapas en orden |
| \`slicer\` | Filtro interactivo | \`dimension\`, \`slicer_mode: dropdown/list/daterange\` |
| \`section\` | Agrupa widgets (colapsable) | \`children\`: los widgets de dentro; no admite secciones dentro |
| \`heading\` | Título divisor | \`text\`, \`heading_level\` 1-3 |
| \`text\` | Párrafo o comentario | \`text\` (admite **negrita** y viñetas con «- ») |
| \`summary\` | Resumen ejecutivo automático | — |

Otras claves útiles: \`color\` (#hex), \`conditional\` (colorear celdas de tabla), \`value_filters\` (ocultar filas), \`advanced_filter\` y \`campaign_filter\` (filtro propio del widget), \`variant: threshold/progress\` con \`threshold\` o \`target\` en un scorecard, \`dimension2\` (series apiladas; solo con métricas que cuentan leads o ventas).
`.trim(),
  },
  {
    id: 'tokens',
    titulo: 'Ids de métricas y dimensiones',
    cuerpo: `
Todos salen de \`list_report_fields\`. La gramática, para reconocerlos:

- **Métricas fijas**: \`spend\`, \`leads_count\`, \`cpl\`, \`roas\`, \`impressions\`, \`clicks\`, \`ctr\`, \`cpm\`, \`sales_count\`, \`revenue\`, \`hm_neto\`, \`hm_roas\`… Van tal cual en \`metric\` y en fórmulas.
- **Dimensiones fijas**: \`none\` (total), \`date\`, \`utm_campaign\` (campaña real, cruza con el gasto), \`utm_content\` (anuncio), \`utm_term\` (conjunto), \`utm_source\`, \`utm_medium\`, \`ip_country\`, \`form_name\`, \`platform\`…
- **Pregunta de formulario** (dimensión): \`leadfield:<pregunta>\`.
- **Una respuesta** (métrica: leads que la eligieron): \`leadans:<pregunta>:<respuesta>\`; en fórmulas, \`lf__<pregunta>__<respuesta>\`. \`leadans:<pregunta>:sin_respuesta\` cuenta a los que no contestaron.
- **Segmento** (métrica): \`leadseg:<clave>\`; en fórmulas, \`lseg__<clave>\`.
- **Google Sheets**: \`sheetdim:<clave>\` (dimensión), \`sheetagg:<agregación>:<clave>\` y \`sheetview:<clave>\` (métricas); en fórmulas \`sf__<clave>\` y \`sv__<clave>\`.
- **Columnas offline**: \`offfield:<tipo>:<clave>\`; en fórmulas \`off__<clave>\`.
- **Eventos clave de GA4**: \`ga4ev:<evento>\` (p. ej. \`ga4ev:purchase\`; la lista sale de \`list_report_fields\` con \`fuente: "ga4"\`); en fórmulas, \`ga4ev__<evento>\` (coste por evento: \`spend / ga4ev__<evento>\`).
- **Conversiones personalizadas de Meta**: \`metacc:<clave>\`; en fórmulas, \`mcc__<clave>\` (coste por conversión: \`spend / mcc__<clave>\`). Las que el cliente marcó como resultado se suman en \`resultados_custom\`, y su coste es \`coste_por_resultado_custom\`.

**Fórmulas** (\`config.formula\` o campos calculados): \`+ - * /\` y paréntesis sobre ids de métricas fijas y alias (\`lf__\`, \`lseg__\`, \`sf__\`, \`sv__\`, \`off__\`, \`mcc__\`, \`ga4ev__\`). Un campo calculado NO puede usarse dentro de otra fórmula. Ejemplo: \`spend / lf__rango_de_ingresos__2m_3m\`.
`.trim(),
  },
  {
    id: 'cruces',
    titulo: 'Qué se puede desglosar por qué',
    cuerpo: `
Un widget que desglosa una métrica por una dimensión que no la reparte mostraría 0 siempre; las herramientas lo rechazan. Las reglas:

- **Gasto, impresiones, clics, CTR, CPL, ROAS** (vienen de Meta/TikTok): por \`date\` y por campaña, anuncio o conjunto (\`utm_campaign\`, \`utm_content\`, \`utm_term\`, \`ad\`, \`adset\`). NO por \`utm_source\`, país, formulario ni pregunta de lead.
- **Leads, ventas, revenue, Hotmart neto**: por cualquier dimensión.
- **GA4 del sitio (\`ga_sessions\`, \`ga_bounce_rate\`, \`ga_avg_session_duration\`) y columnas offline**: solo por \`date\` (o total).
- **GA4 por campaña (\`ga4_sesiones\`, \`ga4_eventos_clave\`, \`ga4_tasa_rebote\`, \`ga4_tasa_sesion_lead\`, \`ga4ev:\`…)**: por \`date\`, campaña (\`utm_campaign\`, \`utm_id\`), \`utm_source\` y \`utm_medium\`. NO por anuncio, conjunto, país ni pregunta de lead. \`ga4_coste_sesion\`, \`ga4_coste_evento_clave\` y \`ga4_roas\` usan el gasto: solo por \`date\` y campaña. La suma por campaña puede no coincidir con \`ga_sessions\` (umbrales de privacidad de GA4): no mezcles las dos en un mismo total.
- **Conversiones de Meta (\`metacc:\`, \`resultados_custom\`)**: igual que el gasto: por \`date\` y por campaña, anuncio o conjunto.
- **MRR y métricas de suscripción**: solo total (\`dimension: "none"\`).
- **Filtrar por una pregunta de lead anula el gasto** (el gasto no se puede atribuir a una respuesta). Para medir el coste por respuesta usa una fórmula: \`spend / lf__<pregunta>__<respuesta>\`.
- **\`dimension2\`** solo funciona en barras, líneas, áreas o combo con una métrica que cuente leads o ventas.
`.trim(),
  },
  {
    id: 'recetas',
    titulo: 'Recetas',
    cuerpo: `
**Fila de KPIs** (cuatro scorecards de ancho 1):
\`\`\`json
{"type":"scorecard","title":"Inversión","w":1,"config":{"metric":"spend","compare_period":true}}
{"type":"scorecard","title":"Leads","w":1,"config":{"metric":"leads_count","compare_period":true}}
{"type":"scorecard","title":"CPL","w":1,"config":{"metric":"cpl","compare_period":true}}
{"type":"scorecard","title":"ROAS Hotmart","w":1,"config":{"metric":"hm_roas","compare_period":true}}
\`\`\`

**Evolución semanal**:
\`\`\`json
{"type":"line","title":"Leads por semana","w":4,"config":{"metric":"leads_count","dimension":"date","date_grouping":"week"}}
\`\`\`

**Tabla de campañas**:
\`\`\`json
{"type":"table","title":"Campañas","w":4,"h":2,"config":{"metric":"spend,leads_count,cpl","dimension":"utm_campaign","limit":20,"show_totals":true}}
\`\`\`

**CPL por respuesta de formulario** (con los tokens de \`list_report_fields\`):
1. \`upsert_calculated_field\` por respuesta: nombre «CPL 2M-3M», expresión \`spend / lf__rango__2m_3m\`, formato \`currency\`.
2. Barras de reparto: \`{"type":"bar","config":{"metric":"leads_count","dimension":"leadfield:rango","limit":30}}\`.
3. Tabla por campaña: \`{"type":"table","config":{"metric":"spend,leads_count,leadans:rango:2m_3m,CPL 2M-3M","dimension":"utm_campaign"}}\`.

**GA4 por campaña** (sesiones, coste por sesión y sesión → lead):
\`\`\`json
{"type":"table","title":"Tráfico por campaña","w":4,"h":2,"config":{"metric":"spend,ga4_sesiones,ga4_coste_sesion,leads_count,ga4_tasa_sesion_lead","dimension":"utm_campaign","limit":20,"show_totals":true}}
\`\`\`
Para que cruce exacto con el gasto, los anuncios de Meta deben llevar \`utm_id={{campaign.id}}\` en los parámetros de URL. Eventos clave frente a leads: \`{"metric":"leads_count,ga4ev:generate_lead","dimension":"utm_campaign"}\`.

**Embudo**: \`{"type":"funnel","config":{"metrics":["impressions","clicks","leads_count","sales_count"]}}\`. Valen como etapa los conteos y los segmentos o respuestas de lead.

**Agrupar en una sección**: crea la sección con \`add_report_widget\` (\`{"type":"section","title":"Captación","config":{"columns":4}}\`) y añade dentro con \`seccion_id\`, o pásala entera con \`children\`.
`.trim(),
  },
  {
    id: 'aprobacion',
    titulo: 'Qué se aplica al momento y qué espera aprobación',
    cuerpo: `
- **Al momento** (\`estado: aplicado\`): \`create_report\`, \`update_report\`, \`add_report_widget\`, \`update_report_widget\`, \`remove_report_widget\`, \`upsert_calculated_field\`, \`remove_calculated_field\`, \`duplicate_report\`, \`save_as_template\`, \`unshare_report\` y \`restore_report_revision\`. Cada una guarda el estado anterior y devuelve \`revision_id\`.
- **Deshacer**: \`restore_report_revision\` con ese \`revision_id\`, o \`list_report_revisions\` para ver el historial. Restaurar también se puede deshacer.
- **Con aprobación de un administrador** (\`pendiente_de_aprobacion\`): \`share_report\` (enlace público), \`delete_report\` y \`set_report_client\`. Dilo tal cual: la acción NO está hecha hasta que alguien la apruebe (hoy, por WhatsApp con «APROBAR <id>»). La propuesta caduca en 24 horas.
`.trim(),
  },
  {
    id: 'errores',
    titulo: 'Errores frecuentes',
    cuerpo: `
- **\`VALIDATION_ERROR\`**: el mensaje dice qué widget y qué campo fallan. Corrige con los ids de \`list_report_fields\` y vuelve a intentarlo; no insistas con el mismo valor.
- **\`CONFLICT\`**: alguien guardó el informe mientras lo editabas (desde el canvas u otra conversación). Vuelve a leerlo con \`get_report\` y repite el cambio.
- **\`NOT_FOUND\`** con un cliente o informe que existe: no lo tienes asignado. No intentes adivinar otro id.
- **«no tiene espejo en Report-UTM»**: ese cliente no está preparado para informes BI; se crea al darlo de alta desde el panel.
- **\`preview_widget\` con \`no_disponibles\`**: la métrica no se puede medir para ese cliente (p. ej. falta el enlace con Meta). No es un cero: explícalo en vez de mostrarlo.
`.trim(),
  },
  {
    id: 'peticiones',
    titulo: 'Ejemplos de peticiones',
    cuerpo: `
- «Crea un informe mensual de Goodprop con los KPIs, la evolución semanal de leads y una tabla de campañas.»
- «Añade al informe de Cris una tabla con el CPL de cada respuesta de la pregunta de rango de ingresos.»
- «En el informe X cambia el gráfico de leads a barras por semana y ponle el título "Leads semanales".»
- «Duplica el informe de Somos rentable para Sur Profundo.»
- «Deshaz el último cambio del informe X.»
- «Comparte el informe X con el cliente.» (queda pendiente de aprobación)
`.trim(),
  },
];

/** La guía larga como un solo markdown. */
export function guiaInformesCompleta(nivelTitulo = '##'): string {
  return GUIA_INFORMES_SECCIONES.map((s) => `${nivelTitulo} ${s.titulo}\n\n${s.cuerpo}`).join(
    '\n\n'
  );
}

/** Lo que el cliente MCP inyecta en el contexto del asistente al conectarse. */
export const INSTRUCCIONES_MCP = [
  'Servidor de reporting de una agencia de publicidad: clientes, métricas (gasto, leads, CPL, ventas), campañas e informes BI.',
  '· Casi todas las herramientas piden `client_id`: sácalo de `list_clients` o `resolve_client`.',
  '· Antes de valorar el rendimiento de un cliente usa `analyze_performance`; respeta `no_aplican` y `fuentes_ausentes`.',
  '· Los importes van en la moneda del campo `moneda`: no sumes importes de clientes distintos.',
  '',
  GUIA_INFORMES_CORTA,
].join('\n');

// ── Skills generadas ───────────────────────────────────────────────────────

export type DestinoSkill = 'claude-code' | 'claude-ai';
export type ArchivoSkill = { ruta: string; contenido: string };

const AVISO_GENERADO =
  '<!-- Generado por `npm run skill:informes` desde src/lib/agent/guias/informes.ts. No lo edites a mano. -->';

const DESCRIPCION: Record<DestinoSkill, string> = {
  'claude-code':
    'Crear, editar, previsualizar y compartir informes BI del reporting con las herramientas del servidor MCP (create_report, add_report_widget, preview_widget…).',
  'claude-ai':
    'Crea y edita informes BI de la agencia con el conector MCP del reporting: KPIs, gráficas, tablas de campañas, CPL por respuesta y enlaces para el cliente.',
};

const NOMBRE: Record<DestinoSkill, string> = {
  'claude-code': 'informes-bi',
  'claude-ai': 'informes-bi-mcp',
};

const RAIZ: Record<DestinoSkill, string> = {
  'claude-code': '.claude/skills/informes-bi',
  'claude-ai': 'skills/informes-bi-mcp',
};

function skillMd(destino: DestinoSkill): string {
  const conexion =
    destino === 'claude-code'
      ? [
          'Las herramientas son las del servidor MCP del reporting (`adshouse-reporting`, en `/api/mcp`). En Claude Code aparecen con el prefijo del servidor, p. ej. `mcp__reporting__create_report`. Si no están, conéctalo:',
          '',
          '```bash',
          'claude mcp add --transport http reporting https://<tu-app>/api/mcp \\',
          '  --header "Authorization: Bearer ads_…"',
          '```',
          '',
          'El token se crea en el panel «Servidor MCP & API» y necesita los scopes `read:clients`, `read:reports` y `write:reports`.',
        ].join('\n')
      : [
          'Las herramientas son las del conector MCP del reporting de la agencia (servidor `adshouse-reporting`). Si no aparecen, pide a la persona que conecte el conector en claude.ai → Configuración → Conectores con un token `ads_…` que tenga los scopes `read:clients`, `read:reports` y `write:reports`.',
        ].join('\n');

  return [
    '---',
    `name: ${NOMBRE[destino]}`,
    `description: ${DESCRIPCION[destino]}`,
    '---',
    '',
    AVISO_GENERADO,
    '',
    '# Informes BI del reporting',
    '',
    'Úsala cuando te pidan crear, cambiar, revisar, duplicar, deshacer o compartir un informe BI (dashboard) de un cliente de la agencia.',
    '',
    '## Conexión',
    '',
    conexion,
    '',
    '## Lo esencial',
    '',
    GUIA_INFORMES_CORTA,
    '',
    guiaInformesCompleta('##'),
    '',
    '## Más detalle',
    '',
    '- `references/tokens.md`: la gramática de ids con ejemplos.',
    '- `references/recetas.md`: widgets listos para copiar.',
    ...(destino === 'claude-code'
      ? ['- `references/desarrollo.md`: dónde vive el código y cómo se prueba.']
      : []),
    '',
  ].join('\n');
}

const DESARROLLO = `
# Desarrollo: herramientas de informes

- **Herramientas**: \`src/lib/agent/tools/informes/\` — \`lectura.ts\`, \`edicion.ts\`, \`ciclo.ts\`; validación en \`validacion.ts\` y \`esquema.ts\`; ids de cliente en \`clientes-bi.ts\`; revisiones en \`revisiones.ts\`.
- **Ejecutor**: \`src/lib/agent/execute.ts\`. \`mutation.approval: 'directa'\` (solo con \`risk: 'low'\`) se aplica al momento; el resto crea una propuesta en \`agent_action_approvals\`. \`mutation.precheck\` corre antes de proponer.
- **Motor**: \`preview_widget\` usa \`paramsDeWidget\` (\`src/lib/report-utm/bi/consulta-widget.ts\`) + \`parseBiQueryParams\` + \`dispatchBiQuery\`, igual que \`/api/report-utm/bi/query\`.
- **Catálogo**: \`catalogoEstatico\` (\`src/lib/report-utm/bi/catalogo-estatico.ts\`) y \`camposDinamicosCliente\` (\`src/lib/report-utm/bi/campos-cliente.ts\`).
- **Revisiones**: tabla \`public.bi_report_revisions\` (\`migrations/092_bi_report_revisions.sql\`).
- **Guía y skills**: \`src/lib/agent/guias/informes.ts\` es la fuente; \`npm run skill:informes\` regenera esta skill y la de claude.ai.
- **Tests**: \`npx tsx --conditions=react-server scripts/verify-agent-informes.ts\` y \`scripts/verify-skill-informes.ts\` (ambos en \`npm run test:puro\`).
`.trim();

/** Los archivos de una skill, con su ruta relativa a la raíz del repo. */
export function renderSkill(destino: DestinoSkill): ArchivoSkill[] {
  const raiz = RAIZ[destino];
  const seccion = (id: string) => GUIA_INFORMES_SECCIONES.find((s) => s.id === id)!;
  const ref = (titulo: string, cuerpo: string) => `${AVISO_GENERADO}\n\n# ${titulo}\n\n${cuerpo}\n`;
  const archivos: ArchivoSkill[] = [
    { ruta: `${raiz}/SKILL.md`, contenido: skillMd(destino) },
    {
      ruta: `${raiz}/references/tokens.md`,
      contenido: ref(
        'Ids de métricas y dimensiones',
        `${seccion('tokens').cuerpo}\n\n## ${seccion('cruces').titulo}\n\n${seccion('cruces').cuerpo}`
      ),
    },
    {
      ruta: `${raiz}/references/recetas.md`,
      contenido: ref('Recetas', seccion('recetas').cuerpo),
    },
  ];
  if (destino === 'claude-code') {
    archivos.push({
      ruta: `${raiz}/references/desarrollo.md`,
      contenido: `${AVISO_GENERADO}\n\n${DESARROLLO}\n`,
    });
  }
  return archivos;
}

export const DESTINOS_SKILL: DestinoSkill[] = ['claude-code', 'claude-ai'];

// ── Prompts MCP ────────────────────────────────────────────────────────────

export type PromptMcp = {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  construir: (args: Record<string, string | undefined>) => string;
};

export const PROMPTS_INFORMES: PromptMcp[] = [
  {
    name: 'crear_informe',
    description: 'Crear un informe BI para un cliente siguiendo el flujo recomendado.',
    arguments: [
      { name: 'cliente', description: 'Nombre del cliente.', required: true },
      {
        name: 'objetivo',
        description: 'Qué debe mostrar (KPIs, campañas, respuestas de formulario…).',
        required: false,
      },
      {
        name: 'periodo',
        description: 'Periodo por defecto, p. ej. «mes pasado».',
        required: false,
      },
    ],
    construir: (a) =>
      [
        `Crea un informe BI para el cliente «${a.cliente ?? ''}».`,
        a.objetivo
          ? `Debe mostrar: ${a.objetivo}.`
          : 'Propón un informe estándar: KPIs, evolución y tabla de campañas.',
        a.periodo ? `Periodo por defecto: ${a.periodo}.` : '',
        '',
        GUIA_INFORMES_CORTA,
        '',
        guiaInformesCompleta('##'),
      ]
        .filter((l) => l !== '')
        .join('\n'),
  },
  {
    name: 'revisar_informe',
    description: 'Revisar un informe BI: widgets que dan 0, cruces imposibles y mejoras.',
    arguments: [{ name: 'report_id', description: 'Id del informe.', required: true }],
    construir: (a) =>
      [
        `Revisa el informe ${a.report_id ?? ''}: lee su layout con get_report y comprueba cada widget con preview_widget.`,
        'Señala los que salen todo a cero, los que tienen métricas no disponibles y los cruces que no tienen sentido, y propone cambios concretos. No cambies nada sin confirmarlo con la persona.',
        '',
        GUIA_INFORMES_SECCIONES.find((s) => s.id === 'cruces')!.cuerpo,
      ].join('\n'),
  },
];
