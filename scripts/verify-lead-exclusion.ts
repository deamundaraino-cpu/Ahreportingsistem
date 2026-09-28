/**
 * Comprobaciones de la regla de exclusión de leads (`lead-exclusion.ts`).
 *
 * Todo es puro: la regla decide sola si un lead cuenta, sin Postgres. Los casos
 * reproducen lo que se vio en la reunión del 2026-09-08 en Cris Tributario —
 * contacto de WhatsApp directo, perfil de Instagram, formulario con UTMs y lead
 * de anuncio con solo el ID— más los que romperían el conteo si nadie los mira.
 *
 *   npx tsx --conditions=react-server scripts/verify-lead-exclusion.ts
 */

import {
  leerRegla,
  motivoExclusion,
  evaluarExclusion,
  aplicarExclusion,
  tieneAtribucion,
  reglaTieneEfecto,
  serializarRegla,
  mismaRegla,
  columnasParaRegla,
  cumpleCondicion,
  CAMPOS_REGLA,
  ID_DUPLICADO,
  REGLA_VACIA,
  MOTIVOS_AUTOMATICOS,
  MOTIVOS_EXCLUSION,
  columnaExcluidoDisponible,
  filtroLeadsQueCuentan,
  _reiniciarDeteccionColumna,
  type CondicionRegla,
  type ReglaExclusion,
} from '../src/lib/report-utm/lead-exclusion';
import {
  claveEmail,
  claveTelefono,
  clavesContacto,
  excluirDuplicadosLote,
  _reiniciarDeteccionRpc,
} from '../src/lib/report-utm/lead-duplicados';
import { clasificarLeads } from '../src/lib/report-utm/lead-exclusion-db';
import { agregarValoresRegla } from '../src/lib/report-utm/lead-regla-valores';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────
const WHATSAPP_DIRECTO = { utm_source: null, form_name: 'WhatsApp' };
const PERFIL_IG = { utm_source: 'instagram', utm_medium: 'social', form_name: 'Social media' };
const FORMULARIO_CON_UTM = {
  utm_source: 'instagram_reels',
  utm_medium: 'instagram',
  utm_campaign: 'Beneficios tributarios',
  utm_content: 'ad 4 agosto',
  utm_term: 'Conjunto inversionistas',
  form_name: 'Formulario landing',
};
const SOLO_ID_ANUNCIO = { utm_id: '120212345678901234', utm_source: 'facebook' };
const SOLO_CLICK_ID = { click_id: 'fbclid.abc', utm_source: null };

const REGLA_CRIS = leerRegla({
  filtro_atribucion: { activa: true, exigir_atribucion: true },
});

// ── 1. Lectura tolerante del config ───────────────────────────────────
console.log('\n1. Lectura del config del cliente');
check('config ausente → regla vacía', !reglaTieneEfecto(leerRegla(null)));
check('config sin la clave → regla vacía', !reglaTieneEfecto(leerRegla({ logo_url: 'x' })));
check(
  'config roto (string) → regla vacía',
  !reglaTieneEfecto(leerRegla({ filtro_atribucion: 'sí' }))
);
check(
  'activa pero sin criterios → no excluye nada',
  !reglaTieneEfecto(leerRegla({ filtro_atribucion: { activa: true } }))
);
check(
  'criterios pero apagada → no excluye nada',
  !reglaTieneEfecto(leerRegla({ filtro_atribucion: { exigir_atribucion: true } }))
);
const reglaListas = leerRegla({
  filtro_atribucion: {
    activa: true,
    excluir_sources: [' Instagram ', 'INSTAGRAM', '', null, 'whatsapp'],
    excluir_formularios: ['Chat Widget'],
  },
});
check(
  'la lista v1 de fuentes pasa a UNA condición «es» (sin vacíos, sin duplicados)',
  reglaListas.condiciones.length === 2 &&
    reglaListas.condiciones[0].campo === 'utm_source' &&
    reglaListas.condiciones[0].op === 'eq' &&
    JSON.stringify(reglaListas.condiciones[0].valores.map((v) => v.toLowerCase())) ===
      JSON.stringify(['instagram', 'whatsapp']),
  JSON.stringify(reglaListas.condiciones)
);
check(
  'y la de formularios a una condición «contiene»',
  reglaListas.condiciones[1].campo === 'form_name' && reglaListas.condiciones[1].op === 'contains'
);
check(
  'activa: solo el booleano true cuenta',
  leerRegla({ filtro_atribucion: { activa: 'true', exigir_atribucion: true } }).activa === false
);

// ── 2. Qué es «tener atribución» ──────────────────────────────────────
console.log('\n2. Señal de atribución');
check('WhatsApp directo no tiene atribución', !tieneAtribucion(WHATSAPP_DIRECTO));
check(
  'el perfil de Instagram (solo source/medium) no tiene atribución',
  !tieneAtribucion(PERFIL_IG)
);
check('el formulario con UTMs sí', tieneAtribucion(FORMULARIO_CON_UTM));
check('el ID de anuncio en utm_id basta', tieneAtribucion(SOLO_ID_ANUNCIO));
check('el click id basta (fbclid/gclid)', tieneAtribucion(SOLO_CLICK_ID));
check('espacios en blanco no cuentan como valor', !tieneAtribucion({ utm_campaign: '   ' }));

// ── 3. La regla de Cris: exigir atribución ────────────────────────────
console.log('\n3. Regla «exigir atribución»');
check(
  'WhatsApp directo queda fuera por sin_atribucion',
  motivoExclusion(WHATSAPP_DIRECTO, REGLA_CRIS) === 'sin_atribucion'
);
check(
  'perfil de Instagram queda fuera por sin_atribucion',
  motivoExclusion(PERFIL_IG, REGLA_CRIS) === 'sin_atribucion'
);
check('formulario con UTMs cuenta', motivoExclusion(FORMULARIO_CON_UTM, REGLA_CRIS) === null);
check(
  'lead de anuncio con solo el ID cuenta',
  motivoExclusion(SOLO_ID_ANUNCIO, REGLA_CRIS) === null
);
check(
  'sin regla (REGLA_VACIA) nunca se excluye',
  motivoExclusion(WHATSAPP_DIRECTO, REGLA_VACIA) === null
);

// ── 4. Listas de fuentes y formularios ────────────────────────────────
console.log('\n4. Listas de exclusión');
check(
  'la fuente se compara exacta y sin mayúsculas',
  motivoExclusion({ utm_campaign: 'x', utm_source: 'WhatsApp' }, reglaListas) === 'source_excluida'
);
check(
  'una fuente que solo CONTIENE el texto no se excluye',
  motivoExclusion({ utm_campaign: 'x', utm_source: 'instagram_reels' }, reglaListas) === null
);
check(
  'el formulario se compara por fragmento',
  motivoExclusion({ utm_campaign: 'x', form_name: 'GHL chat widget v2' }, reglaListas) ===
    'formulario_excluido'
);
const ambas = leerRegla({
  filtro_atribucion: { activa: true, exigir_atribucion: true, excluir_sources: ['instagram'] },
});
check(
  'sin atribución manda sobre fuente excluida (el motivo más útil)',
  motivoExclusion(PERFIL_IG, ambas) === 'sin_atribucion'
);

// ── 5. Marcado de la fila ─────────────────────────────────────────────
console.log('\n5. Marcado de la fila');
const fila = { cliente_id: 'c1', ...WHATSAPP_DIRECTO };
const marcada = aplicarExclusion(fila, REGLA_CRIS, '2026-09-12T00:00:00.000Z');
check('la fila excluida lleva excluido = true', marcada.excluido === true);
check('y su motivo', marcada.excluido_motivo === 'sin_atribucion');
check('y cuándo', marcada.excluido_at === '2026-09-12T00:00:00.000Z');
check('no se muta la fila original', !('excluido' in fila));
const limpia = aplicarExclusion({ cliente_id: 'c1', ...FORMULARIO_CON_UTM }, REGLA_CRIS);
check(
  'una fila que cuenta NO lleva la columna (el INSERT funciona sin la migración 079)',
  !('excluido' in limpia) && !('excluido_motivo' in limpia)
);
check(
  'no se excluye nunca a mano desde la regla',
  !MOTIVOS_AUTOMATICOS.includes('manual') && 'manual' in MOTIVOS_EXCLUSION
);

// ── 6. Detección de la migración 079 ──────────────────────────────────
console.log('\n6. Detección de la columna');
function dbFalsa(respuesta: { error: { code?: string } | null }) {
  let llamadas = 0;
  const db = {
    llamadas: () => llamadas,
    schema: () => db,
    from: () => ({
      select: () => ({
        limit: async () => {
          llamadas++;
          return respuesta;
        },
      }),
    }),
  };
  return db;
}

async function comprobarDeteccion() {
  _reiniciarDeteccionColumna();
  const sin = dbFalsa({ error: { code: '42703' } });
  check('sin la columna → false', (await columnaExcluidoDisponible(sin)) === false);
  await columnaExcluidoDisponible(sin);
  check('el «no existe» se cachea (no se pregunta en cada lectura)', sin.llamadas() === 1);

  _reiniciarDeteccionColumna();
  const red = dbFalsa({ error: { code: 'ECONNRESET' } });
  await columnaExcluidoDisponible(red);
  await columnaExcluidoDisponible(red);
  check('un error de red NO se cachea como «no existe»', red.llamadas() === 2);

  _reiniciarDeteccionColumna();
  const con = dbFalsa({ error: null });
  check('con la columna → true', (await columnaExcluidoDisponible(con)) === true);
  await columnaExcluidoDisponible(con);
  check('el «existe» se cachea', con.llamadas() === 1);
  _reiniciarDeteccionColumna();
}

// ── 7. El filtro devuelve el builder, no lo ejecuta ───────────────────
//
// La API anterior (`q = await soloLeadsQueCuentan(db, q)`) era async y devolvía
// el builder, que es un thenable: el `await` lo ejecutaba y entregaba
// `{ data, error }`, y el `.limit()` siguiente reventaba en `medirCruce`.

/** Builder de mentira con la forma de PostgREST: encadenable y thenable. */
function builderFalso() {
  const estado = { ejecutada: 0, filtros: [] as Array<[string, unknown]> };
  const b = {
    estado,
    eq(c: string, v: unknown) {
      estado.filtros.push([c, v]);
      return b;
    },
    limit() {
      return b;
    },
    then(resolver: (r: { data: unknown[]; error: null }) => unknown) {
      estado.ejecutada++;
      return Promise.resolve(resolver({ data: [], error: null }));
    },
  };
  return b;
}

async function comprobarFiltroNoEjecuta() {
  console.log('\n7. El filtro no ejecuta la consulta');

  _reiniciarDeteccionColumna();
  const cuentan = await filtroLeadsQueCuentan(dbFalsa({ error: null }));
  check(
    'el `await` entrega el filtro, no algo thenable',
    typeof (cuentan as { then?: unknown }).then !== 'function'
  );
  check('con la columna, el filtro está activo', cuentan.activo === true);

  const q = builderFalso();
  const r = cuentan.aplicar(q);
  check('aplicar devuelve el MISMO builder', r === q);
  check('sigue siendo un builder: `.limit()` existe', typeof r.limit === 'function');
  check('y NO se ha ejecutado', q.estado.ejecutada === 0);
  check(
    'con `excluido = false` puesto',
    JSON.stringify(q.estado.filtros) === JSON.stringify([['excluido', false]])
  );

  let avisa = false;
  try {
    cuentan.aplicar({ data: [], error: null } as unknown as ReturnType<typeof builderFalso>);
  } catch (e) {
    avisa = e instanceof TypeError;
  }
  check('pasarle un resultado ya ejecutado lanza un TypeError claro', avisa);

  _reiniciarDeteccionColumna();
  const sinColumna = await filtroLeadsQueCuentan(dbFalsa({ error: { code: '42703' } }));
  const q2 = builderFalso();
  const r2 = sinColumna.aplicar(q2);
  check('sin la columna, el filtro está inactivo', sinColumna.activo === false);
  check(
    'y aplicar deja el builder intacto y sin ejecutar',
    r2 === q2 && q2.estado.filtros.length === 0 && q2.estado.ejecutada === 0
  );

  // Con el builder de verdad de supabase-js. Sin `await` no sale a la red, así
  // que basta con una URL que no responde.
  _reiniciarDeteccionColumna();
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient('http://127.0.0.1:9', 'clave-de-prueba', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const real = sb.schema('report_utm').from('lead_events').select('id').eq('cliente_id', 'c1');
  const rReal = cuentan.aplicar(real);
  const url = String((rReal as unknown as { url?: URL }).url ?? '');
  check(
    'con el builder real de supabase-js sigue siendo builder (`.limit()` encadena)',
    rReal === real &&
      typeof rReal.limit === 'function' &&
      typeof rReal.limit(1).range === 'function'
  );
  check('y lleva el filtro en la URL', url.includes('excluido=eq.false'), url);
  _reiniciarDeteccionColumna();
}

// ── 8. Regla v2: condiciones ──────────────────────────────────────────
function cond(c: Omit<CondicionRegla, 'id'> & { id?: string }): CondicionRegla {
  return { id: c.id ?? `t-${c.campo}-${c.op}`, ...c };
}
function reglaCon(condiciones: CondicionRegla[], extra: Partial<ReglaExclusion> = {}) {
  return leerRegla({
    filtro_atribucion: { activa: true, condiciones, ...extra },
  });
}

function comprobarCondiciones() {
  console.log('\n8. Condiciones (regla v2)');

  // Lectura y compatibilidad
  const v2 = leerRegla({
    filtro_atribucion: {
      activa: true,
      condiciones: [
        { id: 'a', campo: 'utm_campaign', op: 'eq', valores: ['Test', 'test', ' '] },
        { id: 'b', campo: 'inventado', op: 'eq', valores: ['x'] },
        { id: 'c', campo: 'ip_country', op: 'raro', valores: ['CO'] },
        { id: 'd', campo: 'utm_medium', op: 'eq', valores: [] },
        { id: 'e', campo: 'respuesta', op: 'eq', valores: ['x'] },
        { id: 'f', campo: 'ip_country', op: 'vacio', valores: ['ignorado'] },
        { id: 'a', campo: 'nombre', op: 'contains', valores: ['prueba'] },
      ],
      excluir_sources: ['esto-se-ignora'],
    },
  });
  check(
    'campo u operador desconocido, sin valores o respuesta sin pregunta → condición descartada',
    v2.condiciones.map((c) => c.campo).join(',') === 'utm_campaign,ip_country,nombre',
    JSON.stringify(v2.condiciones)
  );
  check(
    'los valores repetidos (sin distinguir mayúsculas) se funden y se conserva la forma escrita',
    JSON.stringify(v2.condiciones[0].valores) === JSON.stringify(['Test'])
  );
  check('«está vacío» no lleva valores', v2.condiciones[1].valores.length === 0);
  check('ids repetidos se desambiguan', new Set(v2.condiciones.map((c) => c.id)).size === 3);
  check(
    'con `condiciones`, las listas v1 se ignoran (son solo copia de compatibilidad)',
    !v2.condiciones.some((c) => c.valores.includes('esto-se-ignora'))
  );
  check(
    'activa con solo «excluir duplicados» tiene efecto',
    reglaTieneEfecto(leerRegla({ filtro_atribucion: { activa: true, excluir_duplicados: true } }))
  );

  // Serialización: ida y vuelta, y copia v1 para instancias viejas
  const s = serializarRegla(
    reglaCon([
      cond({ id: 'f1', campo: 'utm_source', op: 'eq', valores: ['WhatsApp'] }),
      cond({ id: 'f2', campo: 'form_name', op: 'contains', valores: ['UTM - Report'] }),
      cond({ id: 'f3', campo: 'utm_campaign', op: 'eq', valores: ['Test'] }),
    ])
  );
  check(
    'serializar escribe las listas v1 con lo expresable en ellas (en minúsculas)',
    JSON.stringify(s.excluir_sources) === JSON.stringify(['whatsapp']) &&
      JSON.stringify(s.excluir_formularios) === JSON.stringify(['utm - report'])
  );
  const vuelta = leerRegla({ filtro_atribucion: s });
  check(
    'leer lo serializado da la misma regla',
    mismaRegla(vuelta, reglaCon(vuelta.condiciones)) && vuelta.condiciones.length === 3
  );
  check(
    'mismaRegla detecta un cambio de valores',
    !mismaRegla(
      reglaCon([cond({ campo: 'utm_campaign', op: 'eq', valores: ['A'] })]),
      reglaCon([cond({ campo: 'utm_campaign', op: 'eq', valores: ['B'] })])
    )
  );

  // La regla v1 del cliente de la captura: mismo motivo antes y después
  const v1 = leerRegla({
    filtro_atribucion: { activa: true, excluir_formularios: ['UTM - Report'] },
  });
  const leadReport = { utm_campaign: 'x', form_name: 'UTM - Report Landing' };
  check(
    'la regla v1 convertida excluye igual y con el MISMO motivo (reaplicar no mueve nada)',
    motivoExclusion(leadReport, v1) === 'formulario_excluido'
  );

  // Operadores
  const lead = {
    utm_campaign: 'Black Friday 2026',
    utm_term: 'Conjunto Frío',
    utm_content: 'Video 3',
    utm_medium: 'paid_social',
    ip_country: 'CO',
    form_plugin: 'gohighlevel',
    lead_email: 'Juan@FullyClub.agency',
    lead_phone: '+57 300-123-4567',
    lead_name: 'Prueba Juan',
    raw_fields: { 'Presupuesto ': 'Menos de 500', Intereses: ['Cursos', 'Mentoría'] },
    custom_data: { tags: ['Cliente', 'no-contactar'] },
  };
  const t = (c: Omit<CondicionRegla, 'id'>) => cumpleCondicion(lead, cond(c));
  check(
    'es: exacto sin mayúsculas',
    t({ campo: 'utm_campaign', op: 'eq', valores: ['black friday 2026'] })
  );
  check('es: no por fragmento', !t({ campo: 'utm_campaign', op: 'eq', valores: ['black friday'] }));
  check('contiene', t({ campo: 'utm_campaign', op: 'contains', valores: ['FRIDAY'] }));
  check('empieza por', t({ campo: 'utm_term', op: 'starts', valores: ['conjunto'] }));
  check('termina en', t({ campo: 'utm_content', op: 'ends', valores: [' 3'] }));
  check('no es (con dato distinto)', t({ campo: 'ip_country', op: 'neq', valores: ['CL'] }));
  check(
    'no es (con el mismo dato) no atrapa',
    !t({ campo: 'ip_country', op: 'neq', valores: ['co'] })
  );
  check(
    'no es: atrapa también los SIN dato',
    cumpleCondicion({}, cond({ campo: 'ip_country', op: 'neq', valores: ['CO'] }))
  );
  check('no contiene', t({ campo: 'utm_medium', op: 'ncontains', valores: ['organic'] }));
  check('está vacío (con dato) no atrapa', !t({ campo: 'ip_country', op: 'vacio', valores: [] }));
  check(
    'está vacío (sin dato, o solo espacios) atrapa',
    cumpleCondicion({ ip_country: '  ' }, cond({ campo: 'ip_country', op: 'vacio', valores: [] }))
  );
  check('origen (form_plugin)', t({ campo: 'form_plugin', op: 'eq', valores: ['GoHighLevel'] }));

  // Campos especiales
  check(
    'respuesta: la clave se encuentra sin distinguir espacios ni mayúsculas',
    t({ campo: 'respuesta', clave: 'presupuesto', op: 'eq', valores: ['menos de 500'] })
  );
  check(
    'respuesta multiselección: basta con una opción',
    t({ campo: 'respuesta', clave: 'Intereses', op: 'eq', valores: ['mentoría'] })
  );
  check(
    'respuesta de otra pregunta no atrapa',
    !t({ campo: 'respuesta', clave: 'Ciudad', op: 'eq', valores: ['menos de 500'] })
  );
  check(
    'etiqueta GHL (custom_data.tags)',
    t({ campo: 'etiqueta', op: 'eq', valores: ['NO-CONTACTAR'] })
  );
  check(
    'etiqueta también desde el alias `tags` del histórico',
    cumpleCondicion({ tags: ['vip'] }, cond({ campo: 'etiqueta', op: 'eq', valores: ['vip'] }))
  );
  check('email por dominio', t({ campo: 'email', op: 'contains', valores: ['@fullyclub.agency'] }));
  check('nombre de prueba', t({ campo: 'nombre', op: 'contains', valores: ['prueba'] }));
  check(
    'teléfono: se comparan solo dígitos',
    t({ campo: 'telefono', op: 'contains', valores: ['300 123 4567'] })
  );
  check(
    'teléfono: un valor sin dígitos no atrapa a nadie',
    !t({ campo: 'telefono', op: 'contains', valores: ['abc'] })
  );

  // Motivos y prioridad
  const regla = reglaCon(
    [
      cond({ id: 'pais', campo: 'ip_country', op: 'eq', valores: ['CO'] }),
      cond({ id: 'camp', campo: 'utm_campaign', op: 'contains', valores: ['friday'] }),
    ],
    { exigir_atribucion: true }
  );
  const ev = evaluarExclusion(lead, regla);
  check(
    'la primera condición que se cumple decide motivo e id',
    ev?.motivo === 'pais_excluido' && ev.condicionId === 'pais',
    JSON.stringify(ev)
  );
  check(
    'sin atribución sigue mandando sobre las condiciones',
    motivoExclusion({ ip_country: 'CO' }, regla) === 'sin_atribucion'
  );
  check(
    'cada familia de campo tiene su motivo y todos son automáticos',
    (Object.keys(CAMPOS_REGLA) as Array<keyof typeof CAMPOS_REGLA>).every(
      (k) =>
        CAMPOS_REGLA[k].motivo in MOTIVOS_EXCLUSION &&
        MOTIVOS_AUTOMATICOS.includes(CAMPOS_REGLA[k].motivo)
    ) && MOTIVOS_AUTOMATICOS.includes('duplicado')
  );
  check(
    'apagada no excluye aunque haya condiciones',
    motivoExclusion(lead, { ...regla, activa: false }) === null
  );

  // Columnas del histórico
  const sinJson = columnasParaRegla(
    reglaCon([cond({ campo: 'utm_campaign', op: 'eq', valores: ['x'] })])
  );
  const conJson = columnasParaRegla(
    reglaCon([
      cond({ id: 'r', campo: 'respuesta', clave: 'P', op: 'eq', valores: ['x'] }),
      cond({ id: 't', campo: 'etiqueta', op: 'eq', valores: ['x'] }),
    ])
  );
  check(
    'el histórico solo pide los JSONB cuando hacen falta',
    !sinJson.includes('raw_fields') &&
      !sinJson.some((c) => c.includes('custom_data')) &&
      conJson.includes('raw_fields') &&
      conJson.includes('tags:custom_data->tags')
  );
}

// ── 9. Duplicados ─────────────────────────────────────────────────────
async function comprobarDuplicados() {
  console.log('\n9. Duplicados («cuenta el primero»)');

  check('email: minúsculas y sin espacios', claveEmail('  Ana@Mail.COM ') === 'ana@mail.com');
  check('email sin @ no es clave', claveEmail('ana') === null);
  check(
    'teléfono con y sin prefijo de país → misma clave',
    claveTelefono('+56 9 8765 4321') === claveTelefono('987654321') &&
      claveTelefono('+57 300 123 4567') === claveTelefono('3001234567')
  );
  check('teléfono demasiado corto no es clave', claveTelefono('12345') === null);
  check(
    'claves de un lead',
    JSON.stringify(clavesContacto({ lead_email: 'a@b.co', lead_phone: '3001234567' })) ===
      JSON.stringify(['e:a@b.co', 't:001234567'])
  );

  const dup = reglaCon([], { excluir_duplicados: true });
  const L = (
    id: string,
    fecha: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id,
    created_at: `2026-09-${fecha}T10:00:00Z`,
    excluido: false,
    excluido_motivo: null,
    excluido_por: null,
    utm_campaign: 'c',
    ...extra,
  });

  // Histórico
  const h = clasificarLeads(
    [
      L('3', '03', { lead_email: 'ANA@mail.com' }), // desordenado a propósito
      L('1', '01', { lead_email: 'ana@mail.com' }),
      L('2', '02', { lead_phone: '+57 300 111 2222', lead_email: 'otra@mail.com' }),
      L('4', '04', { lead_phone: '3001112222' }),
    ],
    dup
  );
  const dupIds = h.idsPorMotivo.get('duplicado') ?? [];
  check(
    'cuenta el primero por fecha; los siguientes (email o teléfono) son duplicados',
    JSON.stringify([...dupIds].sort()) === JSON.stringify(['3', '4']),
    JSON.stringify(dupIds)
  );
  check('la previsualización los cuenta en su línea', h.porCondicion[ID_DUPLICADO]?.total === 2);

  const h2 = clasificarLeads(
    [
      L('1', '01', { lead_email: 'ana@mail.com', utm_campaign: null }), // sin atribución
      L('2', '02', { lead_email: 'ana@mail.com' }),
    ],
    reglaCon([], { excluir_duplicados: true, exigir_atribucion: true })
  );
  check(
    'si el primero no cuenta (sin atribución), el segundo SÍ cuenta',
    (h2.idsPorMotivo.get('duplicado') ?? []).length === 0 &&
      (h2.idsPorMotivo.get('sin_atribucion') ?? []).join() === '1'
  );

  const h3 = clasificarLeads(
    [
      L('1', '01', { lead_email: 'ana@mail.com', excluido_por: 'u1' }), // re-incluido a mano
      L('2', '02', { lead_email: 'ana@mail.com' }),
      L('3', '01', {
        lead_email: 'bea@mail.com',
        excluido: true,
        excluido_motivo: 'manual',
        excluido_por: 'u1',
      }),
      L('4', '02', { lead_email: 'bea@mail.com' }),
    ],
    dup
  );
  check(
    'un re-incluido a mano ocupa su email; un excluido a mano no',
    (h3.idsPorMotivo.get('duplicado') ?? []).join() === '2'
  );
  check('las filas manuales no se cuentan como revisadas', h3.revisados === 2);

  const h4 = clasificarLeads(
    [
      L('1', '01', { lead_email: 'ana@mail.com' }),
      L('2', '02', { lead_email: 'ana@mail.com', excluido: true, excluido_motivo: 'duplicado' }),
      L('3', '03', { excluido: true, excluido_motivo: 'pais_excluido' }),
    ],
    reglaCon([])
  );
  check(
    'quitar la casilla re-incluye los duplicados y lo que ya no atrapa ninguna condición',
    JSON.stringify(h4.idsReincluir) === JSON.stringify(['2', '3'])
  );

  const h5 = clasificarLeads(
    [
      L('1', '01', { lead_email: 'ana@mail.com', excluido: true, excluido_motivo: 'duplicado' }),
      L('0', '00', { lead_email: 'ana@mail.com' }),
    ],
    dup
  );
  check(
    'un excluido que sigue excluido por lo mismo cuenta como «ya excluido», no como cambio',
    h5.yaExcluidos === 1 && h5.idsPorMotivo.size === 0 && h5.porCondicion[ID_DUPLICADO].nuevos === 0
  );

  // Ingesta
  _reiniciarDeteccionRpc();
  const llamadas: unknown[] = [];
  const dbCon = (respuesta: { data?: unknown; error?: unknown }) => ({
    rpc: async (_n: string, args: unknown) => {
      llamadas.push(args);
      return { data: respuesta.data ?? null, error: respuesta.error ?? null };
    },
  });
  const filas = [
    { cliente_id: 'c', lead_email: 'ya@existe.com', created_at: '2026-09-02' },
    { cliente_id: 'c', lead_email: 'nuevo@mail.com', created_at: '2026-09-03' },
    { cliente_id: 'c', lead_email: 'NUEVO@mail.com', created_at: '2026-09-04' },
    {
      cliente_id: 'c',
      lead_email: 'ya@existe.com',
      excluido: true,
      excluido_motivo: 'pais_excluido',
    },
  ];
  const r = await excluirDuplicadosLote(
    dbCon({ data: [{ tipo: 'e', clave: 'ya@existe.com' }] }),
    'c',
    filas,
    dup,
    'T'
  );
  check(
    'ingesta: el que ya existe en la base y el repetido dentro del lote se marcan',
    r[0].excluido_motivo === 'duplicado' &&
      !('excluido' in r[1]) &&
      r[2].excluido_motivo === 'duplicado' &&
      r[3].excluido_motivo === 'pais_excluido',
    JSON.stringify(r)
  );
  check('ingesta: no muta las filas de entrada', !('excluido' in filas[0]));

  const sinRegla = await excluirDuplicadosLote(dbCon({}), 'c', filas, reglaCon([]));
  check(
    'ingesta: sin la casilla, no pregunta a la base',
    sinRegla === filas && llamadas.length === 1
  );

  const sinRpc = await excluirDuplicadosLote(
    dbCon({ error: { code: 'PGRST202', message: 'no existe' } }),
    'c',
    filas,
    dup
  );
  check(
    'ingesta sin la migración 093: el lead entra sin marcar (nunca se pierde)',
    sinRpc === filas
  );
  const n = llamadas.length;
  await excluirDuplicadosLote(dbCon({ data: [] }), 'c', filas, dup);
  check('y no vuelve a preguntar por la RPC en un rato', llamadas.length === n);
  _reiniciarDeteccionRpc();
}

// ── 10. Valores reales para elegir ────────────────────────────────────
function comprobarValores() {
  console.log('\n10. Valores de los leads para la regla');
  const v = agregarValoresRegla([
    {
      id: '1',
      utm_campaign: 'Test',
      form_name: 'UTM - Report',
      raw_fields: { P: 'Sí', Q: ['a', 'b'] },
      tags: ['vip'],
    },
    {
      id: '2',
      utm_campaign: 'test',
      form_name: 'UTM - Report',
      raw_fields: { P: 'No' },
      tags: ['vip', 'VIP'],
    },
    { id: '3', utm_campaign: 'Otra', ip_country: 'CO', custom_data: { tags: ['frío'] } },
    { id: '4', utm_campaign: null, raw_fields: { P: 'x'.repeat(300) } },
  ]);
  check(
    'cuenta sin distinguir mayúsculas y ordena por frecuencia',
    JSON.stringify(v.columnas.utm_campaign) ===
      JSON.stringify([
        { valor: 'Test', n: 2 },
        { valor: 'Otra', n: 1 },
      ]),
    JSON.stringify(v.columnas.utm_campaign)
  );
  check(
    'formulario con su recuento',
    v.columnas.form_name[0]?.valor === 'UTM - Report' && v.columnas.form_name[0].n === 2
  );
  check(
    'etiquetas desde `tags` y `custom_data.tags`, una vez por lead',
    JSON.stringify(v.etiquetas) ===
      JSON.stringify([
        { valor: 'vip', n: 2 },
        { valor: 'frío', n: 1 },
      ]),
    JSON.stringify(v.etiquetas)
  );
  const p = v.preguntas.find((x) => x.clave === 'P');
  check(
    'preguntas con cobertura y respuestas; las respuestas largas no son opciones',
    p?.n === 3 &&
      p.valores.length === 2 &&
      v.preguntas.find((x) => x.clave === 'Q')?.valores.length === 2
  );
  check('leídos', v.leidos === 4);
}

comprobarDeteccion()
  .then(comprobarFiltroNoEjecuta)
  .then(() => {
    comprobarCondiciones();
    return comprobarDuplicados();
  })
  .then(comprobarValores)
  .then(() => {
    console.log(
      fallos === 0
        ? '\n✅ Exclusión de leads: todas las comprobaciones pasan\n'
        : `\n❌ ${fallos} comprobación(es) fallaron\n`
    );
    process.exit(fallos === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('ERROR:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
