import 'server-only';

/**
 * Catálogo de herramientas en forma serializable, para documentarlas.
 *
 * El panel «Servidor MCP & API» listaba cuatro herramientas escritas a mano, y
 * una de ellas —`get_campaign_groups`— no existía en el registro. Escribir el
 * catálogo dos veces garantiza que el segundo se quede atrás, así que esto lo
 * deriva de `ALL_TOOLS`: la misma fuente que responde `tools/list`.
 *
 * Los parámetros salen del JSON Schema que genera el zod de cada herramienta,
 * que es exactamente lo que ve un cliente MCP. Si un schema cambia, la
 * documentación cambia con él.
 *
 * Ojo con los valores por defecto: ninguna herramienta usa `.default()` de zod
 * —los defaults viven en los handlers—, así que no aparecen en el schema. Se
 * leen en los textos `describe`, que sí viajan.
 */

import { z } from 'zod';
import { ALL_TOOLS } from './registry';
import type { AnyAgentTool, DominioTool, NivelAgente, RiesgoMutacion } from './types';
import type { TokenPermission } from '@/lib/api-token-auth';

/** Un parámetro de entrada, ya legible para una persona. */
export type ParametroDoc = {
  nombre: string;
  /** Tipo en castellano: `uuid`, `texto`, `fecha (YYYY-MM-DD)`, `lista de opción`… */
  tipo: string;
  requerido: boolean;
  /** El `.describe()` del zod, que es lo que lee el modelo. */
  descripcion: string | null;
  /** Valores admitidos, si el campo es un enum (o una lista de enums). */
  valores: string[] | null;
};

/** Una herramienta, tal como se documenta en la interfaz. */
export type ToolDoc = {
  name: string;
  domain: DominioTool;
  description: string;
  /** Se exigen TODOS. */
  scopes: TokenPermission[];
  minLevel: NivelAgente;
  /** `null` si es de solo lectura; si no, el riesgo de la escritura. */
  riesgo: RiesgoMutacion | null;
  parametros: ParametroDoc[];
};

/** Nodo de JSON Schema, con lo poco que hace falta mirar. */
type Nodo = {
  type?: string;
  format?: string;
  pattern?: string;
  description?: string;
  enum?: unknown[];
  items?: Nodo;
  anyOf?: Nodo[];
};

/**
 * El tipo de un campo, en castellano.
 *
 * No pretende reproducir el JSON Schema: pretende que quien lee el panel sepa
 * qué escribir. `uuid` y `fecha (YYYY-MM-DD)` son las dos formas que más se
 * equivocan, así que se distinguen de un `texto` cualquiera.
 */
function tipoLegible(nodo: Nodo): string {
  if (Array.isArray(nodo.enum)) return 'opción';

  // Un opcional puede llegar como `anyOf: [tipo, {not:{}}]` según el schema.
  if (!nodo.type && Array.isArray(nodo.anyOf)) {
    const real = nodo.anyOf.find((n) => n && (n.type || n.enum));
    if (real) return tipoLegible(real);
  }

  switch (nodo.type) {
    case 'array':
      return nodo.items ? `lista de ${tipoLegible(nodo.items)}` : 'lista';
    case 'string':
      if (nodo.format === 'uuid') return 'uuid';
      // El patrón de fecha que comparten todos los `from`/`to`/`fecha`.
      if (typeof nodo.pattern === 'string' && nodo.pattern.includes('\\d{4}')) {
        return 'fecha (YYYY-MM-DD)';
      }
      return 'texto';
    case 'integer':
      return 'entero';
    case 'number':
      return 'número';
    case 'boolean':
      return 'sí/no';
    case 'object':
      return 'objeto';
    default:
      return nodo.type ?? 'valor';
  }
}

/** Los valores de un enum, esté suelto o dentro de una lista. */
function valoresDe(nodo: Nodo): string[] | null {
  const fuente = Array.isArray(nodo.enum)
    ? nodo.enum
    : Array.isArray(nodo.items?.enum)
      ? nodo.items.enum
      : null;
  if (!fuente || fuente.length === 0) return null;
  return fuente.map((v) => String(v));
}

function parametrosDe(tool: AnyAgentTool): ParametroDoc[] {
  const schema = z.toJSONSchema(tool.input) as {
    properties?: Record<string, Nodo>;
    required?: string[];
  };

  const props = schema.properties ?? {};
  const requeridos = new Set(schema.required ?? []);

  const lista = Object.entries(props).map(([nombre, nodo]) => ({
    nombre,
    tipo: tipoLegible(nodo),
    requerido: requeridos.has(nombre),
    descripcion: nodo.description ?? null,
    valores: valoresDe(nodo),
  }));

  // Los obligatorios primero: son los que hay que rellenar sí o sí. Dentro de
  // cada grupo se respeta el orden de declaración del zod.
  return [...lista.filter((p) => p.requerido), ...lista.filter((p) => !p.requerido)];
}

/**
 * Todas las herramientas del registro, documentadas.
 *
 * Es el catálogo COMPLETO, no el que puede usar quien consulta: el panel
 * explica qué scope y qué nivel exige cada una, y eso solo se entiende viéndolas
 * todas. `tools/list` sigue devolviendo únicamente las del token.
 */
export function catalogoPublico(): ToolDoc[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    domain: tool.domain,
    description: tool.description,
    scopes: tool.scopes,
    minLevel: tool.minLevel ?? 'consulta',
    riesgo: tool.mutation?.risk ?? null,
    parametros: parametrosDe(tool),
  }));
}
