import 'server-only';

/**
 * Alta y gestión de clientes.
 *
 * Hay DOS entidades "cliente" en la base y confundirlas deja clientes a medias:
 *
 *   · `public.clientes` — el cliente de publicidad que ve el dashboard.
 *   · `report_utm.clientes` — el del módulo de atribución, enlazado al anterior
 *     por `public_cliente_id`.
 *
 * Por eso `create_client` acepta `scope: 'ambos'`, que crea los dos Y LOS
 * ENLAZA. Es lo que casi siempre se quiere y lo que a mano se olvida.
 *
 * Lo que NO hay aquí, a propósito: crear usuarios y cambiar roles. Un agente
 * que pueda concederse permisos puede escalar privilegios, así que ese camino
 * se queda en el panel.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import type { AnyAgentTool } from '../types';
import { exigirCliente, idsVisibles } from '../registry';

/** Mismo criterio que `report-utm/clientes/_actions.ts`. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const createClient: AnyAgentTool = {
  name: 'create_client',
  domain: 'administracion',
  description:
    'Da de alta un cliente. Con `scope: "ambos"` (lo habitual) lo crea tanto en el dashboard de ' +
    'publicidad como en el módulo de atribución y los enlaza entre sí. ' +
    'NO conecta credenciales: Meta, Google y Hotmart se conectan por OAuth desde el panel, y la ' +
    'herramienta devuelve el enlace para hacerlo. ' +
    'Es una acción de riesgo alto: requiere aprobación de un administrador.',
  input: z.object({
    nombre: z.string().min(2).describe('Nombre del cliente.'),
    scope: z
      .enum(['ads', 'utm', 'ambos'])
      .optional()
      .describe('Dónde crearlo. Por defecto "ambos", que es lo normal.'),
    descripcion: z.string().optional(),
    color: z.string().optional().describe('Color de la ficha en el módulo de atribución.'),
  }),
  scopes: ['write:clients'],
  minLevel: 'admin',
  mutation: {
    risk: 'high',
    summarize: (i: { nombre: string; scope?: string }) =>
      `Crear el cliente "${i.nombre}" en ${i.scope ?? 'ambos'} sistema(s)`,
  },
  handler: async (
    input: {
      nombre: string;
      scope?: 'ads' | 'utm' | 'ambos';
      descripcion?: string;
      color?: string;
    },
    ctx
  ) => {
    const scope = input.scope ?? 'ambos';
    const nombre = input.nombre.trim();
    const resultado: Record<string, unknown> = { scope };

    let publicId: string | null = null;

    if (scope === 'ads' || scope === 'ambos') {
      const { data, error } = await ctx.db
        .from('clientes')
        .insert({ nombre, config_api: {} })
        .select('id, nombre')
        .single();

      if (error) {
        throw new ApiError('DATABASE_ERROR', `No se pudo crear el cliente: ${error.message}`, 500);
      }
      publicId = (data as { id: string }).id;
      resultado.ads = data;
    }

    if (scope === 'utm' || scope === 'ambos') {
      const slug = slugify(nombre);
      if (!slug) {
        throw new ApiError('VALIDATION_ERROR', 'El nombre no produce un slug válido.', 400);
      }

      const { data, error } = await ctx.db
        .schema('report_utm')
        .from('clientes')
        .insert({
          nombre,
          slug,
          descripcion: input.descripcion ?? null,
          color: input.color ?? 'emerald',
          // El enlace entre los dos sistemas: sin él, el módulo de atribución
          // no encuentra el gasto del cliente y todo sale a cero.
          public_cliente_id: publicId,
        })
        .select('id, nombre, slug, public_cliente_id')
        .single();

      if (error) {
        throw new ApiError(
          'DATABASE_ERROR',
          `El cliente se creó en el dashboard pero falló en el módulo de atribución: ${error.message}`,
          500
        );
      }
      resultado.utm = data;
    }

    const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
    return {
      ...resultado,
      enlazados: scope === 'ambos',
      siguiente_paso: publicId
        ? `Conecta las credenciales en ${base}/admin/settings/${publicId}`
        : 'Conecta las credenciales desde el panel de administración.',
    };
  },
};

const updateClient: AnyAgentTool = {
  name: 'update_client',
  domain: 'administracion',
  description:
    'Renombra un cliente o cambia su descripción, color o estado en el módulo de atribución. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: z.string().uuid(),
    nombre: z.string().min(2).optional(),
    descripcion: z.string().optional(),
    color: z.string().optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
  }),
  scopes: ['write:clients'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { client_id: string; nombre?: string; status?: string }) =>
      `Actualizar el cliente ${i.client_id}` +
      (i.nombre ? ` (nombre → "${i.nombre}")` : '') +
      (i.status ? ` (estado → ${i.status})` : ''),
  },
  handler: async (
    input: {
      client_id: string;
      nombre?: string;
      descripcion?: string;
      color?: string;
      status?: string;
    },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);
    const resultado: Record<string, unknown> = {};

    if (input.nombre) {
      const { data, error } = await ctx.db
        .from('clientes')
        .update({ nombre: input.nombre })
        .eq('id', input.client_id)
        .select('id, nombre')
        .single();
      if (error) {
        throw new ApiError('DATABASE_ERROR', `No se pudo renombrar: ${error.message}`, 500);
      }
      resultado.ads = data;
    }

    const parcheUtm: Record<string, unknown> = {};
    if (input.nombre) parcheUtm.nombre = input.nombre;
    if (input.descripcion !== undefined) parcheUtm.descripcion = input.descripcion;
    if (input.color) parcheUtm.color = input.color;
    if (input.status) parcheUtm.status = input.status;

    if (Object.keys(parcheUtm).length > 0) {
      const { data } = await ctx.db
        .schema('report_utm')
        .from('clientes')
        .update(parcheUtm)
        .eq('public_cliente_id', input.client_id)
        .select('id, nombre, status');
      // Que no exista en el módulo de atribución no es un error: hay clientes
      // que solo viven en el dashboard.
      resultado.utm = data ?? null;
    }

    return resultado;
  },
};

const listUsers: AnyAgentTool = {
  name: 'list_users',
  domain: 'administracion',
  description:
    'Usuarios de la plataforma con su rol y los clientes que tienen asignados. Solo lectura: ' +
    'crear usuarios y cambiar roles se hace desde el panel, nunca desde aquí.',
  input: z.object({}),
  scopes: ['write:clients'],
  minLevel: 'aprobador',
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.db
      .from('user_profiles')
      .select('id, role, full_name')
      .order('role');

    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer los usuarios: ${error.message}`,
        500
      );
    }

    const { data: asignaciones } = await ctx.db
      .from('user_client_assignments')
      .select('user_id, client_id');

    const porUsuario = new Map<string, string[]>();
    for (const a of asignaciones ?? []) {
      const r = a as { user_id: string; client_id: string };
      porUsuario.set(r.user_id, [...(porUsuario.get(r.user_id) ?? []), r.client_id]);
    }

    return {
      users: (data ?? []).map((u) => {
        const r = u as { id: string; role: string; full_name: string | null };
        return {
          id: r.id,
          nombre: r.full_name,
          rol: r.role,
          clientes_asignados: porUsuario.get(r.id)?.length ?? 0,
        };
      }),
    };
  },
};

const assignClientToUser: AnyAgentTool = {
  name: 'assign_client_to_user',
  domain: 'administracion',
  description:
    'Da a un usuario acceso a un cliente. Cambia lo que esa persona puede ver, así que es una ' +
    'acción de riesgo alto y requiere aprobación de un administrador.',
  input: z.object({
    user_id: z.string().uuid(),
    client_id: z.string().uuid(),
  }),
  scopes: ['write:clients'],
  minLevel: 'admin',
  mutation: {
    risk: 'high',
    summarize: (i: { user_id: string; client_id: string }) =>
      `Dar al usuario ${i.user_id} acceso al cliente ${i.client_id}`,
  },
  handler: async (input: { user_id: string; client_id: string }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('user_client_assignments')
      .insert({
        user_id: input.user_id,
        client_id: input.client_id,
        assigned_by: ctx.userId,
      })
      .select()
      .single();

    if (error) {
      // 23505 = ya existía. No es un fallo que merezca alarmar a nadie.
      if (error.code === '23505') {
        return { ya_existia: true };
      }
      throw new ApiError('DATABASE_ERROR', `No se pudo asignar: ${error.message}`, 500);
    }
    return { asignacion: data };
  },
};

const listAgentContacts: AnyAgentTool = {
  name: 'list_agent_contacts',
  domain: 'administracion',
  description:
    'Contactos autorizados a hablar con el agente, con su nivel y su alcance de clientes.',
  input: z.object({}),
  scopes: ['write:clients'],
  minLevel: 'aprobador',
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.db
      .from('agent_contacts')
      .select('id, user_id, display_name, level, client_scope, is_active')
      .order('display_name');

    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer los contactos: ${error.message}`,
        500
      );
    }

    const visibles = idsVisibles(ctx);
    return {
      contactos: data ?? [],
      // Se dice el alcance del propio contexto para que el modelo no dé por
      // hecho que ve toda la cuenta.
      alcance_de_esta_consulta:
        visibles === null ? 'todos los clientes' : `${visibles.length} clientes`,
    };
  },
};

export const toolsAdministracion: AnyAgentTool[] = [
  createClient,
  updateClient,
  listUsers,
  assignClientToUser,
  listAgentContacts,
];
