import 'server-only';

/**
 * Carga de métricas de un cliente — el ÚNICO camino que deben usar la API, el
 * servidor MCP y el agente.
 *
 * Antes de esto convivían cinco formas de calcular las mismas cifras y no
 * coincidían entre sí. La diferencia de fondo: el dashboard suma el gasto del
 * array `meta_campaigns[]`, mientras que el MCP, el motor BI y el digest de
 * WhatsApp leían la columna `meta_spend`. Que ambas fuentes divergen no es una
 * hipótesis — existe `metaRowIsIncomplete()` precisamente para detectarlo, con
 * una tolerancia del 1 %. Cuando la paginación de Meta se trunca, la columna y
 * el array dejan de cuadrar y cada consumidor devolvía un número distinto sin
 * avisar.
 *
 * Este módulo fija el camino del dashboard como el oficial y lo hace
 * reutilizable. Vive en `lib/` y no en un `_actions.ts` a propósito: aquel lleva
 * `'use server'`, así que exportar desde allí convertiría la función en un
 * endpoint HTTP público en vez de en una función importable.
 *
 * Tres garantías que ningún camino anterior daba:
 *
 *   1. `clienteId` es obligatorio. En `ParsedBiQuery` era opcional, y omitirlo
 *      agregaba en silencio el gasto y los leads de TODOS los clientes.
 *   2. Los problemas se propagan en `warnings` en lugar de tragarse. Un
 *      desglose incompleto deja de ser un detalle interno y llega a quien
 *      pregunta.
 *   3. Un fallo de base de datos lanza. Nunca devuelve `[]` ni `0`, que es lo
 *      que hace que un timeout se lea como "no hubo inversión".
 */

import { createAdminClient } from '@/utils/supabase/server';
import { fetchAllRows } from '@/lib/supabase-paginate';
import { mergeMetricasDelRango, agruparOfflinePorFecha } from '@/lib/dashboard/merge-metrics';
import {
  parseTabFilter,
  enrichMetaRow,
  enrichTikTokRow,
  metaRowIsIncomplete,
  tiktokRowIsIncomplete,
  tabFilterLabel,
} from '@/lib/campaign-filter';
import { aggregateFormula, reagregarNoAditivas } from '@/lib/formula-engine';
import { clampRangeToToday, colombiaToday } from '@/lib/date-utils';
import { ApiError } from '@/lib/error-handler';

/** Una fila diaria ya enriquecida y filtrada. */
export type FilaMetricas = Record<string, unknown> & { fecha?: string };

export type RangoAplicado = {
  from: string;
  to: string;
  /** El rango pedido excedía el tope o incluía días futuros. */
  recortado: boolean;
};

export type TabResuelto = {
  id: string;
  nombre: string;
  /** El filtro en forma legible, nunca el `__cf:` crudo. */
  filtro: string;
};

export type MetricasCliente = {
  rows: FilaMetricas[];
  totals: Record<string, number>;
  warnings: string[];
  rango: RangoAplicado;
  tab: TabResuelto | null;
};

export type ParamsMetricasCliente = {
  /** Obligatorio: sin él se agregarían todos los clientes de la cuenta. */
  clienteId: string;
  from: string;
  to: string;
  /** Si se indica, aplica el filtro de campañas de esa pestaña. */
  tabId?: string;
  /** Tope de días del rango. Protege de una consulta que tumbe la función. */
  maxDias?: number;
};

/** Tope por defecto del rango consultable, en días. */
export const MAX_DIAS_RANGO = 180;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function diasEntre(from: string, to: string): number {
  const ms = new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime();
  return Math.floor(ms / 86400000) + 1;
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Normaliza el rango: valida formato, ordena, recorta el futuro y aplica el
 * tope. Devuelve además si hubo recorte, para poder decírselo a quien pregunta
 * en vez de responder sobre un periodo distinto del pedido sin avisar.
 */
export function resolverRango(from: string, to: string, maxDias = MAX_DIAS_RANGO): RangoAplicado {
  if (!RE_FECHA.test(from) || !RE_FECHA.test(to)) {
    throw new ApiError('VALIDATION_ERROR', 'Las fechas deben tener formato YYYY-MM-DD.', 400, {
      from,
      to,
    });
  }

  let desde = from;
  let hasta = to;

  if (desde > hasta) [desde, hasta] = [hasta, desde];

  // Un rango enteramente futuro no es un error: es un rango vacío.
  const acotado = clampRangeToToday(desde, hasta, colombiaToday());
  if (!acotado) {
    return { from: desde, to: hasta, recortado: true };
  }
  desde = acotado.start;
  hasta = acotado.end;
  let recortado = acotado.clamped;

  if (diasEntre(desde, hasta) > maxDias) {
    desde = sumarDias(hasta, -(maxDias - 1));
    recortado = true;
  }

  return { from: desde, to: hasta, recortado };
}

/** Claves que no son métricas y no deben sumarse en los totales. */
const NO_SUMABLES = new Set(['fecha', 'meta_campaigns', 'tiktok_campaigns', 'metricas_manuales']);

/**
 * Totales del periodo.
 *
 * Las claves aditivas se suman; las derivadas (CPL, CPA, ROAS, CTR, CPC, CPM) se
 * RECALCULAN sobre los totales en lugar de promediar las diarias — promediar
 * ratios da un número distinto y equivocado, y es el error clásico al agregar.
 */
function calcularTotales(rows: FilaMetricas[]): Record<string, number> {
  const totales: Record<string, number> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (NO_SUMABLES.has(k)) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      totales[k] = (totales[k] ?? 0) + v;
    }
  }

  reagregarNoAditivas(totales, rows as Record<string, unknown>[]);

  // Las derivadas se piden al mismo motor de fórmulas que usa el dashboard, así
  // que salen idénticas a las que ve el usuario en pantalla.
  // Los nombres son los macros de MACRO_MAP, para que la definicion sea
  // literalmente la misma que la del dashboard y no una reimplementacion.
  const DERIVADAS = [
    'meta_cpl',
    'meta_cpc',
    'meta_cpm',
    'meta_ctr',
    'meta_ctr_link',
    'meta_cpc_link',
    'meta_roas',
    'tiktok_cpc',
    'tiktok_cpm',
    'tiktok_ctr',
    'tiktok_cpa',
  ];
  for (const macro of DERIVADAS) {
    const valor = aggregateFormula(macro, rows as Record<string, unknown>[]);
    if (valor !== null && Number.isFinite(valor)) totales[macro] = valor;
  }

  return totales;
}

/**
 * Métricas diarias de un cliente, por el mismo camino que el dashboard.
 *
 * Lanza `ApiError` si falta el cliente o si la base falla. No devuelve datos
 * vacíos para disimular un error.
 */
export async function getMetricasCliente(params: ParamsMetricasCliente): Promise<MetricasCliente> {
  const { clienteId, tabId, maxDias = MAX_DIAS_RANGO } = params;

  if (!clienteId) {
    throw new ApiError('VALIDATION_ERROR', 'clienteId es obligatorio.', 400);
  }

  const rango = resolverRango(params.from, params.to, maxDias);
  const warnings: string[] = [];
  if (rango.recortado) {
    warnings.push(
      `El rango se ajustó a ${rango.from} → ${rango.to} (tope de ${maxDias} días y sin fechas futuras).`
    );
  }

  const supabase = await createAdminClient();

  // El cliente se comprueba con proyección explícita: `config_api` guarda
  // credenciales en claro y no tiene por qué salir de aquí.
  const { data: cliente, error: errCliente } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', clienteId)
    .maybeSingle();

  if (errCliente) {
    throw new ApiError('DATABASE_ERROR', `No se pudo leer el cliente: ${errCliente.message}`, 500);
  }
  if (!cliente) {
    throw new ApiError('NOT_FOUND', `No existe el cliente ${clienteId}.`, 404);
  }

  // Filtro de campañas de la pestaña. `parseTabFilter` entiende el prefijo
  // `__cf:` con el filtro compuesto en JSON; tratar ese texto como una simple
  // palabra clave no casa ninguna campaña y devuelve un cero muy convincente.
  let tab: TabResuelto | null = null;
  let filtro: ReturnType<typeof parseTabFilter> | undefined;
  if (tabId) {
    const { data: fila, error } = await supabase
      .from('cliente_tabs')
      .select('id, nombre, keyword_meta')
      .eq('id', tabId)
      .eq('cliente_id', clienteId)
      .maybeSingle();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer la pestaña: ${error.message}`, 500);
    }
    if (!fila) {
      throw new ApiError('NOT_FOUND', `La pestaña ${tabId} no es de este cliente.`, 404);
    }

    const raw = (fila as { keyword_meta?: string | null }).keyword_meta ?? null;
    filtro = parseTabFilter(raw);
    tab = {
      id: fila.id as string,
      nombre: fila.nombre as string,
      filtro: tabFilterLabel(raw),
    };
  }

  const { data: grupos, error: errGrupos } = await supabase
    .from('campaign_groups')
    .select('*, campaign_group_mappings (id, campaign_id, campaign_name_pattern)')
    .eq('cliente_id', clienteId);

  if (errGrupos) {
    throw new ApiError(
      'DATABASE_ERROR',
      `No se pudieron leer los grupos de campaña: ${errGrupos.message}`,
      500
    );
  }
  const campaignGroups = grupos ?? [];

  const [metricas, leads, offline] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('metricas_diarias')
        .select('*')
        .eq('cliente_id', clienteId)
        .gte('fecha', rango.from)
        .lte('fecha', rango.to)
    ),
    fetchAllRows(() =>
      supabase
        .from('leads_diarios')
        .select('*')
        .eq('client_id', clienteId)
        .gte('date', rango.from)
        .lte('date', rango.to)
    ),
    fetchAllRows(() =>
      supabase
        .from('conversiones_offline')
        .select('*')
        .eq('cliente_id', clienteId)
        .gte('fecha', rango.from)
        .lte('fecha', rango.to)
    ),
  ]);

  const base = mergeMetricasDelRango({
    metricas,
    leads,
    offlinePorFecha: agruparOfflinePorFecha(offline),
    sheetPorFecha: new Map(),
    leadsLegacyPorFecha: new Map(),
  });

  // El enriquecimiento es lo que hace que las cifras coincidan con el dashboard:
  // recalcula el gasto sumando el array de campañas en lugar de leer la columna.
  const diasIncompletos: string[] = [];
  const rows: FilaMetricas[] = base.map((row) => {
    if (metaRowIsIncomplete(row) || tiktokRowIsIncomplete(row)) {
      const f = (row as { fecha?: string }).fecha;
      if (f) diasIncompletos.push(f);
    }
    return enrichTikTokRow(enrichMetaRow(row, filtro, campaignGroups), filtro, campaignGroups);
  });

  if (diasIncompletos.length > 0) {
    const muestra = diasIncompletos.slice(0, 5).join(', ');
    const resto = diasIncompletos.length > 5 ? ` y ${diasIncompletos.length - 5} día(s) más` : '';
    warnings.push(
      `El desglose por campaña está incompleto en ${muestra}${resto}: el gasto puede quedarse corto respecto al total de la cuenta.`
    );
  }

  if (rows.length === 0) {
    warnings.push(`No hay datos sincronizados para ${rango.from} → ${rango.to}.`);
  }

  return { rows, totals: calcularTotales(rows), warnings, rango, tab };
}
