// ════════════════════════════════════════════════════════════════
// Conversión de importes de Hotmart a USD
// ════════════════════════════════════════════════════════════════
//
// Hotmart cobra en BRL, COP, USD, EUR y MXN según el checkout. El invariante
// que hereda este módulo de `src/lib/fx.ts` y del worker es el importante:
//
//   SIN TASA DE CAMBIO EL IMPORTE ES `null`, NUNCA CERO.
//
// Un cero se suma en silencio, hunde el ROAS y nadie lo detecta. Un null se
// puede contar y reportar — de ahí `sin_tasa` en el resultado, que el worker ya
// convierte en la alerta `sin_tasa_cambio:<monedas>`.
//
// La conversión va EN LOTE porque `preloadUsdRates` resuelve todas las divisas
// de una tanda con una sola llamada a la API de FX. Hacerlo venta a venta era
// una petición HTTP por transacción.

import { getUsdRate, preloadUsdRates } from '../fx';
import { comisionesPendientes } from './parser';
import type { VentaHotmart } from './tipos';

export type ResultadoConversion = {
  /** Importes que no se pudieron convertir por falta de tasa. */
  sin_tasa: number;
  /** Divisas encontradas en el lote. Alimenta la alerta del worker. */
  monedas: string[];
};

function redondear(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Rellena `bruto_usd`, `neto_*_usd` y `usd_rate` de un lote de ventas.
 *
 * Muta las ventas en sitio: son objetos recién parseados que todavía no han
 * salido de este pipeline, y devolver copias solo duplicaría memoria en el
 * backfill.
 *
 * `fecha` es el día contra el que se piden las tasas. Se pasa explícito (y no
 * se deduce de cada venta) para que un lote de un mismo día haga UNA consulta:
 * el error de tomar la tasa del día de hoy para una venta de hace tres meses es
 * menor que el de no convertirla, pero aun así el backfill pasa la fecha real
 * de cada tanda.
 */
export async function convertirLote(
  db: unknown,
  ventas: VentaHotmart[],
  fecha: string
): Promise<ResultadoConversion> {
  const monedas = Array.from(
    new Set(
      ventas
        .flatMap((v) => [v.moneda, comisionesPendientes.get(v)?.moneda ?? null])
        .map((m) => String(m ?? '').toUpperCase())
        .filter(Boolean)
    )
  );

  if (monedas.length === 0) return { sin_tasa: 0, monedas: [] };

  // Una sola llamada a la API de FX para todo el lote.
  await preloadUsdRates(db, monedas, fecha);

  const tasas = new Map<string, number | null>();
  for (const m of monedas) {
    const { rate } = await getUsdRate(db, m, fecha);
    tasas.set(m, rate);
  }

  let sin_tasa = 0;

  /** Convierte, contando los importes que se quedan sin tasa. */
  const aUsd = (valor: number | null, moneda: string | null): number | null => {
    if (valor == null) return null;
    const cur = String(moneda ?? '').toUpperCase();
    if (!cur) {
      if (valor !== 0) sin_tasa++;
      return null;
    }
    const rate = tasas.get(cur);
    if (rate == null) {
      // El cero no cuenta como pérdida: convertir 0 da 0 en cualquier moneda.
      if (valor !== 0) sin_tasa++;
      return null;
    }
    return redondear(valor * rate);
  };

  for (const v of ventas) {
    const cur = String(v.moneda ?? '').toUpperCase();
    v.usd_rate = cur ? (tasas.get(cur) ?? null) : null;
    v.bruto_usd = aUsd(v.bruto, v.moneda);

    const com = comisionesPendientes.get(v);
    if (com) {
      const monedaCom = com.moneda ?? v.moneda;
      v.neto_productor_usd = aUsd(com.productor, monedaCom);
      v.neto_afiliado_usd = aUsd(com.afiliado, monedaCom);
      v.neto_coproductor_usd = aUsd(com.coproductor, monedaCom);
    }
  }

  return { sin_tasa, monedas };
}
