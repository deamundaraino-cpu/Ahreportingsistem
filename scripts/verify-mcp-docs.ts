/**
 * Monta el panel de documentación del MCP (`McpDocs`).
 *
 * El resto de comprobaciones del catálogo son de datos: `verify-agent-catalogo`
 * asegura que `catalogoPublico()` produce fichas correctas. Lo que no cubrían es
 * que esas fichas lleguen a la pantalla — que el panel pida el catálogo, lo
 * agrupe, lo filtre y despliegue los parámetros. Eso es justo lo que antes
 * estaba escrito a mano y se quedó desfasado sin que nadie se enterara.
 *
 * Se ejecuta SIN `--conditions=react-server`: con ese flag React no exporta
 * `useState` y el componente no se puede montar. A cambio se neutraliza
 * `server-only`, que el módulo del catálogo importa pero este panel no usa (el
 * tipo `ToolDoc` es `import type` y desaparece al compilar).
 *
 *   npx tsx scripts/verify-mcp-docs.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import Module from 'node:module';

// jsdom no trae tipos (no hay @types/jsdom); basta con lo que usa este script.
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    html: string,
    opts?: { pretendToBeVisual?: boolean; url?: string }
  ) => { window: Window & typeof globalThis };
};

const modAny = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const originalLoad = modAny._load;
modAny._load = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, ...rest);
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  const esEvento = key === 'EventTarget' || key.endsWith('Event');
  if (key in globalThis && !esEvento) continue;
  try {
    g[key] = (dom.window as unknown as Record<string, unknown>)[key];
  } catch {
    /* propiedad de solo lectura */
  }
}
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── Catálogo de mentira, con la forma exacta de `catalogoPublico()` ─────────
//
// Se inventa a propósito en vez de importar el real: así la comprobación es
// sobre el panel, y un cambio en el registro no puede hacerla fallar por
// motivos que no tienen que ver con la pantalla.
const CATALOGO = [
  {
    name: 'list_clients',
    domain: 'clientes',
    description: 'Lista los clientes de publicidad a los que se tiene acceso.',
    scopes: ['read:clients'],
    minLevel: 'consulta',
    riesgo: null,
    parametros: [],
  },
  {
    name: 'get_metrics',
    domain: 'metricas',
    description: 'Métricas diarias de un cliente en un periodo.',
    scopes: ['read:metrics'],
    minLevel: 'consulta',
    riesgo: null,
    parametros: [
      {
        nombre: 'client_id',
        tipo: 'uuid',
        requerido: true,
        descripcion: 'UUID del cliente.',
        valores: null,
      },
      {
        nombre: 'preset',
        tipo: 'opción',
        requerido: false,
        descripcion: 'Periodo con nombre.',
        valores: ['today', 'last_30_days'],
      },
    ],
  },
  {
    name: 'share_report',
    domain: 'informes',
    description: 'Genera un enlace público para un informe.',
    scopes: ['write:reports'],
    minLevel: 'admin',
    riesgo: 'high',
    parametros: [
      {
        nombre: 'report_id',
        tipo: 'uuid',
        requerido: true,
        descripcion: null,
        valores: null,
      },
    ],
  },
];

let pedidas = 0;
g.fetch = (url: string) => {
  if (String(url).includes('/api/agent/tools')) {
    pedidas++;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ tools: CATALOGO }) });
  }
  return Promise.reject(new Error(`fetch inesperado: ${url}`));
};

const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { McpDocs } = require('../src/components/api-tokens/McpDocs') as {
  McpDocs: (props: { appUrl: string; onIrATokens: () => void }) => React.ReactElement;
};

let fallos = 0;
function check(nombre: string, ok: boolean, detalle = '') {
  if (ok) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function main() {
  const APP_URL = 'https://reportes.ejemplo.test';

  let irATokens = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  React.act(() => {
    root.render(
      React.createElement(McpDocs, { appUrl: APP_URL, onIrATokens: () => void irATokens++ })
    );
  });

  // El catálogo llega por fetch: su promesa se resuelve en un microtask posterior
  // al render, así que sin este act asíncrono la pantalla se queda en «Cargando».
  await React.act(async () => {});

  const texto = () => container.textContent ?? '';
  const botones = () => Array.from(container.querySelectorAll('button'));
  const botonQueDice = (t: string) =>
    botones().find((b) => (b.textContent ?? '').trim().toLowerCase().includes(t.toLowerCase()));
  const pulsar = (b: Element | undefined, nombre: string) => {
    if (!b) throw new Error(`No se encontró el botón: ${nombre}`);
    React.act(() => {
      b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  };

  // ── 1. Lo imprescindible para conectarse ────────────────────────────────────
  console.log('\n── El panel se monta y trae lo imprescindible ───────────────');

  check('renderiza algo', container.children.length > 0);
  check('muestra el endpoint MCP completo', texto().includes(`${APP_URL}/api/mcp`));
  check('explica la cabecera de autenticación', texto().includes('Authorization: Bearer'));
  check(
    'ofrece los cuatro clientes de conexión',
    ['Claude Code', 'Claude Desktop', 'Cursor', 'curl'].every((c) => botonQueDice(c) !== undefined)
  );

  // El comando de Claude Code es el que se ve al abrir: es la pestaña por defecto.
  check(
    'el comando de Claude Code lleva el endpoint y el transporte http',
    texto().includes('claude mcp add --transport http') && texto().includes(`${APP_URL}/api/mcp`)
  );

  pulsar(botonQueDice('Claude Desktop'), 'Claude Desktop');
  check(
    'Claude Desktop usa el puente mcp-remote, no un paquete inventado',
    texto().includes('mcp-remote') && !texto().includes('server-fetch')
  );
  check(
    'y pasa el token por env para que no lo parta el espacio',
    texto().includes('ADSHOUSE_TOKEN') && texto().includes('Authorization:${ADSHOUSE_TOKEN}')
  );

  pulsar(botonQueDice('Cursor'), 'Cursor');
  check(
    'Cursor recibe url + cabecera',
    texto().includes('"url"') && texto().includes('Authorization')
  );

  // ── 2. El catálogo llega de la API, no de una lista escrita a mano ──────────
  console.log('\n── El catálogo sale de /api/agent/tools ─────────────────────');

  check('pide el catálogo una sola vez', pedidas === 1, String(pedidas));
  check(
    'muestra el total del catálogo',
    texto().includes('de 3'),
    texto().match(/\d+ de \d+/)?.[0]
  );

  // Los grupos nacen plegados: con 40 herramientas, abrirlo todo es ilegible.
  check('los grupos empiezan plegados', !texto().includes('Lista los clientes de publicidad'));
  check(
    'los dominios se anuncian con su título en castellano',
    texto().includes('Clientes y pestañas') && texto().includes('Métricas y leads')
  );

  pulsar(botonQueDice('Clientes y pestañas'), 'grupo clientes');
  check('al desplegar un grupo aparecen sus herramientas', texto().includes('list_clients'));
  check('con su descripción del registro', texto().includes('Lista los clientes de publicidad'));
  check('y con su scope', texto().includes('read:clients'));

  // ── 3. Los parámetros y el ejemplo ──────────────────────────────────────────
  console.log('\n── Cada herramienta despliega lo que hace falta escribir ────');

  pulsar(botonQueDice('Métricas y leads'), 'grupo metricas');
  pulsar(botonQueDice('get_metrics'), 'get_metrics');

  check(
    'muestra el parámetro y su tipo',
    texto().includes('client_id') && texto().includes('uuid')
  );
  check(
    'distingue obligatorio de opcional',
    texto().includes('obligatorio') && texto().includes('opcional')
  );
  check(
    'vuelca los valores del enum',
    texto().includes('today') && texto().includes('last_30_days')
  );
  check(
    'genera un curl con el argumento obligatorio ya puesto',
    texto().includes('"name":"get_metrics"') && texto().includes('"client_id":'),
    texto().includes('"name":"get_metrics"') ? 'falta client_id' : 'falta el curl'
  );
  check('el curl apunta al endpoint correcto', texto().includes(`curl -X POST ${APP_URL}/api/mcp`));

  // ── 4. Riesgo y permisos se ven antes de llamar ─────────────────────────────
  console.log('\n── Se avisa de lo que escribe ──────────────────────────────');

  pulsar(botonQueDice('Informes BI'), 'grupo informes');
  check(
    'una escritura de riesgo alto se marca como tal',
    texto().includes('escribe · riesgo alto')
  );
  check('y muestra el nivel que exige', texto().includes('nivel admin'));
  check(
    'explica que las escrituras esperan aprobación',
    texto().includes('pendiente_de_aprobacion') && texto().includes('24 horas')
  );

  // ── 5. El buscador ──────────────────────────────────────────────────────────
  console.log('\n── El buscador abre los grupos con resultados ───────────────');

  const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
  if (!input) throw new Error('No se encontró el buscador');

  const buscar = (q: string) => {
    React.act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(input, q);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  buscar('share_report');
  check('filtra por nombre', texto().includes('share_report'));
  check(
    'y esconde los grupos sin coincidencias',
    !texto().includes('Clientes y pestañas') && !texto().includes('Métricas y leads')
  );
  check(
    'el contador refleja el filtro',
    texto().includes('1 de 3'),
    texto().match(/\d+ de \d+/)?.[0]
  );

  buscar('read:metrics');
  check(
    'busca también por scope',
    texto().includes('get_metrics') && !texto().includes('share_report')
  );

  buscar('no-existe-esto');
  check('avisa cuando no hay coincidencias', texto().includes('Ninguna herramienta coincide'));

  buscar('');
  check('al vaciar el buscador vuelve el catálogo entero', texto().includes('de 3'));

  // ── 6. El enlace a la creación del token ────────────────────────────────────
  console.log('\n── El paso 1 lleva a crear el token ────────────────────────');

  pulsar(botonQueDice('Ir a Mis Tokens'), 'Ir a Mis Tokens');
  check('el botón avisa al contenedor', irATokens === 1, String(irATokens));

  React.act(() => root.unmount());

  console.log(`\n${fallos === 0 ? '✅' : '❌'} Panel de documentación MCP: ${fallos} fallidas\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main();
