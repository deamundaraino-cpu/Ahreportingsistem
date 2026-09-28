// ════════════════════════════════════════════════════════════════
// Cliente de la GA4 Data API, compartido por el worker diario (`fetchGA4`),
// el desglose por campaña (`ga4-desglose.ts`) y la prueba de conexión.
// ════════════════════════════════════════════════════════════════
//
// Antes cada sitio construía su propio `BetaAnalyticsDataClient` con su copia
// de la precedencia de credenciales, y cada uno traducía (o no) los errores.
// El resultado en producción: la única propiedad configurada llevaba meses
// fallando en cada sincronización y el error solo llegaba a un `log()`.
//
// Precedencia (la misma que había):
//  1) OAuth de agencia (preferido) — solo hace falta `ga_property_id`.
//  2) Service account legacy por cliente (`ga_client_email` + `ga_private_key`).

import type { BetaAnalyticsDataClient } from '@google-analytics/data';
import {
  getAgencyAccessToken,
  getGoogleIntegration,
  hasAgencyGoogleConnection,
} from './google-auth';

export type ViaGa4 = 'oauth_agencia' | 'service_account';

export interface ClienteGa4 {
  client: BetaAnalyticsDataClient;
  /** `properties/<id>` */
  propertyName: string;
  /** ID numérico, sin prefijo. */
  propertyId: string;
  via: ViaGa4;
}

type ConfigGa4 = {
  ga_property_id?: string | null;
  ga_client_email?: string | null;
  ga_private_key?: string | null;
  ga_project_id?: string | null;
};

/** `'511475756'` o `'properties/511475756'` → ambas formas normalizadas. */
export function normalizarPropiedadGa4(raw: unknown): { id: string; name: string } | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const id = s.replace(/^properties\//, '').trim();
  if (!id) return null;
  return { id, name: `properties/${id}` };
}

/** La clave del JSON de la service account trae los saltos de línea escapados. */
export function limpiarClavePrivada(key: string): string {
  return key.replace(/\\n/g, '\n');
}

/**
 * Construye el cliente de la Data API para una configuración de cliente.
 * `null` = GA4 no configurado (sin propiedad, o sin ninguna credencial).
 *
 * `conexionAgencia` permite a un bucle que procesa muchas fechas consultar la
 * conexión una sola vez en lugar de ir a la base por cada día.
 */
export async function crearClienteGa4(
  config: ConfigGa4 | null | undefined,
  conexionAgencia?: boolean
): Promise<ClienteGa4 | null> {
  const prop = normalizarPropiedadGa4(config?.ga_property_id);
  if (!prop) return null;
  const useAgencyOAuth = conexionAgencia ?? (await hasAgencyGoogleConnection());
  const hasServiceAccount = !!(config?.ga_client_email && config?.ga_private_key);
  if (!useAgencyOAuth && !hasServiceAccount) return null;

  const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  const client = useAgencyOAuth
    ? // `getAgencyAccessToken` devuelve un OAuth2Client de la misma versión de
      // google-auth-library que usa google-gax; el cast es solo de tipos.
      new BetaAnalyticsDataClient({ authClient: (await getAgencyAccessToken()) as never })
    : new BetaAnalyticsDataClient({
        credentials: {
          client_email: config!.ga_client_email!,
          private_key: limpiarClavePrivada(config!.ga_private_key!),
          ...(config?.ga_project_id ? { project_id: config.ga_project_id } : {}),
        },
      });

  return {
    client,
    propertyName: prop.name,
    propertyId: prop.id,
    via: useAgencyOAuth ? 'oauth_agencia' : 'service_account',
  };
}

export type CodigoErrorGa4 =
  'sin_permiso' | 'no_encontrada' | 'credenciales' | 'cuota' | 'no_disponible' | 'otro';

/** Código gRPC o texto → categoría estable. Pura: la usa la salud de fuentes. */
export function clasificarErrorGa4(err: unknown): CodigoErrorGa4 {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'number' ? e.code : null;
  const msg = String(e?.message ?? err ?? '');
  if (code === 7 || /PERMISSION_DENIED|\b403\b/.test(msg)) return 'sin_permiso';
  if (code === 5 || /NOT_FOUND|\b404\b/.test(msg)) return 'no_encontrada';
  if (code === 16 || /UNAUTHENTICATED|invalid_grant|\b401\b/.test(msg)) return 'credenciales';
  if (code === 8 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return 'cuota';
  if (code === 14 || /UNAVAILABLE/.test(msg)) return 'no_disponible';
  return 'otro';
}

/**
 * Mensaje accionable para la persona que administra el cliente.
 * `email` es la cuenta de Google de la agencia (si la conexión es OAuth).
 */
export function mensajeErrorGa4(
  codigo: CodigoErrorGa4,
  ctx: { via: ViaGa4 | null; propertyId?: string | null; email?: string | null; detalle?: string }
): string {
  const prop = ctx.propertyId ? ` ${ctx.propertyId}` : '';
  const quien =
    ctx.via === 'service_account'
      ? 'el email de la service account'
      : ctx.email
        ? `la cuenta de la agencia (${ctx.email})`
        : 'la cuenta de Google de la agencia';
  switch (codigo) {
    case 'sin_permiso':
      return `Sin permisos: ${quien} no tiene acceso a la propiedad${prop}. Dale rol «Lector» en GA4 → Administrar → Gestión de acceso a la propiedad.`;
    case 'no_encontrada':
      return `La propiedad${prop} no existe. Revisa el ID numérico en GA4 → Administrar → Detalles de la propiedad, o elígela desde el selector.`;
    case 'credenciales':
      return ctx.via === 'service_account'
        ? 'Credenciales inválidas: vuelve a subir el JSON de la service account.'
        : 'La conexión de Google de la agencia caducó o fue revocada: reconéctala en Ajustes → Conexión Google.';
    case 'cuota':
      return 'GA4 rechazó la consulta por cuota agotada; se reintentará en la próxima sincronización.';
    case 'no_disponible':
      return 'GA4 no respondió (servicio no disponible); se reintentará en la próxima sincronización.';
    default:
      return `Error de GA4: ${ctx.detalle || 'desconocido'}`;
  }
}

export type PruebaAccesoGa4 =
  | { ok: true; via: ViaGa4; sesionesAyer: number; mensaje: string }
  | {
      ok: false;
      codigo: CodigoErrorGa4 | 'sin_configurar';
      mensaje: string;
      /** ¿La propiedad aparece entre las que ve la cuenta de la agencia? null = no se pudo saber. */
      visibleParaAgencia: boolean | null;
    };

/**
 * Prueba real contra la Data API (1 día de sesiones). Si falla por permisos o
 * por propiedad inexistente, contrasta con la lista de propiedades que ve la
 * cuenta de la agencia para decir exactamente qué pasa.
 */
export async function probarAccesoGa4(
  config: ConfigGa4 | null | undefined
): Promise<PruebaAccesoGa4> {
  const cliente = await crearClienteGa4(config);
  if (!cliente) {
    return {
      ok: false,
      codigo: 'sin_configurar',
      mensaje: normalizarPropiedadGa4(config?.ga_property_id)
        ? 'No hay conexión de Google de la agencia ni credenciales de service account. Conéctala en Ajustes → Conexión Google.'
        : 'Falta el Property ID de Google Analytics 4.',
      visibleParaAgencia: null,
    };
  }

  const email =
    cliente.via === 'oauth_agencia'
      ? ((await getGoogleIntegration())?.connected_email ?? null)
      : null;

  try {
    const [resp] = await cliente.client.runReport({
      property: cliente.propertyName,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
    });
    const sesiones = Number(resp.rows?.[0]?.metricValues?.[0]?.value ?? 0) || 0;
    const via =
      cliente.via === 'oauth_agencia'
        ? `OAuth de agencia${email ? ` (${email})` : ''}`
        : 'Service Account';
    return {
      ok: true,
      via: cliente.via,
      sesionesAyer: sesiones,
      mensaje: `Conexión exitosa vía ${via}. Sesiones ayer: ${sesiones}`,
    };
  } catch (err) {
    const codigo = clasificarErrorGa4(err);
    let visible: boolean | null = null;
    if (
      cliente.via === 'oauth_agencia' &&
      (codigo === 'sin_permiso' || codigo === 'no_encontrada')
    ) {
      try {
        const { listGA4Properties } = await import('./google-analytics');
        const props = await listGA4Properties();
        visible = props.some((p) => p.id === cliente.propertyId);
      } catch {
        visible = null;
      }
    }
    let mensaje = mensajeErrorGa4(codigo, {
      via: cliente.via,
      propertyId: cliente.propertyId,
      email,
      detalle: String((err as Error)?.message ?? err),
    });
    if (visible === false) {
      mensaje += ' (La propiedad no aparece entre las que ve la cuenta de la agencia.)';
    }
    return { ok: false, codigo, mensaje, visibleParaAgencia: visible };
  }
}
