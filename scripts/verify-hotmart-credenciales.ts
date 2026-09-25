/**
 * Credenciales de Hotmart: cifradas en la base y enmascaradas en el navegador.
 *
 * `hotmart_client_secret`, `hotmart_basic` y `hotmart_token` vivían EN CLARO en
 * `clientes.config_api`, y la ficha del cliente los mandaba enteros al
 * navegador. El formulario, además, escribía `hotmart_basic: ''` en todo
 * cliente sin Basic. Aquí se fija el contrato nuevo:
 *
 *  - el parche de la pestaña cifra cada secreto en su clave `*_enc` y vacía la
 *    copia en claro; `''` se guarda como `null`; `SECRETO_GUARDADO` no toca lo
 *    que haya;
 *  - los lectores prefieren la clave cifrada;
 *  - `obtenerToken` en modo Basic devuelve el parche que migra lo que siga en
 *    claro (migración perezosa, igual que los tokens de HotConnect);
 *  - un refresco de HotConnect que pierde la carrera contra el cron relee la
 *    config y usa el token nuevo en vez de dar la conexión por muerta.
 *
 * Todo PURO: se sustituye `globalThis.fetch` por un doble, no se toca la red ni
 * la base.
 *
 *   npx tsx --conditions=react-server scripts/verify-hotmart-credenciales.ts
 */

import { readFileSync } from 'node:fs';
import {
  SECRETO_GUARDADO,
  SECRETOS_HOTMART,
  CLAVES_SOLO_SERVIDOR,
  construirConfigEfectiva,
  construirParche,
  enmascararSecretosHotmart,
  esClaveDePestana,
  huellasPorPestana,
  prepararParcheHotmart,
  superponerFormularioHotmart,
} from '../src/lib/clientes/config-pestanas';
import {
  basicDeConfig,
  clientSecretDe,
  hotmartConectado,
  obtenerToken,
  renovadoPorOtro,
  type ConfigHotmart,
} from '../src/lib/hotmart/cliente';
import { cifrarSecreto, leerSecreto } from '../src/lib/secretos';
import { encrypt } from '../src/lib/report-utm/encryption';
import { salir } from './_salida';

// Claves de PRUEBA. Los módulos leen el entorno de forma perezosa (dentro de la
// función, no al importarse), así que asignarlas aquí llega a tiempo.
process.env.RUTM_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.HOTMART_APP_CLIENT_ID = 'app-id-de-prueba';
process.env.HOTMART_APP_CLIENT_SECRET = 'app-secret-de-prueba';

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

const descifrar = (v: unknown) => leerSecreto(typeof v === 'string' ? v : null, null).valor;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

// ── Doble de `fetch` ───────────────────────────────────────────
type Llamada = { url: string; init?: RequestInit };
const fetchReal = globalThis.fetch;
let llamadas: Llamada[] = [];

/** Sustituye `fetch` por una cola de respuestas; la última se repite. */
function simular(respuestas: Array<{ status?: number; body: unknown }>) {
  llamadas = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init });
    const r = respuestas[Math.min(i++, respuestas.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function cabecera(l: Llamada | undefined, nombre: string): string | null {
  const h = l?.init?.headers as Record<string, string> | undefined;
  return h?.[nombre] ?? null;
}

async function main() {
  // ════════════════════════════════════════════════════════════
  seccion('prepararParcheHotmart: cifra, vacía el claro y respeta el marcador');
  // ════════════════════════════════════════════════════════════
  {
    const parche = prepararParcheHotmart(
      {
        hotmart_client_id: 'cid',
        hotmart_client_secret: 'secreto-1',
        hotmart_basic: 'basic-1',
        hotmart_token: 'token-1',
        hotmart_connection_status: 'connected',
      },
      encrypt
    );
    check(
      'el secreto va cifrado y descifra al original',
      descifrar(parche.hotmart_client_secret_enc) === 'secreto-1'
    );
    check(
      'el Basic va cifrado y descifra al original',
      descifrar(parche.hotmart_basic_enc) === 'basic-1'
    );
    check(
      'el token va cifrado y descifra al original',
      descifrar(parche.hotmart_token_enc) === 'token-1'
    );
    check(
      'las copias en claro se vacían (null)',
      parche.hotmart_client_secret === null &&
        parche.hotmart_basic === null &&
        parche.hotmart_token === null
    );
    check('el client_id no es secreto y sigue en claro', parche.hotmart_client_id === 'cid');
    check('el resto de claves pasa tal cual', parche.hotmart_connection_status === 'connected');
    const texto = JSON.stringify(parche);
    check(
      'ningún secreto viaja en claro en el parche',
      !texto.includes('secreto-1') && !texto.includes('basic-1') && !texto.includes('token-1')
    );
  }
  {
    const parche = prepararParcheHotmart({ hotmart_basic: '', hotmart_client_id: '' }, encrypt);
    check("'' se guarda como null (adiós a hotmart_basic: '')", parche.hotmart_basic === null);
    check('un secreto vaciado borra también su versión cifrada', parche.hotmart_basic_enc === null);
    check("'' en una clave no secreta también es null", parche.hotmart_client_id === null);
    check(
      'solo espacios cuenta como vacío',
      prepararParcheHotmart({ hotmart_token: '   ' }, encrypt).hotmart_token_enc === null
    );
  }
  {
    const parche = prepararParcheHotmart(
      {
        hotmart_client_id: 'cid',
        hotmart_client_secret: SECRETO_GUARDADO,
        hotmart_basic: SECRETO_GUARDADO,
        hotmart_token: SECRETO_GUARDADO,
      },
      encrypt
    );
    const secretas = Object.keys(SECRETOS_HOTMART).flatMap((k) => [
      k,
      SECRETOS_HOTMART[k as keyof typeof SECRETOS_HOTMART],
    ]);
    check(
      'el marcador conserva lo guardado: la clave sale del parche',
      secretas.every((k) => !(k in parche)),
      JSON.stringify(parche)
    );
    check('el marcador nunca llega a la base', !JSON.stringify(parche).includes(SECRETO_GUARDADO));
  }
  {
    // Secreto nuevo con el Basic enmascarado: el Basic guardado se calculó con
    // el secreto viejo y `basicDeConfig` lo preferiría.
    const parche = prepararParcheHotmart(
      {
        hotmart_client_id: 'cid',
        hotmart_client_secret: 'secreto-nuevo',
        hotmart_basic: SECRETO_GUARDADO,
      },
      encrypt
    );
    check(
      'un secreto nuevo descarta el Basic viejo',
      parche.hotmart_basic === null && parche.hotmart_basic_enc === null
    );
    const sinId = prepararParcheHotmart(
      { hotmart_client_secret: 'secreto-nuevo', hotmart_basic: SECRETO_GUARDADO },
      encrypt
    );
    check(
      'sin client_id el Basic guardado se conserva (es la única credencial)',
      !('hotmart_basic' in sinId) && !('hotmart_basic_enc' in sinId)
    );
  }
  check(
    'las claves cifradas son solo de servidor',
    Object.values(SECRETOS_HOTMART).every(
      (k) => CLAVES_SOLO_SERVIDOR.includes(k) && !esClaveDePestana(k)
    )
  );

  // ════════════════════════════════════════════════════════════
  seccion('construirConfigEfectiva: el Basic no se calcula del marcador');
  // ════════════════════════════════════════════════════════════
  {
    const vacia = construirConfigEfectiva({}, [], []);
    check("sin credenciales no aparece hotmart_basic (ni '')", !('hotmart_basic' in vacia));

    const enmascarada = construirConfigEfectiva(
      { hotmart_client_id: 'cid', hotmart_client_secret: SECRETO_GUARDADO },
      [],
      []
    );
    check(
      'con el secreto enmascarado no se inventa un Basic',
      !('hotmart_basic' in enmascarada),
      String(enmascarada.hotmart_basic)
    );

    const ambos = construirConfigEfectiva(
      {
        hotmart_client_id: 'cid',
        hotmart_client_secret: SECRETO_GUARDADO,
        hotmart_basic: SECRETO_GUARDADO,
      },
      [],
      []
    );
    check(
      'Basic enmascarado + secreto enmascarado → se conserva',
      ambos.hotmart_basic === SECRETO_GUARDADO
    );

    const nuevo = construirConfigEfectiva(
      {
        hotmart_client_id: 'cid',
        hotmart_client_secret: 'secreto-nuevo',
        hotmart_basic: SECRETO_GUARDADO,
      },
      [],
      []
    );
    check(
      'un secreto tecleado recalcula el Basic enmascarado',
      nuevo.hotmart_basic === b64('cid:secreto-nuevo')
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('enmascararSecretosHotmart: el navegador no recibe secretos');
  // ════════════════════════════════════════════════════════════
  {
    const guardada = {
      hotmart_auth_mode: 'basic',
      hotmart_client_id: 'cid',
      hotmart_client_secret: 'secreto-en-claro',
      hotmart_basic_enc: cifrarSecreto('basic-cifrado'),
      hotmart_basic: null,
      hotmart_token: '',
      hotmart_access_token: 'access-en-claro',
      hotmart_refresh_token_enc: cifrarSecreto('refresh'),
      hotmart_token_expires_at: '2026-01-01T00:00:00.000Z',
      meta_token: 'no-es-de-hotmart',
    };
    const vista = enmascararSecretosHotmart(guardada);
    const texto = JSON.stringify(vista);
    check(
      'el secreto en claro llega como marcador',
      vista.hotmart_client_secret === SECRETO_GUARDADO
    );
    check('el Basic solo-cifrado llega como marcador', vista.hotmart_basic === SECRETO_GUARDADO);
    check('un secreto vacío no se marca como guardado', vista.hotmart_token === '');
    check('no viaja ninguna clave *_enc', !/_enc"/.test(texto), texto);
    check(
      'no viajan los tokens de HotConnect',
      !('hotmart_access_token' in vista) && !('hotmart_refresh_token_enc' in vista)
    );
    check(
      'no viaja ningún valor secreto',
      !texto.includes('secreto-en-claro') && !texto.includes('access-en-claro')
    );
    check('el client_id sí viaja', vista.hotmart_client_id === 'cid');
    check('lo que no es de Hotmart no se toca', vista.meta_token === 'no-es-de-hotmart');
    check('no muta el original', guardada.hotmart_client_secret === 'secreto-en-claro');

    // Abrir la ficha y guardar Hotmart sin tocar nada no debe tocar secretos.
    const efectiva = construirConfigEfectiva(vista, [], []);
    const base = huellasPorPestana(efectiva);
    check(
      'la pestaña de Hotmart no nace sucia',
      base.hotmart === huellasPorPestana(construirConfigEfectiva(vista, [], [])).hotmart
    );
    const parche = prepararParcheHotmart(construirParche(efectiva, 'hotmart'), encrypt);
    check(
      'guardar sin cambios no escribe ningún secreto',
      !('hotmart_client_secret' in parche) &&
        !('hotmart_client_secret_enc' in parche) &&
        !('hotmart_basic' in parche) &&
        !('hotmart_basic_enc' in parche),
      JSON.stringify(parche)
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('superponerFormularioHotmart: probar = guardado + lo tecleado');
  // ════════════════════════════════════════════════════════════
  {
    const guardada = {
      hotmart_auth_mode: 'basic',
      hotmart_client_id: 'cid',
      hotmart_client_secret_enc: cifrarSecreto('secreto-1'),
      hotmart_basic_enc: cifrarSecreto(b64('cid:secreto-1')),
    };
    const intacta = superponerFormularioHotmart(guardada, {
      hotmart_auth_mode: 'hotconnect',
      hotmart_client_id: 'cid',
      hotmart_client_secret: SECRETO_GUARDADO,
      hotmart_basic: SECRETO_GUARDADO,
    });
    check(
      'con todo enmascarado se prueba lo guardado',
      basicDeConfig(intacta as ConfigHotmart) === b64('cid:secreto-1')
    );
    check('el modo de conexión no lo decide el formulario', intacta.hotmart_auth_mode === 'basic');

    // El formulario real manda la pestaña ya derivada (Basic recalculado).
    const formulario = construirParche(
      construirConfigEfectiva(
        {
          hotmart_client_id: 'cid',
          hotmart_client_secret: 'secreto-2',
          hotmart_basic: SECRETO_GUARDADO,
        },
        [],
        []
      ),
      'hotmart'
    );
    const nueva = superponerFormularioHotmart(guardada, formulario) as ConfigHotmart;
    check(
      'un secreto tecleado manda sobre el cifrado',
      clientSecretDe(nueva).valor === 'secreto-2'
    );
    check('y el Basic que se prueba es el nuevo', basicDeConfig(nueva) === b64('cid:secreto-2'));

    // Aunque llegue sin Basic recalculado, el viejo no se cuela.
    const sinBasic = superponerFormularioHotmart(guardada, {
      hotmart_client_id: 'cid',
      hotmart_client_secret: 'secreto-3',
      hotmart_basic: SECRETO_GUARDADO,
    }) as ConfigHotmart;
    check(
      'el Basic viejo no gana a un secreto nuevo',
      basicDeConfig(sinBasic) === b64('cid:secreto-3')
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('Lectores: la clave cifrada primero');
  // ════════════════════════════════════════════════════════════
  {
    check(
      'basicDeConfig prefiere hotmart_basic_enc',
      basicDeConfig({ hotmart_basic_enc: cifrarSecreto('cifrado'), hotmart_basic: 'claro' }) ===
        'cifrado'
    );
    check(
      'clientSecretDe prefiere hotmart_client_secret_enc',
      clientSecretDe({
        hotmart_client_secret_enc: cifrarSecreto('cifrado'),
        hotmart_client_secret: 'claro',
      }).valor === 'cifrado'
    );
    check(
      'el Basic se deriva de client_id + secreto cifrado',
      basicDeConfig({
        hotmart_client_id: 'cid',
        hotmart_client_secret_enc: cifrarSecreto('sec'),
      }) === b64('cid:sec')
    );
    check(
      'hotmartConectado con client_id + secreto solo cifrado',
      hotmartConectado({ hotmart_client_id: 'cid', hotmart_client_secret_enc: 'x:y:z' })
    );
    check(
      'hotmartConectado con solo hotmart_basic_enc',
      hotmartConectado({ hotmart_basic_enc: 'x:y:z' })
    );
    check(
      'hotmartConectado con solo hotmart_token_enc',
      hotmartConectado({ hotmart_token_enc: 'x:y:z' })
    );
    check(
      "hotmartConectado es false con hotmart_basic: ''",
      !hotmartConectado({ hotmart_basic: '' })
    );
    check(
      "false también con client_id y hotmart_basic: '' (sin secreto)",
      !hotmartConectado({
        hotmart_basic: '',
        hotmart_client_id: 'cid',
        hotmart_client_secret: null,
      })
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('obtenerToken en modo Basic: devuelve la migración');
  // ════════════════════════════════════════════════════════════
  {
    const enClaro: ConfigHotmart = {
      hotmart_auth_mode: 'basic',
      hotmart_client_id: 'cid',
      hotmart_client_secret: 'secreto-en-claro',
      hotmart_basic: 'basic-en-claro',
      hotmart_token: '',
    };
    simular([{ body: { access_token: 'AT-1', expires_in: 172800 } }]);
    const r = await obtenerToken(enClaro);
    check('consigue el token', r.token === 'AT-1');
    check(
      'usa el Basic guardado',
      cabecera(llamadas[0], 'Authorization') === 'Basic basic-en-claro'
    );
    check('la petición lleva timeout (signal)', llamadas[0]?.init?.signal instanceof AbortSignal);
    const p = r.parche ?? {};
    check('hay parche de migración', r.parche != null);
    check(
      'el secreto pasa a hotmart_client_secret_enc',
      descifrar(p.hotmart_client_secret_enc) === 'secreto-en-claro' &&
        p.hotmart_client_secret === null
    );
    check(
      'el Basic pasa a hotmart_basic_enc',
      descifrar(p.hotmart_basic_enc) === 'basic-en-claro' && p.hotmart_basic === null
    );
    check(
      "el hotmart_token: '' heredado se limpia a null",
      p.hotmart_token === null && !('hotmart_token_enc' in p)
    );
    check('el parche no lleva nada en claro', !JSON.stringify(p).includes('en-claro'));

    // Aplicado el parche (lo que hace `fusionar_config_api`), todo sigue igual.
    const migrada = { ...enClaro, ...p } as ConfigHotmart;
    check('tras migrar sigue conectado', hotmartConectado(migrada));
    check('tras migrar el Basic es el mismo', basicDeConfig(migrada) === 'basic-en-claro');
    simular([{ body: { access_token: 'AT-2' } }]);
    const r2 = await obtenerToken(migrada);
    check(
      'la segunda vuelta no migra nada (idempotente)',
      r2.token === 'AT-2' && r2.parche === null
    );

    // Un valor ya cifrado que alguien dejó en la clave en claro no se pierde.
    simular([{ body: { access_token: 'AT-3' } }]);
    const mezclada = await obtenerToken({
      hotmart_client_id: 'cid',
      hotmart_client_secret: cifrarSecreto('secreto-cifrado-mal-puesto'),
    });
    check(
      'un cifrado en la clave en claro se mueve a *_enc',
      descifrar(mezclada.parche?.hotmart_client_secret_enc) === 'secreto-cifrado-mal-puesto' &&
        mezclada.parche?.hotmart_client_secret === null
    );

    // Hotmart rechaza la credencial: no se migra nada.
    simular([{ status: 401, body: { error: 'invalid_client' } }]);
    const rechazo = await obtenerToken(enClaro);
    check('credencial rechazada → sin token ni parche', rechazo.token === null && !rechazo.parche);

    // Sin clave de cifrado el worker sigue sincronizando: no hay parche, no lanza.
    const clave = process.env.RUTM_ENCRYPTION_KEY;
    delete process.env.RUTM_ENCRYPTION_KEY;
    simular([{ body: { access_token: 'AT-4' } }]);
    let sinClave: Awaited<ReturnType<typeof obtenerToken>> | null = null;
    try {
      sinClave = await obtenerToken(enClaro);
    } catch {
      sinClave = null;
    }
    process.env.RUTM_ENCRYPTION_KEY = clave;
    check(
      'sin RUTM_ENCRYPTION_KEY: token sí, parche no',
      sinClave?.token === 'AT-4' && sinClave?.parche === null
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('HotConnect: carrera de refresco contra el cron');
  // ════════════════════════════════════════════════════════════
  {
    const vencida: ConfigHotmart = {
      hotmart_auth_mode: 'hotconnect',
      hotmart_access_token_enc: cifrarSecreto('access-viejo'),
      hotmart_refresh_token_enc: cifrarSecreto('refresh-viejo'),
      hotmart_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    const renovada: ConfigHotmart = {
      ...vencida,
      hotmart_access_token_enc: cifrarSecreto('access-del-cron'),
      hotmart_refresh_token_enc: cifrarSecreto('refresh-del-cron'),
      hotmart_token_expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
    };

    check('renovadoPorOtro: vencimiento posterior → sí', renovadoPorOtro(vencida, renovada));
    check('renovadoPorOtro: la misma config → no', !renovadoPorOtro(vencida, { ...vencida }));
    check('renovadoPorOtro: sin relectura → no', !renovadoPorOtro(vencida, null));
    check(
      'renovadoPorOtro: mismo refresh re-cifrado (otro IV) → no',
      !renovadoPorOtro(vencida, {
        ...vencida,
        hotmart_refresh_token_enc: cifrarSecreto('refresh-viejo'),
      })
    );
    check(
      'renovadoPorOtro: refresh distinto con el mismo vencimiento → sí',
      renovadoPorOtro(vencida, { ...vencida, hotmart_refresh_token_enc: cifrarSecreto('otro') })
    );

    let relecturas = 0;
    simular([{ status: 400, body: { error: 'invalid_grant' } }]);
    const r = await obtenerToken(vencida, {
      releer: async () => {
        relecturas++;
        return renovada;
      },
    });
    check(
      'invalid_grant + relectura con token nuevo → usa el del cron',
      r.token === 'access-del-cron'
    );
    check('releyó una sola vez', relecturas === 1);
    check('no volvió a pedir token a Hotmart', llamadas.length === 1);
    check('el refresco lleva timeout (signal)', llamadas[0]?.init?.signal instanceof AbortSignal);
    check('nada que persistir: el token ya está en la base', !r.parche);

    relecturas = 0;
    simular([{ status: 400, body: { error: 'invalid_grant' } }]);
    const muerta = await obtenerToken(vencida, {
      releer: async () => {
        relecturas++;
        return { ...vencida };
      },
    });
    check(
      'relectura sin cambios → sin token, con motivo',
      muerta.token === null && Boolean(muerta.motivo)
    );
    check('sin bucle: una relectura y una petición', relecturas === 1 && llamadas.length === 1);

    simular([{ status: 400, body: { error: 'invalid_grant' } }]);
    const sinReleer = await obtenerToken(vencida);
    check('sin `releer` se comporta como antes', sinReleer.token === null);

    simular([
      { body: { access_token: 'access-nuevo', refresh_token: 'refresh-nuevo', expires_in: 3600 } },
    ]);
    const ok = await obtenerToken(vencida, {
      releer: async () => {
        throw new Error('no debería releer');
      },
    });
    check(
      'refresco correcto → no relee y rota el refresh token',
      ok.token === 'access-nuevo' &&
        descifrar(ok.parche?.hotmart_refresh_token_enc) === 'refresh-nuevo'
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('Guardarraíles estáticos');
  // ════════════════════════════════════════════════════════════
  {
    const acciones = readFileSync('src/app/(app)/admin/settings/_actions.ts', 'utf8');
    const cuerpo = (nombre: string) => {
      const ini = acciones.indexOf(`export async function ${nombre}(`);
      const fin = acciones.indexOf('\nexport ', ini + 1);
      return ini < 0 ? '' : acciones.slice(ini, fin < 0 ? undefined : fin);
    };
    const guardar = cuerpo('guardarConfigPestana');
    check(
      'guardarConfigPestana cifra con prepararParcheHotmart',
      guardar.includes('prepararParcheHotmart(')
    );
    const probar = cuerpo('testHotmartConnection');
    check('testHotmartConnection comprueba el rol', probar.includes('rolActual()'));
    check('testHotmartConnection saca el token de obtenerToken', probar.includes('obtenerToken('));
    check(
      'testHotmartConnection no lee tokens en claro',
      !/config\.hotmart_(access_token|basic|client_secret|token)\b/.test(probar)
    );
    check(
      'testHotmartConnection persiste con fusionar_config_api, sin update()',
      probar.includes("'fusionar_config_api'") && !probar.includes('.update(')
    );
    check(
      'getCliente enmascara los secretos',
      cuerpo('getCliente').includes('enmascararSecretosHotmart(')
    );

    const cron = readFileSync('src/app/api/cron/refresh-hotmart-tokens/route.ts', 'utf8');
    check('el cron relee antes de marcar expired', cron.includes('renovadoPorOtro('));
    check('el cron pone timeout al refresco', cron.includes('AbortSignal.timeout('));
  }
}

main()
  .catch((e) => {
    console.error(e);
    fallos++;
  })
  .finally(() => {
    globalThis.fetch = fetchReal;
    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
    salir(fallos);
  });
