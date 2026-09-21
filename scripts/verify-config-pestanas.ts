/**
 * El reparto de `config_api` entre las pestañas de la ficha del cliente.
 *
 * Lo que se protege aquí es que guardar una pestaña NO pise otra. El formulario
 * antiguo mandaba el objeto entero y se llevaba por delante lo que el servidor
 * hubiera escrito entre medias; el parche por pestaña solo vale si el mapa de
 * claves particiona de verdad y si la huella es estable.
 *
 *   npx tsx --conditions=react-server scripts/verify-config-pestanas.ts
 */

import {
  PESTANAS,
  CLAVES_POR_PESTANA,
  CLAVES_SOLO_SERVIDOR,
  construirConfigEfectiva,
  construirParche,
  huella,
  huellasPorPestana,
  esClaveDePestana,
  type Pestana,
} from '../src/lib/clientes/config-pestanas';

let fallos = 0;
function ok(cond: boolean, msg: string) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fallos++;
}

console.log('\n1. El mapa particiona: ninguna clave en dos pestañas');
{
  const vistas = new Map<string, Pestana>();
  const repetidas: string[] = [];
  for (const p of PESTANAS) {
    for (const c of CLAVES_POR_PESTANA[p]) {
      if (vistas.has(c)) repetidas.push(`${c} (${vistas.get(c)} y ${p})`);
      else vistas.set(c, p);
    }
  }
  ok(repetidas.length === 0, `sin claves repetidas${repetidas.length ? ': ' + repetidas : ''}`);
}

console.log('\n2. Ninguna clave de servidor es escribible desde el formulario');
{
  const invasoras = CLAVES_SOLO_SERVIDOR.filter((c) => esClaveDePestana(c));
  ok(
    invasoras.length === 0,
    `los tokens y estados que escribe el servidor quedan fuera${invasoras.length ? ': ' + invasoras : ''}`
  );
}

console.log('\n3. Un parche nunca lleva claves de otra pestaña');
{
  const efectiva = construirConfigEfectiva(
    {
      meta_token: 'T',
      meta_keywords: 'negro',
      ga_property_id: '123',
      hotmart_client_id: 'cid',
      hotmart_client_secret: 'sec',
      tiktok_access_token: 'tk',
      // Lo que solo escribe el servidor: viene en la config, no debe salir.
      hotmart_access_token_enc: 'SECRETO',
      meta_estado_cuentas: { act_1: 'ok' },
    },
    [{ account_id: 'act_1' }],
    [{ advertiser_id: 'adv_1' }]
  );

  for (const p of PESTANAS) {
    const parche = construirParche(efectiva, p);
    const permitidas = new Set(CLAVES_POR_PESTANA[p]);
    const fuera = Object.keys(parche).filter((c) => !permitidas.has(c));
    ok(fuera.length === 0, `«${p}» solo emite lo suyo${fuera.length ? ' — se coló ' + fuera : ''}`);
  }

  const todas = PESTANAS.flatMap((p) => Object.keys(construirParche(efectiva, p)));
  ok(
    !todas.includes('hotmart_access_token_enc'),
    'el token cifrado de Hotmart no viaja en ningún parche'
  );
  ok(
    !todas.includes('meta_estado_cuentas'),
    'el estado de cuentas de Meta no viaja en ningún parche'
  );
}

console.log('\n4. La huella no depende del orden de las claves');
{
  ok(huella({ a: 1, b: 2 }) === huella({ b: 2, a: 1 }), 'dos objetos iguales dan la misma huella');
  ok(
    huella([1, 2]) !== huella([2, 1]),
    'el orden de un array sí cuenta (las cuentas están ordenadas)'
  );
  ok(
    huella({ a: { y: 1, x: 2 } }) === huella({ a: { x: 2, y: 1 } }),
    'ordena también en profundidad'
  );
}

console.log('\n5. Una ficha recién abierta no aparece con cambios sin guardar');
{
  // El caso que rompía: hotmart_basic se CALCULA de client_id + secret. Si la
  // línea base se tomara del objeto crudo, Hotmart nacería sucia.
  const crudo = { hotmart_client_id: 'cid', hotmart_client_secret: 'sec', meta_token: 'T' };
  const metaAccounts = [{ account_id: 'act_1' }];
  const tiktokAccounts: unknown[] = [];

  const base = huellasPorPestana(construirConfigEfectiva(crudo, metaAccounts, tiktokAccounts));
  const ahora = huellasPorPestana(construirConfigEfectiva(crudo, metaAccounts, tiktokAccounts));

  const sucias = PESTANAS.filter((p) => base[p] !== ahora[p]);
  ok(sucias.length === 0, `ninguna pestaña nace sucia${sucias.length ? ': ' + sucias : ''}`);
  ok(
    typeof construirConfigEfectiva(crudo, metaAccounts, tiktokAccounts).hotmart_basic ===
      'string' && construirConfigEfectiva(crudo, metaAccounts, tiktokAccounts).hotmart_basic !== '',
    'hotmart_basic se deriva de client_id + secret'
  );
}

console.log('\n6. Editar una pestaña solo ensucia esa pestaña');
{
  const crudo = { meta_token: 'T', ga_property_id: '123', tiktok_access_token: 'tk' };
  const base = huellasPorPestana(construirConfigEfectiva(crudo, [], []));

  const editado = huellasPorPestana(
    construirConfigEfectiva({ ...crudo, ga_property_id: '999' }, [], [])
  );
  const sucias = PESTANAS.filter((p) => base[p] !== editado[p]);
  ok(
    sucias.length === 1 && sucias[0] === 'google',
    `cambiar GA4 ensucia solo «google» (${sucias})`
  );

  const conCuenta = huellasPorPestana(
    construirConfigEfectiva(crudo, [{ account_id: 'act_9' }], [])
  );
  const sucias2 = PESTANAS.filter((p) => base[p] !== conCuenta[p]);
  ok(
    sucias2.length === 1 && sucias2[0] === 'meta',
    `añadir una cuenta de Meta ensucia solo «meta» (${sucias2})`
  );
}

console.log('\n7. Las pestañas sin claves propias nunca pueden estar sucias');
{
  const sinClaves = PESTANAS.filter((p) => CLAVES_POR_PESTANA[p].length === 0);
  ok(sinClaves.length > 0, `hay pestañas autogestionadas: ${sinClaves.join(', ')}`);
  for (const p of sinClaves) {
    ok(
      huella(construirParche(construirConfigEfectiva({ meta_token: 'X' }, [], []), p)) === '{}',
      `«${p}» produce un parche vacío`
    );
  }
}

if (fallos > 0) {
  console.error(`\n${fallos} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log('\nOK: todas las comprobaciones pasan.');
