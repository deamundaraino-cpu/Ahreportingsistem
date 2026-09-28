/**
 * Prueba la migración 089 contra la base real SIN dejar nada escrito.
 *
 * Manda en UNA petición la migración entera más los casos de
 * `scripts/verify-hotmart-089.sql`. Los casos terminan con RAISE EXCEPTION a
 * propósito: la Management API ejecuta la petición como una transacción, así
 * que la excepción la aborta completa —columnas, funciones y filas de prueba— y
 * el resultado viaja en el mensaje de error. Sirve igual antes y después de
 * aplicar la 089.
 *
 *   npx tsx scripts/verify-hotmart-089.ts
 */

import { readFileSync } from 'node:fs';
import { sqlRemoto } from './sql-remoto';
import { salir } from './_salida';

type Caso = { paso: number; caso: string; ok: boolean };

async function main() {
  const migracion = readFileSync('migrations/089_hotmart_atribucion_y_guarda.sql', 'utf8')
    // Un NOTIFY dentro de una transacción abortada no se envía, pero sobra.
    .replace(/^NOTIFY .*$/m, '');
  const casos = readFileSync('scripts/verify-hotmart-089.sql', 'utf8');

  let mensaje = '';
  try {
    await sqlRemoto(`${migracion}\n${casos}`);
  } catch (e) {
    mensaje = e instanceof Error ? e.message : String(e);
  }

  const m = mensaje.match(/RESULTADO089 (\[.*\])/s);
  if (!m) {
    console.error('❌ La prueba no devolvió resultados.');
    console.error(
      mensaje
        ? `   Error: ${mensaje.slice(0, 1500)}`
        : '   La petición terminó SIN excepción: algo quedó escrito. Revísalo.'
    );
    salir(1);
    return;
  }

  // El mensaje llega escapado dentro del JSON de error de la API.
  const crudo = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const resultados = JSON.parse(crudo.slice(0, crudo.lastIndexOf(']') + 1)) as Caso[];

  let fallos = 0;
  for (const r of resultados.sort((a, b) => a.paso - b.paso)) {
    console.log(`  ${r.ok ? '✓' : '✗'} (${r.paso}) ${r.caso}`);
    if (!r.ok) fallos++;
  }
  console.log(
    `\n${fallos === 0 ? '✅' : '❌'} ${resultados.length - fallos} comprobaciones pasadas, ${fallos} fallidas`
  );
  salir(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  salir(1);
});
