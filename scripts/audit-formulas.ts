/**
 * Auditoría de fórmulas de tarjetas/columnas/gráficos/ranking en todo el sistema.
 *
 * Detecta, SIN modificar nada:
 *   1. Constantes numéricas "grandes" (≥ umbral) embebidas en fórmulas → suelen ser
 *      valores congelados (ej. un tiktok_spend copiado a mano) que ya no reflejan la
 *      métrica viva. Sugiere el equivalente cuando el patrón es claro.
 *   2. Identificadores no reconocidos (no están en FIELD_MAP, MACRO_MAP, aliases ni son
 *      meta_custom_ / funnel_ / context) → typos que se evalúan como 0 en silencio.
 *   3. Fórmulas vacías.
 *
 * Fuentes: cliente_tabs, clientes_layouts, layouts_reporte, tab_templates.
 * Recorre los arrays JSONB: tarjetas, columnas, custom_metrics, graficos, ranking_tables.
 *
 *   npx tsx scripts/audit-formulas.ts [umbralConstante]
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { FIELD_MAP, MACRO_MAP, SEMANTIC_ALIASES } from '../src/lib/formula-engine';

const envPath = 'c:/Users/razs9/OneDrive/Desktop/Apps/Ahreportingsistem/.env.local';
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONST_THRESHOLD = Number(process.argv[2]) || 1000;

// Identificadores conocidos (además de dinámicos por prefijo).
const KNOWN = new Set<string>([
  ...Object.keys(FIELD_MAP),
  ...Object.keys(MACRO_MAP),
  ...Object.keys(SEMANTIC_ALIASES),
  // Variables de contexto inyectadas por DashboardClient (varContext).
  'dias_totales',
  'dias_transcurridos',
  'dias_restantes',
  'presupuesto_objetivo',
  'presupuesto_diario_ideal',
  'presupuesto_gastado_total',
  'presupuesto_restante',
  'presupuesto_diario_sugerido',
]);
const KNOWN_PREFIXES = ['meta_custom_', 'funnel_', 'sheet_', '$funnel.', '$'];

function isKnownIdent(id: string): boolean {
  if (KNOWN.has(id)) return true;
  return KNOWN_PREFIXES.some((p) => id.startsWith(p));
}

/** Sugerencia de reemplazo para una constante dentro de una fórmula de spend. */
function suggestForConstant(formula: string, value: number): string | null {
  const f = formula.toLowerCase();
  // 1.549.187 y variantes cercanas junto a meta_spend → probablemente tiktok_spend.
  if (/meta_spend/.test(f) && !/tiktok_spend/.test(f) && value > 100000) {
    return 'posible tiktok_spend (métrica viva) en vez de la constante';
  }
  return null;
}

type Finding = {
  cliente: string;
  contenedor: string;
  elemento: string;
  formula: string;
  constantes: number[];
  desconocidos: string[];
  vacia: boolean;
  sugerencia: string | null;
};

function analizarFormula(
  formula: string | null | undefined
): Omit<Finding, 'cliente' | 'contenedor' | 'elemento'> | null {
  const f = (formula ?? '').trim();
  if (f === '')
    return { formula: '', constantes: [], desconocidos: [], vacia: true, sugerencia: null };

  // Constantes numéricas (enteros/decimales) ≥ umbral.
  const nums = (f.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => n >= CONST_THRESHOLD);
  // Identificadores tipo snake/$ que no reconocemos.
  const idents = f.match(/[$]?[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [];
  const desconocidos = [...new Set(idents.filter((id) => !isKnownIdent(id)))];

  if (nums.length === 0 && desconocidos.length === 0) return null;
  return {
    formula: f,
    constantes: [...new Set(nums)],
    desconocidos,
    vacia: false,
    sugerencia: nums.length ? suggestForConstant(f, Math.max(...nums)) : null,
  };
}

/** Extrae {label/name, formula, targetFormula} de un elemento de layout. */
function elementos(arr: unknown): { nombre: string; formula: string }[] {
  if (!Array.isArray(arr)) return [];
  const out: { nombre: string; formula: string }[] = [];
  for (const el of arr as Record<string, unknown>[]) {
    const nombre = String(el?.label ?? el?.name ?? el?.titulo ?? el?.id ?? '(sin nombre)');
    if (typeof el?.formula === 'string') out.push({ nombre, formula: el.formula });
    if (typeof el?.targetFormula === 'string')
      out.push({ nombre: `${nombre} · target`, formula: el.targetFormula });
    // custom_metrics: { key: formula } o [{ key/name, formula }]
    if (
      el &&
      typeof el === 'object' &&
      typeof el.formula !== 'string' &&
      typeof el.expression === 'string'
    ) {
      out.push({ nombre, formula: el.expression });
    }
  }
  return out;
}

const ARRAY_KEYS = ['tarjetas', 'columnas', 'graficos', 'ranking_tables', 'custom_metrics'];

async function main() {
  console.log(`\n=== Auditoría de fórmulas (constantes ≥ ${CONST_THRESHOLD}) ===\n`);
  const findings: Finding[] = [];

  const pushFrom = (cliente: string, contenedor: string, source: Record<string, unknown>) => {
    for (const key of ARRAY_KEYS) {
      for (const { nombre, formula } of elementos(source?.[key])) {
        const a = analizarFormula(formula);
        if (a)
          findings.push({ cliente, contenedor: `${contenedor}.${key}`, elemento: nombre, ...a });
      }
    }
  };

  // cliente_tabs (con nombre de cliente)
  const { data: clientes } = await db.from('clientes').select('id, nombre');
  const nombreCliente = new Map(
    (clientes || []).map((c: { id: string; nombre: string }) => [c.id, c.nombre])
  );
  const { data: tabs } = await db
    .from('cliente_tabs')
    .select('cliente_id, nombre, tarjetas, columnas, graficos, ranking_tables, custom_metrics');
  for (const t of tabs || [])
    pushFrom(nombreCliente.get(t.cliente_id) || '(cliente?)', `tab:${t.nombre}`, t);

  const { data: cl } = await db
    .from('clientes_layouts')
    .select('cliente_id, nombre, tarjetas, columnas, graficos, ranking_tables, custom_metrics');
  for (const l of cl || [])
    pushFrom(nombreCliente.get(l.cliente_id) || '(cliente?)', `layout_cliente:${l.nombre}`, l);

  const { data: lr } = await db
    .from('layouts_reporte')
    .select('nombre, tarjetas, columnas, graficos, ranking_tables, custom_metrics');
  for (const l of lr || []) pushFrom('(plantilla global)', `layout:${l.nombre}`, l);

  const { data: tt } = await db
    .from('tab_templates')
    .select('nombre, tarjetas, columnas, graficos, ranking_tables, custom_metrics');
  for (const l of tt || []) pushFrom('(plantilla pestaña)', `tab_template:${l.nombre}`, l);

  // Reporte
  const conConst = findings.filter((f) => f.constantes.length > 0);
  const conDesc = findings.filter((f) => f.desconocidos.length > 0);

  console.log(`── CONSTANTES GRANDES EN FÓRMULAS (${conConst.length}) ──`);
  const porCliente = new Map<string, Finding[]>();
  for (const f of conConst) {
    const k = f.cliente;
    (porCliente.get(k) ?? porCliente.set(k, []).get(k)!).push(f);
  }
  for (const [cliente, fs] of porCliente) {
    console.log(`\n  ▸ ${cliente}`);
    for (const f of fs) {
      console.log(`    [${f.contenedor}] "${f.elemento}"`);
      console.log(`        fórmula: ${f.formula}`);
      console.log(
        `        constantes: ${f.constantes.join(', ')}${f.sugerencia ? `  → ${f.sugerencia}` : ''}`
      );
    }
  }

  console.log(`\n── IDENTIFICADORES NO RECONOCIDOS (${conDesc.length}) ──`);
  for (const f of conDesc) {
    console.log(`  ${f.cliente} [${f.contenedor}] "${f.elemento}": ${f.desconocidos.join(', ')}`);
    console.log(`      fórmula: ${f.formula}`);
  }

  console.log(`\n── RESUMEN ──`);
  console.log(`  Fórmulas con constantes grandes: ${conConst.length}`);
  console.log(`  Fórmulas con identificadores desconocidos: ${conDesc.length}`);
  console.log(`  Total elementos analizados con hallazgos: ${findings.length}`);
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
