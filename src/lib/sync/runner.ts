/**
 * Ejecutor de la cola `sync_jobs`.
 *
 * Cada job se traduce a una llamada HTTP a los endpoints de sync que ya existen
 * en la app. Se hace así a propósito: la lógica de Meta/TikTok/Hotmart/GA4 son
 * ~2.000 líneas afinadas en `src/app/api/worker/route.ts`, y duplicarlas en el
 * worker del VPS garantizaría que las dos copias divergieran. El VPS aporta el
 * scheduler persistente y el control de la cola; el cómputo sigue viviendo en un
 * único sitio.
 *
 * Reanudación: si un job se corta por presupuesto de tiempo, la respuesta trae
 * `resumeFrom` y el runner **reencola** el tramo que falta como un job nuevo, en
 * vez de darlo por hecho. Se hace así (y no avanzando un cursor dentro del mismo
 * job) para que en el panel cada job siga representando el rango que realmente
 * cubrió. Si en cambio el proceso muere sin responder, vence el lease y el job
 * entero se reintenta: más lento, pero los upserts son idempotentes.
 */

import {
  claimJob,
  clienteOcupado,
  completeJob,
  failJob,
  enqueueJob,
  releaseJob,
  type SyncJob,
} from './queue';
import { notifyUsers } from '../notifications/notify';
// Ruta relativa, no alias `@/`: este archivo lo compila también el worker del
// VPS, que no pasa por el resolver de Next.
import { esTimeoutDeFetch } from '../fetch-json';

/** Avisa a admins cuando un job agota sus reintentos. Best-effort: nunca lanza. */
async function notifyExhausted(db: any, job: SyncJob, message: string): Promise<void> {
  try {
    await notifyUsers({
      db,
      type: 'sync_failed',
      severity: 'error',
      audience: 'admins',
      clienteId: job.cliente_id,
      title: `Sincronización fallida: ${job.tipo}`,
      message: message.slice(0, 200),
      link: '/admin/sync',
      metadata: {
        job_id: job.id,
        tipo: job.tipo,
        fecha_inicio: job.fecha_inicio,
        fecha_fin: job.fecha_fin,
      },
    });
  } catch {
    // El aviso es observabilidad; su fallo no puede tumbar el drenado de la cola.
  }
}

export type RunnerOptions = {
  /** URL base de la app (ej. https://reportes.adshouse.cloud). */
  appUrl: string;
  /** CRON_SECRET compartido. */
  cronSecret: string;
  /** Identifica al ejecutor en `locked_by` y `sync_runs.ejecutor`. */
  workerId: string;
  /**
   * Quién ejecutó, para `sync_runs.ejecutor`: `'app'` (el drenador de respaldo
   * dentro del contenedor de Next) o `'vps'` (el `sync-worker` persistente).
   *
   * No es cosmético: es el ÚNICO termómetro de si el worker principal está
   * vivo. Durante meses el default fue `'vercel'` y el worker mandaba `'vps'`,
   * así que una consulta de una línea —`select ejecutor, count(*) from
   * sync_runs group by 1`— revela al instante que el worker nunca arrancó.
   */
  ejecutor?: string;
  /** Corta el bucle al superarlo. */
  budgetMs?: number;
  /** Segundos de lease; pasado ese tiempo otro ejecutor puede reclamar el job. */
  leaseSeconds?: number;
  /** Timeout de cada llamada HTTP a la app. */
  requestTimeoutMs?: number;
};

export type RunnerResult = {
  claimed: number;
  done: number;
  failed: number;
  requeued: number;
  details: Array<{ jobId: string; tipo: string; estado: string; message?: string }>;
};

/** Traduce un job a la petición HTTP que lo ejecuta. */
function buildRequest(job: SyncJob, appUrl: string): { url: string; method: 'GET' | 'POST' } {
  const base = appUrl.replace(/\/$/, '');
  const qs = new URLSearchParams();
  const start = job.fecha_inicio;
  if (start) qs.set('start', start);
  if (job.fecha_fin) qs.set('end', job.fecha_fin);
  if (job.cliente_id) qs.set('client_id', job.cliente_id);
  if (job.params?.force) qs.set('force', '1');
  if (job.params?.refresh_days) qs.set('refresh_days', String(job.params.refresh_days));
  // Acota el sync a ciertas fuentes (la reconciliación solo repara Meta).
  if (job.params?.platforms) qs.set('platforms', String(job.params.platforms));
  // Acota un job de Sheets a un documento concreto del cliente.
  if (job.params?.sheet_id) qs.set('sheet_id', String(job.params.sheet_id));

  switch (job.tipo) {
    case 'metricas':
      return { url: `${base}/api/worker?${qs}`, method: 'GET' };
    // Un job `sheets_leads` histórico (anterior a la migración 059) se enruta
    // al worker unificado: su hoja ya vive en google_sheets_conversiones.
    case 'sheets_leads':
    case 'sheets_conversiones':
      return { url: `${base}/api/worker/google-sheets-conversiones?${qs}`, method: 'GET' };
    case 'meta_leads': {
      const p = new URLSearchParams();
      if (job.cliente_id) p.set('clienteId', job.cliente_id);
      return { url: `${base}/api/cron/sync-meta-leads?${p}`, method: 'POST' };
    }
    case 'ghl_leads': {
      // Sin rango de fechas: el cursor de GHL es `dateAdded` y vive en la
      // integración, no en el job (ver `syncGhlLeadsForCliente`).
      const p = new URLSearchParams();
      if (job.cliente_id) p.set('clienteId', job.cliente_id);
      return { url: `${base}/api/cron/sync-ghl-leads?${p}`, method: 'POST' };
    }
    case 'utm_aggregate':
      return { url: `${base}/api/cron/report-utm/aggregate?${qs}`, method: 'GET' };
    case 'cierre_mes':
      return { url: `${base}/api/cron/cierre-mes?${qs}`, method: 'POST' };
    case 'reconciliar':
      // heal=1: además de detectar, encola la reparación de los días malos.
      qs.set('heal', '1');
      return { url: `${base}/api/worker/reconcile?${qs}`, method: 'POST' };
    case 'hotmart_ventas':
    case 'hotmart_reconciliar': {
      const p = new URLSearchParams();
      if (job.cliente_id) p.set('cliente_id', job.cliente_id);
      if (start) p.set('desde', start);
      if (job.fecha_fin) p.set('hasta', job.fecha_fin);
      p.set(
        'modo',
        job.tipo === 'hotmart_reconciliar'
          ? 'reconciliar'
          : job.params?.reclasificar
            ? 'reclasificar'
            : 'backfill'
      );
      return { url: `${base}/api/worker/hotmart?${p}`, method: 'GET' };
    }
    default:
      throw new Error(`Tipo de job desconocido: ${job.tipo}`);
  }
}

/** Espera `ms` sin bloquear el bucle de eventos. */
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Margen que debe quedar de presupuesto para que reintentar tenga sentido.
 * Por debajo, el reintento moriría abortado igual y solo habría gastado la
 * espera.
 */
const REINTENTO_RED_MS = 1_000;

async function executeJob(
  job: SyncJob,
  opts: RunnerOptions,
  /** Techo para esta llamada concreta (ver `runJobs`). */
  timeoutMs: number
): Promise<{
  ok: boolean;
  partial: boolean;
  resumeFrom?: string | null;
  body: any;
  message?: string;
}> {
  const { url, method } = buildRequest(job, opts.appUrl);

  /**
   * Un intento extra ante un fallo de RED (no de timeout).
   *
   * La app se llama a sí misma por su dominio público, así que un redespliegue
   * deja una ventana de segundos en la que el proxy todavía no tiene ruta al
   * contenedor nuevo y `fetch` revienta con `fetch failed` en ~120 ms. Sin este
   * reintento cada corte quemaba un intento de cada job en vuelo, y tres cortes
   * dejaban el job en rojo con datos perfectamente sincronizables. Un timeout,
   * en cambio, NO se reintenta: significa que el destino sí respondía pero no
   * dio tiempo, y repetirlo solo consumiría el presupuesto que queda.
   */
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${opts.cronSecret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (esTimeoutDeFetch(e) || timeoutMs <= REINTENTO_RED_MS * 2) throw e;
    await dormir(REINTENTO_RED_MS);
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${opts.cronSecret}` },
      signal: AbortSignal.timeout(timeoutMs - REINTENTO_RED_MS),
    });
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = { raw: await res.text().catch(() => '') };
  }

  if (!res.ok) {
    return {
      ok: false,
      partial: false,
      body,
      message: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`,
    };
  }

  /**
   * Un 200 no basta. Los workers que iteran clientes por dentro (Sheets,
   * meta_leads) atrapan el fallo de cada cliente para que uno malo no tumbe a
   * los demás, y devolvían 200 aunque no se hubiera salvado ninguno: el job
   * se marcaba `done` y la cola se veía verde sin haber escrito una fila.
   * Quien pueda fallar por dentro lo declara con `ok: false`.
   */
  if (body?.ok === false) {
    const detalle =
      Array.isArray(body?.errores) && body.errores.length > 0
        ? body.errores.join(' | ')
        : (body?.error ?? JSON.stringify(body).slice(0, 500));
    return {
      ok: false,
      partial: false,
      body,
      message: `El worker no completó ningún cliente: ${detalle}`.slice(0, 500),
    };
  }

  return {
    ok: true,
    partial: !!body?.partial,
    resumeFrom: body?.resumeFrom ?? null,
    body,
  };
}

/** Registra la ejecución en `sync_runs` (best-effort: nunca tumba el job). */
async function recordRun(
  db: any,
  job: SyncJob,
  opts: RunnerOptions,
  startedAt: number,
  estado: 'ok' | 'partial' | 'error',
  body: any,
  error?: string
): Promise<void> {
  try {
    const results = Array.isArray(body?.results) ? body.results : [];
    const logs = Array.isArray(body?.debugLogs) ? body.debugLogs.slice(0, 200) : [];
    await db.from('sync_runs').insert({
      job_id: job.id,
      tipo: job.tipo,
      cliente_id: job.cliente_id,
      fecha_inicio: job.fecha_inicio,
      fecha_fin: job.fecha_fin,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duracion_ms: Date.now() - startedAt,
      estado,
      filas_escritas: results.filter((r: any) => r?.status === 'ok').length,
      filas_saltadas: results.filter((r: any) => String(r?.status ?? '').startsWith('skipped'))
        .length,
      stats: {
        partial: !!body?.partial,
        partialClientes: body?.partialClientes ?? [],
        alerts: body?.alerts ?? null,
      },
      error: error?.slice(0, 2000) ?? null,
      logs,
      ejecutor: opts.ejecutor ?? 'app',
    });
  } catch {
    // El historial es observabilidad, no puede hacer fallar la sincronización.
  }
}

/**
 * Presupuesto mínimo que debe quedar para reclamar otro job.
 *
 * Estaba en 5 s, y eso era el origen del error más frecuente del sistema: un
 * job de métricas OK tarda 15,6 s de media y llega a 48,9 s, así que reclamarlo
 * con 5 s de margen garantizaba el aborto. Cada aborto gasta un intento y a los
 * tres el job queda en rojo — 183 de los 219 errores registrados entre julio y
 * agosto de 2026 fueron exactamente eso, y sus duraciones (14,6 s / 32,5 s /
 * 41,4 s) coinciden con el presupuesto restante, no con ningún límite de las
 * APIs externas.
 *
 * 60 s cubre holgado el peor caso observado: si no cabe entero, el job se deja
 * para el ciclo siguiente en vez de quemarle un intento.
 */
const MIN_JOB_MS = 60_000;

/**
 * Drena la cola hasta agotar el presupuesto o quedarse sin jobs.
 * Devuelve el resumen de lo procesado.
 */
export async function runJobs(db: any, opts: RunnerOptions): Promise<RunnerResult> {
  const budgetMs = opts.budgetMs ?? 45_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  const startedLoop = Date.now();
  /** Lo que queda de presupuesto del ciclo. */
  const restante = () => budgetMs - (Date.now() - startedLoop);
  const result: RunnerResult = { claimed: 0, done: 0, failed: 0, requeued: 0, details: [] };
  /**
   * Jobs devueltos a la cola en este ciclo por tener el cliente ocupado.
   * `claim_sync_job` los volvería a entregar de inmediato (mismo orden de
   * prioridad), así que reencontrarse con uno significa que ya no queda nada
   * más que hacer ahora: se corta el ciclo en vez de girar en vacío.
   */
  const liberados = new Set<string>();

  while (restante() > MIN_JOB_MS) {
    const job = await claimJob(db, opts.workerId, opts.leaseSeconds ?? 600);
    if (!job) break;

    /**
     * Un job que ya superó sus intentos no debe volver a ejecutarse.
     *
     * `claim_sync_job` incrementa `intentos` también cuando recupera un job
     * `running` con el lease vencido, y ese camino no pasa por `failJob`, que
     * es quien decide el paso a 'error'. Un ejecutor que muere sin responder
     * (la función de Vercel cortada a mitad) deja el job colgado, y al
     * repetirse el ciclo `intentos` crece sin techo: en producción se vio un
     * 7/3. Aquí se cierra ese camino.
     */
    if (job.intentos > job.max_intentos) {
      const message = `Lease vencido ${job.intentos} veces sin respuesta del ejecutor (máx. ${job.max_intentos})`;
      // `failJob` ya lo da por agotado: `intentos > max_intentos` cumple su `>=`.
      await failJob(db, job, message);
      result.failed++;
      result.details.push({ jobId: job.id, tipo: job.tipo, estado: 'error', message });
      await notifyExhausted(db, job, message);
      continue;
    }

    // Dos corridas concurrentes del mismo cliente se pisan los datos.
    if (
      liberados.has(job.id) ||
      (await clienteOcupado(db, job.cliente_id, job.id, opts.workerId, opts.leaseSeconds ?? 600))
    ) {
      /**
       * Se restituye el intento que `claim_sync_job` incrementó al entregarlo.
       *
       * El job no ha fallado: solo llegó mientras otro ejecutor tenía cogido a
       * su cliente. Cobrárselo era el fallo más visible del sistema — un sync
       * manual encola varios chunks del MISMO cliente, el primero se ejecuta
       * (20-45 s) y los demás rebotan aquí; como el job liberado vuelve a
       * `pending` con la misma prioridad y es el más antiguo, `claim_sync_job`
       * lo devolvía en la vuelta siguiente del propio bucle, gastando DOS
       * intentos por pasada sin ejecutar nada. Con `max_intentos = 3` el chunk
       * moría en dos pasadas (~15 s) acusando un lease vencido que nunca
       * existió, y el dashboard pintaba en rojo un sync que estaba yendo bien.
       */
      await releaseJob(db, job.id, job.intentos - 1);
      if (liberados.has(job.id)) break;
      liberados.add(job.id);
      result.details.push({
        jobId: job.id,
        tipo: job.tipo,
        estado: 'reintento',
        message: 'cliente ocupado por otro ejecutor',
      });
      continue;
    }

    result.claimed++;

    const startedAt = Date.now();

    /**
     * El timeout de la llamada se acota a lo que queda de ciclo: un ejecutor
     * no puede esperar por un job más de lo que él mismo va a vivir. Con los
     * valores fijos de antes, el drenador podía arrancar un job en el segundo
     * 39 de su presupuesto de 40 s y esperar por él otros 55, muriendo sin
     * poder marcar el fallo y dejando el job 'running' hasta vencer el lease.
     */
    const timeoutAplicado = Math.min(requestTimeoutMs, restante());
    /** El corte lo impondría nuestro presupuesto, no el timeout configurado. */
    const cortaElPresupuesto = timeoutAplicado < requestTimeoutMs;

    try {
      const exec = await executeJob(job, opts, timeoutAplicado);

      if (!exec.ok) {
        const exhausted = await failJob(db, job, exec.message ?? 'error desconocido');
        result.failed++;
        result.details.push({
          jobId: job.id,
          tipo: job.tipo,
          estado: exhausted ? 'error' : 'reintento',
          message: exec.message,
        });
        await recordRun(db, job, opts, startedAt, 'error', exec.body, exec.message);
        if (exhausted) await notifyExhausted(db, job, exec.message ?? 'error desconocido');
        continue;
      }

      if (exec.partial && exec.resumeFrom && job.fecha_fin && exec.resumeFrom <= job.fecha_fin) {
        // Se hizo una parte: cerrar este job y encolar el resto. Sin esto el
        // rango restante se daría por sincronizado y quedaría un hueco.
        await completeJob(db, job.id);
        await enqueueJob(db, {
          tipo: job.tipo,
          clienteId: job.cliente_id,
          start: exec.resumeFrom,
          end: job.fecha_fin,
          params: job.params,
          prioridad: job.prioridad,
          triggeredBy: `${job.triggered_by}:continuacion`,
        });
        result.done++;
        result.requeued++;
        result.details.push({
          jobId: job.id,
          tipo: job.tipo,
          estado: 'parcial',
          message: `reanuda en ${exec.resumeFrom}`,
        });
        await recordRun(db, job, opts, startedAt, 'partial', exec.body);
        continue;
      }

      await completeJob(db, job.id);
      result.done++;
      result.details.push({ jobId: job.id, tipo: job.tipo, estado: 'ok' });
      await recordRun(db, job, opts, startedAt, 'ok', exec.body);
    } catch (e: any) {
      const message = e?.message ?? String(e);

      /**
       * Aborto que impuso NUESTRO presupuesto, no un fallo del job.
       *
       * El job seguía trabajando cuando lo cortamos: no ha fallado nada suyo y
       * castigarlo con un intento es lo que llevaba jobs perfectamente sanos a
       * rojo tras tres ciclos apretados. Se devuelve a la cola y se restituye
       * el intento que `claim_sync_job` incrementó al reclamarlo.
       *
       * Y se corta el ciclo: si no hubo presupuesto para este, tampoco lo hay
       * para el siguiente.
       */
      if (esTimeoutDeFetch(e) && cortaElPresupuesto) {
        await releaseJob(db, job.id, job.intentos - 1);
        result.details.push({
          jobId: job.id,
          tipo: job.tipo,
          estado: 'reintento',
          message: `sin presupuesto para terminarlo (quedaban ${Math.round(timeoutAplicado / 1000)}s); devuelto a la cola`,
        });
        break;
      }

      const exhausted = await failJob(db, job, message);
      result.failed++;
      result.details.push({
        jobId: job.id,
        tipo: job.tipo,
        estado: exhausted ? 'error' : 'reintento',
        message,
      });
      await recordRun(db, job, opts, startedAt, 'error', null, message);
      if (exhausted) await notifyExhausted(db, job, message);
    }
  }

  return result;
}
