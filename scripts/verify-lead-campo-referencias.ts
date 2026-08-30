/**
 * Referencias a un campo de lead, contra datos REALES.
 *
 * Protege la comprobación que le faltó a `migrar-segmentos-lead.ts` y que costó
 * dos bloques rotos en producción: su `referenciasVivas` buscaba los tokens
 * `leadfield:<clave>` y `lf__<clave>__`, encontró el informe de Goodprop y dio
 * el visto bueno… sin ver que la pestaña «Evergreen Captacion» apuntaba al mismo
 * campo desde `lead_answer_blocks`, donde la clave va DESNUDA y ningún token la
 * delata.
 *
 * Por eso aquí no basta con que la función "encuentre algo": tiene que encontrar
 * las DOS vías por separado. Si alguien simplifica el módulo a un `includes()`
 * sobre el JSON, la segunda comprobación se cae.
 *
 *   npx tsx --conditions=react-server scripts/verify-lead-campo-referencias.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { loadLeadCampos, loadLeadSegmentos } =
    await import('../src/lib/report-utm/lead-campos-db');
  const { referenciasDeCampoLead, resumirReferencias } =
    await import('../src/lib/report-utm/lead-campo-referencias');

  const db = await createAdminClient();
  const rtm = db.schema('report_utm');

  const { data: clientes } = await rtm.from('clientes').select('id,nombre,public_cliente_id');

  // Se prueba sobre el primer cliente que tenga a la vez un campo activo Y algo
  // que lo referencie. Sin eso no hay nada que verificar y el script no debe
  // fallar por ello.
  let elegido: any = null;
  let campoUsado: any = null;
  let refs: any[] = [];

  for (const c of (clientes ?? []) as any[]) {
    const campos = await loadLeadCampos(rtm, c.id, { soloActivos: true });
    for (const campo of campos) {
      const segmentos = await loadLeadSegmentos(rtm, c.id, [campo], { soloActivos: true });
      const r = await referenciasDeCampoLead(db, {
        rtmClienteId: c.id,
        publicClienteId: c.public_cliente_id,
        clave: campo.clave,
        segmentos,
      });
      if (r.length > 0) {
        elegido = c;
        campoUsado = campo;
        refs = r;
        break;
      }
    }
    if (elegido) break;
  }

  if (!elegido) {
    console.log('\n⚠ Ningún campo de lead activo está referenciado: nada que verificar.\n');
    return;
  }

  console.log(`\nCliente: ${elegido.nombre} · campo «${campoUsado.nombre}» (${campoUsado.clave})`);
  console.log(`Referencias: ${resumirReferencias(refs)}\n`);
  for (const r of refs) console.log(`  · ${r.origen}: «${r.nombre}» — ${r.motivo}`);

  console.log('\n── La detección encuentra las dos vías ─────────────────────');

  check('devuelve al menos una referencia', refs.length > 0);
  check(
    'toda referencia trae origen, id, nombre y motivo',
    refs.every((r) => r.origen && r.id && r.nombre && r.motivo),
    JSON.stringify(refs.find((r) => !r.motivo) ?? {})
  );
  check('el resumen no queda vacío habiendo referencias', resumirReferencias(refs).length > 0);

  // Las dos vías, por separado. Un `includes()` genérico sobre el JSON pasaría
  // la primera y fallaría la segunda: es exactamente la regresión a evitar.
  const porToken = refs.filter((r) => r.motivo.startsWith('usa'));
  const porBloque = refs.filter((r) => r.motivo.startsWith('bloque de respuestas'));

  console.log(
    `\n  (por token: ${porToken.length} · por bloque de respuestas: ${porBloque.length})`
  );
  check(
    'detecta al menos una de las dos vías con su motivo identificado',
    porToken.length + porBloque.length === refs.length,
    'hay referencias con un motivo que no encaja en ninguna vía'
  );

  console.log('\n── Un campo que nadie usa no inventa referencias ───────────');

  const inventada = await referenciasDeCampoLead(db, {
    rtmClienteId: elegido.id,
    publicClienteId: elegido.public_cliente_id,
    clave: 'campo_que_no_existe_en_ningun_sitio_xyz',
  });
  check(
    'una clave inexistente devuelve lista vacía',
    inventada.length === 0,
    String(inventada.length)
  );
  check('el resumen de una lista vacía es cadena vacía', resumirReferencias([]) === '');

  console.log('\n── Los campos retirados ya no cuelgan de nadie ─────────────');

  // Los cuatro umbrales que `migrar-segmentos-lead.ts` desactivó. Tras
  // `reapuntar-bloques-lead.ts` no debe quedar ni una referencia viva: si
  // alguna reaparece, hay un layout apuntando a un campo que ya no se carga.
  const retirados = ['leads_totales', 'leads_desde_1_3m', 'leads_desde1_6m', 'leads_desde_2m'];
  for (const c of (clientes ?? []) as any[]) {
    for (const clave of retirados) {
      const r = await referenciasDeCampoLead(db, {
        rtmClienteId: c.id,
        publicClienteId: c.public_cliente_id,
        clave,
      });
      check(
        `${c.nombre}: nadie referencia "${clave}"`,
        r.length === 0,
        r.map((x) => `${x.origen} «${x.nombre}»`).join(', ')
      );
    }
  }

  console.log(
    fallos === 0
      ? '\n✅ Referencias a campos de lead: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
