/**
 * Conversiones personalizadas de Meta: de la API de Meta al informe.
 *
 * Todo PURO: sin base de datos ni red (los `fetch` y el cliente de Supabase son
 * simulados). Protege lo que se arregló en la auditoría del 2026-09-28:
 *
 *   1. Las conversiones personalizadas (`offsite_conversion.custom.<id>`) solo
 *      llegan en `actions`; leer solo `conversions` las perdía todas.
 *   2. El nombre real (CC) o el del evento con sus mayúsculas, no «Lead …».
 *   3. `/customconversions` se pagina y `last_seen` no retrocede.
 *   4. `ads_daily` SUMA `eventos.custom` cuando una entidad se repite en el día.
 *   5. En el BI viajan con el gasto: alias de fórmula `mcc__`, fila Total,
 *      desglose por anuncio y resultados personalizados (null sin marcar).
 *   6. En los reportes clásicos, la macro por cliente `meta_resultados_custom`.
 *
 *   npx tsx --conditions=react-server scripts/verify-conversiones-meta.ts
 */

import {
  aliasFormulaCc,
  claveDeAccion,
  claveValidaEnFormula,
  conversionActiva,
  dobleConteo,
  etiquetaEfectiva,
  eventosDeRegla,
  extraerConversionesPersonalizadas,
  inferirTipo,
  resolverClaveCc,
} from '../src/lib/meta/conversiones-personalizadas';
import {
  acumularDescubiertas,
  descubrirConversiones,
  filasCatalogo,
  guardarCatalogo,
  listarCustomConversions,
  type ConversionDescubierta,
} from '../src/lib/meta/conversiones-personalizadas-sync';
import { cuentasMetaDe } from '../src/lib/meta/cuentas';
import { motivoReferenciaConversion } from '../src/lib/meta/conversiones-referencias';
import { expandirFila } from '../src/lib/ads/ads-daily-writer';
import {
  pideConversiones,
  planConversiones,
  sumarConversiones,
  valoresConversiones,
} from '../src/lib/report-utm/bi/meta-custom-conv';
import {
  basesAditivasDeFormula,
  extractMetaCcAliases,
  isAdditiveMetric,
  metricCrossesDimension,
  METRIC_META,
} from '../src/lib/report-utm/bi-metadata';
import {
  buildAvailableMetrics,
  conversionesOfrecidas,
  macrosConversionesMeta,
} from '../src/lib/dashboard/metric-catalog';
import { aggregateFormula, MACRO_MAP, SEMANTIC_ALIASES } from '../src/lib/formula-engine';
import { salir } from './_salida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
const seccion = (t: string) => console.log(`\n${t}`);

async function main() {
  // ════════════════════════════════════════════════════════════════
  seccion('1. Lectura de actions + conversions');
  // ════════════════════════════════════════════════════════════════
  check(
    'CC: clave = id',
    claveDeAccion('offsite_conversion.custom.2062935451264673')?.key === '2062935451264673' &&
      claveDeAccion('offsite_conversion.custom.2062935451264673')?.origen === 'cc'
  );
  const ev = claveDeAccion('offsite_conversion.fb_pixel_custom.LEAD_DOCENCIAU');
  check(
    'evento: clave en minúsculas, original conservado',
    ev?.key === 'lead_docenciau' && ev.original === 'LEAD_DOCENCIAU' && ev.origen === 'evento'
  );
  check(
    'el agregado sin sufijo no es una conversión',
    claveDeAccion('offsite_conversion.fb_pixel_custom') === null
  );
  check('una acción estándar no es una conversión', claveDeAccion('lead') === null);

  // Forma real de la API (Eduversio, 2026-09): la CC solo en actions, el evento
  // solo en conversions.
  const actions = [
    { action_type: 'offsite_conversion.fb_pixel_custom', value: '45768' },
    { action_type: 'offsite_conversion.custom.2062935451264673', value: '1113' },
    { action_type: 'lead', value: '10' },
  ];
  const conversions = [
    { action_type: 'offsite_conversion.fb_pixel_custom.LEADTCC', value: '2739' },
    { action_type: 'offsite_conversion.fb_pixel_custom.leadtcc', value: '1' },
  ];
  const ex = extraerConversionesPersonalizadas(actions, conversions);
  check('la CC que solo viene en actions se guarda', ex.valores['2062935451264673'] === 1113);
  check('variantes de mayúsculas del mismo evento suman', ex.valores['leadtcc'] === 2740);
  check('el agregado no crea clave', !('' in ex.valores) && Object.keys(ex.valores).length === 2);
  const doble = extraerConversionesPersonalizadas(
    [{ action_type: 'offsite_conversion.custom.9', value: '5' }],
    [{ action_type: 'offsite_conversion.custom.9', value: '7' }]
  );
  check('la misma conversión en los dos arrays: máximo, no suma', doble.valores['9'] === 7);
  check(
    'sin arrays no revienta',
    Object.keys(extraerConversionesPersonalizadas(undefined, null).valores).length === 0
  );

  // ════════════════════════════════════════════════════════════════
  seccion('2. Nombres, tipo, alias');
  // ════════════════════════════════════════════════════════════════
  check(
    'manual > Meta > clave',
    etiquetaEfectiva({ label_manual: ' Mío ', nombre_meta: 'Meta', key: 'k' }) === 'Mío' &&
      etiquetaEfectiva({ label_manual: '', nombre_meta: 'Meta', key: 'k' }) === 'Meta' &&
      etiquetaEfectiva({ key: 'k' }) === 'k'
  );
  check('tipo por custom_event_type', inferirTipo('COMPLETE_REGISTRATION', 'x') === 'registro');
  check('tipo por nombre: agenda', inferirTipo(null, 'invitee_meeting_scheduled') === 'agenda');
  check('tipo por nombre: lead', inferirTipo('OTHER', 'LEAD_DOCENCIAU') === 'lead');
  check('tipo por defecto', inferirTipo(null, 'cyber_capi') === 'otro');
  check('alias saneado', aliasFormulaCc('lead -agenda-directa') === 'mcc__lead__agenda_directa');
  check(
    'resolverClaveCc: exacta, saneada y ambigua',
    resolverClaveCc('leadtcc', ['leadtcc']) === 'leadtcc' &&
      resolverClaveCc('lead__agenda_directa', ['lead -agenda-directa']) ===
        'lead -agenda-directa' &&
      resolverClaveCc('a_b', ['a b', 'a-b']) === null
  );
  check(
    'clave válida en fórmula',
    claveValidaEnFormula('lead_x') && !claveValidaEnFormula('lead -agenda-directa')
  );
  const regla = JSON.stringify({
    and: [{ event: { eq: 'LEAD_X' } }, { or: [{ URL: { i_contains: '/gracias' } }] }],
  });
  check('eventos de la regla', eventosDeRegla(regla).join() === 'LEAD_X');
  check(
    'doble conteo: CC basada en un evento también marcado',
    dobleConteo([
      { conversion_key: '1', origen: 'cc', regla, es_resultado: true },
      { conversion_key: 'lead_x', origen: 'evento', es_resultado: true },
    ]).length === 1 &&
      dobleConteo([
        { conversion_key: '1', origen: 'cc', regla, es_resultado: true },
        { conversion_key: 'lead_x', origen: 'evento', es_resultado: false },
      ]).length === 0
  );
  check(
    'actividad: 90 días',
    conversionActiva('2026-07-01', '2026-09-28') && !conversionActiva('2026-06-01', '2026-09-28')
  );
  check(
    'cuentasMetaDe deduplica y exige token',
    cuentasMetaDe({
      meta_token: 't',
      meta_accounts: [{ account_id: 'act_1' }, { account_id: '1' }, { account_id: '2' }],
    }).length === 2
  );

  // ════════════════════════════════════════════════════════════════
  seccion('3. Descubrimiento y catálogo');
  // ════════════════════════════════════════════════════════════════
  const acc = new Map<string, ConversionDescubierta>();
  acumularDescubiertas(acc, '2026-09-01', ex);
  acumularDescubiertas(
    acc,
    '2026-09-10',
    extraerConversionesPersonalizadas(
      [],
      [{ action_type: 'offsite_conversion.fb_pixel_custom.LEADTCC', value: '0' }]
    )
  );
  check(
    'un día a 0 no mueve la última actividad',
    acc.get('leadtcc')?.ultimaActividad === '2026-09-01'
  );

  // fetch simulado: insights por día + customconversions en DOS páginas.
  const llamadas: string[] = [];
  const fetcher = async (u: string) => {
    llamadas.push(u);
    const url = new URL(u);
    let body: unknown;
    if (url.pathname.endsWith('/insights')) {
      body = {
        data: [
          { date_start: '2026-09-20', actions, conversions },
          {
            date_start: '2026-09-25',
            actions: [{ action_type: 'offsite_conversion.custom.2062935451264673', value: '4' }],
          },
        ],
      };
    } else if (url.searchParams.get('after') === 'p2') {
      body = {
        data: [{ id: '2062935451264673', name: 'LEAD_GERENCIA', custom_event_type: 'OTHER' }],
      };
    } else {
      body = { data: [{ id: '1', name: 'Otra' }], paging: { next: `${u}&after=p2` } };
    }
    return { json: async () => body };
  };
  const cuentas = [{ account_id: '699518046118081', token: 't' }];
  const { descubiertas } = await descubrirConversiones(cuentas, '2026-09-01', '2026-09-28', {
    fetcher,
  });
  const cc = descubiertas.get('2062935451264673');
  check('descubre la CC desde actions', cc?.origen === 'cc');
  check('última actividad = último día con valor', cc?.ultimaActividad === '2026-09-25');
  check(
    'pide actions y la ventana de atribución fija',
    llamadas.some(
      (u) => /fields=actions%2Cconversions/.test(u) && /action_attribution_windows/.test(u)
    )
  );
  const ccs = await listarCustomConversions(cuentas, { fetcher });
  check(
    'customconversions paginado (2 páginas)',
    ccs.size === 2 && ccs.get('2062935451264673')?.name === 'LEAD_GERENCIA'
  );
  const filas = filasCatalogo(descubiertas, ccs);
  const fCc = filas.find((f) => f.conversion_key === '2062935451264673');
  const fEv = filas.find((f) => f.conversion_key === 'leadtcc');
  check('CC con su nombre real', fCc?.nombre_meta === 'LEAD_GERENCIA' && fCc.origen === 'cc');
  check('evento con sus mayúsculas', fEv?.nombre_meta === 'LEADTCC' && fEv.tipo === 'lead');
  check('ya no se inventa «Lead …»', !filas.some((f) => /^Lead /.test(f.nombre_meta)));

  // guardarCatalogo sin la migración 096: la RPC no existe → upsert antiguo.
  const escrito: unknown[] = [];
  const dbFalsa = {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [{ conversion_key: 'leadtcc', last_seen: '2026-09-27' }] }),
      }),
      upsert: async (rows: unknown[]) => {
        escrito.push(...rows);
        return { error: null };
      },
    }),
    rpc: async () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }),
  };
  const r = await guardarCatalogo(dbFalsa, 'cli', filas, '2026-09-28');
  const leadtcc = escrito.find(
    (x) => (x as { conversion_key: string }).conversion_key === 'leadtcc'
  ) as { last_seen: string; label: string } | undefined;
  check('sin la 096 cae al upsert antiguo', r.error === null && escrito.length === filas.length);
  check('last_seen no retrocede', leadtcc?.last_seen === '2026-09-27');
  check('la etiqueta antigua es la efectiva', leadtcc?.label === 'LEADTCC');
  check('cuenta las nuevas', r.nuevas === filas.length - 1);

  // ════════════════════════════════════════════════════════════════
  seccion('4. ads_daily: una entidad repetida en el día');
  // ════════════════════════════════════════════════════════════════
  const exp = expandirFila(
    {
      cliente_id: 'c',
      fecha: '2026-09-20',
      meta_campaigns: [
        { campaign_id: '1', name: 'A', spend: 10, custom_conversions: { x: 2, y: 1 } },
        { campaign_id: '1', name: 'A', spend: 5, custom_conversions: { x: 3 } },
      ],
    } as never,
    { hoy: '2026-09-28' }
  );
  const custom = (exp[0]?.eventos as { custom?: Record<string, number> })?.custom;
  check(
    'suma eventos.custom clave a clave',
    custom?.x === 5 && custom?.y === 1,
    JSON.stringify(custom)
  );

  // ════════════════════════════════════════════════════════════════
  seccion('5. BI: petición, acumulación y emisión');
  // ════════════════════════════════════════════════════════════════
  const pedido = pideConversiones({
    metrics: ['metacc:leadtcc', 'resultados_custom'],
    calculated: [{ expression: 'spend / mcc__lead__agenda_directa' }],
  });
  check(
    'detecta token, alias y resultados',
    pedido.tokens.length === 1 &&
      pedido.aliases.join() === 'mcc__lead__agenda_directa' &&
      pedido.resultados
  );
  const catalogo = [
    { conversion_key: 'leadtcc', es_resultado: true },
    { conversion_key: 'lead -agenda-directa', es_resultado: false },
    { conversion_key: '777', es_resultado: true },
  ];
  const plan = planConversiones(pedido, catalogo)!;
  check(
    'el alias saneado resuelve a la clave real',
    plan.salidas.find((s) => s.out === 'mcc__lead__agenda_directa')?.key === 'lead -agenda-directa'
  );
  check('acumula las pedidas y las de resultado', plan.claves.length === 3);
  const entry: Record<string, number> = {};
  sumarConversiones(entry, { leadtcc: 4, '777': 1, 'lead -agenda-directa': 2 }, plan.claves);
  sumarConversiones(entry, { leadtcc: 6 }, plan.claves);
  sumarConversiones(entry, null, plan.claves);
  const v = valoresConversiones(entry, plan, 110);
  check('valor del token', v.valores['metacc:leadtcc'] === 10);
  check('valor del alias (para fórmulas)', v.valores['mcc__lead__agenda_directa'] === 2);
  check('resultados = suma de marcadas', v.resultados === 11);
  check('coste = gasto Meta ÷ resultados', v.coste === 10);
  const sinMarcar = planConversiones({ tokens: [], aliases: [], resultados: true }, [
    { conversion_key: 'a', es_resultado: false },
  ]);
  check(
    'sin marcadas: resultados y coste null, no 0',
    valoresConversiones({}, sinMarcar, 100).resultados === null &&
      valoresConversiones({}, sinMarcar, 100).coste === null
  );
  check(
    'con resultados a 0: coste null',
    valoresConversiones(
      {},
      planConversiones({ tokens: [], aliases: [], resultados: true }, catalogo),
      50
    ).coste === null
  );
  check(
    'nada pedido: sin plan',
    planConversiones({ tokens: [], aliases: [], resultados: false }, catalogo) === null
  );
  check('metacc es aditiva (fila Total)', isAdditiveMetric('metacc:leadtcc'));
  check('resultados_custom es aditiva', isAdditiveMetric('resultados_custom'));
  check('coste por resultado no es aditivo', !isAdditiveMetric('coste_por_resultado_custom'));
  check(
    'metacc se desglosa por anuncio y conjunto, no por país',
    metricCrossesDimension('metacc:x', 'ad') &&
      metricCrossesDimension('metacc:x', 'adset') &&
      metricCrossesDimension('metacc:x', 'date') &&
      !metricCrossesDimension('metacc:x', 'ip_country')
  );
  check('alias extraídos', extractMetaCcAliases('spend / mcc__lead_x + mcc__y').length === 2);
  check(
    'spend / mcc__x totaliza con sus bases',
    basesAditivasDeFormula('spend / mcc__lead_x')?.get('mcc__lead_x') === 'metacc:lead_x'
  );
  check(
    'métricas nuevas en el catálogo',
    !!METRIC_META.resultados_custom && !!METRIC_META.coste_por_resultado_custom
  );

  // ════════════════════════════════════════════════════════════════
  seccion('6. Referencias por token exacto');
  // ════════════════════════════════════════════════════════════════
  check('metacc exacto', motivoReferenciaConversion('["metacc:lead"]', 'lead') !== null);
  check(
    'no confunde prefijos',
    motivoReferenciaConversion('["metacc:lead_webinar"]', 'lead') === null
  );
  check('alias en fórmula', motivoReferenciaConversion('"spend / mcc__lead"', 'lead') !== null);
  check(
    'meta_custom_ exacto',
    motivoReferenciaConversion('meta_spend / meta_custom_lead', 'lead') !== null &&
      motivoReferenciaConversion('meta_custom_lead_x', 'lead') === null
  );

  // ════════════════════════════════════════════════════════════════
  seccion('7. Reportes clásicos');
  // ════════════════════════════════════════════════════════════════
  const cat = [
    {
      conversion_key: 'leadtcc',
      label: 'LEADTCC',
      field_id: 'meta_custom_leadtcc',
      es_resultado: true,
      ultima_actividad: '2026-09-20',
    },
    {
      conversion_key: 'lead_aba',
      label: 'ABA',
      field_id: 'meta_custom_lead_aba',
      es_resultado: true,
      ultima_actividad: '2026-09-20',
    },
    {
      conversion_key: 'lead -agenda-directa',
      label: 'Agenda',
      field_id: 'meta_custom_lead -agenda-directa',
      es_resultado: true,
    },
    {
      conversion_key: 'vieja',
      label: 'Vieja',
      field_id: 'meta_custom_vieja',
      ultima_actividad: '2025-01-01',
    },
    {
      conversion_key: 'usada',
      label: 'Usada',
      field_id: 'meta_custom_usada',
      ultima_actividad: '2025-01-01',
    },
    {
      conversion_key: 'arch',
      label: 'Arch',
      field_id: 'meta_custom_arch',
      archivada: true,
      ultima_actividad: '2026-09-20',
    },
  ];
  const macros = macrosConversionesMeta(cat);
  check(
    'macro = suma de las marcadas válidas',
    macros.meta_resultados_custom === '(meta_custom_leadtcc + meta_custom_lead_aba)',
    macros.meta_resultados_custom
  );
  check('sin marcadas no hay macro', Object.keys(macrosConversionesMeta([cat[3]])).length === 0);
  const ofrecidas = conversionesOfrecidas(cat, '{"formula":"meta_custom_usada"}', '2026-09-28').map(
    (c) => c.conversion_key
  );
  check(
    'selectores: activas, marcadas y en uso; no antiguas ni archivadas',
    ofrecidas.includes('leadtcc') &&
      ofrecidas.includes('usada') &&
      !ofrecidas.includes('vieja') &&
      !ofrecidas.includes('arch'),
    ofrecidas.join(',')
  );
  const opciones = buildAvailableMetrics(cat).map((o) => o.id);
  check(
    'opciones fijas de resultados personalizados',
    opciones.includes('meta_resultados_custom') && opciones.includes('meta_cost_per_result_custom')
  );
  const filasDash = [
    { fecha: '2026-09-20', meta_spend: 100, meta_custom_leadtcc: 3, meta_custom_lead_aba: 2 },
    { fecha: '2026-09-21', meta_spend: 50, meta_custom_leadtcc: 5 },
  ];
  const plataformas = new Set(['meta']);
  check(
    'meta_resultados_custom con la macro del cliente',
    aggregateFormula('meta_resultados_custom', filasDash, {}, {}, plataformas, macros) === 10
  );
  check(
    'coste por resultado personalizado',
    aggregateFormula('meta_cost_per_result_custom', filasDash, {}, {}, plataformas, macros) === 15
  );
  check(
    'sin conversiones marcadas: «–» (null), no 0',
    aggregateFormula('meta_resultados_custom', filasDash, {}, {}, plataformas, {}) === null
  );
  check(
    'macro fija del coste',
    MACRO_MAP.meta_cost_per_result_custom === 'meta_spend / meta_resultados_custom'
  );
  check(
    '$conversiones ofrece los resultados personalizados',
    SEMANTIC_ALIASES.$conversiones.options.some((o) => o.value === 'meta_resultados_custom')
  );
}

main()
  .then(() => {
    console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} comprobaciones fallan`);
    salir(fallos);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
