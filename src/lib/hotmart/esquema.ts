// ── ¿Está aplicada la migración 089? ──────────────────────────────────
//
// La 089 añade a `hotmart_ventas` las columnas de atribución
// (`atribucion_metodo`, `atribucion_lead_id`, `atribucion_at`), el reclamo de
// notificaciones (`notificado_estado`) y `estado_crudo`, más la RPC
// `hotmart_leads_para_atribucion`.
//
// La migración la aplica una persona. Hasta entonces el código se comporta como
// siempre: la RPC de guardado ignora las claves nuevas, la atribución por lead
// no hace nada y el webhook deduplica notificaciones con el estado previo de
// `sales_events`. Es el mismo patrón que `columnasIdDisponibles` (082).

export const COLUMNAS_089 = [
  'atribucion_metodo',
  'atribucion_lead_id',
  'atribucion_at',
  'notificado_estado',
  'estado_crudo',
] as const;

const REINTENTO_SIN_COLUMNA_MS = 5 * 60_000;
let estado089: { disponible: boolean; ts: number } | null = null;

/**
 * ¿Existen las columnas de la 089 en `public.hotmart_ventas`? Un resultado
 * positivo se recuerda para siempre; uno negativo, 5 minutos (lo que tarda en
 * notarse que alguien la aplicó sin reiniciar el proceso).
 */
export async function columnas089Disponibles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<boolean> {
  const ahora = Date.now();
  if (estado089?.disponible) return true;
  if (estado089 && ahora - estado089.ts < REINTENTO_SIN_COLUMNA_MS) return false;
  try {
    const pub = typeof db?.schema === 'function' ? db.schema('public') : db;
    // Filtrada por un cliente que no existe: el sondeo solo necesita que
    // PostgREST valide las columnas, y así cumple la regla de
    // `verify-hotmart-ventas` (ninguna lectura de la tabla sin cliente).
    const { error } = await pub
      .from('hotmart_ventas')
      .select(COLUMNAS_089.join(','))
      .eq('cliente_id', '00000000-0000-0000-0000-000000000000')
      .limit(1);
    // Solo un «columna no existe» (42703) cuenta como NO. Un error de red no
    // decide nada: se reintenta en la siguiente llamada.
    if (error) {
      if ((error as { code?: string }).code === '42703') {
        estado089 = { disponible: false, ts: ahora };
      }
      return false;
    }
    estado089 = { disponible: true, ts: ahora };
    return true;
  } catch {
    return false;
  }
}

/** Solo para las comprobaciones: fija o olvida lo aprendido sobre la 089. */
export function fijarEstado089(disponible: boolean | null): void {
  estado089 = disponible === null ? null : { disponible, ts: Date.now() };
}
