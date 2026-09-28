/**
 * Regla de exclusión de leads — la ÚNICA copia.
 *
 * Un lead excluido se guarda igual en `report_utm.lead_events`, pero con
 * `excluido = true`: no cuenta en `leads_count`, en el CPL, en las respuestas ni
 * en el cruce. Se decidió marcar y no descartar (reunión del 2026-09-08) porque
 * así el filtro es auditable, reversible y aplicable al histórico sin volver a
 * pedir nada a GHL o a Meta.
 *
 * La usan los tres caminos de ingesta (GoHighLevel, Meta Lead Ads, S2S) y el
 * script de reclasificación del histórico. Si alguno evaluara la regla por su
 * cuenta, un mismo contacto contaría o no según por dónde entró.
 *
 * Es pura a propósito: sin Postgres ni imports de servidor, se comprueba en
 * `scripts/verify-lead-exclusion.ts`.
 */

// ── Condiciones ──────────────────────────────────────────────────────
//
// Hasta la v1 la regla eran dos listas fijas (fuentes exactas y fragmentos de
// formulario). Desde la v2 es una lista de condiciones «campo + operador +
// valores»: si un lead cumple CUALQUIERA, no cuenta. Las dos listas viejas se
// leen como condiciones (`leerRegla`), así que ningún cliente cambia de
// resultado por la migración de formato.

/**
 * Qué se puede mirar de un lead, con su etiqueta y el motivo que se guarda.
 *
 * El motivo va por FAMILIA de campo, no por condición: `excluido_motivo` es la
 * columna por la que filtra /leads y tiene que seguir siendo un conjunto
 * pequeño y estable. `utm_source` y `form_name` conservan los motivos de la v1
 * para que reaplicar la regla convertida no «mueva» los leads ya excluidos.
 */
export const CAMPOS_REGLA = {
  utm_campaign: { etiqueta: 'Campaña', motivo: 'campana_excluida' },
  utm_term: { etiqueta: 'Conjunto de anuncios', motivo: 'campana_excluida' },
  utm_content: { etiqueta: 'Anuncio', motivo: 'campana_excluida' },
  utm_source: { etiqueta: 'Fuente (utm_source)', motivo: 'source_excluida' },
  utm_medium: { etiqueta: 'Medio (utm_medium)', motivo: 'medio_excluido' },
  form_name: { etiqueta: 'Formulario / fuente GHL', motivo: 'formulario_excluido' },
  form_plugin: { etiqueta: 'Origen (GHL, Meta, WordPress…)', motivo: 'formulario_excluido' },
  ip_country: { etiqueta: 'País', motivo: 'pais_excluido' },
  respuesta: { etiqueta: 'Respuesta de formulario', motivo: 'respuesta_excluida' },
  etiqueta: { etiqueta: 'Etiqueta GHL', motivo: 'etiqueta_excluida' },
  email: { etiqueta: 'Email', motivo: 'contacto_excluido' },
  telefono: { etiqueta: 'Teléfono', motivo: 'contacto_excluido' },
  nombre: { etiqueta: 'Nombre', motivo: 'contacto_excluido' },
} as const;

export type CampoRegla = keyof typeof CAMPOS_REGLA;

/**
 * Operadores. Mismo vocabulario que los filtros de /leads y del BI
 * (`FilterOp`), más `vacio`.
 *
 * `neq` y `ncontains` también atrapan los leads SIN dato: «país no es CO» deja
 * fuera a los que no traen país. Es lo que se espera de una regla de «solo
 * cuentan los de Colombia», y la UI lo dice al elegir el operador.
 */
export const OPS_REGLA = {
  eq: 'es',
  neq: 'no es',
  contains: 'contiene',
  ncontains: 'no contiene',
  starts: 'empieza por',
  ends: 'termina en',
  vacio: 'está vacío',
} as const;

export type OpRegla = keyof typeof OPS_REGLA;

export type CondicionRegla = {
  /** Estable entre guardados: la previsualización cuenta por condición. */
  id: string;
  campo: CampoRegla;
  /** Solo `respuesta`: la clave de `raw_fields` tal como está guardada. */
  clave?: string;
  op: OpRegla;
  /** Tal como se escribieron; se comparan sin distinguir mayúsculas. */
  valores: string[];
};

/** Configuración por cliente, en `report_utm.clientes.config.filtro_atribucion`. */
export type ReglaExclusion = {
  /** Interruptor general. Apagada, no se excluye nada. */
  activa: boolean;
  /**
   * Fuera los leads sin NINGUNA señal publicitaria: ni `utm_id`, ni campaña, ni
   * anuncio, ni conjunto, ni `click_id`. Es el caso de WhatsApp directo, el
   * perfil de Instagram o un contacto creado a mano en el CRM.
   */
  exigir_atribucion: boolean;
  /**
   * Fuera los leads cuyo email o teléfono ya tiene un lead ANTERIOR que cuenta.
   * Cuenta el primero. No lo decide `motivoExclusion` (necesita ver otros
   * leads): ver `lead-duplicados.ts`.
   */
  excluir_duplicados: boolean;
  /** Si un lead cumple cualquiera, no cuenta. */
  condiciones: CondicionRegla[];
};

export const MOTIVOS_EXCLUSION = {
  sin_atribucion: 'Sin atribución (no trae UTM, anuncio ni click id)',
  source_excluida: 'Fuente excluida por la regla del cliente',
  formulario_excluido: 'Formulario/origen excluido por la regla del cliente',
  campana_excluida: 'Campaña, conjunto o anuncio excluido por la regla del cliente',
  medio_excluido: 'Medio (utm_medium) excluido por la regla del cliente',
  pais_excluido: 'País excluido por la regla del cliente',
  respuesta_excluida: 'Respuesta de formulario excluida por la regla del cliente',
  etiqueta_excluida: 'Etiqueta de GHL excluida por la regla del cliente',
  contacto_excluido: 'Email, teléfono o nombre excluido (lead de prueba)',
  duplicado: 'Duplicado: su email o teléfono ya había entrado antes',
  manual: 'Excluido a mano',
} as const;

export type MotivoExclusion = keyof typeof MOTIVOS_EXCLUSION;

/** Motivos que pone la regla. Solo estos se pueden deshacer al re-evaluarla. */
export const MOTIVOS_AUTOMATICOS: MotivoExclusion[] = (
  Object.keys(MOTIVOS_EXCLUSION) as MotivoExclusion[]
).filter((m) => m !== 'manual');

export const REGLA_VACIA: ReglaExclusion = {
  activa: false,
  exigir_atribucion: false,
  excluir_duplicados: false,
  condiciones: [],
};

/** Topes: la regla viaja en cada ingesta y se evalúa lead a lead. */
export const MAX_CONDICIONES = 50;
export const MAX_VALORES = 200;
const MAX_TEXTO = 200;

/** Sin distinguir mayúsculas ni espacios de los bordes. */
function norm(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Lista limpia: sin vacíos y sin repetidos (sin distinguir mayúsculas). Conserva
 * cómo se escribió el primero, que es lo que la UI vuelve a enseñar.
 */
function limpiarLista(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (x === null || x === undefined || typeof x === 'object') continue;
    const s = String(x).trim().slice(0, MAX_TEXTO);
    const k = s.toLowerCase();
    if (!s || vistos.has(k)) continue;
    vistos.add(k);
    out.push(s);
    if (out.length >= MAX_VALORES) break;
  }
  return out;
}

function limpiarCondicion(v: unknown, i: number): CondicionRegla | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const campo = String(c.campo ?? '') as CampoRegla;
  const op = String(c.op ?? '') as OpRegla;
  if (!(campo in CAMPOS_REGLA) || !(op in OPS_REGLA)) return null;
  const valores = op === 'vacio' ? [] : limpiarLista(c.valores);
  // Una condición sin valores no significa nada: «es ∅» no atrapa a nadie y
  // «no es ∅» atraparía a TODOS. Se descarta en vez de adivinar.
  if (op !== 'vacio' && valores.length === 0) return null;
  const out: CondicionRegla = {
    id: typeof c.id === 'string' && c.id.trim() ? c.id.trim().slice(0, 64) : `c${i + 1}`,
    campo,
    op,
    valores,
  };
  if (campo === 'respuesta') {
    const clave = String(c.clave ?? '')
      .trim()
      .slice(0, 120);
    if (!clave) return null;
    out.clave = clave;
  }
  return out;
}

/**
 * Lee la regla desde el JSONB `config` del cliente, tolerando cualquier forma.
 * Un config roto no puede excluir leads por accidente: ante la duda, REGLA_VACIA.
 *
 * Formato v1 (`excluir_sources` / `excluir_formularios`) → condiciones
 * equivalentes. Si ya hay `condiciones`, las listas viejas se ignoran: las
 * escribe `serializarRegla` solo como copia de compatibilidad.
 */
export function leerRegla(config: unknown): ReglaExclusion {
  const raw =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>).filtro_atribucion
      : null;
  if (!raw || typeof raw !== 'object') return { ...REGLA_VACIA, condiciones: [] };
  const r = raw as Record<string, unknown>;

  let condiciones: CondicionRegla[];
  if (Array.isArray(r.condiciones)) {
    condiciones = r.condiciones
      .map((c, i) => limpiarCondicion(c, i))
      .filter((c): c is CondicionRegla => c !== null);
  } else {
    condiciones = [];
    const sources = limpiarLista(r.excluir_sources);
    const formularios = limpiarLista(r.excluir_formularios);
    if (sources.length > 0) {
      condiciones.push({ id: 'v1-fuentes', campo: 'utm_source', op: 'eq', valores: sources });
    }
    if (formularios.length > 0) {
      condiciones.push({
        id: 'v1-formularios',
        campo: 'form_name',
        op: 'contains',
        valores: formularios,
      });
    }
  }
  // Ids únicos: dos condiciones con el mismo id sumarían en la misma línea de
  // la previsualización.
  const ids = new Set<string>();
  condiciones = condiciones.slice(0, MAX_CONDICIONES).map((c, i) => {
    const id = ids.has(c.id) ? `${c.id}-${i + 1}` : c.id;
    ids.add(id);
    return id === c.id ? c : { ...c, id };
  });

  return {
    activa: r.activa === true,
    exigir_atribucion: r.exigir_atribucion === true,
    excluir_duplicados: r.excluir_duplicados === true,
    condiciones,
  };
}

/**
 * Lo que se guarda en `config.filtro_atribucion`.
 *
 * Además de las condiciones, escribe las dos listas de la v1 con lo que sea
 * expresable en ellas. Es para el despliegue: si una instancia con el código
 * viejo lee la regla nueva, excluye MENOS (nunca más) en vez de nada.
 */
export function serializarRegla(regla: ReglaExclusion): Record<string, unknown> {
  const r = leerRegla({ filtro_atribucion: regla });
  const v1 = (campo: CampoRegla, op: OpRegla) =>
    r.condiciones
      .filter((c) => c.campo === campo && c.op === op)
      .flatMap((c) => c.valores.map((v) => v.toLowerCase()));
  return {
    version: 2,
    activa: r.activa,
    exigir_atribucion: r.exigir_atribucion,
    excluir_duplicados: r.excluir_duplicados,
    condiciones: r.condiciones,
    excluir_sources: [...new Set(v1('utm_source', 'eq'))],
    excluir_formularios: [...new Set(v1('form_name', 'contains'))],
  };
}

/** ¿Dos reglas deciden lo mismo? Compara la forma normalizada. */
export function mismaRegla(a: ReglaExclusion, b: ReglaExclusion): boolean {
  const n = (x: ReglaExclusion) => JSON.stringify(leerRegla({ filtro_atribucion: x }));
  return n(a) === n(b);
}

/** ¿La regla puede excluir algo? Evita trabajo cuando está vacía. */
export function reglaTieneEfecto(regla: ReglaExclusion): boolean {
  return (
    regla.activa &&
    (regla.exigir_atribucion || regla.excluir_duplicados || (regla.condiciones?.length ?? 0) > 0)
  );
}

/** Lo mínimo de una fila de `lead_events` que la regla necesita mirar. */
export type LeadParaRegla = {
  utm_id?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  click_id?: unknown;
  form_name?: unknown;
  form_plugin?: unknown;
  ip_country?: unknown;
  lead_email?: unknown;
  lead_phone?: unknown;
  lead_name?: unknown;
  raw_fields?: unknown;
  /** Las etiquetas de GHL viven en `custom_data.tags`. */
  custom_data?: unknown;
  /** Alternativa: el histórico lee solo `tags:custom_data->tags`. */
  tags?: unknown;
};

/** Columnas de `lead_events` que necesita la regla, para el `select` del histórico. */
export function columnasParaRegla(regla: ReglaExclusion): string[] {
  const cols = new Set([
    'utm_id',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'utm_source',
    'utm_medium',
    'click_id',
    'form_name',
    'form_plugin',
    'ip_country',
    'lead_email',
    'lead_phone',
    'lead_name',
  ]);
  const campos = new Set(regla.condiciones.map((c) => c.campo));
  // Los JSONB se piden solo si hacen falta: `custom_data` de GHL trae
  // oportunidades y campos largos, y leerlo entero en todo el histórico es
  // pedir megas para nada.
  if (campos.has('respuesta')) cols.add('raw_fields');
  if (campos.has('etiqueta')) cols.add('tags:custom_data->tags');
  return [...cols];
}

function tiene(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** Solo dígitos. Es como se compara un teléfono: `+57 300-123` = `57300123`. */
export function soloDigitos(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Valores escalares de un campo JSON: un multiselect llega como array. */
function escalares(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(escalares);
  if (typeof v === 'object') return [];
  return [String(v)];
}

/**
 * La respuesta a una pregunta. La clave se busca tal cual y, si no, sin
 * distinguir mayúsculas ni espacios: un mismo formulario ha llegado como
 * `Presupuesto` y `presupuesto ` según la versión del plugin.
 */
function respuesta(rawFields: unknown, clave: string): unknown {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return undefined;
  const rf = rawFields as Record<string, unknown>;
  if (clave in rf) return rf[clave];
  const k = norm(clave);
  for (const [key, val] of Object.entries(rf)) if (norm(key) === k) return val;
  return undefined;
}

function etiquetasDe(lead: LeadParaRegla): unknown {
  if (lead.tags !== undefined) return lead.tags;
  const cd = lead.custom_data;
  return cd && typeof cd === 'object' ? (cd as Record<string, unknown>).tags : undefined;
}

/** Los valores del lead para un campo, normalizados y sin vacíos. */
function valoresDelLead(lead: LeadParaRegla, c: CondicionRegla): string[] {
  let crudos: string[];
  switch (c.campo) {
    case 'respuesta':
      crudos = escalares(respuesta(lead.raw_fields, c.clave ?? ''));
      break;
    case 'etiqueta':
      crudos = escalares(etiquetasDe(lead));
      break;
    case 'email':
      crudos = escalares(lead.lead_email);
      break;
    case 'nombre':
      crudos = escalares(lead.lead_name);
      break;
    case 'telefono':
      return escalares(lead.lead_phone).map(soloDigitos).filter(Boolean);
    default:
      crudos = escalares(lead[c.campo]);
  }
  return crudos.map(norm).filter(Boolean);
}

/** ¿El lead cumple la condición? */
export function cumpleCondicion(lead: LeadParaRegla, c: CondicionRegla): boolean {
  const delLead = valoresDelLead(lead, c);
  if (c.op === 'vacio') return delLead.length === 0;

  const buscados = (
    c.campo === 'telefono' ? c.valores.map(soloDigitos) : c.valores.map(norm)
  ).filter(Boolean);
  if (buscados.length === 0) return false;

  const alguno = (f: (valor: string, buscado: string) => boolean) =>
    delLead.some((v) => buscados.some((b) => f(v, b)));

  switch (c.op) {
    case 'eq':
      return alguno((v, b) => v === b);
    case 'neq':
      return !alguno((v, b) => v === b);
    case 'contains':
      return alguno((v, b) => v.includes(b));
    case 'ncontains':
      return !alguno((v, b) => v.includes(b));
    case 'starts':
      return alguno((v, b) => v.startsWith(b));
    case 'ends':
      return alguno((v, b) => v.endsWith(b));
    default:
      return false;
  }
}

/** ¿El lead trae alguna señal que lo ate a un anuncio? */
export function tieneAtribucion(lead: LeadParaRegla): boolean {
  return (
    tiene(lead.utm_id) ||
    tiene(lead.utm_campaign) ||
    tiene(lead.utm_content) ||
    tiene(lead.utm_term) ||
    tiene(lead.click_id)
  );
}

/** Id con el que la previsualización cuenta «exigir atribución». */
export const ID_SIN_ATRIBUCION = '__sin_atribucion';
/** Id con el que la previsualización cuenta los duplicados. */
export const ID_DUPLICADO = '__duplicado';

/**
 * Qué condición excluye el lead y con qué motivo, o `null` si cuenta.
 *
 * El orden importa solo para el texto que se guarda: un lead sin atribución que
 * además viene de una fuente excluida se registra como `sin_atribucion`, que es
 * el dato más útil para quien lo revise. Después, las condiciones en el orden
 * en que están escritas. Los duplicados van aparte (`lead-duplicados.ts`) y al
 * final: solo es duplicado lo que, por lo demás, contaría.
 */
export function evaluarExclusion(
  lead: LeadParaRegla,
  regla: ReglaExclusion
): { motivo: MotivoExclusion; condicionId: string } | null {
  if (!reglaTieneEfecto(regla)) return null;

  if (regla.exigir_atribucion && !tieneAtribucion(lead)) {
    return { motivo: 'sin_atribucion', condicionId: ID_SIN_ATRIBUCION };
  }

  for (const c of regla.condiciones ?? []) {
    if (cumpleCondicion(lead, c)) {
      return { motivo: CAMPOS_REGLA[c.campo].motivo, condicionId: c.id };
    }
  }

  return null;
}

/** Motivo por el que la regla excluye el lead, o `null` si cuenta. */
export function motivoExclusion(
  lead: LeadParaRegla,
  regla: ReglaExclusion
): MotivoExclusion | null {
  return evaluarExclusion(lead, regla)?.motivo ?? null;
}

/**
 * Marca la fila si la regla la excluye. Si cuenta, la fila sale SIN tocar: no se
 * escribe `excluido: false` explícito, así el INSERT sigue funcionando aunque la
 * migración 079 todavía no esté aplicada en un entorno.
 */
export function aplicarExclusion<T extends Record<string, unknown>>(
  fila: T,
  regla: ReglaExclusion,
  ahora: string = new Date().toISOString()
): T & Partial<MarcaExclusion> {
  const motivo = motivoExclusion(fila, regla);
  if (!motivo) return fila;
  return { ...fila, excluido: true, excluido_motivo: motivo, excluido_at: ahora };
}

/** Columnas que añade `aplicarExclusion` a una fila excluida. */
export type MarcaExclusion = {
  excluido: true;
  excluido_motivo: MotivoExclusion;
  excluido_at: string;
};

// ── ¿Está aplicada la migración 079? ─────────────────────────────────
//
// El código y la migración no se despliegan en el mismo instante. Si el código
// llega antes, un `.eq('excluido', false)` contra una columna que no existe
// tumba TODAS las lecturas de leads —informes, dashboard, salud— con un error
// de PostgREST. Al revés tampoco pasa nada: la columna existe y nadie la usa.
//
// Por eso cada lector pregunta aquí antes de filtrar (`columnaExcluidoDisponible`
// si necesita el booleano, `filtroLeadsQueCuentan` si solo quiere filtrar una
// consulta). La respuesta se cachea: un `true` no puede volver a ser `false`
// (nadie borra la columna), así que se guarda para siempre; un `false` se
// re-pregunta pasado un rato para que la app empiece a filtrar sola en cuanto
// alguien aplique la migración, sin reiniciar.

const REINTENTO_SIN_COLUMNA_MS = 5 * 60_000;
let columnaExcluido: { disponible: boolean; ts: number } | null = null;

/**
 * ¿Existe `report_utm.lead_events.excluido`? Recibe cualquier cliente Supabase
 * (con o sin `.schema('report_utm')` ya aplicado).
 */
export async function columnaExcluidoDisponible(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<boolean> {
  const ahora = Date.now();
  if (columnaExcluido?.disponible) return true;
  if (columnaExcluido && ahora - columnaExcluido.ts < REINTENTO_SIN_COLUMNA_MS) return false;
  try {
    const rtm = typeof db?.schema === 'function' ? db.schema('report_utm') : db;
    const { error } = await rtm.from('lead_events').select('excluido').limit(1);
    // Solo un «columna no existe» (42703) cuenta como NO. Un error de red no
    // debe apagar el filtro: se deja sin decidir y se reintenta a la próxima.
    if (error) {
      const noExiste = (error as { code?: string }).code === '42703';
      if (noExiste) columnaExcluido = { disponible: false, ts: ahora };
      return false;
    }
    columnaExcluido = { disponible: true, ts: ahora };
    return true;
  } catch {
    return false;
  }
}

/** Lo único que `aplicar` necesita de la consulta: poder encadenar un `.eq()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConsultaFiltrable = { eq: (...args: any[]) => unknown };

/** El filtro «solo los leads que cuentan», con la detección ya resuelta. */
export type FiltroLeadsQueCuentan = {
  /** `true` si la columna existe y `aplicar` añade `excluido = false`. */
  activo: boolean;
  /**
   * SÍNCRONO: devuelve el MISMO builder, sin ejecutarlo, con el filtro puesto
   * (o intacto si la columna no existe). No lleva `await` delante.
   */
  aplicar: <Q extends ConsultaFiltrable>(q: Q) => Q;
};

/**
 * Pregunta una vez si existe la columna y devuelve el filtro listo para aplicar
 * a cualquier consulta de `lead_events`:
 *
 *   const cuentan = await filtroLeadsQueCuentan(db);
 *   const { data } = await cuentan.aplicar(rtm.from('lead_events').select('id')).limit(100);
 *
 * El `await` va sobre la DETECCIÓN, nunca sobre la consulta. La versión anterior
 * (`q = await soloLeadsQueCuentan(db, q)`) era async y devolvía el builder de
 * PostgREST, que es un thenable: la promesa lo adopta, así que el `await`
 * EJECUTABA la consulta y entregaba `{ data, error }` en vez del builder. El
 * siguiente `.limit()` reventaba («q.limit is not a function»; pasó en
 * `medirCruce` de `salud-fuentes-db.ts`). Por eso esta función devuelve un objeto
 * plano, que no es thenable, y `aplicar` es síncrona.
 */
export async function filtroLeadsQueCuentan(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<FiltroLeadsQueCuentan> {
  const activo = await columnaExcluidoDisponible(db);
  return {
    activo,
    aplicar: <Q extends ConsultaFiltrable>(q: Q): Q => {
      // Si llega el resultado de una consulta ya ejecutada (`{ data, error }`),
      // se dice alto y claro aquí, no tres líneas más abajo con un
      // «q.limit is not a function».
      if (!q || typeof q.eq !== 'function') {
        throw new TypeError(
          'filtroLeadsQueCuentan().aplicar espera el builder de PostgREST SIN ejecutar (sin `await` delante).'
        );
      }
      return activo ? (q.eq('excluido', false) as Q) : q;
    },
  };
}

/** Solo para las comprobaciones: olvida lo aprendido sobre la columna. */
export function _reiniciarDeteccionColumna(): void {
  columnaExcluido = null;
}

/**
 * Carga la regla de un cliente de `report_utm`. Recibe el cliente del esquema
 * ya resuelto (`supabase.schema('report_utm')`) para no importar nada de
 * servidor y seguir siendo comprobable.
 *
 * Un error de lectura devuelve la regla vacía: es preferible dejar entrar un
 * lead que se pueda excluir después que perder uno que sí contaba. Y sin la
 * migración 079 también: marcar una fila con una columna inexistente haría
 * fallar el INSERT y se perdería el lead entero.
 */
export async function cargarReglaExclusion(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  clienteId: string
): Promise<ReglaExclusion> {
  if (!clienteId) return { ...REGLA_VACIA };
  if (!(await columnaExcluidoDisponible(db))) return { ...REGLA_VACIA };
  try {
    const { data, error } = await db
      .from('clientes')
      .select('config')
      .eq('id', clienteId)
      .maybeSingle();
    if (error) return { ...REGLA_VACIA };
    return leerRegla(data?.config);
  } catch {
    return { ...REGLA_VACIA };
  }
}
