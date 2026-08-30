/**
 * Contrato del motor conversacional.
 *
 * No llama a OpenRouter: comprueba la forma de lo que se le enviaría. Lo que se
 * fija aquí son las reglas cuyo incumplimiento produce fallos silenciosos —
 * caros de encontrar precisamente porque nada se rompe de golpe.
 *
 * Sin base de datos: forma parte de `test:puro`.
 */
import { POLITICA_POR_DEFECTO, leerPolitica, llamarLlm } from '../src/lib/agent/llm/client';
import { aFormatoOpenRouter, construirSystem, MAX_ITERACIONES } from '../src/lib/agent/runner';
import { ALL_TOOLS } from '../src/lib/agent/registry';
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

console.log('\n── Tiers ────────────────────────────────────────────────────');

for (const tier of ['nano', 'work', 'power'] as const) {
  const p = POLITICA_POR_DEFECTO[tier];
  check(`[${tier}] tiene modelo primario`, p.primary.length > 0);
  check(`[${tier}] tiene cadena de reserva`, p.fallbacks.length > 0, String(p.fallbacks.length));
  check(`[${tier}] el primario no se repite en la reserva`, !p.fallbacks.includes(p.primary));
  check(`[${tier}] tiene tope de tokens`, p.maxTokens > 0);
}

// La regla que evita el fallo más difícil de diagnosticar.
check('el tier nano NO admite herramientas', POLITICA_POR_DEFECTO.nano.allowTools === false);
check('work sí admite herramientas', POLITICA_POR_DEFECTO.work.allowTools === true);
check('power sí admite herramientas', POLITICA_POR_DEFECTO.power.allowTools === true);

console.log('\n── La configuración no puede saltarse la regla de nano ──────');

const dbFalsa = (valor: unknown) => ({
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: { value: valor } }) }),
    }),
  }),
});

async function main() {
  // Aunque alguien active herramientas para `nano` en la configuración.
  const forzado = await leerPolitica(
    dbFalsa({ primary: 'x/y', fallbacks: ['a/b'], maxTokens: 100, allowTools: true }),
    'nano'
  );
  check('nano ignora allowTools:true venido de la configuración', forzado.allowTools === false);
  check('pero sí acepta el modelo configurado', forzado.primary === 'x/y');

  const work = await leerPolitica(
    dbFalsa({ primary: 'otro/modelo', fallbacks: ['r/1', 'r/2'], maxTokens: 4096 }),
    'work'
  );
  check('work toma el modelo de la configuración', work.primary === 'otro/modelo');
  check('work toma la reserva de la configuración', work.fallbacks.length === 2);

  const sinConfig = await leerPolitica(dbFalsa(null), 'power');
  check(
    'sin configuración se usa el defecto',
    sinConfig.primary === POLITICA_POR_DEFECTO.power.primary
  );

  const rota = await leerPolitica(
    {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              throw new Error('tabla ausente');
            },
          }),
        }),
      }),
    },
    'work'
  );
  check(
    'si la configuración falla, no revienta',
    rota.primary === POLITICA_POR_DEFECTO.work.primary
  );

  console.log('\n── Formato de herramientas para OpenRouter ──────────────────');

  for (const t of ALL_TOOLS) {
    const d = aFormatoOpenRouter(t);
    check(`[${t.name}] type function`, d.type === 'function');
    check(
      `[${t.name}] nombre y descripción`,
      d.function.name === t.name && d.function.description.length > 0
    );
    check(`[${t.name}] parameters sin $schema`, !('$schema' in d.function.parameters));
    check(
      `[${t.name}] parameters es un objeto JSON Schema`,
      d.function.parameters.type === 'object'
    );
  }

  console.log('\n── Prompt del sistema ───────────────────────────────────────');

  const ctx = {
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

  const sys = construirSystem(ctx);
  // Cada una de estas instrucciones corresponde a un fallo concreto observado.
  check('menciona analyze_performance', sys.includes('analyze_performance'));
  check('instruye a respetar no_aplican', sys.includes('no_aplican'));
  check('instruye a no reportar fuentes_ausentes como carencia', sys.includes('fuentes_ausentes'));
  check('instruye a usar tab_id y no el texto del filtro', sys.includes('tab_id'));
  check('advierte de que la escritura requiere aprobación', /aprob/i.test(sys));
  check('deja claro que no puede tocar campañas', /no puedes pausarlas/i.test(sys));
  check('pide no inventar datos ausentes', /no lo estimes/i.test(sys));

  const conContexto = construirSystem(ctx, 'Cliente: Goodprop\nFuentes que NO tiene: ga4');
  check('el contexto extra se añade al prompt', conContexto.includes('Goodprop'));
  check(
    'el contexto extra va DESPUÉS de la parte estable',
    conContexto.indexOf('Goodprop') > conContexto.indexOf('analyze_performance')
  );

  console.log('\n── Guardas del bucle ────────────────────────────────────────');
  check(
    'hay un tope de iteraciones',
    MAX_ITERACIONES > 0 && MAX_ITERACIONES <= 20,
    String(MAX_ITERACIONES)
  );

  console.log('\n── Sin credenciales el error es claro ───────────────────────');
  const previa = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let mensaje = '';
  try {
    await llamarLlm({ tier: 'work', mensajes: [{ role: 'user', content: 'hola' }] });
  } catch (e) {
    mensaje = e instanceof Error ? e.message : '';
  }
  if (previa) process.env.OPENROUTER_API_KEY = previa;
  check(
    'sin OPENROUTER_API_KEY lanza un error que se entiende',
    mensaje.includes('OPENROUTER_API_KEY'),
    mensaje
  );

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
