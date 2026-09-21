/**
 * Filtros de la página de leads — la ÚNICA copia.
 *
 * Existían dos: la closure `aplicarFiltros` de `src/app/(app)/leads/page.tsx` y el
 * `applyFilters` de `src/app/api/report-utm/leads/export/route.ts`. Eran la misma
 * lógica escrita dos veces y ya habían divergido: la página recortaba el rango con
 * `colombiaRangeBounds` (día calendario Colombia) y el CSV mandaba literales SIN
 * zona, que Postgres lee en UTC. El export metía 5 h de más al principio del rango
 * y perdía las 5 últimas — el mismo bug que `colombia-date.ts` documenta haber
 * medido en el 26,9 % de los leads.
 *
 * De ahí las dos reglas de este módulo:
 *
 *   1. Nadie más construye una consulta de `lead_events`. Ni la página, ni el
 *      export, ni lo que venga. `scripts/verify-leads-filtros.ts` lo comprueba
 *      leyendo los dos fuentes y exigiendo que no tengan `.ilike(` propios.
 *   2. La lista de parámetros de la URL vive aquí (`PARAMS_LEADS`). Antes estaba
 *      escrita tres veces —lista blanca en `buildUrl`, lista negra en el enlace de
 *      export, condición en `hasFilters`— y un filtro nuevo se caía de una de las
 *      tres según en cuál te olvidaras. El síntoma clásico: filtras, pasas a la
 *      página 2 y vuelve la lista completa.
 *
 * Es puro a propósito —sin `server-only`, sin Supabase, sin `date-fns`— para que
 * se pueda comprobar sin base de datos, igual que `lead-exclusion.ts`.
 */

import { colombiaRangeBounds } from '../colombia-date';
import { MOTIVOS_EXCLUSION, type MotivoExclusion } from './lead-exclusion';

/** Pestañas de la página. `incluidos` = lo que cuenta en los informes. */
export type EstadoLeads = 'incluidos' | 'excluidos' | 'todos';

const ESTADOS: EstadoLeads[] = ['incluidos', 'excluidos', 'todos'];

/** Valores del CHECK de `lead_events.attribution_method` (migración 030). */
export const METODOS_ATRIBUCION = ['click_id', 'visitor_cookie', 'utm_only', 'none'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── El buscador ──────────────────────────────────────────────────────
//
// Con menos de 3 caracteres pg_trgm no puede extraer ningún trigrama completo del
// patrón `%ab%`, así que el índice GIN degenera en recorrer la tabla entera con
// recheck: peor que no tenerlo. Por debajo de ese mínimo NO se busca, pero se
// mantiene lo tecleado (`qTexto`) y se avisa en la UI (`qCorto`); ignorarlo en
// silencio haría que el usuario viera la lista completa y creyera que son
// resultados.
export const MIN_BUSQUEDA = 3;
export const MAX_BUSQUEDA = 64;

/** Columnas sobre las que busca `?q=`. La migración 086 indexa estas tres. */
export const COLUMNAS_BUSQUEDA = ['lead_name', 'lead_email', 'lead_phone'] as const;

export type FiltrosLeads = {
  clienteId: string | null;
  /** Eje «Origen»: la columna es `form_plugin`. Ver PLUGIN_LABELS. */
  origen: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  formName: string | null;
  attributionMethod: string | null;
  /** Solo se aplica en la pestaña «Excluidos». */
  motivo: MotivoExclusion | null;
  /** yyyy-MM-dd ya validado; lo que no tenga esa forma se descarta. */
  from: string | null;
  to: string | null;
  /** Lo tecleado, para el input y la URL. */
  qTexto: string | null;
  /** El término que se busca de verdad. `null` si es más corto que MIN_BUSQUEDA. */
  q: string | null;
  /** Tecleó algo, pero demasiado corto para buscar. */
  qCorto: boolean;
  estado: EstadoLeads;
  page: number;
};

/**
 * Parámetros de la URL ↔ campo de `FiltrosLeads`.
 *
 * `aQueryString` se deriva de esta tabla, así que dar de alta un filtro aquí basta
 * para que sobreviva a la paginación, al cambio de pestaña y al enlace de export.
 * Los nombres de parámetro se conservan (`form_plugin`, no `origen`) para no
 * romper los enlaces que la gente ya tenga guardados.
 */
const CAMPOS_URL: readonly (readonly [string, keyof FiltrosLeads])[] = [
  ['clienteId', 'clienteId'],
  ['form_plugin', 'origen'],
  ['utm_source', 'utmSource'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['form_name', 'formName'],
  ['attribution_method', 'attributionMethod'],
  ['motivo', 'motivo'],
  ['q', 'qTexto'],
  ['from', 'from'],
  ['to', 'to'],
] as const;

/** Todas las claves que entiende `/leads`, incluidas las que no son de filtro. */
export const PARAMS_LEADS: readonly string[] = [
  ...CAMPOS_URL.map(([param]) => param),
  'estado',
  'page',
];

// ════════════════════════════════════════════════════════════════════
// Escapes
// ════════════════════════════════════════════════════════════════════
//
// Hay DOS niveles de escape y se parecen lo bastante como para confundirlos. La
// diferencia está medida con peticiones reales a PostgREST:
//
//   · En un filtro normal (`col=ilike.valor`) las comillas dobles son caracteres
//     LITERALES. `nombre=ilike."%a%"` devuelve 200 con CERO filas, no un error.
//   · Dentro de `or=(...)` las comillas SÍ son quoting, y ahí hacen falta: una
//     coma sin comillas rompe la gramática con un 400 PGRST100.
//
// Por eso el buscador usa `.or()` SIEMPRE, aunque busque en una sola columna: un
// único camino de escape es la única forma de no mezclarlos. Mezclarlos es el
// error caro, porque el buscador «funciona» y no encuentra nada.

/** Escapa los comodines de LIKE. Nivel Postgres. */
export function escLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Patrón `%…%` para un `.ilike()` normal. SIN comillas: ahí serían literales.
 *
 * Los `ilike` de la página y del export no escapaban nada, así que buscar `50%`
 * en una campaña se comportaba como comodín y devolvía de más.
 */
export function patronLike(v: string): string {
  return `%${escLike(v)}%`;
}

/** Escapa para el parser de PostgREST. Solo válido dentro de `or=()`/`and=()`. */
function escOr(v: string): string {
  return v.replace(/["\\]/g, (m) => `\\${m}`);
}

/**
 * Valor entrecomillado y escapado para un disyunto de `.or()`.
 *
 * El orden importa y no es simétrico: primero LIKE, luego el parser. Medido, un
 * `%` literal necesita EXACTAMENTE dos barras (`\\%`); con una, el parser se la
 * come y vuelve a ser comodín. Al revés, las barras que mete `escLike` se
 * duplicarían mal y `100%` acabaría buscando una barra.
 */
export function valorOr(v: string): string {
  return `"%${escOr(escLike(v))}%"`;
}

/** ¿Parece un teléfono tecleado a mano? (`+57 300 123 45 67`, `(300) 1234567`) */
function pareceTelefono(q: string): boolean {
  return /^[\d+\s().-]+$/.test(q) && (q.match(/\d/g)?.length ?? 0) >= MIN_BUSQUEDA;
}

/**
 * El grupo `or` del buscador, o `null` si no hay nada que buscar.
 *
 * El 31 % de los teléfonos guardados empiezan por `+57` y el usuario los teclea
 * con espacios, así que cuando el término parece un teléfono se añade un disyunto
 * más con solo los dígitos.
 */
export function cadenaOrBusqueda(q: string | null): string | null {
  if (!q) return null;
  const valor = valorOr(q);
  const partes: string[] = COLUMNAS_BUSQUEDA.map((col) => `${col}.ilike.${valor}`);
  if (pareceTelefono(q)) {
    const digitos = q.replace(/\D/g, '');
    if (digitos && digitos !== q) partes.push(`lead_phone.ilike.${valorOr(digitos)}`);
  }
  return partes.join(',');
}

// ════════════════════════════════════════════════════════════════════
// Lectura de la URL
// ════════════════════════════════════════════════════════════════════

export type ParamsCrudos = Record<string, string | string[] | undefined> | URLSearchParams;

/**
 * Un parámetro, ya recortado. `?q=a&q=b` llega como ARRAY aunque el tipo de Next
 * diga `string`; sin normalizarlo se colaría una coma en la cadena `or`.
 */
function uno(sp: ParamsCrudos, clave: string): string | null {
  const bruto = sp instanceof URLSearchParams ? sp.get(clave) : sp[clave];
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  const limpio = typeof valor === 'string' ? valor.trim() : '';
  return limpio === '' ? null : limpio;
}

function unoDe<T extends string>(sp: ParamsCrudos, clave: string, validos: readonly T[]): T | null {
  const v = uno(sp, clave);
  return v && (validos as readonly string[]).includes(v) ? (v as T) : null;
}

/** Normaliza los searchParams crudos. Es el único sitio que los interpreta. */
export function leerFiltros(sp: ParamsCrudos): FiltrosLeads {
  const fecha = (clave: string): string | null => {
    const v = uno(sp, clave);
    return v && ISO_DATE.test(v) ? v : null;
  };

  // `*` no es escapable: PostgREST lo convierte en `%` dentro y fuera de comillas.
  // Como ya envolvemos el término en `%…%`, quitarlo no le resta nada al usuario.
  const bruto = uno(sp, 'q');
  const qTexto = bruto ? bruto.replace(/\*/g, '').trim().slice(0, MAX_BUSQUEDA) || null : null;
  const buscable = qTexto !== null && qTexto.length >= MIN_BUSQUEDA;

  return {
    clienteId: uno(sp, 'clienteId'),
    origen: uno(sp, 'form_plugin'),
    utmSource: uno(sp, 'utm_source'),
    utmCampaign: uno(sp, 'utm_campaign'),
    utmContent: uno(sp, 'utm_content'),
    formName: uno(sp, 'form_name'),
    attributionMethod: unoDe(sp, 'attribution_method', METODOS_ATRIBUCION),
    motivo: unoDe(sp, 'motivo', Object.keys(MOTIVOS_EXCLUSION) as MotivoExclusion[]),
    from: fecha('from'),
    to: fecha('to'),
    qTexto,
    q: buscable ? qTexto : null,
    qCorto: qTexto !== null && !buscable,
    estado: unoDe(sp, 'estado', ESTADOS) ?? 'incluidos',
    page: Math.max(1, parseInt(uno(sp, 'page') ?? '1', 10) || 1),
  };
}

/** ¿Hay algo que «Limpiar»? Incluye la pestaña, que antes no contaba. */
export function hayFiltros(f: FiltrosLeads): boolean {
  return CAMPOS_URL.some(([, campo]) => f[campo] !== null) || f.estado !== 'incluidos';
}

/**
 * Reconstruye la query string desde los filtros. `override` cambia o borra claves
 * sueltas (`{ page: undefined }` para volver a la primera página).
 *
 * Sustituye a la vez al `buildUrl` de la página y al armado del enlace de export,
 * que tenían listas de claves distintas.
 */
export function aQueryString(
  f: FiltrosLeads,
  override: Record<string, string | undefined> = {}
): string {
  const base: Record<string, string> = {};
  for (const [param, campo] of CAMPOS_URL) {
    const v = f[campo];
    if (typeof v === 'string' && v !== '') base[param] = v;
  }
  if (f.estado !== 'incluidos') base.estado = f.estado;
  if (f.page > 1) base.page = String(f.page);

  const fusion: Record<string, string | undefined> = { ...base, ...override };
  return Object.entries(fusion)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
}

/** `/leads?…` listo para un `<Link>`. */
export function urlLeads(
  f: FiltrosLeads,
  override: Record<string, string | undefined> = {}
): string {
  const qs = aQueryString(f, override);
  return `/leads${qs ? `?${qs}` : ''}`;
}

/** El enlace de exportación con los mismos filtros. Nunca lleva `page`. */
export function urlExport(f: FiltrosLeads): string {
  const qs = aQueryString(f, { page: undefined });
  return `/api/report-utm/leads/export${qs ? `?${qs}` : ''}`;
}

// ════════════════════════════════════════════════════════════════════
// Aplicación a una consulta
// ════════════════════════════════════════════════════════════════════

/**
 * Lo mínimo de un builder de PostgREST que necesitan los filtros.
 *
 * Es una interfaz estructural y no `any` a propósito: así el script de
 * verificación puede pasarle un objeto espía que grabe las llamadas y demostrar
 * SIN base de datos que la página y el export generan la misma consulta.
 */
export interface QueryPostgrest {
  eq(columna: string, valor: unknown): this;
  ilike(columna: string, patron: string): this;
  gte(columna: string, valor: string): this;
  lt(columna: string, valor: string): this;
  or(filtros: string): this;
}

/**
 * Límites del rango en hora Colombia. Mantiene el comportamiento de la página:
 * `from` suelto no pone techo y `to` suelto no pone suelo.
 */
export function rangoColombia(f: FiltrosLeads): { gte: string | null; lt: string | null } {
  if (!f.from && !f.to) return { gte: null, lt: null };
  const limites = colombiaRangeBounds(f.from ?? f.to!, f.to ?? f.from!);
  return { gte: f.from ? limites.gte : null, lt: f.to ? limites.lt : null };
}

/**
 * Aplica los filtros a cualquier consulta de `lead_events`.
 *
 * `conEstado: false` deja fuera la pestaña para poder contar los excluidos con el
 * resto de filtros puestos. `conExclusion` es lo que devuelve
 * `columnaExcluidoDisponible()`: sin la migración 079 la columna no existe y
 * tocarla tumbaría la consulta entera.
 */
export function aplicarFiltrosLeads<T>(
  builder: T,
  f: FiltrosLeads,
  o: { conExclusion: boolean; conEstado: boolean }
): T {
  // El genérico va suelto y el casteo ocurre AQUÍ, una vez. Los builders de
  // supabase-js tipan `eq` contra las columnas inferidas de la fila, y con un
  // `select` armado en tiempo de ejecución esa inferencia no existe: exigir
  // `T extends QueryPostgrest` obligaría a un `any` en cada punto de llamada.
  // Así el espía del verify sigue encajando y la página y el export quedan
  // limpios.
  let q = builder as QueryPostgrest;

  if (f.clienteId) q = q.eq('cliente_id', f.clienteId);
  if (f.origen) q = q.eq('form_plugin', f.origen);
  if (f.attributionMethod) q = q.eq('attribution_method', f.attributionMethod);
  if (f.utmSource) q = q.ilike('utm_source', patronLike(f.utmSource));
  if (f.utmCampaign) q = q.ilike('utm_campaign', patronLike(f.utmCampaign));
  if (f.utmContent) q = q.ilike('utm_content', patronLike(f.utmContent));
  if (f.formName) q = q.ilike('form_name', patronLike(f.formName));

  // Día calendario Colombia, igual que el motor del BI: si esta página usara otra
  // ventana, su total y el del informe no cuadrarían y parecería un bug.
  const rango = rangoColombia(f);
  if (rango.gte) q = q.gte('created_at', rango.gte);
  if (rango.lt) q = q.lt('created_at', rango.lt);

  const busqueda = cadenaOrBusqueda(f.q);
  if (busqueda) q = q.or(busqueda);

  // Por defecto se ve lo que CUENTA: así el total de esta página y el del informe
  // coinciden.
  if (o.conExclusion && o.conEstado) {
    if (f.estado === 'incluidos') q = q.eq('excluido', false);
    if (f.estado === 'excluidos') q = q.eq('excluido', true);
  }
  // El motivo solo tiene sentido sobre los excluidos.
  if (o.conExclusion && o.conEstado && f.estado === 'excluidos' && f.motivo) {
    q = q.eq('excluido_motivo', f.motivo);
  }
  return q as T;
}
