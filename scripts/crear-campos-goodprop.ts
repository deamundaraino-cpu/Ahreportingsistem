/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Recrea los campos de Sheet de Goodprop y recalcula su desglose.
 *
 *   npx tsx scripts/crear-campos-goodprop.ts          → informe, no escribe
 *   npx tsx scripts/crear-campos-goodprop.ts --apply  → crea y recalcula
 *
 * Los campos se borraron el 3-ago-2026 y con ellos se fueron las 12 columnas de
 * las dos pestañas del dashboard, que son fórmulas sobre tokens `sf_*`. Este
 * script los reconstruye con las claves EXACTAS que piden esas fórmulas — la
 * clave es la parte pública del token, así que un nombre distinto no vale.
 *
 * Son campos y no vistas a propósito: las vistas se referencian con `sv_` y las
 * columnas del dashboard usan `sf_`.
 *
 * ── Criterio (confirmado por el cliente) ──
 * Califica el INICIO del rango: "1.3M" es todo lo que empieza en 1.300.000 o más.
 * Por eso `entre_$1.000.000_y_$1.300.000` NO califica: empieza en 1.000.000.
 *
 * Cada campo de calificación colapsa sus rangos en un único bucket y descarta el
 * resto (`sin_mapear: 'ignorar'`), de modo que `sf_<clave>` con agregación
 * `count` es directamente el número de leads que califican.
 *
 * Las tres pestañas nombran la columna distinto y escriben los rangos con `_y_` o
 * con `_a_`; por eso cada campo lleva un origen por pestaña y el `valores_map`
 * lista las dos variantes.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { recalcularCamposCliente } from '../src/lib/sheets/campos-db'
import { normalizarValorCrudo } from '../src/lib/sheets/campos'

config({ path: '.env.local' })

const APLICAR = process.argv.includes('--apply')
const CID = '7deabd98-0820-480a-aff2-4c05e3536928'
const SHEET_ID = 'da55ac5e-4a13-48be-9c6c-866db6802586'

const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
)

/** Pestaña → columna que guarda el rango de ingresos. */
const ORIGENES = [
    { tab_name: 'Mes Enero', columnas: ['cual_es_tu_rango_de_ingresos'] },
    { tab_name: 'form filtro logico', columnas: ['cual_es_tu_rango_de_ingresos'] },
    { tab_name: 'Formulario filtro logico- Abril 2026 V2', columnas: ['cual_es_tu_rango_aproximado_de_ingresos'] },
].map(o => ({ sheet_id: SHEET_ID, combinar: 'primero' as const, ...o }))

// Valores tal como están en el Sheet. Las dos variantes de separador conviven.
const R = {
    menos: ['menos_de_1.300.000_'],
    de1a13: ['entre_$1.000.000_y_$1.300.000'],
    de13a16: ['entre_$1.300.000_y_$1.600.000', 'entre_$1.300.000_a_$1.600.000'],
    de16a2: ['entre_$1.600.000_y_$2.000.000', 'entre_$1.600.000_a_$2.000.000'],
    de2a4: ['entre_$2.000.000_y_$4.000.000', 'entre_$2.000.000_a_$4.000.000'],
    mas4: ['más_de_$4.000.000'],
}

/** { valor crudo normalizado: bucket } — las claves las normaliza `bucketDeValor`. */
function mapa(valores: string[][], bucket: string) {
    const out: Record<string, string> = {}
    for (const v of valores.flat()) out[normalizarValorCrudo(v)] = bucket
    return out
}

const CAMPOS = [
    {
        clave: 'leads_totales',
        nombre: 'Leads Totales',
        descripcion: 'Leads con respuesta de rango de ingresos, en las tres pestañas.',
        // Sin mapa: cada rango es su propio valor, que es lo que hace útil el
        // desglose por valor. 'crudo' conserva cualquier respuesta nueva.
        valores_map: {},
        sin_mapear: 'crudo',
    },
    {
        clave: 'rango_de_ingresos',
        nombre: 'Leads Calificados desde 1.3M',
        descripcion: 'Rango que empieza en 1.300.000 o más.',
        valores_map: mapa([R.de13a16, R.de16a2, R.de2a4, R.mas4], 'Leads calificados 1.3M'),
        sin_mapear: 'ignorar',
    },
    {
        clave: 'leads_calificados_1_6m',
        nombre: 'Leads Calificados desde 1.6M',
        descripcion: 'Rango que empieza en 1.600.000 o más.',
        valores_map: mapa([R.de16a2, R.de2a4, R.mas4], 'Leads calificados 1.6M'),
        sin_mapear: 'ignorar',
    },
    {
        clave: 'leads_calificados_2m',
        nombre: 'Leads Calificados desde 2M',
        descripcion: 'Rango que empieza en 2.000.000 o más.',
        valores_map: mapa([R.de2a4, R.mas4], 'Leads calificados 2M'),
        sin_mapear: 'ignorar',
    },
    {
        clave: 'leads_no_calificados',
        nombre: 'Leads No Calificados',
        descripcion: 'Rango que empieza por debajo de 1.300.000.',
        valores_map: mapa([R.menos, R.de1a13], 'Leads no calificados'),
        sin_mapear: 'ignorar',
    },
]

async function main() {
    const { data: existentes } = await db.from('sheet_campos').select('clave').eq('cliente_id', CID)
    const yaEstan = new Set(((existentes ?? []) as any[]).map(c => c.clave))

    console.log(APLICAR ? '── CREANDO ──\n' : '── Informe. Añade --apply para escribir ──\n')

    for (const [i, campo] of CAMPOS.entries()) {
        const buckets = [...new Set(Object.values(campo.valores_map))]
        console.log(`sf_${campo.clave} — ${campo.nombre}`)
        console.log(`   ${Object.keys(campo.valores_map).length} valores → ${buckets.length ? buckets.join(', ') : '(cada rango por separado)'}`)
        if (yaEstan.has(campo.clave)) { console.log('   ya existe, no se toca\n'); continue }
        if (!APLICAR) { console.log('   se crearía\n'); continue }

        const { error } = await db.from('sheet_campos').insert({
            cliente_id: CID,
            clave: campo.clave,
            nombre: campo.nombre,
            descripcion: campo.descripcion,
            rol: 'ambos',
            formato: 'number',
            agregacion: 'count',
            origenes: ORIGENES,
            valores_map: campo.valores_map,
            valores_orden: [],
            sin_mapear: campo.sin_mapear,
            activo: true,
            orden: i,
        })
        if (error) { console.log(`   ✗ ${error.message}\n`); continue }
        console.log('   ✓ creado\n')
    }

    if (!APLICAR) return

    console.log('Recalculando el desglose desde sheet_filas (no llama a Google)…')
    const res = await recalcularCamposCliente(db, CID)
    if (res.error) { console.log(`✗ ${res.error}`); process.exit(1) }
    console.log(`✓ ${res.campos} campos · ${res.dias} días · ${res.valores} valores`)
    for (const aviso of res.avisos) console.log(`  ⚠ ${aviso}`)

    console.log('\nTotales por campo:')
    const { data: campos } = await db.from('sheet_campos')
        .select('id, clave, nombre').eq('cliente_id', CID).order('orden')
    for (const c of (campos ?? []) as any[]) {
        let filas = 0
        for (let desde = 0; ; desde += 1000) {
            const { data } = await db.from('sheet_campo_valores_diarios')
                .select('filas').eq('campo_id', c.id).order('fecha').range(desde, desde + 999)
            if (!data || data.length === 0) break
            for (const d of data as any[]) filas += d.filas ?? 0
            if (data.length < 1000) break
        }
        console.log(`   sf_${c.clave.padEnd(24)} ${filas.toLocaleString('es').padStart(8)} filas`)
    }
}

main().catch(e => { console.error(e.message); process.exit(1) })
