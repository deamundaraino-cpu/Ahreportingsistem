// Parser y evaluador de las expresiones del BI (campos calculados y fórmulas
// de widget). Client-safe: no importa nada de servidor.
//
// ── Por qué existe este archivo ──────────────────────────────────────────
// Antes había DOS lecturas distintas de la misma expresión, y ninguna la
// entendía de verdad:
//
//   1. `evaluateExpression` (bi-metadata.ts) sustituía identificadores por su
//      valor con `expression.replace(/[a-z_][a-z0-9_]*/gi, ...)`.
//   2. `runBiQuery` (bi-query.ts) descubría las dependencias con
//      `expression.match(/[a-z_][a-z0-9_]*/gi)`.
//
// Consecuencias reales de (2): en `spend / dias`, `dias` se tomaba por una
// métrica requerida y podía disparar la consulta de una fuente entera para
// nada; y una errata nunca se reportaba, simplemente valía 0 en silencio.
//
// Aquí la expresión se parsea UNA vez a un AST. `refs` es la única fuente de
// verdad sobre qué campos necesita, así que el motor pide exactamente esas
// fuentes y el editor puede decir QUÉ identificador está mal.
//
// El descenso recursivo es el mismo enfoque que ya usaban `safeEvalArithmetic`
// aquí y en `lib/formula-engine.ts` (el dashboard clásico): la CSP de
// producción no incluye 'unsafe-eval', así que `new Function` lanza en el
// navegador. Ver el comentario histórico en bi-metadata.ts.

export type BinOp = '+' | '-' | '*' | '/';

export type Node =
  | { t: 'num'; v: number }
  | { t: 'ref'; id: string }
  | { t: 'bin'; op: BinOp; l: Node; r: Node }
  | { t: 'neg'; v: Node };

export interface ParsedExpr {
  ast: Node;
  /** Identificadores referenciados, sin duplicados y en orden de aparición. */
  refs: string[];
}

export interface ExprError {
  error: string;
  /** Índice (0-based) del carácter donde se detectó el problema. */
  at: number;
}

export function isExprError(x: ParsedExpr | ExprError): x is ExprError {
  return (x as ExprError).error !== undefined;
}

/**
 * Identificador de campo: `leads_count`, `ads.spend`, `sheet.rango__sum`.
 *
 * Acepta el punto para los ids canónicos `<fuente>.<campo>` y el guion bajo
 * doble de los campos dinámicos. Un identificador NO puede empezar por dígito,
 * que es lo que lo separa de un número (`1.5` es número, `a.5` es error).
 */
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || (c >= '0' && c <= '9');
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Parsea una expresión aritmética sobre identificadores de campo.
 *
 * Gramática (precedencia estándar):
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('+' | '-') factor | '(' expr ')' | number | ident
 */
export function parseExpr(src: string): ParsedExpr | ExprError {
  if (!src || !src.trim()) return { error: 'La fórmula está vacía.', at: 0 };

  const s = src;
  let i = 0;
  const refs: string[] = [];
  const seen = new Set<string>();

  const skipWs = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  };

  // Se lanza un objeto de error y se captura abajo: evita tener que propagar
  // un tipo unión por cada nivel del descenso.
  const fail = (error: string, at: number = i): never => {
    throw { __expr: true, error, at };
  };

  const parseExpression = (): Node => {
    let left = parseTerm();
    skipWs();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++] as BinOp;
      const right = parseTerm();
      left = { t: 'bin', op, l: left, r: right };
      skipWs();
    }
    return left;
  };

  const parseTerm = (): Node => {
    let left = parseFactor();
    skipWs();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++] as BinOp;
      const right = parseFactor();
      left = { t: 'bin', op, l: left, r: right };
      skipWs();
    }
    return left;
  };

  const parseFactor = (): Node => {
    skipWs();
    if (i >= s.length) return fail('La fórmula termina de forma inesperada.', s.length);

    const c = s[i];

    if (c === '+') {
      i++;
      return parseFactor();
    }
    if (c === '-') {
      i++;
      return { t: 'neg', v: parseFactor() };
    }

    if (c === '(') {
      const open = i;
      i++;
      const inner = parseExpression();
      skipWs();
      if (s[i] !== ')') return fail('Falta cerrar un paréntesis.', open);
      i++;
      return inner;
    }

    if (isDigit(c) || (c === '.' && isDigit(s[i + 1] ?? ''))) {
      const start = i;
      while (i < s.length && isDigit(s[i])) i++;
      if (s[i] === '.') {
        i++;
        while (i < s.length && isDigit(s[i])) i++;
      }
      const raw = s.slice(start, i);
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) return fail(`«${raw}» no es un número válido.`, start);
      return { t: 'num', v };
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < s.length && isIdentPart(s[i])) i++;
      // Segmentos separados por punto: `ads.spend`. Un punto suelto al
      // final (`ads.`) es un error, no un identificador con basura.
      while (s[i] === '.') {
        const dot = i;
        i++;
        if (i >= s.length || !isIdentStart(s[i])) {
          return fail('Falta el nombre del campo después del punto.', dot);
        }
        while (i < s.length && isIdentPart(s[i])) i++;
      }
      const id = s.slice(start, i);
      if (!seen.has(id)) {
        seen.add(id);
        refs.push(id);
      }
      return { t: 'ref', id };
    }

    return fail(`El carácter «${c}» no se puede usar en una fórmula.`, i);
  };

  try {
    const ast = parseExpression();
    skipWs();
    if (i !== s.length) {
      return { error: `Sobra «${s.slice(i)}» al final de la fórmula.`, at: i };
    }
    return { ast, refs };
  } catch (e) {
    const err = e as { __expr?: boolean; error?: string; at?: number };
    if (err?.__expr) return { error: err.error!, at: err.at! };
    throw e;
  }
}

/**
 * Qué hacer con un identificador que no tiene valor en la fila.
 *
 *  - `zero` — cuenta como 0. Es el comportamiento histórico de
 *    `evaluateExpression`, y se conserva para no mover los números de los
 *    informes ya guardados.
 *  - `null` — la expresión entera vale null. Es el comportamiento correcto
 *    ("cero ≠ desconocido", igual que `getUsdRate` en lib/fx.ts) y el que usan
 *    las métricas derivadas.
 */
export type MissingPolicy = 'zero' | 'null';

export interface EvalOptions {
  onMissing?: MissingPolicy;
  /** Decimales del resultado. `null` = sin redondear. */
  decimals?: number | null;
}

/**
 * Evalúa un AST ya parseado.
 *
 * Devuelve null si: falta un valor y la política es `null`, hay una división
 * por cero, o el resultado no es finito. NUNCA devuelve Infinity ni NaN.
 */
export function evalExpr(
  ast: Node,
  values: Record<string, number | null | undefined>,
  opts: EvalOptions = {}
): number | null {
  const onMissing = opts.onMissing ?? 'zero';
  const decimals = opts.decimals === undefined ? 2 : opts.decimals;

  // `null` como sentinela de "no se puede calcular", propagado hacia arriba.
  const walk = (n: Node): number | null => {
    switch (n.t) {
      case 'num':
        return n.v;
      case 'ref': {
        const v = values[n.id];
        if (v === null || v === undefined || !Number.isFinite(v)) {
          return onMissing === 'zero' ? 0 : null;
        }
        return v as number;
      }
      case 'neg': {
        const v = walk(n.v);
        return v === null ? null : -v;
      }
      case 'bin': {
        const l = walk(n.l);
        if (l === null) return null;
        const r = walk(n.r);
        if (r === null) return null;
        switch (n.op) {
          case '+':
            return l + r;
          case '-':
            return l - r;
          case '*':
            return l * r;
          // División por cero → null, no Infinity. Un ROAS "infinito"
          // en un informe de cliente es peor que un guion.
          case '/':
            return r === 0 ? null : l / r;
        }
      }
    }
  };

  const out = walk(ast);
  if (out === null || !Number.isFinite(out)) return null;
  if (decimals === null) return out;
  const f = 10 ** decimals;
  return Math.round(out * f) / f;
}

/** Los identificadores de una expresión, o `[]` si no parsea. Atajo cómodo. */
export function refsOf(src: string): string[] {
  const p = parseExpr(src);
  return isExprError(p) ? [] : p.refs;
}

/**
 * Comprueba que todos los identificadores existen.
 *
 * Es lo que permite que el editor señale la errata en vez de dejar que la
 * expresión valga 0 en silencio.
 */
export function validateRefs(
  parsed: ParsedExpr,
  known: (id: string) => boolean
): { ok: true } | { ok: false; unknown: string[] } {
  const unknown = parsed.refs.filter((id) => !known(id));
  return unknown.length ? { ok: false, unknown } : { ok: true };
}

/**
 * Reescribe los identificadores de una expresión conservando su estructura.
 *
 * Lo usa la migración de informes guardados. Va sobre el AST a propósito: un
 * `replace()` de texto sobre `spend` corrompería `meta_spend` o un campo que
 * contenga la palabra, que es justo el riesgo que corrió la migración 045 al
 * hacer `replace(layout::text, 'leads_total', 'leads_count')`.
 */
export function rewriteRefs(ast: Node, map: (id: string) => string): Node {
  switch (ast.t) {
    case 'num':
      return ast;
    case 'ref':
      return { t: 'ref', id: map(ast.id) };
    case 'neg':
      return { t: 'neg', v: rewriteRefs(ast.v, map) };
    case 'bin':
      return { t: 'bin', op: ast.op, l: rewriteRefs(ast.l, map), r: rewriteRefs(ast.r, map) };
  }
}

/** Vuelve a texto un AST. Añade paréntesis solo donde la precedencia los pide. */
export function serializeExpr(ast: Node): string {
  const prec = (n: Node): number => {
    if (n.t === 'bin') return n.op === '+' || n.op === '-' ? 1 : 2;
    if (n.t === 'neg') return 3;
    return 4;
  };
  const walk = (n: Node): string => {
    switch (n.t) {
      case 'num':
        return String(n.v);
      case 'ref':
        return n.id;
      case 'neg':
        return `-${prec(n.v) < 3 ? `(${walk(n.v)})` : walk(n.v)}`;
      case 'bin': {
        const p = prec(n);
        const l = prec(n.l) < p ? `(${walk(n.l)})` : walk(n.l);
        // El lado derecho de `-` y `/` necesita paréntesis también con
        // igual precedencia: a-(b-c) ≠ a-b-c.
        const needsRight = prec(n.r) < p || (prec(n.r) === p && (n.op === '-' || n.op === '/'));
        const r = needsRight ? `(${walk(n.r)})` : walk(n.r);
        return `${l} ${n.op} ${r}`;
      }
    }
  };
  return walk(ast);
}
