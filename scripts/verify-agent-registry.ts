/**
 * Contrato del registro de herramientas del agente.
 *
 * Las reglas de abajo salen de defectos concretos que la auditoría encontró en
 * el servidor MCP y en el motor BI. Se comprueban aquí, y no en la revisión de
 * código, porque son exactamente el tipo de detalle que se cuela cuando alguien
 * añade la herramienta número quince con prisa.
 *
 * No toca la base de datos: forma parte de `test:puro`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { ALL_TOOLS, getTool, toolsFor } from '../src/lib/agent/registry';
import { nivelEfectivo, nivelAlcanza, TECHO_POR_ROL } from '../src/lib/agent/types';
import type { AgentContext, NivelAgente } from '../src/lib/agent/types';
import { resolverPreset, resolverPeriodo, PRESETS } from '../src/lib/date-presets';
import { ALL_PERMISSIONS } from '../src/lib/api-token-auth';

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

// ── 1. Compatibilidad con el conector que ya está en uso ────────────────────
console.log('\n── Las herramientas existentes siguen ahí ───────────────────');

for (const nombre of ['list_clients', 'get_tabs', 'get_metrics', 'get_summary']) {
  check(`'${nombre}' sigue registrada`, getTool(nombre) !== undefined);
}

check('el registro no está vacío', ALL_TOOLS.length >= 8, String(ALL_TOOLS.length));

const nombres = ALL_TOOLS.map((t) => t.name);
check('no hay nombres duplicados', new Set(nombres).size === nombres.length);

check(
  'el orden es estable (alfabético), para no invalidar la caché de prompt',
  JSON.stringify(nombres) === JSON.stringify([...nombres].sort())
);

// ── 2. Cada herramienta está bien formada ───────────────────────────────────
console.log('\n── Forma de cada herramienta ────────────────────────────────');

for (const t of ALL_TOOLS) {
  check(`[${t.name}] tiene descripción útil`, t.description.length > 40, t.description);
  check(`[${t.name}] declara al menos un scope`, t.scopes.length > 0);
  check(
    `[${t.name}] sus scopes existen`,
    t.scopes.every((s) => (ALL_PERMISSIONS as string[]).includes(s)),
    t.scopes.join(',')
  );

  // El schema tiene que poder convertirse a JSON Schema: es lo que consume MCP.
  let jsonSchema: Record<string, unknown> | null = null;
  try {
    jsonSchema = z.toJSONSchema(t.input) as Record<string, unknown>;
  } catch (e) {
    jsonSchema = null;
    check(`[${t.name}] su schema se convierte a JSON Schema`, false, String(e));
  }
  if (jsonSchema) {
    check(`[${t.name}] su schema se convierte a JSON Schema`, jsonSchema.type === 'object');
  }
}

// ── 3. Regla: `cliente_id` obligatorio en las lecturas de datos ─────────────
console.log('\n── Aislamiento por cliente ──────────────────────────────────');

// Omitirlo agregaba en silencio el gasto y los leads de TODOS los clientes.
// Las excepciones recorren varios clientes a proposito. No se saltan el
// aislamiento: filtran por ctx.allowedClientIds dentro del handler, que es lo
// que se comprueba justo debajo.
const SIN_CLIENTE = new Set(['list_clients', 'resolve_client', 'daily_traffic_report']);

for (const t of ALL_TOOLS) {
  if (SIN_CLIENTE.has(t.name)) continue;
  if (!['metricas', 'analisis', 'campanas', 'clientes'].includes(t.domain)) continue;

  const schema = z.toJSONSchema(t.input) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const tienePropiedad = Boolean(schema.properties?.client_id);
  const esObligatorio = (schema.required ?? []).includes('client_id');

  check(`[${t.name}] exige client_id`, tienePropiedad && esObligatorio);
}

// La excepción tiene que filtrar por allowedClientIds en su propio handler:
// recorrer clientes está bien, recorrerlos TODOS sin mirar el permiso no.
{
  const fuente = readFileSync(
    join(process.cwd(), 'src', 'lib', 'agent', 'tools', 'analisis.ts'),
    'utf8'
  );
  check(
    'daily_traffic_report acota los clientes que recorre a los permitidos',
    fuente.includes("allowedClientIds !== 'all'") &&
      fuente.includes(".in('id', ctx.allowedClientIds)")
  );
}

// Y rechaza de verdad una entrada sin él.
const getSummary = getTool('get_summary');
if (getSummary) {
  check(
    'get_summary rechaza una llamada sin client_id',
    !getSummary.input.safeParse({ preset: 'last_7_days' }).success
  );
  check(
    'get_summary rechaza un client_id que no es UUID',
    !getSummary.input.safeParse({ client_id: 'goodprop' }).success
  );
  check(
    'get_summary acepta una llamada correcta',
    getSummary.input.safeParse({
      client_id: '00000000-0000-4000-8000-000000000000',
      preset: 'last_7_days',
    }).success
  );
}

// ── 4. Reglas verificables sobre el código fuente ───────────────────────────
console.log('\n── Reglas de escritura del código ───────────────────────────');

const DIR_AGENT = join(process.cwd(), 'src', 'lib', 'agent');

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const fuentes = archivosTs(DIR_AGENT);
check('hay archivos del agente que revisar', fuentes.length >= 5, String(fuentes.length));

for (const f of fuentes) {
  const src = readFileSync(f, 'utf8');
  const rel = f.slice(f.indexOf('src'));

  // `config_api` guarda credenciales en claro; un `select('*')` sobre clientes
  // las arrastra hasta la respuesta de la herramienta.
  check(
    `[${rel}] sin select('*') sobre clientes o integraciones`,
    !/from\('(clientes|integrations)'\)[\s\S]{0,80}select\(\s*['"`]\*/.test(src)
  );

  check(
    `[${rel}] usa createAdminClient, no createClient con la service key`,
    !/SUPABASE_SERVICE_ROLE_KEY/.test(src)
  );

  check(`[${rel}] declara 'server-only'`, /^import 'server-only';/m.test(src));

  // El motor BI devolvía `[]` ante un error de base de datos, así que un timeout
  // se leía como "no hubo inversión".
  check(
    `[${rel}] no convierte errores de base de datos en listas vacías`,
    !/if\s*\(\s*error\s*\)\s*return\s*\[\s*\]/.test(src)
  );
}

// ── 5. Niveles de permiso ───────────────────────────────────────────────────
console.log('\n── Niveles: el mínimo de todos los factores ─────────────────');

check(
  'un admin con canal de consulta queda en consulta',
  nivelEfectivo('admin', 'consulta') === 'consulta'
);
check('el rol acota al contacto', nivelEfectivo(TECHO_POR_ROL.viewer, 'admin') === 'consulta');
check(
  'un trafficker nunca pasa de operador',
  nivelEfectivo(TECHO_POR_ROL.trafficker, 'admin') === 'operador'
);
check('sin factores extra manda el rol', nivelEfectivo(TECHO_POR_ROL.admin) === 'admin');
check('los undefined se ignoran', nivelEfectivo('operador', undefined, null) === 'operador');
check(
  'nivelAlcanza compara en el orden correcto',
  nivelAlcanza('admin', 'consulta') && !nivelAlcanza('consulta', 'admin')
);

function ctxFalso(level: NivelAgente, permisos = [...ALL_PERMISSIONS]): AgentContext {
  return {
    userId: 'u',
    role: 'admin',
    level,
    allowedClientIds: 'all',
    permissions: permisos,
    // El catálogo no toca la base: basta un objeto vacío para filtrar.
    db: {} as AgentContext['db'],
    origin: 'web',
    conversationId: null,
    tokenId: null,
  };
}

const catalogoConsulta = toolsFor(ctxFalso('consulta'));
check(
  'un contacto de consulta no ve ninguna herramienta de escritura',
  catalogoConsulta.every((t) => !t.mutation),
  catalogoConsulta
    .filter((t) => t.mutation)
    .map((t) => t.name)
    .join(',')
);

const sinScopes = toolsFor(ctxFalso('admin', []));
check(
  'sin scopes no se ofrece ninguna herramienta',
  sinScopes.length === 0,
  String(sinScopes.length)
);

const soloClientes = toolsFor(ctxFalso('admin', ['read:clients']));
check(
  'con un solo scope se ofrecen solo sus herramientas',
  soloClientes.length > 0 && soloClientes.every((t) => t.scopes.every((s) => s === 'read:clients'))
);

// ── 6. Presets de fecha ─────────────────────────────────────────────────────
console.log('\n── Presets de fecha (zona Colombia) ─────────────────────────');

const HOY = '2026-08-30'; // domingo

check(
  'today',
  JSON.stringify(resolverPreset('today', HOY)) === '{"from":"2026-08-30","to":"2026-08-30"}'
);
check(
  'yesterday',
  JSON.stringify(resolverPreset('yesterday', HOY)) === '{"from":"2026-08-29","to":"2026-08-29"}'
);

// El preset del módulo BI contaba `n` días hacia atrás, así que "7 días" eran 8.
const l7 = resolverPreset('last_7_days', HOY);
check(
  'last_7_days son 7 días contando hoy, no 8',
  l7.from === '2026-08-24' && l7.to === HOY,
  JSON.stringify(l7)
);

const l30 = resolverPreset('last_30_days', HOY);
check('last_30_days son 30 días', l30.from === '2026-08-01' && l30.to === HOY, JSON.stringify(l30));

const semana = resolverPreset('this_week', HOY);
check('this_week empieza en lunes', semana.from === '2026-08-24', JSON.stringify(semana));

const semanaPasada = resolverPreset('last_week', HOY);
check(
  'last_week es lunes a domingo completos',
  semanaPasada.from === '2026-08-17' && semanaPasada.to === '2026-08-23',
  JSON.stringify(semanaPasada)
);

const mes = resolverPreset('this_month', HOY);
check('this_month empieza el día 1', mes.from === '2026-08-01' && mes.to === HOY);

const mesPasado = resolverPreset('last_month', HOY);
check(
  'last_month es el mes natural completo',
  mesPasado.from === '2026-07-01' && mesPasado.to === '2026-07-31',
  JSON.stringify(mesPasado)
);

check(
  'todos los presets resuelven a un rango ordenado',
  PRESETS.every((p) => {
    const r = resolverPreset(p, HOY);
    return r.from <= r.to;
  })
);

check('sin argumentos cae en last_30_days', resolverPeriodo({}, HOY).from === '2026-08-01');
check(
  'from/to explícitos mandan sobre el preset',
  resolverPeriodo({ from: '2026-01-01', to: '2026-01-31' }, HOY).from === '2026-01-01'
);
check(
  'un preset desconocido no revienta',
  resolverPeriodo({ preset: 'inventado' }, HOY).from === '2026-08-01'
);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
process.exit(fail === 0 ? 0 : 1);
