/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Congela la clave de cada respuesta de formulario (migración 090).
 *
 * Hasta la 090 la clave de fórmula de una respuesta (`lf__<campo>__<resp>`) se
 * derivaba de su etiqueta en cada carga. Este script guarda, en
 * `lead_campos.respuestas`, la clave que el dashboard derivaba HOY para cada
 * respuesta con nombre propio, de modo que ninguna fórmula guardada cambie de
 * significado y a partir de aquí renombrar una respuesta no la rompa. Además:
 *
 *   • reescribe los mapeos a la etiqueta literal «(sin respuesta)» (lo que
 *     escribía el antiguo botón «Apartar») a vacío, que es su forma correcta;
 *   • revisa TODAS las fórmulas y configuraciones guardadas (informes,
 *     pestañas, layouts y plantillas) y lista las referencias a respuestas que
 *     no resuelven a ninguna clave congelada.
 *
 *   npx tsx scripts/migrar-respuestas-lead.ts                   → informe en seco
 *   npx tsx scripts/migrar-respuestas-lead.ts --aplicar         → aplica (con copia)
 *   npx tsx scripts/migrar-respuestas-lead.ts --revertir <ruta> → deshace desde la copia
 *
 * Requiere la migración 090 aplicada para `--aplicar` (la columna
 * `respuestas`). El informe en seco funciona sin ella.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { etiquetasDeCampo } from '../src/lib/report-utm/lead-campos';
import type { LeadCampoDef } from '../src/lib/report-utm/lead-campos';
import {
  slugRespuesta,
  extraerReferenciasDeLead,
  reasignarClaves,
  CLAVES_RESERVADAS,
  SIN_RESPUESTA,
} from '../src/lib/leads/respuestas/claves';
import type { RespuestaClave } from '../src/lib/leads/respuestas/claves';

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

/**
 * Las claves que el dashboard derivaba antes de la 090: slug de la etiqueta,
 * con `_2`, `_3`… en el orden de los buckets. El orden es el configurado
 * (`valores_orden`) seguido del resto, que es el que tenían todos los campos
 * del catálogo con respuestas con nombre.
 */
export function clavesHeredadas(etiquetas: string[]): RespuestaClave[] {
  const usadas = new Set<string>(CLAVES_RESERVADAS);
  return etiquetas.map((nombre) => {
    const base = slugRespuesta(nombre) || 'respuesta';
    let clave = base;
    let i = 2;
    while (usadas.has(clave)) clave = `${base}_${i++}`;
    usadas.add(clave);
    return { clave, nombre };
  });
}

const ES_RESERVADA = (v: unknown) =>
  typeof v === 'string' && v.trim().toLowerCase() === '(sin respuesta)';

interface Plan {
  id: string;
  cliente_id: string;
  clave: string;
  nombre: string;
  respuestasAntes: RespuestaClave[] | null;
  respuestasDespues: RespuestaClave[];
  mapaAntes: Record<string, string>;
  mapaDespues: Record<string, string>;
  colisiones: string[];
}

async function planificar(): Promise<{ planes: Plan[]; conColumna: boolean }> {
  const { data, error } = await db.from('lead_campos').select('*');
  if (error) throw new Error(`No se pudo leer lead_campos: ${error.message}`);
  const filas = (data ?? []) as any[];
  const conColumna = filas.length === 0 || 'respuestas' in filas[0];

  const planes: Plan[] = [];
  for (const f of filas) {
    const campo = {
      valores_map: f.valores_map ?? {},
      valores_orden: f.valores_orden ?? [],
      sin_mapear: f.sin_mapear ?? 'crudo',
    } as Pick<LeadCampoDef, 'valores_map' | 'valores_orden' | 'sin_mapear'>;

    // 1. «(sin respuesta)» literal → vacío.
    const mapaDespues: Record<string, string> = {};
    for (const [k, v] of Object.entries(campo.valores_map)) {
      mapaDespues[k] = ES_RESERVADA(v) ? '' : (v as string);
    }

    // 2. Claves: las guardadas se respetan; si no hay, las heredadas.
    const etiquetas = etiquetasDeCampo({ ...campo, valores_map: mapaDespues });
    const previas: RespuestaClave[] = Array.isArray(f.respuestas) ? f.respuestas : [];
    const respuestasDespues =
      previas.length > 0
        ? reasignarClaves({
            mapaAnterior: mapaDespues,
            mapaNuevo: mapaDespues,
            respuestasAnteriores: previas,
            etiquetasNuevas: etiquetas,
          }).respuestas
        : clavesHeredadas(etiquetas);

    const porSlug = new Map<string, string[]>();
    for (const e of etiquetas) {
      const s = slugRespuesta(e);
      porSlug.set(s, [...(porSlug.get(s) ?? []), e]);
    }
    const colisiones = [...porSlug.values()].filter((l) => l.length > 1).map((l) => l.join(' / '));

    planes.push({
      id: f.id,
      cliente_id: f.cliente_id,
      clave: f.clave,
      nombre: f.nombre,
      respuestasAntes: 'respuestas' in f ? previas : null,
      respuestasDespues,
      mapaAntes: campo.valores_map as Record<string, string>,
      mapaDespues,
      colisiones,
    });
  }
  return { planes, conColumna };
}

/** Referencias a respuestas en todo lo guardado que no resuelven a una clave congelada. */
async function revisarReferencias(planes: Plan[]): Promise<void> {
  const porCampo = new Map<string, Set<string>>();
  for (const p of planes) {
    const s = porCampo.get(p.clave) ?? new Set<string>([SIN_RESPUESTA]);
    for (const r of p.respuestasDespues) {
      s.add(r.clave);
      for (const a of r.alias ?? []) s.add(a);
    }
    porCampo.set(p.clave, s);
  }

  const fuentes: { tabla: string; cliente: any; cols: string }[] = [
    { tabla: 'bi_reports', cliente: pub, cols: 'id,nombre,layout,filters,calculated_fields' },
    { tabla: 'cliente_tabs', cliente: pub, cols: '*' },
    { tabla: 'clientes_layouts', cliente: pub, cols: '*' },
    { tabla: 'layouts_reporte', cliente: pub, cols: '*' },
    { tabla: 'tab_templates', cliente: pub, cols: '*' },
  ];
  let total = 0;
  const sinResolver: string[] = [];
  for (const f of fuentes) {
    const { data, error } = await f.cliente.from(f.tabla).select(f.cols);
    if (error) {
      console.log(`  ? ${f.tabla}: no se pudo leer (${error.message})`);
      continue;
    }
    for (const fila of (data ?? []) as any[]) {
      const refs = extraerReferenciasDeLead(JSON.stringify(fila));
      for (const r of refs.respuestas) {
        total++;
        const claves = porCampo.get(r.campo);
        if (!claves)
          sinResolver.push(
            `${f.tabla} «${fila.nombre ?? fila.id}»: ${r.texto} (el campo no existe)`
          );
        else if (!claves.has(r.resp))
          sinResolver.push(
            `${f.tabla} «${fila.nombre ?? fila.id}»: ${r.texto} (respuesta sin nombre propio: se resuelve por su valor tal cual, que puede cambiar)`
          );
      }
    }
  }
  console.log(`\nReferencias a respuestas en lo guardado: ${total}`);
  if (sinResolver.length === 0) console.log('  ✓ todas resuelven a una clave congelada');
  else for (const s of sinResolver) console.log(`  ! ${s}`);
}

async function main() {
  if (REVERTIR) return revertir(REVERTIR);

  const { planes, conColumna } = await planificar();
  console.log(`\n══ Respuestas de formulario: ${planes.length} campos ══\n`);
  for (const p of planes) {
    const cambiaMapa = JSON.stringify(p.mapaAntes) !== JSON.stringify(p.mapaDespues);
    console.log(`• ${p.nombre} (leadfield:${p.clave})`);
    for (const r of p.respuestasDespues)
      console.log(`    lf__${p.clave}__${r.clave}  ←  «${r.nombre}»`);
    if (cambiaMapa)
      console.log('    ⚠ mapeos a «(sin respuesta)» → vacío (cuentan como no respondió)');
    for (const c of p.colisiones) console.log(`    ⚠ mismo slug, claves con sufijo: ${c}`);
  }
  await revisarReferencias(planes);

  if (!APLICAR) {
    console.log('\n(informe en seco: nada cambió. Aplica con --aplicar)\n');
    return;
  }
  if (!conColumna) {
    console.error(
      '\n✗ Falta la columna lead_campos.respuestas: aplica antes migrations/090_respuestas_de_lead.sql\n'
    );
    process.exit(1);
  }

  const copia = planes.map((p) => ({
    id: p.id,
    respuestas: p.respuestasAntes ?? [],
    valores_map: p.mapaAntes,
  }));
  mkdirSync('backups', { recursive: true });
  const ruta = `backups/respuestas-lead-${Date.now()}.json`;
  writeFileSync(ruta, JSON.stringify(copia, null, 2));

  for (const p of planes) {
    const { error } = await db
      .from('lead_campos')
      .update({ respuestas: p.respuestasDespues, valores_map: p.mapaDespues })
      .eq('id', p.id);
    console.log(error ? `✗ ${p.clave}: ${error.message}` : `✓ ${p.clave}`);
  }
  console.log(`\nCopia de seguridad: ${ruta}`);
  console.log(`Revertir con: npx tsx scripts/migrar-respuestas-lead.ts --revertir ${ruta}\n`);
}

async function revertir(ruta: string) {
  const copia = JSON.parse(readFileSync(ruta, 'utf8')) as {
    id: string;
    respuestas: RespuestaClave[];
    valores_map: Record<string, string>;
  }[];
  console.log(`\n══ REVIRTIENDO desde ${ruta} ══\n`);
  for (const c of copia) {
    const { error } = await db
      .from('lead_campos')
      .update({ respuestas: c.respuestas, valores_map: c.valores_map })
      .eq('id', c.id);
    console.log(error ? `✗ ${c.id}: ${error.message}` : `✓ ${c.id} restaurado`);
  }
}

// Solo se ejecuta como script, no al importarlo desde un test.
if (process.argv[1]?.includes('migrar-respuestas-lead')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
