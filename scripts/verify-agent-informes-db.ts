/**
 * Herramientas de informes del agente/MCP contra la base REAL.
 *
 * `verify-agent-informes.ts` lo cubre con una base en memoria; esto comprueba lo
 * que solo se ve en Supabase:
 *
 *   · que `create_report` guarda el id de `report_utm.clientes` y la FK de la
 *     migración 080 lo acepta (con el id público fallaba con 23503),
 *   · que la escritura condicionada a `updated_at` casa con el formato de fecha
 *     que devuelve PostgREST (si no, toda edición daría CONFLICT),
 *   · que las revisiones se guardan en `bi_report_revisions` (migración 092) y
 *     que restaurar devuelve el estado anterior,
 *   · que `preview_widget` pasa por el motor BI de verdad sin error.
 *
 * Crea un informe «[verify] …» con un usuario ficticio y lo borra al terminar,
 * con sus revisiones y su rastro de auditoría. No crea propuestas de aprobación.
 *
 * Forma parte de `test:datos`.
 */
import { config as loadEnv } from 'dotenv';
import { salir } from './_salida';
loadEnv({ path: '.env.local' });

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

/** Usuario ficticio: `created_by` y el log de auditoría son columnas uuid. */
const USUARIO = '00000000-0000-4000-8000-0000000c1a0d';

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { getTool } = await import('../src/lib/agent/registry');
  const { ejecutarConTool } = await import('../src/lib/agent/execute');
  const { ALL_PERMISSIONS } = await import('../src/lib/api-token-auth');
  type Ctx = import('../src/lib/agent/types').AgentContext;

  const db = await createAdminClient();

  const { data: clientes, error: errCli } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id, nombre, public_cliente_id')
    .not('public_cliente_id', 'is', null)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1);
  if (errCli || !clientes?.length) {
    console.log(`No hay un cliente enlazado con el que probar: ${errCli?.message ?? 'ninguno'}`);
    process.exit(1);
  }
  const cli = clientes[0] as { id: string; nombre: string; public_cliente_id: string };
  console.log(`\nCliente de prueba: ${cli.nombre}`);

  // Un operador que solo ve ESTE cliente: es el caso que antes daba 404.
  const ctx: Ctx = {
    userId: USUARIO,
    role: 'trafficker',
    level: 'operador',
    allowedClientIds: [cli.public_cliente_id],
    permissions: [...ALL_PERMISSIONS],
    db,
    origin: 'mcp',
    conversationId: null,
    tokenId: null,
  };
  const correr = (nombre: string, input: unknown) => ejecutarConTool(getTool(nombre)!, input, ctx);

  let reportId: string | null = null;
  try {
    // ── Crear ──
    console.log('\n── Crear ────────────────────────────────────────────────────');
    const creado = await correr('create_report', {
      nombre: '[verify] Informe del agente',
      client_id: cli.public_cliente_id,
    });
    check(
      'create_report se aplica al momento',
      creado.ok && creado.aplicado === true,
      JSON.stringify(creado.error)
    );
    reportId = (creado.data as { informe?: { id?: string } })?.informe?.id ?? null;
    check('devuelve el id del informe', Boolean(reportId));
    if (!reportId) return;

    const { data: fila } = await db
      .from('bi_reports')
      .select('cliente_id, created_by')
      .eq('id', reportId)
      .single();
    check(
      'guarda el id de report_utm (la FK lo acepta)',
      fila?.cliente_id === cli.id,
      String(fila?.cliente_id)
    );
    check('con quien lo pidió como autor', fila?.created_by === USUARIO);

    const leido = await correr('get_report', { report_id: reportId });
    check(
      'un operador del cliente lo lee (antes: 404)',
      leido.ok &&
        (leido.data as { informe: { client_id: string } }).informe.client_id ===
          cli.public_cliente_id,
      JSON.stringify(leido.error)
    );

    // ── Editar ──
    console.log('\n── Editar, con revisión ─────────────────────────────────────');
    const add = await correr('add_report_widget', {
      report_id: reportId,
      widget: {
        type: 'scorecard',
        title: 'Leads',
        w: 1,
        config: { metric: 'leads_count', compare_period: true },
      },
    });
    check('add_report_widget se aplica', add.ok, JSON.stringify(add.error));
    const revision = (add.data as { revision_id?: string })?.revision_id;
    const widgetId = (add.data as { widget_id?: string })?.widget_id;
    check('guarda una revisión en bi_report_revisions', Boolean(revision));

    const upd = await correr('update_report_widget', {
      report_id: reportId,
      widget_id: widgetId,
      cambios: { title: 'Contactos' },
    });
    check(
      'una segunda edición no da CONFLICT (updated_at casa con PostgREST)',
      upd.ok,
      JSON.stringify(upd.error)
    );

    const malo = await correr('add_report_widget', {
      report_id: reportId,
      widget: { type: 'bar', config: { metric: 'spend', dimension: 'ip_country' } },
    });
    check('un widget que mostraría 0 se rechaza', malo.error?.code === 'VALIDATION_ERROR');

    // ── Vista previa ──
    console.log('\n── Vista previa con el motor real ───────────────────────────');
    const prev = await correr('preview_widget', { report_id: reportId, widget_id: widgetId });
    const res =
      (prev.data as { valido?: boolean; resultados?: { error?: string; forma?: string }[] }) ?? {};
    check('preview_widget responde', prev.ok, JSON.stringify(prev.error));
    check('el widget es válido', res.valido === true, JSON.stringify(prev.data)?.slice(0, 300));
    check(
      'y el motor devuelve datos sin error',
      Boolean(res.resultados?.length) && !res.resultados?.[0].error,
      JSON.stringify(res.resultados?.[0])?.slice(0, 300)
    );
    check('con la forma de una comparación', res.resultados?.[0].forma === 'comparacion');

    const tabla = await correr('preview_widget', {
      client_id: cli.public_cliente_id,
      widget: {
        type: 'table',
        config: { metric: 'spend,leads_count,cpl', dimension: 'utm_campaign', limit: 5 },
      },
    });
    const rt = (tabla.data as { resultados?: { error?: string; forma?: string }[] })
      ?.resultados?.[0];
    check(
      'una tabla por campaña sin informe también se previsualiza',
      tabla.ok && !rt?.error && rt?.forma === 'filas',
      JSON.stringify(tabla.error ?? rt)?.slice(0, 300)
    );

    const campos = await correr('list_report_fields', {
      client_id: cli.public_cliente_id,
      fuente: 'formulario',
    });
    check(
      'list_report_fields lee el catálogo del cliente',
      campos.ok,
      JSON.stringify(campos.error)
    );

    // ── Deshacer ──
    console.log('\n── Deshacer ─────────────────────────────────────────────────');
    const hist = await correr('list_report_revisions', { report_id: reportId });
    check(
      'el historial lista las revisiones',
      hist.ok && ((hist.data as { revisiones?: unknown[] }).revisiones?.length ?? 0) >= 2,
      JSON.stringify(hist.error)
    );
    const vuelta = await correr('restore_report_revision', { revision_id: revision });
    check('restore_report_revision se aplica', vuelta.ok, JSON.stringify(vuelta.error));
    const { data: tras } = await db.from('bi_reports').select('layout').eq('id', reportId).single();
    check(
      'el informe vuelve a estar vacío (antes del primer widget)',
      Array.isArray(tras?.layout) && (tras?.layout as unknown[]).length === 0
    );
  } finally {
    // Limpieza: el informe, sus revisiones y el rastro de auditoría del usuario ficticio.
    if (reportId) {
      await db.from('bi_report_revisions').delete().eq('report_id', reportId);
      await db.from('bi_reports').delete().eq('id', reportId);
    }
    await db.from('agent_audit_log').delete().eq('user_id', USUARIO);
    const { data: resto } = await db.from('bi_reports').select('id').eq('created_by', USUARIO);
    check('no queda nada del informe de prueba', (resto ?? []).length === 0);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
  salir(fail);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
