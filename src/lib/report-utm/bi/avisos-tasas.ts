// Días sin tasa de cambio durante UNA consulta del BI.
//
// El motor carga conversores en varios sitios (Hotmart directo, pivot, columnas
// de Hotmart de `metricas_diarias`) y cada uno sabe qué días convirtió sin su
// tasa propia (`aproximadas`) o sin ninguna (`sinTasa`). Pasar esa información
// hacia arriba por cada función del motor tocaría decenas de firmas; en su lugar,
// cada conversor se registra en el contexto de la petición (AsyncLocalStorage,
// igual que `conDeadline` en `rate-limit.ts`) y el despacho lo recoge al final.
//
// Fuera de `conAvisosDeTasas` registrar no hace nada: los llamantes que no piden
// avisos (MCP, agente, pestañas) no pagan nada.

import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  avisoDeTasas,
  unirAvisosTasas,
  type AvisoTasas,
  type ConversorMoneda,
} from '@/lib/moneda-reporte';

const conversoresDeLaPeticion = new AsyncLocalStorage<ConversorMoneda[]>();

/** Apunta el conversor en la consulta en curso, si alguien está recogiendo. */
export function registrarConversor<T extends ConversorMoneda>(conv: T): T {
  conversoresDeLaPeticion.getStore()?.push(conv);
  return conv;
}

/**
 * Corre `fn` recogiendo los conversores que use. Los conjuntos de días se leen
 * AL TERMINAR: se rellenan a medida que se convierte, no al crear el conversor.
 */
export async function conAvisosDeTasas<T>(
  fn: () => Promise<T>
): Promise<{ resultado: T; tasas: AvisoTasas | null }> {
  const conversores: ConversorMoneda[] = [];
  const resultado = await conversoresDeLaPeticion.run(conversores, fn);
  return { resultado, tasas: unirAvisosTasas(conversores.map((c) => avisoDeTasas(c))) };
}
