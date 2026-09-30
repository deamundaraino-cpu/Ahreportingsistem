/**
 * Comprobaciones de las reglas de salud de la base.
 *
 * Todo PURO: `evaluarSaludBase` no toca la base, así que se pueden comprobar
 * las cuatro alertas sin esperar a que producción se sature.
 *
 *   npx tsx scripts/verify-salud-base.ts
 */

import { evaluarSaludBase, umbralesDesdeEnv, UMBRALES_BASE } from '../src/lib/salud/base';
import type { MuestraBase } from '../src/lib/salud/base';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

const MB = 1024 * 1024;
const AHORA = new Date('2026-09-30T12:00:00Z').getTime();
const haceHoras = (h: number) => new Date(AHORA - h * 3_600_000).toISOString();

// La base de producción del 2026-09-30: 580 MB, 7 de 60 conexiones.
function muestra(p: Partial<MuestraBase> = {}): MuestraBase {
  return {
    dbBytes: 580 * MB,
    conexiones: 7,
    maxConexiones: 60,
    ultimaPurgaAt: haceHoras(7),
    midiendoDesde: haceHoras(24 * 30),
    tamanoAnterior: { bytes: 575 * MB, at: haceHoras(24 * 7) },
    ...p,
  };
}
const claves = (m: MuestraBase) =>
  evaluarSaludBase(m, UMBRALES_BASE, AHORA).map((a) => `${a.clave}:${a.gravedad}`);

seccion('Base sana');
check(
  'producción de hoy no dispara nada',
  claves(muestra()).length === 0,
  claves(muestra()).join()
);

seccion('Tamaño');
check(
  '1.100 MB → aviso',
  claves(muestra({ dbBytes: 1100 * MB, tamanoAnterior: null })).join() === 'tamano:aviso'
);
check(
  '2.100 MB → crítico',
  claves(muestra({ dbBytes: 2100 * MB, tamanoAnterior: null })).join() === 'tamano:critico'
);

seccion('Crecimiento');
check(
  '+12 % en 7 días → aviso',
  claves(muestra({ dbBytes: 644 * MB })).join() === 'crecimiento:aviso',
  claves(muestra({ dbBytes: 644 * MB })).join()
);
check(
  '+30 % en 7 días → crítico',
  claves(muestra({ dbBytes: 750 * MB })).join() === 'crecimiento:critico'
);
check('+3 % no alerta', claves(muestra({ dbBytes: 592 * MB })).length === 0);
check('encoger no alerta', claves(muestra({ dbBytes: 400 * MB })).length === 0);
check('sin muestra anterior no se evalúa', claves(muestra({ tamanoAnterior: null })).length === 0);
check(
  'muestra anterior a 0 bytes no divide por cero',
  claves(muestra({ tamanoAnterior: { bytes: 0, at: haceHoras(200) } })).length === 0
);

seccion('Conexiones');
check('50 de 60 (83 %) → aviso', claves(muestra({ conexiones: 50 })).join() === 'conexiones:aviso');
check(
  '58 de 60 (97 %) → crítico',
  claves(muestra({ conexiones: 58 })).join() === 'conexiones:critico'
);
check(
  'max_conexiones a 0 no alerta',
  claves(muestra({ conexiones: 5, maxConexiones: 0 })).length === 0
);

seccion('Purgas');
check('última hace 30 h no alerta', claves(muestra({ ultimaPurgaAt: haceHoras(30) })).length === 0);
check(
  'última hace 40 h → crítico',
  claves(muestra({ ultimaPurgaAt: haceHoras(40) })).join() === 'purga:critico'
);
check(
  'nunca, y midiendo desde hace 2 h → no alerta (migración recién aplicada)',
  claves(muestra({ ultimaPurgaAt: null, midiendoDesde: haceHoras(2), tamanoAnterior: null }))
    .length === 0
);
check(
  'nunca, y midiendo desde hace 3 días → crítico',
  claves(
    muestra({ ultimaPurgaAt: null, midiendoDesde: haceHoras(72), tamanoAnterior: null })
  ).join() === 'purga:critico'
);
check(
  'bitácora vacía no alerta',
  claves(muestra({ ultimaPurgaAt: null, midiendoDesde: null, tamanoAnterior: null })).length === 0
);

seccion('Umbrales del entorno');
const u = umbralesDesdeEnv({ SALUD_DB_AVISO_MB: '700', SALUD_DB_CRITICO_MB: 'abc' });
check('SALUD_DB_AVISO_MB se respeta', u.tamanoAvisoMb === 700);
check('un valor no numérico cae al defecto', u.tamanoCriticoMb === UMBRALES_BASE.tamanoCriticoMb);
check(
  'sin variables, los defectos',
  umbralesDesdeEnv({}).purgaMaxHoras === UMBRALES_BASE.purgaMaxHoras
);

console.log(fallos === 0 ? '\n✅ Todo en orden' : `\n❌ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
