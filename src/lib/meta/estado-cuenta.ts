/**
 * Estado de una cuenta publicitaria de Meta: ¿está gastando o está parada?
 *
 * Hasta el 2026-09-12 nadie lo miraba. Una cuenta que Meta apaga a medianoche por
 * un pago rechazado deja de gastar, el worker guarda `spend = 0` y eso salía como
 * el genérico `zero_vs_previous`, sin causa. El PM lo pidió en la reunión: que si
 * la cuenta queda inactiva por pago, aparezca una alerta.
 *
 * Meta lo expone en el propio objeto de la cuenta (`account_status`,
 * `disable_reason`), sin permisos extra: el mismo token que ya lee insights.
 */

/** `account_status` de la Graph API. */
export const ESTADO_CUENTA: Record<number, string> = {
  1: 'Activa',
  2: 'Inhabilitada',
  3: 'Pago pendiente (sin saldar)',
  7: 'En revisión de riesgo',
  8: 'Liquidación pendiente',
  9: 'En periodo de gracia',
  100: 'Cierre pendiente',
  101: 'Cerrada',
  201: 'Activa (cualquiera)',
  202: 'Cerrada (cualquiera)',
};

/** `disable_reason` de la Graph API. */
export const MOTIVO_INHABILITACION: Record<number, string> = {
  0: 'Sin motivo',
  1: 'Incumplimiento de políticas publicitarias',
  2: 'Revisión de integridad de la cuenta',
  3: 'Riesgo de pago',
  4: 'Cuenta de gray / cuenta de revendedor',
  5: 'Revisión del administrador',
  6: 'Solicitud de revisión',
  7: 'Cuenta de BM cerrada',
  8: 'Cerrada por el anunciante',
  9: 'Revisión de cumplimiento',
  10: 'Revisión de Business Manager',
};

/** Estados en los que la cuenta NO puede publicar anuncios. */
const BLOQUEADOS = new Set([2, 3, 7, 8, 100, 101, 202]);

/** Estados relacionados con el pago: los que se arreglan pagando. */
const POR_PAGO = new Set([3, 8, 9]);

export type EstadoCuentaMeta = {
  account_id: string;
  nombre: string | null;
  status: number | null;
  motivo: number | null;
  moneda: string | null;
  /** No puede publicar: la alerta tiene que saltar. */
  bloqueada: boolean;
  /** El problema es de pago (tarjeta rechazada, saldo pendiente). */
  porPago: boolean;
  texto: string;
};

/** Interpreta la respuesta de la Graph API. Puro: se comprueba sin red. */
export function interpretarEstadoCuenta(raw: {
  account_id?: string;
  id?: string;
  name?: string;
  account_status?: number | string;
  disable_reason?: number | string;
  currency?: string;
}): EstadoCuentaMeta {
  const status = raw.account_status == null ? null : Number(raw.account_status);
  const motivo = raw.disable_reason == null ? null : Number(raw.disable_reason);
  const bloqueada = status !== null && BLOQUEADOS.has(status);
  const porPago = (status !== null && POR_PAGO.has(status)) || motivo === 3;
  const estado = status !== null ? (ESTADO_CUENTA[status] ?? `Estado ${status}`) : 'Desconocido';
  const causa =
    motivo && motivo !== 0 ? ` · ${MOTIVO_INHABILITACION[motivo] ?? `motivo ${motivo}`}` : '';
  return {
    account_id: String(raw.account_id ?? raw.id ?? '').replace(/^act_/, ''),
    nombre: raw.name ?? null,
    status,
    motivo,
    moneda: raw.currency ?? null,
    bloqueada,
    porPago,
    texto: `${estado}${causa}`,
  };
}

/**
 * Consulta el estado de una cuenta. Un fallo de red o de token devuelve `null`:
 * no saber el estado NO es lo mismo que una cuenta bloqueada, y no debe saltar la
 * alerta por un corte momentáneo.
 */
export async function consultarEstadoCuenta(
  accountId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<EstadoCuentaMeta | null> {
  const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
  const version = process.env.META_GRAPH_API_VERSION || 'v19.0';
  const url = new URL(`https://graph.facebook.com/${version}/${actId}`);
  url.searchParams.set('fields', 'account_id,name,account_status,disable_reason,currency');
  url.searchParams.set('access_token', token);
  try {
    const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.error) return null;
    return interpretarEstadoCuenta(j);
  } catch {
    return null;
  }
}
