/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Consolida los campos-contador de lead en campos bien configurados + SEGMENTOS,
 * y da de alta las preguntas cruzables que ningún cliente tenía configuradas.
 *
 *   npx tsx scripts/migrar-segmentos-lead.ts                → informe, no escribe
 *   npx tsx scripts/migrar-segmentos-lead.ts --aplicar      → escribe (con copia)
 *   npx tsx scripts/migrar-segmentos-lead.ts --revertir X   → deshace desde la copia
 *
 * ── Por qué ──
 * Hasta la migración 073 un campo de lead solo era una DIMENSIÓN. Como no había
 * forma de pedir «cuántos leads ganan más de 2M» como número, los traffickers lo
 * fabricaron creando un campo por umbral, cada uno mapeando N respuestas a UN
 * bucket. En producción:
 *
 *   • Goodprop: `leads_totales`, `leads_desde_1_3m`, `leads_desde1_6m` y
 *     `leads_desde_2m`, los cuatro sobre la misma pregunta. Y el campo legítimo
 *     (`rango_de_ingresos`) con `valores_map` VACÍO, así que no agrupa nada.
 *   • Cris tributario: tres campos sobre la misma clave, todos con el mapa vacío
 *     — hoy no hacen absolutamente nada.
 *
 * Un segmento hace eso mismo bien: un campo con sus buckets, y encima subconjuntos
 * con nombre que sí son métricas.
 *
 * ── Seguridad ──
 * Los campos-contador se DESACTIVAN, nunca se borran: revertir es volver el flag,
 * y la clave queda reservada para que ningún alta futura slugifique encima. Antes
 * de escribir se comprueba que ningún informe ni layout guardado los referencia.
 *
 * El criterio de calificación es el confirmado por el cliente y ya usado en
 * `crear-campos-goodprop.ts`: califica el INICIO del rango, así que
 * «entre 1.000.000 y 1.300.000» NO entra en «desde 1.3M».
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { normalizarValorCrudo, slugCampo } from '../src/lib/report-utm/lead-campos';
import { clavesDeCampo } from '../src/lib/dashboard/lead-answer-aggregation';

config({ path: '.env.local' });

const APLICAR = process.argv.includes('--aplicar');
const REVERTIR = process.argv.includes('--revertir')
  ? process.argv[process.argv.indexOf('--revertir') + 1]
  : null;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false }, db: { schema: 'report_utm' } }
);
const pub = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const CLIENTES = {
  goodprop: 'b369b66c-7f91-4cb5-a740-4fa9f6dd69f6',
  cris: '337d5c5a-684c-4b50-88e2-70a73d7ebc4b',
  somosRentable: 'd1ffd5dd-c020-4b65-b674-06b0925bc945',
  surProfundo: '9d8f58d6-38d4-4aee-8577-316876d34000',
  inspira: '1788fa8d-d83c-44e5-b85e-846c01ed3ca4',
};

/** `{ valor crudo normalizado: bucket }` — la clave la normaliza `bucketDeValor`. */
function mapa(pares: [string[], string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [crudos, bucket] of pares) {
    for (const c of crudos) out[normalizarValorCrudo(c)] = bucket;
  }
  return out;
}

interface CampoPlan {
  clave: string;
  nombre: string;
  descripcion?: string;
  claves_origen: string[];
  valores_map: Record<string, string>;
  /** De menor a mayor. Es lo que hace posibles los acumulados «desde X». */
  valores_orden: string[];
  sin_mapear: 'crudo' | 'otros' | 'ignorar';
}

interface SegmentoPlan {
  clave: string;
  nombre: string;
  descripcion?: string;
  /** Buckets incluidos, tal como los produce `valores_map`. */
  valores: string[];
}

interface PlanCliente {
  nombre: string;
  clienteId: string;
  campos: { campo: CampoPlan; segmentos: SegmentoPlan[] }[];
  /** Claves de campos-contador que se retiran (activo = false). */
  retirar: string[];
  /** Avisos que el humano tiene que leer antes de aplicar. */
  notas?: string[];
}

// ════════════════════════════════════════════════════════════════
// Goodprop — 5 campos → 1 campo + 4 segmentos
// ════════════════════════════════════════════════════════════════

const GP_CLAVES = ['cual_es_tu_rango_de_ingresos', 'cual_es_tu_rango_aproximado_de_ingresos'];

// Los seis rangos reales, con las dos variantes de separador (`_y_` en el
// formulario de Meta, `_a_` en el de la web) fundidas en el mismo bucket.
const GP = {
  menos13: 'Menos de $1.300.000',
  de1a13: 'Entre $1.000.000 y $1.300.000',
  de13a16: 'Entre $1.300.000 y $1.600.000',
  de16a2: 'Entre $1.600.000 y $2.000.000',
  de2a4: 'Entre $2.000.000 y $4.000.000',
  mas4: 'Más de $4.000.000',
};

const GP_ORDEN = [GP.menos13, GP.de1a13, GP.de13a16, GP.de16a2, GP.de2a4, GP.mas4];

const goodpropRango: CampoPlan = {
  clave: 'rango_de_ingresos',
  nombre: 'Rango de ingresos',
  descripcion:
    'Respuesta de rango de ingresos, unificando el formulario web y el de Meta Lead Ads.',
  claves_origen: GP_CLAVES,
  valores_map: mapa([
    [['menos_de_1.300.000_'], GP.menos13],
    [['entre_$1.000.000_y_$1.300.000', 'entre_$1.000.000_a_$1.300.000'], GP.de1a13],
    [['entre_$1.300.000_y_$1.600.000', 'entre_$1.300.000_a_$1.600.000'], GP.de13a16],
    [['entre_$1.600.000_y_$2.000.000', 'entre_$1.600.000_a_$2.000.000'], GP.de16a2],
    [['entre_$2.000.000_y_$4.000.000', 'entre_$2.000.000_a_$4.000.000'], GP.de2a4],
    [['más_de_$4.000.000', 'mas_de_$4.000.000'], GP.mas4],
  ]),
  valores_orden: GP_ORDEN,
  // 'otros' y no 'crudo': con 'crudo', una respuesta nueva (o el lead de prueba
  // de Meta) se cuela como bucket suelto y aparece en el selector de métricas
  // con su texto en minúsculas. Es exactamente lo que ensuciaba la lista.
  sin_mapear: 'otros',
};

const goodprop: PlanCliente = {
  nombre: 'Goodprop',
  clienteId: CLIENTES.goodprop,
  campos: [
    {
      campo: goodpropRango,
      segmentos: [
        {
          clave: 'respondieron_rango',
          nombre: 'Respondieron el rango',
          // NO se llama «Leads totales» a propósito: el campo-contador viejo
          // se llamaba así y no medía los contactos, medía a quien contestó
          // la pregunta. Para el total de contactos está `utm_leads`.
          descripcion:
            'Leads que contestaron la pregunta de ingresos. No es el total de contactos.',
          valores: GP_ORDEN,
        },
        {
          clave: 'ingresos_desde_1_3m',
          nombre: 'Desde 1.3M',
          valores: [GP.de13a16, GP.de16a2, GP.de2a4, GP.mas4],
        },
        {
          clave: 'ingresos_desde_1_6m',
          nombre: 'Desde 1.6M',
          valores: [GP.de16a2, GP.de2a4, GP.mas4],
        },
        { clave: 'ingresos_desde_2m', nombre: 'Desde 2M', valores: [GP.de2a4, GP.mas4] },
      ],
    },
    {
      campo: {
        clave: 'plazo_de_compra',
        nombre: 'Plazo de compra',
        descripcion:
          'Cuándo quiere invertir o comprar. 2.448 leads y ningún campo configurado hasta ahora.',
        claves_origen: ['cuando_quieres_invertir_o_comprar_tiempo_estimado'],
        valores_map: mapa([
          [['cuanto_antes,_mejor.'], 'Cuanto antes'],
          [['1_a_3_meses'], '1 a 3 meses'],
          [['3_a_6_meses'], '3 a 6 meses'],
          [['solo_explorando_a_mediano_plazo'], 'Solo explorando'],
        ]),
        valores_orden: ['Cuanto antes', '1 a 3 meses', '3 a 6 meses', 'Solo explorando'],
        sin_mapear: 'otros',
      },
      // El orden va de MÁS urgente a menos, así que el acumulado natural es al
      // revés que en los rangos: «hasta 3 meses» son los dos primeros.
      segmentos: [
        {
          clave: 'plazo_hasta_3_meses',
          nombre: 'Hasta 3 meses',
          valores: ['Cuanto antes', '1 a 3 meses'],
        },
        {
          clave: 'plazo_hasta_6_meses',
          nombre: 'Hasta 6 meses',
          valores: ['Cuanto antes', '1 a 3 meses', '3 a 6 meses'],
        },
      ],
    },
  ],
  retirar: ['leads_totales', 'leads_desde_1_3m', 'leads_desde1_6m', 'leads_desde_2m'],
};

// ════════════════════════════════════════════════════════════════
// Cris tributario — dos escalas que NO encajan
// ════════════════════════════════════════════════════════════════

const cris: PlanCliente = {
  nombre: 'Cris tributario',
  clienteId: CLIENTES.cris,
  campos: [
    {
      campo: {
        clave: 'numero_de_propiedades',
        nombre: 'Número de propiedades (web)',
        descripcion: 'Escala del formulario web: 0-1 / 2-3 / más de 4.',
        claves_origen: ['cuantas_propiedades_tienes'],
        valores_map: mapa([
          [['0 a 1 propiedad'], '0 a 1'],
          [['2 a 3 propiedades'], '2 a 3'],
          [['Más de 4 propiedades'], 'Más de 4'],
        ]),
        valores_orden: ['0 a 1', '2 a 3', 'Más de 4'],
        sin_mapear: 'otros',
      },
      segmentos: [
        {
          clave: 'propiedades_web_desde_2',
          nombre: 'Desde 2 propiedades',
          valores: ['2 a 3', 'Más de 4'],
        },
        { clave: 'propiedades_web_desde_4', nombre: 'Desde 4 propiedades', valores: ['Más de 4'] },
      ],
    },
    {
      campo: {
        clave: 'cuantas_propiedades_tienes_actualmente',
        nombre: 'Número de propiedades (Meta)',
        descripcion:
          'Escala del formulario de Meta: 3-4 / 5-8 / más de 8. NO es la misma que la web.',
        claves_origen: ['cuantas_propiedades_tienes_actualmente'],
        valores_map: mapa([
          [['Tengo 3-4 propiedades.', 'Tengo 3-5 propiedades.'], '3 a 4'],
          [['Tengo 5-8 propiedades.'], '5 a 8'],
          [['Tengo más de 8 propiedades.'], 'Más de 8'],
          // El relleno del desplegable cuenta como respuesta en el dato
          // crudo y ensuciaría el eje: se aparta.
          [['Seleccione una opción.'], '(sin respuesta)'],
        ]),
        valores_orden: ['3 a 4', '5 a 8', 'Más de 8'],
        sin_mapear: 'otros',
      },
      segmentos: [
        {
          clave: 'propiedades_meta_desde_5',
          nombre: 'Desde 5 propiedades',
          valores: ['5 a 8', 'Más de 8'],
        },
        {
          clave: 'propiedades_meta_desde_9',
          nombre: 'Más de 8 propiedades',
          valores: ['Más de 8'],
        },
      ],
    },
  ],
  retirar: ['0_a_1_propiedad', 'de_2_a_3_propiedades', 'mas_de_4_propiedades'],
  notas: [
    'Las DOS preguntas miden lo mismo pero con escalas que no encajan:',
    '  web  → 0-1 (11 leads) · 2-3 (19) · Más de 4 (17)',
    '  Meta → 3-4 (401) · 5-8 (76) · Más de 8 (39)',
    'Fundirlas en un solo campo inventaría una correspondencia entre «2 a 3» y',
    '«Tengo 3-4» que no existe, así que van como DOS campos y cada uno con sus',
    'segmentos. Si el negocio confirma una equivalencia, se hace después a mano.',
  ],
};

// ════════════════════════════════════════════════════════════════
// Altas nuevas — preguntas cruzables sin ningún campo configurado
// ════════════════════════════════════════════════════════════════

const somosRentable: PlanCliente = {
  nombre: 'Somos rentable',
  clienteId: CLIENTES.somosRentable,
  campos: [
    {
      campo: {
        clave: 'monto_a_invertir',
        nombre: 'Monto a invertir',
        descripcion: 'Cuánto está dispuesto a invertir. 6.648 leads.',
        claves_origen: ['cuanto_estarias_dispuesto_a_invertir_en_nuestros_proyectos_inmobiliarios'],
        valores_map: mapa([
          [['Menos de $15 millones'], 'Menos de $15M'],
          [['Entre $15 y $30 millones'], 'Entre $15M y $30M'],
          [['Entre $30 y $50 millones'], 'Entre $30M y $50M'],
          [['Más de $50 millones'], 'Más de $50M'],
        ]),
        valores_orden: ['Menos de $15M', 'Entre $15M y $30M', 'Entre $30M y $50M', 'Más de $50M'],
        sin_mapear: 'otros',
      },
      segmentos: [
        {
          clave: 'invertir_desde_15m',
          nombre: 'Desde $15M',
          valores: ['Entre $15M y $30M', 'Entre $30M y $50M', 'Más de $50M'],
        },
        {
          clave: 'invertir_desde_30m',
          nombre: 'Desde $30M',
          valores: ['Entre $30M y $50M', 'Más de $50M'],
        },
        { clave: 'invertir_desde_50m', nombre: 'Desde $50M', valores: ['Más de $50M'] },
      ],
    },
  ],
  retirar: [],
};

const surProfundo: PlanCliente = {
  nombre: 'Sur Profundo',
  clienteId: CLIENTES.surProfundo,
  campos: [
    {
      campo: {
        clave: 'rango_de_renta',
        nombre: 'Rango de renta',
        descripcion: 'Renta mensual declarada. Funde las dos escrituras del rango medio.',
        claves_origen: ['rango_de_renta'],
        valores_map: mapa([
          [['Menos de $2.000.000'], 'Menos de $2.000.000'],
          // Las dos variantes de separador: «a» y «–». Son 424 + 30 leads
          // que hoy cuentan como dos respuestas distintas.
          [
            ['Entre $2.000.000 a $3.000.000', 'Entre $2.000.000 – $3.000.000'],
            'Entre $2.000.000 y $3.000.000',
          ],
          [['Más de $3.000.000'], 'Más de $3.000.000'],
        ]),
        valores_orden: [
          'Menos de $2.000.000',
          'Entre $2.000.000 y $3.000.000',
          'Más de $3.000.000',
        ],
        sin_mapear: 'otros',
      },
      segmentos: [
        {
          clave: 'renta_desde_2m',
          nombre: 'Desde $2M',
          valores: ['Entre $2.000.000 y $3.000.000', 'Más de $3.000.000'],
        },
        { clave: 'renta_desde_3m', nombre: 'Desde $3M', valores: ['Más de $3.000.000'] },
      ],
    },
    {
      campo: {
        clave: 'pie_disponible',
        nombre: 'Pie disponible',
        descripcion: 'Cuánto puede destinar al pie. Misma doble escritura del rango medio.',
        claves_origen: ['cuanto_puedes_destinar_para_el_pie'],
        valores_map: mapa([
          [['Menos de $12.000.000'], 'Menos de $12.000.000'],
          [
            ['Entre $12.000.000 a $15.000.000', 'Entre $12.000.000 – $15.000.000'],
            'Entre $12.000.000 y $15.000.000',
          ],
          [['Más de $15.000.000'], 'Más de $15.000.000'],
        ]),
        valores_orden: [
          'Menos de $12.000.000',
          'Entre $12.000.000 y $15.000.000',
          'Más de $15.000.000',
        ],
        sin_mapear: 'otros',
      },
      segmentos: [
        {
          clave: 'pie_desde_12m',
          nombre: 'Desde $12M',
          valores: ['Entre $12.000.000 y $15.000.000', 'Más de $15.000.000'],
        },
        { clave: 'pie_desde_15m', nombre: 'Desde $15M', valores: ['Más de $15.000.000'] },
      ],
    },
  ],
  retirar: [],
};

// Inspira son preguntas CATEGÓRICAS, no ordinales: no hay «desde X» que valga, así
// que el atajo correcto es un segmento por respuesta y no un acumulado.
const inspiraCampos: { clave: string; nombre: string; claveOrigen: string; valores: string[] }[] = [
  {
    clave: 'ubicacion',
    nombre: 'Where are you based?',
    claveOrigen: 'where_are_you_based',
    valores: [
      'Mexico City',
      'Los Angeles',
      'Baja California',
      'San Francisco / Bay Area',
      'Monterrey / Guadalajara',
      'Other',
    ],
  },
  {
    clave: 'prioridad',
    nombre: 'What matters most right now?',
    claveOrigen: 'what_matters_most_to_you_right_now',
    valores: [
      'Finding my place in Baja before it peaks',
      'Just exploring, no rush',
      "The community — who's already in",
      'Understanding how ownership works for non-Mexicans',
    ],
  },
  {
    clave: 'canal',
    nombre: 'How did you hear about us?',
    claveOrigen: 'how_did_you_hear_about_munity_iii',
    valores: [
      'Instagram / Facebook',
      'LinkedIn',
      'Search / Online',
      'A friend / colleague mentioned it',
      'Other',
    ],
  },
  {
    clave: 'perfil',
    nombre: 'How would you describe yourself?',
    claveOrigen: 'how_would_you_best_describe_yourself',
    valores: [
      'Creative / Director / Artist',
      'Executive (C-level / Director)',
      'Founder / Co-Founder',
      'Investor / Family Office',
      'Other',
    ],
  },
];

const inspira: PlanCliente = {
  nombre: 'Inspira',
  clienteId: CLIENTES.inspira,
  campos: inspiraCampos.map((c) => ({
    campo: {
      clave: c.clave,
      nombre: c.nombre,
      claves_origen: [c.claveOrigen],
      valores_map: mapa([
        ...c.valores.map((v) => [[v], v] as [string[], string]),
        // El relleno del desplegable se aparta en las cuatro preguntas.
        [['Select an option'], '(sin respuesta)'],
      ]),
      valores_orden: c.valores,
      sin_mapear: 'otros',
    },
    segmentos: [],
  })),
  retirar: [],
  notas: [
    'Preguntas categóricas, no ordinales: no se crean acumulados «desde X».',
    'Para medirlas por separado, usa «Una métrica por respuesta» en la ficha.',
  ],
};

const PLANES: PlanCliente[] = [goodprop, cris, somosRentable, surProfundo, inspira];

// ════════════════════════════════════════════════════════════════
// Reescritura de las fórmulas ya guardadas
// ════════════════════════════════════════════════════════════════
//
// La pestaña «Evergreen Captacion» de Goodprop mide con las claves de los
// campos-contador. Seis, y tres de ellas son FUGA: con `sin_mapear: 'crudo'`, las
// respuestas que el campo no mapeaba se colaron como buckets sueltos, así que
// `lf__leads_desde1_6m__menos_de_1_300_000` existe aunque ese campo se creó para
// contar «desde 1.6M».
//
// Cada una tiene su equivalente exacto en el modelo nuevo: las tres que eran un
// umbral pasan a su segmento, y las tres fugas pasan a la respuesta del campo
// unificado, que es lo que siempre quisieron decir.

/** Slug de respuesta del campo nuevo, calculado igual que en el dashboard. */
const gpClaves = new Map(
  clavesDeCampo({ clave: goodpropRango.clave, buckets: GP_ORDEN }).map((c) => [c.bucket, c.clave])
);

const REESCRITURAS: Record<string, string> = {
  lf__leads_totales__leads_totales: 'lseg__respondieron_rango',
  lf__leads_desde_1_3m__leads_desde_1_3m: 'lseg__ingresos_desde_1_3m',
  lf__leads_desde1_6m__leads_1_6m: 'lseg__ingresos_desde_1_6m',
  lf__leads_desde_2m__leads_2m: 'lseg__ingresos_desde_2m',
  // Fugas de `sin_mapear: 'crudo'` → la respuesta del campo unificado.
  lf__leads_desde1_6m__menos_de_1_300_000: gpClaves.get(GP.menos13)!,
  lf__leads_desde1_6m__entre_1_000_000_y_1_300_000: gpClaves.get(GP.de1a13)!,
};

/** Tablas con layouts que pueden llevar fórmulas. */
const TABLAS_LAYOUT = ['cliente_tabs', 'clientes_layouts', 'tab_templates'] as const;

/** Columnas JSONB de esas tablas donde vive una fórmula. */
const COLS_LAYOUT = [
  'columnas',
  'tarjetas',
  'graficos',
  'text_blocks',
  'custom_metrics',
  'tablas',
  'ranking_tables',
  'lead_answer_blocks',
];

// ════════════════════════════════════════════════════════════════

/** Tokens que quedarían colgando si se retira una clave. */
function tokensDe(clave: string): string[] {
  return [`leadfield:${clave}`, `lf__${clave}__`];
}

/**
 * ¿Algún informe o layout guardado referencia lo que vamos a retirar?
 *
 * Sin esta comprobación, desactivar un campo dejaría un widget midiendo 0 sin que
 * nada avisara. Hoy solo «Reporte de calidad Goodprop» usa un token
 * `leadfield:`, y apunta a `rango_de_ingresos`, que se conserva.
 */
async function referenciasVivas(retirar: { cliente: string; clave: string }[]): Promise<string[]> {
  if (retirar.length === 0) return [];
  const hallazgos: string[] = [];

  // Una referencia que la reescritura sabe traducir no es un problema: se
  // arregla en el mismo paso. Lo que aborta es la que se quedaría colgando.
  const traducibles = new Set(Object.keys(REESCRITURAS));
  const sinTraducir = (txt: string, clave: string) => {
    for (const t of tokensDe(clave)) {
      if (!txt.includes(t)) continue;
      // De todas las apariciones de ese prefijo, ¿queda alguna que no
      // esté en el mapa de reescritura?
      const usos = txt.match(new RegExp(`lf__${clave}__[a-z0-9_]+`, 'g')) ?? [];
      if (t.startsWith('leadfield:')) return true;
      if (usos.some((u) => !traducibles.has(u))) return true;
    }
    return false;
  };

  const { data: informes } = await pub.from('bi_reports').select('id,nombre,layout');
  for (const r of (informes ?? []) as any[]) {
    const txt = JSON.stringify(r.layout ?? {});
    for (const { cliente, clave } of retirar) {
      if (sinTraducir(txt, clave)) {
        hallazgos.push(`informe «${r.nombre}» (${r.id}) usa ${clave} [${cliente}]`);
      }
    }
  }

  for (const tabla of TABLAS_LAYOUT) {
    const { data } = await pub.from(tabla).select('*');
    for (const fila of (data ?? []) as any[]) {
      const txt = JSON.stringify(fila);
      for (const { cliente, clave } of retirar) {
        if (sinTraducir(txt, clave)) {
          hallazgos.push(`${tabla} ${fila.id} usa ${clave} [${cliente}]`);
        }
      }
    }
  }
  return hallazgos;
}

/** Sustituye los tokens viejos por los nuevos en el texto de una columna JSONB. */
function reescribir(txt: string): string {
  // De más largo a más corto: si un token fuera prefijo de otro, reemplazar el
  // corto primero partiría el largo por la mitad.
  const claves = Object.keys(REESCRITURAS).sort((a, b) => b.length - a.length);
  let out = txt;
  for (const k of claves) out = out.split(k).join(REESCRITURAS[k]);
  return out;
}

/**
 * Reescribe las fórmulas de los layouts guardados. Devuelve las filas tocadas
 * (con su contenido previo) para poder revertirlas.
 */
async function reescribirLayouts(soloInforme: boolean): Promise<any[]> {
  const tocadas: any[] = [];

  for (const tabla of TABLAS_LAYOUT) {
    const { data } = await pub.from(tabla).select('*');
    for (const fila of (data ?? []) as any[]) {
      const cambios: Record<string, unknown> = {};
      const previo: Record<string, unknown> = {};
      for (const col of COLS_LAYOUT) {
        if (!(col in fila) || fila[col] == null) continue;
        const txt = JSON.stringify(fila[col]);
        const nuevo = reescribir(txt);
        if (nuevo === txt) continue;
        previo[col] = fila[col];
        cambios[col] = JSON.parse(nuevo);
      }
      if (Object.keys(cambios).length === 0) continue;

      console.log(
        `  ${soloInforme ? 'se reescribiría' : 'reescrito'} ${tabla} ${fila.id}` +
          `${fila.nombre ? ` «${fila.nombre}»` : ''} · ${Object.keys(cambios).join(', ')}`
      );
      if (soloInforme) continue;

      const { error } = await pub.from(tabla).update(cambios).eq('id', fila.id);
      if (error) {
        console.log(`  ✗ ${error.message}`);
        continue;
      }
      tocadas.push({ tabla, id: fila.id, previo });
    }
  }
  return tocadas;
}

async function main() {
  if (REVERTIR) return revertir(REVERTIR);

  console.log(
    APLICAR ? '\n══ APLICANDO ══\n' : '\n══ Informe en seco. Añade --aplicar para escribir ══\n'
  );

  const copia: any = {
    creado: new Date().toISOString(),
    campos: [],
    segmentosCreados: [],
    layouts: [],
  };
  const aRetirar: { cliente: string; clave: string }[] = [];

  for (const plan of PLANES) {
    console.log(`\n──────── ${plan.nombre} ────────`);
    const { data: existentes } = await db
      .from('lead_campos')
      .select('*')
      .eq('cliente_id', plan.clienteId);
    const porClave = new Map(((existentes ?? []) as any[]).map((c) => [c.clave, c]));

    for (const { campo, segmentos } of plan.campos) {
      const previo = porClave.get(campo.clave);
      const buckets = [...new Set(Object.values(campo.valores_map))];
      console.log(`\n  leadfield:${campo.clave} — ${campo.nombre}`);
      console.log(
        `     ${previo ? 'existe' : 'NUEVO'} · ${Object.keys(campo.valores_map).length} valores → ${buckets.length} buckets`
      );
      console.log(`     orden: ${campo.valores_orden.join(' < ')}`);
      for (const s of segmentos) {
        console.log(`     · lseg__${s.clave} «${s.nombre}» = ${s.valores.length} bucket(s)`);
      }
    }

    for (const clave of plan.retirar) {
      const previo = porClave.get(clave);
      console.log(
        `\n  retirar leadfield:${clave} — ${previo ? 'se desactiva' : 'no existe, nada que hacer'}`
      );
      if (previo?.activo) aRetirar.push({ cliente: plan.nombre, clave });
    }

    for (const nota of plan.notas ?? []) console.log(`  ⚠ ${nota}`);
  }

  console.log('\n──────── Eduversio ────────');
  console.log('  Nada que configurar, y no es un olvido: 41.569 leads en el último año');
  console.log('  y NINGUNA pregunta de opción — sus formularios solo piden nombre y correo.');

  const refs = await referenciasVivas(aRetirar);
  if (refs.length > 0) {
    console.log('\n❌ Hay widgets guardados que usan lo que se iba a retirar:');
    for (const r of refs) console.log(`   · ${r}`);
    console.log('   Actualízalos primero. No se ha escrito nada.');
    process.exit(1);
  }
  console.log('\n✓ Ninguna referencia se quedaría colgando.');

  console.log('\n──────── Fórmulas guardadas ────────');
  for (const [viejo, nuevo] of Object.entries(REESCRITURAS)) {
    console.log(`  ${viejo}  →  ${nuevo}`);
  }
  if (!APLICAR) {
    await reescribirLayouts(true);
    console.log('\nInforme terminado. Nada escrito.\n');
    return;
  }

  // ── Escritura ──
  for (const plan of PLANES) {
    const { data: existentes } = await db
      .from('lead_campos')
      .select('*')
      .eq('cliente_id', plan.clienteId);
    const porClave = new Map(((existentes ?? []) as any[]).map((c) => [c.clave, c]));

    for (const [i, { campo, segmentos }] of plan.campos.entries()) {
      const previo = porClave.get(campo.clave);
      const payload = {
        cliente_id: plan.clienteId,
        nombre: campo.nombre,
        descripcion: campo.descripcion ?? null,
        claves_origen: campo.claves_origen,
        valores_map: campo.valores_map,
        valores_orden: campo.valores_orden,
        sin_mapear: campo.sin_mapear,
        activo: true,
        orden: i,
      };

      let campoId: string;
      if (previo) {
        copia.campos.push(previo);
        const { error } = await db.from('lead_campos').update(payload).eq('id', previo.id);
        if (error) {
          console.log(`✗ ${campo.clave}: ${error.message}`);
          continue;
        }
        campoId = previo.id;
        console.log(`✓ actualizado leadfield:${campo.clave}`);
      } else {
        const { data, error } = await db
          .from('lead_campos')
          .insert({ ...payload, clave: campo.clave })
          .select('id')
          .single();
        if (error || !data) {
          console.log(`✗ ${campo.clave}: ${error?.message}`);
          continue;
        }
        campoId = (data as any).id;
        copia.campos.push({ id: campoId, __creado: true });
        console.log(`✓ creado leadfield:${campo.clave}`);
      }

      for (const [j, s] of segmentos.entries()) {
        const clave = slugCampo(s.clave);
        const { data, error } = await db
          .from('lead_campo_segmentos')
          .upsert(
            {
              cliente_id: plan.clienteId,
              campo_id: campoId,
              clave,
              nombre: s.nombre,
              descripcion: s.descripcion ?? null,
              operador: 'in',
              valores: s.valores,
              activo: true,
              orden: j,
            },
            { onConflict: 'cliente_id,clave' }
          )
          .select('id')
          .single();
        if (error) {
          console.log(`  ✗ lseg__${clave}: ${error.message}`);
          continue;
        }
        copia.segmentosCreados.push((data as any).id);
        console.log(`  ✓ lseg__${clave} «${s.nombre}»`);
      }
    }

    for (const clave of plan.retirar) {
      const previo = porClave.get(clave);
      if (!previo?.activo) continue;
      copia.campos.push(previo);
      const { error } = await db.from('lead_campos').update({ activo: false }).eq('id', previo.id);
      console.log(error ? `✗ retirar ${clave}: ${error.message}` : `✓ retirado leadfield:${clave}`);
    }
  }

  // Las fórmulas se reescriben DESPUÉS de crear los segmentos: si se hiciera
  // antes, la pestaña apuntaría un instante a un `lseg__` que todavía no existe.
  console.log('\n──────── Fórmulas guardadas ────────');
  copia.layouts = await reescribirLayouts(false);

  mkdirSync('backups', { recursive: true });
  const ruta = `backups/segmentos-lead-${Date.now()}.json`;
  writeFileSync(ruta, JSON.stringify(copia, null, 2));
  console.log(`\nCopia de seguridad: ${ruta}`);
  console.log(`Revertir con: npx tsx scripts/migrar-segmentos-lead.ts --revertir ${ruta}\n`);
}

async function revertir(ruta: string) {
  const copia = JSON.parse(readFileSync(ruta, 'utf8'));
  console.log(`\n══ REVIRTIENDO desde ${ruta} ══\n`);

  for (const l of copia.layouts ?? []) {
    const { error } = await pub.from(l.tabla).update(l.previo).eq('id', l.id);
    console.log(
      error ? `✗ ${l.tabla} ${l.id}: ${error.message}` : `✓ ${l.tabla} ${l.id} restaurado`
    );
  }

  for (const id of copia.segmentosCreados ?? []) {
    const { error } = await db.from('lead_campo_segmentos').delete().eq('id', id);
    console.log(error ? `✗ segmento ${id}: ${error.message}` : `✓ segmento ${id} borrado`);
  }

  for (const fila of copia.campos ?? []) {
    if (fila.__creado) {
      const { error } = await db.from('lead_campos').delete().eq('id', fila.id);
      console.log(error ? `✗ campo ${fila.id}: ${error.message}` : `✓ campo ${fila.id} borrado`);
      continue;
    }
    const { id, ...resto } = fila;
    const { error } = await db.from('lead_campos').update(resto).eq('id', id);
    console.log(error ? `✗ campo ${id}: ${error.message}` : `✓ campo ${id} restaurado`);
  }
  console.log('\nHecho.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
