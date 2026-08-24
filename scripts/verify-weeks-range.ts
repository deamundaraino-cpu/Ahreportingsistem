/**
 * Comprobaciones del troceado en semanas (`src/lib/date-utils.ts`).
 *
 * Todo PURO: ni base de datos ni APIs.
 *
 * ── Lo que protege ──────────────────────────────────────────────────────
 * `getWeeksInRange` perdía el último día del rango cuando ese día era LUNES.
 * `endOfWeek()` devuelve el domingo a las 23:59:59.999 y `addDays(weekEnd, 1)`
 * daba el lunes a las 23:59:59.999, que no es "antes de" ni "igual a" el lunes a
 * las 00:00 con el que se comparaba: el bucle salía sin emitir esa semana. La
 * Vista de Embudo Diaria solo pinta días que están dentro de una semana, así que
 * ese día no salía NI con ceros —simplemente no había fila—, mientras las
 * tarjetas y la tira de totales (que agregan todas las filas, no las semanas) sí
 * lo contaban: los totales no cuadraban con lo visible. 10 de los 12 presets
 * terminan en "hoy", así que cada lunes se perdía el día más reciente.
 *
 * La comprobación que cierra la clase entera de bug —no solo los lunes— es el
 * BARRIDO: para cualquier par (inicio, fin), la suma de días de las semanas
 * devueltas tiene que ser exactamente el span inclusivo del rango.
 *
 *   npx tsx scripts/verify-weeks-range.ts
 */

import { getWeeksInRange, getMonthWeeks, addDaysISO } from '../src/lib/date-utils';

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

function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

type Semana = { weekNumber: number; start: string; end: string };

/** Días inclusivos entre dos `yyyy-MM-dd`. */
function spanDias(desde: string, hasta: string): number {
  const ms = Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Días que la tabla llegaría a pintar: la suma de los spans de cada semana. */
function diasPintados(semanas: Semana[]): number {
  return semanas.reduce((n, s) => n + spanDias(s.start, s.end), 0);
}

/** true si la fecha es lunes. Se lee en UTC: un `yyyy-MM-dd` no tiene zona. */
function esLunes(fecha: string): boolean {
  return new Date(`${fecha}T00:00:00Z`).getUTCDay() === 1;
}

const ultima = (s: Semana[]) => s[s.length - 1];

// ════════════════════════════════════════════════════════════
seccion('La regresión: rangos que terminan en LUNES');
// ════════════════════════════════════════════════════════════

// 2026-08-10 es lunes, y era el caso reportado: la tabla mostraba "Sem 1"
// (01-02 ago) y "Sem 2" (03-09 ago), sin ninguna fila para el 10.
check('2026-08-10 es lunes (premisa del caso reportado)', esLunes('2026-08-10'));

const caso = getWeeksInRange('2026-08-01', '2026-08-10');
const esperado: Semana[] = [
  { weekNumber: 1, start: '2026-08-01', end: '2026-08-02' },
  { weekNumber: 2, start: '2026-08-03', end: '2026-08-09' },
  { weekNumber: 3, start: '2026-08-10', end: '2026-08-10' },
];
check(
  '01→10 ago devuelve exactamente 3 semanas, la última de un solo día',
  JSON.stringify(caso) === JSON.stringify(esperado),
  JSON.stringify(caso)
);
check(
  '01→10 ago termina el 10, no el 09 (EL bug)',
  ultima(caso).end === '2026-08-10',
  ultima(caso)?.end
);

// El resto de rangos que acaban en lunes, por conteo de días pintados.
const casosLunes: [string, string, number][] = [
  ['2026-08-01', '2026-08-10', 10],
  ['2026-07-12', '2026-08-10', 30],
  ['2026-08-04', '2026-08-10', 7],
  ['2026-07-06', '2026-08-03', 29],
  ['2026-08-01', '2026-08-31', 31], // agosto 2026 acaba en lunes
  ['2026-08-24', '2026-08-24', 1],
];
for (const [desde, hasta, dias] of casosLunes) {
  const w = getWeeksInRange(desde, hasta);
  check(
    `${desde}→${hasta} pinta ${dias} días`,
    diasPintados(w) === dias && ultima(w).end === hasta,
    `pintó ${diasPintados(w)}, último ${ultima(w)?.end}`
  );
}

// ════════════════════════════════════════════════════════════
seccion('Lo que NO debe cambiar');
// ════════════════════════════════════════════════════════════

// 2026-08-05 es miércoles: la primera semana va del miércoles al domingo.
const corta = getWeeksInRange('2026-08-05', '2026-08-20');
check(
  'la primera semana se recorta al inicio del rango (mié→dom)',
  JSON.stringify(corta[0]) ===
    JSON.stringify({ weekNumber: 1, start: '2026-08-05', end: '2026-08-09' }),
  JSON.stringify(corta[0])
);
check(
  'la última semana se recorta al final del rango',
  ultima(corta).end === '2026-08-20',
  ultima(corta)?.end
);

// weekNumber es un contador, no la semana ISO: la semana ISO del 2026-08-01 es la 31.
const mesAgosto = getWeeksInRange('2026-08-01', '2026-08-31');
check(
  'weekNumber empieza en 1 y no es la semana ISO del año',
  mesAgosto[0].weekNumber === 1,
  String(mesAgosto[0].weekNumber)
);
check(
  'weekNumber es secuencial 1..n',
  mesAgosto.every((s, i) => s.weekNumber === i + 1)
);

check(
  'las semanas 2..n empiezan en lunes',
  mesAgosto.slice(1).every((s) => esLunes(s.start)),
  mesAgosto
    .slice(1)
    .map((s) => s.start)
    .join(' ')
);

const invertido = getWeeksInRange('2026-08-12', '2026-08-01');
check(
  'un rango invertido se colapsa a un solo día',
  JSON.stringify(invertido) ===
    JSON.stringify([{ weekNumber: 1, start: '2026-08-12', end: '2026-08-12' }]),
  JSON.stringify(invertido)
);

// Un solo día, en cada uno de los 7 días de la semana.
for (let i = 0; i < 7; i++) {
  const d = addDaysISO('2026-08-10', i); // arranca en lunes
  const w = getWeeksInRange(d, d);
  check(
    `un solo día (${d}) da 1 semana de 1 día`,
    w.length === 1 && w[0].start === d && w[0].end === d,
    JSON.stringify(w)
  );
}

const cruces: [string, string, number, string][] = [
  ['2026-07-28', '2026-08-04', 8, 'cruce de mes'],
  ['2026-12-28', '2027-01-04', 8, 'cruce de año'],
  ['2028-02-26', '2028-03-02', 6, '29 de febrero bisiesto'],
];
for (const [desde, hasta, dias, etiqueta] of cruces) {
  const w = getWeeksInRange(desde, hasta);
  check(
    `${etiqueta} (${desde}→${hasta}) pinta ${dias} días`,
    diasPintados(w) === dias && w[0].start === desde && ultima(w).end === hasta,
    `pintó ${diasPintados(w)}`
  );
}

// ════════════════════════════════════════════════════════════
seccion('El barrido: la invariante que cierra la clase de bug');
// ════════════════════════════════════════════════════════════

// Para CUALQUIER par (inicio, fin), los días pintados tienen que ser exactamente
// el span del rango. Es lo que atrapa este bug y cualquier otro que pierda o
// duplique un día, sin depender de que alguien piense en probar los lunes.
{
  let pares = 0;
  let paresLunes = 0;
  let falloSpan = '';
  let falloBordes = '';
  let falloContigua = '';
  let falloTamano = '';
  let falloNumero = '';
  let falloLunes = '';

  for (let i = 0; i < 400; i++) {
    const desde = addDaysISO('2025-11-01', i);
    for (let largo = 1; largo <= 95; largo++) {
      const hasta = addDaysISO(desde, largo - 1);
      const w = getWeeksInRange(desde, hasta);
      pares++;
      if (esLunes(hasta)) paresLunes++;

      if (!falloSpan && diasPintados(w) !== largo) {
        falloSpan = `${desde}→${hasta}: pintó ${diasPintados(w)} de ${largo}`;
      }
      if (!falloBordes && (w.length === 0 || w[0].start !== desde || ultima(w).end !== hasta)) {
        falloBordes = `${desde}→${hasta}: ${JSON.stringify([w[0], ultima(w)])}`;
      }
      for (let k = 0; k < w.length; k++) {
        if (!falloContigua && k > 0 && addDaysISO(w[k - 1].end, 1) !== w[k].start) {
          falloContigua = `${desde}→${hasta} en la semana ${k + 1}: ${w[k - 1].end} → ${w[k].start}`;
        }
        const dias = spanDias(w[k].start, w[k].end);
        if (!falloTamano && (dias < 1 || dias > 7)) {
          falloTamano = `${desde}→${hasta} en la semana ${k + 1}: ${dias} días`;
        }
        if (!falloNumero && w[k].weekNumber !== k + 1) {
          falloNumero = `${desde}→${hasta} en la posición ${k}: weekNumber ${w[k].weekNumber}`;
        }
        if (!falloLunes && k > 0 && !esLunes(w[k].start)) {
          falloLunes = `${desde}→${hasta} en la semana ${k + 1}: ${w[k].start} no es lunes`;
        }
      }
    }
  }

  console.log(
    `  · ${pares.toLocaleString('es')} pares evaluados, ${paresLunes.toLocaleString('es')} terminan en lunes`
  );
  check('los días pintados siempre igualan el span del rango', falloSpan === '', falloSpan);
  check(
    'la primera semana empieza en el inicio y la última acaba en el fin',
    falloBordes === '',
    falloBordes
  );
  check('las semanas son contiguas, sin huecos ni solapes', falloContigua === '', falloContigua);
  check('ninguna semana mide menos de 1 ni más de 7 días', falloTamano === '', falloTamano);
  check('weekNumber coincide con la posición en el array', falloNumero === '', falloNumero);
  check('todas las semanas menos la primera empiezan en lunes', falloLunes === '', falloLunes);
  // Si alguien recorta la ventana del barrido, el bug del lunes quedaría sin
  // cubrir sin que ningún test se pusiera rojo. Este check lo impide.
  check(
    'el barrido cubre más de 5.000 rangos que terminan en lunes',
    paresLunes > 5_000,
    String(paresLunes)
  );
}

// ════════════════════════════════════════════════════════════
seccion('Entradas inválidas: [] sin colgarse');
// ════════════════════════════════════════════════════════════

// 'all' es el valor real del preset "Máximo" antes de que _actions.ts lo
// sustituya por '2020-01-01'. El bucle avanza con `addDaysISO`, que devuelve
// intacto lo que no reconoce: sin el guard, esto sería un bucle infinito.
const invalidas = ['all', '', 'xx', '2026-02-31', '2026-13-01', '2026-8-1', '2026-08-1'];
for (const mala of invalidas) {
  let salida: Semana[] | null = null;
  let lanzo = false;
  try {
    salida = getWeeksInRange(mala, '2026-08-10');
  } catch {
    lanzo = true;
  }
  check(
    `'${mala}' como inicio devuelve [] sin lanzar`,
    !lanzo && Array.isArray(salida) && salida.length === 0,
    lanzo ? 'lanzó' : JSON.stringify(salida)
  );

  let salidaFin: Semana[] | null = null;
  let lanzoFin = false;
  try {
    salidaFin = getWeeksInRange('2026-08-01', mala);
  } catch {
    lanzoFin = true;
  }
  check(
    `'${mala}' como fin devuelve [] sin lanzar`,
    !lanzoFin && Array.isArray(salidaFin) && salidaFin.length === 0,
    lanzoFin ? 'lanzó' : JSON.stringify(salidaFin)
  );
}

// ════════════════════════════════════════════════════════════
seccion('getMonthWeeks');
// ════════════════════════════════════════════════════════════

// Literales explícitos: es lo que detectaría una regresión a
// `new Date(year, month - 1, 1)` en un runtime con otra zona horaria.
const mesesConNombre: [number, number, number, string, string][] = [
  [2026, 8, 31, '2026-08-01', '2026-08-31'], // acaba en lunes: era el mes que perdía un día
  [2028, 2, 29, '2028-02-01', '2028-02-29'], // bisiesto
  [2026, 2, 28, '2026-02-01', '2026-02-28'], // 2026 no es bisiesto
  [2026, 12, 31, '2026-12-01', '2026-12-31'], // desborde a enero del año siguiente
  [2026, 1, 31, '2026-01-01', '2026-01-31'],
];
for (const [y, m, dias, primero, ultimo] of mesesConNombre) {
  const w = getMonthWeeks(y, m);
  const fin = ultima(w)?.end;
  check(
    `getMonthWeeks(${y}, ${m}) → ${dias} días, ${primero}…${ultimo}`,
    diasPintados(w) === dias && w[0]?.start === primero && fin === ultimo,
    `${diasPintados(w)} días, ${w[0]?.start}…${fin}`
  );
}

// Los 12 meses de un año normal y de uno bisiesto.
const diasDelMes = (y: number, m: number) =>
  Math.round(
    (Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - Date.UTC(y, m - 1, 1)) / 86_400_000
  );

for (const y of [2026, 2028]) {
  let fallo = '';
  for (let m = 1; m <= 12; m++) {
    const w = getMonthWeeks(y, m);
    const dias = diasDelMes(y, m);
    const primero = `${y}-${String(m).padStart(2, '0')}-01`;
    const ultimoDia = addDaysISO(primero, dias - 1);
    if (
      !fallo &&
      (diasPintados(w) !== dias || w[0]?.start !== primero || ultima(w)?.end !== ultimoDia)
    ) {
      fallo = `${y}-${m}: ${diasPintados(w)}/${dias} días, ${w[0]?.start}…${ultima(w)?.end}`;
    }
  }
  check(`los 12 meses de ${y} cubren el mes completo`, fallo === '', fallo);
}

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log(
  `\n${fallidas === 0 ? '✅' : '❌'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas\n`
);
process.exit(fallidas === 0 ? 0 : 1);
