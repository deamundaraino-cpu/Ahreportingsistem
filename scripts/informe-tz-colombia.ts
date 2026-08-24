/**
 * Informe de impacto del cambio de zona horaria: día UTC → día calendario Colombia.
 *
 * NO cambia nada. Solo mide, para que el equipo de cuentas sepa qué informes se
 * mueven y cuánto ANTES de aplicar la corrección.
 *
 * ── El problema ─────────────────────────────────────────────────────────
 * El motor agrupa los leads por `String(created_at).slice(0,10)`, que es el día
 * UTC, mientras el gasto se agrupa por `metricas_diarias.fecha` (un DATE que
 * escribe el worker) y la app MUESTRA en `America/Bogota` (UTC-5, sin horario de
 * verano). Consecuencia: un lead de las 20:00 en Colombia es 01:00 UTC del día
 * siguiente, así que cae en un día distinto al del gasto que lo generó.
 *
 * Afecta a toda la ventana 19:00–23:59 hora Colombia.
 *
 * ── Lo que mide ─────────────────────────────────────────────────────────
 *   · cuántos leads cambian de día, por cliente
 *   · el neto por día (cuántos entran y cuántos salen)
 *   · si el TOTAL DEL MES se mueve (no debería, salvo en los bordes del mes)
 *   · los días con mayor diferencia, que son los que se notarán en un informe
 *
 *   npx tsx scripts/informe-tz-colombia.ts
 *   npx tsx scripts/informe-tz-colombia.ts --desde=2026-07-01 --hasta=2026-07-31
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';

loadEnv({ path: '.env.local' });

const args = process.argv.slice(2);
const opt = (n: string, def?: string) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : def;
};
const DESDE = opt('desde', '2026-07-01')!;
const HASTA = opt('hasta', '2026-07-31')!;

/** Consulta SQL de solo lectura vía Management API (PostgREST no hace GROUP BY). */
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

const n = (v: unknown) => Number(v ?? 0);
const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  Impacto de pasar de día UTC a día calendario Colombia (UTC-5)   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);
  console.log(`\nRango analizado: ${DESDE} → ${HASTA}`);
  console.log(`NO se modifica nada: este informe solo mide.\n`);

  // ── 1. Cuántos leads cambian de día, por cliente ─────────────────
  const porCliente = await sql<Record<string, unknown>>(`
        SELECT c.nombre,
               count(*)                                                          AS leads,
               count(*) FILTER (
                   WHERE (l.created_at)::date
                       <> (l.created_at AT TIME ZONE 'America/Bogota')::date
               )                                                                 AS cambian
          FROM report_utm.lead_events l
          JOIN report_utm.clientes  c ON c.id = l.cliente_id
         WHERE l.created_at >= '${DESDE}T00:00:00Z'
           AND l.created_at <  ('${HASTA}'::date + 1)
         GROUP BY c.nombre
        HAVING count(*) > 0
         ORDER BY cambian DESC
    `);

  console.log(`── Leads que cambian de día ${'─'.repeat(38)}`);
  console.log(
    `   ${pad('Cliente', 26)} ${'Leads'.padStart(8)} ${'Cambian'.padStart(9)} ${'%'.padStart(7)}`
  );
  let totLeads = 0,
    totCambian = 0;
  for (const r of porCliente) {
    const leads = n(r.leads),
      cambian = n(r.cambian);
    totLeads += leads;
    totCambian += cambian;
    const pct = leads > 0 ? (cambian / leads) * 100 : 0;
    console.log(
      `   ${pad(String(r.nombre).trim(), 26)} ${String(leads).padStart(8)} ${String(cambian).padStart(9)} ${pct.toFixed(1).padStart(6)}%`
    );
  }
  const pctTot = totLeads > 0 ? (totCambian / totLeads) * 100 : 0;
  console.log(
    `   ${pad('TOTAL', 26)} ${String(totLeads).padStart(8)} ${String(totCambian).padStart(9)} ${pctTot.toFixed(1).padStart(6)}%`
  );
  console.log(`\n   Son los leads creados entre las 19:00 y las 23:59 hora Colombia:`);
  console.log(`   en UTC ya es el día siguiente, así que hoy caen en un día distinto`);
  console.log(`   al del gasto que los generó.\n`);

  // ── 2. Efecto neto por día ────────────────────────────────────────
  // Lo que se notará en una gráfica de evolución: cada día gana los leads de
  // la noche anterior y pierde los de su propia noche.
  const porDia = await sql<Record<string, unknown>>(`
        WITH d AS (
            SELECT (created_at)::date                                    AS dia_utc,
                   (created_at AT TIME ZONE 'America/Bogota')::date      AS dia_col
              FROM report_utm.lead_events
             WHERE created_at >= '${DESDE}T00:00:00Z'
               AND created_at <  ('${HASTA}'::date + 1)
        ), u AS (SELECT dia_utc AS dia, count(*) AS n FROM d GROUP BY 1),
           k AS (SELECT dia_col AS dia, count(*) AS n FROM d GROUP BY 1)
        SELECT COALESCE(u.dia, k.dia)                       AS dia,
               COALESCE(u.n, 0)                             AS antes_utc,
               COALESCE(k.n, 0)                             AS despues_col,
               COALESCE(k.n, 0) - COALESCE(u.n, 0)          AS diferencia
          FROM u FULL OUTER JOIN k ON u.dia = k.dia
         WHERE COALESCE(k.n,0) <> COALESCE(u.n,0)
         ORDER BY abs(COALESCE(k.n, 0) - COALESCE(u.n, 0)) DESC
         LIMIT 12
    `);

  console.log(`── Los 12 días con mayor diferencia ${'─'.repeat(31)}`);
  console.log(
    `   ${pad('Día', 12)} ${'Hoy (UTC)'.padStart(11)} ${'Nuevo (COL)'.padStart(12)} ${'Dif.'.padStart(8)}`
  );
  for (const r of porDia) {
    const dif = n(r.diferencia);
    console.log(
      `   ${pad(String(r.dia).slice(0, 10), 12)} ${String(n(r.antes_utc)).padStart(11)} ${String(n(r.despues_col)).padStart(12)} ${(dif > 0 ? '+' : '') + dif}`.padEnd(
        4
      )
    );
  }

  // ── 3. ¿Se mueve el total del mes? ────────────────────────────────
  const porMes = await sql<Record<string, unknown>>(`
        WITH d AS (
            SELECT (created_at)::date                               AS dia_utc,
                   (created_at AT TIME ZONE 'America/Bogota')::date AS dia_col
              FROM report_utm.lead_events
             WHERE created_at >= '${DESDE}T00:00:00Z'
               AND created_at <  ('${HASTA}'::date + 1)
        )
        SELECT count(*) FILTER (WHERE date_trunc('month', dia_utc) = date_trunc('month', dia_col)) AS mismo_mes,
               count(*) FILTER (WHERE date_trunc('month', dia_utc) <> date_trunc('month', dia_col)) AS cambia_de_mes
          FROM d
    `);
  const mismoMes = n(porMes[0]?.mismo_mes);
  const cambiaMes = n(porMes[0]?.cambia_de_mes);

  console.log(`\n── Efecto en los totales mensuales ${'─'.repeat(32)}`);
  console.log(`   leads que se quedan en su mes   ${mismoMes}`);
  console.log(`   leads que cambian DE MES        ${cambiaMes}`);
  if (cambiaMes === 0) {
    console.log(`\n   ✓ Ningún total mensual se mueve: solo se recolocan días dentro`);
    console.log(`     del mes. Un informe "Julio 2026" seguirá dando el mismo total.`);
  } else {
    console.log(`\n   ⚠ ${cambiaMes} lead(s) cruzan el borde del mes: los informes mensuales`);
    console.log(`     de esos meses cambiarán su total en esa cantidad.`);
  }

  // ── 4. Entregas ya enviadas que se verían afectadas ───────────────
  const entregas = await sql<Record<string, unknown>>(`
        SELECT r.nombre, d.period_label, d.date_from, d.date_to, d.sent_at
          FROM public.bi_report_deliveries d
          JOIN public.bi_reports r ON r.id = d.report_id
         ORDER BY d.sent_at DESC
         LIMIT 10
    `).catch(() => []);

  console.log(`\n── Entregas ya enviadas al cliente ${'─'.repeat(32)}`);
  if (!entregas.length) {
    console.log(`   No hay entregas registradas: nadie ha recibido todavía un PDF o`);
    console.log(`   enlace con números que puedan dejar de cuadrar.`);
  } else {
    console.log(`   ${entregas.length} entrega(s). Sus enlaces recalculan al abrirse, así que`);
    console.log(`   mostrarán los números NUEVOS y podrían no cuadrar con el PDF enviado:`);
    for (const e of entregas) {
      console.log(
        `     · ${pad(String(e.nombre), 28)} ${e.period_label}  (${String(e.date_from).slice(0, 10)} → ${String(e.date_to).slice(0, 10)})`
      );
    }
  }

  console.log(`\n── Recomendación ${'─'.repeat(50)}`);
  console.log(`   El cambio es correcto: hoy los leads de la noche se comparan contra`);
  console.log(`   el gasto del día equivocado. Con este informe en la mano:`);
  console.log(`     1. Avisa al equipo de cuentas el día que se aplique.`);
  console.log(`     2. Aplícalo a principio de mes, para que el mes en curso nazca ya bien.`);
  console.log(`     3. Recaptura la línea base:`);
  console.log(`          npx tsx scripts/verify-bi-golden.ts --capturar`);
  console.log(`   Piezas a cambiar: getDimValue en bi-query.ts (deja de usar`);
  console.log(`   slice(0,10) del UTC) y los rangos .gte/.lte, que hoy mandan un`);
  console.log(`   literal SIN zona a una columna timestamptz. Usar colombia-date.ts.\n`);
}

main().catch((e) => {
  console.error('\n✗ Fallo:', e?.message ?? e);
  process.exit(1);
});
