/**
 * Campos de Sheet — lectura y escritura en base.
 *
 * Esta capa es fina a propósito: pagina `public.sheet_filas`, llama a la función
 * pura `computeCampoValoresDiarios` y guarda el resultado. Todo el cálculo vive
 * en `./campos.ts`, así que el recálculo bajo demanda y el del sync diario no
 * pueden dar números distintos.
 *
 * Lo importante del diseño: **el recálculo nunca llama a Google**. Lee de la
 * capa cruda que dejó el sync, así que editar el mapa de valores de un campo y
 * ver el resultado es cuestión de un segundo, no de esperar al cron.
 */

import { fetchAllRows } from '@/lib/supabase-paginate'
import {
  computeCampoValoresDiarios,
  sanitizarColumna,
} from './campos'
import type {
  SheetCampoDef, SheetCampoVistaDef, SheetRawRow,
  CampoValorCrudo, CampoCatalogo, CampoOrigen,
} from './campos'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Tope de valores crudos que se guardan por campo para la UI de agrupación. */
const MAX_VALORES_CATALOGO = 1000

/** Mensaje típico de PostgREST cuando falta la migración 058. */
function esTablaAusente(error: any): boolean {
  const msg = String(error?.message ?? '')
  return error?.code === '42P01' || /does not exist|schema cache/i.test(msg)
}

function toCampo(row: any): SheetCampoDef {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    clave: row.clave,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    rol: row.rol,
    formato: row.formato,
    agregacion: row.agregacion,
    origenes: Array.isArray(row.origenes) ? (row.origenes as CampoOrigen[]) : [],
    valores_map: row.valores_map ?? {},
    valores_orden: row.valores_orden ?? [],
    sin_mapear: row.sin_mapear,
    max_valores: row.max_valores ?? 200,
    alta_cardinalidad: !!row.alta_cardinalidad,
    legacy_offfield: row.legacy_offfield ?? null,
    activo: row.activo !== false,
    orden: row.orden ?? 0,
    recalculado_at: row.recalculado_at ?? null,
  }
}

function toVista(row: any, campoClave: string): SheetCampoVistaDef {
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    campo_id: row.campo_id,
    campo_clave: campoClave,
    clave: row.clave,
    nombre: row.nombre,
    agregacion: row.agregacion,
    operador: row.operador,
    valores: row.valores ?? [],
    formato: row.formato,
    activo: row.activo !== false,
    orden: row.orden ?? 0,
  }
}

/**
 * Campos y vistas de un cliente. Si la migración 058 todavía no está aplicada
 * devuelve un catálogo vacío en vez de lanzar: el resto de la plataforma tiene
 * que seguir funcionando exactamente igual que antes de esta feature.
 */
export async function loadCamposCliente(
  db: any,
  clienteId: string,
  opts?: { soloActivos?: boolean }
): Promise<CampoCatalogo> {
  let q = db.from('sheet_campos').select('*').eq('cliente_id', clienteId)
  if (opts?.soloActivos) q = q.eq('activo', true)

  const { data: campoRows, error } = await q.order('orden', { ascending: true })
  if (error) {
    if (!esTablaAusente(error)) console.error('[sheet-campos] error leyendo campos:', error.message)
    return { campos: [], vistas: [] }
  }

  const campos = ((campoRows ?? []) as any[]).map(toCampo)
  if (campos.length === 0) return { campos: [], vistas: [] }

  const clavePorId = new Map(campos.map(c => [c.id, c.clave]))

  let vq = db.from('sheet_campo_vistas').select('*').eq('cliente_id', clienteId)
  if (opts?.soloActivos) vq = vq.eq('activo', true)
  const { data: vistaRows } = await vq.order('orden', { ascending: true })

  const vistas = ((vistaRows ?? []) as any[])
    .filter(v => clavePorId.has(v.campo_id))
    .map(v => toVista(v, clavePorId.get(v.campo_id)!))

  return { campos, vistas }
}

/** Filas crudas del cliente en un rango, paginadas por keyset. */
async function leerFilasCrudas(
  db: any,
  clienteId: string,
  desde?: string,
  hasta?: string
): Promise<SheetRawRow[]> {
  const rows = await fetchAllRows(() => {
    let q = db.from('sheet_filas')
      .select('id, sheet_id, tab_name, fecha, fila_num, valores')
      .eq('cliente_id', clienteId)
    if (desde) q = q.gte('fecha', desde)
    if (hasta) q = q.lte('fecha', hasta)
    return q
  })

  return rows.map(r => ({
    sheet_id: String(r.sheet_id ?? ''),
    tab_name: String(r.tab_name ?? ''),
    fecha: String(r.fecha ?? '').slice(0, 10),
    fila_num: Number(r.fila_num ?? 0),
    valores: (r.valores ?? {}) as Record<string, string>,
  }))
}

export interface RecalculoResult {
  campos: number
  dias: number
  valores: number
  avisos: string[]
  error?: string
}

/**
 * Recalcula el desglose diario de uno o todos los campos de un cliente leyendo
 * SOLO de `public.sheet_filas`.
 *
 * El reemplazo es **por campo** (y por rango, si se pide): editar un campo no
 * toca los demás. A diferencia del sync, aquí no hace falta el baile del
 * `sync_batch_id`: el desglose es 100% derivable de la capa cruda, así que si
 * algo falla a mitad basta con volver a lanzarlo. Se borra e inserta seguido
 * para que la ventana en la que el campo está vacío sea de milisegundos.
 */
export async function recalcularCamposCliente(
  db: any,
  clienteId: string,
  opts?: { campoIds?: string[]; desde?: string; hasta?: string }
): Promise<RecalculoResult> {
  const vacio: RecalculoResult = { campos: 0, dias: 0, valores: 0, avisos: [] }

  const { campos: todos } = await loadCamposCliente(db, clienteId, { soloActivos: true })
  const campos = opts?.campoIds?.length
    ? todos.filter(c => opts.campoIds!.includes(c.id))
    : todos
  if (campos.length === 0) return vacio

  const filas = await leerFilasCrudas(db, clienteId, opts?.desde, opts?.hasta)
  if (filas.length === 0) {
    vacio.avisos.push(
      'No hay filas sincronizadas todavía: ejecuta un sync del Sheet antes de calcular los campos.'
    )
  }

  const { diarios, crudos, altaCardinalidad, avisos } = computeCampoValoresDiarios(filas, campos)

  const fechas = new Set<string>()
  const valores = new Set<string>()
  const ahora = new Date().toISOString()

  for (const campo of campos) {
    const propias = diarios.filter(d => d.campo_id === campo.id)
    for (const d of propias) { fechas.add(d.fecha); valores.add(`${d.campo_id}|${d.valor}`) }

    // ── Desglose diario ──────────────────────────────────────────────────
    let del = db.from('sheet_campo_valores_diarios').delete().eq('campo_id', campo.id)
    if (opts?.desde) del = del.gte('fecha', opts.desde)
    if (opts?.hasta) del = del.lte('fecha', opts.hasta)
    const { error: delErr } = await del
    if (delErr) {
      if (esTablaAusente(delErr)) {
        return { ...vacio, error: 'Faltan las tablas de campos de Sheet (migración 058).' }
      }
      return { ...vacio, error: `No se pudo limpiar el desglose: ${delErr.message}` }
    }

    if (propias.length > 0) {
      const toInsert = propias.map(d => ({
        cliente_id: clienteId, campo_id: d.campo_id, fecha: d.fecha, valor: d.valor,
        filas: d.filas, suma: d.suma, n_num: d.n_num, minimo: d.minimo, maximo: d.maximo,
      }))
      for (let i = 0; i < toInsert.length; i += 500) {
        const { error } = await db.from('sheet_campo_valores_diarios').insert(toInsert.slice(i, i + 500))
        if (error) return { ...vacio, error: `No se pudo guardar el desglose: ${error.message}` }
      }
    }

    // ── Catálogo de valores crudos (alimenta el agrupador de la UI) ───────
    // Solo se reescribe en un recálculo completo: con un rango parcial el
    // catálogo quedaría recortado a ese periodo y la UI perdería valores que
    // sí existen fuera de él.
    if (!opts?.desde && !opts?.hasta) {
      await db.from('sheet_campo_valores').delete().eq('campo_id', campo.id)
      const lista = (crudos.get(campo.id) ?? []).slice(0, MAX_VALORES_CATALOGO)
      if (lista.length > 0) {
        const toInsert = lista.map(v => ({
          cliente_id: clienteId, campo_id: campo.id,
          valor_crudo: v.valor_crudo, valor_norm: v.valor_norm,
          filas: v.filas, origenes: v.origenes, ultima_fecha: v.ultima_fecha,
        }))
        for (let i = 0; i < toInsert.length; i += 500) {
          await db.from('sheet_campo_valores').insert(toInsert.slice(i, i + 500))
        }
      }
    }

    await db.from('sheet_campos').update({
      recalculado_at: ahora,
      alta_cardinalidad: altaCardinalidad.get(campo.id) ?? false,
    }).eq('id', campo.id)
  }

  return { campos: campos.length, dias: fechas.size, valores: valores.size, avisos }
}

/** Valores crudos de un campo, para la UI de agrupación. */
export async function listarValoresCrudos(
  db: any,
  clienteId: string,
  campoId: string,
  limite = 500
): Promise<{ valores: CampoValorCrudo[]; totalDistintos: number }> {
  const { data, error, count } = await db.from('sheet_campo_valores')
    .select('valor_crudo, valor_norm, filas, origenes, ultima_fecha', { count: 'exact' })
    .eq('cliente_id', clienteId).eq('campo_id', campoId)
    .order('filas', { ascending: false })
    .limit(limite)

  if (error) return { valores: [], totalDistintos: 0 }

  const valores = ((data ?? []) as any[]).map(v => ({
    valor_crudo: v.valor_crudo,
    valor_norm: v.valor_norm ?? '',
    filas: v.filas ?? 0,
    origenes: v.origenes ?? [],
    ultima_fecha: v.ultima_fecha ?? null,
  }))

  return { valores, totalDistintos: count ?? valores.length }
}

export interface FuenteColumnas {
  sheet_id: string
  tab_name: string
  columnas: string[]
  /** Hasta 3 valores de ejemplo por columna, para reconocerla de un vistazo. */
  muestras: Record<string, string[]>
  filas: number
  /**
   * Por qué la pestaña no tiene columnas que ofrecer, cuando es el caso. Se
   * muestra en vez de omitirla: una pestaña que desaparece del selector sin
   * explicación parece un fallo de la app, cuando el problema suele estar en el
   * mapeo del Sheet (columna de fecha mal escrita, por ejemplo).
   */
  aviso?: string
}

/**
 * Pestañas que tienen filas sincronizadas, sacadas del log de sync.
 *
 * El log guarda el título REAL de cada pestaña leída (`sheet.title`), que es
 * exactamente lo que se graba en `sheet_filas.tab_name`. Sirve de índice: sin él
 * habría que recorrer `sheet_filas` entera solo para saber qué pestañas existen.
 */
interface PestanaSync {
  sheet_id: string
  tab_name: string
  /** Avisos del último sync de esa pestaña (columna ausente, filas descartadas…). */
  warnings: string[]
}

async function pestanasSincronizadas(db: any, clienteId: string): Promise<PestanaSync[]> {
  const { data, error } = await db.from('conversiones_offline_sync_log')
    .select('sheet_id, run_at, detalle')
    .eq('cliente_id', clienteId)
    .order('run_at', { ascending: false })
    .limit(200)

  if (error || !data) return []

  // Los logs vienen del más reciente al más antiguo, así que la primera vez que
  // se ve una pestaña es su último sync: es el estado que interesa.
  const pares = new Map<string, PestanaSync>()
  for (const log of data as any[]) {
    const sheetId = String(log.sheet_id ?? '')
    for (const q of (log.detalle?.por_pestana ?? []) as any[]) {
      const tabName = String(q?.tab_name ?? '')
      if (!sheetId || !tabName) continue
      const key = `${sheetId} ${tabName}`
      if (pares.has(key)) continue
      pares.set(key, {
        sheet_id: sheetId,
        tab_name: tabName,
        warnings: Array.isArray(q?.warnings) ? q.warnings.map(String) : [],
      })
    }
  }
  return Array.from(pares.values())
}

/** Deriva columnas y valores de ejemplo de un puñado de filas. */
function columnasDeFilas(sheetId: string, tabName: string, filas: any[]): FuenteColumnas {
  const fuente: FuenteColumnas = {
    sheet_id: sheetId, tab_name: tabName, columnas: [], muestras: {}, filas: 0,
  }

  for (const row of filas) {
    fuente.filas++
    for (const [col, val] of Object.entries((row.valores ?? {}) as Record<string, string>)) {
      if (!fuente.muestras[col]) {
        fuente.muestras[col] = []
        fuente.columnas.push(col)
      }
      const texto = String(val ?? '').trim()
      if (texto && fuente.muestras[col].length < 3 && !fuente.muestras[col].includes(texto)) {
        fuente.muestras[col].push(texto)
      }
    }
  }

  fuente.columnas.sort()
  return fuente
}

/**
 * Columnas disponibles por sheet y pestaña, derivadas de `sheet_filas`. No llama
 * a Google: es lo que puebla el selector de "qué columna es este campo en cada
 * pestaña", y tiene que abrirse al instante.
 *
 * Se muestrea **por pestaña**, no sobre el cliente entero. Antes se leían las N
 * filas más recientes de todo el cliente y se agrupaban después: la pestaña con
 * los datos más nuevos se comía la muestra completa y las demás no llegaban a
 * aparecer en el selector, aunque estuvieran sincronizadas.
 */
export async function listarColumnasDisponibles(
  db: any,
  clienteId: string,
  muestraPorPestana = 300
): Promise<FuenteColumnas[]> {
  const ordenar = (a: FuenteColumnas, b: FuenteColumnas) =>
    a.sheet_id.localeCompare(b.sheet_id) || a.tab_name.localeCompare(b.tab_name)

  const pares = await pestanasSincronizadas(db, clienteId)

  // Sin log utilizable (nunca se sincronizó con esta versión) se cae al muestreo
  // global: incompleto, pero mejor que un selector vacío.
  if (pares.length === 0) {
    const { data } = await db.from('sheet_filas')
      .select('sheet_id, tab_name, valores')
      .eq('cliente_id', clienteId)
      .order('fecha', { ascending: false })
      .limit(1500)

    const porFuente = new Map<string, any[]>()
    for (const row of (data ?? []) as any[]) {
      const key = `${row.sheet_id ?? ''}\u0000${row.tab_name ?? ''}`
      const lista = porFuente.get(key)
      if (lista) lista.push(row)
      else porFuente.set(key, [row])
    }
    return Array.from(porFuente.entries())
      .map(([key, filas]) => {
        const [sheetId, tabName] = key.split('\u0000')
        return columnasDeFilas(sheetId, tabName, filas)
      })
      .filter(f => f.columnas.length > 0)
      .sort(ordenar)
  }

  // Una consulta acotada POR pestaña. Son pocas (una por hoja del documento) y
  // así cada una aporta sus columnas aunque otra tenga mil veces más filas.
  const fuentes = await Promise.all(pares.map(async ({ sheet_id, tab_name, warnings }) => {
    const { data } = await db.from('sheet_filas')
      .select('valores')
      .eq('cliente_id', clienteId)
      .eq('sheet_id', sheet_id)
      .eq('tab_name', tab_name)
      .order('fecha', { ascending: false })
      .limit(muestraPorPestana)

    const fuente = columnasDeFilas(sheet_id, tab_name, (data ?? []) as any[])

    // Una pestaña sin columnas se devuelve igualmente, con el motivo del último
    // sync. Omitirla la hacía desaparecer del selector sin decir por qué, que es
    // justo cuando hace falta saberlo.
    if (fuente.columnas.length === 0) {
      fuente.aviso = warnings[0]
        ?? 'No importó ninguna fila en el último sync. Revisa el mapeo de la pestaña.'
    }
    return fuente
  }))

  return fuentes.sort(ordenar)
}

/**
 * Normaliza lo que llega del formulario antes de guardarlo: las columnas de los
 * orígenes tienen que estar sanitizadas igual que las claves de
 * `sheet_filas.valores`, o el campo no encontraría su dato.
 */
export function normalizarOrigenes(origenes: unknown): CampoOrigen[] {
  if (!Array.isArray(origenes)) return []
  return origenes
    .map((o: any) => ({
      sheet_id: String(o?.sheet_id ?? '*'),
      tab_name: String(o?.tab_name ?? '*'),
      columnas: Array.isArray(o?.columnas)
        ? Array.from(new Set(o.columnas.map((c: unknown) => sanitizarColumna(String(c))).filter(Boolean))) as string[]
        : [],
      combinar: (['primero', 'suma', 'concat'].includes(o?.combinar) ? o.combinar : 'primero') as CampoOrigen['combinar'],
    }))
    .filter(o => o.columnas.length > 0)
}
