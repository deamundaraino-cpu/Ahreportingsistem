/**
 * Valores reales de los leads de un cliente, para armar la regla de exclusión.
 *
 * La ficha del cliente («Qué leads cuentan») ofrece elegir de una lista —con
 * cuántos leads tiene cada valor— en vez de escribir a ciegas. Todo sale de UNA
 * pasada sobre `lead_events` y se agrega en Node:
 *
 *   · por qué no `bi_valores_conteo`: esa RPC no sabe leer `custom_data.tags`
 *     (las etiquetas de GHL), y es la que se corta a los 8 s en los clientes
 *     grandes (ver `bi-valores.ts`). Aquí basta con una lectura paginada;
 *   · los EXCLUIDOS se cuentan también: justo los valores que la regla ya deja
 *     fuera («UTM - Report») son los que alguien querrá ver para retocarla.
 *
 * `agregarValoresRegla` es pura y se comprueba en `verify-lead-exclusion.ts`.
 */

import { fetchAllRows } from '@/lib/supabase-paginate';

/** Columnas de `lead_events` que se ofrecen con su lista de valores. */
export const COLUMNAS_CON_VALORES = [
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_source',
  'utm_medium',
  'form_name',
  'form_plugin',
  'ip_country',
] as const;

export type ColumnaConValores = (typeof COLUMNAS_CON_VALORES)[number];

export type ValorConteo = { valor: string; n: number };

export type PreguntaConValores = { clave: string; n: number; valores: ValorConteo[] };

export type ValoresRegla = {
  columnas: Record<ColumnaConValores, ValorConteo[]>;
  etiquetas: ValorConteo[];
  preguntas: PreguntaConValores[];
  /** Leads leídos. */
  leidos: number;
  /** `true` si se llegó al tope de lectura: la lista es una muestra. */
  truncado: boolean;
  /** Desde qué fecha (ISO) se leyó. */
  desde: string;
};

/** Valores por lista: más no se leen en un desplegable. */
export const MAX_VALORES_LISTA = 300;
/** Preguntas: las de más cobertura primero. */
const MAX_PREGUNTAS = 60;
/** Textos más largos no son una opción, son una respuesta libre. */
const MAX_LARGO_VALOR = 120;

function escalares(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(escalares);
  if (typeof v === 'object') return [];
  const s = String(v).trim();
  return s ? [s] : [];
}

/**
 * Cuenta sin distinguir mayúsculas y enseña la forma más frecuente. Un lead
 * cuenta una sola vez por valor aunque lo repita.
 */
class Contador {
  private m = new Map<string, { n: number; formas: Map<string, number> }>();
  add(valores: string[]) {
    const vistos = new Set<string>();
    for (const v of valores) {
      if (v.length > MAX_LARGO_VALOR) continue;
      const k = v.toLowerCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      let e = this.m.get(k);
      if (!e) this.m.set(k, (e = { n: 0, formas: new Map() }));
      e.n++;
      e.formas.set(v, (e.formas.get(v) ?? 0) + 1);
    }
  }
  lista(): ValorConteo[] {
    return [...this.m.values()]
      .map((e) => ({
        valor: [...e.formas.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0],
        n: e.n,
      }))
      .sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor))
      .slice(0, MAX_VALORES_LISTA);
  }
}

export function agregarValoresRegla(
  filas: Array<Record<string, unknown>>
): Omit<ValoresRegla, 'truncado' | 'desde'> {
  const cols = Object.fromEntries(COLUMNAS_CON_VALORES.map((c) => [c, new Contador()])) as Record<
    ColumnaConValores,
    Contador
  >;
  const etiquetas = new Contador();
  const preguntas = new Map<string, { n: number; valores: Contador }>();

  for (const f of filas) {
    for (const c of COLUMNAS_CON_VALORES) cols[c].add(escalares(f[c]));
    const cd = f.custom_data;
    etiquetas.add(
      escalares(
        f.tags !== undefined
          ? f.tags
          : cd && typeof cd === 'object'
            ? (cd as Record<string, unknown>).tags
            : undefined
      )
    );
    const rf = f.raw_fields;
    if (rf && typeof rf === 'object' && !Array.isArray(rf)) {
      for (const [clave, val] of Object.entries(rf as Record<string, unknown>)) {
        const vs = escalares(val);
        if (vs.length === 0) continue;
        let p = preguntas.get(clave);
        if (!p) preguntas.set(clave, (p = { n: 0, valores: new Contador() }));
        p.n++;
        p.valores.add(vs);
      }
    }
  }

  return {
    columnas: Object.fromEntries(COLUMNAS_CON_VALORES.map((c) => [c, cols[c].lista()])) as Record<
      ColumnaConValores,
      ValorConteo[]
    >,
    etiquetas: etiquetas.lista(),
    preguntas: [...preguntas.entries()]
      .map(([clave, p]) => ({ clave, n: p.n, valores: p.valores.lista() }))
      .sort((a, b) => b.n - a.n || a.clave.localeCompare(b.clave))
      .slice(0, MAX_PREGUNTAS),
    leidos: filas.length,
  };
}

/** Tope de lectura: suficiente para ver todos los valores de uso real. */
export const MAX_LEADS_LEIDOS = 15_000;
/** Ventana: lo que entró en el último año. */
export const DIAS_VENTANA = 365;

/**
 * Lee y agrega. `rtm` = cliente Supabase ya en `report_utm`.
 */
export async function cargarValoresRegla(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rtm: any,
  clienteId: string
): Promise<ValoresRegla> {
  const desde = new Date(Date.now() - DIAS_VENTANA * 86_400_000).toISOString();
  const filas = await fetchAllRows(
    () =>
      rtm
        .from('lead_events')
        .select(`id,${COLUMNAS_CON_VALORES.join(',')},raw_fields,tags:custom_data->tags`)
        .eq('cliente_id', clienteId)
        .gte('created_at', desde),
    1000,
    MAX_LEADS_LEIDOS,
    { estricto: false }
  );
  return {
    ...agregarValoresRegla(filas),
    truncado: filas.length >= MAX_LEADS_LEIDOS,
    desde,
  };
}
