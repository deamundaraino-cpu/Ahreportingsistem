/**
 * Comprobaciones del adelgazamiento de `lead_events` (migración 084).
 *
 * La base se cayó el 2026-09-20 por una desproporción entre datos y memoria:
 * 543 MB contra 224 MB de caché. Medido entonces, cada lead ocupaba ~3.750 bytes
 * cuando el lead en sí son ~300. El resto era lo mismo guardado varias veces:
 *
 *   · la fila entera duplicada en `pixel_events` (98,7 % tenía gemela)
 *   · las UTM dentro de `page_url`, que ya están en columnas propias
 *   · las UTM otra vez dentro del JSONB `first_touch`
 *
 * Este script fija las dos reglas que impiden que eso vuelva. Todo es puro: no
 * toca Postgres.
 *
 *   npx tsx --conditions=react-server scripts/verify-lead-adelgazado.ts
 */

import { normalizarPageUrl } from '../src/lib/report-utm/page-url';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ── 1. La query string pierde solo lo que ya está en columnas ────────
console.log('\n── page_url: qué se recorta y qué se conserva ─────────────');

const URL_REAL =
  'https://adshouseagencia.com/registro-evs/?utm_source=Facebook_Mobile_Reels&utm_medium=fb' +
  '&utm_campaign=JD+-+AH+%5B060826%5D&utm_content=AD+2&utm_term=35-55&fbclid=IwAR0abcdef123456';

const limpia = normalizarPageUrl(URL_REAL);

check('el path sobrevive intacto', limpia === 'https://adshouseagencia.com/registro-evs/');
check('no queda ni un utm_ ni el fbclid', !/utm_|fbclid/i.test(limpia ?? ''), `quedó: ${limpia}`);
check(
  'y recorta de verdad: 486 caracteres de media eran el 29 % de la tabla',
  (limpia?.length ?? 0) < URL_REAL.length / 3
);

// Los parámetros propios del cliente NO están duplicados en ninguna columna:
// aparecían en 3.565 filas y conservarlos cuesta 684 kB sobre el total.
const CON_PROPIOS =
  'https://adshouseagencia.com/panguipulli-v2/?utm_source=Instagram_Stories&lpt=abc123' +
  '&hsa_cam=99&brid=7&ttclid=EAAA';
const conservada = normalizarPageUrl(CON_PROPIOS);

check('se conserva lpt', conservada?.includes('lpt=abc123') === true, `quedó: ${conservada}`);
check('se conserva hsa_cam', conservada?.includes('hsa_cam=99') === true);
check('se conserva brid', conservada?.includes('brid=7') === true);
check('pero ttclid se va: ya está en la columna click_id', !/ttclid/i.test(conservada ?? ''));

// Casos límite: lo que no se sabe leer no se toca.
check(
  'una URL sin query string no cambia',
  normalizarPageUrl('https://a.com/b') === 'https://a.com/b'
);
check('null sigue siendo null', normalizarPageUrl(null) === null);
check('undefined también', normalizarPageUrl(undefined) === null);
check(
  'una cadena que no es URL absoluta se guarda tal cual',
  normalizarPageUrl('/registro?utm_source=x') === '/registro?utm_source=x'
);
check(
  'si solo había parámetros duplicados, no queda un ? colgando',
  normalizarPageUrl('https://a.com/b?utm_source=x&fbclid=y') === 'https://a.com/b'
);
check(
  'gclid y msclkid también salen (mismo motivo que fbclid)',
  normalizarPageUrl('https://a.com/b?gclid=1&msclkid=2') === 'https://a.com/b'
);
check(
  'el hash se respeta',
  normalizarPageUrl('https://a.com/b?fbclid=1#seccion') === 'https://a.com/b#seccion'
);

// ── 2. Un lead no escribe en pixel_events ────────────────────────────
console.log('\n── El endpoint S2S no duplica la fila ────────────────────');

// No se puede invocar el endpoint sin base ni firma HMAC, así que se comprueba
// sobre el propio fuente: el insert a `pixel_events` tiene que estar dentro de
// un `if` que excluya los leads. Era incondicional, con el comentario «para no
// romper dashboards existentes» — dashboards que no existían: las 90.401 filas
// de la tabla eran leads y `sales_events` seguía vacía.
import { readFileSync } from 'node:fs';
const fuente = readFileSync('src/app/api/report-utm/pixel/s2s/route.ts', 'utf8');

check(
  "el insert a pixel_events está bajo `if (eventType !== 'lead')`",
  /if \(eventType !== 'lead'\)\s*\{[\s\S]{0,400}?from\('pixel_events'\)\.insert/.test(fuente)
);
check(
  'el lead se guarda con la page_url ya normalizada',
  /page_url: pageUrl,/.test(fuente) && /normalizarPageUrl\(body\.page_url\)/.test(fuente)
);
check(
  'ya no se escriben first_touch ni last_touch en el lead',
  !/first_touch|last_touch|dedupTouches/.test(fuente)
);
// Se busca la llamada y el import, no la palabra: el comentario del fuente la
// menciona a propósito para explicar por qué ya no está.
check(
  'ni se consulta pixel_events para resolver la atribución',
  !/resolveAttribution\(/.test(fuente) && !/attribution-resolver/.test(fuente)
);
check(
  'la atribución se calcula y se guarda en el propio insert, sin UPDATE posterior',
  /attribution_method: metodoAtribucion,/.test(fuente) &&
    !/from\('lead_events'\)\s*\.update\(/.test(fuente)
);
check(
  'el fallo al insertar el lead ya no se traga en silencio',
  /lead_events insert error[\s\S]{0,200}?status: 500/.test(fuente)
);

// ── 3. El SQL y el TypeScript no pueden separarse ────────────────────
console.log('\n── La migración 084 limpia lo mismo que page-url.ts ──────');

// El backfill corre en SQL (`report_utm.limpiar_page_url`) y las escrituras
// nuevas en TS (`normalizarPageUrl`). Si las dos listas de parámetros divergen,
// el histórico y lo nuevo quedan limpiados con criterios distintos y nadie se
// entera hasta que alguien compara dos filas a mano. Verificado a mano contra
// producción el 2026-09-21: las dos dan el mismo resultado en los cinco casos
// de arriba.
const LISTA = 'utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id';
const helperTs = readFileSync('src/lib/report-utm/page-url.ts', 'utf8');
const migracion = readFileSync('migrations/084_adelgazar_lead_events.sql', 'utf8');

check('page-url.ts usa la lista esperada', helperTs.includes(LISTA));
check('y la 084 usa exactamente la misma', migracion.includes(LISTA));
check(
  'la 084 no hace un UPDATE de golpe: va por lotes',
  /backfill_page_url/.test(migracion) && /LIMIT p_lote/.test(migracion)
);
check(
  'la 084 elimina las dos columnas de touches',
  /DROP COLUMN IF EXISTS first_touch/.test(migracion) &&
    /DROP COLUMN IF EXISTS last_touch/.test(migracion)
);

// ── Cierre ───────────────────────────────────────────────────────────
if (fallos > 0) {
  console.log(`\n❌ ${fallos} comprobación(es) fallaron`);
  process.exit(1);
}
console.log('\n✅ Adelgazamiento de lead_events: todas las comprobaciones pasan');
