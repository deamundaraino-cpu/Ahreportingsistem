/**
 * Comprobaciones del mapeo JSONB → `ads_daily` (`src/lib/ads/ads-daily-writer.ts`).
 *
 * Casi todo PURO. Al final hace dos comprobaciones contra el repo y la base que
 * protegen la invariante más peligrosa de la tabla.
 *
 * ── La invariante peligrosa ──────────────────────────────────────────────
 * `ads_daily` guarda UNA FILA POR NIVEL (campaña, conjunto, anuncio) porque los
 * niveles de Meta no suman entre sí y `reach` cuenta personas únicas. Eso
 * convierte cualquier `SUM(spend)` que olvide filtrar `nivel` en un número
 * TRIPLICADO y plausible. Aquí se comprueba que nadie en el repo lea la tabla
 * sin fijar el nivel.
 *
 *   npx tsx scripts/verify-ads-daily.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import {
  mapElemento,
  expandirFila,
  normNombre,
  nivelesParaFecha,
  FORMAS,
  VENTANA_NIVEL_AD_DIAS,
} from '../src/lib/ads/ads-daily-writer';
import { normLabel } from '../src/lib/report-utm/bi-metadata';

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

const CTX = { cliente_id: 'c1', fecha: '2026-07-15' };

// ════════════════════════════════════════════════════════════
seccion('normNombre coincide con normLabel del BI');
// ════════════════════════════════════════════════════════════

// Si las dos normalizaciones divergen, `nombre_norm` deja de servir para cruzar
// y el gasto se atribuye a la campaña equivocada — un fallo invisible en la
// salida. Se prueban nombres REALES del cliente Cris tributario.
const NOMBRES = [
  'V3[D][13|07][NEUROEMOCION][COLOMBIA][CAPTACIÓN][CBO] - ANDROMEDA',
  '[12/07][EBOOK][VENTAS][HOTMART][PERPETUO][ADS GANADORES/NUEVOS JUL] - Copia',
  'F2[23|07][ASESORIA TRIBUTARIA][C LEADS][AGENDAMIENTO][VIDS][P FRIO][ABO][JUL]',
  'promo_verano',
  'Promo Verano',
  'PROMO-VERANO',
  'Campaña Otoño',
  '  espacios   raros  ',
  'LSP Ranco II',
  'LSP EVS',
  '',
];
const divergentes = NOMBRES.filter((n) => normNombre(n) !== normLabel(n));
check(
  `las dos normalizaciones coinciden en ${NOMBRES.length} nombres reales`,
  divergentes.length === 0,
  divergentes.join(' | ')
);
check('quita acentos', normNombre('Campaña Otoño') === 'campana otono');
check('guiones y guiones bajos son espacios', normNombre('a-b_c') === 'a b c');
check('promo_verano === Promo Verano', normNombre('promo_verano') === normNombre('Promo Verano'));
check('NO funde campañas distintas', normNombre('LSP Ranco II') !== normNombre('LSP EVS'));

// ════════════════════════════════════════════════════════════
seccion('Identidad y entidad_key');
// ════════════════════════════════════════════════════════════

const conId = mapElemento('meta_ads', { ad_id: 'a1', ad_name: 'Anuncio 1', spend: 10 }, CTX)!;
check('con id, entidad_key es el id', conId.entidad_key === 'a1');
check('entidad_id se conserva', conId.entidad_id === 'a1');

// El caso de TikTok antes de pedirle los atributos: sin id.
const sinId = mapElemento('tiktok_adgroups', { adgroup_name: 'Grupo A', spend: 5 }, CTX)!;
check('sin id, entidad_key cae al nombre normalizado', sinId.entidad_key === 'n:grupo a');
check('y entidad_id queda null', sinId.entidad_id === null);
// Sin este fallback, dos NULL no colisionan en el índice único y la entidad se
// duplicaría en CADA sincronización.
const sinId2 = mapElemento('tiktok_adgroups', { adgroup_name: 'GRUPO_A', spend: 7 }, CTX)!;
check(
  'dos escrituras del mismo nombre dan la MISMA clave (no duplica)',
  sinId.entidad_key === sinId2.entidad_key
);

check(
  'sin id NI nombre se descarta (no se inventa clave)',
  mapElemento('meta_ads', { spend: 10 }, CTX) === null
);
check(
  'una columna desconocida se descarta',
  mapElemento('columna_inventada', { name: 'x' }, CTX) === null
);

// ════════════════════════════════════════════════════════════
seccion('Jerarquía por nivel');
// ════════════════════════════════════════════════════════════

const camp = mapElemento('meta_campaigns', { name: 'Camp 1', campaign_id: 'c9', spend: 100 }, CTX)!;
check(
  'en nivel campaña, la entidad ES la campaña',
  camp.campana_id === 'c9' && camp.campana_nombre === 'Camp 1'
);
check('nivel correcto', camp.nivel === 'campaign' && camp.plataforma === 'meta');

const adset = mapElemento(
  'meta_adsets',
  {
    adset_id: 's1',
    adset_name: 'Conjunto 1',
    campaign_id: 'c9',
    campaign_name: 'Camp 1',
    spend: 50,
  },
  CTX
)!;
check(
  'en nivel conjunto se guarda su campaña',
  adset.campana_id === 'c9' && adset.adset_id === 's1' && adset.adset_nombre === 'Conjunto 1'
);

const ad = mapElemento(
  'meta_ads',
  {
    ad_id: 'a1',
    ad_name: 'Anuncio 1',
    adset_id: 's1',
    adset_name: 'Conjunto 1',
    campaign_id: 'c9',
    campaign_name: 'Camp 1',
    account_id: 'act_1',
    spend: 25,
  },
  CTX
)!;
check(
  'en nivel anuncio se guarda toda la jerarquía',
  ad.campana_id === 'c9' &&
    ad.adset_id === 's1' &&
    ad.entidad_id === 'a1' &&
    ad.cuenta_id === 'act_1'
);

// Los objetos de TikTok NO traen campaign_id: es exactamente por lo que sus
// anuncios se descartaban bajo un filtro de campaña.
const tkAd = mapElemento('tiktok_ads', { ad_id: 't1', ad_name: 'TK 1', spend: 9 }, CTX)!;
check(
  'un anuncio de TikTok sin campaign_id queda con campana_id null (limitación real)',
  tkAd.campana_id === null
);

// ════════════════════════════════════════════════════════════
seccion('Métricas: columnas propias y cola larga');
// ════════════════════════════════════════════════════════════

const conEventos = mapElemento(
  'meta_ads',
  {
    ad_id: 'a1',
    ad_name: 'A',
    spend: '12.5',
    impressions: 1000,
    clicks: 50,
    reach: 800,
    link_clicks: 40,
    purchases: 3,
    view_content: 20,
    // Cola larga: sin columna propia.
    search: 7,
    donate: 2,
    find_location: 1,
    customize_product: 4,
    custom_conversions: { lead_calificado: 5 },
    // Ratios: NO se guardan, se recalculan sobre los totales.
    cpc: 0.25,
    cpm: 12.5,
    ctr: 5,
    frequency: 1.25,
  },
  CTX
)!;
check('el gasto en texto se convierte', conEventos.spend === 12.5);
check(
  'las columnas propias se llenan',
  conEventos.impressions === 1000 &&
    conEventos.clicks === 50 &&
    conEventos.reach === 800 &&
    conEventos.purchases === 3 &&
    conEventos.view_content === 20
);
check(
  'la cola larga va a eventos',
  conEventos.eventos.search === 7 &&
    conEventos.eventos.donate === 2 &&
    conEventos.eventos.find_location === 1
);
check(
  'custom_conversions se conserva como objeto',
  JSON.stringify(conEventos.eventos.custom) === '{"lead_calificado":5}'
);
// Guardar un ratio invitaría a promediarlo, y un promedio de promedios no cuadra
// con ningún día.
check(
  'los ratios NO se guardan',
  !('cpc' in conEventos.eventos) &&
    !('ctr' in conEventos.eventos) &&
    !('frequency' in conEventos.eventos)
);
check(
  'los eventos en 0 no ocupan sitio en el JSONB',
  mapElemento('meta_ads', { ad_id: 'x', ad_name: 'x', search: 0 }, CTX)!.eventos.search ===
    undefined
);

// `meta_campaigns` usa `leads`; adsets y ads usan `leads_form`. Sin el fallback
// el nivel campaña quedaría siempre a 0 en esa métrica.
check(
  'nivel campaña: `leads` alimenta leads_form',
  mapElemento('meta_campaigns', { name: 'C', leads: 42 }, CTX)!.leads_form === 42
);
check(
  'nivel anuncio: `leads_form` manda sobre `leads`',
  mapElemento('meta_ads', { ad_id: 'a', ad_name: 'a', leads: 1, leads_form: 9 }, CTX)!
    .leads_form === 9
);
check(
  '`leads` no se duplica en eventos',
  mapElemento('meta_campaigns', { name: 'C', leads: 42 }, CTX)!.eventos.leads === undefined
);

// ════════════════════════════════════════════════════════════
seccion('Ventana de retención del nivel anuncio');
// ════════════════════════════════════════════════════════════

const HOY = '2026-08-03';
check(
  'hoy incluye los tres niveles',
  JSON.stringify(nivelesParaFecha('2026-08-03', HOY)) === '["campaign","adset","ad"]'
);
check(
  `hace ${VENTANA_NIVEL_AD_DIAS} días todavía incluye anuncio`,
  nivelesParaFecha('2026-07-04', HOY).includes('ad')
);
check('hace 31 días ya NO incluye anuncio', !nivelesParaFecha('2026-07-03', HOY).includes('ad'));
check(
  'pero campaña y conjunto se conservan SIEMPRE',
  JSON.stringify(nivelesParaFecha('2025-01-01', HOY)) === '["campaign","adset"]'
);

// ════════════════════════════════════════════════════════════
seccion('Expansión de una fila día×cliente');
// ════════════════════════════════════════════════════════════

const filaReciente = {
  cliente_id: 'c1',
  fecha: '2026-08-01',
  meta_campaigns: [{ name: 'Camp 1', campaign_id: 'c9', spend: 100, reach: 500 }],
  meta_adsets: [{ adset_id: 's1', adset_name: 'S1', campaign_id: 'c9', spend: 60 }],
  meta_ads: [
    { ad_id: 'a1', ad_name: 'A1', campaign_id: 'c9', adset_id: 's1', spend: 35 },
    { ad_id: 'a2', ad_name: 'A2', campaign_id: 'c9', adset_id: 's1', spend: 25 },
  ],
  tiktok_campaigns: [{ name: 'TK', campaign_id: 'tk1', spend: 40 }],
};
const expReciente = expandirFila(filaReciente, { hoy: HOY });
check(
  'expande los tres niveles en fecha reciente',
  expReciente.length === 5,
  String(expReciente.length)
);
check(
  'los niveles NO se mezclan',
  expReciente.filter((r) => r.nivel === 'ad').length === 2 &&
    expReciente.filter((r) => r.nivel === 'campaign').length === 2
);
// La comprobación que da sentido a guardar por nivel: sumar TODO triplica.
const sumaTodo = expReciente.reduce((a, r) => a + r.spend, 0);
const sumaCampana = expReciente
  .filter((r) => r.nivel === 'campaign')
  .reduce((a, r) => a + r.spend, 0);
check(
  'sumar sin filtrar nivel infla el gasto (140 → 260): de ahí el aviso',
  sumaCampana === 140 && sumaTodo === 260,
  `campaña=${sumaCampana} todo=${sumaTodo}`
);

const filaVieja = { ...filaReciente, fecha: '2025-01-01' };
const expVieja = expandirFila(filaVieja, { hoy: HOY });
check(
  'en fecha vieja se omite el nivel anuncio',
  expVieja.length === 3 && !expVieja.some((r) => r.nivel === 'ad')
);

seccion('Deduplicación dentro del mismo día');
// La plataforma puede repetir una entidad (varias cuentas de anuncios). Sin
// deduplicar, el insert falla entero por conflicto con el UNIQUE.
const conRepetida = {
  cliente_id: 'c1',
  fecha: '2026-08-01',
  meta_ads: [
    { ad_id: 'a1', ad_name: 'A1', spend: 10, impressions: 100, reach: 80 },
    { ad_id: 'a1', ad_name: 'A1', spend: 15, impressions: 200, reach: 90 },
  ],
};
const dedup = expandirFila(conRepetida, { hoy: HOY });
check('la entidad repetida produce UNA sola fila', dedup.length === 1);
check('las métricas aditivas se suman', dedup[0].spend === 25 && dedup[0].impressions === 300);
check(
  'el alcance toma el MÁXIMO, no la suma (personas únicas)',
  dedup[0].reach === 90,
  String(dedup[0].reach)
);

seccion('Cobertura de las 6 columnas');
check('las 6 columnas JSONB están mapeadas', Object.keys(FORMAS).length === 6);
check(
  'cada plataforma tiene sus 3 niveles',
  (['meta', 'tiktok'] as const).every((p) =>
    (['campaign', 'adset', 'ad'] as const).every((n) =>
      Object.values(FORMAS).some((f) => f.plataforma === p && f.nivel === n)
    )
  )
);

// ════════════════════════════════════════════════════════════
seccion('Nadie lee ads_daily sin fijar el nivel');
// ════════════════════════════════════════════════════════════

// Es la guarda contra el fallo silencioso más peligroso de esta tabla: un
// SUM(spend) sin `nivel` triplica el gasto y el número parece razonable.
async function comprobacionesConEntorno() {
  // Se recorre el sistema de ficheros, NO `git grep`: éste solo mira lo que ya
  // está trackeado, así que mientras los archivos nuevos estaban sin añadir la
  // comprobación devolvía «0 referencias» y no guardaba nada. Un test que pasa
  // porque no encuentra nada es peor que no tenerlo.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const lecturas: string[] = [];
  const recorrer = (dir: string) => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entradas) {
      if (e === 'node_modules' || e === '.next' || e === '.git' || e === 'dist') continue;
      const p = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        recorrer(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e)) continue;
      const txt = readFileSync(p, 'utf8');
      const lineas = txt.split(/\r?\n/);
      lineas.forEach((linea, i) => {
        if (!linea.includes("from('ads_daily')")) return;
        // La sentencia encadenada ocupa varias líneas, así que se mira una
        // ventana, no solo la línea del `from`. Mirar solo la línea daba
        // falsos positivos en cada escritura.
        const sentencia = lineas.slice(i, i + 10).join(' ');
        lecturas.push(`${p}:${i + 1}|${sentencia}`);
      });
    }
  };
  for (const raiz of ['src', 'sync-worker', 'scripts']) recorrer(raiz);

  const sospechosas = lecturas.filter((ref) => {
    const [donde, sentencia] = ref.split('|');
    // Una ESCRITURA no necesita filtrar nivel: el peligro es sumar leyendo.
    if (/\.(upsert|insert)\(/.test(sentencia)) return false;
    // Un DELETE acotado por cliente_id + fecha abarca todos los niveles a
    // propósito: limpia lo que la plataforma dejó de reportar, sea del nivel
    // que sea. Se exige que esté acotado, no que filtre nivel.
    if (/\.delete\(/.test(sentencia)) {
      const acotado =
        /\.eq\('cliente_id'/.test(sentencia) &&
        /\.in\('fecha'|\.eq\('fecha'|\.lt\('fecha'/.test(sentencia);
      return !acotado ? true : false;
    }
    // Una lectura anclada a UN día concreto (`.eq('fecha', …)`) es una
    // inspección, no una agregación: se usa para comparar los tres niveles de
    // ese día contra el origen. El peligro que persigue esta guarda es sumar
    // sobre un RANGO sin fijar nivel, que triplica el gasto con un número que
    // parece plausible.
    if (/\.eq\('fecha'/.test(sentencia)) return false;
    if (donde.includes('verify-ads-daily')) return false;
    // Lo demás es una LECTURA agregable: tiene que fijar el nivel.
    return !/\.eq\('nivel'/.test(sentencia);
  });
  console.log(`  · ${lecturas.length} referencia(s) a ads_daily en el repo`);
  check(
    'ninguna lectura omite el filtro de nivel',
    sospechosas.length === 0,
    sospechosas.map((s) => s.split('|')[0]).join(' | ')
  );

  // ════════════════════════════════════════════════════════════
  seccion('Estado de la migración 063');
  // ════════════════════════════════════════════════════════════

  const { createAdminClient } = await import('../src/utils/supabase/server');
  const db = await createAdminClient();
  const { error } = await db.from('ads_daily').select('id').limit(1);
  if (error) {
    console.log(`  · La tabla ads_daily NO existe todavía (migración 063 sin aplicar).`);
    console.log(`    Es lo esperado: el mapeo se valida sin ella. Para aplicarla:`);
    console.log(`      migrations/063_ads_daily.sql`);
    console.log(`    y después:  npx tsx scripts/backfill-ads-daily.ts --dry-run`);
  } else {
    console.log(`  ✓ la tabla ads_daily existe`);
    const { count } = await db.from('ads_daily').select('id', { count: 'exact', head: true });
    console.log(`  · ${count ?? 0} filas`);
  }
}

comprobacionesConEntorno()
  .catch((e) => {
    console.error('\n✗ Fallo:', e?.message ?? e);
    fallos++;
  })
  .finally(() => {
    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
    process.exit(fallos === 0 ? 0 : 1);
  });
