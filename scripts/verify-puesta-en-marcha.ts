/**
 * Comprobaciones de la «Puesta en marcha» (`src/lib/clientes/puesta-en-marcha.ts`):
 * qué cuenta como hecho, qué es imprescindible y qué se puede marcar «No aplica».
 *
 * Puro: sin base de datos.
 *
 *   npx tsx --conditions=react-server scripts/verify-puesta-en-marcha.ts
 */

import {
  CLAVE_OMITIDOS,
  evaluarPuestaEnMarcha,
  progreso,
  type DatosPuestaEnMarcha,
  type PasoPuestaEnMarcha,
} from '../src/lib/clientes/puesta-en-marcha';
import { CLAVES_POR_PESTANA, CLAVES_SOLO_SERVIDOR } from '../src/lib/clientes/config-pestanas';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const vacio: DatosPuestaEnMarcha = {
  clienteId: 'c-1',
  configApi: {},
  configUtm: {},
  integracionesActivas: [],
  pestanas: 0,
  camposLead: 0,
  camposSheet: 0,
  traffickers: 0,
  rutasWhatsapp: 0,
};
const paso = (pasos: PasoPuestaEnMarcha[], clave: string) => pasos.find((p) => p.clave === clave)!;

console.log('\n1. Cliente recién creado');
{
  const pasos = evaluarPuestaEnMarcha(vacio);
  check(
    'todo pendiente',
    pasos.every((p) => p.estado === 'pendiente')
  );
  check(
    'lo imprescindible es Meta, moneda/zona y una pestaña del dashboard',
    JSON.stringify(pasos.filter((p) => !p.opcional).map((p) => p.clave)) ===
      JSON.stringify(['meta', 'moneda_zona', 'pestanas'])
  );
  check(
    'progreso 0 de N',
    progreso(pasos).resueltos === 0 && progreso(pasos).total === pasos.length
  );
  check(
    'la pestaña del dashboard lleva a su dashboard',
    JSON.stringify(paso(pasos, 'pestanas').destino) === JSON.stringify({ href: '/dashboard/c-1' })
  );
}

console.log('\n2. Meta: token sin cuentas no basta');
{
  const soloToken = evaluarPuestaEnMarcha({ ...vacio, configApi: { meta_token: 't' } });
  check(
    'con token pero sin cuentas sigue pendiente',
    paso(soloToken, 'meta').estado === 'pendiente'
  );
  const conCuentas = evaluarPuestaEnMarcha({
    ...vacio,
    configApi: { meta_token: 't', meta_accounts: [{ account_id: 'act_1' }] },
  });
  check('con cuentas, hecho', paso(conCuentas, 'meta').estado === 'hecho');
  check(
    'con cuentas de Meta, moneda y zona salen solas',
    paso(conCuentas, 'moneda_zona').estado === 'hecho'
  );
}

console.log('\n3. Moneda y zona escritas a mano');
{
  const soloMoneda = evaluarPuestaEnMarcha({ ...vacio, configUtm: { moneda_reporte: 'CLP' } });
  check('solo moneda: pendiente', paso(soloMoneda, 'moneda_zona').estado === 'pendiente');
  const ambas = evaluarPuestaEnMarcha({
    ...vacio,
    configUtm: { moneda_reporte: 'CLP' },
    configApi: { zona_horaria: 'America/Santiago' },
  });
  check('moneda y zona: hecho', paso(ambas, 'moneda_zona').estado === 'hecho');
  const zonaMala = evaluarPuestaEnMarcha({
    ...vacio,
    configUtm: { moneda_reporte: 'CLP' },
    configApi: { zona_horaria: 'Marte/Olympus' },
  });
  check('una zona inválida no cuenta', paso(zonaMala, 'moneda_zona').estado === 'pendiente');
}

console.log('\n4. Integraciones y conteos');
{
  const pasos = evaluarPuestaEnMarcha({
    ...vacio,
    configApi: {
      google_sheets_conversiones: [{ sheet_id: 's' }],
      ga_property_id: '123',
      tiktok_access_token: 't',
      tiktok_accounts: [{ advertiser_id: 'a' }],
    },
    integracionesActivas: ['meta_lead_ads', 'gohighlevel', 's2s', 'hotmart'],
    pestanas: 1,
    camposSheet: 2,
    traffickers: 1,
    rutasWhatsapp: 1,
  });
  const hechos = [
    'sheets',
    'ga4',
    'tiktok',
    'lead_ads',
    'ghl',
    'pixel',
    'hotmart',
    'pestanas',
    'leads',
    'traffickers',
    'whatsapp',
  ];
  check(
    'cada canal conectado cuenta como hecho',
    hechos.every((c) => paso(pasos, c).estado === 'hecho'),
    pasos
      .filter((p) => p.estado !== 'hecho')
      .map((p) => p.clave)
      .join(', ')
  );
}

console.log('\n5. «No aplica»');
{
  const pasos = evaluarPuestaEnMarcha({
    ...vacio,
    configApi: { [CLAVE_OMITIDOS]: ['tiktok', 'hotmart', 'meta'] },
  });
  check(
    'lo opcional marcado queda omitido',
    paso(pasos, 'tiktok').estado === 'omitido' && paso(pasos, 'hotmart').estado === 'omitido'
  );
  check('lo imprescindible no se puede omitir', paso(pasos, 'meta').estado === 'pendiente');
  check('omitidos cuentan como resueltos', progreso(pasos).resueltos === 2);
  const hechoYOmitido = evaluarPuestaEnMarcha({
    ...vacio,
    configApi: { [CLAVE_OMITIDOS]: ['ga4'], ga_property_id: '1' },
  });
  check('si se conecta después, manda «hecho»', paso(hechoYOmitido, 'ga4').estado === 'hecho');
}

console.log('\n6. La lista de omitidos no la pisa ninguna pestaña');
{
  const deAlgunaPestana = Object.values(CLAVES_POR_PESTANA).flat().includes(CLAVE_OMITIDOS);
  check(
    'es clave solo de servidor y de ninguna pestaña',
    !deAlgunaPestana && CLAVES_SOLO_SERVIDOR.includes(CLAVE_OMITIDOS)
  );
}

console.log(fallos === 0 ? '\n✓ TODO OK\n' : `\n✗ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
