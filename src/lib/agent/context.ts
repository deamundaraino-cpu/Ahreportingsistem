import 'server-only';

/**
 * Construcción del contexto de ejecución de las herramientas.
 *
 * Aquí se reconcilian los dos modelos de autorización que convivían:
 *
 *   · El servidor MCP filtraba por `clientes.user_id`.
 *   · La aplicación usa `user_profiles.role` + `user_client_assignments`.
 *
 * Un trafficker con asignaciones explícitas veía N clientes en la interfaz y su
 * token podía devolverle otros distintos, o ninguno.
 *
 * La unión es ADITIVA a propósito: quien ya veía un cliente por `user_id` lo
 * sigue viendo. Hacerla restrictiva habría dejado sin datos, de golpe y sin
 * aviso, a los conectores que ya están en uso.
 */

import { createAdminClient } from '@/utils/supabase/server';
import type { TokenContext } from '@/lib/api-token-auth';
import {
  TECHO_POR_ROL,
  nivelEfectivo,
  type AgentContext,
  type NivelAgente,
  type OrigenLlamada,
  type RolApp,
} from './types';

const ROLES: RolApp[] = ['superadmin', 'admin', 'trafficker', 'viewer'];

function normalizarRol(valor: unknown): RolApp {
  return ROLES.includes(valor as RolApp) ? (valor as RolApp) : 'viewer';
}

/**
 * Clientes que puede ver un usuario.
 *
 * `'all'` solo para administradores. Para el resto, la unión de sus
 * asignaciones explícitas y los clientes que le pertenecen por `user_id`.
 */
export async function resolverClientesVisibles(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
  rol: RolApp
): Promise<string[] | 'all'> {
  if (rol === 'superadmin' || rol === 'admin') return 'all';

  const [asignados, propios] = await Promise.all([
    db.from('user_client_assignments').select('client_id').eq('user_id', userId),
    db.from('clientes').select('id').eq('user_id', userId),
  ]);

  const ids = new Set<string>();
  for (const a of asignados.data ?? []) {
    const v = (a as { client_id?: string }).client_id;
    if (v) ids.add(v);
  }
  for (const c of propios.data ?? []) {
    const v = (c as { id?: string }).id;
    if (v) ids.add(v);
  }

  return [...ids];
}

/** Lee el rol de la aplicación. Ante la duda, el rol menos capaz. */
export async function resolverRol(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string
): Promise<RolApp> {
  const { data } = await db.from('user_profiles').select('role').eq('id', userId).maybeSingle();
  return normalizarRol((data as { role?: string } | null)?.role);
}

export type OpcionesContexto = {
  origin: OrigenLlamada;
  conversationId?: string | null;
  /** Nivel del contacto, si la llamada viene de un canal de mensajería. */
  contactLevel?: NivelAgente;
  /** Techo del canal desde el que se habla (un grupo de solo lectura, p. ej.). */
  channelLevel?: NivelAgente;
  /** Acota los clientes por debajo de lo que permita el rol. Nunca los amplía. */
  clientScope?: string[] | null;
};

/**
 * Contexto para una llamada autenticada con un token de API (MCP y /api/v1).
 */
export async function contextoDesdeToken(
  token: TokenContext,
  opts: OpcionesContexto
): Promise<AgentContext> {
  const db = await createAdminClient();
  const role = await resolverRol(db, token.userId);
  let allowedClientIds = await resolverClientesVisibles(db, token.userId, role);

  // El alcance del contacto solo puede recortar.
  if (opts.clientScope && opts.clientScope.length > 0) {
    allowedClientIds =
      allowedClientIds === 'all'
        ? [...opts.clientScope]
        : allowedClientIds.filter((id) => opts.clientScope!.includes(id));
  }

  return {
    userId: token.userId,
    role,
    level: nivelEfectivo(TECHO_POR_ROL[role], opts.contactLevel, opts.channelLevel),
    allowedClientIds,
    permissions: token.permissions,
    db,
    origin: opts.origin,
    conversationId: opts.conversationId ?? null,
    tokenId: token.tokenId,
  };
}

/**
 * Contexto para una llamada con sesión de navegador (consola de administración).
 * No hay token, así que se conceden todos los scopes: quien manda es el rol.
 */
export async function contextoDesdeSesion(
  userId: string,
  opts: OpcionesContexto
): Promise<AgentContext> {
  const db = await createAdminClient();
  const role = await resolverRol(db, userId);
  const { ALL_PERMISSIONS } = await import('@/lib/api-token-auth');
  let allowedClientIds = await resolverClientesVisibles(db, userId, role);

  if (opts.clientScope && opts.clientScope.length > 0) {
    allowedClientIds =
      allowedClientIds === 'all'
        ? [...opts.clientScope]
        : allowedClientIds.filter((id) => opts.clientScope!.includes(id));
  }

  return {
    userId,
    role,
    level: nivelEfectivo(TECHO_POR_ROL[role], opts.contactLevel, opts.channelLevel),
    allowedClientIds,
    permissions: [...ALL_PERMISSIONS],
    db,
    origin: opts.origin,
    conversationId: opts.conversationId ?? null,
    tokenId: null,
  };
}
