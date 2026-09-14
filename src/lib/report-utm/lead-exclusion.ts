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
  /** `utm_source` exactos (sin distinguir mayúsculas) que no cuentan. */
  excluir_sources: string[];
  /** Fragmentos de `form_name` (la «fuente» del contacto en GHL) que no cuentan. */
  excluir_formularios: string[];
};

export const MOTIVOS_EXCLUSION = {
  sin_atribucion: 'Sin atribución (no trae UTM, anuncio ni click id)',
  source_excluida: 'Fuente excluida por la regla del cliente',
  formulario_excluido: 'Formulario/origen excluido por la regla del cliente',
  manual: 'Excluido a mano',
} as const;

export type MotivoExclusion = keyof typeof MOTIVOS_EXCLUSION;

/** Motivos que pone la regla. Solo estos se pueden deshacer al re-evaluarla. */
export const MOTIVOS_AUTOMATICOS: MotivoExclusion[] = [
  'sin_atribucion',
  'source_excluida',
  'formulario_excluido',
];

export const REGLA_VACIA: ReglaExclusion = {
  activa: false,
  exigir_atribucion: false,
  excluir_sources: [],
  excluir_formularios: [],
};

function limpiarLista(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(
    new Set(
      v
        .map((x) =>
          String(x ?? '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
  );
}

/**
 * Lee la regla desde el JSONB `config` del cliente, tolerando cualquier forma.
 * Un config roto no puede excluir leads por accidente: ante la duda, REGLA_VACIA.
 */
export function leerRegla(config: unknown): ReglaExclusion {
  const raw =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>).filtro_atribucion
      : null;
  if (!raw || typeof raw !== 'object') return { ...REGLA_VACIA };
  const r = raw as Record<string, unknown>;
  return {
    activa: r.activa === true,
    exigir_atribucion: r.exigir_atribucion === true,
    excluir_sources: limpiarLista(r.excluir_sources),
    excluir_formularios: limpiarLista(r.excluir_formularios),
  };
}

/** ¿La regla puede excluir algo? Evita trabajo cuando está vacía. */
export function reglaTieneEfecto(regla: ReglaExclusion): boolean {
  return (
    regla.activa &&
    (regla.exigir_atribucion ||
      regla.excluir_sources.length > 0 ||
      regla.excluir_formularios.length > 0)
  );
}

/** Lo mínimo de una fila de `lead_events` que la regla necesita mirar. */
export type LeadParaRegla = {
  utm_id?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  utm_source?: unknown;
  click_id?: unknown;
  form_name?: unknown;
};

function tiene(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
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

/**
 * Motivo por el que la regla excluye el lead, o `null` si cuenta.
 *
 * El orden importa solo para el texto que se guarda: un lead sin atribución que
 * además viene de una fuente excluida se registra como `sin_atribucion`, que es
 * el dato más útil para quien lo revise.
 */
export function motivoExclusion(
  lead: LeadParaRegla,
  regla: ReglaExclusion
): MotivoExclusion | null {
  if (!reglaTieneEfecto(regla)) return null;

  if (regla.exigir_atribucion && !tieneAtribucion(lead)) return 'sin_atribucion';

  const source = String(lead.utm_source ?? '')
    .trim()
    .toLowerCase();
  if (source && regla.excluir_sources.includes(source)) return 'source_excluida';

  const form = String(lead.form_name ?? '')
    .trim()
    .toLowerCase();
  if (form && regla.excluir_formularios.some((f) => form.includes(f))) {
    return 'formulario_excluido';
  }

  return null;
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
// Por eso cada lector pregunta aquí antes de filtrar. La respuesta se cachea: un
// `true` no puede volver a ser `false` (nadie borra la columna), así que se
// guarda para siempre; un `false` se re-pregunta pasado un rato para que la app
// empiece a filtrar sola en cuanto alguien aplique la migración, sin reiniciar.

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

/**
 * Aplica `excluido = false` a una consulta de `lead_events` si la columna existe.
 * Uso: `q = await soloLeadsQueCuentan(db, q)`.
 */
export async function soloLeadsQueCuentan<Q extends { eq: (c: string, v: unknown) => Q }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  q: Q
): Promise<Q> {
  return (await columnaExcluidoDisponible(db)) ? q.eq('excluido', false) : q;
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
