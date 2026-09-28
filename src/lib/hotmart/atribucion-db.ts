// ════════════════════════════════════════════════════════════════
// Atribución por lead: lectura de candidatos y escritura (con base)
// ════════════════════════════════════════════════════════════════
//
// La decisión es pura y vive en `atribucion.ts`. Aquí solo se cargan los leads
// candidatos y, en el barrido, se escribe el resultado.
//
// Dos caminos para los candidatos:
//   · La RPC `hotmart_leads_para_atribucion` (migración 089): filtra en SQL por
//     email/teléfono normalizados y solo devuelve leads que sirven.
//   · Sin la 089, una lectura directa de `lead_events` del cliente en la
//     ventana, filtrada en memoria. Sirve para el modo en seco del script
//     antes de aplicar la migración; escribir exige la 089 (columnas nuevas).

import { fetchAllRows } from '../supabase-paginate';
import { columnas089Disponibles } from './esquema';
import {
  LOOKBACK_DIAS,
  atribuirLotePuro,
  esAnadido,
  esTracking,
  instanteCompra,
  normalizarEmail,
  tel9,
  type LeadCandidato,
  type VentaAtribuible,
} from './atribucion';
import type { AtribucionMetodo, VentaHotmart } from './tipos';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

const DIA_MS = 86_400_000;

/** Id de `report_utm.clientes` a partir del de `public.clientes`. */
export async function rtmDePublico(db: Db, clientePublicoId: string): Promise<string | null> {
  const { data } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', clientePublicoId)
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function funcionNoExiste(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function/i.test(error.message ?? '')
  );
}

/** Leads candidatos del cliente cuyo email o teléfono coincide. */
export async function cargarCandidatos(
  db: Db,
  rtmId: string,
  emails: string[],
  tels: string[],
  desde: Date,
  hasta: Date
): Promise<{ candidatos: LeadCandidato[]; via: 'rpc' | 'directo' }> {
  if (emails.length === 0 && tels.length === 0) return { candidatos: [], via: 'rpc' };

  const args = {
    p_cliente_rtm: rtmId,
    p_emails: emails,
    p_tel9: tels,
    p_desde: desde.toISOString(),
    p_hasta: hasta.toISOString(),
  };
  // La v2 (094) devuelve también los IDs del lead y admite leads que solo traen
  // IDs. Sin ella, la v1 (089); sin ninguna, la lectura directa de abajo.
  const v2 = await db.rpc('hotmart_leads_para_atribucion_v2', args);
  if (!v2.error) return { candidatos: (v2.data ?? []) as LeadCandidato[], via: 'rpc' };
  if (!funcionNoExiste(v2.error)) {
    throw new Error(`hotmart_leads_para_atribucion_v2: ${v2.error.message}`);
  }
  const { data, error } = await db.rpc('hotmart_leads_para_atribucion', args);
  if (!error) return { candidatos: (data ?? []) as LeadCandidato[], via: 'rpc' };
  if (!funcionNoExiste(error)) {
    throw new Error(`hotmart_leads_para_atribucion: ${error.message}`);
  }

  // Sin la 089: lectura directa acotada al cliente y a la ventana.
  const leer = async (conExcluido: boolean) =>
    fetchAllRows(() => {
      let q = db
        .schema('report_utm')
        .from('lead_events')
        .select(
          'id, created_at, lead_email, lead_phone, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id'
        )
        .eq('cliente_id', rtmId)
        .gte('created_at', desde.toISOString())
        .lt('created_at', hasta.toISOString())
        .or('utm_campaign.not.is.null,utm_id.not.is.null');
      if (conExcluido) q = q.not('excluido', 'is', true);
      return q;
    });
  let filas: Record<string, unknown>[];
  try {
    filas = await leer(true);
  } catch {
    filas = await leer(false);
  }

  const setEmails = new Set(emails);
  const setTels = new Set(tels);
  const candidatos: LeadCandidato[] = [];
  for (const f of filas) {
    const email_norm = normalizarEmail(f.lead_email);
    const t9 = tel9(f.lead_phone);
    if (!(email_norm && setEmails.has(email_norm)) && !(t9 && setTels.has(t9))) continue;
    candidatos.push({
      id: String(f.id),
      created_at: String(f.created_at),
      email_norm,
      tel9: t9,
      utm_source: (f.utm_source as string) ?? null,
      utm_medium: (f.utm_medium as string) ?? null,
      utm_campaign: (f.utm_campaign as string) ?? null,
      utm_content: (f.utm_content as string) ?? null,
      utm_term: (f.utm_term as string) ?? null,
      utm_id: (f.utm_id as string) ?? null,
    });
  }
  return { candidatos, via: 'directo' };
}

/** Ventana de leads que cubre un lote de ventas. */
function ventanaDe(ventas: VentaAtribuible[]): { desde: Date; hasta: Date } {
  const ts = ventas.map(instanteCompra).filter((t) => t > 0);
  const min = ts.length ? Math.min(...ts) : Date.now();
  const max = ts.length ? Math.max(...ts) : Date.now();
  return { desde: new Date(min - LOOKBACK_DIAS * DIA_MS), hasta: new Date(max + DIA_MS) };
}

const COLUMNAS_PADRE =
  'id, transaction_id, parent_transaction_id, es_order_bump, tipo, comprador_email, comprador_telefono, orden_at, aprobada_at, fecha_venta, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id';

/**
 * Atribuye un lote ANTES de guardarlo (sync de la API, backfill y webhook).
 * Muta las ventas. Nunca lanza: sin atribución la venta se guarda igual.
 */
export async function atribuirLote(
  db: Db,
  clientePublicoId: string,
  ventas: VentaHotmart[],
  log: (msg: string) => void = () => {}
): Promise<{ atribuidas: number; motivo?: string }> {
  if (ventas.length === 0) return { atribuidas: 0 };
  try {
    if (!(await columnas089Disponibles(db))) return { atribuidas: 0, motivo: 'sin_089' };

    const pendientes = ventas.filter((v) => !esTracking(v) && !v.atribucion_metodo);
    if (pendientes.length === 0) {
      atribuirLotePuro(ventas, []);
      return { atribuidas: 0 };
    }

    const rtmId = await rtmDePublico(db, clientePublicoId);
    if (!rtmId) {
      atribuirLotePuro(ventas, []);
      return { atribuidas: 0, motivo: 'sin_puente' };
    }

    const emails = Array.from(
      new Set(pendientes.map((v) => normalizarEmail(v.comprador_email)).filter(Boolean))
    ) as string[];
    const tels = Array.from(
      new Set(pendientes.map((v) => tel9(v.comprador_telefono)).filter(Boolean))
    ) as string[];
    const { desde, hasta } = ventanaDe(pendientes);
    const { candidatos } = await cargarCandidatos(db, rtmId, emails, tels, desde, hasta);

    // Principales guardados antes (el bump de hoy cuyo principal llegó ayer).
    const padres: VentaAtribuible[] = [];
    const anadidos = pendientes.filter(esAnadido);
    if (anadidos.length > 0) {
      const enLote = new Set(ventas.map((v) => v.transaction_id));
      const ids = Array.from(
        new Set(
          anadidos
            .map((v) => v.parent_transaction_id)
            .filter((t): t is string => Boolean(t) && !enLote.has(t as string))
        )
      );
      const correos = Array.from(
        new Set(anadidos.map((v) => v.comprador_email).filter(Boolean))
      ) as string[];
      const fechas = anadidos.map((v) => v.fecha_venta).sort();
      const antes = new Date(Date.parse(`${fechas[0]}T00:00:00Z`) - DIA_MS)
        .toISOString()
        .slice(0, 10);
      const despues = new Date(Date.parse(`${fechas[fechas.length - 1]}T00:00:00Z`) + DIA_MS)
        .toISOString()
        .slice(0, 10);

      if (ids.length > 0) {
        const { data } = await db
          .from('hotmart_ventas')
          .select(COLUMNAS_PADRE)
          .eq('cliente_id', clientePublicoId)
          .in('transaction_id', ids);
        padres.push(...((data ?? []) as VentaAtribuible[]));
      }
      if (correos.length > 0) {
        const { data } = await db
          .from('hotmart_ventas')
          .select(COLUMNAS_PADRE)
          .eq('cliente_id', clientePublicoId)
          .in('comprador_email', correos)
          .gte('fecha_venta', antes)
          .lte('fecha_venta', despues);
        padres.push(
          ...((data ?? []) as VentaAtribuible[]).filter((p) => !enLote.has(p.transaction_id))
        );
      }
    }

    const r = atribuirLotePuro(ventas, candidatos, padres);
    if (r.atribuidas > 0) {
      log(
        `[Hotmart] Atribución por lead: ${r.atribuidas} venta(s) (email ${r.porMetodo.lead_email}, teléfono ${r.porMetodo.lead_telefono}, padre ${r.porMetodo.padre}).`
      );
    }
    return { atribuidas: r.atribuidas };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[Hotmart] Atribución por lead omitida: ${msg}`);
    return { atribuidas: 0, motivo: msg };
  }
}

// ────────────────────────────────────────────────────────────────
// Barrido sobre lo ya guardado (job diario y script)
// ────────────────────────────────────────────────────────────────

export type InformeAtribucion = {
  aplicado: boolean;
  via: 'rpc' | 'directo' | null;
  con089: boolean;
  revisadas: number;
  yaAtribuidas: number;
  nuevas: number;
  porMetodo: Record<AtribucionMetodo, number>;
  /** Compras principales (sin añadidos) y cuántas quedan con campaña. */
  principales: number;
  principalesConCampana: number;
  netoUsdTotal: number;
  netoUsdConCampana: number;
  escritas: number;
  cambios: Array<{ transaction_id: string; metodo: AtribucionMetodo; utm_campaign: string | null }>;
};

/**
 * Atribuye las ventas guardadas que aún no tienen tupla. En seco por defecto.
 *
 * Escribe con un UPDATE condicional (`atribucion_metodo IS NULL`), no con la
 * RPC: solo toca la tupla, nunca el estado ni los importes, y si mientras
 * tanto llegó el tracking del webhook, la condición falla y no pisa nada.
 */
export async function reatribuirGuardadas(
  db: Db,
  clientePublicoId: string,
  opts: { desde: string; hasta: string; aplicar?: boolean; log?: (m: string) => void }
): Promise<InformeAtribucion> {
  const log = opts.log ?? (() => {});
  const con089 = await columnas089Disponibles(db);
  if (opts.aplicar && !con089) {
    throw new Error(
      'La migración 089 no está aplicada: sin sus columnas no hay dónde guardar la atribución.'
    );
  }

  const cols = [
    'id',
    'transaction_id',
    'parent_transaction_id',
    'es_order_bump',
    'tipo',
    'estado',
    'comprador_email',
    'comprador_telefono',
    'orden_at',
    'aprobada_at',
    'fecha_venta',
    'neto_productor_usd',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'utm_id',
    ...(con089 ? ['atribucion_metodo', 'atribucion_lead_id', 'atribucion_at'] : []),
  ];
  const filas = (await fetchAllRows(() =>
    db
      .from('hotmart_ventas')
      .select(cols.join(','))
      .eq('cliente_id', clientePublicoId)
      .gte('fecha_venta', opts.desde)
      .lte('fecha_venta', opts.hasta)
  )) as Array<Record<string, any>>;

  const ventas = filas.map((f) => ({ ...f })) as Array<VentaAtribuible & Record<string, any>>;
  const antes = new Map(ventas.map((v) => [v.transaction_id, v.atribucion_metodo ?? null]));
  const pendientes = ventas.filter((v) => !esTracking(v) && !v.atribucion_metodo);

  let via: InformeAtribucion['via'] = null;
  let candidatos: LeadCandidato[] = [];
  const rtmId = pendientes.length > 0 ? await rtmDePublico(db, clientePublicoId) : null;
  if (rtmId) {
    const emails = Array.from(
      new Set(pendientes.map((v) => normalizarEmail(v.comprador_email)).filter(Boolean))
    ) as string[];
    const tels = Array.from(
      new Set(pendientes.map((v) => tel9(v.comprador_telefono)).filter(Boolean))
    ) as string[];
    const { desde, hasta } = ventanaDe(pendientes);
    const r = await cargarCandidatos(db, rtmId, emails, tels, desde, hasta);
    candidatos = r.candidatos;
    via = r.via;
  }

  const res = atribuirLotePuro(ventas, candidatos, []);

  const cobrada = (v: Record<string, any>) => v.estado === 'aprobada' || v.estado === 'completa';
  const principales = ventas.filter((v) => cobrada(v) && !esAnadido(v));
  const conCampana = (v: VentaAtribuible) => Boolean(v.utm_campaign || v.utm_id);
  const informe: InformeAtribucion = {
    aplicado: Boolean(opts.aplicar),
    via,
    con089,
    revisadas: ventas.length,
    yaAtribuidas: Array.from(antes.values()).filter(Boolean).length,
    nuevas: res.atribuidas,
    porMetodo: res.porMetodo,
    principales: principales.length,
    principalesConCampana: principales.filter(conCampana).length,
    netoUsdTotal: ventas
      .filter(cobrada)
      .reduce((s, v) => s + (Number(v.neto_productor_usd) || 0), 0),
    netoUsdConCampana: ventas
      .filter((v) => cobrada(v) && conCampana(v))
      .reduce((s, v) => s + (Number(v.neto_productor_usd) || 0), 0),
    escritas: 0,
    cambios: [],
  };

  for (const v of ventas) {
    if (antes.get(v.transaction_id) || !v.atribucion_metodo) continue;
    informe.cambios.push({
      transaction_id: v.transaction_id,
      metodo: v.atribucion_metodo,
      utm_campaign: v.utm_campaign ?? null,
    });
  }

  if (!opts.aplicar) return informe;

  for (const v of ventas) {
    if (antes.get(v.transaction_id) || !v.atribucion_metodo) continue;
    const patch: Record<string, unknown> =
      v.atribucion_metodo === 'tracking'
        ? { atribucion_metodo: 'tracking', atribucion_at: new Date().toISOString() }
        : {
            utm_source: v.utm_source,
            utm_medium: v.utm_medium,
            utm_campaign: v.utm_campaign,
            utm_content: v.utm_content,
            utm_term: v.utm_term,
            utm_id: v.utm_id,
            atribucion_metodo: v.atribucion_metodo,
            atribucion_lead_id: v.atribucion_lead_id ?? null,
            atribucion_at: v.atribucion_at ?? new Date().toISOString(),
          };
    const { error, count } = await db
      .from('hotmart_ventas')
      .update({ ...patch, actualizado_at: new Date().toISOString() }, { count: 'exact' })
      .eq('cliente_id', clientePublicoId)
      .eq('id', v.id)
      .is('atribucion_metodo', null);
    if (error) {
      log(`[Hotmart] No se pudo atribuir ${v.transaction_id}: ${error.message}`);
      continue;
    }
    informe.escritas += count ?? 0;
  }
  return informe;
}
