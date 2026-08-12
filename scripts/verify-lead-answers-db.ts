/**
 * Comprobaciones del cubo de respuestas de formulario contra datos REALES.
 *
 * Lo que se verifica aquí no cabe en el script puro: que las defensas de la RPC
 * 071 aborten de verdad, que su universo sea EXACTAMENTE el mismo que el de
 * `bi_valores_conteo` (si no, el bloque y el BI darían cifras distintas para la
 * misma pregunta), que el día Colombia no pierda los bordes del rango, y que el
 * presupuesto de tiempo quepa en el `statement_timeout` de 8 s.
 *
 * También mide el FACTOR DE PLEGADO real por cliente: es el número que sostiene
 * el diseño —plegar en la base y colapsar en Node— y conviene verlo en la
 * consola antes de que sorprenda en producción.
 *
 *   npx tsx scripts/verify-lead-answers-db.ts
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

/** Fallback por si algún día el cliente mayor deja de llamarse Eduversio. */
function mayorCliente<T extends { nombre: string }>(cs: T[]): T | undefined {
    return cs[0]
}

// Rango CERRADO: con uno que llegue a hoy entran leads durante la prueba y los
// totales se mueven entre una consulta y la siguiente.
const DESDE = '2026-07-01'
const HASTA = '2026-07-31'
/** Margen sobre el `statement_timeout` de 8 s. */
const PRESUPUESTO_MS = 6000

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
    const { createAdminClient } = await import('../src/utils/supabase/server')
    const { colombiaRangeBounds } = await import('../src/lib/colombia-date')
    const { resolveRtmClienteId } = await import('../src/lib/report-utm/campaign-resolver')
    const { detectarCamposDeLeads, loadLeadCampos } = await import('../src/lib/report-utm/lead-campos-db')
    const { cargarRespuestasLead, campoSintetico } = await import('../src/lib/report-utm/lead-answers-db')

    const db = await createAdminClient()
    const rutm = db.schema('report_utm')
    const bounds = colombiaRangeBounds(DESDE, HASTA)

    const { data: csRaw } = await rutm
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    const clientes = (csRaw ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>
    check('hay clientes report_utm que inspeccionar', clientes.length > 0)

    // ════════════════════════════════════════════════════════════
    seccion('La RPC se niega a lo que no debe hacer')
    // ════════════════════════════════════════════════════════════
    // Comprobar solo que hay error no vale: si la RPC se invocara en el esquema
    // equivocado, TODO abortaría con «función no encontrada» y las pruebas
    // pasarían enteras sin que ninguna defensa saltara. Exigir el texto
    // convierte ese falso verde en un fallo.
    const abortaCon = async (nombre: string, esperado: string, fn: () => PromiseLike<{ error: unknown }>) => {
        const { error } = await fn()
        const msg = String((error as { message?: string } | null)?.message ?? '')
        if (!error) { check(nombre, false, 'la llamada NO abortó'); return }
        check(nombre, msg.includes(esperado), `abortó por otro motivo: ${msg}`)
    }

    await abortaCon('un array de claves vacío aborta', 'no puede ser NULL ni vacío', () =>
        rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: null, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: [], p_limite: 100,
        }))

    await abortaCon('un límite fuera de rango aborta', 'fuera de rango', () =>
        rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: null, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: ['x'], p_limite: 999999,
        }))

    await abortaCon('un límite de cero aborta', 'fuera de rango', () =>
        rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: null, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: ['x'], p_limite: 0,
        }))

    // Las claves viajan como PARÁMETRO y se comparan como valores, no se
    // interpolan como identificadores: no hay superficie de inyección. Se acota
    // a un cliente pequeño porque con `p_cliente_id: null` la consulta recorre
    // los leads de TODOS y agota el statement_timeout sin probar nada.
    {
        const pequeño = clientes[0]
        const { error } = await rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: pequeño.id, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: ["o'brien%_", "x'; DROP TABLE report_utm.lead_events; --"],
            p_limite: 10,
        })
        check('una clave con comillas y un intento de inyección no rompen la consulta',
            !error, String((error as { message?: string } | null)?.message ?? ''))
    }
    const { count: sigueViva } = await rutm.from('lead_events')
        .select('id', { count: 'planned', head: true })
    check('la tabla sigue existiendo tras los intentos', (sigueViva ?? 0) > 0)

    // ════════════════════════════════════════════════════════════
    seccion('norm_clave (SQL) == sanitizarColumna (Node)')
    // ════════════════════════════════════════════════════════════
    // Si estas dos divergen, un campo deja de encontrar su pregunta y la
    // consulta devuelve cero — indistinguible de "nadie respondió". Es el fallo
    // que tuvo la primera versión de esta migración: buscaba la clave
    // normalizada dentro de un JSONB que guarda la clave CRUDA, y solo
    // funcionaba con los formularios de Meta, que ya mandan snake_case.
    {
        const { normalizarClaveLead } = await import('../src/lib/report-utm/lead-campos')
        // Claves reales de producción, una por cliente y forma de escritura.
        const muestras = [
            'cual_es_tu_rango_de_ingresos',
            '¿cuál_es_tu_rango_aproximado_de_ingresos?',
            '¿cuándo_quieres_invertir_o_comprar?_tiempo_estimado',
            'cuantas propiedades tienes actualmente',
            '¿cuántas propiedades tienes?*',
            'rango de renta',
            '¿cuanto puedes destinar para el pie?',
            '¿cuánto estarías dispuesto a invertir en nuestros proyectos inmobiliarios?',
            'How would you best describe yourself?',
            'Año de Nacimiento — señálelo',
        ]
        for (const m of muestras) {
            const { data: fila, error: e } = await rutm
                .rpc('norm_clave', { p: m })
            const enSql = e ? `<error: ${e.message}>` : String(fila ?? '')
            const enNode = normalizarClaveLead(m)
            check(`"${m.slice(0, 45)}" normaliza igual`, enSql === enNode,
                `sql="${enSql}" node="${enNode}"`)
        }
    }

    // ════════════════════════════════════════════════════════════
    seccion('Paridad SQL ↔ Node (el mismo universo de leads)')
    // ════════════════════════════════════════════════════════════
    // La referencia es `bucketDeLead` sobre las filas crudas: es la definición
    // de qué responde un lead, y la RPC tiene que reproducirla exactamente.
    //
    // Deliberadamente NO se compara contra `bi_valores_conteo` (migración 070):
    // aquella busca con `raw_fields->>'<clave>'` literal, así que solo encuentra
    // las claves que ya vienen en snake_case (las de Meta). Con una clave
    // normalizada devuelve 0, que es justo el fallo que esta migración corrige.
    // Compararse con ella daría por bueno el comportamiento roto.

    // Cliente y claves con datos de verdad en el rango.
    let refCliente: { id: string; nombre: string } | null = null
    let refClaves: string[] = []
    for (const c of clientes) {
        const { claves } = await detectarCamposDeLeads(rutm, c.id, { dateFrom: DESDE, dateTo: HASTA })
        const opcion = claves.filter(k => k.es_opcion && k.leads > 100)
        if (opcion.length > 0) {
            refCliente = c
            refClaves = opcion.slice(0, 2).map(k => k.clave_norm)
            break
        }
    }

    if (!refCliente) {
        check('hay algún cliente con preguntas de opción en el rango', false,
            'ninguno: revisa el rango DESDE/HASTA del script')
    } else {
        console.log(`  · cliente de referencia: ${refCliente.nombre.trim()} · claves: ${refClaves.join(', ')}`)

        const { indexarRawFields, bucketDeLead } = await import('../src/lib/report-utm/lead-campos')
        const { fetchAllRows } = await import('../src/lib/supabase-paginate')

        const nueva = await rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: refCliente.id, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: refClaves, p_limite: 60000,
        })
        const sum = (rows: any) => (rows ?? []).reduce((s: number, r: any) => s + Number(r.n ?? 0), 0)
        const totalNueva = sum(nueva.data)

        // La misma cuenta, hecha a mano sobre las filas crudas.
        const crudas = await fetchAllRows(() => rutm
            .from('lead_events').select('id,raw_fields')
            .eq('cliente_id', refCliente!.id)
            .gte('created_at', bounds.gte).lt('created_at', bounds.lt)
            .not('raw_fields', 'is', null))
        const campoRef = campoSintetico('ref', 'ref', refClaves)
        const totalNode = (crudas as any[]).reduce((s, r) =>
            s + (bucketDeLead(campoRef, indexarRawFields(r.raw_fields)) ? 1 : 0), 0)

        check('la RPC cuenta exactamente los mismos leads que bucketDeLead',
            totalNueva === totalNode && totalNueva > 0,
            `sql=${totalNueva} node=${totalNode}`)

        // Y los VALORES, no solo el total: un desfase por bucket no cambiaría la
        // suma pero sí las barras.
        const porValorSql = new Map<string, number>()
        for (const r of (nueva.data ?? []) as any[]) {
            porValorSql.set(String(r.valor), (porValorSql.get(String(r.valor)) ?? 0) + Number(r.n ?? 0))
        }
        const porValorNode = new Map<string, number>()
        for (const r of crudas as any[]) {
            const idx = indexarRawFields(r.raw_fields)
            for (const clave of refClaves) {
                const v = idx.get(clave)
                const s = v === null || v === undefined ? '' : String(v).trim()
                if (!s) continue
                porValorNode.set(s, (porValorNode.get(s) ?? 0) + 1)
                break   // la primera clave con valor manda, igual que bucketDeLead
            }
        }
        const desajustes = [...porValorNode.entries()]
            .filter(([v, n]) => (porValorSql.get(v) ?? 0) !== n)
            .map(([v, n]) => `${v}: node=${n} sql=${porValorSql.get(v) ?? 0}`)
        check('cada respuesta cuadra valor a valor', desajustes.length === 0,
            desajustes.slice(0, 3).join(' · '))

        // ════════════════════════════════════════════════════════
        seccion('El día Colombia no pierde los bordes del rango')
        // ════════════════════════════════════════════════════════
        // El WHERE usa `colombiaRangeBounds` (offset literal -05:00) y el GROUP
        // BY usa `AT TIME ZONE 'America/Bogota'`. Hoy son idénticos porque
        // Bogotá es UTC-5 fijo; si algún día divergieran, aquí se vería.
        const dias = new Set<string>((nueva.data ?? []).map((r: any) => String(r.dia)))
        const fuera = [...dias].filter(d => d < DESDE || d > HASTA)
        check('ningún día cae fuera del rango pedido', fuera.length === 0, fuera.join(', '))

        const { count: leadsEnRango } = await rutm.from('lead_events')
            .select('id', { count: 'exact', head: true })
            .eq('cliente_id', refCliente.id)
            .gte('created_at', bounds.gte).lt('created_at', bounds.lt)
        check('los leads contados no superan a los del rango',
            totalNueva <= (leadsEnRango ?? 0),
            `respuestas=${totalNueva} leads=${leadsEnRango}`)

        // ════════════════════════════════════════════════════════
        seccion('Un lead que responde por dos vías cuenta UNA vez')
        // ════════════════════════════════════════════════════════
        // Es la regresión del doble conteo: agrupar cada clave por separado y
        // sumar después inflaría el total sin que nada lo delatara.
        if (refClaves.length >= 2) {
            const porSeparado = await Promise.all(refClaves.map(k =>
                rutm.rpc('bi_respuestas_por_dia', {
                    p_cliente_id: refCliente!.id, p_desde: bounds.gte, p_hasta: bounds.lt,
                    p_claves_json: [k], p_limite: 60000,
                })))
            const sumaSeparada = porSeparado.reduce((s, r) => s + sum(r.data), 0)
            check('el COALESCE evita el doble conteo (juntas ≤ suma por separado)',
                totalNueva <= sumaSeparada,
                `juntas=${totalNueva} separadas=${sumaSeparada}`)
        } else {
            console.log('  · (el cliente de referencia solo tiene una clave: no aplica)')
        }
    }

    // ════════════════════════════════════════════════════════════
    seccion('Presupuesto de tiempo y factor de plegado')
    // ════════════════════════════════════════════════════════════
    let mayor = clientes[0]
    let maxLeads = -1
    for (const c of clientes) {
        const { count } = await rutm.from('lead_events')
            .select('id', { count: 'planned', head: true }).eq('cliente_id', c.id)
        if ((count ?? 0) > maxLeads) { maxLeads = count ?? 0; mayor = c }
    }
    console.log(`  · cliente con más leads: ${mayor.nombre.trim()} (~${maxLeads})`)

    for (const c of clientes) {
        const { claves, leads } = await detectarCamposDeLeads(rutm, c.id, { dateFrom: DESDE, dateTo: HASTA })
        const opcion = claves.filter(k => k.es_opcion && k.leads >= 20).slice(0, 2)
        if (opcion.length === 0 || leads === 0) {
            // No es un fallo: hay clientes cuyos formularios solo piden nombre y
            // correo. Se declara para que la ausencia sea un dato, no un misterio.
            console.log(`  · ${c.nombre.trim()}: ${leads} leads, sin preguntas de opción`)
            continue
        }
        const t0 = Date.now()
        const { data, error } = await rutm.rpc('bi_respuestas_por_dia', {
            p_cliente_id: c.id, p_desde: bounds.gte, p_hasta: bounds.lt,
            p_claves_json: opcion.map(k => k.clave_norm), p_limite: 60000,
        })
        const ms = Date.now() - t0
        if (error) {
            check(`${c.nombre.trim()}: la consulta responde`, false, error.message)
            continue
        }
        const filas = (data ?? []).length
        const factor = leads > 0 ? filas / leads : 0
        console.log(`  · ${c.nombre.trim()}: ${leads} leads → ${filas} filas (factor ${factor.toFixed(2)}) en ${ms} ms`)
        check(`${c.nombre.trim()}: cabe en el presupuesto`, ms < PRESUPUESTO_MS, `${ms} ms`)
        // Lo que de verdad importa es el tamaño ABSOLUTO: es lo que viaja a Node
        // y lo que puede truncar la consulta.
        check(`${c.nombre.trim()}: no se acerca al tope de la consulta`, filas < 60000 * 0.5,
            `${filas} filas`)
        // El factor solo tiene sentido con volumen. Con 115 leads y una pregunta
        // de 10 respuestas, casi cada lead es su propia combinación y un factor
        // alto no dice nada: son 98 filas. Se exige a partir de mil leads, que es
        // donde el plegado tiene que estar sosteniendo el diseño.
        if (leads >= 1000) {
            check(`${c.nombre.trim()}: el plegado sigue comprimiendo`, factor <= 0.5,
                `factor ${factor.toFixed(2)} — revisar el diseño del grano`)
        }
    }

    // ════════════════════════════════════════════════════════════
    seccion('El puente public → report_utm')
    // ════════════════════════════════════════════════════════════
    let enlazados = 0
    for (const c of clientes) {
        if (!c.public_cliente_id) continue
        enlazados++
        const rtmId = await resolveRtmClienteId(c.public_cliente_id)
        check(`${c.nombre.trim()}: resuelve a un cliente report_utm`, rtmId !== null)
    }
    check('hay al menos un cliente enlazado', enlazados > 0)
    check('un id público inventado devuelve null, no lanza',
        (await resolveRtmClienteId('00000000-0000-0000-0000-000000000000')) === null)

    // ════════════════════════════════════════════════════════════
    seccion('El cubo completo, de punta a punta')
    // ════════════════════════════════════════════════════════════
    if (refCliente) {
        const catalogo = await loadLeadCampos(rutm, refCliente.id, { soloActivos: true })
        const campos = catalogo.length > 0
            ? catalogo.slice(0, 2)
            : refClaves.map(k => campoSintetico(`auto:${k}`, k, [k]))

        const ds = await cargarRespuestasLead(rutm, refCliente.id, DESDE, HASTA, campos)
        check('el cubo trae campos', ds.campos.length > 0)
        check('el índice 0 del diccionario es siempre (sin campaña)',
            ds.campanas[0] === '(sin campaña)', ds.campanas[0])
        check('el diccionario de ids es paralelo al de nombres',
            ds.campanas.length === ds.campanaIds.length)
        check('no se marca incompleto en un rango normal', !ds.incompleto)

        const fechas = Object.keys(ds.porFecha)
        check('hay días en el cubo', fechas.length > 0)
        check('todos los días están dentro del rango',
            fechas.every(f => f >= DESDE && f <= HASTA))
        // El índice del array de cada día TIENE que coincidir con el del
        // catálogo, o el bloque leería los tripletes de otra pregunta.
        check('cada día trae una entrada por campo',
            fechas.every(f => ds.porFecha[f].length === ds.campos.length))
        check('ningún triplete apunta fuera del diccionario',
            fechas.every(f => ds.porFecha[f].every(porCampo =>
                porCampo.every(([b, c]) => c >= 0 && c < ds.campanas.length && b >= 0))))
        check('ningún triplete apunta a un bucket inexistente',
            fechas.every(f => ds.porFecha[f].every((porCampo, i) =>
                porCampo.every(([b]) => b < ds.campos[i].buckets.length))))

        const totalCubo = fechas.reduce((s, f) =>
            s + ds.porFecha[f].reduce((s2, pc) => s2 + pc.reduce((s3, [, , n]) => s3 + n, 0), 0), 0)
        const coberturaDeclarada = ds.campos.reduce((s, c) => s + c.cobertura, 0)
        check('la cobertura declarada cuadra con la suma del cubo',
            totalCubo === coberturaDeclarada, `cubo=${totalCubo} cobertura=${coberturaDeclarada}`)
    }

    // ════════════════════════════════════════════════════════════
    seccion('Total diario de contactos (utm_leads)')
    // ════════════════════════════════════════════════════════════
    await abortaCon('un límite fuera de rango aborta también aquí', 'fuera de rango', () =>
        rutm.rpc('bi_leads_por_dia', {
            p_cliente_id: null, p_desde: bounds.gte, p_hasta: bounds.lt, p_limite: 999999,
        }))

    // Se pasa por `cargarRespuestasLead`, que es el camino real: la RPC devuelve
    // el conteo pero PostgREST corta en 1000 filas, así que sin la paginación de
    // la librería el total saldría corto. Ver la comprobación siguiente.
    for (const c of clientes) {
        const ds = await cargarRespuestasLead(rutm, c.id, DESDE, HASTA, [])
        const totalCubo = Object.values(ds.totalesPorFecha)
            .reduce((s, pares) => s + pares.reduce((s2, [, n]) => s2 + n, 0), 0)

        // La cuenta de referencia: los leads del rango, sin más.
        const { count } = await rutm.from('lead_events')
            .select('id', { count: 'exact', head: true })
            .eq('cliente_id', c.id)
            .gte('created_at', bounds.gte).lt('created_at', bounds.lt)
        check(`${c.nombre.trim()}: el total diario cuadra con los leads del rango`,
            totalCubo === (count ?? 0), `cubo=${totalCubo} tabla=${count}`)
    }

    // ════════════════════════════════════════════════════════════
    seccion('La paginación es imprescindible, no una precaución')
    // ════════════════════════════════════════════════════════════
    // PostgREST corta las respuestas de RPC en 1000 filas igual que las de tabla.
    // El síntoma era invisible: el desglose salía corto pero cuadrando consigo
    // mismo. Esta comprobación fija el comportamiento en el cliente que lo
    // provoca, para que nadie "simplifique" la paginación creyéndola de más.
    {
        const grande = clientes.find(c => c.nombre.includes('Eduversio')) ?? mayorCliente(clientes)
        if (grande) {
            const { data } = await rutm.rpc('bi_leads_por_dia', {
                p_cliente_id: grande.id, p_desde: bounds.gte, p_hasta: bounds.lt, p_limite: 60000,
            })
            const unaPagina = (data ?? []) as any[]
            const totalReal = Number(unaPagina[0]?.total_filas ?? 0)
            if (totalReal > 1000) {
                check(`${grande.nombre.trim()}: una sola página se queda corta (por eso se pagina)`,
                    unaPagina.length === 1000 && totalReal > unaPagina.length,
                    `devueltas=${unaPagina.length} total=${totalReal}`)

                const ds = await cargarRespuestasLead(rutm, grande.id, DESDE, HASTA, [])
                const dias = Object.keys(ds.totalesPorFecha).length
                check(`${grande.nombre.trim()}: paginando se recuperan todos los días`,
                    dias > 0 && !ds.incompleto, `dias=${dias} incompleto=${ds.incompleto}`)
            } else {
                console.log(`  · ${grande.nombre.trim()} no llega a 1000 combinaciones: no aplica`)
            }
        }
    }

    if (refCliente) {
        // La invariante que hace legible la tabla diaria: los que respondieron
        // NUNCA pueden ser más que el total de contactos de ese día. Si lo fueran,
        // `(sin respuesta)` saldría negativo y la tabla no cerraría.
        const campos = refClaves.map(k => campoSintetico(`auto:${k}`, k, [k]))
        const ds = await cargarRespuestasLead(rutm, refCliente.id, DESDE, HASTA, campos)

        let desbordes = 0
        for (const [fecha, porCampo] of Object.entries(ds.porFecha)) {
            const total = (ds.totalesPorFecha[fecha] ?? []).reduce((s, [, n]) => s + n, 0)
            for (const tripletes of porCampo) {
                const respondieron = tripletes.reduce((s, [, , n]) => s + n, 0)
                if (respondieron > total) desbordes++
            }
        }
        check('en ningún día responden más leads de los que se registraron',
            desbordes === 0, `${desbordes} días desbordados`)

        check('el cubo trae totales diarios', Object.keys(ds.totalesPorFecha).length > 0)
        check('todo día con respuestas tiene su total',
            Object.keys(ds.porFecha).every(f => ds.totalesPorFecha[f] !== undefined))
    }

    // ════════════════════════════════════════════════════════════
    seccion('Las claves se inyectan en filas que existen')
    // ════════════════════════════════════════════════════════════
    // `utm_leads` y las claves por respuesta se añaden a las filas de
    // `metricas_diarias` que ya vienen del servidor. Un día con contactos pero
    // SIN fila de métricas no recibiría clave y sus leads no se contarían en
    // ninguna tarjeta — en silencio. Hoy no ocurre en ningún cliente; esta
    // comprobación existe para enterarnos si algún día empieza a ocurrir.
    {
        let diasHuerfanos = 0
        for (const c of clientes) {
            if (!c.public_cliente_id) continue
            const { data: filas } = await rutm.rpc('bi_leads_por_dia', {
                p_cliente_id: c.id, p_desde: bounds.gte, p_hasta: bounds.lt, p_limite: 60000,
            })
            const dias = new Set<string>(((filas ?? []) as any[]).map(r => String(r.dia)))
            if (dias.size === 0) continue
            const { data: metricas } = await db.from('metricas_diarias')
                .select('fecha').eq('cliente_id', c.public_cliente_id)
                .gte('fecha', DESDE).lte('fecha', HASTA)
            const conFila = new Set<string>(((metricas ?? []) as any[]).map(m => String(m.fecha)))
            const huerfanos = [...dias].filter(d => !conFila.has(d))
            if (huerfanos.length > 0) {
                diasHuerfanos += huerfanos.length
                console.log(`  · ${c.nombre.trim()}: ${huerfanos.length} días con leads y sin fila de métricas`)
            }
        }
        check('ningún día con contactos se queda sin fila de métricas', diasHuerfanos === 0,
            `${diasHuerfanos} días — esos leads no llegarían a las tarjetas`)
    }

    console.log(fallos === 0
        ? '\n✅ Respuestas de formulario (datos): todas las comprobaciones pasan\n'
        : `\n❌ ${fallos} comprobación(es) fallaron\n`)
    process.exit(fallos === 0 ? 0 : 1)
}

main().catch(err => {
    console.error('\n❌ Error inesperado:', err)
    process.exit(1)
})
