/**
 * Comprobaciones de la ingesta de TikTok Lead Generation → `report_utm.lead_events`
 * y del troceo de rangos de 30 días de los informes de TikTok.
 *
 * Todo lo que decide la fila es puro: no hay Postgres ni red en este archivo.
 * El CSV reproduce la forma de una descarga de `/page/lead/task/download/`:
 * cabeceras de estructura + preguntas del formulario, con una respuesta que
 * lleva coma y salto de línea, IDs protegidos de Excel y un lead de prueba.
 *
 *   npx tsx --conditions=react-server scripts/verify-tiktok-leads.ts
 */

import {
  parseCsv,
  normalizarCabecera,
  leadsDesdeCsv,
  limpiarId,
  parseTikTokTime,
  synthesizeTikTokUtms,
  buildTikTokLeadRow,
  cuentasConLeadsTikTok,
  errorTikTok,
  TIKTOK_EXTERNAL_PREFIX,
  TIKTOK_SOURCE,
} from '../src/lib/report-utm/tiktok-leads';
import { trocearRangoDias, TIKTOK_MAX_DIAS_INFORME } from '../src/lib/tiktok/rangos';
import {
  interpretarInfoCuenta,
  tiktokInfoCuenta,
  _olvidarInfoCuentas,
} from '../src/lib/tiktok/cuenta';
import { adaptarIds } from '../src/lib/report-utm/lead-ids';
import { aplicarExclusion, REGLA_VACIA } from '../src/lib/report-utm/lead-exclusion';
import { PLUGIN_LABELS } from '../src/lib/report-utm/leads-display';
import { CLAVES_SOLO_SERVIDOR } from '../src/lib/clientes/config-pestanas';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const CLIENTE = '11111111-1111-1111-1111-111111111111';

const CSV = [
  '﻿lead_id,created_time,ad_id,ad_name,adgroup_id,adgroup_name,campaign_id,campaign_name,page_id,page_name,is_test,Name,Email,Phone number,¿Cuál es tu presupuesto?,Comentarios',
  `7412345678901234567,2026-09-20 14:03:11,'1809876543210987,Video UGC 1,1809876543210000,Conjunto LAL,="1809876543200000",Captación Septiembre,7400000000000000001,Form Renta Corta,false,Ana Pérez,ana@example.com,+56911112222,"entre $2.000.000 y $4.000.000","Hola, quiero info`,
  `sobre el curso"`,
  '7412345678901234568,1758376800,1809876543210988,Video UGC 2,1809876543210000,Conjunto LAL,1809876543200000,Captación Septiembre,,,true,Test Lead,test@example.com,,menos de $1.000.000,',
  ',2026-09-21 10:00:00,1,x,1,x,1,x,,,false,Sin ID,,,,',
].join('\r\n');

console.log('\nCSV');
{
  const filas = parseCsv(CSV);
  check('4 filas (cabecera + 3), el salto dentro de comillas no parte la fila', filas.length === 4);
  check('BOM fuera de la primera cabecera', filas[0][0] === 'lead_id');
  check(
    'campo con coma y salto de línea intacto',
    filas[1][15] === 'Hola, quiero info\r\nsobre el curso',
    JSON.stringify(filas[1][15])
  );
  check('comillas escapadas', parseCsv('a\n"di ""hola"""')[1][0] === 'di "hola"');
  check('normalizarCabecera', normalizarCabecera(' Ad Group Name ') === 'ad_group_name');
  check('normalizarCabecera quita tildes', normalizarCabecera('Teléfono') === 'telefono');
  check('limpiarId apóstrofo', limpiarId("'1809876543210987") === '1809876543210987');
  check('limpiarId fórmula', limpiarId('="1809876543200000"') === '1809876543200000');
  check('limpiarId guion → null', limpiarId('--') === null);
}

const FORM = {
  page_id: '7400000000000000009',
  name: 'Form fallback',
  advertiser_id: '7387511059776798737',
};
const leads = leadsDesdeCsv(CSV, FORM);
console.log('\nleadsDesdeCsv');
{
  check('descarta la fila sin lead_id', leads.length === 2, String(leads.length));
  const [a, b] = leads;
  check('ad_id limpio', a.ad_id === '1809876543210987');
  check('campaign_id limpio', a.campaign_id === '1809876543200000');
  check(
    'form del CSV cuando viene',
    a.form_id === '7400000000000000001' && a.form_name === 'Form Renta Corta'
  );
  check(
    'form de respaldo cuando la columna va vacía',
    b.form_id === FORM.page_id && b.form_name === 'Form fallback'
  );
  check('advertiser de respaldo', a.advertiser_id === FORM.advertiser_id);
  check('lead de prueba marcado', a.is_test === false && b.is_test === true);
  check(
    'respuestas sin columnas de estructura',
    Object.keys(a.campos).join('|') ===
      'Name|Email|Phone number|¿Cuál es tu presupuesto?|Comentarios',
    Object.keys(a.campos).join('|')
  );
  let lanzo = false;
  try {
    leadsDesdeCsv('foo,bar\n1,2');
  } catch (e) {
    lanzo = /sin columna de ID/.test(String((e as Error).message));
  }
  check('CSV sin columna de ID → error claro', lanzo);
  const alias = leadsDesdeCsv(
    'Lead ID,Create Time,Ad Group ID,Ad Group Name\n7412345678901234599,2026-09-22T05:00:00Z,1809876543210001,LAL 2'
  );
  check(
    'alias con espacios (Lead ID, Ad Group ID)',
    alias[0]?.lead_id === '7412345678901234599' &&
      alias[0]?.adgroup_id === '1809876543210001' &&
      alias[0]?.adgroup_name === 'LAL 2'
  );
}

console.log('\nFechas');
{
  check('sin zona → UTC', parseTikTokTime('2026-09-20 14:03:11') === '2026-09-20T14:03:11.000Z');
  check(
    'epoch segundos',
    parseTikTokTime('1758376800') === new Date(1758376800 * 1000).toISOString()
  );
  check('epoch ms', parseTikTokTime('1758376800000') === new Date(1758376800000).toISOString());
  check(
    'ISO con zona respetada',
    parseTikTokTime('2026-09-20T09:00:00-05:00') === '2026-09-20T14:00:00.000Z'
  );
  check('basura → null', parseTikTokTime('ayer') === null && parseTikTokTime('') === null);
}

console.log('\nUTMs sintetizadas');
{
  const u = synthesizeTikTokUtms(leads[0]);
  check('utm_source tiktok', u.utm_source === 'tiktok');
  check('utm_medium paid_social', u.utm_medium === 'paid_social');
  check('utm_campaign = nombre de campaña', u.utm_campaign === 'Captación Septiembre');
  check('utm_content = nombre del anuncio', u.utm_content === 'Video UGC 1');
  check('utm_term = nombre del conjunto', u.utm_term === 'Conjunto LAL');
  check('utm_id = campaign_id', u.utm_id === '1809876543200000');
}

console.log('\nFila de lead_events');
{
  const row = buildTikTokLeadRow(CLIENTE, leads[0]);
  check(
    'external_id con prefijo',
    row.external_id === `${TIKTOK_EXTERNAL_PREFIX}7412345678901234567`
  );
  check('external_id = tiktok:<lead_id>', String(row.external_id) === 'tiktok:7412345678901234567');
  check(
    'source y form_plugin',
    row.source === TIKTOK_SOURCE && row.form_plugin === 'tiktok_lead_ads'
  );
  check('created_at del lead (UTC)', row.created_at === '2026-09-20T14:03:11.000Z');
  check(
    'IDs publicitarios',
    row.campaign_id === '1809876543200000' &&
      row.adset_id === '1809876543210000' &&
      row.ad_id === '1809876543210987'
  );
  check(
    'contacto',
    row.lead_name === 'Ana Pérez' &&
      row.lead_email === 'ana@example.com' &&
      row.lead_phone === '+56911112222'
  );
  const raw = row.raw_fields as Record<string, string>;
  check(
    'respuesta en raw_fields con su cabecera',
    raw['¿Cuál es tu presupuesto?'] === 'entre $2.000.000 y $4.000.000'
  );
  check('attribution utm_only', row.attribution_method === 'utm_only');
  check('form_id', row.form_id === '7400000000000000001');
  check('sin click_id', row.click_id === null);

  const sinIds = adaptarIds(row, false);
  check(
    'adaptarIds quita los IDs sin la 082',
    !('ad_id' in sinIds) && !('campaign_id' in sinIds) && sinIds.utm_id === '1809876543200000'
  );
  check('regla vacía no marca', !('excluido' in aplicarExclusion(row, REGLA_VACIA)));

  const sinFecha = buildTikTokLeadRow(CLIENTE, { lead_id: '1', campos: {} });
  check('sin fecha no inventa created_at', !('created_at' in sinFecha));
  const idCorto = buildTikTokLeadRow(CLIENTE, { lead_id: '2', ad_id: '2026', campos: {} });
  check('un «ID» de 4 dígitos no pasa por ID', idCorto.ad_id === null);
}

console.log('\nActivación por flag');
{
  const cfg = {
    tiktok_access_token: 'tok',
    tiktok_accounts: [
      { advertiser_id: '111', tiktok_leads: true },
      { advertiser_id: '222' },
      { advertiser_id: '111', tiktok_leads: true },
      { advertiser_id: '333', access_token: 'propio', tiktok_leads: true, lead_region: 'eu' },
    ],
  };
  const c = cuentasConLeadsTikTok(cfg);
  check(
    'solo las marcadas y sin duplicados',
    c.map((x) => x.advertiser_id).join(',') === '111,333'
  );
  check('token propio o compartido', c[0].token === 'tok' && c[1].token === 'propio');
  check('lead_region', c[1].lead_region === 'eu' && c[0].lead_region === null);
  check(
    'flag en la raíz activa todas',
    cuentasConLeadsTikTok({ ...cfg, tiktok_leads: true }).length === 3
  );
  check(
    'legacy de una cuenta',
    cuentasConLeadsTikTok({
      tiktok_access_token: 't',
      tiktok_advertiser_id: '9',
      tiktok_leads: true,
    })[0]?.advertiser_id === '9'
  );
  check(
    'sin flag, nada',
    cuentasConLeadsTikTok({ tiktok_accounts: [{ advertiser_id: '1', access_token: 'x' }] })
      .length === 0
  );
  check(
    'error de permisos explica el alcance',
    /Lead management/.test(errorTikTok('x', { code: 40001, message: 'No permission' }).message)
  );
  check('etiqueta del plugin', PLUGIN_LABELS.tiktok_lead_ads === 'TikTok Lead Ads');
}

console.log('\nTroceo de rangos (≤30 días)');
{
  const v = trocearRangoDias('2026-05-31', '2026-09-28');
  const total = v.reduce(
    (s, x) => s + (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000 + 1,
    0
  );
  check('121 días → 5 ventanas', v.length === 5, JSON.stringify(v));
  check('cubre todos los días sin solapes', total === 121);
  check(
    'ninguna ventana pasa de 30',
    v.every(
      (x) => (Date.parse(x.end) - Date.parse(x.start)) / 86_400_000 + 1 <= TIKTOK_MAX_DIAS_INFORME
    )
  );
  check(
    'contiguas',
    v.every((x, i) => i === 0 || Date.parse(x.start) - Date.parse(v[i - 1].end) === 86_400_000)
  );
  check('extremos', v[0].start === '2026-05-31' && v[v.length - 1].end === '2026-09-28');
  check(
    'un día',
    JSON.stringify(trocearRangoDias('2026-09-01', '2026-09-01')) ===
      JSON.stringify([{ start: '2026-09-01', end: '2026-09-01' }])
  );
  check('exactamente 30 → 1 ventana', trocearRangoDias('2026-09-01', '2026-09-30').length === 1);
  check('31 → 2 ventanas', trocearRangoDias('2026-08-01', '2026-08-31').length === 2);
  check('al revés → []', trocearRangoDias('2026-09-02', '2026-09-01').length === 0);
  check('inválido → []', trocearRangoDias('x', '2026-09-01').length === 0);
}

async function infoCuenta() {
  console.log('\nInfo de cuenta (moneda / zona)');
  const i = interpretarInfoCuenta(
    {
      advertiser_id: '7387511059776798737',
      name: 'SR',
      currency: 'clp',
      timezone: 'America/Santiago',
      display_timezone: 'America/Santiago',
    },
    '2026-09-28T00:00:00.000Z'
  );
  check('moneda en mayúsculas', i.currency === 'CLP');
  check('zona', i.timezone === 'America/Santiago');
  check(
    'vacíos → null',
    interpretarInfoCuenta({ advertiser_id: '1', currency: '' }).currency === null
  );

  _olvidarInfoCuentas();
  let llamadas = 0;
  const fetchFalso = async (url: string) => {
    llamadas++;
    const u = new URL(url);
    const ok =
      u.pathname.endsWith('/advertiser/info/') &&
      JSON.parse(u.searchParams.get('advertiser_ids') ?? '[]')[0] === '42';
    return {
      json: async () =>
        ok
          ? {
              code: 0,
              data: { list: [{ advertiser_id: '42', currency: 'USD', timezone: 'Etc/GMT+5' }] },
            }
          : { code: 40001, message: 'no' },
    };
  };
  const r1 = await tiktokInfoCuenta('42', 'tok', { fetchImpl: fetchFalso });
  const r2 = await tiktokInfoCuenta('42', 'tok', { fetchImpl: fetchFalso });
  check('lee moneda y zona', r1?.currency === 'USD' && r1?.timezone === 'Etc/GMT+5');
  check('cacheado: una sola llamada', r2 === r1 && llamadas === 1);
  const r3 = await tiktokInfoCuenta('43', 'tok', { fetchImpl: fetchFalso });
  check('error de TikTok → null', r3 === null);
  check(
    'tiktok_cuentas_info solo la escribe el servidor',
    CLAVES_SOLO_SERVIDOR.includes('tiktok_cuentas_info')
  );
}

infoCuenta().then(() => {
  console.log(fallos === 0 ? '\nTodo OK' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
});
