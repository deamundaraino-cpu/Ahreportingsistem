/**
 * Campos de Sheet — motor puro.
 *
 * Un "campo" unifica columnas equivalentes de varias pestañas bajo un nombre
 * visible único. El caso que resuelve: la misma pregunta se llama "rango de
 * ingresos" en un formulario y "cuál es tu rango de ingresos" en otro, y sus
 * respuestas se escriben "20 a 100" en una hoja y "20-100" en la otra.
 *
 * Todo lo de aquí es puro y client-safe (sin `crypto`, sin `google-spreadsheet`,
 * sin Supabase): lo importan por igual el sync, el recálculo desde la base, la
 * UI de configuración y el motor del BI. Un solo camino de cálculo significa que
 * el número del informe y el de la vista previa no pueden divergir.
 */

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type CampoRol = 'dimension' | 'metrica' | 'ambos'
export type CampoAgg = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type CampoFormato = 'number' | 'currency' | 'percent' | 'text'
export type CampoCombinar = 'primero' | 'suma' | 'concat'
export type CampoSinMapear = 'crudo' | 'otros' | 'ignorar'

/** Bucket único de un campo numérico sin desglose: una fila por día. */
export const BUCKET_TOTAL = '(total)'
/** Cajón de sastre: valores no mapeados o excedente de cardinalidad. */
export const BUCKET_OTROS = '(otros)'

/**
 * Un origen del dato: qué pestañas y qué columnas dentro de ellas.
 * `sheet_id` y `tab_name` aceptan '*' como comodín — lo normal es
 * `{ sheet_id: 'uuid', tab_name: 'Form A', columnas: ['rango_de_ingresos'] }`.
 */
export interface CampoOrigen {
  sheet_id: string
  tab_name: string
  /** Nombres sanitizados, tal como están en `sheet_filas.valores`. */
  columnas: string[]
  /**
   * Qué hacer cuando el origen tiene varias columnas:
   *   'primero' → la primera con valor (por defecto)
   *   'suma'    → suma numérica de todas
   *   'concat'  → cada columna aporta su propio valor (la fila cuenta en varios buckets)
   */
  combinar?: CampoCombinar
}

/** { <valor crudo normalizado>: <bucket> } */
export type CampoValoresMap = Record<string, string>

export interface SheetCampoDef {
  id: string
  cliente_id: string
  /** Slug inmutable: la parte pública de los tokens guardados en informes. */
  clave: string
  /** Nombre visible en el BI, el Layout Builder y las tablas. */
  nombre: string
  descripcion?: string | null
  rol: CampoRol
  formato: CampoFormato
  agregacion: CampoAgg
  origenes: CampoOrigen[]
  valores_map: CampoValoresMap
  valores_orden: string[]
  sin_mapear: CampoSinMapear
  max_valores: number
  alta_cardinalidad: boolean
  legacy_offfield?: string | null
  activo: boolean
  orden: number
  recalculado_at?: string | null
}

export interface SheetCampoVistaDef {
  id: string
  cliente_id: string
  campo_id: string
  /** Clave del campo padre, desnormalizada para el catálogo del BI. */
  campo_clave: string
  clave: string
  nombre: string
  agregacion: CampoAgg
  operador: 'in' | 'not_in'
  valores: string[]
  formato: 'number' | 'currency' | 'percent'
  activo: boolean
  orden: number
}

/** Fila del Sheet tal cual, como se guarda y se lee de `public.sheet_filas`. */
export interface SheetRawRow {
  sheet_id: string
  tab_name: string
  fecha: string
  fila_num: number
  valores: Record<string, string>
}

/** Una fila del desglose diario por valor. */
export interface CampoValorDiario {
  campo_id: string
  fecha: string
  valor: string
  filas: number
  suma: number
  n_num: number
  minimo: number | null
  maximo: number | null
}

/** Valor crudo detectado, para la UI de agrupación. */
export interface CampoValorCrudo {
  valor_crudo: string
  valor_norm: string
  filas: number
  origenes: string[]
  ultima_fecha: string | null
}

export interface CampoCatalogo {
  campos: SheetCampoDef[]
  vistas: SheetCampoVistaDef[]
}

export interface ComputeCamposResult {
  diarios: CampoValorDiario[]
  /** Por campo_id: los valores crudos vistos, ordenados por frecuencia. */
  crudos: Map<string, CampoValorCrudo[]>
  /** Por campo_id: si superó `max_valores` y el excedente cayó en '(otros)'. */
  altaCardinalidad: Map<string, boolean>
  avisos: string[]
}

// ── Normalización ─────────────────────────────────────────────────────────────

/**
 * Forma canónica de un valor crudo para compararlo y buscarlo en `valores_map`:
 * minúsculas, sin espacios de sobra y con los guiones unicode unificados. Un
 * "20‑100" con guion de no separación y un "20-100" normal son el mismo valor
 * para cualquier persona, y nunca se escriben distinto a propósito.
 *
 * Deliberadamente NO intenta adivinar que "20 a 100" y "20-100" son lo mismo:
 * eso es una decisión de negocio y para eso está el mapa de valores.
 */
export function normalizarValorCrudo(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw)
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Nombre de columna → clave sanitizada. Es la forma en que viajan las columnas
 * en `sheet_filas.valores` y en `custom_fields`, así que `CampoOrigen.columnas`
 * usa exactamente esta misma función: si divergieran, un campo dejaría de
 * encontrar su columna sin decir por qué.
 */
export function sanitizarColumna(name: string): string {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Slug estable para la clave de un campo o una vista. */
export function slugCampo(nombre: string): string {
  return sanitizarColumna(nombre).slice(0, 60).replace(/_+$/, '')
}

/**
 * Texto de celda → número. Acepta las dos convenciones de separadores:
 *   "1.000,50" → 1000.5    "1,000.50" → 1000.5    "12,5" → 12.5
 * Devuelve null si no hay ningún número: el campo distingue "no es numérico"
 * de "es cero", cosa que un 0 por defecto haría imposible.
 */
export function parseNumeroSheet(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).replace(/[^0-9.,-]/g, '')
  if (!s || !/\d/.test(s)) return null
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))       s = s.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))  s = s.replace(/,/g, '')
  else if (/^-?\d+(,\d+)?$/.test(s))                s = s.replace(',', '.')
  else                                              s = s.replace(/,/g, '')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

/**
 * Bucket al que pertenece un valor crudo, o null si la fila no aporta nada.
 *
 * Un valor sin mapear se queda en su forma normalizada (minúsculas). Es
 * intencionado: agrupar y renombrar es justo lo que hace el agrupador de la UI,
 * y adivinar la capitalización "buena" a partir de la primera fila que llega
 * haría que el mismo dato cambiara de etiqueta según el orden del Sheet.
 */
export function bucketDeValor(campo: SheetCampoDef, crudo: unknown): string | null {
  const norm = normalizarValorCrudo(crudo)
  if (!norm) return null

  const mapeado = campo.valores_map?.[norm]
  if (mapeado) return mapeado

  if (campo.sin_mapear === 'ignorar') return null
  if (campo.sin_mapear === 'otros') return BUCKET_OTROS
  return norm
}

// ── Lectura de una fila ───────────────────────────────────────────────────────

function origenAplica(origen: CampoOrigen, fila: SheetRawRow): boolean {
  const sheetOk = !origen.sheet_id || origen.sheet_id === '*' || origen.sheet_id === fila.sheet_id
  const tabOk = !origen.tab_name || origen.tab_name === '*' ||
    normalizarValorCrudo(origen.tab_name) === normalizarValorCrudo(fila.tab_name)
  return sheetOk && tabOk
}

/**
 * Valores que la fila aporta al campo. Devuelve una lista porque un origen con
 * `combinar: 'concat'` (o varios orígenes que apliquen a la vez) puede hacer que
 * una misma fila cuente en más de un bucket.
 */
export function valoresDeCampoEnFila(campo: SheetCampoDef, fila: SheetRawRow): string[] {
  const out: string[] = []

  for (const origen of campo.origenes ?? []) {
    if (!origenAplica(origen, fila)) continue

    const brutos = (origen.columnas ?? [])
      .map(col => (fila.valores?.[col] ?? '').toString().trim())
      .filter(Boolean)
    if (brutos.length === 0) continue

    // `combinar` solo decide qué hacer cuando hay VARIAS columnas con dato: con
    // una sola el valor se toma tal cual. Aplicarlo igualmente rompía el campo en
    // silencio — un origen de una columna marcado como 'suma' convertía
    // "más_de_$4.000.000" en 4000000 y el campo dejaba de parecerse a su columna.
    if (brutos.length === 1) {
      out.push(brutos[0])
      continue
    }

    const combinar = origen.combinar ?? 'primero'
    if (combinar === 'primero') {
      out.push(brutos[0])
    } else if (combinar === 'concat') {
      out.push(...brutos)
    } else {
      // 'suma': solo tiene sentido con columnas numéricas.
      const nums = brutos.map(parseNumeroSheet).filter((n): n is number => n !== null)
      if (nums.length > 0) out.push(String(nums.reduce((a, b) => a + b, 0)))
    }
  }

  return out
}

// ── Desglose diario ───────────────────────────────────────────────────────────

interface Acc {
  campo_id: string
  fecha: string
  valor: string
  filas: number
  suma: number
  n_num: number
  minimo: number | null
  maximo: number | null
}

function accKey(campoId: string, fecha: string, valor: string) {
  return `${campoId}\u0000${fecha}\u0000${valor}`
}

function acumular(mapa: Map<string, Acc>, campoId: string, fecha: string, valor: string, n: number | null) {
  const key = accKey(campoId, fecha, valor)
  let e = mapa.get(key)
  if (!e) {
    e = { campo_id: campoId, fecha, valor, filas: 0, suma: 0, n_num: 0, minimo: null, maximo: null }
    mapa.set(key, e)
  }
  e.filas++
  if (n !== null) {
    e.suma += n
    e.n_num++
    e.minimo = e.minimo === null ? n : Math.min(e.minimo, n)
    e.maximo = e.maximo === null ? n : Math.max(e.maximo, n)
  }
}

/**
 * Convierte las filas crudas en el desglose diario por valor de cada campo.
 *
 * Es la única función que sabe calcular un campo: la usan tanto el sync como el
 * recálculo bajo demanda, así que editar un mapa de valores y volver a
 * sincronizar desde Google no pueden dar resultados distintos.
 *
 * `suma` y `n_num` se guardan por separado para que un promedio agregue bien a
 * cualquier grano (`sum(suma)/sum(n_num)`), en vez del promedio de promedios que
 * sale de guardar el promedio ya resuelto.
 */
export function computeCampoValoresDiarios(
  filas: SheetRawRow[],
  campos: SheetCampoDef[]
): ComputeCamposResult {
  const acc = new Map<string, Acc>()
  const crudosPorCampo = new Map<string, Map<string, CampoValorCrudo>>()
  const altaCardinalidad = new Map<string, boolean>()
  const avisos: string[] = []

  const activos = campos.filter(c => c.activo !== false)

  for (const campo of activos) {
    if (!campo.origenes || campo.origenes.length === 0) {
      avisos.push(`El campo "${campo.nombre}" no tiene ninguna pestaña ni columna asignada.`)
    }
    crudosPorCampo.set(campo.id, new Map())
  }

  for (const fila of filas) {
    if (!fila?.fecha) continue

    for (const campo of activos) {
      const valores = valoresDeCampoEnFila(campo, fila)
      if (valores.length === 0) continue

      const catalogo = crudosPorCampo.get(campo.id)!
      const origen = fila.tab_name || '(primera pestaña)'

      for (const crudo of valores) {
        const bucket = bucketDeValor(campo, crudo)

        // El catálogo registra el valor aunque el bucket se ignore: la UI tiene
        // que poder ver lo que hay para decidir cómo agruparlo.
        const norm = normalizarValorCrudo(crudo)
        let cat = catalogo.get(norm)
        if (!cat) {
          cat = { valor_crudo: crudo.trim(), valor_norm: bucket ?? '', filas: 0, origenes: [], ultima_fecha: null }
          catalogo.set(norm, cat)
        }
        cat.filas++
        cat.valor_norm = bucket ?? ''
        if (!cat.origenes.includes(origen)) cat.origenes.push(origen)
        if (!cat.ultima_fecha || fila.fecha > cat.ultima_fecha) cat.ultima_fecha = fila.fecha

        if (bucket === null) continue
        acumular(acc, campo.id, fila.fecha, bucket, parseNumeroSheet(crudo))
      }
    }
  }

  let diarios = Array.from(acc.values())

  // Cardinalidad: un campo con demasiados buckets distintos (un email, un id)
  // no sirve como dimensión y llenaría la tabla. Se conservan los más
  // frecuentes y el resto se pliega en '(otros)', sin perder los totales.
  for (const campo of activos) {
    const delCampo = diarios.filter(d => d.campo_id === campo.id)
    const totalPorBucket = new Map<string, number>()
    for (const d of delCampo) totalPorBucket.set(d.valor, (totalPorBucket.get(d.valor) ?? 0) + d.filas)

    const limite = campo.max_valores > 0 ? campo.max_valores : 200
    if (totalPorBucket.size <= limite) {
      altaCardinalidad.set(campo.id, false)
      continue
    }

    altaCardinalidad.set(campo.id, true)
    avisos.push(
      `El campo "${campo.nombre}" tiene ${totalPorBucket.size} valores distintos (tope ${limite}): ` +
      `se conservan los ${limite} más frecuentes y el resto se agrupa en "${BUCKET_OTROS}". ` +
      'Deja de ofrecerse como dimensión.'
    )

    const conservados = new Set(
      Array.from(totalPorBucket.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limite)
        .map(([v]) => v)
    )

    const replegado = new Map<string, Acc>()
    for (const d of delCampo) {
      const valor = conservados.has(d.valor) ? d.valor : BUCKET_OTROS
      const key = accKey(d.campo_id, d.fecha, valor)
      const e = replegado.get(key)
      if (!e) {
        replegado.set(key, { ...d, valor })
      } else {
        e.filas += d.filas
        e.suma += d.suma
        e.n_num += d.n_num
        if (d.minimo !== null) e.minimo = e.minimo === null ? d.minimo : Math.min(e.minimo, d.minimo)
        if (d.maximo !== null) e.maximo = e.maximo === null ? d.maximo : Math.max(e.maximo, d.maximo)
      }
    }

    diarios = diarios.filter(d => d.campo_id !== campo.id).concat(Array.from(replegado.values()))
  }

  const crudos = new Map<string, CampoValorCrudo[]>()
  for (const [campoId, mapa] of crudosPorCampo) {
    crudos.set(campoId, Array.from(mapa.values()).sort((a, b) => b.filas - a.filas))
  }

  diarios.sort((a, b) =>
    a.campo_id.localeCompare(b.campo_id) || a.fecha.localeCompare(b.fecha) || a.valor.localeCompare(b.valor))

  return { diarios, crudos, altaCardinalidad, avisos }
}

// ── Agregación y vistas ───────────────────────────────────────────────────────

/**
 * Colapsa un conjunto de filas del desglose en un solo número.
 * `avg` sale de `sum(suma)/sum(n_num)`: correcto a cualquier grano, a diferencia
 * de promediar promedios ya resueltos.
 */
export function agregarDiarios(rows: CampoValorDiario[], agg: CampoAgg): number {
  if (rows.length === 0) return 0
  switch (agg) {
    case 'count':
      return rows.reduce((s, r) => s + r.filas, 0)
    case 'sum':
      return rows.reduce((s, r) => s + r.suma, 0)
    case 'avg': {
      const n = rows.reduce((s, r) => s + r.n_num, 0)
      return n > 0 ? rows.reduce((s, r) => s + r.suma, 0) / n : 0
    }
    case 'min': {
      const vals = rows.map(r => r.minimo).filter((v): v is number => v !== null)
      return vals.length > 0 ? Math.min(...vals) : 0
    }
    case 'max': {
      const vals = rows.map(r => r.maximo).filter((v): v is number => v !== null)
      return vals.length > 0 ? Math.max(...vals) : 0
    }
  }
}

/** `count` y `sum` se pueden sumar entre días; los promedios y extremos no. */
export function esAgregacionAditiva(agg: CampoAgg): boolean {
  return agg === 'count' || agg === 'sum'
}

/** ¿El bucket pasa el filtro de la vista? */
export function vistaIncluyeValor(vista: SheetCampoVistaDef, valor: string): boolean {
  const dentro = vista.valores.includes(valor)
  return vista.operador === 'not_in' ? !dentro : dentro
}

/**
 * Evalúa una vista guardada ("Leads 20-100") sobre el desglose diario: el total
 * del periodo y el valor de cada día, que es lo que alimenta las series.
 */
export function evaluarVista(
  vista: SheetCampoVistaDef,
  diarios: CampoValorDiario[]
): { total: number; porFecha: Map<string, number> } {
  const propias = diarios.filter(d => d.campo_id === vista.campo_id && vistaIncluyeValor(vista, d.valor))

  const porFecha = new Map<string, number>()
  const agrupado = new Map<string, CampoValorDiario[]>()
  for (const d of propias) {
    const lista = agrupado.get(d.fecha)
    if (lista) lista.push(d)
    else agrupado.set(d.fecha, [d])
  }
  for (const [fecha, rows] of agrupado) porFecha.set(fecha, agregarDiarios(rows, vista.agregacion))

  return { total: agregarDiarios(propias, vista.agregacion), porFecha }
}

// ── Claves planas para el dashboard clásico ───────────────────────────────────

/** Prefijo de un campo en las fórmulas del dashboard clásico. */
export const CAMPO_FLAT_PREFIX = 'sf_'
/** Prefijo de una vista guardada. */
export const VISTA_FLAT_PREFIX = 'sv_'

// Sufijos internos: los sumandos que permiten reagregar una métrica que no se
// puede sumar entre días. Son seguros por construcción — `sanitizarColumna`
// colapsa cualquier racha de símbolos en UN solo `_`, así que ninguna clave de
// campo puede contener `__` y no hay forma de que choquen.
export const SUFIJO_NUM = '__num'
export const SUFIJO_DEN = '__den'
export const SUFIJO_MIN = '__min'
export const SUFIJO_MAX = '__max'

/**
 * Claves planas de UN día para el dashboard clásico.
 *
 * Devuelve `sf_<clave>` (el campo con su agregación) y `sv_<clave>` (cada vista)
 * y, **solo cuando esa agregación no es aditiva**, los sumandos que permiten
 * reagregarla a semana o mes sin inventar un número.
 *
 * El porqué: el motor de fórmulas del dashboard suma toda clave numérica de la
 * fila al agrupar por periodo. Para un conteo o una suma eso es correcto; para
 * un promedio no —tres días de 30, 32 y 28 darían 90—. Llevando el numerador y
 * el denominador dentro de la propia fila, la reagregación sale bien sin que
 * ningún componente tenga que enterarse de nada.
 */
export function clavesPlanasDelDia(
  campo: SheetCampoDef,
  vistas: SheetCampoVistaDef[],
  filasDelDia: CampoValorDiario[]
): Record<string, number> {
  const out: Record<string, number> = {}

  const anotar = (clave: string, agg: CampoAgg, filas: CampoValorDiario[]) => {
    out[clave] = agregarDiarios(filas, agg)
    if (esAgregacionAditiva(agg)) return

    if (agg === 'avg') {
      // El promedio se reconstruye como Σnumerador / Σdenominador, que es lo
      // mismo que hace el BI y lo único correcto a cualquier grano.
      out[clave + SUFIJO_NUM] = filas.reduce((s, f) => s + f.suma, 0)
      out[clave + SUFIJO_DEN] = filas.reduce((s, f) => s + f.n_num, 0)
    } else if (agg === 'min') {
      out[clave + SUFIJO_MIN] = out[clave]
    } else if (agg === 'max') {
      out[clave + SUFIJO_MAX] = out[clave]
    }
  }

  anotar(CAMPO_FLAT_PREFIX + campo.clave, campo.agregacion, filasDelDia)

  for (const vista of vistas) {
    if (vista.campo_id !== campo.id) continue
    anotar(
      VISTA_FLAT_PREFIX + vista.clave,
      vista.agregacion,
      filasDelDia.filter(f => vistaIncluyeValor(vista, f.valor))
    )
  }

  return out
}

// ── Ayuda para el agrupador de la UI ──────────────────────────────────────────

/**
 * Firma agresiva de un valor, para proponer agrupaciones automáticas: quita todo
 * lo que no sea alfanumérico y trata la "a" de los rangos como un separador, de
 * modo que "20 a 100", "20-100" y "20a100" caen juntos.
 *
 * Es solo una SUGERENCIA para el botón "Auto-agrupar": lo que manda siempre es
 * el `valores_map` que confirma el analista.
 */
export function firmaDeValor(raw: unknown): string {
  return normalizarValorCrudo(raw)
    // La "a" solo se trata como separador entre dígitos ("20 a 100", "20a100"):
    // exigir los números a ambos lados evita destrozar palabras como "casa".
    .replace(/(\d)\s*a\s*(\d)/g, '$1-$2')
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Agrupa valores crudos por su firma y propone un bucket por grupo (el valor más
 * frecuente del grupo, que suele ser el mejor escrito). Devuelve un mapa listo
 * para fusionar con `valores_map`.
 */
export function sugerirAgrupacion(valores: CampoValorCrudo[]): CampoValoresMap {
  const porFirma = new Map<string, CampoValorCrudo[]>()
  for (const v of valores) {
    const f = firmaDeValor(v.valor_crudo)
    if (!f) continue
    const lista = porFirma.get(f)
    if (lista) lista.push(v)
    else porFirma.set(f, [v])
  }

  const out: CampoValoresMap = {}
  for (const grupo of porFirma.values()) {
    if (grupo.length < 2) continue   // sin variantes no hay nada que agrupar
    const bucket = grupo.slice().sort((a, b) => b.filas - a.filas)[0].valor_crudo.trim()
    for (const v of grupo) out[normalizarValorCrudo(v.valor_crudo)] = bucket
  }
  return out
}
