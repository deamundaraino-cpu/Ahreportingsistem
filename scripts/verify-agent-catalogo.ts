/**
 * Contrato del catálogo documentado de herramientas.
 *
 * El panel «Servidor MCP & API» anunciaba cuatro herramientas escritas a mano y
 * una de ellas, `get_campaign_groups`, no existía: quien la pedía recibía un
 * error del servidor. `catalogoPublico()` deriva la lista del registro para que
 * eso no pueda repetirse, y esto comprueba que la derivación sigue siendo útil
 * —no basta con que no reviente: los tipos y los enums tienen que llegar a la
 * pantalla, porque son lo que evita que alguien mande una fecha mal.
 *
 * No toca la base de datos: forma parte de `test:puro`.
 */
import { catalogoPublico } from '../src/lib/agent/catalogo';
import { ALL_TOOLS, getTool } from '../src/lib/agent/registry';
import { nivelAlcanza } from '../src/lib/agent/types';
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

const catalogo = catalogoPublico();

// ── 1. El catálogo es el registro, no una copia ─────────────────────────────
console.log('\n── El catálogo sale del registro ────────────────────────────');

check(
  'documenta exactamente las herramientas registradas',
  catalogo.length === ALL_TOOLS.length,
  `${catalogo.length} documentadas / ${ALL_TOOLS.length} registradas`
);

check(
  'los nombres coinciden uno a uno',
  JSON.stringify(catalogo.map((t) => t.name)) === JSON.stringify(ALL_TOOLS.map((t) => t.name))
);

// La regresión concreta que motivó todo esto.
check(
  '`get_campaign_groups` no se anuncia (nunca existió)',
  getTool('get_campaign_groups') === undefined
);
check(
  'las de campañas son las que de verdad hay',
  catalogo.some((t) => t.name === 'list_campaigns') &&
    catalogo.some((t) => t.name === 'get_campaign_performance')
);

// ── 2. Cada ficha es publicable ─────────────────────────────────────────────
console.log('\n── Cada ficha tiene lo que hace falta mostrar ───────────────');

for (const t of catalogo) {
  check(`[${t.name}] conserva la descripción`, t.description.length > 40);
  check(
    `[${t.name}] sus scopes existen`,
    t.scopes.length > 0 && t.scopes.every((s) => (ALL_PERMISSIONS as string[]).includes(s)),
    t.scopes.join(',')
  );
  check(
    `[${t.name}] los parámetros obligatorios van primero`,
    (() => {
      const opcionalVisto = t.parametros.findIndex((p) => !p.requerido);
      return opcionalVisto === -1 || t.parametros.slice(opcionalVisto).every((p) => !p.requerido);
    })()
  );
  check(
    `[${t.name}] ningún parámetro queda sin tipo legible`,
    t.parametros.every((p) => p.tipo.length > 0 && p.tipo !== 'valor'),
    t.parametros
      .filter((p) => p.tipo === 'valor')
      .map((p) => p.nombre)
      .join(',')
  );
}

// ── 3. Los tipos que más se equivocan se distinguen ─────────────────────────
console.log('\n── Los tipos delicados llegan a la pantalla ─────────────────');

const todosLosParams = catalogo.flatMap((t) => t.parametros.map((p) => ({ tool: t.name, ...p })));

check(
  'todo `client_id` se documenta como uuid',
  todosLosParams.filter((p) => p.nombre === 'client_id').every((p) => p.tipo === 'uuid'),
  todosLosParams
    .filter((p) => p.nombre === 'client_id' && p.tipo !== 'uuid')
    .map((p) => `${p.tool}.${p.tipo}`)
    .join(',')
);

check(
  'las fechas se documentan con su formato, no como texto suelto',
  todosLosParams
    .filter((p) => ['from', 'to', 'fecha', 'desde', 'hasta'].includes(p.nombre))
    .every((p) => p.tipo === 'fecha (YYYY-MM-DD)'),
  todosLosParams
    .filter((p) => ['from', 'to', 'fecha', 'desde', 'hasta'].includes(p.nombre))
    .filter((p) => p.tipo !== 'fecha (YYYY-MM-DD)')
    .map((p) => `${p.tool}.${p.nombre}:${p.tipo}`)
    .join(',')
);

const presets = todosLosParams.filter((p) => p.nombre === 'preset');
check('hay herramientas con periodo por preset', presets.length > 0, String(presets.length));
check(
  'el enum de presets llega con todos sus valores',
  presets.every((p) => (p.valores?.length ?? 0) >= 10),
  presets.map((p) => `${p.tool}:${p.valores?.length ?? 0}`).join(',')
);

const tipoTarea = catalogo
  .find((t) => t.name === 'create_task')
  ?.parametros.find((p) => p.nombre === 'tipo');
check(
  'un enum corto conserva sus opciones (create_task.tipo)',
  JSON.stringify(tipoTarea?.valores) === JSON.stringify(['bug', 'feature', 'mejora', 'tarea']),
  JSON.stringify(tipoTarea?.valores)
);

check(
  'los enums de lista también traen valores (create_alert_rule.channels)',
  (catalogo
    .find((t) => t.name === 'create_alert_rule')
    ?.parametros.find((p) => p.nombre === 'channels')?.valores?.length ?? 0) > 0
);

// ── 4. Lectura y escritura quedan separadas ─────────────────────────────────
console.log('\n── Se distingue lo que escribe de lo que solo mira ──────────');

for (const t of ALL_TOOLS) {
  const doc = catalogo.find((d) => d.name === t.name)!;
  check(
    `[${t.name}] el riesgo coincide con el registro`,
    doc.riesgo === (t.mutation?.risk ?? null),
    `${doc.riesgo} / ${t.mutation?.risk ?? null}`
  );
}

check(
  'ninguna escritura se documenta como accesible en solo consulta',
  catalogo.filter((t) => t.riesgo !== null).every((t) => nivelAlcanza(t.minLevel, 'operador')),
  catalogo
    .filter((t) => t.riesgo !== null && !nivelAlcanza(t.minLevel, 'operador'))
    .map((t) => t.name)
    .join(',')
);

check(
  'hay al menos una escritura de riesgo alto documentada',
  catalogo.some((t) => t.riesgo === 'high')
);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
process.exit(fail === 0 ? 0 : 1);
