/**
 * Zona horaria por cliente (activada el 2026-09-28). Puro: sin base de datos.
 *
 *   npx tsx --conditions=react-server scripts/verify-zona-cliente.ts
 *
 * Fija que:
 *   · fuera de un contexto todo sigue en Colombia (el worker, el navegador);
 *   · dentro de `conZona`, los helpers de `colombia-date.ts` cortan en esa zona,
 *     también con el cambio de horario de Chile;
 *   · la zona del cliente sale de la ficha, luego de su cuenta de Meta, luego de
 *     TikTok, y si no, Colombia;
 *   · `parseDate` de Sheets convierte un instante con desfase al día del cliente.
 */

import {
  colombiaDateOf,
  colombiaDateTimeOf,
  colombiaRangeBounds,
  colombiaToday,
  hoyCliente,
} from '../src/lib/colombia-date';
import { argsZona, conZona } from '../src/lib/zona-activa';
import { zonaHorariaDeCliente, zonasDeCuentas } from '../src/lib/zona-horaria';
import { parseDate } from '../src/lib/integrations/google-sheets-conversiones';
import { ventanaDiaColombia } from '../src/lib/hotmart/cliente';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function main() {
  console.log('\n1. Fuera de contexto: Colombia, como siempre');
  const b = colombiaRangeBounds('2026-09-10', '2026-09-10');
  check(
    'límites con -05:00',
    b.gte === '2026-09-10T00:00:00-05:00' && b.lt === '2026-09-11T00:00:00-05:00',
    JSON.stringify(b)
  );
  check(
    '22:30 de Colombia sigue siendo ese día',
    colombiaDateOf('2026-09-11T03:30:00Z') === '2026-09-10'
  );
  check('argsZona no manda p_zona en Colombia', !('p_zona' in argsZona()));

  console.log('\n2. Dentro de la zona de Chile (UTC-3 desde el 6 de septiembre)');
  await conZona('America/Santiago', async () => {
    const s = colombiaRangeBounds('2026-09-10', '2026-09-10');
    check(
      'el día empieza a las 03:00 UTC',
      s.gte === '2026-09-10T03:00:00.000Z' && s.lt === '2026-09-11T03:00:00.000Z',
      JSON.stringify(s)
    );
    check(
      'las 00:30 de Chile ya son el día siguiente',
      colombiaDateOf('2026-09-11T03:30:00Z') === '2026-09-11'
    );
    check(
      'la hora del CSV sale en hora de Chile',
      colombiaDateTimeOf('2026-09-11T03:30:00Z') === '2026-09-11 00:30'
    );
    check('argsZona manda la zona', argsZona().p_zona === 'America/Santiago');
    check(
      'la ventana de Hotmart es el día de Chile',
      ventanaDiaColombia('2026-09-10').inicio === Date.parse('2026-09-10T03:00:00Z')
    );
    check(
      'Sheets: un created_time con desfase cae en el día de Chile',
      parseDate('2026-09-10T22:30:00-05:00') === '2026-09-11'
    );
    check('Sheets: una fecha sola no se mueve', parseDate('2026-09-10') === '2026-09-10');
    check('hoy es un yyyy-MM-dd', /^\d{4}-\d{2}-\d{2}$/.test(colombiaToday()), colombiaToday());
  });
  await conZona('America/Santiago', async () => {
    const inv = colombiaRangeBounds('2026-07-10', '2026-07-10');
    check(
      'en invierno (UTC-4) el día empieza a las 04:00 UTC',
      inv.gte === '2026-07-10T04:00:00.000Z',
      inv.gte
    );
  });
  check(
    'al salir del contexto vuelve Colombia',
    colombiaRangeBounds('2026-09-10', '2026-09-10').gte === '2026-09-10T00:00:00-05:00'
  );

  console.log('\n3. De dónde sale la zona del cliente');
  check('sin nada, Colombia', zonaHorariaDeCliente({}) === 'America/Bogota');
  const conMeta = {
    meta_estado_cuentas: { '1': { zona: 'America/Santiago' }, '2': { zona: 'America/Santiago' } },
  };
  check('la de su cuenta de Meta', zonaHorariaDeCliente(conMeta) === 'America/Santiago');
  check(
    'la escrita en la ficha manda',
    zonaHorariaDeCliente({ ...conMeta, zona_horaria: 'America/Lima' }) === 'America/Lima'
  );
  check(
    'sin Meta, la de TikTok',
    zonaHorariaDeCliente({ tiktok_cuentas_info: { x: { timezone: 'America/Mexico_City' } } }) ===
      'America/Mexico_City'
  );
  check(
    'una zona inválida se ignora',
    zonaHorariaDeCliente({ meta_estado_cuentas: { '1': { zona: 'Marte/Olympus' } } }) ===
      'America/Bogota'
  );
  check(
    'varias cuentas: la más frecuente primero',
    zonasDeCuentas({
      meta_estado_cuentas: {
        a: { zona: 'America/Bogota' },
        b: { zona: 'America/Santiago' },
        c: { zona: 'America/Santiago' },
      },
    })[0] === 'America/Santiago'
  );
  check(
    'hoyCliente usa la zona de la config',
    hoyCliente(conMeta, new Date('2026-09-11T03:30:00Z')) === '2026-09-11'
  );
  check(
    'y Colombia sin config',
    hoyCliente(undefined, new Date('2026-09-11T03:30:00Z')) === '2026-09-10'
  );

  console.log(
    fallos === 0 ? '\n✅ Zona por cliente: todo OK\n' : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  process.exit(fallos === 0 ? 0 : 1);
}

main();
