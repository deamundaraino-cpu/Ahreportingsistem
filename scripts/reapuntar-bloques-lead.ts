/**
 * Re-apunta los bloques de «Respuestas de formulario» que quedaron mirando a un
 * campo de lead DESACTIVADO.
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────
 * `scripts/migrar-segmentos-lead.ts` desactivó los cuatro campos-umbral de
 * Goodprop (`leads_totales`, `leads_desde_1_3m`, `leads_desde1_6m`,
 * `leads_desde_2m`) al sustituirlos por segmentos de `rango_de_ingresos`.
 *
 * Su salvaguarda `referenciasVivas` buscaba los tokens `leadfield:<clave>` y
 * `lf__<clave>__`, y su reescritura solo traducía fórmulas. Pero un bloque de
 * respuestas NO guarda un token: guarda la clave DESNUDA dentro de
 * `lead_answer_blocks` (`{"origen":"catalogo","clave":"leads_desde_2m"}`). Ni la
 * comprobación ni la reescritura la veían, así que el script dio el visto bueno
 * y aplicó.
 *
 * Resultado: `dashboard/_actions.ts` carga el catálogo con `soloActivos:true`,
 * no encuentra el campo y omite el bloque. La pestaña «Evergreen Captacion» de
 * Goodprop lleva desde entonces con dos bloques que muestran un cartel de error
 * en vez de datos.
 *
 * ── Qué hace este script ────────────────────────────────────────────────
 * Recorre `cliente_tabs`, `clientes_layouts` y `tab_templates`, encuentra los
 * bloques `origen:'catalogo'` cuya `clave` no existe o está inactiva en el
 * catálogo del cliente, y la sustituye por la del campo activo que la reemplaza
 * según `REEMPLAZOS`.
 *
 * NO adivina el reemplazo: un bloque cuya clave no esté en el mapa se REPORTA y
 * se deja intacto. Cambiar la pregunta de un bloque cambia lo que el cliente ve
 * en su informe; eso se decide a mano, no por heurística.
 *
 *   npx tsx --conditions=react-server scripts/reapuntar-bloques-lead.ts
 *   npx tsx --conditions=react-server scripts/reapuntar-bloques-lead.ts --aplicar
 *
 * Sin `--aplicar` solo enseña lo que haría. Con `--aplicar` vuelca el estado
 * previo a `scripts/.backup-bloques-lead-<timestamp>.json` antes de escribir.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const APLICAR = process.argv.includes('--aplicar');

/** Tablas con layouts que pueden llevar bloques de respuestas. */
const TABLAS = ['cliente_tabs', 'clientes_layouts', 'tab_templates'] as const;

/**
 * Clave retirada → clave activa que la sustituye.
 *
 * Los cuatro umbrales de Goodprop eran cuatro vistas de la MISMA pregunta —el
 * rango de ingresos—, cada una mapeando N respuestas a un único bucket. El campo
 * que las reemplaza a todas es `rango_de_ingresos`, que además llega con sus 6
 * buckets ordenados de menor a mayor, que es lo que el título de los bloques
 * («Cantidad de leads x rango …») pedía desde el principio.
 *
 * El `label` también se reemplaza: dejar «Leads Desde 2M» sobre un desglose de
 * seis rangos sería una etiqueta que miente.
 */
const REEMPLAZOS: Record<string, { clave: string; label: string }> = {
  leads_totales: { clave: 'rango_de_ingresos', label: 'Rango de ingresos' },
  leads_desde_1_3m: { clave: 'rango_de_ingresos', label: 'Rango de ingresos' },
  leads_desde1_6m: { clave: 'rango_de_ingresos', label: 'Rango de ingresos' },
  leads_desde_2m: { clave: 'rango_de_ingresos', label: 'Rango de ingresos' },
};

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { loadLeadCampos } = await import('../src/lib/report-utm/lead-campos-db');

  const db = await createAdminClient();
  const rtm = db.schema('report_utm');

  // Catálogo por cliente PÚBLICO: los layouts se guardan contra el id público,
  // y los campos contra el de report_utm.
  const { data: rtmClientes } = await rtm.from('clientes').select('id,nombre,public_cliente_id');

  const activosPorPublico = new Map<string, { nombre: string; activas: Set<string> }>();
  for (const c of (rtmClientes ?? []) as any[]) {
    if (!c.public_cliente_id) continue;
    const campos = await loadLeadCampos(rtm, c.id, { soloActivos: true });
    activosPorPublico.set(c.public_cliente_id, {
      nombre: c.nombre,
      activas: new Set(campos.map((k) => k.clave)),
    });
  }

  const backup: any[] = [];
  const cambios: string[] = [];
  const huerfanos: string[] = [];

  for (const tabla of TABLAS) {
    const { data, error } = await db.from(tabla).select('*');
    if (error) {
      console.log(`  ! ${tabla}: ${error.message}`);
      continue;
    }

    for (const fila of (data ?? []) as any[]) {
      const bloques = fila.lead_answer_blocks;
      if (!Array.isArray(bloques) || bloques.length === 0) continue;

      // `tab_templates` no pertenece a un cliente: se comprueba contra la unión
      // de todas las claves activas, que es lo único honesto que se puede hacer.
      const ficha = fila.cliente_id ? activosPorPublico.get(fila.cliente_id) : undefined;
      const activas =
        ficha?.activas ?? new Set([...activosPorPublico.values()].flatMap((v) => [...v.activas]));
      const quien = `${tabla} «${fila.nombre ?? fila.id}»${ficha ? ` [${ficha.nombre}]` : ''}`;

      let tocada = false;
      const nuevos = bloques.map((b: any) => {
        if (b?.origen !== 'catalogo' || !b.clave) return b;
        if (activas.has(b.clave)) return b;

        const reemplazo = REEMPLAZOS[b.clave];
        if (!reemplazo) {
          huerfanos.push(`${quien} → «${b.title ?? b.id}» apunta a "${b.clave}", sin reemplazo`);
          return b;
        }
        cambios.push(
          `${quien} → «${b.title ?? b.id}»: ${b.clave} → ${reemplazo.clave}` +
            (b.label ? ` (label "${b.label}" → "${reemplazo.label}")` : '')
        );
        tocada = true;
        return { ...b, clave: reemplazo.clave, label: reemplazo.label };
      });

      if (!tocada) continue;
      backup.push({ tabla, id: fila.id, lead_answer_blocks: bloques });

      if (APLICAR) {
        const { error: errUpd } = await db
          .from(tabla)
          .update({ lead_answer_blocks: nuevos })
          .eq('id', fila.id);
        if (errUpd) console.log(`  ! no se pudo actualizar ${quien}: ${errUpd.message}`);
      }
    }
  }

  console.log(`\n── Bloques a re-apuntar (${cambios.length}) ───────────────────────`);
  for (const c of cambios) console.log(`  · ${c}`);
  if (cambios.length === 0) console.log('  (ninguno)');

  if (huerfanos.length > 0) {
    console.log(`\n── Bloques rotos SIN reemplazo conocido (${huerfanos.length}) ─────`);
    console.log('  Se dejan intactos: elegir otra pregunta cambia lo que ve el cliente.');
    for (const h of huerfanos) console.log(`  · ${h}`);
  }

  if (!APLICAR) {
    console.log('\n(simulación: nada se ha escrito — repite con --aplicar)\n');
    return;
  }

  if (backup.length > 0) {
    const destino = path.join(
      process.cwd(),
      'scripts',
      `.backup-bloques-lead-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    writeFileSync(destino, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`\nEstado previo guardado en ${destino}`);
  }
  console.log(`\n✅ ${cambios.length} bloque(s) re-apuntado(s)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
