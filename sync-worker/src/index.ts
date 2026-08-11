/**
 * sync-worker — ejecutor persistente de la cola `sync_jobs`.
 *
 * Por qué existe
 * ─────────────
 * La app corre en Vercel Hobby: funciones de 60s y solo 2 crons diarios. Eso no
 * da para sincronizar Meta + TikTok + Hotmart + GA4 de todos los clientes (el
 * worker moría a mitad y dejaba datos parciales sin rastro). Este proceso vive
 * en el VPS, no tiene límite de tiempo y va drenando la cola a su ritmo.
 *
 * No duplica la lógica de sincronización: importa `runner.ts` de la app, que
 * traduce cada job a una llamada a los endpoints existentes. Aquí solo vive el
 * bucle, el scheduler y el healthcheck.
 *
 * Despliegue: ver README.md (Docker o PM2 en el VPS).
 */

import express from 'express'
import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import { runJobs } from '../../src/lib/sync/runner.js'
import { queueStats } from '../../src/lib/sync/queue.js'

// ─── Configuración ───────────────────────────────────────────────────────────

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    APP_URL,
    CRON_SECRET,
    PORT = '8080',
    TZ_OPERACION = 'America/Bogota',
    /** Segundos entre pasadas a la cola cuando hay trabajo pendiente. */
    POLL_SECONDS = '15',
} = process.env

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL, CRON_SECRET })) {
    if (!v) {
        console.error(`[sync-worker] Falta la variable de entorno ${k}. Ver .env.example`)
        process.exit(1)
    }
}

const db = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
const workerId = `vps-${process.env.HOSTNAME ?? 'local'}-${process.pid}`

const log = (msg: string, extra?: unknown) => {
    const ts = new Date().toISOString()
    if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra)
    else console.log(`[${ts}] ${msg}`)
}

// ─── Estado para el healthcheck ──────────────────────────────────────────────

let lastLoopAt: string | null = null
let lastError: string | null = null
let totalDone = 0
let totalFailed = 0
let loopRunning = false

// ─── Bucle de la cola ────────────────────────────────────────────────────────

/**
 * Drena la cola. Se protege con `loopRunning` para que un ciclo lento no se
 * solape con el siguiente: el claim ya es atómico, pero solapar solo añadiría
 * presión sobre las APIs externas sin procesar más rápido.
 */
async function drenarCola(): Promise<void> {
    if (loopRunning) return
    loopRunning = true
    try {
        const res = await runJobs(db, {
            appUrl: APP_URL!,
            cronSecret: CRON_SECRET!,
            workerId,
            ejecutor: 'vps',
            // Sin el techo de 60s de Vercel: tandas largas, menos overhead de claim.
            budgetMs: 10 * 60_000,
            // Lease holgado acorde a la tanda; si el proceso muere, otro ejecutor
            // (o este al reiniciar) retoma el job pasado ese tiempo.
            leaseSeconds: 900,
            requestTimeoutMs: 120_000,
        })
        lastLoopAt = new Date().toISOString()
        lastError = null
        totalDone += res.done
        totalFailed += res.failed
        if (res.claimed > 0) {
            log(`[cola] ${res.claimed} job(s): ${res.done} ok, ${res.failed} fallidos, ${res.requeued} reencolados`)
            for (const d of res.details) {
                if (d.estado !== 'ok') log(`  · ${d.tipo} ${d.jobId} → ${d.estado}${d.message ? `: ${d.message}` : ''}`)
            }
        }
    } catch (e: any) {
        lastError = e?.message ?? String(e)
        log(`[cola] ❌ Error en el bucle: ${lastError}`)
    } finally {
        loopRunning = false
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Pide a la app que encole un plan. El planning vive en la app (donde está el
 * modelo de datos), no aquí: este proceso solo decide CUÁNDO.
 */
async function encolarPlan(plan: 'diario' | 'intradia' | 'cierre_mes' | 'reconciliacion'): Promise<void> {
    try {
        const res = await fetch(`${APP_URL!.replace(/\/$/, '')}/api/worker/enqueue?plan=${plan}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${CRON_SECRET}` },
            signal: AbortSignal.timeout(60_000),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
            log(`[plan:${plan}] ❌ HTTP ${res.status}`, body)
            return
        }
        log(`[plan:${plan}] ✓ ${body.encolados ?? 0} job(s) encolados`, body.detalle)
    } catch (e: any) {
        log(`[plan:${plan}] ❌ ${e?.message ?? e}`)
    }
}

/**
 * Llama a un endpoint de cron de la app.
 *
 * Vercel Hobby solo admite 2 crons y los dos están ocupados
 * (`refresh-meta-tokens` y `run-jobs`), así que los demás cuelgan de aquí.
 */
async function llamarCron(ruta: string, nombre: string): Promise<void> {
    try {
        const res = await fetch(`${APP_URL!.replace(/\/$/, '')}${ruta}`, {
            headers: { Authorization: `Bearer ${CRON_SECRET}` },
            signal: AbortSignal.timeout(60_000),
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
            log(`[cron:${nombre}] ❌ HTTP ${res.status}`, body)
            return
        }
        log(`[cron:${nombre}] ✓`, body)
    } catch (e: any) {
        log(`[cron:${nombre}] ❌ ${e?.message ?? e}`)
    }
}

// Horarios en hora Colombia. Sustituyen a los 9 crons de vercel.json.
const horarios: Array<{ expr: string; nombre: string; fn: () => Promise<void> }> = [
    // Plan completo de la mañana: ayer (ya cerrado) + hoy.
    { expr: '0 5 * * *', nombre: 'plan diario', fn: () => encolarPlan('diario') },
    // Segunda pasada de la tarde: recoge las correcciones de atribución del día.
    { expr: '0 14 * * *', nombre: 'plan diario (tarde)', fn: () => encolarPlan('diario') },
    // Cierre del mes anterior: el día 7 ya pasó la mayor parte de la reatribución.
    { expr: '0 3 7 * *', nombre: 'cierre de mes', fn: () => encolarPlan('cierre_mes') },
    // Auditoría semanal: detecta días cuyo desglose de campañas de Meta no cuadra
    // con el gasto real de la cuenta y los repara. Sin esto, un día con el array
    // truncado se muestra en $0 para siempre.
    { expr: '0 3 * * 0', nombre: 'reconciliación de gasto Meta', fn: () => encolarPlan('reconciliacion') },
    // Refresco de tokens de Hotmart (HotConnect).
    //
    // El endpoint existía desde hace meses y la documentación afirmaba que
    // corría, pero NO estaba en ningún planificador: ni en vercel.json, ni aquí,
    // ni en el workflow de respaldo. La conexión sobrevivía solo porque el
    // worker refresca en línea cuando el token está a punto de vencer, con dos
    // consecuencias: el estado 'expired' no se escribía nunca y el aviso a los
    // administradores por token caducado NO se disparaba jamás.
    //
    // Cada 2 horas: los tokens de HotConnect son de vida corta y el umbral del
    // endpoint es de 30 minutos, así que ninguno llega a caducar entre pasadas.
    { expr: '0 */2 * * *', nombre: 'refresco de tokens Hotmart', fn: () => llamarCron('/api/cron/refresh-hotmart-tokens', 'hotmart-tokens') },
]

// ─── Healthcheck HTTP ────────────────────────────────────────────────────────

const app = express()

app.get('/health', async (_req, res) => {
    res.json({ ok: true, workerId, lastLoopAt, lastError, totalDone, totalFailed })
})

app.get('/status', async (_req, res) => {
    try {
        res.json({
            ok: true,
            workerId,
            lastLoopAt,
            lastError,
            totalDone,
            totalFailed,
            loopRunning,
            cola: await queueStats(db),
        })
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message ?? String(e) })
    }
})

/** Disparo manual de una pasada (útil para depurar sin esperar al poll). */
app.post('/run', async (_req, res) => {
    await drenarCola()
    res.json({ ok: true, lastLoopAt, totalDone, totalFailed })
})

// ─── Arranque ────────────────────────────────────────────────────────────────

app.listen(Number(PORT), () => {
    log(`[sync-worker] Escuchando en :${PORT} — worker ${workerId}`)
})

for (const h of horarios) {
    cron.schedule(h.expr, () => { void h.fn() }, { timezone: TZ_OPERACION })
    log(`[scheduler] ${h.nombre}: "${h.expr}" (${TZ_OPERACION})`)
}

// Poll continuo de la cola: cubre tanto el plan programado como el sync manual
// que el usuario dispara desde el dashboard.
const pollMs = Math.max(5, Number(POLL_SECONDS)) * 1000
setInterval(() => { void drenarCola() }, pollMs)
log(`[sync-worker] Poll de la cola cada ${pollMs / 1000}s`)
void drenarCola()

// Apagado limpio: no dejar un job con el lease tomado más de lo necesario.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
        log(`[sync-worker] ${sig} recibido — cerrando`)
        process.exit(0)
    })
}
