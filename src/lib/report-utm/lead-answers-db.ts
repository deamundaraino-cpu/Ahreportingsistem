/**
 * Respuestas de formulario, plegadas y cruzadas con las campañas reales.
 *
 * Es la capa que alimenta el bloque de respuestas del dashboard general. Su
 * trabajo son tres pasos, en este orden:
 *
 *   1. La base pliega los leads a (día Colombia × valor crudo × tupla UTM) con
 *      su recuento — `report_utm.leads_cubo` (migración 090: una sola lectura
 *      para el total y todas las preguntas) o, sin ella, las RPC anteriores
 *      `bi_leads_por_dia` y `bi_respuestas_por_dia` (071).
 *   2. Node aplica el catálogo de campos de lead (`bucketDeValor`) para convertir
 *      el valor crudo en su bucket, y resuelve la campaña UNA VEZ POR TUPLA UTM
 *      con la cascada de 7 pasos de `campaign-resolver`.
 *   3. El resultado se colapsa a (día × campaña × bucket) y se codifica por
 *      diccionario. Eso —y no el plegado de SQL— es lo que hace que al navegador
 *      lleguen unos KB en vez de decenas de miles de filas.
 *
 * Por qué el cruce a campaña se resuelve por tupla y no por fila: es el mismo
 * patrón que la migración 070 §2 estableció para los desplegables. Un cliente con
 * 9.000 leads tiene unas pocas decenas de tuplas UTM distintas; resolver por fila
 * repetiría el mismo trabajo miles de veces.
 *
 * NO hay dato derivado ni recálculo: igual que los campos de lead (migración
 * 060), el catálogo se aplica al consultar, así que editar una agrupación se ve
 * en el dashboard al recargar.
 */

import { colombiaRangeBounds } from '@/lib/colombia-date';
import type { LeadCampoDef, LeadSegmentoLite } from './lead-campos';
import { loadResolver, SIN_CAMPANA } from './campaign-resolver';
import type { CampaignResolver } from './campaign-resolver';
import { cargarCuboCrudo, esFuncionAusente, ventanas } from '@/lib/leads/respuestas/cubo-db';
import type { CuboCrudo, TuplaCubo } from '@/lib/leads/respuestas/cubo-db';
import { construirDataset } from '@/lib/leads/respuestas/cubo';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tope de filas que pide cada llamada a la RPC. Superarlo NO se degrada en
 * silencio: la RPC devuelve `total_filas` y el dataset se marca `incompleto`
 * para que la UI lo diga.
 */
export const LIMITE_FILAS_RPC = 60000;

/**
 * Tope de campos por carga. Un layout con más renderiza los primeros y avisa:
 * cada campo es una consulta independiente, y cuatro ya cubren de sobra el uso
 * real (el cliente con más preguntas configuradas tiene tres).
 */
export const MAX_CAMPOS_POR_CARGA = 4;

/** Bucket sintético de los leads que no cruzaron con ninguna campaña real. */
export { SIN_CAMPANA };

/** Un campo de lead tal como lo ve el bloque, con sus buckets ya ordenados. */
export interface LeadAnswerCatalogo {
  clave: string;
  nombre: string;
  /** Buckets en el orden configurado (`valores_orden`), o por frecuencia. */
  buckets: string[];
  /**
   * Clave estable de cada bucket, en el mismo orden (`lf__<campo>__<clave>`).
   * Sale de `lead_campos.respuestas` (migración 090) o, si falta, del slug
   * determinista de `clavesDeRespuestas`. Opcional por compatibilidad con
   * datasets armados antes de la 090.
   */
  claves?: string[];
  /** Pregunta de selección múltiple: sus buckets solapan (ver `respondidosPorFecha`). */
  multiple?: boolean;
  claves_origen: string[];
  origen: 'catalogo' | 'auto';
  /** Leads del período que respondieron este campo. */
  cobertura: number;
  /**
   * Segmentos definidos sobre este campo («Desde 2M» = estos tres buckets).
   * Solo los tiene un campo del catálogo: uno autodetectado no existe en la
   * base, así que nadie ha podido definirle un segmento.
   */
  segmentos?: LeadSegmentoLite[];
}

/**
 * El cubo de respuestas listo para filtrar en el navegador.
 *
 * Codificado por diccionario a propósito: los tripletes son la parte que crece
 * (día × campaña × bucket) y repetir el nombre de la campaña —que en producción
 * llega a tener 40 caracteres con emojis y corchetes— en cada uno multiplicaría
 * el payload por diez.
 */
export interface LeadAnswerDataset {
  /** Nombres de campaña. El índice 0 es SIEMPRE `(sin campaña)`. */
  campanas: string[];
  /** `campaign_id` paralelo a `campanas` (null si no cruzó o no lo tiene). */
  campanaIds: (string | null)[];
  campos: LeadAnswerCatalogo[];
  /** fecha (yyyy-MM-dd) → índice de campo → tripletes [bucket, campaña, n]. */
  porFecha: Record<string, Array<Array<[number, number, number]>>>;
  /**
   * TODOS los contactos del día, respondan o no: fecha → pares [campaña, n].
   *
   * Es el denominador. Sin él, los buckets suman menos que la realidad y nadie
   * sabe si el resto no respondió o si el sistema se los perdió; con él existe
   * `(sin respuesta)` y la cuenta cierra siempre.
   *
   * Se carga aunque el layout no tenga ningún bloque de respuestas, porque la
   * métrica `utm_leads` tiene que estar disponible en cualquier tarjeta,
   * gráfica o columna que quiera usarla el trafficker.
   */
  totalesPorFecha: Record<string, Array<[number, number]>>;
  /**
   * Solo para preguntas de selección múltiple: fecha → índice de campo → pares
   * [campaña, n] de los leads que respondieron ALGO. Sus buckets solapan (un
   * lead cuenta en cada opción que eligió), así que la suma de buckets ya no es
   * «los que respondieron» y `(sin respuesta)` se calcula contra esto.
   */
  respondidosPorFecha?: Record<string, Record<number, Array<[number, number]>>>;
  /**
   * El mismo cubo a nivel de CONJUNTO y ANUNCIO, solo si el layout lo pide (un
   * ranking o una gráfica por anuncio/conjunto con métricas de respuestas). Va
   * aparte y es opcional porque multiplica el tamaño: hay decenas de campañas
   * pero cientos de tuplas de atribución.
   */
  niveles?: NivelesDataset;
  /** Alguna consulta se truncó o falló: la UI tiene que decirlo. */
  incompleto: boolean;
  /**
   * Claves que un bloque pide y el catálogo ACTIVO no tiene.
   *
   * No se rellena aquí sino en el servidor del dashboard, que es quien resuelve
   * los bloques contra el catálogo. Viaja en el dataset para que el bloque pueda
   * distinguir "esta pregunta ya no existe" de "este cliente no tiene ninguna
   * respuesta", que es un mensaje muy distinto y manda a buscar el problema a
   * otro sitio.
   *
   * Pasó de verdad: con un único bloque roto en la pestaña, `campos` quedaba
   * vacío y la UI decía "no hay respuestas de formulario para este cliente"
   * cuando el cliente tenía doce mil.
   */
  camposAusentes?: string[];
}

/**
 * Cubo por tupla de atribución, con su campaña, conjunto y anuncio resueltos.
 * Los índices de `porFecha` y `totalesPorFecha` son de TUPLA; `tuplas[i]` dice a
 * qué campaña (índice de `campanas` del dataset), conjunto y anuncio pertenece.
 * El índice 0 de `conjuntos` y `anuncios` es siempre «sin conjunto/anuncio».
 */
export interface NivelesDataset {
  tuplas: Array<[iCampana: number, iConjunto: number, iAnuncio: number]>;
  conjuntos: string[];
  conjuntoIds: (string | null)[];
  anuncios: string[];
  anuncioIds: (string | null)[];
  /** fecha → índice de campo → [bucket, tupla, n] */
  porFecha: Record<string, Array<Array<[number, number, number]>>>;
  /** fecha → [tupla, n] */
  totalesPorFecha: Record<string, Array<[number, number]>>;
  /** Selección múltiple: fecha → índice de campo → [tupla, n] que respondieron. */
  respondidosPorFecha?: Record<string, Record<number, Array<[number, number]>>>;
}

export function datasetVacio(): LeadAnswerDataset {
  return {
    campanas: [],
    campanaIds: [],
    campos: [],
    porFecha: {},
    totalesPorFecha: {},
    incompleto: false,
  };
}

/** ¿El dataset tiene algo que pintar? */
export function datasetTieneDatos(ds: LeadAnswerDataset | null | undefined): boolean {
  return !!ds && ds.campos.length > 0 && Object.keys(ds.porFecha).length > 0;
}

/** ¿Hay al menos contactos, aunque no haya ninguna pregunta configurada? */
export function datasetTieneLeads(ds: LeadAnswerDataset | null | undefined): boolean {
  return !!ds && Object.keys(ds.totalesPorFecha).length > 0;
}

/**
 * Tamaño de página de PostgREST. **También corta las respuestas de RPC**, no solo
 * las de tabla: una función que agrupa 1.608 filas devuelve 1.000 y no avisa.
 * Es el mismo motivo por el que `lead-campos-db.ts` usa `fetchAllRows`.
 */
const PAGINA_POSTGREST = 1000;

/**
 * Clave de grano de una fila de RPC: todas sus columnas MENOS las agregadas.
 *
 * `n` es el recuento y `total_filas` la ventana; el resto es justamente el
 * `GROUP BY` de la función, así que dos filas con la misma clave son la misma
 * combinación devuelta dos veces.
 */
function claveDeGrano(fila: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(fila)
      .filter((k) => k !== 'n' && k !== 'total_filas')
      .sort()
      .map((k) => [k, fila[k]])
  );
}

/**
 * Trae TODAS las filas de una RPC, paginando con `range`.
 *
 * Detecta el truncado comparando contra `total_filas`, que la propia función
 * devuelve con un `COUNT(*) OVER ()`. Sin esto, el desglose de un cliente con
 * más de mil combinaciones mostraba de menos con aspecto de dato completo —y
 * cuadrando consigo mismo, que es lo que lo hacía indetectable a ojo.
 *
 * **La paginación por OFFSET exige que la RPC ordene por su GRANO COMPLETO.** No
 * es un detalle de estilo: `.range()` re-ejecuta la función en cada página, así
 * que si el `ORDER BY` deja empates (y con `n DESC, dia ASC` los deja a miles),
 * el orden de esos empates puede cambiar entre peticiones y unas filas salen en
 * DOS páginas mientras otras no salen en ninguna. La migración 078 lo arregló
 * añadiendo el resto de la tupla al `ORDER BY`; si alguien recorta ese `ORDER BY`
 * por rendimiento, esto vuelve a romperse. Antes de la 078 el síntoma era un
 * conteo que cambiaba al recargar, y `verify-lead-segmentos-db` lo cazaba una de
 * cada tres veces.
 *
 * Por eso el truncado NO basta como red de seguridad —`filas.length < total` no
 * ve un intercambio de una duplicada por una perdida, porque el recuento cuadra—
 * y se comprueban además los duplicados por grano.
 */
async function traerTodasLasFilas(
  consulta: (desde: number, hasta: number) => PromiseLike<{ data: unknown; error: any }>
): Promise<{ filas: any[]; error: any; truncado: boolean }> {
  const filas: any[] = [];
  let total: number | null = null;

  for (let offset = 0; offset < LIMITE_FILAS_RPC; offset += PAGINA_POSTGREST) {
    const { data, error } = await consulta(offset, offset + PAGINA_POSTGREST - 1);
    if (error) return { filas, error, truncado: false };

    const lote = (data ?? []) as any[];
    if (lote.length === 0) break;
    if (total === null) total = Number(lote[0].total_filas ?? 0);
    filas.push(...lote);

    if (lote.length < PAGINA_POSTGREST) break;
    if (total !== null && filas.length >= total) break;
  }

  // Solo puede haber duplicados si se paginó: con una única página el orden es
  // el de una sola ejecución y no hay nada que pueda descuadrarse.
  if (filas.length > PAGINA_POSTGREST) {
    const vistos = new Set<string>();
    let repetidas = 0;
    for (const f of filas) {
      const k = claveDeGrano(f);
      if (vistos.has(k)) repetidas++;
      else vistos.add(k);
    }
    if (repetidas > 0) {
      console.error(
        `[lead-answers] la paginación devolvió ${repetidas} fila(s) repetida(s) de ${filas.length}:` +
          ' el ORDER BY de la RPC ya no cubre su grano completo (ver migración 078).' +
          ' El conteo va a estar mal y va a cambiar entre recargas.'
      );
    }
  }

  return { filas, error: null, truncado: total !== null && filas.length < total };
}

/**
 * Sintetiza un `LeadCampoDef` a partir de unas claves crudas, para las preguntas
 * auto-detectadas que todavía no están en el catálogo.
 *
 * Es lo que permite que haya UN SOLO camino de ejecución: a partir de aquí, una
 * pregunta detectada y una configurada son indistinguibles para el resto del
 * módulo, porque `bucketDeValor` solo necesita `valores_map` y `sin_mapear`. Sin
 * esto, cada arreglo del bucketizado habría que hacerlo dos veces.
 */
export function campoSintetico(
  clave: string,
  nombre: string,
  clavesOrigen: string[]
): LeadCampoDef {
  return {
    id: `auto:${clave}`,
    cliente_id: '',
    clave,
    nombre,
    descripcion: null,
    claves_origen: clavesOrigen,
    // Sin agrupación: el valor crudo normalizado ES el bucket. Es la
    // diferencia real entre una pregunta detectada y una configurada, y por
    // eso el modal ofrece "Guardar en el catálogo".
    valores_map: {},
    valores_orden: [],
    sin_mapear: 'crudo',
    max_valores: 200,
    activo: true,
    orden: 0,
  };
}

// ── Caché de módulo ───────────────────────────────────────────────────
// El dashboard interno y el espejo público del mismo cliente piden lo mismo, y
// el periodo anterior dispara una segunda tanda con otro rango. TTL igual que el
// del resolver de campañas, por coherencia: los dos dependen de lo mismo (que el
// worker no haya sincronizado nada nuevo).

const DATASET_TTL_MS = 60_000;

interface CacheEntry {
  ds: LeadAnswerDataset;
  ts: number;
}
const datasetCache = new Map<string, CacheEntry>();

function pruneCache(now: number): void {
  for (const [k, v] of datasetCache) {
    if (now - v.ts > DATASET_TTL_MS) datasetCache.delete(k);
  }
}

/**
 * Firma de los segmentos que van a viajar en el cubo. Entra en la clave de caché
 * junto a la de los campos: sin ella, editar los buckets de un segmento seguiría
 * devolviendo el cubo anterior durante el TTL, y la tarjeta mostraría el número
 * de antes sin ninguna señal de que está caducado.
 */
function firmaDeSegmentos(
  campos: LeadCampoDef[],
  porCampo: Record<string, LeadSegmentoLite[]>
): string {
  return campos
    .map((c) =>
      (porCampo[c.clave] ?? [])
        .map((s) => `${s.clave}:${s.operador}:${s.valores.join('~')}`)
        .join(',')
    )
    .join('|');
}

/**
 * Firma COMPLETA de la definición de los campos pedidos.
 *
 * Antes solo entraba cuántas entradas tenía `valores_map` (auditoría del
 * 2026-09-26): remapear una respuesta de un bucket a otro no cambiaba la firma y
 * el dashboard seguía sirviendo la cifra vieja durante el TTL. Ahora entra todo
 * lo que decide un número: el mapa entero, el orden, la política de lo no
 * mapeado, el tipo y las claves de respuesta.
 */
export function firmaDeCampos(campos: LeadCampoDef[]): string {
  return campos
    .map((c) =>
      JSON.stringify([
        c.clave,
        c.claves_origen,
        Object.entries(c.valores_map ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        c.valores_orden ?? [],
        c.sin_mapear,
        c.tipo ?? null,
        (c.respuestas ?? []).map((r) => [r.clave, r.nombre, r.alias ?? []]),
      ])
    )
    .join('|');
}

/**
 * Índice nombre de campaña → `campaign_id`, para que el diccionario del dataset
 * pueda llevar el id. Lo necesitan los grupos de campaña del dashboard, que
 * mapean por id además de por patrón de nombre.
 *
 * Exportado para el cubo de ventas de Hotmart (`hotmart/cubo-db.ts`): los dos
 * cubos tienen que dar el MISMO id a la misma campaña, o un grupo de campañas
 * recortaría leads y ventas de forma distinta.
 */
export function idsPorNombre(resolver: CampaignResolver | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!resolver) return out;
  for (const agg of resolver.index.campaigns.values()) {
    // Si dos plataformas comparten nombre, gana la primera: el id solo se usa
    // para cruzar con los grupos, y un grupo se define por plataforma.
    if (!out.has(agg.name)) out.set(agg.name, agg.campaign_id);
  }
  return out;
}

// ── Camino anterior a la 090 ──────────────────────────────────────────
// Mientras `report_utm.leads_cubo` no exista (la migración la aplica una
// persona), el cubo se arma con las RPC de siempre y se convierte al MISMO
// formato crudo. A partir de ahí el procesamiento es uno solo (`cubo.ts`): no
// hay dos implementaciones del bucketizado que puedan divergir.

async function cargarCuboAnterior(
  db: any,
  rtmClienteId: string,
  dateFrom: string,
  dateTo: string,
  campos: LeadCampoDef[],
  conTotales: boolean
): Promise<{ crudo: CuboCrudo; incompleto: boolean }> {
  const tuplas: TuplaCubo[] = [];
  const idx = new Map<string, number>();
  const tupla = (r: any): number => {
    const t: TuplaCubo = [
      r.utm_id ?? null,
      r.utm_campaign ?? null,
      r.utm_content ?? null,
      r.utm_term ?? null,
      null,
      null,
      null,
    ];
    const k = JSON.stringify(t);
    let i = idx.get(k);
    if (i === undefined) {
      i = tuplas.length;
      tuplas.push(t);
      idx.set(k, i);
    }
    return i;
  };
  const totales: CuboCrudo['totales'] = [];
  const respuestas: CuboCrudo['respuestas'] = [];
  let incompleto = false;

  // Ventanas en serie, igual que la RPC nueva: el rango «Todo» ya no se recorta.
  for (const [ini, fin] of ventanas(dateFrom, dateTo)) {
    const bounds = colombiaRangeBounds(ini, fin);
    const totalesPromise = conTotales
      ? traerTodasLasFilas((desde, hasta) =>
          db
            .rpc('bi_leads_por_dia', {
              p_cliente_id: rtmClienteId,
              p_desde: bounds.gte,
              p_hasta: bounds.lt,
              p_limite: LIMITE_FILAS_RPC,
            })
            .range(desde, hasta)
        )
      : null;

    const porCampo = await Promise.all(
      campos.map(async (campo) => {
        if ((campo.claves_origen ?? []).length === 0) return { filas: [] as any[], parcial: true };
        const { filas, error, truncado } = await traerTodasLasFilas((desde, hasta) =>
          db
            .rpc('bi_respuestas_por_dia', {
              p_cliente_id: rtmClienteId,
              p_desde: bounds.gte,
              p_hasta: bounds.lt,
              p_claves_json: campo.claves_origen,
              p_limite: LIMITE_FILAS_RPC,
            })
            .range(desde, hasta)
        );
        if (error) {
          if (!esFuncionAusente(error)) {
            console.error('[lead-answers] bi_respuestas_por_dia falló:', error.message);
          }
          return { filas: [] as any[], parcial: true };
        }
        return { filas, parcial: truncado };
      })
    );
    porCampo.forEach(({ filas, parcial }, iCampo) => {
      if (parcial) incompleto = true;
      for (const f of filas) {
        const dia = String(f.dia ?? '').slice(0, 10);
        const n = Number(f.n ?? 0);
        if (!dia || !n) continue;
        respuestas.push([dia, tupla(f), iCampo, String(f.valor ?? ''), n]);
      }
    });

    if (totalesPromise) {
      const { filas, error, truncado } = await totalesPromise;
      if (error) {
        if (!esFuncionAusente(error)) {
          console.error('[lead-answers] bi_leads_por_dia falló:', error.message);
        }
        incompleto = true;
      } else {
        if (truncado) incompleto = true;
        for (const f of filas) {
          const dia = String(f.dia ?? '').slice(0, 10);
          const n = Number(f.n ?? 0);
          if (!dia || !n) continue;
          totales.push([dia, tupla(f), n]);
        }
      }
    }
  }
  return { crudo: { tuplas, totales, respuestas, truncado: false }, incompleto };
}

/** La tupla del cubo en la forma que lee el resolver de campañas. */
function registroDeTupla(t: TuplaCubo) {
  return {
    utm_id: t[0],
    utm_campaign: t[1],
    utm_content: t[2],
    utm_term: t[3],
    campaign_id: t[4],
    adset_id: t[5],
    ad_id: t[6],
  };
}

/**
 * Carga el cubo de respuestas de un cliente report_utm para un rango.
 *
 * Nunca lanza: cualquier fallo (falta la migración, la RPC agota el tiempo, el
 * cliente no tiene índice de campañas) devuelve un dataset marcado `incompleto`
 * en vez de tumbar la carga del dashboard.
 *
 * `db` tiene que venir YA acotado al esquema report_utm
 * (`createAdminClient().schema('report_utm')`), igual que en `lead-campos-db.ts`:
 * así quien llama decide una sola vez con qué credenciales entra.
 *
 * Con la migración 090 es UNA lectura por ventana de un año para el total y
 * todas las preguntas, sin tope de preguntas. Sin ella, el camino anterior (una
 * RPC por pregunta, con tope `MAX_CAMPOS_POR_CARGA`).
 */
export async function cargarRespuestasLead(
  db: any,
  rtmClienteId: string,
  dateFrom: string,
  dateTo: string,
  campos: LeadCampoDef[],
  origenes: Record<string, 'catalogo' | 'auto'> = {},
  /**
   * Traer el total diario de contactos. Solo hace falta si algo lo va a usar:
   * un bloque de respuestas (que lo necesita para su `(sin respuesta)`) o una
   * fórmula que mencione `utm_leads`/`lf__`. Ver `layoutUsaRespuestasLead`.
   */
  conTotales = true,
  /**
   * Segmentos del cliente, indexados por la clave de su campo padre. No cuestan
   * ninguna consulta extra aquí: el cubo ya viene desglosado por bucket, así que
   * un segmento es una suma sobre un subconjunto de índices.
   */
  segmentosPorCampo: Record<string, LeadSegmentoLite[]> = {},
  /**
   * `niveles`: construir también el cubo por conjunto y anuncio. Solo cuando un
   * ranking o una gráfica por anuncio/conjunto usa métricas de respuestas.
   */
  opciones: { niveles?: boolean } = {}
): Promise<LeadAnswerDataset> {
  // Sin campos SÍ se sigue si se piden totales: `utm_leads` tiene que existir
  // aunque el cliente no tenga ninguna pregunta configurada.
  if (!rtmClienteId) return datasetVacio();
  if (campos.length === 0 && !conTotales) return datasetVacio();
  if (!dateFrom || !dateTo || dateFrom > dateTo) return datasetVacio();

  const key = `${rtmClienteId}|${dateFrom}|${dateTo}|${conTotales ? 't' : ''}|${firmaDeCampos(campos)}|${firmaDeSegmentos(campos, segmentosPorCampo)}|${opciones.niveles ? 'n' : ''}`;
  const now = Date.now();
  const hit = datasetCache.get(key);
  if (hit && now - hit.ts <= DATASET_TTL_MS) return hit.ds;

  // El resolver se carga UNA vez para todos los campos.
  const resolver = await loadResolver(rtmClienteId, dateFrom, dateTo).catch(() => null);
  const idsCampana = idsPorNombre(resolver);

  let crudo: CuboCrudo | null = null;
  let incompleto = false;
  let usados = campos;
  try {
    crudo = await cargarCuboCrudo(
      db,
      rtmClienteId,
      dateFrom,
      dateTo,
      campos.map((c) => c.claves_origen ?? [])
    );
    // Una pregunta sin claves de origen no puede aportar nada: se declara.
    if (crudo && campos.some((c) => (c.claves_origen ?? []).length === 0)) incompleto = true;
  } catch (err) {
    console.error('[lead-answers] leads_cubo falló:', (err as Error).message);
    return { ...datasetVacio(), incompleto: true };
  }
  if (!crudo) {
    // Sin la 090: el camino anterior, con su tope de preguntas. El recorte NO
    // puede ser silencioso: las preguntas sobrantes desaparecerían con aspecto
    // de "no hay datos".
    usados = campos.slice(0, MAX_CAMPOS_POR_CARGA);
    const r = await cargarCuboAnterior(db, rtmClienteId, dateFrom, dateTo, usados, conTotales);
    crudo = r.crudo;
    incompleto = r.incompleto || campos.length > MAX_CAMPOS_POR_CARGA;
  }

  const ds = construirDataset(
    crudo,
    usados.map((campo) => ({
      campo,
      origen: origenes[campo.clave] ?? 'catalogo',
      segmentos: segmentosPorCampo[campo.clave],
    })),
    {
      campanaDeTupla: resolver
        ? (t) =>
            resolver.campaignOf({
              utm_id: t[0],
              utm_campaign: t[1],
              utm_content: t[2],
              utm_term: t[3],
              campaign_id: t[4],
              adset_id: t[5],
              ad_id: t[6],
            }).label
        : null,
      idsCampana,
      conTotales,
      incompleto,
      niveles:
        opciones.niveles && resolver
          ? {
              conjuntoDe: (t) => ({
                label: resolver.adsetOf(registroDeTupla(t)).label,
                id: t[5],
              }),
              anuncioDe: (t) => ({ label: resolver.adOf(registroDeTupla(t)).label, id: t[6] }),
            }
          : undefined,
    }
  );

  // Un dataset incompleto NO se cachea: reintentar en la siguiente carga es
  // mejor que servir un minuto entero de cifras parciales.
  if (!ds.incompleto) {
    pruneCache(now);
    datasetCache.set(key, { ds, ts: now });
  }
  return ds;
}
