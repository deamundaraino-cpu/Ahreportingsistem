/**
 * ¿Qué puede pedir un visitante de un informe PÚBLICO?
 *
 * El token de un informe compartido es la credencial, y hasta la auditoría del
 * 2026-09-26 solo acotaba el cliente, las fechas y los filtros guardados: el
 * resto de la consulta la decidía el visitante. Así, un
 * `?type=standard&dimension=field:email` agrupaba los leads por su correo y
 * devolvía la lista de correos del cliente con su recuento, aunque ningún
 * widget del informe la mostrara.
 *
 * La regla: todo lo que ABRE filas (dimensión, dimensión secundaria) o las
 * RECORTA por un valor de formulario (filtro por `field:`, `leadfield:` o campo
 * de Sheet) tiene que aparecer en el propio informe —en algún widget, slicer o
 * filtro guardado—. Las métricas no abren filas: devuelven números agregados, y
 * se dejan pasar para no romper los campos calculados que viajan en la URL.
 *
 * Puro, para comprobarlo desde `scripts/verify-bi-publico-seguridad.ts`.
 */

/** Dimensiones que no exponen ningún valor de un lead. */
const DIMENSIONES_SIEMPRE = new Set(['none', 'date']);

/** Prefijos de las claves que leen un valor escrito en un formulario o un Sheet. */
const PREFIJOS_SENSIBLES = ['field:', 'leadfield:', 'sheetdim:'];

function esSensible(clave: string): boolean {
  return PREFIJOS_SENSIBLES.some((p) => clave.startsWith(p));
}

/** Todas las cadenas que aparecen en cualquier parte de un JSON. */
export function cadenasDe(valor: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof valor === 'string') {
    out.add(valor);
    // Un filtro avanzado guardado viaja serializado como texto dentro de
    // `filters.__adv`: sus campos también cuentan como «del informe».
    if (valor.startsWith('{') || valor.startsWith('[')) {
      try {
        cadenasDe(JSON.parse(valor), out);
      } catch {
        /* no era JSON */
      }
    }
  } else if (Array.isArray(valor)) {
    for (const v of valor) cadenasDe(v, out);
  } else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      out.add(k);
      cadenasDe(v, out);
    }
  }
  return out;
}

export interface ConsultaPublica {
  dimension?: string;
  dimension2?: string;
  filters?: Record<string, string>;
  advancedFilter?: { groups?: { conditions?: { field?: string }[] }[] };
}

/**
 * null si la consulta está permitida; si no, el motivo (para el log, no para el
 * visitante).
 */
export function motivoConsultaNoPermitida(
  consulta: ConsultaPublica,
  informe: { layout: unknown; filters: unknown }
): string | null {
  const delInforme = cadenasDe([informe.layout, informe.filters]);
  const conocida = (k: string) => delInforme.has(k);

  // Solo las dimensiones que leen un valor ESCRITO en un formulario o un Sheet:
  // las columnas fijas (source, campaña, país…) no son datos personales, y varios
  // widgets piden una por defecto sin tenerla guardada (la tabla, `utm_source`).
  for (const d of [consulta.dimension, consulta.dimension2]) {
    if (!d || DIMENSIONES_SIEMPRE.has(d) || !esSensible(d)) continue;
    if (!conocida(d)) return `dimensión no usada por el informe: ${d}`;
  }
  for (const k of Object.keys(consulta.filters ?? {})) {
    if (esSensible(k) && !conocida(k)) return `filtro no usado por el informe: ${k}`;
  }
  for (const g of consulta.advancedFilter?.groups ?? []) {
    for (const c of g.conditions ?? []) {
      const f = c.field ?? '';
      if (f && esSensible(f) && !conocida(f)) return `filtro no usado por el informe: ${f}`;
    }
  }
  return null;
}
