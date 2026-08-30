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
];

/**
 * Tokens de texto con los que un campo aparece dentro de una fórmula o de la
 * configuración de un widget.
 *
 * - `leadfield:<clave>` — dimensión o filtro del BI
 * - `lf__<clave>__` — métrica "leads que respondieron X" en una fórmula
 */
function tokensDeCampo(clave: string): string[] {
  return [`leadfield:${clave}`, `lf__${clave}__`];
}

/**
 * Tokens de un segmento. Van con el campo porque un segmento muere con su padre:
 * `lead_campo_segmentos.campo_id` tiene `ON DELETE CASCADE`, y `loadLeadSegmentos`
 * descarta los segmentos cuyo campo no venga en la lista, así que desactivar el
 * campo también apaga sus segmentos.
 */
function tokensDeSegmento(clave: string): string[] {
  return [`leadseg:${clave}`, `lseg__${clave}`];
}

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
    clave: string;
    /** Segmentos hijos, que caen con el padre. */
    segmentos?: Pick<LeadSegmentoDef, 'clave' | 'nombre'>[];
  }
): Promise<ReferenciaCampo[]> {
  const { rtmClienteId, publicClienteId, clave, segmentos = [] } = opts;
  if (!clave) return [];

  const out: ReferenciaCampo[] = [];

  const tokensCampo = tokensDeCampo(clave);
  const tokensSeg = segmentos.map((s) => ({ seg: s, tokens: tokensDeSegmento(s.clave) }));

  /** Busca los tokens en el texto de una fila y devuelve el motivo, o null. */
  const motivoEnTexto = (txt: string): string | null => {
    for (const t of tokensCampo) if (txt.includes(t)) return `usa \`${t}\``;
    for (const { seg, tokens } of tokensSeg) {
      for (const t of tokens) {
        if (txt.includes(t)) return `usa el segmento «${seg.nombre}» (\`${t}\`)`;
      }
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
      const bloque = bloques.find((b: any) => b?.origen === 'catalogo' && b?.clave === clave);
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
