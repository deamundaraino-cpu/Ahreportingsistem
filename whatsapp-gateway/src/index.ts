// Gateway Baileys — proceso Node persistente que mantiene la conexión con
// WhatsApp y expone una API REST mínima para la app Next.js (en Vercel).
//
// Endpoints (todos con Authorization: Bearer WHATSAPP_GATEWAY_API_KEY):
//   GET  /status  -> { connected, me, lastSeen }
//   GET  /qr      -> { qr, connected }   (qr = dataURL para emparejar)
//   GET  /groups  -> { groups: [{ id, name }] }
//   POST /send    -> { messageId }       body { groupId, message }
//   GET  /health  -> { ok: true }        (sin auth, para health-checks)

import express, { type Request, type Response, type NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import pino from 'pino'
import { useSupabaseAuthState } from './auth-state.js'
import { registrarEntrantes } from './inbound.js'

const PORT = Number(process.env.PORT ?? 8080)
const API_KEY = process.env.WHATSAPP_GATEWAY_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
// Throttle mínimo entre envíos (anti-baneo).
const SEND_THROTTLE_MS = Number(process.env.WHATSAPP_SEND_THROTTLE_MS ?? 1500)
// Para que la app pueda conversar: adonde se reenvia lo que llega y con que
// secreto se firma. Sin ambos, el gateway sigue siendo solo de salida.
const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
const AGENT_INBOUND_SECRET = process.env.AGENT_INBOUND_SECRET

if (!API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
        'Faltan envs: WHATSAPP_GATEWAY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
    )
    process.exit(1)
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
})

// ───────────────────────────────────────────────────────────────
// Connection manager (singleton)
// ───────────────────────────────────────────────────────────────
let sock: WASocket | null = null
let qrDataUrl: string | null = null
let connected = false
let me: { id: string; name?: string } | null = null
let lastSeen: string | null = null
let saveCreds: (() => Promise<void>) | null = null

async function startSock(): Promise<void> {
    const { state, saveCreds: save } = await useSupabaseAuthState(db)
    saveCreds = save
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
    })

    sock.ev.on('creds.update', () => saveCreds?.())

    // Mensajes entrantes. Solo si esta configurado: sin secreto no se reenvia
    // nada, para no mandar conversaciones a un endpoint sin firmar.
    if (APP_URL && AGENT_INBOUND_SECRET) {
        registrarEntrantes(sock, { appUrl: APP_URL, secret: AGENT_INBOUND_SECRET, logger })
        logger.info('Escucha de mensajes entrantes activada')
    } else {
        logger.info('Sin APP_URL/AGENT_INBOUND_SECRET: el gateway funciona solo de salida')
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrDataUrl = await QRCode.toDataURL(qr)
            logger.info('QR actualizado — escanealo para emparejar')
        }

        if (connection === 'open') {
            connected = true
            qrDataUrl = null
            lastSeen = new Date().toISOString()
            me = sock?.user ? { id: sock.user.id, name: sock.user.name } : null
            await db.from('whatsapp_session').upsert({
                id: 'agency',
                me,
                connected: true,
                last_connected_at: lastSeen,
                updated_at: lastSeen,
            })
            logger.info({ me }, 'WhatsApp conectado')
        }

        if (connection === 'close') {
            connected = false
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            await db
                .from('whatsapp_session')
                .update({ connected: false, updated_at: new Date().toISOString() })
                .eq('id', 'agency')
            logger.warn({ statusCode, loggedOut }, 'Conexión cerrada')
            if (!loggedOut) {
                // Reconexión automática.
                setTimeout(() => void startSock(), 3000)
            } else {
                // Sesión inválida: limpiar para forzar nuevo QR.
                qrDataUrl = null
                me = null
            }
        }
    })
}

// Cola de envío serializada con throttle (anti-baneo).
let sendChain: Promise<unknown> = Promise.resolve()
function enqueueSend<T>(task: () => Promise<T>): Promise<T> {
    const run = sendChain.then(task)
    sendChain = run.then(
        () => new Promise((r) => setTimeout(r, SEND_THROTTLE_MS)),
        () => new Promise((r) => setTimeout(r, SEND_THROTTLE_MS)),
    )
    return run
}

// ───────────────────────────────────────────────────────────────
// HTTP API
// ───────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

// Auth Bearer para el resto.
app.use((req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
})

app.get('/status', (_req, res) => {
    res.json({ connected, me, lastSeen })
})

app.get('/qr', (_req, res) => {
    res.json({ qr: connected ? null : qrDataUrl, connected })
})

app.get('/groups', async (_req, res) => {
    if (!sock || !connected) {
        return res.status(503).json({ error: 'WhatsApp no conectado' })
    }
    try {
        const all = await sock.groupFetchAllParticipating()
        const groups = Object.values(all).map((g) => ({ id: g.id, name: g.subject }))
        res.json({ groups })
    } catch (err) {
        logger.error({ err }, 'Error al listar grupos')
        res.status(500).json({ error: err instanceof Error ? err.message : 'Error' })
    }
})

app.post('/send', async (req, res) => {
    const { groupId, message } = req.body ?? {}
    if (typeof groupId !== 'string' || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'groupId y message son requeridos' })
    }
    // Se acepta tambien el chat privado: el agente responde a quien le escribe,
    // no solo a grupos. La validacion de sufijo se mantiene explicita para que
    // un jid mal formado falle aqui y no dentro de Baileys.
    const esGrupo = groupId.endsWith('@g.us')
    const esContacto = groupId.endsWith('@s.whatsapp.net')
    if (!esGrupo && !esContacto) {
        return res
            .status(400)
            .json({ error: 'groupId debe ser un jid de grupo (...@g.us) o de contacto (...@s.whatsapp.net)' })
    }
    if (!sock || !connected) {
        return res.status(503).json({ error: 'WhatsApp no conectado' })
    }
    try {
        const sent = await enqueueSend(() => sock!.sendMessage(groupId, { text: message }))
        res.json({ messageId: sent?.key?.id ?? null })
    } catch (err) {
        logger.error({ err }, 'Error al enviar mensaje')
        res.status(500).json({ error: err instanceof Error ? err.message : 'Error' })
    }
})

app.listen(PORT, () => {
    logger.info(`Gateway escuchando en :${PORT}`)
    void startSock()
})
