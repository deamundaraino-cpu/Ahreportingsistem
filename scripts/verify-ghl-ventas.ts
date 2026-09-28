/**
 * Comprobaciones de las ventas de GoHighLevel (2026-09-28): atribución por
 * «último lead antes de la venta», fecha estable, estado vacío configurable y
 * reversión. Todo puro: ni Postgres ni red.
 *
 *   npx tsx --conditions=react-server scripts/verify-ghl-ventas.ts
 */

import {
  atribucionDesdeLead,
  coincideConContacto,
  debeRevertirPorSync,
  elegirUltimoLeadVenta,
  esMacroSinRellenar,
  esVentaGanada,
  esVentaRevertida,
  instanteVentaGhl,
  saleTimestampEstable,
  soloSenalMacro,
  vacioEsGanadaDe,
  METODO_VENTA_LEAD,
  type LeadVentaCandidato,
} from '../src/lib/report-utm/ghl-ventas-atribucion';
import { idVentaGhl, leerVentaGhl } from '../src/lib/report-utm/ghl-ventas';
import { payloadDeOportunidad } from '../src/lib/report-utm/ghl-oportunidades';
import { deriveUtms, deriveUtmsUltimoToque } from '../src/lib/report-utm/ghl-leads';
import { agruparVentasCrm } from '../src/lib/dashboard/ventas-crm';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function lead(
  p: Partial<LeadVentaCandidato> & { id: string; created_at: string }
): LeadVentaCandidato {
  return {
    external_id: null,
    lead_email: null,
    lead_phone: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    utm_id: null,
    ...p,
  };
}

const VENTA = Date.parse('2026-09-20T15:00:00Z');
const clave = { contactId: 'c1', email: ' Ana@Mail.com ', telefono: '+56 9 8765 4321' };

// ── 1. Último lead antes de la venta ──────────────────────────────────
console.log('\n1. Elección del lead');
const candidatos = [
  lead({
    id: 'viejo',
    created_at: '2026-08-01T00:00:00Z',
    external_id: 'ghl:c1',
    utm_campaign: 'Campaña A',
    campaign_id: '1200000000000001',
  }),
  lead({
    id: 'email',
    created_at: '2026-09-10T00:00:00Z',
    lead_email: 'ana@mail.com',
    utm_campaign: 'Campaña B',
    utm_id: '1200000000000002',
    ad_id: '1200000000000003',
  }),
  lead({
    id: 'despues',
    created_at: '2026-09-21T00:00:00Z',
    external_id: 'ghl:c1',
    utm_campaign: 'Campaña C',
  }),
  lead({
    id: 'otro',
    created_at: '2026-09-19T00:00:00Z',
    lead_email: 'otra@mail.com',
    utm_campaign: 'X',
  }),
];
let r = elegirUltimoLeadVenta(clave, VENTA, candidatos);
check('elige el último ANTERIOR a la venta (no el posterior)', r?.lead.id === 'email', r?.lead.id);
check('coincide por email normalizado', r?.via === 'email');
check('ignora leads de otro contacto', !candidatos.slice(3).some((l) => l.id === r?.lead.id));

r = elegirUltimoLeadVenta(clave, VENTA, [
  ...candidatos,
  lead({
    id: 'macro',
    created_at: '2026-09-15T00:00:00Z',
    lead_phone: '987654321',
    utm_campaign: '{{campaign.name}}',
    utm_id: '__CID__',
  }),
]);
check('salta el lead cuya única señal es una macro', r?.lead.id === 'email', r?.lead.id);

r = elegirUltimoLeadVenta(clave, VENTA, [
  ...candidatos,
  lead({
    id: 'tel',
    created_at: '2026-09-18T00:00:00Z',
    lead_phone: '(9) 8765-4321',
    utm_campaign: '{{campaign.name}}',
    campaign_id: '1200000000000009',
  }),
]);
check(
  'macro + ID real NO se salta; coincide por teléfono (9 dígitos)',
  r?.lead.id === 'tel' && r.via === 'telefono',
  r?.lead.id
);

r = elegirUltimoLeadVenta(clave, VENTA, [
  ...candidatos,
  lead({
    id: 'organico',
    created_at: '2026-09-19T12:00:00Z',
    external_id: 'ghl:c1',
    utm_source: 'instagram',
  }),
]);
check(
  'un lead orgánico posterior SÍ es el último toque',
  r?.lead.id === 'organico' && r.via === 'contacto'
);

r = elegirUltimoLeadVenta(clave, VENTA, [
  lead({
    id: 'reloj',
    created_at: '2026-09-20T15:03:00Z',
    external_id: 'ghl:c1',
    utm_campaign: 'Z',
  }),
]);
check('tolera unos minutos de desfase de reloj', r?.lead.id === 'reloj');
check(
  'fuera del lookback no cuenta',
  elegirUltimoLeadVenta(clave, VENTA, [
    lead({ id: 'x', created_at: '2024-01-01T00:00:00Z', external_id: 'ghl:c1' }),
  ]) === null
);
check(
  'sin coincidencias → null',
  elegirUltimoLeadVenta(clave, VENTA, candidatos.slice(3)) === null
);
check(
  'teléfono corto (<8 dígitos) no cruza',
  coincideConContacto(lead({ id: 't', created_at: '', lead_phone: '4321' }), {
    contactId: null,
    email: null,
    telefono: '4321',
  }) === null
);
check(
  'macros: {{…}}, __X__ y %x%',
  esMacroSinRellenar('{{ad.id}}') &&
    esMacroSinRellenar('__CAMPAIGN_ID__') &&
    esMacroSinRellenar('%campaign%')
);
check(
  'un nombre normal no es macro',
  !esMacroSinRellenar('Black Friday 2026') && !esMacroSinRellenar(null)
);
check('sin señal alguna no es «solo macro»', !soloSenalMacro(lead({ id: 's', created_at: '' })));

const a = atribucionDesdeLead(candidatos[1]);
check(
  'copia la tupla y los IDs del lead como bloque',
  a.utm_campaign === 'Campaña B' &&
    a.utm_id === '1200000000000002' &&
    a.ad_id === '1200000000000003' &&
    a.ad_campaign_id === null &&
    a.attribution_method === METODO_VENTA_LEAD
);

// ── 2. Respaldo sin lead: último toque como bloque ────────────────────
console.log('\n2. Último toque del contacto');
const contacto = {
  id: 'c1',
  attributionSource: { campaign: 'Primera', utmSource: 'facebook', adId: '111111111111' },
  lastAttributionSource: { utmSource: 'google', utmMedium: 'cpc', campaign: 'Última' },
};
const mezcla = deriveUtms(contacto);
const bloque = deriveUtmsUltimoToque(contacto);
check('deriveUtms (leads) sigue mezclando primer toque', mezcla.utm_campaign === 'Primera');
check(
  'el último toque NO arrastra campos del primero',
  bloque.utm_campaign === 'Última' && bloque.utm_source === 'google' && bloque.utm_id === null,
  JSON.stringify(bloque)
);
check(
  'sin lastAttributionSource usa el primero entero',
  deriveUtmsUltimoToque({ id: 'c2', attributionSource: { campaign: 'Solo' } }).utm_campaign ===
    'Solo'
);

// ── 3. Fecha de la venta ──────────────────────────────────────────────
console.log('\n3. sale_timestamp');
const opp = {
  lastStatusChangeAt: '2026-09-20T15:00:00.000Z',
  lastStageChangeAt: '2026-09-18T10:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
};
check('won → cambio de estado', instanteVentaGhl('won', [opp]) === '2026-09-20T15:00:00.000Z');
check(
  'sin estado (por etapa) → cambio de etapa',
  instanteVentaGhl(null, [opp]) === '2026-09-18T10:00:00.000Z'
);
check(
  'el payload manda sobre la oportunidad releída',
  instanteVentaGhl('won', [{ lastStatusChangeAt: '2026-09-21T00:00:00Z' }, opp]) ===
    '2026-09-21T00:00:00.000Z'
);
check('sin fechas → null', instanteVentaGhl('won', [null, {}]) === null);
check(
  'un reenvío conserva la fecha guardada',
  saleTimestampEstable('2026-09-20T15:00:00+00:00', '2026-09-28T00:00:00.000Z', 'ahora') ===
    '2026-09-20T15:00:00.000Z'
);
check(
  'primera vez usa la calculada',
  saleTimestampEstable(null, '2026-09-20T15:00:00.000Z', 'ahora') === '2026-09-20T15:00:00.000Z'
);
check('sin nada, la hora de llegada', saleTimestampEstable(undefined, null, 'ahora') === 'ahora');

// ── 4. Estado ─────────────────────────────────────────────────────────
console.log('\n4. Estado');
check('won es venta', esVentaGanada('won'));
check(
  'vacío es venta por defecto (compatibilidad)',
  esVentaGanada(null) && vacioEsGanadaDe(null) && vacioEsGanadaDe({})
);
check(
  'vacío NO es venta con el flag en false',
  !esVentaGanada(null, vacioEsGanadaDe({ ventas_estado_vacio_es_ganada: false }))
);
check(
  'lost/abandoned/open revierten',
  esVentaRevertida('lost') && esVentaRevertida('abandoned') && esVentaRevertida('open')
);
check('won y vacío no revierten', !esVentaRevertida('won') && !esVentaRevertida(null));

// ── 5. Reversión en el sync ───────────────────────────────────────────
console.log('\n5. Reversión (sync)');
check('sigue ganada → no', !debeRevertirPorSync('won', 'won'));
check('perdida → sí', debeRevertirPorSync('won', 'lost') && debeRevertirPorSync(null, 'abandoned'));
check('borrada (404) → sí', debeRevertirPorSync('won', null));
check('open tras un won explícito → sí', debeRevertirPorSync('won', 'open'));
check('open de una venta por ETAPA (sin estado) → no', !debeRevertirPorSync(null, 'open'));

// ── 6. Payload del sync = payload del webhook ─────────────────────────
console.log('\n6. Camino común');
const p = payloadDeOportunidad({
  id: 'o9',
  name: 'Asesoría',
  status: 'won',
  monetaryValue: 1500000,
  contactId: 'c9',
  lastStatusChangeAt: '2026-09-20T15:00:00.000Z',
  contact: { email: 'x@y.com', phone: '+56987654321' },
});
const v = leerVentaGhl(p);
check(
  'leerVentaGhl entiende la oportunidad del sync',
  v.oportunidadId === 'o9' &&
    v.contactId === 'c9' &&
    v.estado === 'won' &&
    v.importe === 1500000 &&
    v.email === 'x@y.com'
);
check('mismo platform_sale_id que el webhook', idVentaGhl(v) === 'ghl-opp:o9');
check(
  'la fecha del cierre viaja en el payload',
  instanteVentaGhl(v.estado, [v.fechas]) === '2026-09-20T15:00:00.000Z'
);

// ── 7. Dashboard fecha como el BI ─────────────────────────────────────
console.log('\n7. Dashboard');
const dias = agruparVentasCrm([
  { created_at: '2026-09-20T15:00:00Z', sale_timestamp: '2026-09-25T15:00:00Z', amount: 10 },
]);
check(
  'agrupa por created_at (criterio del BI)',
  dias.get('2026-09-20')?.ventas === 1 && !dias.has('2026-09-25')
);

console.log(fallos === 0 ? '\nTodo OK' : `\n${fallos} comprobación(es) fallida(s)`);
process.exit(fallos === 0 ? 0 : 1);
