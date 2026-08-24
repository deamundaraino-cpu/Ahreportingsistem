/**
 * Sonda de diagnóstico de la API de Hotmart.
 *
 * Existe porque el 2026-08-18 Hotmart empezó a responder `invalid_parameter`
 * ("The request was unacceptable, often due to a misconfigured parameter") a
 * TODAS las peticiones de `/sales/history` y `/sales/commissions`, sin que
 * hubiera un despliegue de por medio. El worker registra el cuerpo del error
 * pero no el status HTTP, así que desde los logs no se puede distinguir un 400
 * (parámetro malo) de un 401/403 (credencial revocada).
 *
 * Esta sonda varía UN eje por intento sobre la línea base que usa el código en
 * producción y reporta status + cuerpo de cada uno. El primer 200 identifica al
 * culpable.
 *
 *   npx tsx scripts/diagnostico-hotmart.ts
 *   npx tsx scripts/diagnostico-hotmart.ts --cliente=<uuid>
 *   npx tsx scripts/diagnostico-hotmart.ts --fecha=2026-08-19
 *
 * SOLO HACE PETICIONES GET DE LECTURA. No escribe en Supabase ni en Hotmart.
 * Nunca imprime la credencial Basic ni el access token.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import {
  HOTMART_API_BASE,
  hotmartConectado,
  obtenerToken,
  ventanaDiaColombia,
} from '../src/lib/hotmart/cliente';
import { addDaysISO, colombiaYesterday } from '../src/lib/colombia-date';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}

const CLIENTE = args.get('cliente') ?? null;
/** Conviene un día que SÍ tuvo ventas: así un 200 con 0 items no se lee como éxito. */
const FECHA = args.get('fecha') ?? colombiaYesterday();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}
const db = createClient(url, key);

type Intento = {
  nombre: string;
  ruta: string;
  params: Array<[string, string]>;
};

const HIST = '/payments/api/v1/sales/history';
const COMM = '/payments/api/v1/sales/commissions';
const SUBS = '/payments/api/v1/subscriptions';

/** Matriz de intentos: un solo eje cambia respecto a la línea base en cada uno. */
function intentos(fecha: string): Intento[] {
  const { inicio, fin } = ventanaDiaColombia(fecha);
  const semanaAtras = ventanaDiaColombia(addDaysISO(fecha, -7)).inicio;

  const desde: [string, string] = ['start_date', String(inicio)];
  const hasta: [string, string] = ['end_date', String(fin)];
  const base: Array<[string, string]> = [desde, hasta, ['max_results', '100']];

  return [
    // Eje 0 — la línea base exacta que usa el worker hoy.
    { nombre: 'LÍNEA BASE (lo que hace el worker hoy)', ruta: HIST, params: base },

    // Eje 1 — max_results.
    { nombre: 'max_results=50', ruta: HIST, params: [desde, hasta, ['max_results', '50']] },
    { nombre: 'max_results=10', ruta: HIST, params: [desde, hasta, ['max_results', '10']] },
    { nombre: 'max_results=500', ruta: HIST, params: [desde, hasta, ['max_results', '500']] },
    { nombre: 'max_results OMITIDO', ruta: HIST, params: [desde, hasta] },

    // Eje 2 — formato de fecha.
    {
      nombre: 'fechas en epoch SEGUNDOS',
      ruta: HIST,
      params: [
        ['start_date', String(Math.floor(inicio / 1000))],
        ['end_date', String(Math.floor(fin / 1000))],
        ['max_results', '100'],
      ],
    },
    {
      nombre: 'fechas en YYYY-MM-DD',
      ruta: HIST,
      params: [
        ['start_date', fecha],
        ['end_date', fecha],
        ['max_results', '100'],
      ],
    },

    // Eje 3 — ventana.
    {
      nombre: 'ventana de 7 días',
      ruta: HIST,
      params: [['start_date', String(semanaAtras)], hasta, ['max_results', '100']],
    },
    { nombre: 'SIN fechas, solo max_results=100', ruta: HIST, params: [['max_results', '100']] },
    {
      nombre: 'SIN fechas, max_results=1 (forma de testHotmartConnection)',
      ruta: HIST,
      params: [['max_results', '1']],
    },
    { nombre: 'SIN ningún parámetro', ruta: HIST, params: [] },

    // Eje 4 — otros endpoints.
    { nombre: 'commissions, línea base', ruta: COMM, params: base },
    // `subscriptions` no lleva fechas: si TAMBIÉN falla, el problema es de
    // credencial/scope y no del formato de las fechas.
    { nombre: 'subscriptions, solo max_results=100', ruta: SUBS, params: [['max_results', '100']] },
  ];
}

function resumirCuerpo(raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (j?.error || j?.message) return JSON.stringify(j);
    const n = Array.isArray(j?.items) ? j.items.length : null;
    const next = j?.page_info?.next_page_token ? ' (hay más páginas)' : '';
    return n === null ? JSON.stringify(j).slice(0, 200) : `${n} item(s)${next}`;
  } catch {
    return raw.slice(0, 200);
  }
}

async function probar(intento: Intento, token: string): Promise<boolean> {
  const u = new URL(`${HOTMART_API_BASE}${intento.ruta}`);
  for (const [k, v] of intento.params) u.searchParams.append(k, v);

  let status = 0;
  let cuerpo = '';
  try {
    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
    status = res.status;
    cuerpo = await res.text();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${intento.nombre}`);
    console.log(`      ${intento.ruta}${u.search}`);
    console.log(`      ERROR DE RED: ${msg}\n`);
    return false;
  }

  const ok = status === 200;
  console.log(`  ${ok ? '✓' : '✗'} [${status}] ${intento.nombre}`);
  console.log(`      ${intento.ruta}${u.search}`);
  console.log(`      ${resumirCuerpo(cuerpo)}\n`);
  return ok;
}

async function main() {
  console.log(`\n── SONDA HOTMART (solo lecturas) ${'─'.repeat(30)}`);
  console.log(`  Fecha de prueba: ${FECHA}\n`);

  let q = db.from('clientes').select('id, nombre, config_api').order('nombre');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) {
    console.error('Error leyendo clientes:', error.message);
    process.exit(1);
  }

  const conHotmart = (clientes ?? []).filter((c) => hotmartConectado(c.config_api));
  if (conHotmart.length === 0) {
    console.log('  No hay clientes con Hotmart conectado.\n');
    return;
  }

  for (const cliente of conHotmart) {
    const relleno = Math.max(0, 46 - String(cliente.nombre).length);
    console.log(`── ${cliente.nombre} ${'─'.repeat(relleno)}`);
    console.log(`  modo: ${cliente.config_api?.hotmart_auth_mode ?? 'client_credentials'}`);

    // Paso 1 — ¿hay token? Si falla aquí, no es un problema de parámetros.
    const auth = await obtenerToken(cliente.config_api);
    if (!auth.token) {
      console.log(`  ✗ SIN TOKEN: ${auth.motivo ?? 'motivo desconocido'}`);
      console.log(`    → El fallo es de CREDENCIALES, no de parámetros.\n`);
      continue;
    }
    console.log(`  ✓ Token obtenido (${auth.token.length} caracteres)\n`);

    // Paso 2 — matriz de parámetros.
    const exitosos: string[] = [];
    for (const intento of intentos(FECHA)) {
      if (await probar(intento, auth.token)) exitosos.push(intento.nombre);
    }

    console.log(`  ── Veredicto ${'─'.repeat(38)}`);
    if (exitosos.length === 0) {
      console.log(`  Ningún intento devolvió 200 con un token válido.`);
      console.log(`  → Credencial activa pero sin permiso sobre estos endpoints,`);
      console.log(`    o la app de Hotmart perdió el scope de ventas.`);
    } else {
      console.log(`  ${exitosos.length} intento(s) con 200:`);
      for (const e of exitosos) console.log(`    • ${e}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
