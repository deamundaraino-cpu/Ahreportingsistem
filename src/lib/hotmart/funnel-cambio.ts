/**
 * ¿Cambió de verdad el embudo de Hotmart de una pestaña?
 *
 * `saveClienteTab` encolaba una reclasificación de UN AÑO de ventas cada vez que
 * el formulario mandaba `hotmart_funnel`, que es en cada guardado de la pestaña:
 * aunque no se hubiera tocado nada, aunque llegara `null` y aunque el cliente no
 * tuviera Hotmart. Cada una es un trabajo en la cola del worker para nada.
 *
 * Se compara el JSON con las claves ordenadas: el formulario reconstruye el
 * objeto y el orden de sus claves no significa nada. `null`, `undefined` y la
 * ausencia son el mismo «sin embudo».
 *
 * Puro, para comprobarlo desde `scripts/`.
 */

function estable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(estable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      // Una clave a `undefined` no sobrevive al guardado en JSONB: no cuenta.
      if (x !== undefined) out[k] = estable(x);
    }
    return out;
  }
  return v ?? null;
}

export function funnelCambio(guardado: unknown, nuevo: unknown): boolean {
  return JSON.stringify(estable(guardado ?? null)) !== JSON.stringify(estable(nuevo ?? null));
}
