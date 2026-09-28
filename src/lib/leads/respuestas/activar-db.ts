/**
 * Activar una pregunta de formulario: crear su campo de lead YA usable.
 *
 * Es el único camino de alta automática. Lo usan la pantalla de Leads
 * («Medir») y el selector de preguntas del dashboard («Guardar en el
 * catálogo»); antes el segundo creaba un campo vacío —sin respuestas nombradas
 * ni orden— y con una clave que podía chocar con un campo desactivado
 * (auditoría del 2026-09-26).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { loadLeadCampos, saveLeadCampo } from '@/lib/report-utm/lead-campos-db';
import { normalizarClaveLead } from '@/lib/report-utm/lead-campos';
import { detectarPreguntas } from './deteccion-db';
import { cargarPreguntas } from './preguntas-db';
import { configurarCampoAutomatico, unificarPreguntas } from './catalogo';

export async function activarPregunta(
  db: any,
  rtmClienteId: string,
  input: { claves_origen: string[]; nombre?: string | null }
): Promise<{ id?: string; clave?: string; existente?: boolean; error?: string }> {
  const claves = [
    ...new Set(
      (input.claves_origen ?? []).map((c) => normalizarClaveLead(String(c))).filter(Boolean)
    ),
  ];
  if (claves.length === 0) return { error: 'Elige al menos una pregunta.' };

  const existentes = await loadLeadCampos(db, rtmClienteId);
  // Una pregunta no se mide dos veces con cifras distintas: si ya está en un
  // campo activo, ese es el campo.
  const yaActivo = existentes.find(
    (c) => c.activo && c.claves_origen.some((k) => claves.includes(k))
  );
  if (yaActivo) return { id: yaActivo.id, clave: yaActivo.clave, existente: true };

  const [deteccion, plataforma] = await Promise.all([
    detectarPreguntas(db, rtmClienteId),
    cargarPreguntas(db, rtmClienteId),
  ]);
  const preguntas = unificarPreguntas(deteccion.claves, plataforma).filter((p) =>
    claves.includes(p.clave_norm)
  );
  const principal = [...preguntas].sort((a, b) => b.leads - a.leads)[0];
  const auto = configurarCampoAutomatico({
    etiqueta: principal?.nombre ?? claves[0],
    claves_origen: claves,
    valores: preguntas.flatMap((p) => p.valores),
    opciones: preguntas.flatMap((p) => p.opciones),
    tipo: preguntas.some((p) => p.tipo === 'multiple')
      ? 'multiple'
      : (preguntas.find((p) => p.tipo)?.tipo ?? null),
    es_opcion: preguntas.some((p) => p.es_opcion),
  });

  const nombre = String(input.nombre ?? '').trim() || principal?.nombre || auto.nombre;
  // Clave única también frente a los campos desactivados.
  const usadas = new Set(existentes.map((c) => c.clave));
  let clave = auto.clave;
  for (let i = 2; usadas.has(clave); i++) clave = `${auto.clave}_${i}`;

  const res = await saveLeadCampo(db, {
    cliente_id: rtmClienteId,
    clave,
    nombre,
    claves_origen: claves,
    valores_map: auto.valores_map,
    valores_orden: auto.valores_orden,
    sin_mapear: auto.sin_mapear,
    tipo: auto.tipo,
    sincronizar_opciones: true,
  });
  if (res.error) return { error: res.error };
  return { id: res.id, clave };
}
