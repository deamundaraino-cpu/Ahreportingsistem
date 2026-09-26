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
  /**
   * Escritura en curso, si la hay. Lo rellena el ejecutor (o la aprobación) para
   * que un handler que guarda una revisión sepa qué herramienta la provocó sin
   * tener que repetirlo en cada llamada.
   */
  operacion?: { tool: string; resumen: string };
};

/**
 * Riesgo de una operación de escritura.
 *
 * `high` es todo lo que cuesta dinero, crea entidades o borra: exige nivel
 * `admin` y aprobación de una persona distinta de quien la propuso.
 */
export type RiesgoMutacion = 'low' | 'high';

/**
 * Cómo se aplica una escritura.
 *
 *   · `requerida` (por defecto): queda como propuesta y una persona distinta la
 *     aprueba. Es lo que hacen todas las escrituras salvo que se diga otra cosa.
 *   · `directa`: se ejecuta al momento, se audita y deja una revisión para
 *     deshacerla. Solo para escrituras reversibles y de alcance interno —editar
 *     un informe que nadie de fuera ve—. Construir un informe son diez o quince
 *     pasos encadenados, y con aprobación por paso no se podía terminar ninguno:
 *     `create_report` devolvía «pendiente» sin id al que añadir widgets.
 */
export type ModoAprobacion = 'directa' | 'requerida';

export type Mutacion<I> = {
  risk: RiesgoMutacion;
  /** Por defecto `requerida`. Ver `esDirecta`: el riesgo alto nunca es directo. */
  approval?: ModoAprobacion;
  /** Resumen en lenguaje natural para que un humano apruebe con criterio. */
  summarize: (input: I) => string;
  /**
   * Comprobaciones que corren ANTES de registrar la propuesta: que el informe
   * existe, que quien propone puede verlo... Sin esto, el modelo recibía
   * «pendiente de aprobación» para una acción que iba a fallar al aprobarla, y
   * con los permisos de quien aprueba en vez de los de quien la pidió.
   */
  precheck?: (input: I, ctx: AgentContext) => Promise<void>;
};

/**
 * ¿La escritura se aplica sin aprobación?
 *
 * Una de riesgo alto nunca, aunque la marquen como directa por error: la regla
 * vive aquí y no en la disciplina de quien declara la herramienta.
 */
export function esDirecta(tool: {
  mutation?: { approval?: ModoAprobacion; risk: RiesgoMutacion };
}): boolean {
  return tool.mutation?.approval === 'directa' && tool.mutation.risk === 'low';
}

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
  /** Si está presente, la herramienta escribe (con o sin aprobación: ver `approval`). */
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
