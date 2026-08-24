/**
 * Detector de días en los que una plataforma se quedó SIN datos en BD.
 *
 * NO cambia nada. Solo lista lo que hay que re-sincronizar.
 *
 * ── Qué busca y por qué ─────────────────────────────────────────────────
 * El worker «preservaba» los datos de una plataforma omitiendo sus claves del
 * upsert. En un lote mezclado eso no preservaba: PostgREST rellena con NULL las
 * columnas que una fila no trae y el ON CONFLICT las escribe encima. Resultado:
 * días con `meta_spend IS NULL` y el desglose vacío, aunque la cuenta sí gastó.
 *
 * Un día así es INVISIBLE en el panel: la fila existe (TikTok, Hotmart o GA4 sí
 * escribieron), así que no aparece como hueco, y el dashboard suma el array de
 * campañas, que está vacío → muestra $0 y 0 leads con toda naturalidad. Se
 * detectó en Sur Profundo del 24 al 27 de julio de 2026: 3.385.086 COP y 432
 * leads que el worker había descargado bien y se borraron después.
 *
 * También marca los días con el desglose incompleto (la columna no cuadra con
 * la suma de campañas), que producen el mismo síntoma por otra vía.
 *
 * El fallo de raíz está corregido en `src/lib/sync/upsert-batches.ts`; esto es
 * la red para localizar el daño ya hecho y para que no vuelva a pasar inadvertido.
 *
 *   npx tsx scripts/detectar-dias-nulos.ts
 *   npx tsx scripts/detectar-dias-nulos.ts --desde=2026-04-01 --hasta=2026-08-05
 *   npx tsx scripts/detectar-dias-nulos.ts --cliente=<uuid>
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';

loadEnv({ path: '.env.local' });

const args = process.argv.slice(2);
const opt = (n: string, def?: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : def;
};
const DESDE = opt('desde', '2026-01-01')!;
const HASTA = opt('hasta', new Date().toISOString().slice(0, 10))!;
const CLIENTE = opt('cliente');

/** Consulta de solo lectura vía Management API (PostgREST no hace GROUP BY). */
async function sql<T>(query: string): Promise<T[]> {
  const env = readFileSync('.env.local', 'utf8');
  const get = (k: string) =>
    env
      .split('\n')
      .find((l) => l.startsWith(`${k}=`))
      ?.slice(k.length + 1)
      .trim()
      .replace(/^"|"$/g, '') ?? '';
  const proj = get('NEXT_PUBLIC_SUPABASE_URL')
    .replace(/.*https:\/\//, '')
    .replace(/\.supabase\.co.*/, '');
  const token = get('SUPABASE_ACCESS_TOKEN');
  if (!proj || !token)
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_ACCESS_TOKEN en .env.local');

  const res = await fetch(`https://api.supabase.com/v1/projects/${proj}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok || json?.message) throw new Error(json?.message ?? `HTTP ${res.status}`);
  return json as T[];
}

const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));

/**
 * Solo se marca una plataforma si el cliente LA TIENE CONFIGURADA. Un cliente
 * sin TikTok tiene `tiktok_spend` en NULL para siempre y no es ningún fallo.
 */
const META_CONFIGURADA = `(
    jsonb_array_length(COALESCE(c.config_api->'meta_accounts', '[]'::jsonb)) > 0
    OR (c.config_api->>'meta_token' IS NOT NULL AND c.config_api->>'meta_account_id' IS NOT NULL)
)`;
const TIKTOK_CONFIGURADA = `(
    jsonb_array_length(COALESCE(c.config_api->'tiktok_accounts', '[]'::jsonb)) > 0
    OR (c.config_api->>'tiktok_access_token' IS NOT NULL AND c.config_api->>'tiktok_advertiser_id' IS NOT NULL)
)`;

const filtroCliente = CLIENTE ? `AND c.id = '${CLIENTE}'` : '';

type FilaHueco = {
  cliente: string;
  cliente_id: string;
  plataforma: string;
  fecha: string;
  motivo: string;
  otra_plataforma: string | null;
};

async function main() {
  console.log(`\nHuecos de plataforma en metricas_diarias — ${DESDE} → ${HASTA}\n`);

  const huecos = await sql<FilaHueco>(`
        WITH d AS (
            SELECT m.*, c.nombre AS cliente, ${META_CONFIGURADA} AS meta_ok, ${TIKTOK_CONFIGURADA} AS tiktok_ok
            FROM metricas_diarias m
            JOIN clientes c ON c.id = m.cliente_id
            WHERE m.fecha BETWEEN '${DESDE}' AND '${HASTA}' ${filtroCliente}
        )
        SELECT cliente, cliente_id::text, 'meta' AS plataforma, fecha::text, 'columna NULL' AS motivo,
               CASE WHEN tiktok_spend > 0 THEN 'tiktok con datos' END AS otra_plataforma
        FROM d WHERE meta_ok AND meta_spend IS NULL
        UNION ALL
        SELECT cliente, cliente_id::text, 'tiktok', fecha::text, 'columna NULL',
               CASE WHEN meta_spend > 0 THEN 'meta con datos' END
        FROM d WHERE tiktok_ok AND tiktok_spend IS NULL
        UNION ALL
        SELECT cliente, cliente_id::text, 'meta', fecha::text, 'gasto sin desglose', NULL
        FROM d WHERE meta_ok AND meta_spend > 0
          AND COALESCE(jsonb_array_length(meta_campaigns), 0) = 0
        UNION ALL
        SELECT cliente, cliente_id::text, 'tiktok', fecha::text, 'gasto sin desglose', NULL
        FROM d WHERE tiktok_ok AND tiktok_spend > 0
          AND COALESCE(jsonb_array_length(tiktok_campaigns), 0) = 0
        ORDER BY 1, 3, 4
    `);

  if (huecos.length === 0) {
    console.log('  ✓ Sin huecos: ninguna plataforma configurada se quedó sin datos.\n');
  } else {
    console.log(
      `  ${pad('CLIENTE', 22)} ${pad('PLAT', 7)} ${pad('FECHA', 12)} ${pad('MOTIVO', 20)} PISTA`
    );
    console.log(`  ${'─'.repeat(84)}`);
    for (const h of huecos) {
      console.log(
        `  ${pad(h.cliente.trim(), 22)} ${pad(h.plataforma, 7)} ${pad(h.fecha, 12)} ${pad(h.motivo, 20)} ${h.otra_plataforma ?? ''}`
      );
    }
    console.log(`\n  ${huecos.length} día(s)/plataforma afectados.`);
  }

  // Un día con `otra_plataforma` es la huella exacta del borrado por NULL: la
  // fila se escribió por la otra fuente y arrastró las columnas omitidas.
  const porNull = huecos.filter((h) => h.otra_plataforma);
  if (porNull.length > 0) {
    console.log(`  ${porNull.length} de ellos con la otra plataforma sí presente ese día`);
    console.log('  → huella del borrado por upsert heterogéneo (corregido en upsert-batches.ts).');
  }

  // Desglose que no cuadra con la columna: mismo síntoma en el panel (que suma
  // el array), distinta causa. Tolerancia del 1% con piso de 1, igual que
  // `importesCuadran` en src/lib/sync/reconcile.ts.
  const descuadres = await sql<{
    cliente: string;
    plataforma: string;
    fecha: string;
    columna: string;
    array: string;
  }>(`
        WITH d AS (
            SELECT m.*, c.nombre AS cliente
            FROM metricas_diarias m JOIN clientes c ON c.id = m.cliente_id
            WHERE m.fecha BETWEEN '${DESDE}' AND '${HASTA}' ${filtroCliente}
        ), s AS (
            SELECT cliente, fecha, 'meta' AS plataforma, meta_spend AS columna,
                   (SELECT COALESCE(SUM((e->>'spend')::numeric), 0) FROM jsonb_array_elements(meta_campaigns) e) AS suma
            FROM d WHERE meta_spend > 0 AND jsonb_array_length(COALESCE(meta_campaigns, '[]'::jsonb)) > 0
            UNION ALL
            SELECT cliente, fecha, 'tiktok', tiktok_spend,
                   (SELECT COALESCE(SUM((e->>'spend')::numeric), 0) FROM jsonb_array_elements(tiktok_campaigns) e)
            FROM d WHERE tiktok_spend > 0 AND jsonb_array_length(COALESCE(tiktok_campaigns, '[]'::jsonb)) > 0
        )
        SELECT cliente, plataforma, fecha::text, columna::text, suma::text AS array
        FROM s WHERE ABS(columna - suma) > GREATEST(1, columna * 0.01)
        ORDER BY 1, 2, 3
    `);

  console.log(`\nDesglose que no cuadra con la columna (>1%)\n`);
  if (descuadres.length === 0) {
    console.log('  ✓ Ninguno.\n');
  } else {
    for (const d of descuadres) {
      console.log(
        `  ${pad(d.cliente.trim(), 22)} ${pad(d.plataforma, 7)} ${d.fecha}  columna=${d.columna}  campañas=${d.array}`
      );
    }
    console.log(
      `\n  ${descuadres.length} día(s). El panel suma el array, así que muestran de MENOS.\n`
    );
  }

  // Comandos listos para copiar: un rango por cliente, que es como se re-pide.
  const porCliente = new Map<string, { nombre: string; fechas: string[] }>();
  for (const h of [...huecos]) {
    const e = porCliente.get(h.cliente_id) ?? { nombre: h.cliente.trim(), fechas: [] };
    e.fechas.push(h.fecha);
    porCliente.set(h.cliente_id, e);
  }
  if (porCliente.size > 0) {
    console.log('Re-sincronización sugerida (force=1 salta la ventana de refresco):\n');
    for (const [id, e] of porCliente) {
      const ord = [...new Set(e.fechas)].sort();
      console.log(`  # ${e.nombre} (${ord.length} día(s))`);
      console.log(
        `  GET /api/worker?client_id=${id}&start=${ord[0]}&end=${ord[ord.length - 1]}&force=1\n`
      );
    }
  }

  // Código de salida para poder engancharlo a una alerta.
  process.exit(huecos.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(2);
});
