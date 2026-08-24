/**
 * Comprobaciones del catálogo unificado que alimenta el selector del editor.
 *
 * No invoca la ruta HTTP (necesitaría sesión); prueba la MISMA composición que
 * hace el handler: registro → campos con su id histórico → disponibilidad por
 * fuente según el enlace del cliente.
 *
 * Lo que importa que se cumpla:
 *
 *   1. Todo campo que el selector ofrece se puede GUARDAR con el id de siempre,
 *      así que el cambio de UI no arrastra migración de datos.
 *   2. Una fuente que no se puede leer se atenúa ENTERA con su motivo, en vez de
 *      listar 40 campos que van a dar 0.
 *   3. Los campos que no cruzan con la dimensión elegida se marcan ANTES de
 *      elegirlos.
 *
 *   npx tsx scripts/verify-bi-catalog.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import {
  BASE_REGISTRY as REG,
  isAdditive,
  isPivotable,
  fieldCrossesDimension,
  funnelStages,
} from '../src/lib/report-utm/bi/registry';
import {
  CANONICAL_TO_LEGACY_MEASURE,
  LEGACY_DIMENSION_IDS,
  migrateMeasureId,
  migrateDimensionId,
} from '../src/lib/report-utm/bi/legacy-tokens';
import { METRIC_META, DIMENSION_META } from '../src/lib/report-utm/bi-metadata';

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

const CANONICAL_TO_LEGACY_DIM: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [legacy, canonical] of Object.entries(LEGACY_DIMENSION_IDS)) {
    if (!(canonical in out)) out[canonical] = legacy;
  }
  return out;
})();

async function main() {
  // ════════════════════════════════════════════════════════════
  seccion('Lo que ofrece el selector se puede guardar como siempre');
  // ════════════════════════════════════════════════════════════

  const medidas = REG.measures();
  const idsGuardados = medidas.map((m) => CANONICAL_TO_LEGACY_MEASURE[m.id] ?? m.id);

  const noReconocidas = idsGuardados.filter((id) => !(id in METRIC_META));
  check(
    `las ${medidas.length} medidas se guardan con un id que el motor ya entiende`,
    noReconocidas.length === 0,
    noReconocidas.join(', ')
  );

  // Ida y vuelta: lo que se guarda vuelve a resolver al mismo campo.
  const idaVuelta = idsGuardados.filter((id, i) => migrateMeasureId(id) !== medidas[i].id);
  check('ida y vuelta guardar → resolver es exacta', idaVuelta.length === 0, idaVuelta.join(', '));

  const dims = REG.dimensions();
  const dimsGuardadas = dims.map((d) => CANONICAL_TO_LEGACY_DIM[d.id] ?? d.id);
  const dimsNoReconocidas = dimsGuardadas.filter((id) => !(id in DIMENSION_META));
  check(
    `las ${dims.length} dimensiones se guardan con un id conocido`,
    dimsNoReconocidas.length === 0,
    dimsNoReconocidas.join(', ')
  );
  const dimIdaVuelta = dimsGuardadas.filter((id, i) => migrateDimensionId(id) !== dims[i].id);
  check(
    'ida y vuelta de dimensiones es exacta',
    dimIdaVuelta.length === 0,
    dimIdaVuelta.join(', ')
  );

  // ════════════════════════════════════════════════════════════
  seccion('La cascada reparte los 72 campos en pocas opciones por paso');
  // ════════════════════════════════════════════════════════════

  const porFuente = REG.sources.map((s) => ({
    id: s.id,
    label: s.label,
    medidas: s.fields.filter((f) => f.kind === 'measure').length,
    dims: s.fields.filter((f) => f.kind === 'dimension').length,
  }));
  for (const s of porFuente) {
    console.log(`  · ${s.label}: ${s.medidas} medidas · ${s.dims} dimensiones`);
  }
  const maxMedidas = Math.max(...porFuente.map((s) => s.medidas));
  // El punto de la cascada: en el paso 2 nunca hay 72 opciones.
  check(`ninguna fuente supera 40 medidas (máx: ${maxMedidas})`, maxMedidas <= 40);
  check('hay 7 fuentes en el primer paso', REG.sources.length === 7);

  // ════════════════════════════════════════════════════════════
  seccion('Fuentes que dependen del enlace de cliente');
  // ════════════════════════════════════════════════════════════

  const dependientes = REG.sources.filter((s) => s.clientKey.scope === 'public');
  const camposAfectados = dependientes.reduce(
    (a, s) => a + s.fields.filter((f) => f.kind === 'measure').length,
    0
  );
  console.log(`  · ${dependientes.map((s) => s.label).join(', ')}`);
  check(
    `sin enlace se atenúan ${dependientes.length} fuentes de golpe (${camposAfectados} medidas)`,
    dependientes.length === 5 && camposAfectados > 30,
    `${dependientes.length} fuentes / ${camposAfectados} medidas`
  );
  // Antes esto era el equivalente a listar 40+ métricas que darían 0 sin
  // ninguna explicación.
  check(
    'leads y ventas NO dependen del enlace',
    REG.sources.filter((s) => s.clientKey.scope === 'report_utm').length === 2
  );

  // ════════════════════════════════════════════════════════════
  seccion('Marcado previo de lo que no cruza con la dimensión');
  // ════════════════════════════════════════════════════════════

  const conPais = REG.measures().filter(
    (m) => !fieldCrossesDimension(REG, m.id, 'leads.ip_country')
  );
  console.log(
    `  · agrupando por País, ${conPais.length} de ${medidas.length} medidas caerían en el total`
  );
  check(
    'agrupando por país se marca el gasto',
    conPais.some((m) => m.id === 'ads.spend')
  );
  check(
    'agrupando por país se marca el CPL (hereda del gasto)',
    conPais.some((m) => m.id === 'leads.cpl')
  );
  check('agrupando por país NO se marca leads.count', !conPais.some((m) => m.id === 'leads.count'));

  const conCampana = REG.measures().filter(
    (m) => !fieldCrossesDimension(REG, m.id, 'leads.campaign')
  );
  console.log(`  · agrupando por Campaña, ${conCampana.length} caerían en el total`);
  check('agrupando por campaña el gasto SÍ cruza', !conCampana.some((m) => m.id === 'ads.spend'));
  check(
    'agrupando por campaña GA4 se marca',
    conCampana.some((m) => m.id === 'cuenta.ga_sessions')
  );

  // ════════════════════════════════════════════════════════════
  seccion('Filtros del selector por tipo de widget');
  // ════════════════════════════════════════════════════════════

  const etapas = funnelStages(REG);
  check(
    `el embudo ofrece ${etapas.length} etapas, no las 72 medidas`,
    etapas.length > 5 && etapas.length < medidas.length,
    String(etapas.length)
  );
  check(
    'las etapas del embudo son conteos, nunca importes',
    etapas.every((e) => e.format === 'number'),
    etapas
      .filter((e) => e.format !== 'number')
      .map((e) => e.id)
      .join(', ')
  );

  const pivotables = medidas.filter((m) => isPivotable(REG, m.id));
  check(
    `la tabla dinámica ofrece ${pivotables.length} medidas (solo grano de fila)`,
    pivotables.length === 3,
    pivotables.map((m) => m.id).join(', ')
  );

  const aditivas = medidas.filter(isAdditive);
  check(`${aditivas.length} medidas admiten fila de totales`, aditivas.length > 40);
  check(
    'el alcance NO admite total (personas únicas)',
    !aditivas.some((m) => m.id === 'ads.reach')
  );
  check(
    'ningún ratio admite total',
    !aditivas.some((m) => m.format === 'ratio' || m.format === 'percent'),
    aditivas
      .filter((m) => m.format === 'ratio' || m.format === 'percent')
      .map((m) => m.id)
      .join(', ')
  );

  // ════════════════════════════════════════════════════════════
  seccion('Avisos de solapamiento');
  // ════════════════════════════════════════════════════════════

  const conSolape = medidas.filter((m) => (m.conflictsWith?.length ?? 0) > 0);
  console.log(`  · ${conSolape.length} medidas declaran con qué se solapan`);
  check(
    'las tres métricas de "leads" se declaran entre sí',
    ['leads.count', 'ads.leads_form', 'offline.leads'].every(
      (id) => (REG.measure(id)?.conflictsWith?.length ?? 0) >= 2
    )
  );
  // Los solapamientos tienen que apuntar a campos que existen, o el aviso
  // mostraría un id suelto.
  const solapeRoto = conSolape.flatMap((m) =>
    (m.conflictsWith ?? []).filter((id) => !REG.measure(id)).map((id) => `${m.id} → ${id}`)
  );
  check(
    'todos los solapamientos apuntan a campos reales',
    solapeRoto.length === 0,
    solapeRoto.join(', ')
  );

  // ════════════════════════════════════════════════════════════
  seccion('Disponibilidad real contra la base');
  // ════════════════════════════════════════════════════════════

  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { resolvePublicClienteId } = await import('../src/lib/report-utm/campaign-resolver');
  const db = await createAdminClient();
  const { data } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .order('nombre');
  const todos = (data ?? []) as Array<{
    id: string;
    nombre: string;
    public_cliente_id: string | null;
  }>;

  const sinEnlace = todos.find((c) => !c.public_cliente_id);
  const conEnlace = todos.find((c) => c.public_cliente_id);

  if (conEnlace) {
    const link = await resolvePublicClienteId(conEnlace.id);
    check(`«${conEnlace.nombre.trim()}»: las 7 fuentes disponibles`, link !== null);
  }
  if (sinEnlace) {
    const link = await resolvePublicClienteId(sinEnlace.id);
    check(`«${sinEnlace.nombre.trim()}»: 5 fuentes atenuadas con motivo`, link === null);
  } else {
    console.log('  (no hay cliente sin enlace para probar la atenuación)');
  }

  console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✗ Fallo:', e?.message ?? e);
  process.exit(1);
});
