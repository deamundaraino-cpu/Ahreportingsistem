/**
 * Campos de lead — lectura, escritura y descubrimiento.
 *
 * Capa fina sobre `report_utm.lead_campos`: todo el cálculo (bucket de un valor,
 * orden, sugerencia de agrupación) vive en `./lead-campos.ts`, así que el motor
 * BI, la vista previa del agrupador y esta capa no pueden dar resultados
 * distintos.
 *
 * A diferencia de los campos de Sheet, aquí NO hay dato derivado: los buckets se
 * calculan al consultar `lead_events`, de modo que editar el catálogo se ve
 * reflejado en el informe al instante, sin recálculo ni cron.
 */

import { fetchAllRows } from '@/lib/supabase-paginate';
import {
  normalizarClaveLead,
  normalizarValorCrudo,
  esClaveOfrecible,
  etiquetasDeCampo,
} from './lead-campos';
import type {
  LeadCampoDef,
  LeadSegmentoDef,
  ClaveDetectada,
  CampoValorCrudo,
  TipoPregunta,
} from './lead-campos';
import { clavesDeRespuestas, reasignarClaves } from '@/lib/leads/respuestas/claves';
import type { RespuestaClave } from '@/lib/leads/respuestas/claves';
import { colombiaRangeBounds } from '@/lib/colombia-date';
import { columnaExcluidoDisponible } from './lead-exclusion';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Tope de leads que escanea el descubrimiento de claves. */
const MAX_LEADS_ESCANEO = 30000;

/** Tope de valores crudos que se devuelven por clave, para no inflar la UI. */
const MAX_VALORES_POR_CLAVE = 300;

/** Mensaje típico de PostgREST cuando falta la migración 060. */
function esTablaAusente(error: any): boolean {
  const msg = String(error?.message ?? '');
  return error?.code === '42P01' || /does not exist|schema cache/i.test(msg);
}

function toCampo(row: any): LeadCampoDef {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    clave: row.clave,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    claves_origen: Array.isArray(row.claves_origen) ? row.claves_origen : [],
    valores_map: row.valores_map ?? {},
    valores_orden: row.valores_orden ?? [],
    sin_mapear: row.sin_mapear ?? 'crudo',
    max_valores: row.max_valores ?? 200,
    activo: row.activo !== false,
    orden: row.orden ?? 0,
    respuestas: Array.isArray(row.respuestas) ? (row.respuestas as RespuestaClave[]) : [],
    tipo: (row.tipo as TipoPregunta | null) ?? null,
    sincronizar_opciones: row.sincronizar_opciones !== false,
  };
}

// ── ¿Está aplicada la 090? ────────────────────────────────────────────
// La migración la aplica una persona. Hasta entonces se escribe como siempre:
// sin `respuestas`, `tipo` ni `sincronizar_opciones`. Mismo patrón que
// `columnasIdDisponibles` (lead-ids.ts).

const REINTENTO_SIN_COLUMNAS_MS = 5 * 60_000;
let columnas090: { disponible: boolean; ts: number } | null = null;

export async function columnasRespuestasDisponibles(db: any): Promise<boolean> {
  const ahora = Date.now();
  if (columnas090 && (columnas090.disponible || ahora - columnas090.ts < REINTENTO_SIN_COLUMNAS_MS))
    return columnas090.disponible;
  const { error } = await db.from('lead_campos').select('respuestas').limit(1);
  columnas090 = { disponible: !error, ts: ahora };
  return !error;
}

/**
 * Catálogo de campos de un cliente. Si la migración 060 todavía no está
 * aplicada devuelve lista vacía en vez de lanzar: el módulo tiene que seguir
 * funcionando exactamente igual que antes de esta feature.
 */
export async function loadLeadCampos(
  db: any,
  clienteId: string,
  opts?: { soloActivos?: boolean }
): Promise<LeadCampoDef[]> {
  if (!clienteId) return [];
  let q = db.from('lead_campos').select('*').eq('cliente_id', clienteId);
  if (opts?.soloActivos) q = q.eq('activo', true);

  const { data, error } = await q.order('orden', { ascending: true });
  if (error) {
    if (!esTablaAusente(error)) console.error('[lead-campos] error leyendo campos:', error.message);
    return [];
  }
  return (data ?? []).map(toCampo);
}

/** Un solo campo por su clave pública (la del token `leadfield:<clave>`). */
export async function loadLeadCampo(
  db: any,
  clienteId: string,
  clave: string
): Promise<LeadCampoDef | null> {
  const campos = await loadLeadCampos(db, clienteId);
  return campos.find((c) => c.clave === clave) ?? null;
}

// ── Escritura ─────────────────────────────────────────────────────────

export interface LeadCampoInput {
  id?: string;
  cliente_id: string;
  clave: string;
  nombre: string;
  descripcion?: string | null;
  claves_origen: string[];
  valores_map?: Record<string, string>;
  valores_orden?: string[];
  sin_mapear?: 'crudo' | 'otros' | 'ignorar';
  activo?: boolean;
  orden?: number;
  tipo?: TipoPregunta | null;
  sincronizar_opciones?: boolean;
}

/**
 * Alta o edición de un campo. La `clave` se fija en el alta y NO se reescribe
 * después: es lo que quedó guardado dentro de los widgets de `bi_reports`, así
 * que cambiarla dejaría esos widgets apuntando a un campo inexistente.
 */
export async function saveLeadCampo(
  db: any,
  input: LeadCampoInput
): Promise<{ error?: string; id?: string; renombres?: Array<[string, string]> }> {
  const claves = Array.from(
    new Set((input.claves_origen ?? []).map(normalizarClaveLead).filter(Boolean))
  );
  if (!input.nombre?.trim()) return { error: 'El campo necesita un nombre.' };
  if (claves.length === 0) return { error: 'Selecciona al menos una pregunta de formulario.' };

  const payload: Record<string, unknown> = {
    cliente_id: input.cliente_id,
    nombre: input.nombre.trim(),
    descripcion: input.descripcion?.trim() || null,
    claves_origen: claves,
    valores_map: input.valores_map ?? {},
    valores_orden: input.valores_orden ?? [],
    sin_mapear: input.sin_mapear ?? 'crudo',
    activo: input.activo !== false,
    orden: input.orden ?? 0,
  };

  // ── Claves de respuesta (090) y renombres ─────────────────────────
  // Cada respuesta conserva su clave aunque el analista la renombre: es lo que
  // tienen guardado las tarjetas (`lf__<campo>__<clave>`). Y los segmentos,
  // que guardan ETIQUETAS, se reescriben en el mismo guardado; antes renombrar
  // una respuesta los dejaba contando cero sin ningún aviso.
  const anterior: LeadCampoDef | null = input.id
    ? await db
        .from('lead_campos')
        .select('*')
        .eq('id', input.id)
        .maybeSingle()
        .then(({ data }: any) => (data ? toCampo(data) : null))
    : null;
  const nuevo = {
    valores_map: payload.valores_map as Record<string, string>,
    valores_orden: payload.valores_orden as string[],
    sin_mapear: payload.sin_mapear as LeadCampoDef['sin_mapear'],
  };
  const respuestasAnteriores: RespuestaClave[] = anterior
    ? anterior.respuestas && anterior.respuestas.length > 0
      ? anterior.respuestas
      : // Sin claves guardadas (campo anterior a la 090): se congelan las que
        // se estaban derivando, para que ninguna tarjeta cambie de significado.
        (() => {
          const et = etiquetasDeCampo(anterior);
          const cl = clavesDeRespuestas(et);
          return et.map((nombre, i) => ({ clave: cl[i], nombre }));
        })()
    : [];
  const { respuestas, renombres } = reasignarClaves({
    mapaAnterior: anterior?.valores_map ?? {},
    mapaNuevo: nuevo.valores_map,
    respuestasAnteriores,
    etiquetasNuevas: etiquetasDeCampo(nuevo),
  });

  if (await columnasRespuestasDisponibles(db)) {
    payload.respuestas = respuestas;
    if (input.tipo !== undefined) payload.tipo = input.tipo;
    if (input.sincronizar_opciones !== undefined)
      payload.sincronizar_opciones = input.sincronizar_opciones;
  }

  if (input.id) {
    const { error } = await db.from('lead_campos').update(payload).eq('id', input.id);
    if (error) return { error: error.message };
    if (renombres.size > 0) await renombrarEnSegmentos(db, input.id, renombres);
    return { id: input.id, renombres: [...renombres.entries()] };
  }

  const { data, error } = await db
    .from('lead_campos')
    .insert({ ...payload, clave: input.clave })
    .select('id')
    .single();
  if (error) {
    if (esTablaAusente(error)) {
      return { error: 'Falta aplicar la migración 060 (report_utm.lead_campos) en Supabase.' };
    }
    if (error.code === '23505')
      return { error: 'Ya existe un campo con esa clave para este cliente.' };
    return { error: error.message };
  }
  return { id: data?.id };
}

/**
 * Aplica los renombres de respuesta a los segmentos del campo: un segmento
 * guarda las ETIQUETAS de sus respuestas, así que «Calificadas» → «Calificados»
 * lo dejaba vacío. Nunca lanza: un fallo aquí no deshace el guardado del campo,
 * pero se registra.
 */
async function renombrarEnSegmentos(
  db: any,
  campoId: string,
  renombres: Map<string, string>
): Promise<void> {
  const { data, error } = await db
    .from('lead_campo_segmentos')
    .select('id, valores')
    .eq('campo_id', campoId);
  if (error) {
    console.error('[lead-campos] no se pudieron leer los segmentos a renombrar:', error.message);
    return;
  }
  for (const seg of (data ?? []) as { id: string; valores: string[] | null }[]) {
    const antes = seg.valores ?? [];
    const despues = [...new Set(antes.map((v) => renombres.get(v) ?? v))];
    if (despues.length === antes.length && despues.every((v, i) => v === antes[i])) continue;
    const { error: e } = await db
      .from('lead_campo_segmentos')
      .update({ valores: despues })
      .eq('id', seg.id);
    if (e) console.error('[lead-campos] no se pudo renombrar en el segmento', seg.id, e.message);
  }
}

export async function deleteLeadCampo(db: any, id: string): Promise<{ error?: string }> {
  const { error } = await db.from('lead_campos').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Segmentos (report_utm.lead_campo_segmentos, migración 073) ────────

function toSegmento(row: any, porId: Map<string, LeadCampoDef>): LeadSegmentoDef {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    campo_id: row.campo_id,
    // Desnormalizado en la carga y no en un join por fila: el motor necesita
    // la clave del campo padre en cada evaluación de cada lead.
    campo_clave: porId.get(row.campo_id)?.clave ?? '',
    clave: row.clave,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    operador: row.operador === 'not_in' ? 'not_in' : 'in',
    valores: Array.isArray(row.valores) ? row.valores : [],
    activo: row.activo !== false,
    orden: row.orden ?? 0,
  };
}

/**
 * Segmentos de un cliente. Igual que `loadLeadCampos`, si falta la migración 073
 * devuelve lista vacía en vez de lanzar: el resto del módulo tiene que seguir
 * funcionando exactamente como antes de esta feature.
 *
 * `campos` se pasa ya cargado para resolver `campo_clave` sin una consulta más;
 * un segmento cuyo campo padre no esté en la lista se descarta, porque sin
 * bucketizador no hay nada que contar.
 */
export async function loadLeadSegmentos(
  db: any,
  clienteId: string,
  campos: LeadCampoDef[],
  opts?: { soloActivos?: boolean }
): Promise<LeadSegmentoDef[]> {
  if (!clienteId) return [];
  let q = db.from('lead_campo_segmentos').select('*').eq('cliente_id', clienteId);
  if (opts?.soloActivos) q = q.eq('activo', true);

  const { data, error } = await q.order('orden', { ascending: true });
  if (error) {
    if (!esTablaAusente(error))
      console.error('[lead-campos] error leyendo segmentos:', error.message);
    return [];
  }
  const porId = new Map(campos.map((c) => [c.id, c]));
  return (data ?? [])
    .map((r: any) => toSegmento(r, porId))
    .filter((s: LeadSegmentoDef) => !!s.campo_clave);
}

export interface LeadSegmentoInput {
  id?: string;
  cliente_id: string;
  campo_id: string;
  clave: string;
  nombre: string;
  descripcion?: string | null;
  operador?: 'in' | 'not_in';
  valores?: string[];
  activo?: boolean;
  orden?: number;
}

/**
 * Alta o edición de un segmento. La `clave` se fija en el alta y no se reescribe:
 * es lo que queda guardado dentro de los widgets de `bi_reports` y dentro de las
 * fórmulas de las pestañas del dashboard.
 */
export async function saveLeadSegmento(
  db: any,
  input: LeadSegmentoInput
): Promise<{ error?: string; id?: string }> {
  if (!input.nombre?.trim()) return { error: 'El segmento necesita un nombre.' };
  if (!input.campo_id) return { error: 'El segmento necesita un campo de lead.' };
  const valores = Array.from(
    new Set((input.valores ?? []).filter((v) => typeof v === 'string' && v !== ''))
  );
  const operador = input.operador === 'not_in' ? 'not_in' : 'in';
  // Un `in` sin buckets no cuenta nada; un `not_in` sin buckets sí tiene
  // sentido (todos los que respondieron), así que solo se exige en el primero.
  if (operador === 'in' && valores.length === 0) {
    return { error: 'Elige al menos una respuesta para el segmento.' };
  }

  const payload = {
    cliente_id: input.cliente_id,
    campo_id: input.campo_id,
    nombre: input.nombre.trim(),
    descripcion: input.descripcion?.trim() || null,
    operador,
    valores,
    activo: input.activo !== false,
    orden: input.orden ?? 0,
  };

  if (input.id) {
    const { error } = await db.from('lead_campo_segmentos').update(payload).eq('id', input.id);
    if (error) return { error: error.message };
    return { id: input.id };
  }

  const { data, error } = await db
    .from('lead_campo_segmentos')
    .insert({ ...payload, clave: input.clave })
    .select('id')
    .single();
  if (error) {
    if (esTablaAusente(error)) {
      return {
        error: 'Falta aplicar la migración 073 (report_utm.lead_campo_segmentos) en Supabase.',
      };
    }
    if (error.code === '23505')
      return { error: 'Ya existe un segmento con esa clave para este cliente.' };
    return { error: error.message };
  }
  return { id: data?.id };
}

export async function deleteLeadSegmento(db: any, id: string): Promise<{ error?: string }> {
  const { error } = await db.from('lead_campo_segmentos').delete().eq('id', id);
  return error ? { error: error.message } : {};
}

// ── Descubrimiento ────────────────────────────────────────────────────

/**
 * Escanea los leads del cliente y devuelve las preguntas de formulario
 * detectadas, con sus valores y cuántos leads tiene cada uno. Es lo que alimenta
 * el alta de un campo y el agrupador de valores.
 *
 * `incluirIgnoradas` trae también las claves que se filtran por defecto (correo,
 * teléfono, UTM…): el analista puede necesitarlas si su formulario llama
 * "origen" a una pregunta real.
 */
export async function detectarCamposDeLeads(
  db: any,
  clienteId: string,
  opts: { dateFrom: string; dateTo: string; incluirIgnoradas?: boolean }
): Promise<{ claves: ClaveDetectada[]; leads: number }> {
  if (!clienteId) return { claves: [], leads: 0 };

  // Las preguntas se detectan sobre los leads que cuentan: un contacto de
  // WhatsApp excluido que trae un campo suelto del chatbot no debe proponerse
  // como pregunta del formulario.
  const filtrarExcluidos = await columnaExcluidoDisponible(db);
  const rows = await fetchAllRows(
    () => {
      let q = db
        .from('lead_events')
        .select('id,raw_fields,form_name')
        .eq('cliente_id', clienteId)
        .gte('created_at', colombiaRangeBounds(opts.dateFrom, opts.dateTo).gte)
        .lt('created_at', colombiaRangeBounds(opts.dateFrom, opts.dateTo).lt)
        // Sin `order` propio: fetchAllRows pagina por keyset sobre `id` y
        // añadir otro criterio rompería el cursor.
        .not('raw_fields', 'is', null);
      if (filtrarExcluidos) q = q.eq('excluido', false);
      return q;
    },
    1000,
    MAX_LEADS_ESCANEO
  );

  interface Acc {
    etiquetas: Map<string, number>; // clave cruda → veces vista (para elegir la más común)
    leads: number;
    valores: Map<string, number>;
    formularios: Set<string>;
  }
  const porClave = new Map<string, Acc>();

  for (const r of rows as any[]) {
    const rf = r.raw_fields as Record<string, unknown> | null;
    if (!rf || typeof rf !== 'object') continue;
    for (const [k, v] of Object.entries(rf)) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (!s) continue;
      const norm = normalizarClaveLead(k);
      if (!norm) continue;
      if (!opts.incluirIgnoradas && !esClaveOfrecible(norm)) continue;

      let acc = porClave.get(norm);
      if (!acc) {
        acc = { etiquetas: new Map(), leads: 0, valores: new Map(), formularios: new Set() };
        porClave.set(norm, acc);
      }
      acc.etiquetas.set(k, (acc.etiquetas.get(k) ?? 0) + 1);
      acc.leads++;
      acc.valores.set(s, (acc.valores.get(s) ?? 0) + 1);
      if (r.form_name) acc.formularios.add(String(r.form_name));
    }
  }

  const claves: ClaveDetectada[] = Array.from(porClave.entries())
    .map(([norm, acc]) => {
      const valores: CampoValorCrudo[] = Array.from(acc.valores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_VALORES_POR_CLAVE)
        .map(([valor_crudo, filas]) => ({
          valor_crudo,
          valor_norm: normalizarValorCrudo(valor_crudo),
          filas,
          // `origenes` (pestañas) y `ultima_fecha` son del catálogo de
          // Sheets; aquí el origen es el propio formulario y ya viaja en
          // `formularios`, a nivel de la clave.
          origenes: [],
          ultima_fecha: null,
        }));
      const distintos = acc.valores.size;
      // Pregunta de opción = pocos valores distintos y muy repetidos. Es la
      // heurística que ordena la lista: lo cruzable primero, los campos de
      // texto libre (comentarios, direcciones) al final.
      const es_opcion = distintos <= 30 && distintos < Math.max(2, acc.leads * 0.5);
      const etiqueta =
        Array.from(acc.etiquetas.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? norm;
      return {
        clave: etiqueta,
        clave_norm: norm,
        leads: acc.leads,
        distintos,
        es_opcion,
        formularios: Array.from(acc.formularios).sort(),
        valores,
      };
    })
    .sort((a, b) => Number(b.es_opcion) - Number(a.es_opcion) || b.leads - a.leads);

  return { claves, leads: rows.length };
}
