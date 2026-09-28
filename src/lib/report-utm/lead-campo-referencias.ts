/**
 * ¿Quién está usando este campo de lead?
 *
 * Antes de desactivar o borrar un campo hay que saber qué informes y qué
 * pestañas se quedarían sin datos. Sin esta comprobación el fallo es mudo: el
 * catálogo se lee con `soloActivos:true`, así que un campo retirado no produce
 * ningún error, simplemente deja de aparecer y el widget que lo usaba muestra 0
 * o un cartel de "ya no está disponible".
 *
 * Ya pasó. `scripts/migrar-segmentos-lead.ts` desactivó los cuatro campos-umbral
 * de Goodprop con una salvaguarda que solo miraba los tokens `leadfield:<clave>`
 * y `lf__<clave>__`. Pero un bloque de respuestas guarda la clave DESNUDA dentro
 * de `lead_answer_blocks`, sin prefijo ninguno, así que la salvaguarda dio el
 * visto bueno y dos bloques de la pestaña «Evergreen Captacion» se quedaron
 * rotos durante semanas sin que nada lo dijera.
 *
 * De ahí que este módulo busque las CUATRO formas, y que la de los bloques se
 * compruebe sobre el array ya parseado en vez de por texto: es la que se olvidó.
 */

import type { LeadSegmentoDef } from './lead-campos';
import { extraerReferenciasDeLead } from '@/lib/leads/respuestas/claves';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type OrigenReferencia = 'informe' | 'pestaña' | 'layout' | 'plantilla';

export interface ReferenciaCampo {
  origen: OrigenReferencia;
  id: string;
  /** Nombre legible: el del informe o el de la pestaña. */
  nombre: string;
  /** Qué lo referencia, en términos que el analista reconoce. */
  motivo: string;
}

/** Tablas de layout que pueden llevar bloques o fórmulas. */
const TABLAS_LAYOUT: { tabla: string; origen: OrigenReferencia; porCliente: boolean }[] = [
  { tabla: 'cliente_tabs', origen: 'pestaña', porCliente: true },
  { tabla: 'clientes_layouts', origen: 'layout', porCliente: true },
  // Las plantillas no pertenecen a un cliente: una que nombre esta clave se
  // rompería en cuanto se aplicara, así que también cuentan.
  { tabla: 'tab_templates', origen: 'plantilla', porCliente: false },
  // Las plantillas globales del dashboard (las que una pestaña usa por
  // `plantilla_id`). Faltaban hasta la auditoría del 2026-09-26.
  { tabla: 'layouts_reporte', origen: 'plantilla', porCliente: false },
];

// Formas en que aparece un campo (y sus segmentos, que mueren con él por el
// `ON DELETE CASCADE` de `lead_campo_segmentos.campo_id`):
//   `leadfield:<clave>` (dimensión o filtro), `lf__<clave>__<resp>` y
//   `leadans:<clave>:<resp>` (respuestas), `lseg__<seg>` y `leadseg:<seg>`.
// Se reconocen con `extraerReferenciasDeLead`, por TOKEN EXACTO.

/** Nombre legible de una fila de layout, que no siempre tiene `nombre`. */
function nombreDeFila(fila: any, origen: OrigenReferencia): string {
  return String(fila?.nombre ?? fila?.title ?? `${origen} ${String(fila?.id ?? '').slice(0, 8)}`);
}

/**
 * Informes y layouts que dejarían de funcionar si este campo se retira.
 *
 * `rtmClienteId` filtra los informes (`bi_reports.cliente_id` guarda el id de
 * report_utm) y `publicClienteId` los layouts (que van contra el id público).
 * Cuando el cliente no está enlazado, `publicClienteId` es null y simplemente no
 * se miran los layouts: no hay ninguno que pueda apuntarle.
 */
export async function referenciasDeCampoLead(
  db: any,
  opts: {
    rtmClienteId: string;
    publicClienteId?: string | null;
    /** Campo buscado. Vacío = solo se buscan los segmentos. */
    clave: string;
    /** Segmentos hijos, que caen con el padre. */
    segmentos?: Pick<LeadSegmentoDef, 'clave' | 'nombre'>[];
    /**
     * Solo estas respuestas del campo (claves), no el campo entero: es lo que
     * se pregunta antes de retirar o fusionar una respuesta. La pregunta sigue
     * existiendo, así que `leadfield:` y los bloques no cuentan.
     */
    respuestas?: string[];
  }
): Promise<ReferenciaCampo[]> {
  const { rtmClienteId, publicClienteId, clave, segmentos = [], respuestas } = opts;
  if (!clave && segmentos.length === 0) return [];

  const out: ReferenciaCampo[] = [];
  const segsPorClave = new Map(segmentos.map((s) => [s.clave, s]));

  /**
   * Busca las referencias en el texto de una fila y devuelve el motivo, o null.
   *
   * Por TOKEN EXACTO: con `includes`, un campo `rango` daba por usado
   * `leadfield:rango_de_ingresos`, y un segmento `desde_2` daba por usado
   * `lseg__desde_2m` (auditoría del 2026-09-26).
   */
  const motivoEnTexto = (txt: string): string | null => {
    const refs = extraerReferenciasDeLead(txt);
    if (clave) {
      if (!respuestas) {
        const c = refs.campos.find((x) => x.clave === clave);
        if (c) return `usa \`${c.texto}\``;
      }
      const rsp = refs.respuestas.find(
        (x) => x.campo === clave && (!respuestas || respuestas.includes(x.resp))
      );
      if (rsp) return `usa \`${rsp.texto}\``;
    }
    for (const x of refs.segmentos) {
      const seg = segsPorClave.get(x.clave);
      if (seg) return `usa el segmento «${seg.nombre}» (\`${x.texto}\`)`;
    }
    return null;
  };

  // ── Informes del BI ──────────────────────────────────────────────────
  // Se incluyen los que no tienen cliente (plantillas del sistema): un token de
  // campo dentro de una plantilla se rompe igual en cuanto alguien la aplica.
  const { data: informes, error: errInformes } = await db
    .from('bi_reports')
    .select('id,nombre,layout,filters,calculated_fields')
    .or(`cliente_id.eq.${rtmClienteId},cliente_id.is.null`);

  if (!errInformes) {
    for (const r of (informes ?? []) as any[]) {
      const motivo = motivoEnTexto(
        JSON.stringify([r.layout ?? [], r.filters ?? {}, r.calculated_fields ?? []])
      );
      if (motivo) {
        out.push({ origen: 'informe', id: r.id, nombre: String(r.nombre ?? 'sin nombre'), motivo });
      }
    }
  }

  // ── Layouts del dashboard ────────────────────────────────────────────
  for (const { tabla, origen, porCliente } of TABLAS_LAYOUT) {
    if (porCliente && !publicClienteId) continue;

    let q = db.from(tabla).select('*');
    if (porCliente) q = q.eq('cliente_id', publicClienteId);
    const { data, error } = await q;
    if (error) continue;

    for (const fila of (data ?? []) as any[]) {
      // 1) Bloques de respuestas. Se mira el array PARSEADO, no el texto: la
      //    clave va desnuda (`{"origen":"catalogo","clave":"…"}`) y buscarla como
      //    subcadena daría positivos falsos con cualquier otro campo `clave`.
      const bloques = Array.isArray(fila.lead_answer_blocks) ? fila.lead_answer_blocks : [];
      const bloque =
        clave && !respuestas
          ? bloques.find((b: any) => b?.origen === 'catalogo' && b?.clave === clave)
          : undefined;
      if (bloque) {
        out.push({
          origen,
          id: String(fila.id),
          nombre: nombreDeFila(fila, origen),
          motivo: `bloque de respuestas «${bloque.title ?? bloque.label ?? clave}»`,
        });
        continue;
      }

      // 2) Fórmulas y configuración de widgets, por token.
      const motivo = motivoEnTexto(JSON.stringify(fila));
      if (motivo) {
        out.push({ origen, id: String(fila.id), nombre: nombreDeFila(fila, origen), motivo });
      }
    }
  }

  return out;
}

/** Resumen de una frase para un `confirm()`. Devuelve '' si no hay nada. */
export function resumirReferencias(refs: ReferenciaCampo[]): string {
  if (refs.length === 0) return '';
  const porOrigen: Record<string, number> = {};
  for (const r of refs) porOrigen[r.origen] = (porOrigen[r.origen] ?? 0) + 1;
  const plural: Record<OrigenReferencia, [string, string]> = {
    informe: ['informe', 'informes'],
    pestaña: ['pestaña', 'pestañas'],
    layout: ['layout', 'layouts'],
    plantilla: ['plantilla', 'plantillas'],
  };
  const partes = Object.entries(porOrigen).map(
    ([o, n]) => `${n} ${plural[o as OrigenReferencia][n === 1 ? 0 : 1]}`
  );
  return partes.join(', ');
}
