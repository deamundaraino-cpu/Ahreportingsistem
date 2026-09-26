/**
 * El enlace público de un informe no puede listar lo que el informe no enseña.
 *
 * Hasta la auditoría del 2026-09-26, con el token de un informe compartido se
 * podía pedir `dimension=field:email` y recibir los correos de los leads con su
 * recuento. `motivoConsultaNoPermitida` (src/lib/report-utm/bi/public-allowlist.ts)
 * exige que toda dimensión o filtro sobre un valor de formulario salga del propio
 * informe. Puro, sin base de datos.
 *
 *   npx tsx --conditions=react-server scripts/verify-bi-publico-seguridad.ts
 */

import { motivoConsultaNoPermitida, cadenasDe } from '../src/lib/report-utm/bi/public-allowlist';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const informe = {
  layout: [
    {
      type: 'table',
      config: { dimension: 'leadfield:rango_de_ingresos', metrics: ['leads_count'] },
    },
    {
      type: 'section',
      children: [{ type: 'slicer', config: { dimension: 'field:ciudad' } }],
    },
    { type: 'bar', config: { dimension: 'utm_campaign', dimension2: 'sheetdim:calidad' } },
  ],
  filters: {
    __adv: JSON.stringify({
      groups: [{ conditions: [{ field: 'leadfield:pie_disponible', op: 'eq', value: 'x' }] }],
    }),
  },
};

console.log('\n── Lo que el informe enseña se puede pedir');
check(
  'la dimensión de su tabla',
  motivoConsultaNoPermitida({ dimension: 'leadfield:rango_de_ingresos' }, informe) === null
);
check(
  'la de un slicer dentro de una sección',
  motivoConsultaNoPermitida({ dimension: 'field:ciudad' }, informe) === null
);
check(
  'su dimensión secundaria de Sheet',
  motivoConsultaNoPermitida(
    { dimension: 'utm_campaign', dimension2: 'sheetdim:calidad' },
    informe
  ) === null
);
check(
  'el filtro por el valor de su slicer (drill-down)',
  motivoConsultaNoPermitida(
    { dimension: 'none', filters: { 'field:ciudad': 'Bogotá' } },
    informe
  ) === null
);
check(
  'un campo del filtro avanzado GUARDADO (viaja serializado)',
  motivoConsultaNoPermitida(
    { advancedFilter: { groups: [{ conditions: [{ field: 'leadfield:pie_disponible' }] }] } },
    informe
  ) === null
);
check(
  'none y date siempre',
  motivoConsultaNoPermitida({ dimension: 'date', dimension2: 'none' }, informe) === null
);
check(
  'una columna fija aunque no esté guardada (la tabla pide utm_source por defecto)',
  motivoConsultaNoPermitida({ dimension: 'utm_source' }, informe) === null
);

console.log('\n── Lo que no enseña, no');
check(
  'dimension=field:email',
  motivoConsultaNoPermitida({ dimension: 'field:email' }, informe) !== null
);
check(
  'dimension2=field:telefono',
  motivoConsultaNoPermitida({ dimension: 'date', dimension2: 'field:telefono' }, informe) !== null
);
check(
  'un campo de lead que el informe no usa',
  motivoConsultaNoPermitida({ dimension: 'leadfield:otro' }, informe) !== null
);
check(
  'un filtro plano por un valor escrito (oráculo de correos)',
  motivoConsultaNoPermitida({ filters: { 'field:email': 'contains:@gmail' } }, informe) !== null
);
check(
  'una condición avanzada nueva sobre field:',
  motivoConsultaNoPermitida(
    { advancedFilter: { groups: [{ conditions: [{ field: 'field:email' }] }] } },
    informe
  ) !== null
);
check(
  'una dimensión de Sheet no usada',
  motivoConsultaNoPermitida({ dimension: 'sheetdim:telefono' }, informe) !== null
);

console.log('\n── cadenasDe');
check(
  'recoge claves y valores anidados',
  cadenasDe({ a: [{ b: 'x' }] }).has('x') && cadenasDe({ a: 1 }).has('a')
);

console.log(
  fallos === 0
    ? '\n✅ Seguridad del informe público: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`
);
process.exit(fallos === 0 ? 0 : 1);
