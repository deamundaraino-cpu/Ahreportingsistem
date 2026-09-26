import 'server-only';

/**
 * Informes BI: todas las herramientas.
 *
 *   · lectura.ts  — listar, leer, catálogo de campos, vista previa, historial.
 *   · edicion.ts  — crear y editar (escrituras directas, con revisión).
 *   · ciclo.ts    — duplicar, plantilla, publicar, borrar, cambiar de cliente,
 *                   restaurar. Publicar, borrar y cambiar de cliente piden
 *                   aprobación.
 *
 * La guía de uso para el modelo (flujo, gramática de tokens, recetas) vive en
 * `src/lib/agent/guias/informes.ts`, que alimenta el prompt del agente, las
 * instrucciones del servidor MCP y las skills generadas.
 */

import type { AnyAgentTool } from '../../types';
import { toolsLecturaInformes } from './lectura';
import { toolsEdicionInformes } from './edicion';
import { toolsCicloInformes } from './ciclo';

export const toolsInformes: AnyAgentTool[] = [
  ...toolsLecturaInformes,
  ...toolsEdicionInformes,
  ...toolsCicloInformes,
];
