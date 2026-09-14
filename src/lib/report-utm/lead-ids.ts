// ── IDs publicitarios dedicados de un lead (migración 082) ────────────
//
// Hasta la 082 un lead solo guardaba sus UTM, y el ID de la entidad llegaba —si
// llegaba— dentro de `utm_id`, `utm_content` o `utm_term`. Meta Lead Ads recibía
// `ad_id` y `adset_id` y los tiraba; GHL los dejaba enterrados en `custom_data`.
// Con estas tres columnas el cruce baja a conjunto y anuncio por ID exacto, sin
// depender de que el nombre no se repita entre campañas ni se haya renombrado
// (ver docs/22-auditoria-cruce-por-id.md).
//
// La migración la aplica una persona. Hasta entonces el código se comporta como
// siempre: no pide las columnas ni las escribe. Es el mismo patrón que
// `columnaExcluidoDisponible` de `lead-exclusion.ts`.

export const COLUMNAS_ID = ['campaign_id', 'adset_id', 'ad_id'] as const;
export type ColumnaId = (typeof COLUMNAS_ID)[number];
export type IdsPublicitarios = Record<ColumnaId, string | null>;

/**
 * Las mismas columnas en `sales_events`, que existen desde la migración 012 con
 * otro nombre. El alias de PostgREST (`alias:columna`) las entrega con el nombre
 * que lee el resolver, así ventas y leads cruzan con el mismo código.
 */
export const SELECT_IDS_VENTA = [
  'campaign_id:ad_campaign_id',
  'adset_id:ad_set_id',
  'ad_id',
] as const;

/**
 * ¿El valor es un ID numérico de plataforma y no un nombre?
 *
 * Solo dígitos y al menos 10: los de Meta tienen 15-18 y los de TikTok 16-19. El
 * umbral evita que un anuncio llamado `2026` pase por ID, y deja fuera las
 * macros sin rellenar (`{{ad.id}}`, `__CID__`), que no deben guardarse como ID.
 */
export function esIdPublicitario(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  return /^\d{10,}$/.test(String(v).trim());
}

/** El ID limpio, o null si el valor no es un ID. */
export function idPublicitario(v: unknown): string | null {
  return esIdPublicitario(v) ? String(v).trim() : null;
}

export function idsPublicitarios(campaign: unknown, adset: unknown, ad: unknown): IdsPublicitarios {
  return {
    campaign_id: idPublicitario(campaign),
    adset_id: idPublicitario(adset),
    ad_id: idPublicitario(ad),
  };
}

export const SIN_IDS: IdsPublicitarios = { campaign_id: null, adset_id: null, ad_id: null };

// ── ¿Está aplicada la 082? ────────────────────────────────────────────

const REINTENTO_SIN_COLUMNA_MS = 5 * 60_000;
let columnasId: { disponible: boolean; ts: number } | null = null;

/**
 * ¿Existen `report_utm.lead_events.campaign_id / adset_id / ad_id`? Recibe
 * cualquier cliente Supabase (con o sin `.schema('report_utm')` ya aplicado).
 */
export async function columnasIdDisponibles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<boolean> {
  const ahora = Date.now();
  if (columnasId?.disponible) return true;
  if (columnasId && ahora - columnasId.ts < REINTENTO_SIN_COLUMNA_MS) return false;
  try {
    const rtm = typeof db?.schema === 'function' ? db.schema('report_utm') : db;
    const { error } = await rtm.from('lead_events').select(COLUMNAS_ID.join(',')).limit(1);
    // Solo un «columna no existe» (42703) cuenta como NO. Un error de red no
    // decide nada: se reintenta en la siguiente llamada.
    if (error) {
      if ((error as { code?: string }).code === '42703') {
        columnasId = { disponible: false, ts: ahora };
      }
      return false;
    }
    columnasId = { disponible: true, ts: ahora };
    return true;
  } catch {
    return false;
  }
}

/** Solo para las comprobaciones: olvida lo aprendido sobre las columnas. */
export function olvidarColumnasId(): void {
  columnasId = null;
}

/**
 * Quita las columnas de ID de una fila de `lead_events` si la base aún no las
 * tiene. Los `buildLeadRow` las incluyen siempre (son puros y los prueban las
 * comprobaciones); la decisión de escribirlas se toma aquí, al insertar.
 */
export function adaptarIds<T extends Record<string, unknown>>(row: T, disponible: boolean): T {
  if (disponible) return row;
  const copia: Record<string, unknown> = { ...row };
  for (const c of COLUMNAS_ID) delete copia[c];
  return copia as T;
}

/**
 * Columnas de `lead_events` que necesita el resolver: las UTM de siempre y, con
 * la 082 aplicada, los IDs dedicados.
 */
export async function columnasCruceLead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  base: readonly string[]
): Promise<string[]> {
  return (await columnasIdDisponibles(db)) ? [...base, ...COLUMNAS_ID] : [...base];
}
