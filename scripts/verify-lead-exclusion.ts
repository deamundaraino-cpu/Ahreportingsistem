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
  aplicarExclusion,
  tieneAtribucion,
  reglaTieneEfecto,
  REGLA_VACIA,
  MOTIVOS_AUTOMATICOS,
  MOTIVOS_EXCLUSION,
  columnaExcluidoDisponible,
  _reiniciarDeteccionColumna,
} from '../src/lib/report-utm/lead-exclusion';

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
  'las listas se normalizan (minúsculas, sin vacíos, sin duplicados)',
  JSON.stringify(reglaListas.excluir_sources) === JSON.stringify(['instagram', 'whatsapp'])
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

comprobarDeteccion().then(() => {
  console.log(
    fallos === 0
      ? '\n✅ Exclusión de leads: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  process.exit(fallos === 0 ? 0 : 1);
});
