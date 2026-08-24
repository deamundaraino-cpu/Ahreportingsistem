/**
 * Retirada de la integración legacy "Google Sheets — Leads" (migración 059).
 *
 * Tres modos, pensados para correrse en este orden:
 *
 *   npx tsx scripts/migracion-leads-legacy.ts inventario
 *       Solo lectura. Qué clientes la usan, cuántos datos tienen y qué layouts
 *       referencian las 4 métricas. Es el punto de partida para decidir.
 *
 *   npx tsx scripts/migracion-leads-legacy.ts campos [--dry-run]
 *       Convierte el `quality_field` / `qualified_values` de cada cliente en un
 *       campo de Sheet ("Calidad del lead") con una vista ("Leads calificados"),
 *       y recalcula. Requiere la migración 059 aplicada y un sync posterior, que
 *       es lo que llena `sheet_filas` con las filas del documento migrado.
 *       Idempotente: no duplica nada si se vuelve a lanzar.
 *
 *   npx tsx scripts/migracion-leads-legacy.ts cuadre [dias]
 *       El GATE. Compara día a día `leads_diarios` (legacy) contra el pipeline
 *       nuevo. Mientras no salga en verde para todos los clientes, no conviene
 *       dar por buena la migración.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { sanitizarColumna, normalizarValorCrudo } from '../src/lib/sheets/campos';
import { recalcularCamposCliente, loadCamposCliente } from '../src/lib/sheets/campos-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

const envPath = 'c:/Users/razs9/OneDrive/Desktop/Apps/Ahreportingsistem/.env.local';
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Claves reservadas: el dashboard las usa para reconstruir las 4 métricas. */
const CAMPO_CLAVE = 'calidad_lead';
const VISTA_CLAVE = 'leads_calificados';

const modo = (process.argv[2] ?? 'inventario').toLowerCase();
const dryRun = process.argv.includes('--dry-run');

function titulo(t: string) {
  console.log(`\n${t}\n${'─'.repeat(t.length)}`);
}

interface ClienteLegacy {
  id: string;
  nombre: string;
  config: any;
}

/** Clientes con la integración legacy configurada. */
async function clientesLegacy(): Promise<ClienteLegacy[]> {
  const { data, error } = await db.from('clientes').select('id, nombre, config_api');
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((c: any) => c.config_api?.google_sheets?.sheet_url)
    .map((c: any) => ({ id: c.id, nombre: c.nombre, config: c.config_api.google_sheets }));
}

// ─── Inventario ─────────────────────────────────────────────────────────────

async function inventario() {
  const clientes = await clientesLegacy();

  titulo('Clientes con la integración legacy de leads');
  if (clientes.length === 0) {
    console.log('  Ninguno. La integración se puede retirar sin migrar nada.');
  }
  for (const c of clientes) {
    const migrado = await tieneSheetMigrado(c.id);
    console.log(
      `  ${c.nombre}\n` +
        `    habilitada:    ${c.config.enabled === true ? 'sí' : 'no'}\n` +
        `    pestañas:      ${(c.config.sheet_names ?? []).join(', ') || '(primera)'}\n` +
        `    campo calidad: ${c.config.quality_field || '—'}\n` +
        `    valores ok:    ${(c.config.qualified_values ?? []).join(', ') || '—'}\n` +
        `    sheet migrado: ${migrado ? 'sí' : 'NO (falta aplicar la migración 059)'}`
    );
  }

  titulo('Datos vivos en las tablas legacy');
  const { data: diarios } = await db
    .from('leads_diarios')
    .select('client_id, date')
    .order('date', { ascending: false })
    .limit(5000);
  const porCliente = new Map<string, { dias: number; ultimo: string }>();
  for (const r of (diarios ?? []) as any[]) {
    const e = porCliente.get(r.client_id) ?? { dias: 0, ultimo: r.date };
    e.dias++;
    if (r.date > e.ultimo) e.ultimo = r.date;
    porCliente.set(r.client_id, e);
  }
  if (porCliente.size === 0) console.log('  leads_diarios está vacía.');
  for (const [id, e] of porCliente) {
    const nombre = clientes.find((c) => c.id === id)?.nombre ?? id;
    console.log(`  ${nombre}: ${e.dias} días, último ${e.ultimo}`);
  }

  titulo('Layouts que referencian las 4 métricas');
  // Si alguno las usa, retirarlas rompería su dashboard: por eso se conservan
  // los nombres y se derivan del pipeline nuevo en vez de eliminarlas.
  const patron = /leads_totales|leads_calificados|leads_no_calificados|tasa_calificacion/;
  for (const tabla of ['layouts_reporte', 'clientes_layouts', 'cliente_tabs']) {
    const { data } = await db.from(tabla).select('*');
    const usados = (data ?? []).filter((r: any) =>
      patron.test(
        JSON.stringify([r.columnas, r.tarjetas, r.graficos, r.custom_metrics, r.ranking_tables])
      )
    );
    console.log(`  ${tabla}: ${usados.length} con referencias`);
    for (const u of usados.slice(0, 10)) console.log(`    · ${u.nombre ?? u.id}`);
  }
}

async function tieneSheetMigrado(clienteId: string): Promise<boolean> {
  const { data } = await db.from('clientes').select('config_api').eq('id', clienteId).maybeSingle();
  const sheets = (data as any)?.config_api?.google_sheets_conversiones;
  return Array.isArray(sheets) && sheets.some((s: any) => s?.migrado_de === 'google_sheets');
}

// ─── Campos de calidad ──────────────────────────────────────────────────────

async function crearCampos() {
  const clientes = await clientesLegacy();
  if (clientes.length === 0) {
    console.log('No hay clientes con la integración legacy. Nada que migrar.');
    return;
  }

  for (const c of clientes) {
    titulo(c.nombre);

    const qualityField = String(c.config.quality_field ?? '').trim();
    if (!qualityField) {
      console.log(
        '  Sin campo de calidad configurado: sus leads ya se cuentan como offline_leads.'
      );
      continue;
    }

    const columna = sanitizarColumna(qualityField);
    const { data: cliente } = await db
      .from('clientes')
      .select('config_api')
      .eq('id', c.id)
      .maybeSingle();
    const sheetMigrado = ((cliente as any)?.config_api?.google_sheets_conversiones ?? []).find(
      (s: any) => s?.migrado_de === 'google_sheets'
    );

    if (!sheetMigrado) {
      console.log('  ✗ No tiene sheet migrado. Aplica la migración 059 primero.');
      continue;
    }

    // El campo apunta a la columna de calidad en todas las pestañas del
    // sheet migrado: es la misma pregunta en todas ellas.
    const origenes = [
      {
        sheet_id: sheetMigrado.id,
        tab_name: '*',
        columnas: [columna],
        combinar: 'primero' as const,
      },
    ];

    const { campos, vistas } = await loadCamposCliente(db, c.id);
    const yaCampo = campos.find((k) => k.clave === CAMPO_CLAVE);
    const yaVista = vistas.find((v) => v.clave === VISTA_CLAVE);

    let campoId = yaCampo?.id;
    if (yaCampo) {
      console.log(`  · El campo "${CAMPO_CLAVE}" ya existe, se deja como está.`);
    } else if (dryRun) {
      console.log(`  [dry-run] crearía el campo "${CAMPO_CLAVE}" sobre la columna "${columna}"`);
    } else {
      const { data, error } = await db
        .from('sheet_campos')
        .insert({
          cliente_id: c.id,
          clave: CAMPO_CLAVE,
          nombre: 'Calidad del lead',
          descripcion: `Migrado de la integración legacy (columna "${qualityField}")`,
          rol: 'dimension',
          formato: 'number',
          agregacion: 'count',
          origenes,
          sin_mapear: 'crudo',
        })
        .select('id')
        .single();
      if (error) {
        console.log(`  ✗ ${error.message}`);
        continue;
      }
      campoId = data.id;
      console.log(`  ✓ Campo "${CAMPO_CLAVE}" creado sobre la columna "${columna}"`);
    }

    // La vista reproduce el `qualified_values` del legacy: los valores se
    // normalizan igual que en el motor para que "Sí" y "sí" coincidan.
    const valores = (c.config.qualified_values ?? [])
      .map((v: unknown) => normalizarValorCrudo(v))
      .filter(Boolean);

    if (valores.length === 0) {
      console.log('  · Sin valores calificados: no se crea la vista.');
    } else if (yaVista) {
      console.log(`  · La vista "${VISTA_CLAVE}" ya existe, se deja como está.`);
    } else if (dryRun) {
      console.log(`  [dry-run] crearía la vista "${VISTA_CLAVE}" con: ${valores.join(', ')}`);
    } else if (campoId) {
      const { error } = await db.from('sheet_campo_vistas').insert({
        cliente_id: c.id,
        campo_id: campoId,
        clave: VISTA_CLAVE,
        nombre: 'Leads calificados',
        agregacion: 'count',
        operador: 'in',
        valores,
        formato: 'number',
      });
      if (error) console.log(`  ✗ ${error.message}`);
      else console.log(`  ✓ Vista "${VISTA_CLAVE}" creada con: ${valores.join(', ')}`);
    }

    if (!dryRun && campoId) {
      const res = await recalcularCamposCliente(db, c.id, { campoIds: [campoId] });
      if (res.error) console.log(`  ✗ Recálculo: ${res.error}`);
      else console.log(`  ✓ Recalculado: ${res.valores} valores en ${res.dias} días`);
      for (const aviso of res.avisos) console.log(`    ! ${aviso}`);
    }
  }

  if (dryRun) console.log('\n(dry-run: no se escribió nada)');
}

// ─── Cuadre ─────────────────────────────────────────────────────────────────

async function cuadre() {
  const dias = Number(process.argv[3]) || 30;
  const desde = new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
  const clientes = await clientesLegacy();

  let totalDesajustes = 0;

  for (const c of clientes) {
    titulo(`${c.nombre} — últimos ${dias} días`);

    const { campos, vistas } = await loadCamposCliente(db, c.id);
    const campo = campos.find((k) => k.clave === CAMPO_CLAVE);
    const vista = vistas.find((v) => v.clave === VISTA_CLAVE);
    if (!campo) {
      console.log('  ✗ Sin campo de calidad migrado: ejecuta el modo "campos" primero.');
      totalDesajustes++;
      continue;
    }

    const { data: legacy } = await db
      .from('leads_diarios')
      .select('date, leads_totales, leads_calificados')
      .eq('client_id', c.id)
      .gte('date', desde)
      .order('date');

    const { data: nuevo } = await db
      .from('sheet_campo_valores_diarios')
      .select('fecha, valor, filas')
      .eq('campo_id', campo.id)
      .gte('fecha', desde);

    const nuevoPorFecha = new Map<string, { total: number; calificados: number }>();
    for (const r of (nuevo ?? []) as any[]) {
      const fecha = String(r.fecha).slice(0, 10);
      const e = nuevoPorFecha.get(fecha) ?? { total: 0, calificados: 0 };
      e.total += Number(r.filas ?? 0);
      if (vista && vista.valores.includes(String(r.valor))) e.calificados += Number(r.filas ?? 0);
      nuevoPorFecha.set(fecha, e);
    }

    let desajustes = 0;
    for (const l of (legacy ?? []) as any[]) {
      const n = nuevoPorFecha.get(l.date) ?? { total: 0, calificados: 0 };
      const okTotal = Number(l.leads_totales ?? 0) === n.total;
      const okCalif = Number(l.leads_calificados ?? 0) === n.calificados;
      if (!okTotal || !okCalif) {
        desajustes++;
        console.log(
          `  ✗ ${l.date}  legacy ${l.leads_totales}/${l.leads_calificados}` +
            `  ·  nuevo ${n.total}/${n.calificados}`
        );
      }
    }

    if ((legacy ?? []).length === 0) {
      console.log('  · Sin datos legacy en el rango: nada que cuadrar.');
    } else if (desajustes === 0) {
      console.log(`  ✓ Cuadran los ${(legacy ?? []).length} días (totales y calificados).`);
    } else {
      console.log(`  ${desajustes} de ${(legacy ?? []).length} días NO cuadran.`);
    }
    totalDesajustes += desajustes;
  }

  titulo('Resultado');
  if (totalDesajustes === 0) {
    console.log('  ✓ Todo cuadra. La retirada del legacy es segura.');
  } else {
    console.log(`  ✗ ${totalDesajustes} días con diferencias. Revisa antes de retirar el legacy.`);
    console.log('    Causas típicas: el sync del sheet migrado aún no ha corrido,');
    console.log('    o la columna de fecha de alguna pestaña no se resuelve sola.');
  }
  process.exit(totalDesajustes === 0 ? 0 : 1);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const modos: Record<string, () => Promise<void>> = {
  inventario,
  campos: crearCampos,
  cuadre,
};

const fn = modos[modo];
if (!fn) {
  console.error(`Modo desconocido: "${modo}". Usa: inventario | campos | cuadre`);
  process.exit(1);
}
fn().catch((err) => {
  console.error(err);
  process.exit(1);
});
