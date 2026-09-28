// Catálogo fijo del BI: las fuentes de datos y sus campos, en la forma que
// consume el editor.
//
// Vivía dentro de `/api/report-utm/bi/catalog`. Se extrajo para que las
// herramientas del agente (`list_report_fields`) ofrezcan EXACTAMENTE los mismos
// ids que el selector de campos, sin pasar por HTTP ni duplicar el mapeo
// canónico → histórico. Es puro: no toca la base.
//
// Cada campo lleva DOS ids: el canónico (`ads.spend`) y el histórico (`spend`).
// El editor guarda el HISTÓRICO, así que los informes siguen escribiéndose
// exactamente igual que hoy.

import { BASE_REGISTRY, isAdditive, isPivotable, fieldCrossesDimension } from './registry';
import {
  CANONICAL_TO_LEGACY_MEASURE,
  LEGACY_DIMENSION_IDS,
  migrateDimensionId,
} from './legacy-tokens';
import type { MeasureField, DimensionField } from './registry-types';

/** Inverso de LEGACY_DIMENSION_IDS, para devolver el id que el editor guarda. */
const CANONICAL_TO_LEGACY_DIM: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [legacy, canonical] of Object.entries(LEGACY_DIMENSION_IDS)) {
    // El primero gana: `utm_campaign` antes que el alias `campaign`.
    if (!(canonical in out)) out[canonical] = legacy;
  }
  return out;
})();

export interface CampoSalida {
  id: string; // el que se guarda (histórico si existe)
  canonicalId: string;
  label: string;
  help: string;
  kind: 'measure' | 'dimension';
  format?: string;
  group: string;
  recommended?: boolean;
  additive?: boolean;
  pivotable?: boolean;
  /** Etapa del embudo, si sirve como tal. */
  funnelStage?: number;
  /** Mide lo mismo que estas otras: sumarlas cuenta doble. */
  conflictsWith?: string[];
  direction?: 'up' | 'down';
  /** Solo si se pidió con `dimension`: ¿cruza con ella? */
  crossesDimension?: boolean;
}

export interface FuenteSalida {
  id: string;
  label: string;
  /** `row` | `daily` | `snapshot`. Explica qué se puede hacer con ella. */
  grain: string;
  /** Qué hace única una fila, en texto: se muestra como ayuda. */
  grainText: string;
  /** Ejes por los que esta fuente cruza con las demás. */
  joinAxes: string[];
  /** `false` si necesita el enlace de cliente y falta. */
  available: boolean;
  /** Motivo cuando no está disponible. */
  unavailableReason?: string;
  fields: CampoSalida[];
}

/**
 * Fuentes y campos del catálogo fijo.
 *
 * `hasPublicLink` decide si media plataforma es legible: sin el puente
 * `public_cliente_id` las fuentes de `public` (gasto, GA4, Hotmart) se marcan
 * como no disponibles con su motivo, en vez de listar 40 métricas que darán 0.
 *
 * Con `dimension`, cada métrica dice si cruza con ella, para descartar de
 * antemano lo que mostraría 0.
 */
export function catalogoEstatico(hasPublicLink: boolean, dimension?: string): FuenteSalida[] {
  const reg = BASE_REGISTRY;
  return reg.sources.map((src) => {
    const necesitaEnlace = src.clientKey.scope === 'public';
    const available = !necesitaEnlace || hasPublicLink;

    const fields: CampoSalida[] = src.fields.map((f) => {
      const base = {
        canonicalId: f.id,
        label: f.label,
        group: f.group,
      };
      if (f.kind === 'measure') {
        const m = f as MeasureField;
        return {
          ...base,
          id: CANONICAL_TO_LEGACY_MEASURE[m.id] ?? m.id,
          help: m.help,
          kind: 'measure' as const,
          format: m.format,
          recommended: m.recommended,
          additive: isAdditive(m),
          pivotable: isPivotable(reg, m.id),
          funnelStage: m.funnelStage,
          conflictsWith: m.conflictsWith?.map((id) => CANONICAL_TO_LEGACY_MEASURE[id] ?? id),
          direction: m.direction,
        };
      }
      const d = f as DimensionField;
      return {
        ...base,
        id: CANONICAL_TO_LEGACY_DIM[d.id] ?? d.id,
        help: '',
        kind: 'dimension' as const,
      };
    });

    // Si el widget ya tiene dimensión, se marca lo que no cruza con ella. El
    // editor manda el id HISTÓRICO (`ip_country`) y el registro busca el
    // canónico: sin traducirlo, `fieldCrossesDimension` no encontraba la
    // dimensión y daba todo por válido, así que nunca se marcaba nada.
    const dimCanonica = dimension ? migrateDimensionId(dimension) : undefined;
    const conCruce = dimCanonica
      ? fields.map((f) => ({
          ...f,
          crossesDimension:
            f.kind === 'dimension' ? true : fieldCrossesDimension(reg, f.canonicalId, dimCanonica),
        }))
      : fields;

    return {
      id: src.id,
      label: src.label,
      grain: src.grainKind,
      grainText: src.grain.join(' × '),
      joinAxes: [...src.joinAxes],
      available,
      unavailableReason: available
        ? undefined
        : 'Este cliente no está enlazado con su cliente de Reporting.',
      fields: conCruce,
    };
  });
}
