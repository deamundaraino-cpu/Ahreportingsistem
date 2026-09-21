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

import { colombiaRangeBounds, colombiaToday, addDaysISO } from '../colombia-date';
import { MOTIVOS_EXCLUSION, type MotivoExclusion } from './lead-exclusion';
// `bi-valores` no importa nada —es el módulo puro de la selección— así que
// traerlo aquí no rompe la regla de arriba. De `bi-metadata` solo viene el TIPO:
// `import type` se borra al compilar, de modo que sus 2.611 líneas y sus
// dependencias NO entran en este módulo. El vocabulario de operadores es el
// mismo que el del BI a propósito: el usuario ya lee esas etiquetas allí.
import { parseSeleccion, serializarSeleccion } from './bi-valores';
import type { FilterOp } from './bi-metadata';

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

// ── Campos que admiten operador y varios valores ─────────────────────
//
// El nombre del parámetro de la URL ES el nombre de la columna, que es lo que
// permite que `aplicarFiltrosLeads` recorra la tabla sin un mapa aparte.
//
// `form_plugin` y `attribution_method` quedan FUERA a propósito: son
// desplegables cerrados de un solo valor y no ganan nada con un operador.
// `source` también queda fuera: `LEAD_FILTER_KEYS` del motor BI no lo lista
// —así que no se puede ofrecer su lista de valores— y `form_plugin` ya es el
// eje completo de origen, como razona la propia página.
export const CAMPOS_FILTRABLES = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_id',
  'ip_country',
  'form_name',
] as const;

export type CampoFiltrable = (typeof CAMPOS_FILTRABLES)[number];

/** Una condición ya interpretada. `valores` nunca está vacío. */
export type CondicionCampo = { op: FilterOp; valores: string[] };

const OPS: readonly FilterOp[] = ['eq', 'neq', 'contains', 'ncontains', 'starts', 'ends'];

/**
 * El operador por defecto de /leads es `contains`, NO `eq`.
 *
 * Diverge a propósito de `parseFilterValue` de `bi-metadata`, que cae a `eq`.
 * Esta página lleva desde siempre haciendo `ilike '%x%'` sobre estos campos, y
 * `CAMPOS_URL` ya declara que los enlaces guardados no se rompen: si un
 * `?utm_campaign=verano` pasara a significar igualdad exacta, todos los enlaces
 * que la gente tiene guardados dejarían de encontrar nada.
 *
 * La UI siempre escribe el prefijo explícito, así que la ambigüedad solo existe
 * para los enlaces viejos, que es justo a quien protege.
 */
export const OP_POR_DEFECTO: FilterOp = 'contains';

/** Separa `<op>:<selección>` en operador y valores. Sin prefijo válido → contains. */
export function parseCondicion(raw: string | null): CondicionCampo | null {
  if (!raw) return null;
  let op: FilterOp = OP_POR_DEFECTO;
  let resto = raw;
  const i = raw.indexOf(':');
  if (i > 0 && (OPS as readonly string[]).includes(raw.slice(0, i))) {
    op = raw.slice(0, i) as FilterOp;
    resto = raw.slice(i + 1);
  }
  const valores = parseSeleccion(resto);
  return valores.length > 0 ? { op, valores } : null;
}

/** La inversa de `parseCondicion`. Lo que escriben los controles del formulario. */
export function serializarCondicion(c: CondicionCampo): string {
  return `${c.op}:${serializarSeleccion(c.valores)}`;
}

// ── Presencia: «tiene dato» / «está vacío» ───────────────────────────
//
// MEDIDO el 2026-09-21 sobre las 93.415 filas de `lead_events`:
//
//     columna        NULL     = ''   solo blancos
//     utm_source     3.509      0        0
//     utm_medium     3.516      0        0
//     utm_campaign   5.330      0        0
//     utm_content    7.215      0        0
//     utm_term       7.390      0        0
//     utm_id         9.881      0        0
//     ip_country    25.439      0        0
//     form_name        262      0        0
//
// CERO cadenas vacías y CERO blancos en las ocho. O sea que «vacío» es
// exactamente `IS NULL`: un filtro plano, sin `or`, sin `neq.''` y sin tocar el
// árbol. Si algún día una ingesta empieza a escribir `''`, esta premisa deja de
// valer en silencio — por eso `verify-leads-filtros-db.ts` la vuelve a medir y
// falla si aparece una sola.
export type PresenciaCampo = 'con' | 'sin';

/**
 * Lee una lista de campos filtrables. Acepta el parámetro repetido
 * (`?con=a&con=b`, que es como lo manda un formulario con varios controles) y
 * también separado por comas, que es la forma canónica que reemite
 * `aQueryString`. Lo que no esté en la lista blanca se descarta.
 */
function campos(sp: ParamsCrudos, clave: string): CampoFiltrable[] {
  const bruto = sp instanceof URLSearchParams ? sp.getAll(clave) : sp[clave];
  const partes = (Array.isArray(bruto) ? bruto : [bruto])
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim());
  const validos = partes.filter((v): v is CampoFiltrable =>
    (CAMPOS_FILTRABLES as readonly string[]).includes(v)
  );
  return [...new Set(validos)];
}

// ── Respuestas de formulario (`raw_fields`) ──────────────────────────
//
// La clave es la que está GUARDADA, tal cual llegó: `Rango de renta`, no
// `rango_de_renta`. `lead_campos.claves_origen` guarda la forma canónica y
// `normalizarClaveLead` solo se aplica al comparar, en Node — así que un
// `raw_fields->>'rango_de_renta'` no encontraría NADA. Por eso el desplegable se
// llena desde `/api/report-utm/bi/form-fields`, que devuelve las claves crudas.
//
// Y por eso NO se filtra por el bucket del catálogo: `valores_map` funde varios
// valores crudos en uno y ese plegado se hace en Node (`bi-query.ts`), mientras
// que /leads pagina en SQL. Resolverlo aquí daría números distintos de los que
// el informe enseña para el mismo campo, que es peor que no ofrecerlo.
//
// El filtro es PLANO a propósito: un solo campo, un solo valor. Meter una clave
// JSON con espacios dentro de `or=()` exigiría un nivel de entrecomillado más
// que no está medido contra PostgREST, y este módulo no añade escapes a ojo.
const MAX_CLAVE_CAMPO = 120;

export type FiltrosLeads = {
  clienteId: string | null;
  /** Eje «Origen»: la columna es `form_plugin`. Ver PLUGIN_LABELS. */
  origen: string | null;
  // Los campos filtrables guardan el texto CRUDO de la URL: es lo que
  // `aQueryString` reemite para que el filtro sobreviva a la paginación. Lo ya
  // interpretado vive en `condiciones`, igual que `qTexto` convive con `q`.
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  utmId: string | null;
  ipCountry: string | null;
  formName: string | null;
  attributionMethod: string | null;
  /** Derivado: las condiciones ya parseadas, por columna. */
  condiciones: Partial<Record<CampoFiltrable, CondicionCampo>>;
  /** Clave cruda de `raw_fields` por la que se filtra, y su condición. */
  campo: string | null;
  campoValor: string | null;
  campoCond: CondicionCampo | null;
  /** Campos que tienen que traer dato, y campos que tienen que estar vacíos. */
  con: CampoFiltrable[];
  sin: CampoFiltrable[];
  /** Forma canónica de los dos anteriores, que es lo que reemite la URL. */
  conTexto: string | null;
  sinTexto: string | null;
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
  /** Orden de la lista. Solo por `created_at`: ver ORDENES. */
  orden: OrdenLeads;
  /** `null` cuando es el orden por defecto, para no ensuciar la URL. */
  ordenTexto: string | null;
  page: number;
};

/**
 * Órdenes posibles. SOLO por `created_at`, y no es pereza.
 *
 * El índice `(cliente_id, created_at DESC)` sirve las dos direcciones sin
 * ordenar nada. Ordenar por `lead_name` o `utm_campaign` no lo sirve ningún
 * índice: serían las 93.415 filas leídas y ordenadas en cada carga, que es
 * literalmente la consulta de la caída del 2026-09-20. Quien necesite otro
 * orden tiene el CSV.
 */
export const ORDENES = ['reciente', 'antiguo'] as const;
export type OrdenLeads = (typeof ORDENES)[number];

/** `true` si la lista va de más antiguo a más nuevo. */
export function ascendente(f: FiltrosLeads): boolean {
  return f.orden === 'antiguo';
}

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
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
  ['utm_id', 'utmId'],
  ['ip_country', 'ipCountry'],
  ['form_name', 'formName'],
  ['attribution_method', 'attributionMethod'],
  ['campo', 'campo'],
  ['campo_valor', 'campoValor'],
  ['orden', 'ordenTexto'],
  ['con', 'conTexto'],
  ['sin', 'sinTexto'],
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

/**
 * Valor EXACTO dentro de `or=()`. Solo escape de parser, NUNCA `escLike`.
 *
 * Es el hermano peligroso de `valorOr`. Un `eq` no es un patrón LIKE: ahí `%` y
 * `_` son caracteres normales, así que escaparlos los convierte en una barra
 * invertida literal que no está en el dato. Una campaña llamada `PROMO 50%`
 * dejaría de encontrarse y la respuesta sería 200 con CERO filas — el fallo
 * silencioso que este módulo ya pagó una vez con los `ilike` sin escapar.
 */
export function valorOrExacto(v: string): string {
  return `"${escOr(v)}"`;
}

/** Patrón de `empieza con`. El comodín va solo a la derecha. */
export function patronEmpieza(v: string): string {
  return `${escLike(v)}%`;
}

/** Patrón de `termina con`. El comodín va solo a la izquierda. */
export function patronTermina(v: string): string {
  return `%${escLike(v)}`;
}

/** El patrón que le toca a cada operador de subcadena. */
function patronDe(op: FilterOp, v: string): string {
  if (op === 'starts') return patronEmpieza(v);
  if (op === 'ends') return patronTermina(v);
  return patronLike(v);
}

/** Igual, pero entrecomillado para vivir dentro de `or=()`. */
function valorOrPatron(op: FilterOp, v: string): string {
  if (op === 'starts') return `"${escOr(escLike(v))}%"`;
  if (op === 'ends') return `"%${escOr(escLike(v))}"`;
  return valorOr(v);
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

  // Las condiciones se derivan de los MISMOS parámetros que los campos crudos:
  // no hay una segunda lista que se pueda desincronizar de `CAMPOS_URL`.
  const condiciones: Partial<Record<CampoFiltrable, CondicionCampo>> = {};
  for (const campo of CAMPOS_FILTRABLES) {
    const c = parseCondicion(uno(sp, campo));
    if (c) condiciones[campo] = c;
  }

  // Un campo no puede exigir dato y estar vacío a la vez. Gana `sin`, que es el
  // más restrictivo: así un enlace contradictorio devuelve poco y raro en vez de
  // devolver todo, que se confundiría con «el filtro no se aplicó».
  const orden = unoDe(sp, 'orden', ORDENES) ?? 'reciente';

  // La clave se acota en longitud y se rechaza si trae caracteres que romperían
  // el camino de `raw_fields->>clave`. No se «saneia» recortando: una clave rara
  // se descarta entera, igual que una fecha con mala forma.
  const claveBruta = uno(sp, 'campo');
  const campo =
    claveBruta && claveBruta.length <= MAX_CLAVE_CAMPO && !/[(),."\\]/.test(claveBruta)
      ? claveBruta
      : null;
  const campoValor = campo ? uno(sp, 'campo_valor') : null;
  const campoCond = parseCondicion(campoValor);

  const sinCampos = campos(sp, 'sin');
  const conCampos = campos(sp, 'con').filter((c) => !sinCampos.includes(c));

  return {
    clienteId: uno(sp, 'clienteId'),
    origen: uno(sp, 'form_plugin'),
    utmSource: uno(sp, 'utm_source'),
    utmMedium: uno(sp, 'utm_medium'),
    utmCampaign: uno(sp, 'utm_campaign'),
    utmContent: uno(sp, 'utm_content'),
    utmTerm: uno(sp, 'utm_term'),
    utmId: uno(sp, 'utm_id'),
    ipCountry: uno(sp, 'ip_country'),
    formName: uno(sp, 'form_name'),
    condiciones,
    campo,
    campoValor: campoCond ? campoValor : null,
    campoCond,
    con: conCampos,
    sin: sinCampos,
    conTexto: conCampos.length > 0 ? conCampos.join(',') : null,
    sinTexto: sinCampos.length > 0 ? sinCampos.join(',') : null,
    attributionMethod: unoDe(sp, 'attribution_method', METODOS_ATRIBUCION),
    motivo: unoDe(sp, 'motivo', Object.keys(MOTIVOS_EXCLUSION) as MotivoExclusion[]),
    from: fecha('from'),
    to: fecha('to'),
    qTexto,
    q: buscable ? qTexto : null,
    qCorto: qTexto !== null && !buscable,
    estado: unoDe(sp, 'estado', ESTADOS) ?? 'incluidos',
    orden,
    ordenTexto: orden === 'reciente' ? null : orden,
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
  /** `col is null`. Lo usa «está vacío», que está medido como NULL puro. */
  is(columna: string, valor: null): this;
  /** `col not.is.null`. Lo usa «tiene dato». */
  not(columna: string, operador: string, valor: unknown): this;
}

// ════════════════════════════════════════════════════════════════════
// Presets de fecha
// ════════════════════════════════════════════════════════════════════
//
// Los mismos nombres y las mismas ventanas que los presets del BI, para que
// «Últimos 7 días» signifique lo mismo en las dos pantallas. Van en hora
// Colombia, igual que el resto del rango, porque si esta página usara otra
// ventana su total y el del informe no cuadrarían y parecería un bug.

export type PresetFecha = { id: string; etiqueta: string; from: string; to: string };

export function presetsFecha(hoy: string = colombiaToday()): PresetFecha[] {
  const desde = (dias: number) => addDaysISO(hoy, -dias);
  return [
    { id: 'hoy', etiqueta: 'Hoy', from: hoy, to: hoy },
    { id: 'ayer', etiqueta: 'Ayer', from: desde(1), to: desde(1) },
    { id: '7d', etiqueta: '7 días', from: desde(6), to: hoy },
    { id: '30d', etiqueta: '30 días', from: desde(29), to: hoy },
    { id: '90d', etiqueta: '90 días', from: desde(89), to: hoy },
  ];
}

/** Qué preset está puesto, si es que hay alguno. */
export function presetActivo(f: FiltrosLeads, hoy: string = colombiaToday()): string | null {
  if (!f.from || !f.to) return null;
  return presetsFecha(hoy).find((p) => p.from === f.from && p.to === f.to)?.id ?? null;
}

// ════════════════════════════════════════════════════════════════════
// Chips de filtros activos
// ════════════════════════════════════════════════════════════════════

/** Un filtro puesto, con el override que lo quita. */
export type ChipFiltro = {
  /** Identificador estable para la `key` de React. */
  clave: string;
  /** Columna o parámetro al que pertenece, para poder etiquetarlo. */
  param: string;
  /** Lo que se lee en el chip. */
  texto: string;
  /** Override para `urlLeads` que borra justo este filtro y nada más. */
  quitar: Record<string, string | undefined>;
};

const ETIQUETA_OP: Record<FilterOp, string> = {
  eq: 'es',
  neq: 'no es',
  contains: 'contiene',
  ncontains: 'no contiene',
  starts: 'empieza por',
  ends: 'termina en',
};

/**
 * Los filtros puestos, cada uno con su forma de quitarlo.
 *
 * Se deriva de las mismas estructuras que la consulta, así que un filtro nuevo
 * aparece aquí solo. `clienteId` queda fuera a propósito: su desplegable está
 * siempre a la vista, y un chip para él sería ruido duplicado.
 */
export function chipsFiltros(f: FiltrosLeads): ChipFiltro[] {
  const out: ChipFiltro[] = [];
  const simple = (param: string, texto: string) =>
    out.push({ clave: param, param, texto, quitar: { [param]: undefined } });

  if (f.q) simple('q', `«${f.q}»`);
  if (f.origen) simple('form_plugin', f.origen);
  if (f.attributionMethod) simple('attribution_method', f.attributionMethod);

  for (const campo of CAMPOS_FILTRABLES) {
    const c = f.condiciones[campo];
    if (!c) continue;
    out.push({
      clave: campo,
      param: campo,
      texto: `${ETIQUETA_OP[c.op]} ${c.valores.join(' o ')}`,
      quitar: { [campo]: undefined },
    });
  }

  // La presencia vive en una lista, así que quitar un campo no borra el
  // parámetro: lo reescribe sin él.
  const sinUno = (lista: CampoFiltrable[], quitar: CampoFiltrable) =>
    lista.filter((c) => c !== quitar).join(',') || undefined;
  for (const campo of f.con) {
    out.push({
      clave: `con:${campo}`,
      param: campo,
      texto: 'tiene dato',
      quitar: { con: sinUno(f.con, campo) },
    });
  }
  for (const campo of f.sin) {
    out.push({
      clave: `sin:${campo}`,
      param: campo,
      texto: 'está vacío',
      quitar: { sin: sinUno(f.sin, campo) },
    });
  }

  if (f.from) simple('from', `desde ${f.from}`);
  if (f.to) simple('to', `hasta ${f.to}`);

  return out;
}

/**
 * ¿Hay filtros caros (presencia o respuesta de formulario) sin cliente que los acote?
 *
 * `col IS NULL` no lo sirve ningún índice, así que sobre las 93.415 filas es un
 * seq scan de 171 MB contra 224 MB de `shared_buffers`: el patrón exacto de la
 * caída del 2026-09-20. Con `cliente_id` puesto, el índice
 * `(cliente_id, created_at DESC)` acota primero y el IS NULL cae sobre unos
 * pocos miles de filas.
 *
 * La comprobación vive AQUÍ y no en el componente para que una URL escrita a
 * mano y el enlace de export tampoco puedan saltársela.
 */
export function faltaAcotarFiltrosCaros(f: FiltrosLeads): boolean {
  const caros = f.con.length > 0 || f.sin.length > 0 || (f.campo !== null && f.campoCond !== null);
  return caros && !f.clienteId;
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
// ════════════════════════════════════════════════════════════════════
// El árbol lógico
// ════════════════════════════════════════════════════════════════════
//
// Todo lo disyuntivo viaja dentro de UN SOLO `or=()`, con un único hijo raíz:
//
//   or=(and( or(lead_name.ilike."%ana%",…),
//            or(utm_source.eq."facebook",utm_source.eq."instagram") ))
//
// Tres razones, y las tres son caras de aprender por las malas:
//
//   1. Manda UNA sola petición con UNA sola cláusula lógica, así que no depende
//      de cómo combine PostgREST varios `or=` repetidos. `.or()` de supabase-js
//      hace `searchParams.append`, o sea que dos llamadas producen `or=…&or=…`
//      y su semántica habría que medirla. Con un solo árbol, da igual.
//   2. Un único camino de escape, que es la doctrina que este módulo ya declara
//      más arriba. Mezclar los dos niveles es el error que no se ve.
//   3. `QueryPostgrest` no necesita `in`, `is` ni `not`: todo lo disyuntivo es
//      texto dentro del string. El espía del verify sigue valiendo tal cual.
//
// NO se usa `.in()` de supabase-js: entrecomilla sin escapar `"` ni `\`, y en
// esta base hay 717 nombres de entidad con coma.

/**
 * El nodo de una condición, o `null` si se resuelve como filtro plano.
 *
 * ── La trampa de NULL ────────────────────────────────────────────────
 * `col <> 'x'` y `NOT (col ILIKE …)` valen NULL cuando la columna es NULL, y
 * PostgREST descarta las filas cuya condición no es verdadera. Sin el
 * `col.is.null` de delante, «utm_source no es instagram» se dejaría fuera justo
 * los leads SIN utm_source — que son precisamente los que se está buscando.
 */
function nodoDeCondicion(col: CampoFiltrable, c: CondicionCampo | undefined): string | null {
  if (!c) return null;
  const { op, valores } = c;

  // Los positivos de un solo valor salen como filtro plano: es el 95 % del uso,
  // se lee mejor en los logs de PostgREST y el plan es idéntico.
  if (valores.length === 1 && op !== 'neq' && op !== 'ncontains') return null;

  const unidos = (partes: string[]) => partes.join(',');

  if (op === 'eq') {
    return `or(${unidos(valores.map((v) => `${col}.eq.${valorOrExacto(v)}`))})`;
  }
  if (op === 'neq') {
    return `or(${col}.is.null,and(${unidos(valores.map((v) => `${col}.neq.${valorOrExacto(v)}`))}))`;
  }
  if (op === 'ncontains') {
    return `or(${col}.is.null,and(${unidos(valores.map((v) => `${col}.not.ilike.${valorOr(v)}`))}))`;
  }
  // contains / starts / ends con varios valores: basta con que coincida uno.
  return `or(${unidos(valores.map((v) => `${col}.ilike.${valorOrPatron(op, v)}`))})`;
}

/** Los nodos que se unen por Y dentro del único `or=`. */
function nodosLogicos(f: FiltrosLeads): string[] {
  const nodos: string[] = [];
  const busqueda = cadenaOrBusqueda(f.q);
  if (busqueda) nodos.push(`or(${busqueda})`);
  for (const campo of CAMPOS_FILTRABLES) {
    const nodo = nodoDeCondicion(campo, f.condiciones[campo]);
    if (nodo) nodos.push(nodo);
  }
  return nodos;
}

/**
 * El árbol completo para `.or()`, o `null` si no hay nada disyuntivo.
 *
 * Con un solo nodo se desenvuelve el `or(...)` exterior: así una búsqueda sin
 * más filtros genera EXACTAMENTE la misma cadena que antes de existir el árbol,
 * que es la que está medida contra PostgREST real en el verify.
 */
export function arbolFiltros(f: FiltrosLeads): string | null {
  const nodos = nodosLogicos(f);
  if (nodos.length === 0) return null;
  if (nodos.length === 1 && nodos[0].startsWith('or(')) return nodos[0].slice(3, -1);
  return `and(${nodos.join(',')})`;
}

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

  // Filtros planos: un solo valor y operador positivo. `cliente_id` y el rango
  // siguen siendo planos siempre, que es lo que deja al índice
  // `(cliente_id, created_at DESC)` dirigiendo el plan; el árbol de abajo es un
  // filtro de heap sobre lo que ese índice ya acotó.
  for (const campo of CAMPOS_FILTRABLES) {
    const c = f.condiciones[campo];
    if (!c || c.valores.length !== 1 || c.op === 'neq' || c.op === 'ncontains') continue;
    const v = c.valores[0];
    q = c.op === 'eq' ? q.eq(campo, v) : q.ilike(campo, patronDe(c.op, v));
  }

  // Presencia. Los dos lados son filtros planos porque el vacío está medido como
  // NULL puro: ni disyunción ni `neq.''`. Ver la tabla de arriba.
  for (const campo of f.con) q = q.not(campo, 'is', null);
  for (const campo of f.sin) q = q.is(campo, null);

  // Respuesta de formulario. Un solo campo y un solo valor, como filtro plano:
  // así la clave JSON no tiene que entrar en el árbol `or=()`, que exigiría un
  // entrecomillado más que no está medido.
  if (f.campo && f.campoCond) {
    const columna = `raw_fields->>${f.campo}`;
    const v = f.campoCond.valores[0];
    const op = f.campoCond.op;
    if (op === 'eq') q = q.eq(columna, v);
    else if (op === 'neq') q = q.not(columna, 'eq', v);
    else if (op === 'ncontains') q = q.not(columna, 'ilike', patronLike(v));
    else q = q.ilike(columna, patronDe(op, v));
  }

  // Día calendario Colombia, igual que el motor del BI: si esta página usara otra
  // ventana, su total y el del informe no cuadrarían y parecería un bug.
  const rango = rangoColombia(f);
  if (rango.gte) q = q.gte('created_at', rango.gte);
  if (rango.lt) q = q.lt('created_at', rango.lt);

  // UNA sola llamada, con el buscador y las condiciones disyuntivas dentro.
  const arbol = arbolFiltros(f);
  if (arbol) q = q.or(arbol);

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
