/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Comprobaciones puras de dos piezas que deciden qué ve el usuario cuando algo
 * falla por debajo:
 *
 *   • `describirErrorDeRed` — traduce el `TypeError: fetch failed` de undici a un
 *     mensaje con el motivo real. «Detectar pestañas» enseñaba `fetch failed`
 *     cuando lo que pasaba era que NEXT_PUBLIC_APP_URL apuntaba a un puerto vacío.
 *   • `fetchAllRows` en modo estricto — el recálculo de los agregados diarios de
 *     un Sheet no puede trabajar con un recuento parcial, porque después borra el
 *     lote anterior.
 *
 *   npx tsx --conditions=react-server scripts/verify-fetch-errores.ts
 */

import { codigoErrorDeRed, describirErrorDeRed, esTimeoutDeFetch } from '../src/lib/fetch-json';
import { fetchAllRows } from '../src/lib/supabase-paginate';

let pasadas = 0;
let fallidas = 0;

function check(nombre: string, condicion: boolean, detalle?: string) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallidas++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function sec(titulo: string) {
  console.log(`\n${titulo}`);
}

/** Un `fetch failed` como el de undici, con el código de sistema en la causa. */
function fetchFailed(causa: unknown): TypeError {
  return new TypeError('fetch failed', { cause: causa });
}

function conCodigo(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

const ORIGEN = 'http://localhost:3001';

// ─── describirErrorDeRed ────────────────────────────────────────────────────

sec('describirErrorDeRed — el motivo real en vez de «fetch failed»');

{
  const msg = describirErrorDeRed(fetchFailed(conCodigo('ECONNREFUSED')), ORIGEN);
  check(
    'ECONNREFUSED nombra el destino y el código',
    !!msg && msg.includes(ORIGEN) && msg.includes('ECONNREFUSED'),
    String(msg)
  );
  check('y apunta a NEXT_PUBLIC_APP_URL', !!msg?.includes('NEXT_PUBLIC_APP_URL'), String(msg));

  // `localhost` prueba ::1 y 127.0.0.1: si los dos rechazan, la causa es un
  // AggregateError sin `code` propio.
  const agregado = fetchFailed(
    Object.assign(new AggregateError([conCodigo('ECONNREFUSED'), conCodigo('ECONNREFUSED')]), {})
  );
  check(
    'lee el código dentro de un AggregateError',
    codigoErrorDeRed(agregado) === 'ECONNREFUSED',
    String(codigoErrorDeRed(agregado))
  );
  check(
    'y describe el AggregateError igual',
    !!describirErrorDeRed(agregado, ORIGEN)?.includes('ECONNREFUSED')
  );

  const casos: [string, string][] = [
    ['ENOTFOUND', 'dominio'],
    ['UND_ERR_CONNECT_TIMEOUT', 'a tiempo'],
    ['ECONNRESET', 'se cortó'],
    ['CERT_HAS_EXPIRED', 'certificado'],
    ['ERR_INVALID_URL', 'URL válida'],
  ];
  for (const [code, texto] of casos) {
    const m = describirErrorDeRed(fetchFailed(conCodigo(code)), ORIGEN);
    check(`${code} → mensaje propio`, !!m && m.includes(code) && m.includes(texto), String(m));
  }

  // Causa anidada: undici a veces envuelve el error de socket otra vez.
  const anidado = fetchFailed(new Error('envoltorio', { cause: conCodigo('ENOTFOUND') }));
  check('baja por causas anidadas', codigoErrorDeRed(anidado) === 'ENOTFOUND');

  check(
    '«fetch failed» sin código sigue siendo un fallo de red',
    !!describirErrorDeRed(new TypeError('fetch failed'), ORIGEN)?.includes(ORIGEN)
  );
}

{
  // Los timeouts tienen su propio mensaje en cada llamador: no se tocan.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const abort = new DOMException('This operation was aborted', 'AbortError');
  check('TimeoutError → null', describirErrorDeRed(timeout, ORIGEN) === null);
  check('AbortError → null', describirErrorDeRed(abort, ORIGEN) === null);
  check(
    'y esTimeoutDeFetch los sigue reconociendo',
    esTimeoutDeFetch(timeout) && esTimeoutDeFetch(abort)
  );

  check('un Error cualquiera → null', describirErrorDeRed(new Error('boom'), ORIGEN) === null);
  check(
    'otro TypeError sin causa → null (no se reetiqueta)',
    describirErrorDeRed(new TypeError('Headers.set: invalid header'), ORIGEN) === null
  );
  check('null/undefined → null', describirErrorDeRed(undefined, ORIGEN) === null);
}

// ─── fetchAllRows estricto ──────────────────────────────────────────────────

/**
 * Builder de query falso al estilo PostgREST: `order/limit/gt` devuelven el
 * builder y `await` resuelve `{ data, error }`. `falla(pagina)` decide qué
 * páginas devuelven error (todas sus llamadas, para agotar los reintentos).
 */
function builderFalso(
  total: number,
  opts: { falla?: (pagina: number) => boolean; sinId?: boolean } = {}
) {
  const filas = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1).padStart(8, '0'),
    n: i,
  }));
  return () => {
    let limite = 1000;
    let desde: string | null = null;
    const q: any = {
      order: () => q,
      limit: (n: number) => ((limite = n), q),
      gt: (_col: string, v: string) => ((desde = v), q),
      then: (resolve: (r: any) => void) => {
        const resto = desde === null ? filas : filas.filter((f) => f.id > desde!);
        const pagina = Math.floor((total - resto.length) / limite) + 1;
        if (opts.falla?.(pagina)) {
          resolve({ data: null, error: { message: `página ${pagina} caída` } });
          return;
        }
        const data = resto.slice(0, limite).map((f) => (opts.sinId ? { n: f.n } : f));
        resolve({ data, error: null });
      },
    };
    return q;
  };
}

async function lanza(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function comprobarPaginacion() {
  sec('fetchAllRows — modo estricto');

  const completo = await fetchAllRows(builderFalso(2500));
  const completoEstricto = await fetchAllRows(builderFalso(2500), 1000, 200_000, {
    estricto: true,
  });
  check('2.500 filas completas (normal)', completo.length === 2500, String(completo.length));
  check('2.500 filas completas (estricto)', completoEstricto.length === 2500);

  const exacto = await fetchAllRows(builderFalso(2000), 1000, 200_000, { estricto: true });
  check(
    'un múltiplo exacto de la página termina bien',
    exacto.length === 2000,
    String(exacto.length)
  );

  const vacio = await fetchAllRows(builderFalso(0), 1000, 200_000, { estricto: true });
  check('una tabla vacía no es un error', vacio.length === 0);

  const falla2 = { falla: (p: number) => p === 2 };
  const parcial = await fetchAllRows(builderFalso(2500, falla2));
  check(
    'normal: con la página 2 caída devuelve lo ya traído',
    parcial.length === 1000,
    String(parcial.length)
  );
  const errPagina = await lanza(() =>
    fetchAllRows(builderFalso(2500, falla2), 1000, 200_000, { estricto: true })
  );
  check(
    'estricto: con la página 2 caída lanza',
    !!errPagina?.includes('página fallida'),
    String(errPagina)
  );

  const tope = await fetchAllRows(builderFalso(2500), 1000, 1000);
  check('normal: el tope corta en silencio', tope.length === 1000, String(tope.length));
  const errTope = await lanza(() =>
    fetchAllRows(builderFalso(2500), 1000, 1000, { estricto: true })
  );
  check(
    'estricto: llegar al tope sin terminar lanza',
    !!errTope?.includes('tope'),
    String(errTope)
  );

  const errSinId = await lanza(() =>
    fetchAllRows(builderFalso(2500, { sinId: true }), 1000, 200_000, { estricto: true })
  );
  check('estricto: un select sin `id` lanza', !!errSinId?.includes('id'), String(errSinId));
}

comprobarPaginacion()
  .catch((e) => {
    fallidas++;
    console.log(`  ✗ excepción inesperada — ${e instanceof Error ? e.message : e}`);
  })
  .finally(() => {
    console.log(
      `\n${fallidas === 0 ? '✓' : '✗'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas`
    );
    process.exit(fallidas === 0 ? 0 : 1);
  });
