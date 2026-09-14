/**
 * Alerta de cuenta de Meta que no puede publicar (pago rechazado, inhabilitada…).
 *
 * La llama el worker una vez por cliente y por corrida. Por cada cuenta:
 *   1. pregunta a Meta su `account_status` (una llamada barata, mismo token);
 *   2. deja el estado en `config_api.meta_estado_cuentas`, que es lo que lee el
 *      panel de salud (`salud-fuentes-db.ts`);
 *   3. si alguna está bloqueada, avisa en la campana y en el grupo de WhatsApp
 *      del equipo — una vez cada 24 h por cliente, no en cada corrida.
 *
 * No toca la sincronización: un fallo aquí se registra y se sigue. Y no saber el
 * estado (red, token) NO cuenta como bloqueada: la alerta solo salta con una
 * respuesta explícita de Meta.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { consultarEstadoCuenta, type EstadoCuentaMeta } from './estado-cuenta';
import { notifyUsers } from '@/lib/notifications/notify';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const REVISION_TTL_MS = 3 * 60 * 60 * 1000;
const MOTIVO = 'meta_cuenta_bloqueada';

/** Cuentas de Meta configuradas en un cliente, sin duplicados. */
export function cuentasMetaDe(
  config: Record<string, any>
): Array<{ account_id: string; token: string }> {
  let cuentas: Array<{ account_id: string; token: string }> = [];
  if (Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) {
    cuentas = config.meta_accounts
      .filter((a: any) => a?.account_id)
      .map((a: any) => ({
        account_id: String(a.account_id),
        token: a.token || config.meta_token || '',
      }));
  } else if (config.meta_token && config.meta_account_id) {
    cuentas = [{ account_id: String(config.meta_account_id), token: String(config.meta_token) }];
  }
  const vistas = new Set<string>();
  return cuentas.filter((c) => {
    const k = c.account_id.replace(/^act_/, '');
    if (!c.token || vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

/** Mensaje humano para la alerta. Puro. */
export function mensajeAlerta(clienteNombre: string, bloqueadas: EstadoCuentaMeta[]): string {
  const detalle = bloqueadas
    .map((b) => `${b.nombre ?? b.account_id}: ${b.texto}${b.porPago ? ' (revisar el pago)' : ''}`)
    .join(' · ');
  return `⚠️ ${clienteNombre}: Meta tiene ${bloqueadas.length === 1 ? 'una cuenta' : `${bloqueadas.length} cuentas`} sin poder publicar. ${detalle}`;
}

export async function revisarEstadoCuentasMeta(
  db: any,
  cliente: { id: string; nombre?: string | null; config_api?: Record<string, any> | null }
): Promise<{ revisadas: number; bloqueadas: number; avisado: boolean }> {
  const cuentas = cuentasMetaDe(cliente.config_api ?? {});
  if (cuentas.length === 0) return { revisadas: 0, bloqueadas: 0, avisado: false };

  // El worker corre a diario y además desde el fallback de GitHub Actions cada
  // 30 min: sin este umbral serían ~48 consultas al día por cuenta. Si todas se
  // revisaron hace menos de 3 h, no se vuelve a preguntar a Meta (y si alguna
  // estaba bloqueada, su aviso ya salió: el dedupe es de 24 h).
  const revisionesPrevias = (cliente.config_api?.meta_estado_cuentas ?? {}) as Record<
    string,
    { revisada_at?: string }
  >;
  const todasRecientes = cuentas.every((c) => {
    const r = revisionesPrevias[c.account_id.replace(/^act_/, '')]?.revisada_at;
    return Boolean(r) && Date.now() - Date.parse(String(r)) < REVISION_TTL_MS;
  });
  if (todasRecientes) return { revisadas: 0, bloqueadas: 0, avisado: false };

  const estados = (
    await Promise.all(cuentas.map((c) => consultarEstadoCuenta(c.account_id, c.token)))
  ).filter((e): e is EstadoCuentaMeta => e !== null);
  if (estados.length === 0) return { revisadas: 0, bloqueadas: 0, avisado: false };

  const ahora = new Date().toISOString();
  const parche: Record<string, unknown> = {};
  for (const e of estados) {
    parche[e.account_id] = {
      status: e.status,
      motivo: e.motivo,
      bloqueada: e.bloqueada,
      texto: e.texto,
      nombre: e.nombre,
      moneda: e.moneda,
      revisada_at: ahora,
    };
  }
  // Merge atómico (migración 066): no pisa lo que otro escritor haya guardado
  // en `config_api` entre medias.
  const previo = (cliente.config_api?.meta_estado_cuentas ?? {}) as Record<string, unknown>;
  await db
    .rpc('fusionar_config_api', {
      p_cliente_id: cliente.id,
      p_parche: { meta_estado_cuentas: { ...previo, ...parche } },
    })
    .then(
      () => undefined,
      () => undefined
    );

  const bloqueadas = estados.filter((e) => e.bloqueada);
  if (bloqueadas.length === 0) return { revisadas: estados.length, bloqueadas: 0, avisado: false };

  const { data: reciente } = await db
    .from('notifications')
    .select('id')
    .eq('cliente_id', cliente.id)
    .eq('metadata->>reason', MOTIVO)
    .gte('created_at', new Date(Date.now() - DEDUPE_MS).toISOString())
    .limit(1);
  if (reciente && reciente.length > 0) {
    return { revisadas: estados.length, bloqueadas: bloqueadas.length, avisado: false };
  }

  const nombre = cliente.nombre ?? 'Cliente';
  const mensaje = mensajeAlerta(nombre, bloqueadas);
  await notifyUsers({
    db,
    // `system` y no un tipo nuevo: añadir uno exige migrar el CHECK de
    // `public.notifications`, y la alerta no puede esperar a eso. El motivo
    // viaja en `metadata.reason`, que es por lo que se deduplica.
    type: 'system',
    severity: 'error',
    clienteId: cliente.id,
    title: `Cuenta de Meta sin poder publicar: ${nombre}`,
    message: mensaje.slice(0, 300),
    link: `/admin/settings/${cliente.id}`,
    metadata: { reason: MOTIVO, cuentas: bloqueadas },
  });
  await sendWhatsAppNotification({
    db,
    clienteId: cliente.id,
    notificationType: 'alert_threshold',
    message: mensaje,
    includeTeamAlertGroup: true,
  }).catch(() => undefined);

  return { revisadas: estados.length, bloqueadas: bloqueadas.length, avisado: true };
}
