/**
 * Comprobaciones de las reglas de salud de fuentes.
 *
 * Todo PURO. Es justamente el motivo de separar `salud-fuentes.ts` (reglas) de
 * `salud-fuentes-db.ts` (recolección): así se pueden comprobar las siete reglas,
 * incluidas las que hoy no dispara ningún cliente, sin depender de que la
 * producción tenga un caso roto a mano.
 *
 *   npx tsx scripts/verify-salud-fuentes.ts
 */

import {
  evaluarCliente,
  ordenarPorGravedad,
  diasEntre,
  TOLERANCIA_DIAS,
  UMBRAL_CRUCE,
} from '../src/lib/report-utm/salud-fuentes';
import type { SenalesCliente, SenalFuente } from '../src/lib/report-utm/salud-fuentes';

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

const HOY = '2026-08-11';

function fuente(p: Partial<SenalFuente> = {}): SenalFuente {
  return {
    id: 'ads',
    label: 'Anuncios (gasto)',
    ultimaFecha: HOY,
    estado: 'con_datos',
    toleranciaDias: TOLERANCIA_DIAS.ads,
    configurada: true,
    requierePuente: true,
    ...p,
  };
}
function senales(p: Partial<SenalesCliente> = {}): SenalesCliente {
  return {
    clienteId: 'c1',
    nombre: 'Cliente',
    tienePuente: true,
    hoy: HOY,
    fuentes: [],
    integraciones: [],
    pctLeadsCruzados: 90,
    sheetFilasAjenas: null,
    ...p,
  };
}
const titulos = (s: SenalesCliente) =>
  evaluarCliente(s)
    .hallazgos.map((h) => h.titulo)
    .join(' | ');

// ════════════════════════════════════════════════════════════
seccion('Aritmética de fechas');
// ════════════════════════════════════════════════════════════
check('mismo día → 0', diasEntre('2026-08-11', '2026-08-11') === 0);
check('un día', diasEntre('2026-08-10', '2026-08-11') === 1);
check('cruza el cambio de mes', diasEntre('2026-07-31', '2026-08-02') === 2);
// El horario de verano movería el resultado si se calculara en hora local: por
// eso las dos fechas se anclan en UTC.
check('no le afecta el cambio de hora', diasEntre('2026-03-01', '2026-04-01') === 31);
check('una fecha inválida no revienta', diasEntre('vaya', '2026-08-11') === 0);

// ════════════════════════════════════════════════════════════
seccion('El puente ausente se reporta UNA vez');
// ════════════════════════════════════════════════════════════
// Es la causa declarada de los ceros en silencio: sin él, cinco de las siete
// fuentes son invisibles. Repetirlo por cada fuente convertiría un problema en
// cinco y enterraría el que de verdad hay que arreglar.
{
  const r = evaluarCliente(
    senales({
      tienePuente: false,
      fuentes: [
        fuente({ id: 'ads', estado: 'vacia', ultimaFecha: null }),
        fuente({ id: 'sheet', label: 'Sheet', estado: 'vacia', ultimaFecha: null }),
        fuente({ id: 'offline', label: 'Offline', estado: 'vacia', ultimaFecha: null }),
      ],
    })
  );
  check('sin puente → crítico', r.gravedad === 'critico');
  check(
    'un solo hallazgo, no uno por fuente',
    r.hallazgos.length === 1,
    `${r.hallazgos.length} hallazgos`
  );
  check('el hallazgo nombra el enlace', r.hallazgos[0].ambito === 'Enlace de cliente');
}

// ════════════════════════════════════════════════════════════
seccion('Fuentes paradas, vacías y desconocidas');
// ════════════════════════════════════════════════════════════
check(
  'una fuente al día no genera nada',
  evaluarCliente(senales({ fuentes: [fuente()] })).hallazgos.length === 0
);

check(
  'una fuente NO configurada se ignora',
  evaluarCliente(
    senales({
      fuentes: [fuente({ configurada: false, estado: 'vacia', ultimaFecha: null })],
    })
  ).hallazgos.length === 0
);

check(
  'configurada y vacía → crítico',
  titulos(senales({ fuentes: [fuente({ estado: 'vacia', ultimaFecha: null })] })).includes(
    'sin un solo dato'
  )
);

// Retrasada: por encima de la tolerancia avisa; al triple, es crítico. El salto
// distingue «el sync llegó tarde» de «el sync está muerto».
{
  const retrasada = (dias: number) =>
    evaluarCliente(
      senales({
        fuentes: [
          fuente({
            ultimaFecha: new Date(Date.parse(`${HOY}T00:00:00Z`) - dias * 86400_000)
              .toISOString()
              .slice(0, 10),
          }),
        ],
      })
    );
  check('dentro de la tolerancia no avisa', retrasada(TOLERANCIA_DIAS.ads).hallazgos.length === 0);
  check('pasada la tolerancia → aviso', retrasada(TOLERANCIA_DIAS.ads + 1).gravedad === 'aviso');
  check(
    'al triple de la tolerancia → crítico',
    retrasada(TOLERANCIA_DIAS.ads * 3 + 1).gravedad === 'critico'
  );
}

// La regla que costó un bug real: un error de consulta NO es «no hay datos».
// Un cliente con 34.745 leads llegó a aparecer como «sin un solo dato» porque el
// `count` exacto agotaba el tiempo límite y el error se tragaba.
{
  const r = evaluarCliente(
    senales({
      fuentes: [fuente({ estado: 'desconocida', ultimaFecha: null })],
    })
  );
  check(
    'no poder leer NO se reporta como fuente vacía',
    !r.hallazgos.some((h) => h.titulo.includes('sin un solo dato'))
  );
  check('no poder leer se reporta como aviso, no como crítico', r.gravedad === 'aviso');
  check(
    'el texto dice que no se pudo comprobar',
    r.hallazgos[0].titulo.includes('No se pudo comprobar')
  );
}

// ════════════════════════════════════════════════════════════
seccion('Integraciones en error');
// ════════════════════════════════════════════════════════════
{
  const r = evaluarCliente(
    senales({
      integraciones: [
        {
          tipo: 'meta_lead_ads',
          status: 'error',
          ultimoError: 'No se encontraron Páginas accesibles',
          ultimoSync: '2026-06-22T13:35:53Z',
        },
      ],
    })
  );
  check('una integración en error → crítico', r.gravedad === 'critico');
  check(
    'dice cuántos días lleva',
    r.hallazgos[0].titulo.includes('50 día(s)'),
    r.hallazgos[0].titulo
  );
  check(
    'incluye el mensaje de la plataforma',
    r.hallazgos[0].titulo.includes('Páginas accesibles')
  );
}
check(
  'una integración sana no genera nada',
  evaluarCliente(
    senales({
      integraciones: [{ tipo: 's2s', status: 'active', ultimoError: null, ultimoSync: null }],
    })
  ).hallazgos.length === 0
);

// ════════════════════════════════════════════════════════════
seccion('Calidad del cruce UTM ↔ campaña');
// ════════════════════════════════════════════════════════════
// Es la métrica de la que depende todo lo demás y la única que nada más vigila.
check(
  'por encima del umbral no avisa',
  evaluarCliente(senales({ pctLeadsCruzados: UMBRAL_CRUCE + 1 })).hallazgos.length === 0
);
check(
  'por debajo del umbral → aviso',
  evaluarCliente(senales({ pctLeadsCruzados: UMBRAL_CRUCE - 1 })).gravedad === 'aviso'
);
// Sin leads no se puede medir, y decir «0 % cruzado» sería mentir: misma
// doctrina que el resto de la plataforma.
check(
  'sin leads no se inventa un 0 %',
  evaluarCliente(senales({ pctLeadsCruzados: null })).hallazgos.length === 0
);

// ════════════════════════════════════════════════════════════
seccion('Sheet de otro cliente');
// ════════════════════════════════════════════════════════════
// Un Sheet propio cruza casi entero; uno ajeno no cruza nada.
check(
  'ninguna fila cruza → crítico',
  evaluarCliente(senales({ sheetFilasAjenas: { total: 500, sinCruce: 500 } })).gravedad ===
    'critico'
);
check(
  'un Sheet propio no avisa',
  evaluarCliente(senales({ sheetFilasAjenas: { total: 500, sinCruce: 12 } })).hallazgos.length === 0
);
// Con pocas filas la señal no distingue «Sheet ajeno» de «campañas viejas ya
// purgadas»: callar es lo correcto.
check(
  'con muy pocas filas no se pronuncia',
  evaluarCliente(senales({ sheetFilasAjenas: { total: 10, sinCruce: 10 } })).hallazgos.length === 0
);
check(
  'sin datos de Sheet no se pronuncia',
  evaluarCliente(senales({ sheetFilasAjenas: null })).hallazgos.length === 0
);

// ════════════════════════════════════════════════════════════
seccion('Orden de presentación');
// ════════════════════════════════════════════════════════════
// Lo que hay que mirar primero, primero: un panel que hay que leer entero para
// encontrar lo urgente no resuelve el problema que motivó construirlo.
{
  const lista = ordenarPorGravedad([
    { clienteId: 'a', nombre: 'Sano', gravedad: 'ok', hallazgos: [] },
    { clienteId: 'b', nombre: 'Roto', gravedad: 'critico', hallazgos: [] },
    { clienteId: 'c', nombre: 'Regular', gravedad: 'aviso', hallazgos: [] },
  ]);
  check(
    'crítico → aviso → ok',
    lista.map((c) => c.nombre).join(',') === 'Roto,Regular,Sano',
    lista.map((c) => c.nombre).join(',')
  );
}
{
  const r = evaluarCliente(
    senales({
      tienePuente: false,
      pctLeadsCruzados: 10,
    })
  );
  check(
    'dentro de un cliente, lo crítico va antes que el aviso',
    r.hallazgos[0].gravedad === 'critico' &&
      r.hallazgos[r.hallazgos.length - 1].gravedad === 'aviso'
  );
}

// Todo hallazgo tiene que decir qué hacer: un panel que solo señala problemas
// sin salida se deja de mirar a la semana.
{
  const r = evaluarCliente(
    senales({
      tienePuente: false,
      pctLeadsCruzados: 10,
      fuentes: [fuente({ requierePuente: false, estado: 'vacia', ultimaFecha: null })],
      integraciones: [{ tipo: 'x', status: 'error', ultimoError: 'e', ultimoSync: null }],
      sheetFilasAjenas: { total: 500, sinCruce: 500 },
    })
  );
  check(
    `los ${r.hallazgos.length} hallazgos traen una acción`,
    r.hallazgos.every((h) => Boolean(h.accion && h.accion.trim()))
  );
}

console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} comprobación(es) fallida(s)`);
process.exit(fallos === 0 ? 0 : 1);
