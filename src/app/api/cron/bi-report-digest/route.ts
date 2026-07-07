// Cron: envío automático de informes BI programados (Fase 4).
//
// Recorre los informes (bi_reports) con schedule.enabled=true, decide si toca
// enviar según la frecuencia (semanal/mensual) y el último envío, se asegura de
// que exista public_token, y entrega el link por WhatsApp y/o Email.
// Protegido por CRON_SECRET (mismo patrón que los demás crons).

import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createAdminClient } from '@/utils/supabase/server'
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify'
import { sendEmail, buildReportEmailHtml, isEmailConfigured } from '@/lib/email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface Schedule {
    enabled?: boolean
    frequency?: 'weekly' | 'monthly'
    channels?: { whatsapp?: boolean; email?: boolean }
    emails?: string[]
}

const COLOR_HEX: Record<string, string> = {
    blue: '#3b82f6', emerald: '#10b981', green: '#22c55e', red: '#ef4444',
    amber: '#f59e0b', orange: '#f97316', violet: '#8b5cf6', purple: '#a855f7',
    cyan: '#06b6d4', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
    slate: '#64748b', rose: '#f43f5e',
}

function baseUrl(request: Request): string {
    const env = process.env.NEXT_PUBLIC_APP_URL
    if (env) return env.replace(/\/$/, '')
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    if (host) return `https://${host}`
    return 'https://reportes.adshouse.cloud'
}

function isDue(freq: 'weekly' | 'monthly' | undefined, lastSentAt: string | null): boolean {
    if (!lastSentAt) return true
    const days = (Date.now() - new Date(lastSentAt).getTime()) / 86_400_000
    return freq === 'monthly' ? days >= 28 : days >= 7
}

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const db = await createAdminClient()
    const origin = baseUrl(request)

    const { data: reports, error } = await db
        .from('bi_reports')
        .select('id, nombre, cliente_id, public_token, schedule, schedule_last_sent_at')
        .eq('schedule->>enabled', 'true')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const results: Array<Record<string, unknown>> = []

    for (const rep of reports ?? []) {
        const schedule = (rep.schedule ?? {}) as Schedule
        if (!schedule.enabled) continue
        if (!isDue(schedule.frequency, rep.schedule_last_sent_at)) {
            results.push({ id: rep.id, skipped: 'not_due' })
            continue
        }

        // Asegurar token público (reutiliza el existente o crea uno).
        let token: string = rep.public_token
        if (!token) {
            token = randomBytes(16).toString('hex')
            await db.from('bi_reports').update({ public_token: token }).eq('id', rep.id)
        }
        const url = `${origin}/report/bi/${token}`

        // Identidad del cliente (nombre + acento) para el mensaje/branding.
        let clienteName: string | undefined
        let accent: string | undefined
        let publicClienteId: string | null = null
        if (rep.cliente_id) {
            const { data: cli } = await db
                .schema('report_utm').from('clientes')
                .select('nombre, color, config, public_cliente_id')
                .eq('id', rep.cliente_id).maybeSingle()
            if (cli) {
                clienteName = cli.nombre
                publicClienteId = cli.public_cliente_id ?? null
                const cfg = (cli.config ?? {}) as { accent?: string }
                accent = cfg.accent || (cli.color ? COLOR_HEX[cli.color] : undefined)
            }
        }

        const channels = schedule.channels ?? {}
        const outcome: Record<string, unknown> = { id: rep.id, nombre: rep.nombre, url }

        // ── WhatsApp ──
        if (channels.whatsapp) {
            const message =
                `📊 *${rep.nombre}*\n` +
                (clienteName ? `Informe para ${clienteName}\n` : '') +
                `Ver informe actualizado:\n${url}`
            try {
                // El ruteo de WhatsApp usa el cliente del sistema principal (public).
                const res = await sendWhatsAppNotification({
                    db,
                    clienteId: publicClienteId,
                    notificationType: 'report_ready',
                    message,
                })
                outcome.whatsapp = res
            } catch (err) {
                outcome.whatsapp = { error: err instanceof Error ? err.message : 'error' }
            }
        }

        // ── Email ──
        const emails = (schedule.emails ?? []).map(e => e.trim()).filter(Boolean)
        if (channels.email && emails.length) {
            if (!isEmailConfigured()) {
                outcome.email = { error: 'RESEND_API_KEY no configurado' }
            } else {
                const html = buildReportEmailHtml({ reportName: rep.nombre, clienteName, url, accent })
                const res = await sendEmail({ to: emails, subject: `📊 ${rep.nombre}`, html })
                outcome.email = res
            }
        }

        // Marcar como enviado (evita reenvío en la próxima corrida del cron).
        await db.from('bi_reports').update({ schedule_last_sent_at: new Date().toISOString() }).eq('id', rep.id)
        results.push(outcome)
    }

    return NextResponse.json({ ok: true, processed: results.length, results })
}
