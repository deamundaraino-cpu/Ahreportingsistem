import 'server-only';

/**
 * Validación de widgets y fórmulas antes de guardarlos.
 *
 * El editor del canvas solo AVISA de un cruce imposible; el agente, en cambio,
 * no ve el aviso, así que aquí se rechaza. La regla es la misma que usa el
 * editor (`metricCrossesDimension`) para que agente e interfaz no discrepen
 * sobre qué muestra 0.
 *
 * La versión anterior solo miraba `config.metric` contra `config.dimension`. Se
 * le escapaban las tablas (varias métricas separadas por comas), las fórmulas,
 * la dimensión secundaria y los widgets dentro de una sección.
 *
 * Todo es puro: no toca la base.
 */

import {
  DIMENSION_META,
  METRIC_META,
  metricCrossesDimension,
  supportsPivot,
  isSheetDim,
  isFieldMetric,
  esEtapaDeEmbudo,
} from '@/lib/report-utm/bi-metadata';
import { parseExpr, isExprError, validateRefs } from '@/lib/report-utm/bi/expr';
import type { BiWidget, CalculatedField } from '@/components/report-utm/bi/BiTypes';

export type Validacion = { errores: string[]; avisos: string[] };

/** Tokens y alias dinámicos que existen para el cliente, si se cargaron. */
export type CatalogoCliente = { tokens: Set<string>; aliases: Set<string> };

const PREFIJOS_METRICA = [
  'fieldagg:',
  'leadseg:',
  'leadans:',
  'offfield:',
  'metacc:',
  'sheetagg:',
  'sheetview:',
];
const PREFIJOS_DIMENSION = ['field:', 'leadfield:', 'sheetdim:'];

/** Alias de fórmula de un campo dinámico (`lf__`, `lseg__`, `sf__`…). */
const PATRON_ALIAS = /^(f_(sum|avg|min|max|count)__|lf__|lseg__|off__|sf__|sv__)[a-z0-9_]+$/i;

/** Identificadores que el motor acepta en una fórmula además del catálogo fijo. */
const REFS_EXTRA = new Set(['leads_total']);

type Resolucion = 'ok' | 'desconocida' | 'sin_comprobar';

function resolverRef(id: string, cat?: CatalogoCliente): Resolucion {
  if (id in METRIC_META || REFS_EXTRA.has(id)) return 'ok';
  if (PATRON_ALIAS.test(id)) {
    if (!cat) return 'sin_comprobar';
    // Los alias de campo de formulario crudo (`f_sum__…`) no están en el
    // catálogo del agente: se aceptan con aviso.
    if (/^f_/i.test(id)) return 'sin_comprobar';
    return cat.aliases.has(id) ? 'ok' : 'desconocida';
  }
  return 'desconocida';
}

function resolverMetrica(token: string, cat?: CatalogoCliente): Resolucion {
  if (token in METRIC_META) return 'ok';
  if (PREFIJOS_METRICA.some((p) => token.startsWith(p))) {
    if (!cat || isFieldMetric(token)) return 'sin_comprobar';
    return cat.tokens.has(token) ? 'ok' : 'desconocida';
  }
  return 'desconocida';
}

function resolverDimension(token: string, cat?: CatalogoCliente): Resolucion {
  if (token in DIMENSION_META) return 'ok';
  if (PREFIJOS_DIMENSION.some((p) => token.startsWith(p))) {
    if (!cat || token.startsWith('field:')) return 'sin_comprobar';
    return cat.tokens.has(token) ? 'ok' : 'desconocida';
  }
  return 'desconocida';
}

/**
 * Valida una fórmula: que se entienda y que cada identificador exista.
 *
 * Un identificador desconocido valía 0 en silencio (`validateRefs` existía pero
 * nadie lo llamaba), así que una errata producía una tarjeta que se veía bien y
 * mentía.
 */
export function validarFormula(expr: string, cat?: CatalogoCliente): Validacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  const parsed = parseExpr(expr);
  if (isExprError(parsed)) {
    errores.push(
      `La fórmula "${expr}" no se entiende (posición ${parsed.at + 1}): ${parsed.error}`
    );
    return { errores, avisos };
  }
  const r = validateRefs(parsed, (id) => resolverRef(id, cat) !== 'desconocida');
  if (!r.ok) {
    errores.push(
      `La fórmula "${expr}" usa identificadores que no existen: ${r.unknown.join(', ')}. ` +
        'Consulta list_report_fields para ver los ids y alias válidos.'
    );
  }
  const sinComprobar = parsed.refs.filter((id) => resolverRef(id, cat) === 'sin_comprobar');
  if (sinComprobar.length) {
    avisos.push(`No se pudo comprobar que existan para este cliente: ${sinComprobar.join(', ')}.`);
  }
  return { errores, avisos };
}

/** Valida un campo calculado del informe. */
export function validarCampoCalculado(
  c: Pick<CalculatedField, 'name' | 'expression'>,
  cat?: CatalogoCliente
): Validacion {
  const out = validarFormula(c.expression, cat);
  // Una tabla guarda sus columnas como una lista separada por comas: un nombre
  // con coma partiría la columna en dos.
  if (c.name.includes(',')) {
    out.errores.push(`El nombre del campo calculado "${c.name}" no puede llevar comas.`);
  }
  if (!c.name.trim()) out.errores.push('El campo calculado necesita un nombre.');
  return out;
}

/**
 * Métricas que usa un widget, ya expandidas: columnas de tabla, etapas de
 * embudo, identificadores de la fórmula y las bases de los campos calculados.
 */
export function metricasDeWidget(w: BiWidget, calc: CalculatedField[] = []): string[] {
  const porNombre = new Map(calc.map((c) => [c.name, c]));
  const out = new Set<string>();
  const cfg = w.config ?? {};
  const expandir = (token: string) => {
    const c = porNombre.get(token);
    if (c) {
      const p = parseExpr(c.expression);
      if (!isExprError(p)) for (const id of p.refs) out.add(id);
    } else out.add(token);
  };
  const formula = cfg.formula?.trim();
  if (formula) {
    const p = parseExpr(formula);
    if (!isExprError(p)) for (const id of p.refs) out.add(id);
  } else if (cfg.metric) {
    for (const t of String(cfg.metric).split(',')) if (t.trim()) expandir(t.trim());
  }
  for (const m of cfg.metrics ?? []) expandir(String(m));
  return [...out];
}

const TIPOS_CON_METRICA = new Set(['scorecard', 'line', 'area', 'bar', 'combo', 'pie', 'scatter']);
const TIPOS_GRAFICA = new Set(['line', 'area', 'bar', 'combo', 'pie', 'scatter']);
const TIPOS_CON_PIVOTE = new Set(['bar', 'combo', 'area', 'line']);

/**
 * Valida un widget (y sus hijos, si es una sección).
 *
 * `calc` son los campos calculados del informe; `cat`, el catálogo dinámico del
 * cliente cuando se ha cargado. Sin catálogo, los tokens dinámicos se aceptan
 * con aviso en vez de rechazarse.
 */
export function validarWidget(
  w: BiWidget,
  calc: CalculatedField[] = [],
  cat?: CatalogoCliente
): Validacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  const cfg = w.config ?? {};
  const etiqueta = `Widget ${w.title ? `"${w.title}"` : w.id} (${w.type})`;
  const calcNombres = new Set(calc.map((c) => c.name));
  const formula = cfg.formula?.trim();

  // ── Lo mínimo que necesita cada tipo ──
  if (TIPOS_CON_METRICA.has(w.type) && !cfg.metric && !formula) {
    errores.push(`${etiqueta}: indica config.metric o config.formula.`);
  }
  if (w.type === 'table' && !cfg.metric) {
    errores.push(`${etiqueta}: una tabla necesita config.metric (columnas separadas por comas).`);
  }
  if (w.type === 'funnel' && (cfg.metrics?.length ?? 0) < 2) {
    errores.push(`${etiqueta}: un embudo necesita al menos dos etapas en config.metrics.`);
  }
  if (w.type === 'funnel') {
    // El motor descarta en silencio las etapas que no valen y, si quedan menos
    // de dos, dibuja el embudo clásico: el widget mostraría otra cosa.
    const malas = (cfg.metrics ?? []).map(String).filter((m) => !esEtapaDeEmbudo(m));
    if (malas.length) {
      errores.push(
        `${etiqueta}: estas métricas no valen como etapa de embudo: ${malas.join(', ')}. ` +
          'Valen conteos (impresiones, clics, leads, ventas) y segmentos o respuestas de lead.'
      );
    }
  }
  if (w.type === 'slicer' && cfg.slicer_mode !== 'daterange' && !cfg.dimension) {
    errores.push(`${etiqueta}: un slicer necesita config.dimension.`);
  }
  if ((w.type === 'heading' || w.type === 'text') && !cfg.text?.trim()) {
    errores.push(`${etiqueta}: necesita config.text.`);
  }

  // ── Fórmula propia ──
  if (formula) {
    const f = validarFormula(formula, cat);
    errores.push(...f.errores.map((e) => `${etiqueta}: ${e}`));
    avisos.push(...f.avisos.map((a) => `${etiqueta}: ${a}`));
  }

  // ── Que cada métrica exista ──
  const directas = formula
    ? []
    : [
        ...String(cfg.metric ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ...(cfg.metrics ?? []).map(String),
      ];
  for (const m of directas) {
    if (calcNombres.has(m)) continue;
    const r = resolverMetrica(m, cat);
    if (r === 'desconocida') {
      errores.push(
        `${etiqueta}: la métrica "${m}" no existe (ni como campo calculado del informe). ` +
          'Consulta list_report_fields.'
      );
    } else if (r === 'sin_comprobar') {
      avisos.push(`${etiqueta}: no se pudo comprobar que "${m}" exista para este cliente.`);
    }
  }

  // ── Que cada dimensión exista ──
  const dims = [cfg.dimension, cfg.dimension2]
    .map((d) => (d ? String(d) : ''))
    .filter((d) => d && d !== 'none');
  for (const d of dims) {
    const r = resolverDimension(d, cat);
    if (r === 'desconocida') {
      errores.push(`${etiqueta}: la dimensión "${d}" no existe. Consulta list_report_fields.`);
    } else if (r === 'sin_comprobar') {
      avisos.push(`${etiqueta}: no se pudo comprobar que la dimensión "${d}" exista.`);
    }
  }

  // ── Cruces imposibles: el widget mostraría 0 siempre ──
  if (w.type !== 'slicer' && w.type !== 'funnel') {
    for (const m of metricasDeWidget(w, calc)) {
      for (const d of dims) {
        if (!metricCrossesDimension(m, d)) {
          errores.push(
            `${etiqueta}: la métrica "${m}" no se puede desglosar por "${d}": ese widget mostraría 0 siempre.`
          );
        }
      }
    }
  }

  // ── Dimensión secundaria que el canvas ignorará ──
  const d2 = cfg.dimension2 && cfg.dimension2 !== 'none' ? String(cfg.dimension2) : null;
  if (d2) {
    const metric = String(cfg.metric ?? '');
    const pivota =
      TIPOS_CON_PIVOTE.has(w.type) &&
      !formula &&
      !calcNombres.has(metric) &&
      !isFieldMetric(metric) &&
      supportsPivot(metric);
    if (!pivota) {
      avisos.push(
        `${etiqueta}: la dimensión secundaria "${d2}" se ignora (solo aplica a gráficas de barras, ` +
          'líneas, áreas o combo con una métrica que cuente leads o ventas).'
      );
    } else if (isSheetDim(d2)) {
      avisos.push(`${etiqueta}: una dimensión de Sheet no sirve como dimensión secundaria.`);
    }
  }
  if (!TIPOS_GRAFICA.has(w.type) && cfg.date_grouping && cfg.dimension !== 'date') {
    avisos.push(`${etiqueta}: date_grouping solo tiene efecto con dimension "date".`);
  }

  // ── Hijos de una sección ──
  for (const c of w.children ?? []) {
    const r = validarWidget(c, calc, cat);
    errores.push(...r.errores);
    avisos.push(...r.avisos);
  }

  return { errores, avisos };
}
