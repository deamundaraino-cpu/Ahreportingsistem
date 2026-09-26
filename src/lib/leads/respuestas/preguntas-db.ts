/**
 * Preguntas de formulario publicadas por cada plataforma
 * (`report_utm.lead_preguntas`, migración 091).
 *
 * Lo escriben las integraciones cuando leen la definición de un formulario
 * (Meta Lead Ads, GoHighLevel, el plugin de WordPress) y lo lee la pantalla de
 * Leads para activar una pregunta con sus opciones reales. Dos reglas:
 *
 *   • Nunca lanza. Si la 091 no está aplicada, escribir es un no-op y leer
 *     devuelve lista vacía: la captación de leads no puede romperse por esto.
 *   • Solo escribe lo que cambió (`firma`): un formulario se relee en cada
 *     sondeo, pero su definición cambia muy de vez en cuando.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import { normalizarClaveLead, normalizarValorCrudo } from '@/lib/report-utm/lead-campos';
import type { OpcionDePregunta } from './catalogo';
import { limpiarEtiqueta } from './catalogo';

export type FuentePregunta = 'meta' | 'ghl' | 'wordpress' | 'detectado';
export type TipoPlataforma =
  'opcion' | 'multiple' | 'texto' | 'numero' | 'email' | 'telefono' | 'fecha' | 'desconocido';

/** Una pregunta tal como la describe su plataforma. */
export interface PreguntaPlataforma {
  form_id?: string | null;
  form_name?: string | null;
  /** Clave con la que la respuesta llega a `raw_fields`. */
  clave_origen: string;
  etiqueta?: string | null;
  tipo: TipoPlataforma;
  opciones?: OpcionDePregunta[];
}

/** Fila leída de la tabla. */
export interface PreguntaGuardada extends PreguntaPlataforma {
  fuente: FuentePregunta;
  clave_norm: string;
  actualizado_at?: string;
}

const REINTENTO_SIN_TABLA_MS = 5 * 60_000;
let sinTablaHasta = 0;

function esTablaAusente(error: any): boolean {
  const msg = String(error?.message ?? '');
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    /does not exist|schema cache|could not find the table/i.test(msg)
  );
}

function firmaDe(p: PreguntaPlataforma): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        p.form_name ?? '',
        p.etiqueta ?? '',
        p.tipo,
        (p.opciones ?? []).map((o) => [o.valor, o.etiqueta ?? '']),
      ])
    )
    .digest('hex');
}

/**
 * Guarda (upsert) las preguntas de una fuente para un cliente. Devuelve cuántas
 * filas cambiaron. Nunca lanza.
 */
export async function guardarPreguntas(
  db: any,
  clienteId: string,
  fuente: FuentePregunta,
  preguntas: PreguntaPlataforma[]
): Promise<number> {
  if (!clienteId || preguntas.length === 0 || Date.now() < sinTablaHasta) return 0;
  try {
    const { data: existentes, error: e1 } = await db
      .from('lead_preguntas')
      .select('form_id, clave_norm, firma')
      .eq('cliente_id', clienteId)
      .eq('fuente', fuente);
    if (e1) {
      if (esTablaAusente(e1)) sinTablaHasta = Date.now() + REINTENTO_SIN_TABLA_MS;
      return 0;
    }
    const previas = new Map(
      ((existentes ?? []) as any[]).map((r) => [`${r.form_id}|${r.clave_norm}`, r.firma])
    );
    const ahora = new Date().toISOString();
    const filas = preguntas
      .map((p) => {
        const clave_norm = normalizarClaveLead(p.clave_origen);
        if (!clave_norm) return null;
        const form_id = String(p.form_id ?? '');
        const firma = firmaDe(p);
        if (previas.get(`${form_id}|${clave_norm}`) === firma) return null;
        return {
          cliente_id: clienteId,
          fuente,
          form_id,
          form_name: p.form_name ?? null,
          clave_origen: p.clave_origen,
          clave_norm,
          etiqueta: p.etiqueta ?? null,
          tipo: p.tipo,
          opciones: (p.opciones ?? []).slice(0, 200).map((o) => ({
            valor: String(o.valor ?? '').slice(0, 300),
            etiqueta: o.etiqueta ? String(o.etiqueta).slice(0, 300) : null,
          })),
          firma,
          visto_at: ahora,
          actualizado_at: ahora,
        };
      })
      .filter(Boolean);
    if (filas.length === 0) return 0;
    const { error } = await db
      .from('lead_preguntas')
      .upsert(filas, { onConflict: 'cliente_id,fuente,form_id,clave_norm' });
    if (error) {
      if (esTablaAusente(error)) sinTablaHasta = Date.now() + REINTENTO_SIN_TABLA_MS;
      else console.error('[lead-preguntas] no se pudieron guardar:', error.message);
      return 0;
    }
    return filas.length;
  } catch (err) {
    console.error('[lead-preguntas] error guardando preguntas:', err);
    return 0;
  }
}

/** Preguntas de un cliente, de todas las fuentes. Nunca lanza. */
export async function cargarPreguntas(db: any, clienteId: string): Promise<PreguntaGuardada[]> {
  if (!clienteId || Date.now() < sinTablaHasta) return [];
  try {
    const { data, error } = await db
      .from('lead_preguntas')
      .select(
        'fuente, form_id, form_name, clave_origen, clave_norm, etiqueta, tipo, opciones, actualizado_at'
      )
      .eq('cliente_id', clienteId);
    if (error) {
      if (esTablaAusente(error)) sinTablaHasta = Date.now() + REINTENTO_SIN_TABLA_MS;
      return [];
    }
    return ((data ?? []) as any[]).map((r) => ({
      fuente: r.fuente,
      form_id: r.form_id,
      form_name: r.form_name,
      clave_origen: r.clave_origen,
      clave_norm: r.clave_norm,
      etiqueta: r.etiqueta,
      tipo: r.tipo,
      opciones: Array.isArray(r.opciones) ? r.opciones : [],
      actualizado_at: r.actualizado_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Añade a los campos del cliente las opciones NUEVAS que publicó la plataforma
 * (`sincronizar_opciones`): una opción que Meta estrena hoy aparece mañana como
 * respuesta con su nombre, sin que nadie tenga que volver a la pantalla de
 * Leads. Solo añade; nunca renombra ni borra lo que el analista decidió.
 *
 * Devuelve cuántos campos cambiaron. Nunca lanza.
 */
export async function sincronizarOpcionesEnCampos(db: any, clienteId: string): Promise<number> {
  try {
    const preguntas = await cargarPreguntas(db, clienteId);
    if (preguntas.length === 0) return 0;
    const { data: campos, error } = await db
      .from('lead_campos')
      .select('id, claves_origen, valores_map, valores_orden, sincronizar_opciones, activo')
      .eq('cliente_id', clienteId)
      .eq('activo', true);
    if (error || !campos) return 0;

    let cambiados = 0;
    for (const c of campos as any[]) {
      if (c.sincronizar_opciones === false) continue;
      const claves = new Set<string>(c.claves_origen ?? []);
      const opciones = preguntas
        .filter((p) => claves.has(p.clave_norm))
        .flatMap((p) => p.opciones ?? []);
      if (opciones.length === 0) continue;
      const mapa: Record<string, string> = { ...(c.valores_map ?? {}) };
      const orden: string[] = [...(c.valores_orden ?? [])];
      let tocado = false;
      for (const o of opciones) {
        const norm = normalizarValorCrudo(o.valor);
        if (!norm || Object.prototype.hasOwnProperty.call(mapa, norm)) continue;
        const label = limpiarEtiqueta(o.etiqueta || o.valor);
        if (!label) continue;
        mapa[norm] = label;
        if (orden.length > 0 && !orden.includes(label)) orden.push(label);
        tocado = true;
      }
      if (!tocado) continue;
      const { error: e2 } = await db
        .from('lead_campos')
        .update({ valores_map: mapa, valores_orden: orden })
        .eq('id', c.id);
      if (!e2) cambiados++;
    }
    return cambiados;
  } catch {
    return 0;
  }
}
