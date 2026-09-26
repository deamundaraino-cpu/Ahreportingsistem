/**
 * La guía de informes y las skills generadas no se desincronizan.
 *
 * `src/lib/agent/guias/informes.ts` alimenta cuatro sitios: el prompt del
 * agente, las instrucciones y los prompts del MCP, y dos skills que se generan a
 * disco. Una skill editada a mano, o una guía que nombra una herramienta que ya
 * no existe, enseña al asistente a pedir algo que el servidor rechaza.
 *
 * No toca la base de datos: forma parte de `test:puro`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  DESTINOS_SKILL,
  GUIA_INFORMES_CORTA,
  INSTRUCCIONES_MCP,
  PROMPTS_INFORMES,
  guiaInformesCompleta,
  renderSkill,
} from '../src/lib/agent/guias/informes';
import { ALL_TOOLS, getTool } from '../src/lib/agent/registry';
import { construirSystem } from '../src/lib/agent/runner';
import { ALL_PERMISSIONS } from '../src/lib/api-token-auth';
import type { AgentContext } from '../src/lib/agent/types';

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

// ── 1. Los archivos en disco son los que genera la guía ─────────────────────
console.log('\n── Las skills en disco coinciden con la guía ────────────────');

for (const destino of DESTINOS_SKILL) {
  for (const { ruta, contenido } of renderSkill(destino)) {
    const abs = join(process.cwd(), ruta);
    const existe = existsSync(abs);
    check(`[${ruta}] existe`, existe, 'ejecuta npm run skill:informes');
    if (existe) {
      check(
        `[${ruta}] está al día`,
        lf(readFileSync(abs, 'utf8')) === lf(contenido),
        'regenera con npm run skill:informes (no la edites a mano)'
      );
    }
  }
}

// ── 2. El formato que exigen Claude Code y claude.ai ────────────────────────
console.log('\n── Frontmatter válido ───────────────────────────────────────');

for (const destino of DESTINOS_SKILL) {
  const skill = renderSkill(destino).find((f) => f.ruta.endsWith('/SKILL.md'))!;
  const m = skill.contenido.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  check(`[${destino}] empieza por el frontmatter`, Boolean(m));
  if (!m) continue;
  const [, nombre, descripcion] = m;
  check(`[${destino}] name en kebab-case (≤64)`, /^[a-z0-9-]{1,64}$/.test(nombre), nombre);
  check(
    `[${destino}] la carpeta se llama como la skill`,
    skill.ruta.split('/').slice(-2, -1)[0] === nombre,
    skill.ruta
  );
  check(
    `[${destino}] description entre 40 y 200 caracteres`,
    descripcion.length >= 40 && descripcion.length <= 200,
    String(descripcion.length)
  );
  check(`[${destino}] description sin < ni >`, !/[<>]/.test(descripcion));
  check(
    `[${destino}] SKILL.md por debajo de 500 líneas`,
    skill.contenido.split('\n').length < 500,
    String(skill.contenido.split('\n').length)
  );
}

// ── 3. La guía solo nombra herramientas que existen ─────────────────────────
console.log('\n── La guía nombra herramientas reales ───────────────────────');

const VERBOS =
  /^(list|get|create|update|add|remove|share|unshare|delete|duplicate|save|restore|preview|upsert|set|resolve|analyze)_[a-z_]+$/;
const textoGuia = [GUIA_INFORMES_CORTA, guiaInformesCompleta(), INSTRUCCIONES_MCP].join('\n');
const nombrados = new Set(
  [...textoGuia.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]).filter((n) => VERBOS.test(n))
);
check('la guía nombra herramientas', nombrados.size >= 15, String(nombrados.size));
for (const n of nombrados) {
  check(`\`${n}\` existe en el registro`, getTool(n) !== undefined);
}

const deInformes = ALL_TOOLS.filter((t) => t.domain === 'informes').map((t) => t.name);
for (const n of deInformes) {
  check(`la guía explica \`${n}\``, textoGuia.includes(`\`${n}\``));
}

// ── 4. La guía llega a donde tiene que llegar ───────────────────────────────
console.log('\n── La guía llega al agente y al MCP ─────────────────────────');

const ctxBase = {
  userId: 'u',
  role: 'admin',
  level: 'admin',
  allowedClientIds: 'all',
  permissions: [...ALL_PERMISSIONS],
  db: {} as AgentContext['db'],
  origin: 'web',
  conversationId: null,
  tokenId: null,
} as AgentContext;

check(
  'el prompt del agente lleva la guía si hay herramientas de informes',
  construirSystem(ctxBase).includes(GUIA_INFORMES_CORTA)
);
check(
  'y no la lleva si el contexto no tiene informes',
  !construirSystem({ ...ctxBase, permissions: ['read:clients', 'read:metrics'] }).includes(
    GUIA_INFORMES_CORTA
  )
);
check(
  'ni si la conversación se acota a otros dominios',
  !construirSystem(ctxBase, undefined, ['metricas']).includes(GUIA_INFORMES_CORTA)
);
check('las instrucciones del MCP llevan la guía', INSTRUCCIONES_MCP.includes(GUIA_INFORMES_CORTA));
check(
  'las instrucciones del MCP caben (≤ 4000 caracteres)',
  INSTRUCCIONES_MCP.length <= 4000,
  String(INSTRUCCIONES_MCP.length)
);

const ruta = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'mcp', 'route.ts'), 'utf8');
check('initialize devuelve instructions', /instructions:\s*INSTRUCCIONES_MCP/.test(ruta));
check('el MCP anuncia prompts', ruta.includes('prompts: {}'));
check(
  'el MCP responde prompts/list y prompts/get',
  ruta.includes("'prompts/list'") && ruta.includes("'prompts/get'")
);
check(
  'un fallo de herramienta viaja como isError, no como error JSON-RPC',
  ruta.includes('isError: true')
);

for (const p of PROMPTS_INFORMES) {
  const args = Object.fromEntries(p.arguments.map((a) => [a.name, `valor-${a.name}`]));
  const texto = p.construir(args);
  check(
    `[prompt ${p.name}] usa sus argumentos`,
    p.arguments.every((a) => texto.includes(`valor-${a.name}`))
  );
  check(`[prompt ${p.name}] trae instrucciones útiles`, texto.length > 200);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
process.exit(fail === 0 ? 0 : 1);
