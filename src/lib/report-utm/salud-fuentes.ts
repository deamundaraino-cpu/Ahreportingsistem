/**
 * Salud de las fuentes de datos, por cliente.
 *
 * ── Qué problema resuelve ────────────────────────────────────────────────
 * Un informe con una fuente muerta NO se ve roto: se ve vacío. Esa es la razón
 * de que estos tres fallos convivieran semanas sin que saltara nada:
 *
 *   · Meta Lead Ads de un cliente en estado de error desde hacía siete semanas,
 *     mientras sus leads seguían entrando por el píxel y el informe parecía lleno.
 *   · Un cliente ingiriendo la pestaña de Sheet de OTRO cliente.
 *   · Un cliente sin el enlace `public_cliente_id`, que deja el gasto, GA4,
 *     Hotmart, offline y los Sheets invisibles devolviendo cero en silencio.
 *
 * ── Por qué la evaluación es pura ────────────────────────────────────────
 * Recoger las señales necesita la base; decidir si algo está mal, no. Separarlo
 * permite comprobar las reglas —incluidas las que no se disparan hoy con ningún
 * cliente— sin depender de que la producción tenga un caso roto a mano.
 */

/** Gravedad, ordenada: lo que se muestra primero. */
export type Gravedad = 'critico' | 'aviso' | 'ok' | 'no_aplica'

export const ORDEN_GRAVEDAD: Record<Gravedad, number> = {
    critico: 0, aviso: 1, ok: 2, no_aplica: 3,
}

/** Señales crudas de un cliente. Todo lo que la evaluación necesita saber. */
export interface SenalesCliente {
    clienteId: string
    nombre: string
    /** El puente `report_utm.clientes.public_cliente_id`. */
    tienePuente: boolean
    /** Hoy, en día calendario de Colombia (`YYYY-MM-DD`). */
    hoy: string
    fuentes: SenalFuente[]
    integraciones: SenalIntegracion[]
    /** % de leads del período atados a una campaña real, o null si no hay leads. */
    pctLeadsCruzados: number | null
    /** Filas de Sheet cuyo id de campaña no cruza con ningún anuncio del cliente. */
    sheetFilasAjenas?: { total: number; sinCruce: number } | null
}

/**
 * Estado de lectura de una fuente.
 *
 * `desconocida` existe porque la alternativa es mentir. La primera versión de
 * este módulo trataba un error de consulta como «sin datos», y con eso un
 * cliente con 34.745 leads aparecía como «configurada pero sin un solo dato»:
 * el `count` exacto agotaba el `statement_timeout` y el error se tragaba. Un
 * panel de salud que inventa un fallo es peor que no tener panel.
 *
 * Misma doctrina que el resto de la plataforma: donde no se puede saber, se dice
 * que no se puede saber.
 */
export type EstadoFuente = 'con_datos' | 'vacia' | 'desconocida'

export interface SenalFuente {
    /** `leads` | `sales` | `ads` | `cuenta` | `offline` | `sheet` | `subs` */
    id: string
    label: string
    /** Última fecha con datos (`YYYY-MM-DD`), o null si no hay ninguno. */
    ultimaFecha: string | null
    estado: EstadoFuente
    /**
     * Días sin datos a partir de los cuales se considera parada.
     * Una fuente diaria (gasto) debería tener ayer; un Sheet que se vuelca a
     * mano tolera más. Sin este número por fuente, o se avisa en falso o no se
     * avisa nunca.
     */
    toleranciaDias: number
    /** `false` si el cliente ni siquiera tiene esta integración configurada. */
    configurada: boolean
    /** Necesita el puente para ser legible. */
    requierePuente: boolean
}

export interface SenalIntegracion {
    tipo: string
    status: string
    ultimoError: string | null
    /** Última sincronización correcta (ISO), o null. */
    ultimoSync: string | null
}

/** Un problema concreto, ya redactado para que se pueda actuar sobre él. */
export interface Hallazgo {
    gravedad: Gravedad
    /** Fuente o integración a la que apunta. */
    ambito: string
    titulo: string
    /** Qué hacer. Vacío si no hay una acción clara. */
    accion?: string
}

export interface SaludCliente {
    clienteId: string
    nombre: string
    gravedad: Gravedad
    hallazgos: Hallazgo[]
}

/** Días completos entre dos fechas `YYYY-MM-DD`. */
export function diasEntre(desde: string, hasta: string): number {
    const a = Date.parse(`${desde}T00:00:00Z`)
    const b = Date.parse(`${hasta}T00:00:00Z`)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
    return Math.round((b - a) / 86400_000)
}

/**
 * Umbral por debajo del cual el cruce UTM↔campaña se considera roto.
 *
 * 50 % es deliberadamente permisivo: por debajo de eso la mitad del gasto no
 * tiene contactos atribuidos y ningún CPL por campaña significa nada. Los
 * clientes sanos medidos hoy están entre el 67 % y el 100 %, así que el umbral
 * no genera ruido; avisa cuando algo se ha degradado de verdad.
 */
export const UMBRAL_CRUCE = 50

/** Proporción de filas de Sheet sin cruce que delata un Sheet equivocado. */
const UMBRAL_SHEET_AJENO = 0.9

export function evaluarCliente(s: SenalesCliente): SaludCliente {
    const hallazgos: Hallazgo[] = []

    // ── El puente: la causa declarada de los ceros en silencio ───────
    // Va primero porque explica de golpe casi todo lo demás: sin él, cinco de
    // las siete fuentes son invisibles y el informe muestra cero sin decir nada.
    if (!s.tienePuente) {
        hallazgos.push({
            gravedad: 'critico',
            ambito: 'Enlace de cliente',
            titulo: 'Sin enlace con el cliente de Reporting: gasto, GA4, Hotmart, offline y Sheets son invisibles.',
            accion: 'Enlazar el cliente en /report-utm/clientes para que el informe pueda leer esas fuentes.',
        })
    }

    // ── Integraciones en error ───────────────────────────────────────
    for (const i of s.integraciones) {
        if (i.status !== 'error') continue
        const dias = i.ultimoSync
            ? diasEntre(String(i.ultimoSync).slice(0, 10), s.hoy)
            : null
        hallazgos.push({
            gravedad: 'critico',
            ambito: `Integración · ${i.tipo}`,
            titulo: dias !== null && dias > 0
                ? `En error desde hace ${dias} día(s): ${i.ultimoError ?? 'sin detalle'}`
                : `En error: ${i.ultimoError ?? 'sin detalle'}`,
            accion: 'Reconectar la integración desde /report-utm/integraciones.',
        })
    }

    // ── Fuentes paradas o vacías ─────────────────────────────────────
    for (const f of s.fuentes) {
        // Una fuente que el cliente no usa no es un problema: decirlo sería
        // llenar el panel de ruido que nadie va a arreglar nunca.
        if (!f.configurada) continue

        // Sin puente ya se ha avisado arriba; repetirlo por cada fuente
        // convertiría un problema en cinco.
        if (f.requierePuente && !s.tienePuente) continue

        // No se pudo leer: se dice, y no se juzga. Presentarlo como «vacía»
        // convertiría un fallo de consulta en un fallo de integración inexistente.
        if (f.estado === 'desconocida') {
            hallazgos.push({
                gravedad: 'aviso',
                ambito: `Fuente · ${f.label}`,
                titulo: 'No se pudo comprobar el estado de esta fuente.',
                accion: 'Reintentar; si persiste, la consulta está agotando el tiempo límite.',
            })
            continue
        }

        if (f.estado === 'vacia' || !f.ultimaFecha) {
            hallazgos.push({
                gravedad: 'critico',
                ambito: `Fuente · ${f.label}`,
                titulo: 'Configurada pero sin un solo dato.',
                accion: 'Revisar la conexión: está dada de alta pero nunca ha entregado.',
            })
            continue
        }

        const dias = diasEntre(f.ultimaFecha, s.hoy)
        if (dias > f.toleranciaDias) {
            hallazgos.push({
                gravedad: dias > f.toleranciaDias * 3 ? 'critico' : 'aviso',
                ambito: `Fuente · ${f.label}`,
                titulo: `Sin datos nuevos desde hace ${dias} día(s) (último: ${f.ultimaFecha}).`,
                accion: 'Comprobar el sync de esta fuente.',
            })
        }
    }

    // ── Calidad del cruce ────────────────────────────────────────────
    // Es la métrica de la que depende todo lo demás: si los leads dejan de
    // atarse a su campaña, cada CPL y cada ROAS por campaña queda sin sentido, y
    // nada más en la plataforma lo vigila.
    if (s.pctLeadsCruzados !== null && s.pctLeadsCruzados < UMBRAL_CRUCE) {
        hallazgos.push({
            gravedad: 'aviso',
            ambito: 'Cruce UTM ↔ campaña',
            titulo: `Solo el ${s.pctLeadsCruzados.toFixed(1)} % de los leads se ata a una campaña real.`,
            accion: 'Revisar /report-utm/cruce-campanas y añadir correcciones manuales donde falte.',
        })
    }

    // ── Sheet de otro cliente ────────────────────────────────────────
    // Un Sheet propio cruza casi entero; uno ajeno no cruza nada. El caso real
    // que motivó esta regla: un cliente ingiriendo la pestaña de otro, con sus
    // 2.105 «leads offline» pertenecientes a un tercero.
    const sh = s.sheetFilasAjenas
    if (sh && sh.total >= 50 && sh.sinCruce / sh.total >= UMBRAL_SHEET_AJENO) {
        hallazgos.push({
            gravedad: 'critico',
            ambito: 'Fuente · Sheet',
            titulo: `${sh.sinCruce} de ${sh.total} filas no cruzan con ninguna campaña de este cliente: el Sheet podría ser de otro.`,
            accion: 'Comprobar qué documento está conectado en la configuración del cliente.',
        })
    }

    const gravedad: Gravedad = hallazgos.some(h => h.gravedad === 'critico')
        ? 'critico'
        : hallazgos.some(h => h.gravedad === 'aviso') ? 'aviso' : 'ok'

    hallazgos.sort((a, b) => ORDEN_GRAVEDAD[a.gravedad] - ORDEN_GRAVEDAD[b.gravedad])

    return { clienteId: s.clienteId, nombre: s.nombre.trim(), gravedad, hallazgos }
}

/** Ordena los clientes por gravedad: lo que hay que mirar primero, primero. */
export function ordenarPorGravedad(cs: SaludCliente[]): SaludCliente[] {
    return [...cs].sort((a, b) =>
        ORDEN_GRAVEDAD[a.gravedad] - ORDEN_GRAVEDAD[b.gravedad] ||
        b.hallazgos.length - a.hallazgos.length ||
        a.nombre.localeCompare(b.nombre))
}

/**
 * Tolerancias por fuente, en días sin datos antes de avisar.
 *
 * Salen del ritmo real de cada una, no de un número redondo: el gasto lo escribe
 * el worker cada día, así que dos días de silencio ya es un fallo; un Sheet que
 * alguien actualiza a mano puede pasar una semana sin tocarse sin que pase nada.
 */
export const TOLERANCIA_DIAS: Record<string, number> = {
    ads: 2,
    cuenta: 2,
    leads: 3,
    sales: 30,
    offline: 7,
    sheet: 7,
    subs: 7,
}
