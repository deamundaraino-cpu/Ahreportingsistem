// Catálogo unificado del BI: las fuentes de datos y sus campos.
//
// ── Qué sustituye ────────────────────────────────────────────────────────
// El editor hace hoy CUATRO peticiones para armar sus listas
// (`form-fields`, `lead-fields`, `sheet-fields`, `offline-fields`) más una quinta
// de disponibilidad, y luego mezcla todo con seis gramáticas de tokens distintas
// en un `<select>` plano de 72 métricas fijas con 9 optgroups y un
// «Ver todas (60 más)».
//
// Aquí se devuelve UNA estructura: fuentes, y dentro de cada fuente sus campos.
// Es el modelo que hace fácil la configuración en las herramientas del mercado:
// se elige primero la fuente y después el campo, en vez de buscar una aguja en
// una lista de 72.
//
// ── Compatibilidad ───────────────────────────────────────────────────────
// Cada campo lleva DOS ids: el canónico (`ads.spend`) y el histórico
// (`spend`). El editor guarda el HISTÓRICO, así que los informes siguen
// escribiéndose exactamente igual que hoy y no hace falta migrar nada todavía.
// El canónico viaja para que el día que se cambie el formato de guardado el
// cliente ya lo tenga.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { resolvePublicClienteId } from '@/lib/report-utm/campaign-resolver';
import {
  BASE_REGISTRY,
  isAdditive,
  isPivotable,
  fieldCrossesDimension,
} from '@/lib/report-utm/bi/registry';
import {
  CANONICAL_TO_LEGACY_MEASURE,
  LEGACY_DIMENSION_IDS,
} from '@/lib/report-utm/bi/legacy-tokens';
import type { MeasureField, DimensionField } from '@/lib/report-utm/bi/registry-types';

export const dynamic = 'force-dynamic';

/** Inverso de LEGACY_DIMENSION_IDS, para devolver el id que el editor guarda. */
const CANONICAL_TO_LEGACY_DIM: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [legacy, canonical] of Object.entries(LEGACY_DIMENSION_IDS)) {
    // El primero gana: `utm_campaign` antes que el alias `campaign`.
    if (!(canonical in out)) out[canonical] = legacy;
  }
  return out;
})();

interface CampoSalida {
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
}

interface FuenteSalida {
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

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clienteId = req.nextUrl.searchParams.get('cliente_id') ?? undefined;
  // La dimensión actual del widget: sirve para marcar de antemano qué campos
  // NO cruzan con ella, en vez de dejar que el usuario descubra el 0 después.
  const dimension = req.nextUrl.searchParams.get('dimension') ?? undefined;

  try {
    // El puente `public_cliente_id` decide si media plataforma es legible.
    // Declararlo aquí es lo que permite atenuar la fuente ENTERA en el
    // selector con un motivo, en vez de listar 40 métricas que darán 0.
    const hasPublicLink = clienteId ? (await resolvePublicClienteId(clienteId)) !== null : true;

    const reg = BASE_REGISTRY;
    const fuentes: FuenteSalida[] = reg.sources.map((src) => {
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

      // Si el widget ya tiene dimensión, se marca lo que no cruza con ella.
      const conCruce = dimension
        ? fields.map((f) => ({
            ...f,
            crossesDimension:
              f.kind === 'dimension' ? true : fieldCrossesDimension(reg, f.canonicalId, dimension),
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

    return NextResponse.json(
      {
        data: {
          hasPublicLink,
          sources: fuentes,
        },
      },
      { headers: { 'Cache-Control': 'private, max-age=120' } }
    );
  } catch (err) {
    console.error('[bi/catalog]', err);
    return NextResponse.json({ error: 'Catalog error' }, { status: 500 });
  }
}
