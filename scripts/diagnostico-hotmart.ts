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
 * Sin flags, esta sonda varía UN eje por intento sobre la línea base que usa el
 * código en producción y reporta status + cuerpo de cada uno. El primer 200
 * identifica al culpable.
 *
 *   npx tsx --conditions=react-server scripts/diagnostico-hotmart.ts
 *   npx tsx --conditions=react-server scripts/diagnostico-hotmart.ts --cliente=<uuid>
 *   npx tsx --conditions=react-server scripts/diagnostico-hotmart.ts --fecha=2026-08-19
 *
 * Con flags, en vez de la matriz corre sondas concretas sobre la ventana
 * 2026-07-12 → 2026-08-31 (hora Colombia, epoch ms como el worker):
 *
 *   --estados   ¿qué estados devuelve `sales/history` sin filtro? ¿funciona
 *               `transaction_status` repetido? ¿y separado por comas?
 *   --claves    censo de rutas de clave de los items (SOLO conteos y tipos,
 *               nunca valores), desfase aprobación−orden, y si `start_date`
 *               filtra por fecha de orden o de aprobación.
 *   --zona      zona horaria y moneda de las cuentas publicitarias de Meta.
 *   --paginas=N tope de páginas por llamada (100 items/página; 10 por defecto).
 *   --desde=YYYY-MM-DD --hasta=YYYY-MM-DD  cambia la ventana de las sondas.
 *
 * SOLO HACE PETICIONES GET DE LECTURA. No escribe en Supabase ni en Hotmart.
 * Nunca imprime la credencial Basic, el access token ni datos del comprador.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import {
  HOTMART_API_BASE,
  accessTokenDe,
  hotmartConectado,
  obtenerToken,
  ventanaDiaColombia,
} from '../src/lib/hotmart/cliente';
import type { ConfigHotmart } from '../src/lib/hotmart/cliente';
import type { PaginaHotmart } from '../src/lib/hotmart/tipos';
import { hotmartFetch } from '../src/lib/rate-limit';
import { addDaysISO, colombiaDateOf, colombiaYesterday } from '../src/lib/colombia-date';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  args.set(k, v ?? 'true');
}

const CLIENTE = args.get('cliente') ?? null;
/** Conviene un día que SÍ tuvo ventas: así un 200 con 0 items no se lee como éxito. */
const FECHA = args.get('fecha') ?? colombiaYesterday();

const SONDA_ESTADOS = args.has('estados');
const SONDA_CLAVES = args.has('claves');
const SONDA_ZONA = args.has('zona');
/** Con cualquiera de las sondas nuevas, la matriz de parámetros no corre. */
const MODO_SONDAS = SONDA_ESTADOS || SONDA_CLAVES || SONDA_ZONA;
const MAX_PAGINAS_SONDA = Math.max(1, Number(args.get('paginas') ?? 10) || 10);

/** Ventana de las sondas nuevas. Días de calendario de Colombia, ambos incluidos. */
const VENTANA_DESDE = args.get('desde') ?? '2026-07-12';
const VENTANA_HASTA = args.get('hasta') ?? '2026-08-31';

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

// ════════════════════════════════════════════════════════════════
// Utilidades de las sondas nuevas
// ════════════════════════════════════════════════════════════════

type Item = Record<string, unknown>;

/** Resultado de una llamada paginada a `sales/history`, con su status HTTP. */
type Llamada = {
  etiqueta: string;
  query: string;
  status: number;
  items: Item[];
  paginas: number;
  /** Quedaron páginas sin leer por el tope `--paginas`. */
  truncado: boolean;
  /** `page_info.total_results` de la primera página, si Hotmart lo manda. */
  total: number | null;
  error?: string;
};

/**
 * Query string a mano, no con `URLSearchParams`: la prueba (d) necesita la coma
 * LITERAL (`APPROVED,REFUNDED`), y `URLSearchParams` la escaparía a `%2C`.
 */
function construirQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`)
    .join('&');
}

const cacheLlamadas = new Map<string, Llamada>();

/**
 * Pagina `sales/history` hasta agotarlo o hasta el tope. Memoriza por query: las
 * sondas `--estados` y `--claves` comparten las mismas llamadas.
 */
async function llamarHistorial(
  token: string,
  etiqueta: string,
  params: Array<[string, string]>,
  maxPaginas = MAX_PAGINAS_SONDA
): Promise<Llamada> {
  const base = construirQuery(params);
  const previa = cacheLlamadas.get(base);
  if (previa) return previa;

  const r: Llamada = {
    etiqueta,
    query: base,
    status: 0,
    items: [],
    paginas: 0,
    truncado: false,
    total: null,
  };
  const vistos = new Set<string>();
  let pageToken = '';

  for (;;) {
    if (r.paginas >= maxPaginas) {
      r.truncado = true;
      break;
    }
    r.paginas++;
    const qs = pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base;
    let res;
    try {
      res = await hotmartFetch(`${HOTMART_API_BASE}${HIST}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e: unknown) {
      r.error = `error de red: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    r.status = res.status;
    const data = res.parsed as PaginaHotmart<Item> | null;
    if (res.status !== 200 || !data || data.error || !Array.isArray(data.items)) {
      // El cuerpo de error de Hotmart es `{error, error_description}`: sin datos
      // de compradores. Se recorta igualmente.
      r.error = (await res.text()).slice(0, 200) || '(cuerpo vacío)';
      break;
    }
    if (r.total === null && typeof data.page_info?.total_results === 'number') {
      r.total = data.page_info.total_results;
    }
    r.items.push(...data.items);

    const siguiente = data.page_info?.next_page_token;
    if (!siguiente) break;
    if (vistos.has(siguiente)) {
      r.error = 'next_page_token repetido';
      break;
    }
    vistos.add(siguiente);
    pageToken = siguiente;
  }

  cacheLlamadas.set(base, r);
  return r;
}

/** Lee una ruta con puntos (`purchase.tracking.source_sck`) sin romper. */
function en(obj: unknown, ruta: string): unknown {
  let cur: unknown = obj;
  for (const p of ruta.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function txDe(item: Item): string {
  const t = en(item, 'purchase.transaction');
  return t == null ? '' : String(t);
}

function estadoDe(item: Item): string {
  const s = en(item, 'purchase.status');
  return s == null || s === '' ? '(sin status)' : String(s);
}

function esVacio(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/**
 * El TIPO de un valor, nunca el valor. Lo que interesa saber de `sck`/`src` es
 * si traen un id de anuncio de Meta (numérico, 15–18 dígitos) o texto libre.
 */
function tipoValor(v: unknown): string {
  if (esVacio(v)) return 'vacío';
  if (typeof v === 'boolean') return 'booleano';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'objeto';
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return 'id numérico ≥10 dígitos';
  if (/^\d+$/.test(s)) return 'número <10 dígitos';
  if (/\d{10,}/.test(s)) return 'texto con id numérico ≥10 dígitos dentro';
  if (/[|]/.test(s)) return 'texto con separador |';
  return 'texto';
}

/**
 * Rasgos estructurales de un texto, sin el texto: ¿es una query string, una URL,
 * un slug, lleva UTMs? Basta para saber qué es sin imprimirlo.
 */
function rasgosTexto(s: string): string[] {
  const r: string[] = [];
  if (/https?:\/\//i.test(s)) r.push('url');
  if (/utm_/i.test(s)) r.push('utm_');
  if (/[=&]/.test(s)) r.push('=&');
  if (/\s/.test(s)) r.push('espacios');
  if (/[{}]/.test(s)) r.push('llaves');
  if (/_/.test(s)) r.push('_');
  if (/-/.test(s)) r.push('-');
  if (/%[0-9a-f]{2}/i.test(s)) r.push('%xx');
  if (/\d/.test(s)) r.push('dígitos');
  return r.length > 0 ? r : ['solo letras'];
}

function contar(h: Map<string, number>, k: string, n = 1) {
  h.set(k, (h.get(k) ?? 0) + n);
}

function histograma(valores: Iterable<string>): Map<string, number> {
  const h = new Map<string, number>();
  for (const v of valores) contar(h, v);
  return h;
}

function formatoHist(h: Map<string, number>): string {
  if (h.size === 0) return '(vacío)';
  return [...h.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
}

/** Epoch ms de un campo de fecha de Hotmart (número, string numérico o ISO). */
function aMs(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim()) {
    if (/^\d+$/.test(v.trim())) n = Number(v.trim());
    else {
      const t = Date.parse(v);
      n = Number.isNaN(t) ? null : t;
    }
  }
  if (n === null) return null;
  // Epoch en segundos: Hotmart manda ms, pero no se asume.
  return n < 1e11 ? n * 1000 : n;
}

function diaColombia(ms: number): string {
  return colombiaDateOf(new Date(ms));
}

function lineaLlamada(l: Llamada): string {
  const marca = l.status === 200 && !l.error ? '✓' : '✗';
  const total = l.total !== null ? ` total_results=${l.total}` : '';
  const trunc = l.truncado ? ' [TRUNCADO por --paginas]' : '';
  const err = l.error ? ` — ${l.error}` : '';
  return `  ${marca} [${l.status}] ${l.etiqueta}: ${l.items.length} item(s) en ${l.paginas} pág.${total}${trunc}${err}`;
}

function conjuntoTx(l: Llamada): Set<string> {
  return new Set(l.items.map(txDe).filter(Boolean));
}

function iguales(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function diferencia(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  return n;
}

// ════════════════════════════════════════════════════════════════
// Sonda --estados
// ════════════════════════════════════════════════════════════════

const ESTADOS_HOTMART = [
  'APPROVED',
  'COMPLETE',
  'REFUNDED',
  'CHARGEBACK',
  'CANCELLED',
  'EXPIRED',
  'WAITING_PAYMENT',
  'PRINTED_BILLET',
  'BILLET_PRINTED',
  'PROTESTED',
  'PARTIALLY_REFUNDED',
  'NO_FUNDS',
  'BLOCKED',
  'OVERDUE',
  'PROCESSING_TRANSACTION',
  'PRE_ORDER',
  'STARTED',
  'UNDER_ANALISYS',
];

const TRIO = ['APPROVED', 'REFUNDED', 'CANCELLED'];

function paramsVentana(): Array<[string, string]> {
  return [
    ['start_date', String(ventanaDiaColombia(VENTANA_DESDE).inicio)],
    ['end_date', String(ventanaDiaColombia(VENTANA_HASTA).fin)],
    ['max_results', '100'],
  ];
}

type Recoleccion = {
  porDefecto: Llamada;
  sueltos: Map<string, Llamada>;
  repetido: Llamada;
  comas: Llamada;
  /**
   * (e) Las mismas dos formas con estados que SÍ tienen items, en los dos
   * órdenes. Con el trío fijo, si solo APPROVED/REFUNDED vienen vacíos, "se usa
   * el último valor" y "se usan todos" dan el mismo resultado: esto los separa.
   */
  discriminantes: { estados: string[]; llamadas: Llamada[] } | null;
};

/** Hace (o recupera de la caché) las llamadas (a)–(d) sobre la ventana. */
async function recolectar(token: string): Promise<Recoleccion> {
  const base = paramsVentana();
  const porDefecto = await llamarHistorial(token, '(a) sin transaction_status', base);
  const sueltos = new Map<string, Llamada>();
  for (const e of ESTADOS_HOTMART) {
    sueltos.set(e, await llamarHistorial(token, `(b) ${e}`, [...base, ['transaction_status', e]]));
  }
  const repetido = await llamarHistorial(token, `(c) repetido ${TRIO.join('&')}`, [
    ...base,
    ...TRIO.map((e): [string, string] => ['transaction_status', e]),
  ]);
  const comas = await llamarHistorial(token, `(d) comas ${TRIO.join(',')}`, [
    ...base,
    ['transaction_status', TRIO.join(',')],
  ]);

  const conItems = [...sueltos]
    .filter(([, l]) => l.status === 200 && !l.error && l.items.length > 0)
    .map(([e]) => e)
    .slice(0, 3);
  let discriminantes: Recoleccion['discriminantes'] = null;
  if (conItems.length >= 2) {
    const llamadas: Llamada[] = [];
    for (const orden of [conItems, [...conItems].reverse()]) {
      llamadas.push(
        await llamarHistorial(token, `(e) repetido ${orden.join('&')}`, [
          ...base,
          ...orden.map((e): [string, string] => ['transaction_status', e]),
        ])
      );
      llamadas.push(
        await llamarHistorial(token, `(e) comas ${orden.join(',')}`, [
          ...base,
          ['transaction_status', orden.join(',')],
        ])
      );
    }
    discriminantes = { estados: conItems, llamadas };
  }
  return { porDefecto, sueltos, repetido, comas, discriminantes };
}

function llamadasDe(r: Recoleccion): Llamada[] {
  return [
    r.porDefecto,
    ...r.sueltos.values(),
    r.repetido,
    r.comas,
    ...(r.discriminantes?.llamadas ?? []),
  ];
}

/** Todos los items vistos en cualquier llamada, sin duplicados por transacción. */
function unionItems(r: Recoleccion): Item[] {
  const porTx = new Map<string, Item>();
  for (const l of llamadasDe(r)) {
    for (const it of l.items) {
      const tx = txDe(it);
      if (tx && !porTx.has(tx)) porTx.set(tx, it);
    }
  }
  return [...porTx.values()];
}

function sondaEstados(r: Recoleccion) {
  console.log(
    `  ── --estados: ${VENTANA_DESDE} → ${VENTANA_HASTA} (hora Colombia) ${'─'.repeat(8)}`
  );
  const todas = llamadasDe(r);
  for (const l of todas) {
    console.log(lineaLlamada(l));
    if (l.items.length > 0) {
      console.log(`      purchase.status → ${formatoHist(histograma(l.items.map(estadoDe)))}`);
    }
  }

  const hayTruncado = todas.some((l) => l.truncado);
  if (hayTruncado) {
    console.log(`\n  ⚠ Alguna llamada quedó truncada: las comparaciones de conjuntos no son`);
    console.log(`    concluyentes. Sube --paginas=N para verlas completas.`);
  }

  // Unión de los sueltos vs las formas combinadas.
  const compararConUnion = (estados: string[], combinadas: Llamada[]) => {
    const union = new Set<string>();
    for (const e of estados) for (const tx of conjuntoTx(r.sueltos.get(e)!)) union.add(tx);
    console.log(`\n  Unión de sueltos ${estados.join('+')}: ${union.size} transacciones`);
    for (const l of combinadas) {
      if (l.status !== 200 || l.error) {
        console.log(`    ${l.etiqueta}: la llamada falló [${l.status}] — no comparable`);
        continue;
      }
      const s = conjuntoTx(l);
      const ok = iguales(union, s);
      console.log(
        `    ${l.etiqueta}: ${s.size} → ${ok ? 'IGUAL a la unión' : 'DISTINTO'}` +
          (ok
            ? ''
            : ` (faltan ${diferencia(union, s)} de la unión; sobran ${diferencia(s, union)})`) +
          ` · estados: ${formatoHist(histograma(l.items.map(estadoDe)))}`
      );
    }
  };
  compararConUnion(TRIO, [r.repetido, r.comas]);
  if (r.discriminantes) {
    compararConUnion(r.discriminantes.estados, r.discriminantes.llamadas);
  } else {
    console.log(`\n  (e) no se pudo: menos de dos estados con items en la ventana.`);
  }

  // Qué devuelve el filtro por defecto.
  const setA = conjuntoTx(r.porDefecto);
  console.log(`\n  Sin transaction_status (a): ${setA.size} transacciones`);
  console.log(
    `    estados que devuelve: ${formatoHist(histograma(r.porDefecto.items.map(estadoDe)))}`
  );
  console.log(`    cobertura de cada estado suelto dentro de (a):`);
  const unionTodos = new Set<string>();
  for (const [e, l] of r.sueltos) {
    const s = conjuntoTx(l);
    for (const tx of s) unionTodos.add(tx);
    if (l.status !== 200 || l.error) {
      console.log(`      ${e.padEnd(24)} [${l.status}] falló`);
      continue;
    }
    if (s.size === 0) continue;
    const dentro = s.size - diferencia(s, setA);
    console.log(`      ${e.padEnd(24)} ${dentro}/${s.size} aparecen en (a)`);
  }
  const vacios = [...r.sueltos]
    .filter(([, l]) => l.status === 200 && !l.error && l.items.length === 0)
    .map(([e]) => e);
  if (vacios.length > 0) console.log(`      (200 con 0 items: ${vacios.join(', ')})`);
  console.log(
    `    unión de TODOS los sueltos: ${unionTodos.size} · en (a) y en ningún suelto: ` +
      `${diferencia(setA, unionTodos)} · en algún suelto y no en (a): ${diferencia(unionTodos, setA)}`
  );
  console.log();
}

// ════════════════════════════════════════════════════════════════
// Sonda --claves
// ════════════════════════════════════════════════════════════════

/** Rutas de clave de un valor, con `[]` para los arrays. Solo nombres de clave. */
function rutasDe(
  v: unknown,
  ruta: string,
  presentes: Set<string>,
  llenas: Set<string>,
  prof = 0
): void {
  if (prof > 6) return;
  if (Array.isArray(v)) {
    const r = `${ruta}[]`;
    for (const e of v) rutasDe(e, r, presentes, llenas, prof + 1);
    return;
  }
  if (v === null || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const r = ruta ? `${ruta}.${k}` : k;
    presentes.add(r);
    if (!esVacio(x)) llenas.add(r);
    rutasDe(x, r, presentes, llenas, prof + 1);
  }
}

/** Censo de una familia de claves (`purchase.tracking.*`) con el TIPO de cada valor. */
function censoFamilia(items: Item[], prefijo: string) {
  const presentes = new Map<string, number>();
  const tipos = new Map<string, Map<string, number>>();
  // Los valores solo se cuentan (distintos, longitud); nunca salen por pantalla.
  const distintos = new Map<string, Set<string>>();
  const longitudes = new Map<string, [number, number]>();
  const rasgos = new Map<string, Map<string, number>>();
  let conObjeto = 0;
  for (const it of items) {
    const obj = en(it, prefijo);
    if (obj === undefined) continue;
    conObjeto++;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      contar(presentes, `(el propio ${prefijo} es ${tipoValor(obj)})`);
      continue;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      contar(presentes, k);
      if (!tipos.has(k)) tipos.set(k, new Map());
      contar(tipos.get(k)!, tipoValor(v));
      if (esVacio(v) || typeof v === 'object') continue;
      const s = String(v);
      if (!distintos.has(k)) distintos.set(k, new Set());
      distintos.get(k)!.add(s);
      const [min, max] = longitudes.get(k) ?? [Infinity, 0];
      longitudes.set(k, [Math.min(min, s.length), Math.max(max, s.length)]);
      if (typeof v === 'string' && !/^\d+$/.test(s)) {
        if (!rasgos.has(k)) rasgos.set(k, new Map());
        for (const x of rasgosTexto(s)) contar(rasgos.get(k)!, x);
      }
    }
  }
  console.log(`    ${prefijo}.*  (objeto presente en ${conObjeto}/${items.length})`);
  if (presentes.size === 0) {
    console.log(`      (sin claves)`);
    return;
  }
  for (const [k, n] of [...presentes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const t = tipos.get(k);
    const d = distintos.get(k);
    const lon = longitudes.get(k);
    const extra = d && lon ? ` · ${d.size} distintos · longitud ${lon[0]}–${lon[1]}` : '';
    console.log(`      ${k.padEnd(28)} presente ${n} · ${t ? formatoHist(t) : ''}${extra}`);
    const ras = rasgos.get(k);
    if (ras) console.log(`      ${''.padEnd(28)} rasgos del texto: ${formatoHist(ras)}`);
  }
}

function forma(v: unknown): string {
  if (v === undefined) return 'ausente';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

type LagItem = { item: Item; orden: number; aprob: number; diaOrden: string; diaAprob: string };

function desfase(items: Item[]): LagItem[] {
  const buckets = new Map<string, number>();
  const pagoConLag = new Map<string, number>();
  const conLag: LagItem[] = [];
  const ORDEN = [
    '0 s (idénticas)',
    '<10 s',
    '10 s – <1 min',
    '1 – <60 min',
    '1 h – <1 día',
    '1 día',
    '2 días',
    '3–7 días',
    '8–14 días',
    '15–30 días',
    '>30 días',
    'negativo',
    'sin approved_date',
    'sin order_date',
  ];
  for (const b of ORDEN) buckets.set(b, 0);

  for (const it of items) {
    const orden = aMs(en(it, 'purchase.order_date'));
    const aprob = aMs(en(it, 'purchase.approved_date'));
    if (orden === null) {
      contar(buckets, 'sin order_date');
      continue;
    }
    if (aprob === null) {
      contar(buckets, 'sin approved_date');
      continue;
    }
    const ms = aprob - orden;
    const dias = ms / 86_400_000;
    let b: string;
    if (ms < 0) b = 'negativo';
    else if (ms === 0) b = '0 s (idénticas)';
    else if (ms < 10_000) b = '<10 s';
    else if (ms < 60_000) b = '10 s – <1 min';
    else if (ms < 3_600_000) b = '1 – <60 min';
    else if (dias < 1) b = '1 h – <1 día';
    else if (dias < 2) b = '1 día';
    else if (dias < 3) b = '2 días';
    else if (dias < 8) b = '3–7 días';
    else if (dias < 15) b = '8–14 días';
    else if (dias <= 30) b = '15–30 días';
    else b = '>30 días';
    contar(buckets, b);
    if (dias >= 1) contar(pagoConLag, String(en(it, 'purchase.payment.type') ?? '(sin tipo)'));

    if (ms > 0) {
      conLag.push({
        item: it,
        orden,
        aprob,
        diaOrden: diaColombia(orden),
        diaAprob: diaColombia(aprob),
      });
    }
  }

  console.log(`\n    Desfase approved_date − order_date (${items.length} items):`);
  for (const b of ORDEN) {
    const n = buckets.get(b) ?? 0;
    if (n > 0) console.log(`      ${b.padEnd(18)} ${n}`);
  }
  const conDiaDistinto = conLag.filter((c) => c.diaOrden !== c.diaAprob).length;
  console.log(`      día de aprobación ≠ día de orden (Colombia): ${conDiaDistinto}`);
  if (pagoConLag.size > 0) {
    console.log(`      payment.type de los que tardan ≥1 día: ${formatoHist(pagoConLag)}`);
  }

  // Meses de order_date (Colombia): dónde cae el volumen de la ventana.
  const meses = new Map<string, number>();
  for (const it of items) {
    const o = aMs(en(it, 'purchase.order_date'));
    if (o !== null) contar(meses, diaColombia(o).slice(0, 7));
  }
  const ordenados = [...meses.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`      order_date por mes: ${ordenados.map(([m, n]) => `${m}=${n}`).join(', ')}`);
  return conLag;
}

/** Margen de las ventanas sub-día: ±2 s alrededor del instante exacto. */
const MARGEN_MS = 2_000;

/**
 * ¿`start_date/end_date` filtran por fecha de orden o de aprobación? Se busca la
 * transacción en una ventana que contiene SOLO su orden y en otra que contiene
 * SOLO su aprobación. Solo se imprimen días, desfases y estado, nunca el id.
 *
 *  A. Ventana de UN día de Colombia, para items aprobados otro día.
 *  B. Si no hay bastantes (pagos con tarjeta: se aprueban al instante), ventana
 *     de ±2 s alrededor de cada instante, para items con desfase ≥10 s. Es la
 *     misma pregunta a escala de segundos: el filtro va en epoch ms.
 */
async function pruebaFiltroFecha(token: string, candidatos: LagItem[]) {
  console.log(`\n    ¿start_date/end_date filtran por orden o por aprobación?`);
  const veredictos = new Map<string, number>();

  const buscar = async (
    tx: string,
    estado: string,
    inicio: number,
    fin: number,
    etiqueta: string,
    conEstado: boolean
  ) => {
    const params: Array<[string, string]> = [
      ['start_date', String(inicio)],
      ['end_date', String(fin)],
      ['max_results', '100'],
    ];
    if (conEstado) params.push(['transaction_status', estado]);
    const l = await llamarHistorial(
      token,
      `${etiqueta}${conEstado ? ` +${estado}` : ''}`,
      params,
      20
    );
    if (l.status !== 200 || l.error) return `error ${l.status}`;
    const esta = l.items.some((it) => txDe(it) === tx);
    return esta ? 'SÍ' : l.truncado ? 'no (truncado)' : 'no';
  };

  const probarPar = async (
    c: LagItem,
    ventanaOrden: [number, number],
    ventanaAprob: [number, number],
    etiqueta: string
  ) => {
    const tx = txDe(c.item);
    const estado = estadoDe(c.item);
    const aSin = await buscar(tx, estado, ...ventanaAprob, `aprob ${etiqueta}`, false);
    const aCon = await buscar(tx, estado, ...ventanaAprob, `aprob ${etiqueta}`, true);
    const oSin = await buscar(tx, estado, ...ventanaOrden, `orden ${etiqueta}`, false);
    const oCon = await buscar(tx, estado, ...ventanaOrden, `orden ${etiqueta}`, true);
    console.log(`         ventana aprobación: sin filtro=${aSin}, con status=${aCon}`);
    console.log(`         ventana orden:      sin filtro=${oSin}, con status=${oCon}`);
    const enAprob = aSin === 'SÍ' || aCon === 'SÍ';
    const enOrden = oSin === 'SÍ' || oCon === 'SÍ';
    contar(
      veredictos,
      enOrden && !enAprob
        ? 'fecha de ORDEN'
        : enAprob && !enOrden
          ? 'fecha de APROBACIÓN'
          : enAprob && enOrden
            ? 'ambas (¿solapan?)'
            : 'ninguna'
    );
  };

  const porLag = [...candidatos].sort((a, b) => b.aprob - b.orden - (a.aprob - a.orden));

  // A. Día de aprobación ≠ día de orden.
  const dias = porLag
    .filter((c) => c.diaOrden !== c.diaAprob)
    .filter((c) => c.diaAprob >= VENTANA_DESDE && c.diaAprob <= VENTANA_HASTA)
    .slice(0, 3);
  if (dias.length === 0) {
    console.log(`      A. Sin items con día de aprobación ≠ día de orden en la ventana.`);
  }
  for (const [i, c] of dias.entries()) {
    const lag = ((c.aprob - c.orden) / 86_400_000).toFixed(1);
    console.log(
      `      A#${i + 1} [${estadoDe(c.item)}] orden ${c.diaOrden} → aprobación ${c.diaAprob} (${lag} d)`
    );
    const o = ventanaDiaColombia(c.diaOrden);
    const a = ventanaDiaColombia(c.diaAprob);
    await probarPar(c, [o.inicio, o.fin], [a.inicio, a.fin], 'día');
  }

  // B. Ventanas de ±2 s, si A no alcanzó para tres pruebas.
  if (dias.length < 3) {
    const segundos = porLag.filter((c) => c.aprob - c.orden >= 10_000).slice(0, 3 - dias.length);
    if (segundos.length === 0) {
      console.log(`      B. Sin items con desfase ≥10 s: no se puede probar a escala de segundos.`);
    }
    for (const [i, c] of segundos.entries()) {
      const lag = Math.round((c.aprob - c.orden) / 1000);
      console.log(
        `      B#${i + 1} [${estadoDe(c.item)}] día ${c.diaOrden}, desfase ${lag} s (ventanas de ±${MARGEN_MS / 1000} s)`
      );
      await probarPar(
        c,
        [c.orden - MARGEN_MS, c.orden + MARGEN_MS],
        [c.aprob - MARGEN_MS, c.aprob + MARGEN_MS],
        '±2 s'
      );
    }
  }

  console.log(
    `      Veredicto: ${veredictos.size ? formatoHist(veredictos) : 'sin pruebas posibles'}`
  );
}

async function sondaClaves(token: string, items: Item[]) {
  console.log(
    `  ── --claves: ${items.length} items únicos (unión de todas las llamadas) ${'─'.repeat(4)}`
  );
  if (items.length === 0) {
    console.log(`    Sin items: nada que censar.\n`);
    return;
  }

  // 1. Censo general de rutas: SOLO nombres y conteos.
  const presentes = new Map<string, number>();
  const llenas = new Map<string, number>();
  for (const it of items) {
    const p = new Set<string>();
    const f = new Set<string>();
    rutasDe(it, '', p, f);
    for (const r of p) contar(presentes, r);
    for (const r of f) contar(llenas, r);
  }
  console.log(`    Censo de rutas (presente / con valor no vacío, de ${items.length}):`);
  for (const r of [...presentes.keys()].sort()) {
    console.log(`      ${r.padEnd(52)} ${presentes.get(r)} / ${llenas.get(r) ?? 0}`);
  }

  // 2. Familias de atribución y de embudo, con el tipo de cada valor.
  console.log();
  for (const fam of [
    'purchase.tracking',
    'purchase.origin',
    'purchase.order_bump',
    'purchase.offer',
  ]) {
    censoFamilia(items, fam);
  }
  const ppt = new Map<string, number>();
  for (const it of items) contar(ppt, tipoValor(en(it, 'purchase.parent_purchase_transaction')));
  console.log(`    purchase.parent_purchase_transaction: ${formatoHist(ppt)}`);

  // 3. Comprador: presencia, nunca valores.
  console.log(`    buyer (presente / con valor):`);
  for (const k of ['email', 'phone', 'checkout_phone']) {
    let p = 0;
    let f = 0;
    for (const it of items) {
      const b = en(it, 'buyer');
      if (b && typeof b === 'object' && k in (b as object)) p++;
      if (!esVacio(en(it, `buyer.${k}`))) f++;
    }
    console.log(`      buyer.${k.padEnd(16)} ${p} / ${f}`);
  }

  // 4. Forma de las comisiones.
  const formaCom = new Map<string, number>();
  const firmas = new Map<string, number>();
  const fuentes = new Map<string, number>();
  for (const it of items) {
    const c = en(it, 'purchase.commissions');
    contar(formaCom, forma(c));
    if (Array.isArray(c)) {
      for (const e of c) {
        if (e && typeof e === 'object') {
          contar(
            firmas,
            `{${Object.keys(e as object)
              .sort()
              .join(',')}}`
          );
          contar(fuentes, String((e as Record<string, unknown>).source ?? '(sin source)'));
        } else contar(firmas, forma(e));
      }
    }
  }
  console.log(`    purchase.commissions: ${formatoHist(formaCom)}`);
  if (firmas.size > 0) console.log(`      claves de cada elemento: ${formatoHist(firmas)}`);
  if (fuentes.size > 0) console.log(`      source: ${formatoHist(fuentes)}`);
  console.log(
    `    item.commissions (raíz): ${formatoHist(histograma(items.map((it) => forma(it.commissions))))}`
  );

  // 5. Estados.
  console.log(`    purchase.status: ${formatoHist(histograma(items.map(estadoDe)))}`);

  // 6. Desfase aprobación − orden, y 7. qué fecha filtra la API.
  const conDiaDistinto = desfase(items);
  await pruebaFiltroFecha(token, conDiaDistinto);
  console.log();
}

// ════════════════════════════════════════════════════════════════
// Sonda --zona
// ════════════════════════════════════════════════════════════════

/**
 * Cuentas de Meta del cliente. Misma lógica que `cuentasMetaDe`
 * (`src/lib/meta/alerta-cuenta.ts`), copiada para no arrastrar sus imports de
 * notificaciones y WhatsApp a una sonda de solo lectura.
 */
function cuentasMeta(
  config: Record<string, unknown>
): Array<{ account_id: string; token: string }> {
  let cuentas: Array<{ account_id: string; token: string }> = [];
  const lista = config.meta_accounts;
  if (Array.isArray(lista) && lista.length > 0) {
    cuentas = lista
      .filter((a) => a && typeof a === 'object' && (a as Record<string, unknown>).account_id)
      .map((a) => {
        const r = a as Record<string, unknown>;
        return {
          account_id: String(r.account_id),
          token: String(r.token || config.meta_token || ''),
        };
      });
  } else if (config.meta_token && config.meta_account_id) {
    cuentas = [{ account_id: String(config.meta_account_id), token: String(config.meta_token) }];
  }
  const vistas = new Set<string>();
  return cuentas.filter((c) => {
    const k = c.account_id.replace(/^act_/, '');
    if (!c.token || vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

async function sondaZona(config: Record<string, unknown>) {
  console.log(`  ── --zona: cuentas publicitarias de Meta ${'─'.repeat(20)}`);
  const cuentas = cuentasMeta(config);
  if (cuentas.length === 0) {
    const claves = Object.keys(config).filter((k) => k.startsWith('meta_'));
    console.log(`    Sin cuentas de Meta con token en config_api.`);
    console.log(
      `    Claves meta_* presentes: ${claves.length ? claves.join(', ') : '(ninguna)'}\n`
    );
    return;
  }
  const version = process.env.META_GRAPH_API_VERSION || 'v19.0';
  for (const c of cuentas) {
    const actId = c.account_id.startsWith('act_') ? c.account_id : `act_${c.account_id}`;
    const u = new URL(`https://graph.facebook.com/${version}/${actId}`);
    u.searchParams.set('fields', 'timezone_name,timezone_offset_hours_utc,currency');
    u.searchParams.set('access_token', c.token);
    try {
      // La URL lleva el token: nunca se imprime.
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const err = j?.error as { message?: string; code?: number } | undefined;
      if (!res.ok || !j || err) {
        console.log(
          `    ${actId} [${res.status}] error: ${err?.message ?? 'respuesta ilegible'}` +
            (err?.code ? ` (code ${err.code})` : '')
        );
        continue;
      }
      console.log(
        `    ${actId} [${res.status}] timezone_name=${j.timezone_name} · ` +
          `offset UTC=${j.timezone_offset_hours_utc} h · currency=${j.currency}`
      );
    } catch (e: unknown) {
      console.log(`    ${actId} error de red: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`    (Graph ${version})\n`);
}

// ════════════════════════════════════════════════════════════════

/**
 * ¿`obtenerToken` tendría que refrescar un token de HotConnect?
 *
 * Hotmart ROTA el refresh token al refrescar: si la sonda lo hiciera sin
 * persistir el parche, la conexión de producción quedaría con un refresh token
 * muerto. La sonda no escribe en la base, así que en ese caso no pide token.
 */
function refrescariaHotconnect(config: ConfigHotmart): boolean {
  if (config.hotmart_auth_mode !== 'hotconnect') return false;
  const access = accessTokenDe(config);
  const expiraMs = config.hotmart_token_expires_at
    ? new Date(config.hotmart_token_expires_at).getTime()
    : 0;
  return !access.valor || !expiraMs || Number.isNaN(expiraMs) || expiraMs - Date.now() < 60_000;
}

async function main() {
  console.log(`\n── SONDA HOTMART (solo lecturas) ${'─'.repeat(30)}`);
  if (MODO_SONDAS) {
    const flags = [SONDA_ESTADOS && 'estados', SONDA_CLAVES && 'claves', SONDA_ZONA && 'zona']
      .filter(Boolean)
      .join(', ');
    console.log(`  Sondas: ${flags} · tope ${MAX_PAGINAS_SONDA} pág./llamada\n`);
  } else {
    console.log(`  Fecha de prueba: ${FECHA}\n`);
  }

  let q = db.from('clientes').select('id, nombre, config_api').order('nombre');
  if (CLIENTE) q = q.eq('id', CLIENTE);
  const { data: clientes, error } = await q;
  if (error) {
    console.error('Error leyendo clientes:', error.message);
    process.exit(1);
  }

  const lista = (clientes ?? []).filter(
    (c) => hotmartConectado(c.config_api) || (SONDA_ZONA && CLIENTE)
  );
  if (lista.length === 0) {
    console.log('  No hay clientes con Hotmart conectado.\n');
    return;
  }

  for (const cliente of lista) {
    const relleno = Math.max(0, 46 - String(cliente.nombre).length);
    console.log(`── ${cliente.nombre} ${'─'.repeat(relleno)}`);
    const config = (cliente.config_api ?? {}) as ConfigHotmart;

    if (SONDA_ZONA) await sondaZona(config);
    if (MODO_SONDAS && !SONDA_ESTADOS && !SONDA_CLAVES) continue;

    if (!hotmartConectado(config)) {
      console.log(`  Sin Hotmart conectado.\n`);
      continue;
    }
    console.log(`  modo: ${config.hotmart_auth_mode ?? 'client_credentials'}`);

    if (refrescariaHotconnect(config)) {
      console.log(`  ✗ El token de HotConnect está vencido: pedir uno nuevo ROTARÍA el refresh`);
      console.log(
        `    token y la sonda no puede persistirlo. Espera a que el worker lo refresque.\n`
      );
      continue;
    }

    // Paso 1 — ¿hay token? Si falla aquí, no es un problema de parámetros.
    const auth = await obtenerToken(config);
    if (!auth.token) {
      console.log(`  ✗ SIN TOKEN: ${auth.motivo ?? 'motivo desconocido'}`);
      console.log(`    → El fallo es de CREDENCIALES, no de parámetros.\n`);
      continue;
    }
    console.log(`  ✓ Token obtenido (${auth.token.length} caracteres)\n`);

    if (MODO_SONDAS) {
      const r = await recolectar(auth.token);
      if (SONDA_ESTADOS) sondaEstados(r);
      if (SONDA_CLAVES) await sondaClaves(auth.token, unionItems(r));
      continue;
    }

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
