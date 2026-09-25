/**
 * Ventas de Hotmart POR CAMPAÑA, para las pestañas del dashboard.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────
 * Las claves de Hotmart que tenía una pestaña (`ventas_*`, `total_*`, y las
 * `funnel_*` por clasificación de oferta) son de CUENTA: salen de
 * `metricas_diarias`, que no sabe de campañas. Así que una pestaña filtrada por
 * campaña dividía TODA la facturación del cliente entre un gasto ya recortado, y
 * el ROAS de la pestaña de una campaña pequeña salía disparado.
 *
 * Las claves `hm_*` son las mismas que las del BI —mismo nombre y misma
 * definición, las de `hotmart/metricas.ts`—, pero siguen el filtro de campañas
 * de la pestaña y el `campaignFilter` de cada tarjeta y columna. Una fórmula
 * `meta_spend / hm_compras` significa lo mismo en un informe y en una pestaña.
 *
 * ── La forma ─────────────────────────────────────────────────────────────────
 * Es el patrón del cubo de respuestas (`lead-answer-aggregation.ts`): el
 * servidor resuelve cada venta a su campaña UNA VEZ POR TUPLA UTM, colapsa a
 * (día × campaña) y codifica por diccionario; el navegador recorta por la
 * pestaña activa, que el servidor no conoce. El diccionario usa la MISMA regla
 * que el de respuestas —índice 0 = `(sin campaña)`— para poder reutilizar
 * `campanasPermitidas` tal cual: una venta y un lead de la misma campaña pasan o
 * no pasan el filtro juntos.
 *
 * Puro: sin Supabase ni `next/*`, para comprobarlo desde `scripts/` y para que lo
 * pueda importar el componente de cliente.
 */

import { aporteDeVenta, CLAVES_APORTE } from '@/lib/hotmart/metricas';
import type { FilaAporte } from '@/lib/hotmart/metricas';
import { SIN_CAMPANA } from './lead-answer-aggregation';
import type { AporteDeCampana } from './lead-answer-aggregation';

export { CLAVES_APORTE };

/**
 * El cubo de ventas listo para filtrar en el navegador.
 *
 * Cada fila de `porFecha` es `[iCampana, ...valores]`, con los valores en el
 * orden de `CLAVES_APORTE`. Posicional a propósito: son nueve números por
 * (día × campaña), y repetir los nueve nombres de clave en cada fila
 * triplicaría el payload sin aportar nada.
 */
export interface HotmartCuboLite {
  /** Nombres de campaña. El índice 0 es SIEMPRE `(sin campaña)`. */
  campanas: string[];
  /** `campaign_id` paralelo a `campanas` (null si no cruzó o no lo tiene). */
  campanaIds: (string | null)[];
  /** fecha de la VENTA (yyyy-MM-dd, día Colombia) → filas `[iCampana, ...valores]`. */
  porFecha: Record<string, number[][]>;
  /** Moneda de los importes `hm_neto`/`hm_bruto`/`hm_neto_reembolsado`. */
  moneda: string;
  /**
   * La carga falló. Un cubo incompleto NO se adjunta a las filas: sin él las
   * fórmulas `hm_*` salen «—», que es la verdad; con él saldrían 0, que
   * afirmaría que no hubo ventas.
   */
  incompleto: boolean;
}

export function cuboHotmartVacio(moneda = 'USD'): HotmartCuboLite {
  return { campanas: [SIN_CAMPANA], campanaIds: [null], porFecha: {}, moneda, incompleto: false };
}

/**
 * ¿Esta fórmula usa claves `hm_*`?
 *
 * Decide si el servidor carga el cubo: leer las ventas y resolver su campaña no
 * es gratis, y la inmensa mayoría de layouts no lo necesita. Las macros
 * derivadas (`hm_roas`, `hm_cpa`…) empiezan también por `hm_`, así que una
 * tarjeta que solo use una macro se detecta igual. Si algún día una macro que NO
 * empieza por `hm_` se expande a claves `hm_*`, hay que añadirla aquí.
 *
 * `\b` delante para no capturar cosas como `xhm_ventas`.
 */
export function formulaUsaHotmart(f: string | null | undefined): boolean {
  return !!f && /\bhm_[a-z0-9_]+/.test(f);
}

// ── Construcción (la usa `hotmart/cubo-db.ts`) ────────────────────────

/** Una fila de `hotmart_ventas` con lo que hace falta para aportar y resolver. */
export type FilaVentaCubo = FilaAporte & {
  utm_id?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
};

/** Céntimos: los importes convertidos ya vienen redondeados venta a venta. */
function redondear(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Pliega las ventas a (día × campaña) y las codifica por diccionario.
 *
 * `campanaDe` recibe la tupla UTM y devuelve la etiqueta de campaña; se llama
 * UNA vez por tupla distinta (memo), igual que en el cubo de respuestas.
 * `convertir` pasa dólares a la moneda de reporte con la tasa del día de CADA
 * venta: se aplica aquí, venta a venta, y no al total del día, que es lo que
 * hace el BI.
 *
 * Las ventas que no aportan nada (pendientes, canceladas, expiradas) no llegan
 * al cubo: no cambian ninguna cifra y solo engordarían el payload.
 */
export function construirCuboHotmart(
  filas: FilaVentaCubo[],
  opts: {
    campanaDe: (tupla: {
      utm_id: string | null;
      utm_campaign: string | null;
      utm_content: string | null;
      utm_term: string | null;
    }) => string;
    idDeCampana?: (label: string) => string | null;
    convertir?: (usd: number, fecha: string) => number;
    moneda?: string;
  }
): HotmartCuboLite {
  const cubo = cuboHotmartVacio(opts.moneda ?? 'USD');
  const idxCampana = new Map<string, number>([[SIN_CAMPANA, 0]]);
  const indiceDeCampana = (label: string): number => {
    const ya = idxCampana.get(label);
    if (ya !== undefined) return ya;
    const i = cubo.campanas.length;
    cubo.campanas.push(label);
    cubo.campanaIds.push(opts.idDeCampana?.(label) ?? null);
    idxCampana.set(label, i);
    return i;
  };

  const memoTupla = new Map<string, number>();
  const campanaDeFila = (r: FilaVentaCubo): number => {
    const tupla = {
      utm_id: r.utm_id ?? null,
      utm_campaign: r.utm_campaign ?? null,
      utm_content: r.utm_content ?? null,
      utm_term: r.utm_term ?? null,
    };
    const k = `${tupla.utm_id ?? ''}|${tupla.utm_campaign ?? ''}|${tupla.utm_content ?? ''}|${tupla.utm_term ?? ''}`;
    const ya = memoTupla.get(k);
    if (ya !== undefined) return ya;
    const i = indiceDeCampana(opts.campanaDe(tupla) || SIN_CAMPANA);
    memoTupla.set(k, i);
    return i;
  };

  // fecha → campaña → valores (en el orden de CLAVES_APORTE).
  const acc = new Map<string, Map<number, number[]>>();
  for (const fila of filas) {
    const fecha = String(fila.fecha_venta ?? '').slice(0, 10);
    if (!fecha) continue;
    const aporte = aporteDeVenta(fila, opts.convertir);
    if (CLAVES_APORTE.every((k) => aporte[k] === 0)) continue;

    const iCampana = campanaDeFila(fila);
    let porCampana = acc.get(fecha);
    if (!porCampana) {
      porCampana = new Map();
      acc.set(fecha, porCampana);
    }
    let valores = porCampana.get(iCampana);
    if (!valores) {
      valores = CLAVES_APORTE.map(() => 0);
      porCampana.set(iCampana, valores);
    }
    CLAVES_APORTE.forEach((k, j) => (valores![j] += aporte[k]));
  }

  for (const [fecha, porCampana] of acc) {
    cubo.porFecha[fecha] = [...porCampana.entries()].map(([i, valores]) => [
      i,
      ...valores.map(redondear),
    ]);
  }
  return cubo;
}

// ── Lectura (navegador) ───────────────────────────────────────────────

/** Todas las claves a 0: un día sin ventas es un día con 0 ventas, no un hueco. */
function clavesEnCero(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of CLAVES_APORTE) out[k] = 0;
  return out;
}

/**
 * Claves `hm_*` que aporta un DÍA a la fila de métricas, ya recortadas por las
 * campañas permitidas (ver `campanasPermitidas`).
 *
 * Emite SIEMPRE las nueve claves, también en cero: si una clave apareciera solo
 * los días con ventas, una gráfica por fecha dibujaría huecos en vez de ceros, y
 * `hm_cpa` de un día sin ventas saldría «—» por falta de clave en lugar de por
 * división entre cero.
 *
 * `(sin campaña)` (índice 0) solo cuenta si `permitidas` lo incluye, y
 * `campanasPermitidas` solo lo incluye cuando NO hay filtro de campaña: una
 * venta sin atribuir es del cliente, pero no se puede afirmar que sea de la
 * campaña filtrada.
 */
export function clavesHotmartDelDia(
  ds: Pick<HotmartCuboLite, 'porFecha'>,
  fecha: string,
  permitidas: Set<number>
): Record<string, number> {
  const out = clavesEnCero();
  for (const fila of ds.porFecha[fecha] ?? []) {
    if (!permitidas.has(fila[0])) continue;
    CLAVES_APORTE.forEach((k, j) => (out[k] += Number(fila[j + 1]) || 0));
  }
  return out;
}

/**
 * Desglose de un día repartido por campaña, para las tablas de ranking (cuyo
 * grano es la campaña y no el día). Misma forma que `desglosePorCampana` del
 * cubo de respuestas, para que el ranking cuelgue las dos cosas igual.
 */
export function desgloseHotmartPorCampana(
  ds: Pick<HotmartCuboLite, 'porFecha' | 'campanas' | 'campanaIds'>,
  fecha: string,
  permitidas: Set<number>
): AporteDeCampana[] {
  const porCampana = new Map<number, Record<string, number>>();
  for (const fila of ds.porFecha[fecha] ?? []) {
    const iCampana = fila[0];
    if (!permitidas.has(iCampana)) continue;
    let v = porCampana.get(iCampana);
    if (!v) {
      v = clavesEnCero();
      porCampana.set(iCampana, v);
    }
    CLAVES_APORTE.forEach((k, j) => (v![k] += Number(fila[j + 1]) || 0));
  }
  return [...porCampana.entries()].map(([iCampana, valores]) => ({
    campaignId: ds.campanaIds[iCampana] ?? null,
    nombre: ds.campanas[iCampana] ?? SIN_CAMPANA,
    valores,
    esSinCampana: iCampana === 0,
  }));
}
