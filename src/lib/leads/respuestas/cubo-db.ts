/**
 * Lectura del cubo único de leads y respuestas (`report_utm.leads_cubo`,
 * migración 090).
 *
 * UNA llamada por ventana de ≤ 366 días devuelve, para todo el rango, los
 * contactos y las respuestas de TODAS las preguntas pedidas por
 * (día Colombia × tupla UTM + IDs). Sustituye a las hasta cinco lecturas
 * paginadas que hacía el dashboard (`bi_leads_por_dia` + una
 * `bi_respuestas_por_dia` por pregunta, con tope de cuatro).
 *
 * Tres decisiones:
 *
 *   • Las ventanas se piden EN SERIE, no en paralelo: la instancia es una Micro
 *     (ver memoria «instancia saturada») y cada ventana ya es una pasada entera
 *     sobre `lead_events`. Así el rango «Todo» deja de recortarse a 365 días
 *     (auditoría del 2026-09-26: el CPL de «Todo» dividía seis años de gasto
 *     entre un año de leads).
 *   • Si la función no existe (la 090 la aplica una persona), devuelve `null` y
 *     quien llama usa el camino anterior. Mismo patrón que `lead-ids.ts`.
 *   • No aplica catálogo ni resolver: eso es de `cubo.ts` (puro). Aquí solo se
 *     habla con la base.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { colombiaDateOf, colombiaRangeBounds } from '@/lib/colombia-date';
import { argsZona } from '@/lib/zona-activa';

/** Tupla de atribución de un grupo de leads, tal como la devuelve la RPC. */
export type TuplaCubo = [
  utm_id: string | null,
  utm_campaign: string | null,
  utm_content: string | null,
  utm_term: string | null,
  campaign_id: string | null,
  adset_id: string | null,
  ad_id: string | null,
  // La fuente (migración 095): el resolver la usa para no cruzar un nombre con
  // la plataforma equivocada. Opcional: la RPC anterior no la devuelve.
  utm_source?: string | null,
];

/** El cubo crudo: sin catálogo aplicado, con los valores tal como llegaron. */
export interface CuboCrudo {
  tuplas: TuplaCubo[];
  /** [día, índice de tupla, n] */
  totales: Array<[string, number, number]>;
  /** [día, índice de tupla, índice de pregunta, valor crudo, n] */
  respuestas: Array<[string, number, number, string, number]>;
  truncado: boolean;
}

/** Ventana máxima que acepta la RPC (la valida también en SQL). */
export const VENTANA_MAX_DIAS = 366;

/** Tope de grupos (día × tupla × pregunta × valor) por ventana. */
export const LIMITE_GRUPOS = 150000;

function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parte [desde, hasta] (días inclusive) en ventanas de ≤ 366 días. */
export function ventanas(desde: string, hasta: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let ini = desde;
  while (ini <= hasta) {
    const fin = sumarDias(ini, VENTANA_MAX_DIAS - 1);
    out.push([ini, fin < hasta ? fin : hasta]);
    ini = sumarDias(fin, 1);
  }
  return out;
}

/** ¿El error es «la función no existe» (migración sin aplicar)? */
export function esFuncionAusente(error: any): boolean {
  const msg = String(error?.message ?? '');
  return (
    error?.code === 'PGRST202' ||
    error?.code === '42883' ||
    /could not find the function|does not exist|schema cache/i.test(msg)
  );
}

// El resultado de «¿existe la función?» se recuerda unos minutos para no pagar
// una petición fallida por carga mientras la 090 no esté aplicada.
const REINTENTO_SIN_FUNCION_MS = 5 * 60_000;
let sinFuncionHasta = 0;

/** Fusiona cubos de ventanas consecutivas en uno solo (re-indexa las tuplas). */
export function fusionarCubos(partes: CuboCrudo[]): CuboCrudo {
  if (partes.length === 1) return partes[0];
  const tuplas: TuplaCubo[] = [];
  const idx = new Map<string, number>();
  const totales: CuboCrudo['totales'] = [];
  const respuestas: CuboCrudo['respuestas'] = [];
  let truncado = false;
  for (const p of partes) {
    truncado ||= p.truncado;
    const remap = p.tuplas.map((t) => {
      const k = JSON.stringify(t);
      let i = idx.get(k);
      if (i === undefined) {
        i = tuplas.length;
        tuplas.push(t);
        idx.set(k, i);
      }
      return i;
    });
    for (const [d, i, n] of p.totales) totales.push([d, remap[i], n]);
    for (const [d, i, c, v, n] of p.respuestas) respuestas.push([d, remap[i], c, v, n]);
  }
  return { tuplas, totales, respuestas, truncado };
}

/**
 * Carga el cubo crudo de un cliente report_utm para un rango de días Colombia.
 *
 * `campos` es la lista de `claves_origen` (ya normalizadas) de cada pregunta, en
 * el orden en que quien llama quiere recibirlas: el índice de pregunta del cubo
 * es su posición aquí.
 *
 * Devuelve `null` si la función no existe; lanza si falla de otra forma (quien
 * llama decide cómo degradar).
 */
export async function cargarCuboCrudo(
  db: any,
  rtmClienteId: string,
  desde: string,
  hasta: string,
  campos: string[][]
): Promise<CuboCrudo | null> {
  if (Date.now() < sinFuncionHasta) return null;

  const partes: CuboCrudo[] = [];
  for (const [ini, fin] of ventanas(desde, hasta)) {
    const b = colombiaRangeBounds(ini, fin);
    const args = {
      p_cliente_id: rtmClienteId,
      p_desde: b.gte,
      p_hasta: b.lt,
      p_campos: campos,
      p_limite: LIMITE_GRUPOS,
    };
    // La zona del cliente (095) solo viaja si no es Colombia. Sin la migración,
    // la función con `p_zona` no existe (PGRST202) y se repite sin ella: los
    // límites del rango ya van en su zona y solo el corte por día queda en
    // Colombia, que es lo de antes.
    let { data, error } = await db.rpc('leads_cubo', { ...args, ...argsZona() });
    if (error && esFuncionAusente(error) && argsZona().p_zona) {
      ({ data, error } = await db.rpc('leads_cubo', args));
    }
    if (error) {
      if (esFuncionAusente(error)) {
        sinFuncionHasta = Date.now() + REINTENTO_SIN_FUNCION_MS;
        return null;
      }
      throw new Error(`leads_cubo falló: ${error.message}`);
    }
    const d = (data ?? {}) as Partial<CuboCrudo>;
    partes.push({
      tuplas: (d.tuplas ?? []) as TuplaCubo[],
      totales: ((d.totales ?? []) as any[]).map(
        ([dia, i, n]) =>
          [String(dia).slice(0, 10), Number(i), Number(n)] as [string, number, number]
      ),
      respuestas: ((d.respuestas ?? []) as any[]).map(
        ([dia, i, c, v, n]) =>
          [String(dia).slice(0, 10), Number(i), Number(c), String(v ?? ''), Number(n)] as [
            string,
            number,
            number,
            string,
            number,
          ]
      ),
      truncado: !!d.truncado,
    });
  }
  return partes.length === 0
    ? { tuplas: [], totales: [], respuestas: [], truncado: false }
    : fusionarCubos(partes);
}

/**
 * Primer día (Colombia) con leads del cliente, o null si no tiene ninguno.
 *
 * Es lo que resuelve el rango «Todo»: en vez de fingir que el histórico empieza
 * hace 365 días, se empieza donde empieza el cliente. Lee una sola fila por el
 * índice (cliente_id, created_at).
 */
export async function primerDiaConLeads(db: any, rtmClienteId: string): Promise<string | null> {
  const { data, error } = await db
    .from('lead_events')
    .select('created_at')
    .eq('cliente_id', rtmClienteId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error || !data?.[0]?.created_at) return null;
  return colombiaDateOf(String(data[0].created_at));
}
