// ── Configuración automática de una pregunta de formulario ───────────
//
// Convertir una pregunta en algo medible costaba unos 13 pasos a mano: nombrar
// el campo, marcar sus claves, agrupar cada variante de escritura, poner
// nombre a cada grupo, apartar «Seleccione una opción», ordenar los rangos de
// uno en uno… (auditoría del 2026-09-26). Aquí está lo que hace falta para que
// «Activar» lo haga en un clic y deje un campo YA usable:
//
//   • etiquetas legibles («entre_$2.000.000_y_$4.000.000» → «Entre $2.000.000 y
//     $4.000.000»), o las de la plataforma cuando las publica (Meta, GHL, WP);
//   • variantes de escritura fundidas (`firmaDeValorLead`);
//   • placeholders apartados como «sin respuesta» (mapeados a vacío);
//   • rangos numéricos ordenados de menor a mayor.
//
// Puro: lo usan la API de activación, la pantalla de Leads (vista previa) y los
// scripts de verificación.

import {
  esValorPlaceholder,
  firmaDeValorLead,
  normalizarValorCrudo,
  slugCampo,
  BUCKET_OTROS,
} from '@/lib/report-utm/lead-campos';
import type { CampoValorCrudo, TipoPregunta } from '@/lib/report-utm/lead-campos';

/** Una opción publicada por la plataforma: el valor que llega y su etiqueta. */
export interface OpcionDePregunta {
  valor: string;
  etiqueta?: string | null;
}

// ── Etiquetas ─────────────────────────────────────────────────────────

/**
 * Valor crudo → etiqueta legible. Meta manda las opciones en snake_case
 * («mas_de_$4.000.000»); los formularios web, como las escribió quien los hizo.
 * Solo se toca la forma, nunca el contenido: guiones bajos a espacios,
 * espacios colapsados y mayúscula inicial.
 */
export function limpiarEtiqueta(raw: string): string {
  const s = String(raw ?? '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return s;
  return s.charAt(0).toLocaleUpperCase('es') + s.slice(1);
}

/** Etiqueta legible de una clave de pregunta («cual_es_tu_rango» → «Cual es tu rango»). */
export function nombreDePregunta(clave: string): string {
  return limpiarEtiqueta(String(clave ?? '').replace(/[¿?:]+/g, ' '));
}

// ── Orden de rangos ───────────────────────────────────────────────────

/**
 * Número de un fragmento de texto: «$2.000.000» → 2000000, «2M» → 2000000,
 * «1,5M» → 1500000, «500k» → 500000. null si no hay ninguno.
 */
function numeros(texto: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(mil(?:lones)?|mm|m|k)?\b/gi;
  for (const m of texto.matchAll(re)) {
    let raw = m[1];
    // Separador de miles (1.000.000 / 1,000,000) vs decimal (1,5 / 1.5).
    if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, '');
    else raw = raw.replace(',', '.');
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    const suf = (m[2] ?? '').toLowerCase();
    if (suf === 'k' || suf === 'mil') n *= 1_000;
    else if (suf === 'm' || suf === 'mm' || suf === 'millones') n *= 1_000_000;
    out.push(n);
  }
  return out;
}

/**
 * Clave de orden de una etiqueta de rango: «Menos de $2M» va antes que «Entre
 * $2M y $3M», y «Más de $4M» después de «Entre $3M y $4M». null si la etiqueta
 * no tiene números (entonces no es un rango y no se reordena).
 */
export function claveDeRango(label: string): number | null {
  const t = normalizarValorCrudo(label);
  const ns = numeros(t);
  if (ns.length === 0) return null;
  const base = Math.min(...ns);
  if (/^(menos|hasta|inferior|menor|<|under|less)/.test(t)) return base - 0.5;
  if (/^(mas|más|superior|mayor|desde|>|over|more|\+)/.test(t) || /\+\s*$/.test(t))
    return Math.max(...ns) + 0.5;
  return base;
}

/**
 * Ordena las respuestas: de menor a mayor si TODAS son rangos numéricos; si no,
 * se respeta el orden recibido (por frecuencia). `(otros)` va siempre al final.
 */
export function ordenarRespuestas(labels: string[]): string[] {
  const sinOtros = labels.filter((l) => l !== BUCKET_OTROS);
  const claves = sinOtros.map((l) => claveDeRango(l));
  const ordenadas =
    sinOtros.length > 1 && claves.every((k) => k !== null)
      ? sinOtros
          .map((l, i) => ({ l, k: claves[i] as number, i }))
          .sort((a, b) => a.k - b.k || a.i - b.i)
          .map((x) => x.l)
      : sinOtros;
  return labels.includes(BUCKET_OTROS) ? [...ordenadas, BUCKET_OTROS] : ordenadas;
}

// ── Configuración de un clic ──────────────────────────────────────────

export interface PreguntaParaActivar {
  /** Clave cruda más frecuente, para proponer el nombre. */
  etiqueta: string;
  claves_origen: string[];
  /** Respuestas vistas en los leads, con su frecuencia. */
  valores: CampoValorCrudo[];
  /** Opciones que publica la plataforma, si las hay (lista cerrada). */
  opciones?: OpcionDePregunta[];
  /** Tipo que declara la plataforma; si no, se deduce de `es_opcion`. */
  tipo?: TipoPregunta | null;
  es_opcion?: boolean;
}

export interface CampoAutomatico {
  nombre: string;
  clave: string;
  claves_origen: string[];
  valores_map: Record<string, string>;
  valores_orden: string[];
  sin_mapear: 'crudo' | 'otros' | 'ignorar';
  tipo: TipoPregunta;
}

export function configurarCampoAutomatico(p: PreguntaParaActivar): CampoAutomatico {
  const mapa: Record<string, string> = {};
  const frecuencia = new Map<string, number>();
  const suma = (label: string, n: number) =>
    frecuencia.set(label, (frecuencia.get(label) ?? 0) + n);

  // 1. Opciones de la plataforma: su etiqueta manda, y cualquier forma en que
  //    llegue la opción (su valor interno o su texto) cae en ella.
  const porFirma = new Map<string, string>();
  for (const o of p.opciones ?? []) {
    const label = limpiarEtiqueta(o.etiqueta || o.valor);
    if (!label || esValorPlaceholder(label)) continue;
    for (const forma of [o.valor, o.etiqueta]) {
      if (!forma) continue;
      mapa[normalizarValorCrudo(forma)] = label;
      const f = firmaDeValorLead(forma);
      if (f) porFirma.set(f, label);
    }
    if (!frecuencia.has(label)) frecuencia.set(label, 0);
  }

  // 2. Lo que se ve en los leads: placeholders fuera; el resto, a la opción de
  //    su misma firma o a un grupo propio con la variante más frecuente.
  const grupos = new Map<string, CampoValorCrudo[]>();
  for (const v of p.valores) {
    const norm = normalizarValorCrudo(v.valor_crudo);
    if (!norm) continue;
    if (esValorPlaceholder(v.valor_crudo)) {
      mapa[norm] = '';
      continue;
    }
    if (mapa[norm]) {
      suma(mapa[norm], v.filas);
      continue;
    }
    const f = firmaDeValorLead(v.valor_crudo);
    const deOpcion = f ? porFirma.get(f) : undefined;
    if (deOpcion) {
      mapa[norm] = deOpcion;
      suma(deOpcion, v.filas);
      continue;
    }
    const k = f || norm;
    const l = grupos.get(k);
    if (l) l.push(v);
    else grupos.set(k, [v]);
  }
  for (const grupo of grupos.values()) {
    const masFrecuente = [...grupo].sort((a, b) => b.filas - a.filas)[0];
    const label = limpiarEtiqueta(masFrecuente.valor_crudo.trim());
    for (const v of grupo) {
      mapa[normalizarValorCrudo(v.valor_crudo)] = label;
      suma(label, v.filas);
    }
  }

  const porFrecuencia = [...frecuencia.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l]) => l);
  const hayOpciones = (p.opciones ?? []).length > 0;
  const tipo: TipoPregunta = p.tipo ?? (hayOpciones || p.es_opcion ? 'opcion' : 'texto');

  const nombre = nombreDePregunta(p.etiqueta) || 'Pregunta';
  return {
    nombre,
    clave: slugCampo(nombre) || 'pregunta',
    claves_origen: p.claves_origen,
    valores_map: mapa,
    valores_orden: ordenarRespuestas(porFrecuencia),
    // Con la lista cerrada de la plataforma, lo que no encaja es ruido (un
    // valor de prueba, una opción retirada): va a `(otros)` en vez de abrir
    // una barra nueva. Sin ella se deja tal cual, para no esconder respuestas.
    sin_mapear: hayOpciones ? 'otros' : 'crudo',
    tipo,
  };
}

/**
 * Respuestas vistas en los leads que el campo todavía no clasifica: las que
 * con `sin_mapear: 'crudo'` saldrían tal cual. Es el «N respuestas nuevas sin
 * clasificar» de la pantalla de Leads.
 */
export function respuestasSinClasificar(
  campo: { valores_map: Record<string, string | null | undefined> },
  valores: CampoValorCrudo[]
): CampoValorCrudo[] {
  const mapa = campo.valores_map ?? {};
  return valores.filter((v) => {
    const norm = normalizarValorCrudo(v.valor_crudo);
    return norm && !Object.prototype.hasOwnProperty.call(mapa, norm);
  });
}

// ── Una lista de preguntas para la pantalla de Leads ─────────────────

/** Pregunta publicada por una plataforma (fila de `lead_preguntas`). */
export interface PreguntaDePlataforma {
  fuente: 'meta' | 'ghl' | 'wordpress' | 'detectado';
  form_id?: string | null;
  form_name?: string | null;
  clave_origen: string;
  clave_norm: string;
  etiqueta?: string | null;
  tipo: string;
  opciones?: OpcionDePregunta[];
}

/** Pregunta detectada en los leads (`detectarCamposDeLeads`). */
export interface PreguntaDetectadaEnLeads {
  clave: string;
  clave_norm: string;
  leads: number;
  distintos: number;
  es_opcion: boolean;
  formularios: string[];
  valores: CampoValorCrudo[];
}

/** Una pregunta tal como la enseña la pantalla de Leads: todas sus fuentes juntas. */
export interface PreguntaUnificada {
  clave_norm: string;
  /** Clave cruda más representativa (la de la plataforma si la hay). */
  clave: string;
  /** Nombre propuesto: la etiqueta de la plataforma o la clave legible. */
  nombre: string;
  fuentes: ('meta' | 'ghl' | 'wordpress' | 'leads')[];
  formularios: string[];
  tipo: TipoPregunta | null;
  opciones: OpcionDePregunta[];
  leads: number;
  distintos: number;
  es_opcion: boolean;
  valores: CampoValorCrudo[];
}

const TIPOS_MEDIBLES = new Set(['opcion', 'multiple', 'texto', 'numero']);

/**
 * Funde lo detectado en los leads con lo que publican las plataformas, por clave
 * normalizada. La plataforma manda en el nombre, el tipo y las opciones; los
 * leads aportan los recuentos y las variantes de escritura reales.
 */
export function unificarPreguntas(
  detectadas: PreguntaDetectadaEnLeads[],
  plataforma: PreguntaDePlataforma[]
): PreguntaUnificada[] {
  const porClave = new Map<string, PreguntaUnificada>();
  const dame = (clave_norm: string, clave: string): PreguntaUnificada => {
    let p = porClave.get(clave_norm);
    if (!p) {
      p = {
        clave_norm,
        clave,
        nombre: nombreDePregunta(clave),
        fuentes: [],
        formularios: [],
        tipo: null,
        opciones: [],
        leads: 0,
        distintos: 0,
        es_opcion: false,
        valores: [],
      };
      porClave.set(clave_norm, p);
    }
    return p;
  };

  for (const d of detectadas) {
    const p = dame(d.clave_norm, d.clave);
    p.leads += d.leads;
    p.distintos = Math.max(p.distintos, d.distintos);
    p.es_opcion ||= d.es_opcion;
    p.valores = d.valores;
    for (const f of d.formularios) if (!p.formularios.includes(f)) p.formularios.push(f);
    if (!p.fuentes.includes('leads')) p.fuentes.push('leads');
  }

  for (const q of plataforma) {
    if (q.fuente === 'detectado') continue;
    // Datos de contacto (correo, teléfono, fecha): no son preguntas medibles.
    if (!TIPOS_MEDIBLES.has(q.tipo)) continue;
    const p = dame(q.clave_norm, q.clave_origen);
    if (!p.fuentes.includes(q.fuente)) p.fuentes.push(q.fuente);
    if (q.etiqueta) p.nombre = limpiarEtiqueta(q.etiqueta);
    if (q.form_name && !p.formularios.includes(q.form_name)) p.formularios.push(q.form_name);
    if (q.tipo === 'multiple' || (q.tipo === 'opcion' && p.tipo !== 'multiple'))
      p.tipo = q.tipo as TipoPregunta;
    else if (!p.tipo && (q.tipo === 'texto' || q.tipo === 'numero'))
      p.tipo = q.tipo as TipoPregunta;
    const vistos = new Set(p.opciones.map((o) => normalizarValorCrudo(o.valor)));
    for (const o of q.opciones ?? []) {
      const k = normalizarValorCrudo(o.valor);
      if (k && !vistos.has(k)) {
        vistos.add(k);
        p.opciones.push(o);
      }
    }
    if (p.opciones.length > 0) p.es_opcion = true;
  }

  return [...porClave.values()].sort(
    (a, b) => Number(b.es_opcion) - Number(a.es_opcion) || b.leads - a.leads
  );
}
