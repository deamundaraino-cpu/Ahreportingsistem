import 'server-only';

/**
 * Tipos del registro de herramientas del agente.
 *
 * Una herramienta se define UNA vez y la consumen tres sitios: el servidor MCP
 * (que expone su schema como JSON Schema), el motor conversacional (que lo pasa
 * a OpenRouter como `function`) y la consola de administración. Antes de esto,
 * añadir una herramienta al MCP obligaba a tocar dos lugares —un array literal
 * de schemas escritos a mano y un `switch`— y nada garantizaba que siguieran de
 * acuerdo.
 */

import type { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TokenPermission } from '@/lib/api-token-auth';

/** Roles de la aplicación, tal como los guarda `user_profiles.role`. */
export type RolApp = 'superadmin' | 'admin' | 'trafficker' | 'viewer';

/**
 * Nivel de un contacto del agente. Es independiente del rol: sirve para
 * restringir por canal (un grupo de WhatsApp de solo lectura) sin tocar los
 * permisos que esa persona tiene en la aplicación.
 */
export type NivelAgente = 'consulta' | 'operador' | 'aprobador' | 'admin';

/** Orden de menor a mayor capacidad. El índice es lo que permite comparar. */
export const NIVELES: NivelAgente[] = ['consulta', 'operador', 'aprobador', 'admin'];

/** Techo que impone el rol de la aplicación. El nivel nunca puede superarlo. */
export const TECHO_POR_ROL: Record<RolApp, NivelAgente> = {
  superadmin: 'admin',
  admin: 'admin',
  trafficker: 'operador',
  viewer: 'consulta',
};

/**
 * Nivel efectivo: el mínimo de todos los factores.
 *
 * Un contacto marcado como `admin` cuyo usuario es `viewer` en la aplicación
 * opera como `consulta`. Cada factor puede restringir; ninguno puede ampliar.
 * Sin esta regla, dar de alta un número de WhatsApp sería una puerta trasera al
 * panel de administración.
 */
export function nivelEfectivo(...factores: (NivelAgente | undefined | null)[]): NivelAgente {
  let indice = NIVELES.length - 1;
  for (const f of factores) {
    if (!f) continue;
    const i = NIVELES.indexOf(f);
    if (i >= 0 && i < indice) indice = i;
  }
  return NIVELES[indice];
}

/** ¿`nivel` alcanza al menos a `minimo`? */
export function nivelAlcanza(nivel: NivelAgente, minimo: NivelAgente): boolean {
  return NIVELES.indexOf(nivel) >= NIVELES.indexOf(minimo);
}

/** Dominios en los que se agrupan las herramientas. */
export type DominioTool =
  | 'contexto'
  | 'clientes'
  | 'metricas'
  | 'analisis'
  | 'informes'
  | 'operaciones'
  | 'administracion'
  | 'campanas';

/** De dónde viene la llamada. Solo para auditoría y límites. */
export type OrigenLlamada = 'mcp' | 'whatsapp' | 'web' | 'cron';

/**
 * Contexto de ejecución de una herramienta.
 *
 * `allowedClientIds` unifica los dos modelos de autorización que convivían: el
 * MCP filtraba por `clientes.user_id` y la aplicación por `user_profiles` +
 * `user_client_assignments`.
 */
export type AgentContext = {
  userId: string;
  role: RolApp;
  level: NivelAgente;
  /** `'all'` para administradores; lista explícita para el resto. */
  allowedClientIds: string[] | 'all';
  permissions: TokenPermission[];
  db: SupabaseClient;
  origin: OrigenLlamada;
  conversationId: string | null;
  tokenId: string | null;
};

/**
 * Riesgo de una operación de escritura.
 *
 * `high` es todo lo que cuesta dinero, crea entidades o borra: exige nivel
 * `admin` y aprobación de una persona distinta de quien la propuso.
 */
export type RiesgoMutacion = 'low' | 'high';

export type Mutacion<I> = {
  risk: RiesgoMutacion;
  /** Resumen en lenguaje natural para que un humano apruebe con criterio. */
  summarize: (input: I) => string;
};

/** Una herramienta del agente. */
export type AgentTool<I = unknown> = {
  name: string;
  domain: DominioTool;
  /** Se la lee el modelo: debe decir cuándo usarla, no solo qué hace. */
  description: string;
  input: z.ZodType<I>;
  /** Scopes de token necesarios. Se exigen TODOS. */
  scopes: TokenPermission[];
  /** Nivel mínimo del contacto. Por defecto `consulta` (solo lectura). */
  minLevel?: NivelAgente;
  /** Si está presente, la herramienta escribe y pasa por aprobación. */
  mutation?: Mutacion<I>;
  handler: (input: I, ctx: AgentContext) => Promise<unknown>;
};

/** Herramienta con su tipo de entrada ya borrado, para guardarla en el registro. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

/**
 * Resultado uniforme de una herramienta.
 *
 * `warnings` es parte del contrato a propósito: el motor BI devolvía `[]` ante
 * un error de base de datos, así que un timeout se leía como "no hubo
 * inversión". Un aviso explícito distingue "no hay datos" de "no pude mirar".
 */
export type ResultadoTool<T = unknown> = {
  data: T;
  warnings?: string[];
};
