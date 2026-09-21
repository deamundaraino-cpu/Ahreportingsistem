'use client';

/**
 * Documentación del servidor MCP.
 *
 * Antes era una tarjeta con el endpoint y cuatro herramientas escritas a mano
 * —una de ellas inexistente—, así que quien seguía las instrucciones acababa
 * preguntando por algo que el servidor no sabía hacer. Ahora el catálogo se pide
 * a `/api/agent/tools`, que lo deriva del registro: la lista no puede
 * desincronizarse de lo que responde `tools/list`.
 *
 * El texto explica también lo que no se ve en un schema y decide si una
 * respuesta es correcta o no: que las escrituras pasan por aprobación, que el
 * rol de la aplicación pone el techo por encima de los scopes, y que las fechas
 * se calculan en hora de Colombia.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Key,
  Lock,
  MessageSquare,
  Plug,
  Search,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react';
import { CopyButton } from './CopyButton';
import { PERMISSION_LABELS, type TokenPermission } from '@/lib/api-token-auth';
import type { ToolDoc } from '@/lib/agent/catalogo';

// ─── Piezas de presentación ──────────────────────────────────────────────────

/** Bloque de código con su botón de copiar. Un único sitio con el contenido. */
function Bloque({ codigo, wrap = false }: { codigo: string; wrap?: boolean }) {
  return (
    <div className="relative">
      <pre
        className={`bg-zinc-950 border border-zinc-800 rounded-lg p-3 pr-12 text-xs text-zinc-300 overflow-x-auto ${
          wrap ? 'whitespace-pre-wrap' : ''
        }`}
      >
        {codigo}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={codigo} />
      </div>
    </div>
  );
}

function Aviso({
  tono = 'amber',
  children,
}: {
  tono?: 'amber' | 'blue';
  children: React.ReactNode;
}) {
  const clases =
    tono === 'amber'
      ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
      : 'text-sky-700 dark:text-sky-400 bg-sky-500/10 border-sky-500/20';
  return (
    <div className={`flex items-start gap-2 text-sm border rounded-lg p-3 ${clases}`}>
      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Ficha({
  icono: Icono,
  titulo,
  children,
}: {
  icono: typeof Zap;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground text-base flex items-center gap-2">
          <Icono className="h-4 w-4 text-muted-foreground" /> {titulo}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-foreground/90">{children}</CardContent>
    </Card>
  );
}

/** Código en línea, para nombres de campo y valores dentro de un párrafo. */
function C({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted px-1 rounded text-xs font-mono">{children}</code>;
}

// ─── Catálogo de herramientas ────────────────────────────────────────────────

const DOMINIOS: { id: string; titulo: string; resumen: string }[] = [
  {
    id: 'clientes',
    titulo: 'Clientes y pestañas',
    resumen: 'El punto de partida: de aquí salen los client_id y tab_id que piden las demás.',
  },
  {
    id: 'metricas',
    titulo: 'Métricas y leads',
    resumen: 'Cifras diarias, totales, comparativas y los leads en tiempo real.',
  },
  {
    id: 'analisis',
    titulo: 'Análisis con contexto',
    resumen: 'Dossieres que traen las cifras ya acompañadas de su estrategia y sus metas.',
  },
  {
    id: 'campanas',
    titulo: 'Campañas',
    resumen: 'Solo lectura. Pausar o cambiar presupuestos se sigue haciendo en Meta.',
  },
  {
    id: 'contexto',
    titulo: 'Contexto y estrategia',
    resumen: 'Qué vende cada cliente, hasta dónde mide y qué metas se le aplican.',
  },
  { id: 'informes', titulo: 'Informes BI', resumen: 'Crear, revisar y compartir informes.' },
  {
    id: 'operaciones',
    titulo: 'Operaciones y tareas',
    resumen: 'Roadmap, bitácoras, alertas y estado de la sincronización.',
  },
  {
    id: 'administracion',
    titulo: 'Administración',
    resumen: 'Alta de clientes y accesos. Crear usuarios o cambiar roles no se puede desde aquí.',
  },
];

/** Placeholder de ejemplo según el tipo, para el curl de cada herramienta. */
function ejemploValor(tipo: string, valores: string[] | null): string {
  if (valores && valores.length > 0) return `"${valores[0]}"`;
  if (tipo === 'uuid') return '"00000000-0000-0000-0000-000000000000"';
  if (tipo.startsWith('fecha')) return '"2026-09-01"';
  if (tipo === 'número' || tipo === 'entero') return '0';
  if (tipo === 'sí/no') return 'false';
  if (tipo === 'objeto') return '{}';
  if (tipo.startsWith('lista')) return '[]';
  return '"…"';
}

/** Una llamada de ejemplo con los argumentos obligatorios ya puestos. */
function ejemploCurl(tool: ToolDoc, appUrl: string): string {
  const args = tool.parametros
    .filter((p) => p.requerido)
    .map((p) => `"${p.nombre}":${ejemploValor(p.tipo, p.valores)}`)
    .join(',');

  const cuerpo = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${tool.name}","arguments":{${args}}}}`;

  return `curl -X POST ${appUrl}/api/mcp \\
  -H "Authorization: Bearer ads_TU_TOKEN_AQUI" \\
  -H "Content-Type: application/json" \\
  -d '${cuerpo}'`;
}

function EtiquetaScope({ scope }: { scope: TokenPermission }) {
  const escribe = scope.startsWith('write:');
  return (
    <span
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
        escribe
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
          : 'bg-muted text-muted-foreground border-border'
      }`}
      title={PERMISSION_LABELS[scope] ?? scope}
    >
      {scope}
    </span>
  );
}

function FilaTool({ tool, appUrl }: { tool: ToolDoc; appUrl: string }) {
  const [abierto, setAbierto] = useState(false);

  return (
    <div className="rounded-lg bg-muted/40 border border-border overflow-hidden">
      <button
        onClick={() => setAbierto((v) => !v)}
        className="w-full text-left p-3 flex items-start gap-3 hover:bg-accent/40 transition-colors"
      >
        {abierto ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-emerald-600 dark:text-emerald-400 text-xs font-mono font-semibold">
              {tool.name}
            </code>
            {tool.scopes.map((s) => (
              <EtiquetaScope key={s} scope={s} />
            ))}
            {tool.minLevel !== 'consulta' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border">
                nivel {tool.minLevel}
              </span>
            )}
            {tool.riesgo !== null && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  tool.riesgo === 'high'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
                }`}
              >
                {tool.riesgo === 'high' ? 'escribe · riesgo alto' : 'escribe · aprobación'}
              </span>
            )}
          </div>
          <p className="text-sm text-foreground/90">{tool.description}</p>
        </div>
      </button>

      {abierto && (
        <div className="px-3 pb-3 pl-10 space-y-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-2">Parámetros</p>
            {tool.parametros.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recibe ninguno.</p>
            ) : (
              <div className="space-y-2">
                {tool.parametros.map((p) => (
                  <div key={p.nombre} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-xs font-mono text-foreground">{p.nombre}</code>
                      <span className="text-[10px] text-muted-foreground font-mono">{p.tipo}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          p.requerido
                            ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {p.requerido ? 'obligatorio' : 'opcional'}
                      </span>
                    </div>
                    {p.descripcion && (
                      <p className="text-xs text-muted-foreground mt-0.5">{p.descripcion}</p>
                    )}
                    {p.valores && (
                      <p className="text-xs text-muted-foreground/80 mt-0.5 font-mono break-words">
                        {p.valores.join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-2">Llamada de ejemplo</p>
            <Bloque codigo={ejemploCurl(tool, appUrl)} wrap />
          </div>
        </div>
      )}
    </div>
  );
}

function Catalogo({ appUrl }: { appUrl: string }) {
  const [tools, setTools] = useState<ToolDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [abiertos, setAbiertos] = useState<string[]>([]);

  useEffect(() => {
    let vivo = true;
    fetch('/api/agent/tools')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => vivo && setTools(d.tools ?? []))
      .catch((e) => vivo && setError(e instanceof Error ? e.message : 'Error desconocido'));
    return () => {
      vivo = false;
    };
  }, []);

  const filtradas = useMemo(() => {
    if (!tools) return [];
    const t = q.trim().toLowerCase();
    if (!t) return tools;
    return tools.filter(
      (x) =>
        x.name.toLowerCase().includes(t) ||
        x.description.toLowerCase().includes(t) ||
        x.scopes.some((s) => s.toLowerCase().includes(t)) ||
        x.parametros.some((p) => p.nombre.toLowerCase().includes(t))
    );
  }, [tools, q]);

  const grupos = useMemo(() => {
    const conocidos = DOMINIOS.map((d) => ({
      ...d,
      tools: filtradas.filter((t) => t.domain === d.id),
    }));
    // Un dominio nuevo en el registro no debe desaparecer de la pantalla solo
    // porque nadie se acordó de añadirlo a DOMINIOS.
    const ids = new Set(DOMINIOS.map((d) => d.id));
    const huerfanos = filtradas.filter((t) => !ids.has(t.domain));
    const extra = [...new Set(huerfanos.map((t) => t.domain))].map((id) => ({
      id,
      titulo: id,
      resumen: '',
      tools: huerfanos.filter((t) => t.domain === id),
    }));
    return [...conocidos, ...extra].filter((g) => g.tools.length > 0);
  }, [filtradas]);

  const buscando = q.trim().length > 0;

  if (error) {
    return (
      <Aviso>
        <p>No se pudo cargar el catálogo de herramientas ({error}).</p>
        <p className="opacity-80">
          La lista siempre se puede pedir al propio servidor con el método <C>tools/list</C>.
        </p>
      </Aviso>
    );
  }

  if (!tools) {
    return <p className="text-sm text-muted-foreground">Cargando catálogo…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, descripción, scope o parámetro…"
            className="w-full bg-background border border-input rounded-lg pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtradas.length} de {tools.length}
        </span>
      </div>

      {grupos.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Ninguna herramienta coincide con «{q}».
        </p>
      )}

      {grupos.map((g) => {
        // Al buscar, los grupos con resultados se abren solos: obligar a hacer
        // clic en cada uno para ver si hay algo dentro anula el buscador.
        const abierto = buscando || abiertos.includes(g.id);
        return (
          <div key={g.id} className="rounded-xl border border-border bg-muted/20 overflow-hidden">
            <button
              onClick={() =>
                setAbiertos((prev) =>
                  prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]
                )
              }
              className="w-full flex items-center gap-2 px-4 py-3 hover:bg-accent/40 transition-colors text-left"
            >
              {abierto ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-foreground">{g.titulo}</span>
                {g.resumen && <p className="text-xs text-muted-foreground mt-0.5">{g.resumen}</p>}
              </div>
              <span className="text-xs text-muted-foreground">{g.tools.length}</span>
            </button>

            {abierto && (
              <div className="p-3 pt-0 space-y-2">
                {g.tools.map((t) => (
                  <FilaTool key={t.name} tool={t} appUrl={appUrl} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Conexión desde cada cliente ─────────────────────────────────────────────

type Cliente = 'claude-code' | 'claude-desktop' | 'cursor' | 'curl';

const CLIENTES: { id: Cliente; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'curl', label: 'curl' },
];

function Conexion({ appUrl }: { appUrl: string }) {
  const [cliente, setCliente] = useState<Cliente>('claude-code');
  const endpoint = `${appUrl}/api/mcp`;

  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-background border border-border rounded-lg p-1 w-fit">
        {CLIENTES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCliente(c.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              cliente === c.id
                ? 'bg-brand-blue text-white shadow'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {cliente === 'claude-code' && (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            Un solo comando en la terminal, dentro del proyecto donde quieras usarlo:
          </p>
          <Bloque
            wrap
            codigo={`claude mcp add --transport http adshouse ${endpoint} \\
  --header "Authorization: Bearer ads_TU_TOKEN_AQUI"`}
          />
          <p className="text-muted-foreground">
            Compruébalo con <C>claude mcp list</C>, o con <C>/mcp</C> dentro de una sesión. Para
            quitarlo, <C>claude mcp remove adshouse</C>.
          </p>
        </div>
      )}

      {cliente === 'claude-desktop' && (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            Claude Desktop habla con servidores locales, así que necesita el puente{' '}
            <C>mcp-remote</C> (se descarga solo con <C>npx</C>). Añade esto a{' '}
            <C>claude_desktop_config.json</C>:
          </p>
          <Bloque
            codigo={`{
  "mcpServers": {
    "adshouse": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${endpoint}",
        "--header",
        "Authorization:\${ADSHOUSE_TOKEN}"
      ],
      "env": {
        "ADSHOUSE_TOKEN": "Bearer ads_TU_TOKEN_AQUI"
      }
    }
  }
}`}
          />
          <p className="text-muted-foreground">
            El token va en <C>env</C> y no directamente en <C>args</C> a propósito: algunos sistemas
            parten los argumentos por el espacio de <C>&quot;Authorization: Bearer …&quot;</C> y la
            cabecera llega cortada.
          </p>
          <p className="text-muted-foreground">
            El archivo está en <C>%APPDATA%\Claude\claude_desktop_config.json</C> (Windows) o{' '}
            <C>~/Library/Application Support/Claude/claude_desktop_config.json</C> (macOS). Reinicia
            Claude Desktop después de guardarlo.
          </p>
        </div>
      )}

      {cliente === 'cursor' && (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            Cursor conecta por HTTP sin puente. En <C>.cursor/mcp.json</C> (el proyecto) o{' '}
            <C>~/.cursor/mcp.json</C> (todos):
          </p>
          <Bloque
            codigo={`{
  "mcpServers": {
    "adshouse": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer ads_TU_TOKEN_AQUI"
      }
    }
  }
}`}
          />
          <p className="text-muted-foreground">
            Windsurf y el resto de clientes con transporte HTTP usan esta misma forma: una{' '}
            <C>url</C> y una cabecera <C>Authorization</C>.
          </p>
        </div>
      )}

      {cliente === 'curl' && (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            Útil para comprobar que el token funciona antes de tocar ninguna configuración.
          </p>
          <p className="text-xs font-semibold text-muted-foreground">
            1 · El servidor responde (no hace falta token)
          </p>
          <Bloque wrap codigo={`curl ${endpoint}`} />
          <p className="text-xs font-semibold text-muted-foreground">
            2 · Qué herramientas te deja usar tu token
          </p>
          <Bloque
            wrap
            codigo={`curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ads_TU_TOKEN_AQUI" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}
          />
          <p className="text-xs font-semibold text-muted-foreground">3 · Llamar a una</p>
          <Bloque
            wrap
            codigo={`curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ads_TU_TOKEN_AQUI" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_clients","arguments":{}}}'`}
          />
        </div>
      )}
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function McpDocs({ appUrl, onIrATokens }: { appUrl: string; onIrATokens: () => void }) {
  const endpoint = `${appUrl}/api/mcp`;

  return (
    <div className="space-y-4">
      {/* Qué es */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-brand-blue dark:text-brand-blue-light" /> MCP Server —
            Integración con IA
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-foreground/90">
          <p>
            MCP (<em>Model Context Protocol</em>) es la forma estándar de que un asistente como{' '}
            <strong>Claude</strong>, <strong>Cursor</strong> o <strong>Windsurf</strong> consulte
            estos datos por su cuenta. En vez de exportar un CSV y pegarlo en el chat, el asistente
            llama a las herramientas del dashboard y recibe las mismas cifras que ves en pantalla:
            el gasto, los leads y las métricas derivadas se calculan con el mismo código.
          </p>
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
            <span className="text-zinc-500 text-xs">Endpoint MCP</span>
            <div className="flex items-center gap-2">
              <code className="text-emerald-300 text-sm font-mono flex-1 break-all">
                {endpoint}
              </code>
              <CopyButton value={endpoint} />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              ['1 · Crea un token', 'En «Mis Tokens». Marca solo lo que vayas a necesitar.'],
              ['2 · Conecta el asistente', 'Un comando o un bloque de JSON, según el cliente.'],
              ['3 · Pregunta', 'En lenguaje natural. Él elige la herramienta.'],
            ].map(([titulo, texto]) => (
              <div key={titulo} className="rounded-lg bg-muted/40 border border-border p-3">
                <p className="text-xs font-semibold text-foreground">{titulo}</p>
                <p className="text-xs text-muted-foreground mt-1">{texto}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Paso 1 */}
      <Ficha icono={Key} titulo="Paso 1 · Crea un token">
        <p>
          El servidor solo atiende peticiones con la cabecera <C>Authorization: Bearer ads_…</C>. El
          token se crea en la pestaña <strong>Mis Tokens</strong> y{' '}
          <strong>se muestra una sola vez</strong>: de él se guarda solo un hash, así que si lo
          pierdes hay que crear otro.
        </p>
        <Bloque codigo={`Authorization: Bearer ads_TU_TOKEN_AQUI`} />
        <p>
          Los permisos que marques son el <strong>techo</strong> de ese token. Cada herramienta pide
          los suyos y se exigen todos: un token sin <C>read:metrics</C> ni siquiera ve{' '}
          <C>get_metrics</C> en la lista.
        </p>
        <div className="rounded-lg border border-border overflow-hidden">
          {(
            [
              ['read:clients', 'Clientes, pestañas, tareas, bitácoras y reglas de alerta.'],
              [
                'read:metrics',
                'Métricas, leads, comparativas, análisis y estado de sincronización.',
              ],
              ['read:campaigns', 'Campañas de Meta y su evolución diaria.'],
              ['read:reports', 'Informes BI y plantillas.'],
              ['write:sync', 'Encolar una sincronización.'],
              ['write:context', 'Perfil del cliente, estrategia de pestaña y correcciones.'],
              ['write:reports', 'Crear informes, añadir o quitar widgets, compartir.'],
              ['write:tasks', 'Tareas del roadmap y reglas de alerta.'],
              ['write:logs', 'Bitácoras del cliente.'],
              ['write:clients', 'Alta y edición de clientes, y consulta de usuarios y accesos.'],
            ] as const
          ).map(([scope, texto]) => (
            <div
              key={scope}
              className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-b-0"
            >
              <code
                className={`text-xs font-mono mt-0.5 min-w-[120px] ${
                  scope.startsWith('write:')
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {scope}
              </code>
              <span className="text-sm text-muted-foreground flex-1">{texto}</span>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          <C>read:context</C> y <C>agent:chat</C> existen para otros usos —el chat del agente— y hoy
          no los exige ninguna herramienta MCP.
        </p>
        <Button
          onClick={onIrATokens}
          className="nav-active-blue text-white border-0 hover:opacity-90"
        >
          <Key className="h-4 w-4 mr-2" /> Ir a Mis Tokens
        </Button>
      </Ficha>

      {/* Paso 2 */}
      <Ficha icono={Plug} titulo="Paso 2 · Conecta tu asistente">
        <Conexion appUrl={appUrl} />
      </Ficha>

      {/* Paso 3 */}
      <Ficha icono={Sparkles} titulo="Paso 3 · Qué preguntarle">
        <p>
          No hace falta nombrar las herramientas: el asistente las encadena solo. Lo que sí conviene
          es nombrar al cliente y el periodo.
        </p>
        <div className="space-y-2">
          {[
            '¿Cómo va Goodprop este mes comparado con el anterior?',
            '¿Cuántos leads llevamos hoy y de qué campañas vienen?',
            'Dame el reporte de tráfico de ayer de todos los clientes activos.',
            '¿Por qué no cuadra el CPL por campaña de este cliente?',
            'Analiza la pestaña de lanzamiento y dime si va bien según su estrategia.',
          ].map((p) => (
            <div
              key={p}
              className="flex items-start gap-2 rounded-lg bg-muted/40 border border-border p-2.5"
            >
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <span className="text-sm text-foreground/90">{p}</span>
            </div>
          ))}
        </div>
        <Aviso tono="blue">
          <p>
            Pídele que empiece por <C>get_client_profile</C> cuando vaya a opinar sobre el
            rendimiento. Ese perfil dice qué fuentes NO tiene ese cliente a propósito, y sin él es
            fácil que reporte como carencia algo que está montado así queriendo.
          </p>
        </Aviso>
      </Ficha>

      {/* Catálogo */}
      <Ficha icono={Wrench} titulo="Herramientas disponibles">
        <p className="text-muted-foreground">
          Esta lista sale del registro del servidor, así que es exactamente lo que devuelve{' '}
          <C>tools/list</C>. Despliega una herramienta para ver sus parámetros y una llamada de
          ejemplo. Tu token verá solo las que sus permisos y tu rol permitan.
        </p>
        <Catalogo appUrl={appUrl} />
      </Ficha>

      {/* Permisos */}
      <Ficha icono={Shield} titulo="Quién puede hacer qué">
        <p>
          Sobre los permisos del token manda tu <strong>rol en la aplicación</strong>, y el
          resultado es siempre el más restrictivo de los dos. Un token con <C>write:clients</C> en
          manos de un <em>viewer</em> sigue siendo de solo lectura.
        </p>
        <div className="rounded-lg border border-border overflow-hidden">
          {(
            [
              ['viewer', 'consulta', 'Solo herramientas de lectura.'],
              [
                'trafficker',
                'operador',
                'Además, las escrituras corrientes (tareas, bitácoras, informes, sync).',
              ],
              ['admin / superadmin', 'admin', 'Todo, incluidas las de riesgo alto.'],
            ] as const
          ).map(([rol, nivel, texto]) => (
            <div
              key={rol}
              className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-b-0"
            >
              <span className="text-xs font-medium text-foreground min-w-[130px]">{rol}</span>
              <code className="text-xs font-mono text-muted-foreground min-w-[70px]">{nivel}</code>
              <span className="text-sm text-muted-foreground flex-1">{texto}</span>
            </div>
          ))}
        </div>
        <p>
          Además, un token solo alcanza <strong>los clientes que ya tienes asignados</strong>. Pedir
          otro no devuelve «prohibido» sino «no se encuentra»: distinguirlos revelaría qué clientes
          existen en la cuenta.
        </p>
        <Aviso>
          <p className="font-medium">Ninguna escritura se ejecuta sola.</p>
          <p>
            Las herramientas marcadas como <em>escribe</em> registran una propuesta y devuelven{' '}
            <C>pendiente_de_aprobacion</C> con un resumen en castellano. Una persona distinta de
            quien la propuso tiene que aprobarla, y la propuesta caduca a las 24 horas. Las de{' '}
            <em>riesgo alto</em> —compartir un informe, dar de alta un cliente, dar acceso a un
            usuario— exigen que quien apruebe sea administrador.
          </p>
        </Aviso>
        <p className="text-muted-foreground text-xs">
          Cada llamada queda registrada con la herramienta, los argumentos, si salió bien y cuánto
          tardó.
        </p>
      </Ficha>

      {/* Detalles que cambian las cifras */}
      <Ficha icono={Clock} titulo="Detalles que cambian las respuestas">
        <ul className="space-y-2 list-disc pl-4 marker:text-muted-foreground">
          <li>
            <strong>Las fechas son de Colombia (UTC−5)</strong>, no del servidor. «Hoy» y «ayer» se
            calculan ahí, que es como se leen los informes.
          </li>
          <li>
            Si no pasas periodo, casi todas usan <C>last_30_days</C>. Las excepciones son{' '}
            <C>get_leads</C>, que usa <C>today</C>, y <C>daily_traffic_report</C>, que usa ayer.
          </li>
          <li>
            Los presets incluyen el día de hoy: <C>last_7_days</C> son 7 días, no 8. Los rangos son
            inclusivos por los dos extremos.
          </li>
          <li>
            El rango máximo es de <strong>180 días</strong>. Si pides más, o pides fechas futuras,
            el servidor lo recorta y lo dice en <C>warnings</C> en vez de fallar.
          </li>
          <li>
            <C>warnings</C> no es decorativo: distingue «no hubo inversión» de «no pude mirar». Si
            viene con algo, merece la pena leerlo antes de dar una cifra por buena.
          </li>
          <li>
            Para acotar a una estrategia usa el <C>tab_id</C> de <C>get_tabs</C>. No intentes
            reconstruir el filtro a partir de su texto: las pestañas con filtro compuesto
            devolverían cero.
          </li>
          <li>
            <C>get_leads</C> son los leads reales en tiempo real (GoHighLevel, Meta Lead Ads,
            formulario web). El <C>meta_leads</C> de <C>get_metrics</C> es lo que reportó Meta en la
            última sincronización. No tienen por qué coincidir.
          </li>
        </ul>
      </Ficha>

      {/* Protocolo */}
      <Ficha icono={Terminal} titulo="Referencia del protocolo">
        <p className="text-muted-foreground">
          JSON-RPC 2.0 sobre HTTP. <C>GET</C> devuelve la ficha del servidor; todo lo demás va por{' '}
          <C>POST</C>.
        </p>
        <Bloque
          codigo={`{
  "name": "adshouse-reporting",
  "version": "2.0.0",
  "protocolVersion": "2024-11-05",
  "capabilities": { "tools": {} }
}`}
        />
        <div className="rounded-lg border border-border overflow-hidden">
          {(
            [
              ['initialize', 'no', 'Negociación inicial.'],
              ['ping', 'no', 'Comprobar que responde.'],
              ['notifications/initialized', 'no', 'Aviso de arranque del cliente.'],
              ['tools/list', 'sí', 'Las herramientas que permite tu token.'],
              ['tools/call', 'sí', 'Ejecuta una. El resultado viaja como texto JSON.'],
            ] as const
          ).map(([metodo, auth, texto]) => (
            <div
              key={metodo}
              className="flex items-start gap-3 px-3 py-2 border-b border-border last:border-b-0"
            >
              <code className="text-xs font-mono text-foreground min-w-[180px]">{metodo}</code>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  auth === 'sí'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {auth === 'sí' ? 'token' : 'abierto'}
              </span>
              <span className="text-sm text-muted-foreground flex-1">{texto}</span>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground">
          Códigos de error: <C>-32001</C> token inválido o permisos insuficientes, <C>-32601</C>{' '}
          método desconocido, <C>-32602</C> falta el nombre de la herramienta, <C>-32603</C> error
          al ejecutarla.
        </p>
        <Aviso>
          <p>
            El token viaja <strong>solo</strong> en la cabecera. El antiguo <C>?token=</C> se retiró
            porque dejaba la credencial escrita en los registros del servidor y en el <C>Referer</C>
            .
          </p>
        </Aviso>
      </Ficha>

      <Ficha icono={Lock} titulo="Si algo no funciona">
        <ul className="space-y-2 list-disc pl-4 marker:text-muted-foreground">
          <li>
            <strong>El asistente no ve ninguna herramienta.</strong> El token está mal, caducado o
            desactivado. Compruébalo con el <C>tools/list</C> de curl: el error lo dice.
          </li>
          <li>
            <strong>Ve unas pocas y faltan otras.</strong> Es el filtro de permisos:{' '}
            <C>tools/list</C> solo ofrece lo que el token y tu rol permiten. Revisa los scopes
            marcados.
          </li>
          <li>
            <strong>«No se encuentra el cliente …».</strong> O no existe, o no lo tienes asignado.
            Empieza por <C>list_clients</C>, que devuelve exactamente los que puedes ver.
          </li>
          <li>
            <strong>Pidió una escritura y no pasó nada.</strong> Pasó: quedó como propuesta
            pendiente. Hay que aprobarla desde la aplicación, y no puede hacerlo quien la propuso.
          </li>
          <li>
            <strong>Las cifras parecen viejas.</strong> Pregunta por <C>get_sync_status</C> antes de
            sacar conclusiones de una caída.
          </li>
        </ul>
      </Ficha>

      <Ficha icono={BookOpen} titulo="Más detalle">
        <p className="text-muted-foreground">
          El repositorio documenta el resto en <C>docs/13-mcp-y-tokens-api.md</C>: formato y
          almacenamiento de los tokens, ciclo de vida de <C>/api/tokens</C> y la API REST.
        </p>
      </Ficha>
    </div>
  );
}
