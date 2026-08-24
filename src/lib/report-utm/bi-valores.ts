/**
 * Valores de una dimensión, con su recuento — motor puro.
 *
 * ── Qué problema resuelve ────────────────────────────────────────────────
 * Para filtrar por una campaña había que ESCRIBIR su nombre a mano. Con una
 * campaña llamada `[ÑUÑOA][CAPTACIÓN LEADS][FORM][ABO][NOV]` eso significa
 * acordarse de los acentos y los corchetes; si te equivocas el widget sale
 * vacío y no hay forma de distinguir «el filtro está mal escrito» de «no hay
 * datos».
 *
 * Este módulo es la mitad pura de la solución: dado un conjunto de valores
 * crudos con su frecuencia, decide cuáles se muestran, en qué orden y cómo se
 * serializa la selección. La mitad que toca la base vive en `bi-query.ts`
 * (`runValores`), donde ya están el resolver de campañas y los filtros.
 *
 * Client-safe: sin imports de servidor. Lo usan el motor y el selector.
 */

// Este módulo NO importa nada, ni siquiera tipos de `bi-metadata`.
//
// Es a propósito: `bi-metadata` necesita `parseSeleccion` para leer los filtros
// guardados, así que la dependencia va en ese sentido. Si además se importara
// `FilterOp` desde allí habría un ciclo.

/** Un valor distinto y cuántas filas lo tienen. */
export interface ValorConConteo {
  valor: string;
  n: number;
}

/**
 * Por qué una lista vino vacía.
 *
 * Existe porque una lista vacía sin motivo es indistinguible de «no hay
 * valores», y esa confusión ya costó un fallo real en este proyecto: un error
 * de consulta se tradujo a «esta fuente no tiene datos» sobre un cliente con
 * 34.745 leads. Misma doctrina que `lib/fx.ts`: donde no se puede saber, se
 * dice que no se puede saber.
 */
export type MotivoSinValores =
  'sin_cliente' | 'dimension_no_listable' | 'error_consulta' | 'timeout';

export interface ResultadoValores {
  valores: ValorConConteo[];
  /** Valores distintos totales. Con búsqueda activa, cuántos coinciden. */
  total: number;
  /** `true` si `total` supera lo devuelto: hay más de los que se ven. */
  truncado: boolean;
  /** Presente SOLO si la lista está vacía por un motivo concreto. */
  motivo?: MotivoSinValores;
}

/** Resultado vacío con su causa. Nunca se devuelve `[]` a secas. */
export function sinValores(motivo: MotivoSinValores): ResultadoValores {
  return { valores: [], total: 0, truncado: false, motivo };
}

/** Resultado vacío legítimo: se consultó y de verdad no hay nada. */
export const VACIO_HONESTO: ResultadoValores = { valores: [], total: 0, truncado: false };

// ════════════════════════════════════════════════════════════════════════
// Plegado y orden
// ════════════════════════════════════════════════════════════════════════

/**
 * Suma los conteos de los valores crudos que caen en la misma etiqueta.
 *
 * Es lo que permite que SQL agrupe por el valor CRUDO (barato, indexable) y
 * Node aplique después la etiqueta real: el bucket de un campo de lead, o el
 * nombre de campaña que sale de la cascada del resolver. Dos crudos distintos
 * que resuelven a lo mismo tienen que sumar, no competir.
 *
 * `etiquetar` devuelve `null` para descartar la fila (un valor que el
 * bucketizador ignora, un UTM que no cruza con ninguna entidad).
 */
export function plegarConteos(
  filas: readonly ValorConConteo[],
  etiquetar: (valor: string) => string | null
): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of filas) {
    const etiqueta = etiquetar(f.valor);
    if (etiqueta === null || etiqueta === '') continue;
    out.set(etiqueta, (out.get(etiqueta) ?? 0) + f.n);
  }
  return out;
}

/**
 * Ordena por frecuencia descendente, con desempate alfabético estable.
 *
 * `ordenFijo` invierte la regla: cuando el analista definió el orden de los
 * buckets («1-10, 11-20, 20-100»), ese orden MANDA aunque el conteo diga otra
 * cosa. Reordenar esos por frecuencia destruiría la información que alguien se
 * molestó en declarar; el recuento se sigue mostrando, simplemente no ordena.
 */
export function ordenarPorFrecuencia(
  conteos: Map<string, number>,
  ordenFijo?: readonly string[]
): ValorConConteo[] {
  const arr: ValorConConteo[] = [...conteos].map(([valor, n]) => ({ valor, n }));

  if (ordenFijo && ordenFijo.length > 0) {
    const pos = (v: string) => {
      const i = ordenFijo.indexOf(v);
      return i === -1 ? ordenFijo.length : i;
    };
    return arr.sort((a, b) => pos(a.valor) - pos(b.valor) || a.valor.localeCompare(b.valor));
  }

  return arr.sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor));
}

/**
 * Recorta a `limite` conservando el total real.
 *
 * El total viaja aparte a propósito: decir «los 50 más frecuentes de 648» es
 * una respuesta útil; devolver 50 sin más hace creer que son todos. El truncado
 * anterior era peor todavía —una página sin `ORDER BY`, así que qué valores
 * llegaban era indefinido— y esto es justo lo que lo sustituye.
 */
export function recortar(valores: ValorConConteo[], limite: number): ResultadoValores {
  const total = valores.length;
  if (limite <= 0 || total <= limite) {
    return { valores, total, truncado: false };
  }
  return { valores: valores.slice(0, limite), total, truncado: true };
}

/** Proyección al contrato histórico: solo los nombres, en el mismo orden. */
export function aValoresPlanos(r: ResultadoValores): string[] {
  return r.valores.map((v) => v.valor);
}

// ════════════════════════════════════════════════════════════════════════
// Serialización de la selección
// ════════════════════════════════════════════════════════════════════════
//
// Los filtros se guardan como texto separado por comas (`filters[dim] =
// "a,b,c"`) y se leen con `split(',')` en cuatro sitios. Eso rompe cualquier
// valor que CONTENGA una coma, y en los datos actuales hay 717 nombres de
// entidad así — por ejemplo `[VIDEOS_11,12Y13][ABIERTO][25-55][CHILE][HM]`.
//
// Hoy casi no se nota porque nadie escribe eso a mano. En cuanto se puede
// marcar en una lista, deja de ser teórico: el filtro se parte en dos trozos
// que no coinciden con nada y el widget sale vacío sin explicar por qué.
//
// La solución es escapar SOLO la coma (`\,`). Un valor sin escapes se lee
// exactamente igual que antes, así que los informes ya guardados siguen
// funcionando — condición que `verify-bi-valores.ts` comprueba con casos
// reales. Se verificó además que ninguno de los 19 informes guardados contiene
// hoy la secuencia `\,`.

const ESCAPE_COMA = '\\,';

/**
 * Parte una selección guardada en sus valores.
 *
 * Solo `\,` es un escape. Cualquier otra barra invertida es un carácter normal,
 * de modo que un valor como `C:\ruta,otro` se sigue partiendo en dos igual que
 * hoy. Eso es lo que hace el cambio compatible hacia atrás.
 */
export function parseSeleccion(raw: string | null | undefined): string[] {
  const s = String(raw ?? '');
  if (!s) return [];

  const out: string[] = [];
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === ',') {
      actual += ',';
      i++;
      continue;
    }
    if (s[i] === ',') {
      out.push(actual);
      actual = '';
      continue;
    }
    actual += s[i];
  }
  out.push(actual);

  return out.map((v) => v.trim()).filter(Boolean);
}

/** Serializa una selección, escapando las comas de los propios valores. */
export function serializarSeleccion(valores: readonly string[]): string {
  return valores
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.split(',').join(ESCAPE_COMA))
    .join(',');
}

/** ¿Este valor necesita escaparse para caber en el formato guardado? */
export function tieneComa(valor: string): boolean {
  return valor.includes(',');
}

/**
 * ¿Este operador admite elegir de una lista de casillas?
 *
 * Solo los de pertenencia. «contiene ∈ {a, b, c}» no significa nada: un
 * operador de subcadena se aplica a UN texto, y ofrecer valores exactos ahí
 * invitaría a construir un filtro que no hace lo que parece.
 */
export function esSeleccionPorCasillas(op: string): boolean {
  return op === 'eq' || op === 'neq';
}

// ════════════════════════════════════════════════════════════════════════
// Presentación
// ════════════════════════════════════════════════════════════════════════

/**
 * Une lo seleccionado con lo listado, dejando arriba lo que está marcado.
 *
 * Sin esto, abrir el panel de un filtro guardado sobre un valor que ya no está
 * entre los más frecuentes del rango y tocar cualquier cosa lo borraría en
 * silencio. Los seleccionados que no aparecen en la lista se marcan con
 * `n: null` — no es que valgan cero, es que no se sabe cuántos hay.
 */
export interface FilaSelector {
  valor: string;
  /** `null` = seleccionado pero fuera de la lista consultada. */
  n: number | null;
  marcado: boolean;
}

export function componerFilas(
  listados: readonly ValorConConteo[],
  seleccionados: readonly string[]
): FilaSelector[] {
  const sel = new Set(seleccionados);
  const vistos = new Set<string>();

  const filas: FilaSelector[] = [];
  // Primero los seleccionados que NO están en la lista: son los que se
  // perderían al guardar si no se representaran.
  for (const v of seleccionados) {
    if (listados.some((l) => l.valor === v)) continue;
    filas.push({ valor: v, n: null, marcado: true });
    vistos.add(v);
  }
  for (const l of listados) {
    if (vistos.has(l.valor)) continue;
    filas.push({ valor: l.valor, n: l.n, marcado: sel.has(l.valor) });
  }
  return filas;
}

/** Alterna un valor dentro de una selección ya serializada. */
export function alternarValor(seleccionActual: string, valor: string): string {
  const actuales = parseSeleccion(seleccionActual);
  const i = actuales.indexOf(valor);
  if (i === -1) return serializarSeleccion([...actuales, valor]);
  return serializarSeleccion(actuales.filter((_, k) => k !== i));
}
