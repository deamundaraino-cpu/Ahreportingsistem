import 'server-only';

/**
 * Herramientas de lectura de clientes y pestañas.
 *
 * Dos correcciones respecto a lo que exponía el servidor MCP:
 *
 *   · `get_tabs` devolvía `keyword_meta` en crudo y su descripción le decía al
 *     modelo que lo usara como palabra clave. Cuando la pestaña lleva un filtro
 *     compuesto (prefijo `__cf:` con JSON), pasarlo como texto no casa ninguna
 *     campaña y el gasto sale 0 sin ningún error. Ahora se devuelve una
 *     etiqueta legible y el identificador de la pestaña, que es lo que hay que
 *     pasar a las herramientas de métricas.
 *
 *   · Se filtra por los clientes que el contexto puede ver, no por
 *     `clientes.user_id`, que era un modelo de autorización distinto del que
 *     usa la aplicación.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import { tabFilterLabel } from '@/lib/campaign-filter';
import type { AnyAgentTool } from '../types';
import { exigirCliente, idsVisibles } from '../registry';

const clienteIdSchema = z
  .string()
  .uuid()
  .describe('UUID del cliente. Se obtiene con list_clients o resolve_client.');

type FilaCliente = { id: string; nombre: string; created_at?: string };

const listClients: AnyAgentTool = {
  name: 'list_clients',
  domain: 'clientes',
  description:
    'Lista los clientes de publicidad a los que se tiene acceso. Devuelve su id y su nombre. ' +
    'Es el punto de partida: casi todas las demás herramientas necesitan un client_id.',
  input: z.object({}),
  scopes: ['read:clients'],
  handler: async (_input, ctx) => {
    let q = ctx.db.from('clientes').select('id, nombre, created_at').order('nombre');
    const ids = idsVisibles(ctx);
    if (ids) {
      if (ids.length === 0) return { clients: [] };
      q = q.in('id', ids);
    }

    const { data, error } = await q;
    // Se propaga en lugar de devolver una lista vacía: "no tienes clientes" y
    // "no pude consultarlos" no son lo mismo.
    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer los clientes: ${error.message}`,
        500
      );
    }

    return {
      clients: (data ?? []).map((c: FilaCliente) => ({ id: c.id, name: c.nombre })),
    };
  },
};

const resolveClient: AnyAgentTool = {
  name: 'resolve_client',
  domain: 'clientes',
  description:
    'Busca un cliente por nombre aproximado y devuelve su id. Úsala cuando el usuario mencione ' +
    'un cliente por su nombre ("cómo va Goodprop") en lugar de por su identificador. ' +
    'Si hay varias coincidencias las devuelve todas para poder preguntar cuál.',
  input: z.object({
    nombre: z.string().min(1).describe('Nombre o parte del nombre del cliente.'),
  }),
  scopes: ['read:clients'],
  handler: async (input: { nombre: string }, ctx) => {
    let q = ctx.db
      .from('clientes')
      .select('id, nombre')
      .ilike('nombre', `%${input.nombre.trim()}%`);
    const ids = idsVisibles(ctx);
    if (ids) {
      if (ids.length === 0) return { matches: [], exact: null };
      q = q.in('id', ids);
    }

    const { data, error } = await q;
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo buscar el cliente: ${error.message}`, 500);
    }

    const matches = (data ?? []).map((c: FilaCliente) => ({ id: c.id, name: c.nombre }));
    const buscado = input.nombre.trim().toLowerCase();
    const exact = matches.find((m) => m.name.trim().toLowerCase() === buscado) ?? null;

    return {
      matches,
      exact,
      // Se dice explícitamente para que el modelo pregunte en vez de elegir por
      // su cuenta y acabar informando del cliente equivocado.
      ambiguo: matches.length > 1 && !exact,
    };
  },
};

type FilaTab = {
  id: string;
  nombre: string;
  keyword_meta: string | null;
  orden: number | null;
  fecha_inicio: string | null;
  fecha_finalizacion: string | null;
  presupuesto_objetivo: number | null;
  archived?: boolean | null;
};

const getTabs: AnyAgentTool = {
  name: 'get_tabs',
  domain: 'clientes',
  description:
    'Pestañas (estrategias) de un cliente. Cada pestaña agrupa un conjunto de campañas: un ' +
    'evergreen de captación, un lanzamiento, un producto. Para pedir métricas de una estrategia ' +
    'concreta, pasa su `id` como `tab_id` a get_metrics o get_summary — NO intentes reconstruir ' +
    'el filtro a partir del texto.',
  input: z.object({
    client_id: clienteIdSchema,
    incluir_archivadas: z
      .boolean()
      .optional()
      .describe('Por defecto false: las pestañas archivadas se omiten.'),
  }),
  scopes: ['read:clients'],
  handler: async (input: { client_id: string; incluir_archivadas?: boolean }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const { data: cliente, error: errCliente } = await ctx.db
      .from('clientes')
      .select('id, nombre')
      .eq('id', input.client_id)
      .maybeSingle();

    if (errCliente) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudo leer el cliente: ${errCliente.message}`,
        500
      );
    }
    if (!cliente) {
      throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${input.client_id}.`, 404);
    }

    const { data, error } = await ctx.db
      .from('cliente_tabs')
      .select(
        'id, nombre, keyword_meta, orden, fecha_inicio, fecha_finalizacion, presupuesto_objetivo, archived'
      )
      .eq('cliente_id', input.client_id)
      .order('orden');

    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer las pestañas: ${error.message}`,
        500
      );
    }

    const filas = (data ?? []) as FilaTab[];
    const visibles = input.incluir_archivadas ? filas : filas.filter((t) => !t.archived);

    return {
      client: { id: cliente.id, name: cliente.nombre },
      tabs: visibles.map((t) => ({
        id: t.id,
        name: t.nombre,
        // Legible, nunca el `__cf:` crudo: pasárselo al modelo como si fuera una
        // palabra clave es justo lo que producía cifras en cero.
        filtro: tabFilterLabel(t.keyword_meta),
        orden: t.orden,
        fecha_inicio: t.fecha_inicio,
        fecha_finalizacion: t.fecha_finalizacion,
        presupuesto_objetivo: t.presupuesto_objetivo,
        archivada: Boolean(t.archived),
      })),
    };
  },
};

const getClient: AnyAgentTool = {
  name: 'get_client',
  domain: 'clientes',
  description:
    'Ficha de un cliente: nombre, fecha de alta, número de pestañas activas y qué integraciones ' +
    'tiene conectadas (Meta, TikTok, Hotmart, Google Analytics). Útil para saber hasta dónde ' +
    'llega la medición de ese cliente antes de sacar conclusiones.',
  input: z.object({ client_id: clienteIdSchema }),
  scopes: ['read:clients'],
  handler: async (input: { client_id: string }, ctx) => {
    exigirCliente(ctx, input.client_id);

    // Proyección explícita: `config_api` guarda credenciales en claro y no debe
    // salir de aquí. Los flags se derivan y se devuelven como booleanos.
    const { data: cliente, error } = await ctx.db
      .from('clientes')
      .select('id, nombre, created_at, config_api')
      .eq('id', input.client_id)
      .maybeSingle();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el cliente: ${error.message}`, 500);
    }
    if (!cliente) {
      throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${input.client_id}.`, 404);
    }

    const { flagsConexion } = await import('@/lib/cliente-seguro');
    const conexiones = flagsConexion(cliente.config_api);

    const { count } = await ctx.db
      .from('cliente_tabs')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', input.client_id);

    const ausentes = Object.entries(conexiones)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    return {
      id: cliente.id,
      name: cliente.nombre,
      created_at: cliente.created_at,
      pestanas: count ?? 0,
      integraciones: conexiones,
      // Se dice de forma explícita para que no se reporte como carencia lo que
      // simplemente no forma parte de la medición de ese cliente.
      fuentes_no_conectadas: ausentes,
    };
  },
};

export const toolsClientes: AnyAgentTool[] = [listClients, resolveClient, getTabs, getClient];
