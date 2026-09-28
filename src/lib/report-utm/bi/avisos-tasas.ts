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
import { alResultadoIncompleto } from '@/lib/supabase-paginate';

const conversoresDeLaPeticion = new AsyncLocalStorage<ConversorMoneda[]>();

// ── Avisos de la consulta ─────────────────────────────────────────────
// Lo mismo para lo que no es moneda: un cruce de campañas que no se pudo
// cargar, una lectura que quedó incompleta. Antes el motor degradaba en
// silencio (agrupaba por UTM crudo, devolvía lo ya leído) y el mismo widget
// podía dar cifras distintas de una carga a otra sin que nada lo dijera.
const avisosDeLaPeticion = new AsyncLocalStorage<Set<string>>();

/** Apunta un aviso en la consulta en curso, si alguien está recogiendo. */
export function registrarAvisoConsulta(texto: string): void {
  avisosDeLaPeticion.getStore()?.add(texto);
}
alResultadoIncompleto(registrarAvisoConsulta);

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
): Promise<{ resultado: T; tasas: AvisoTasas | null; avisos: string[] }> {
  const conversores: ConversorMoneda[] = [];
  const avisos = new Set<string>();
  const resultado = await avisosDeLaPeticion.run(avisos, () =>
    conversoresDeLaPeticion.run(conversores, fn)
  );
  return {
    resultado,
    tasas: unirAvisosTasas(conversores.map((c) => avisoDeTasas(c))),
    avisos: [...avisos],
  };
}
