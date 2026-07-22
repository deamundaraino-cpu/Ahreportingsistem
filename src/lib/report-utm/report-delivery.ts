// Entrega de un informe BI a su cliente: registra la entrega en el historial
// (public.bi_report_deliveries) y envía el link por WhatsApp y/o Email.
//
// Se usa desde el cron (`/api/cron/bi-report-digest`) y desde el reenvío manual
// (`POST /api/report-utm/bi/reports/[reportId]/deliveries`), para que ambos
// caminos produzcan exactamente el mismo historial y el mismo mensaje.

import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify'
import { sendEmail, buildReportEmailHtml, isEmailConfigured } from '@/lib/email'
import type { ReportPeriod } from './report-periods'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>

const COLOR_HEX: Record<string, string> = {
    blue: '#3b82f6', emerald: '#10b981', green: '#22c55e', red: '#ef4444',
    amber: '#f59e0b', orange: '#f97316', violet: '#8b5cf6', purple: '#a855f7',
    cyan: '#06b6d4', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
    slate: '#64748b', rose: '#f43f5e',
}

export interface DeliverableReport {
    id: string
    nombre: string
    cliente_id?: string | null
}

export interface DeliveryChannels {
    whatsapp?: boolean
    email?: boolean
}

export interface DeliverReportArgs {
    db: Db
    report: DeliverableReport
    /** Origen absoluto del sitio, sin barra final. Ej. https://reportes.adshouse.cloud */
    origin: string
    period: ReportPeriod
    channels: DeliveryChannels
    emails?: string[]
    /**
     * Reenviar un período ya entregado: reutiliza la fila y su token en vez de
     * omitir el envío. El cron NUNCA usa force (así el UNIQUE actúa de dedup).
     */
    force?: boolean
}

export interface DeliverReportResult {
    reportId: string
    nombre: string
    period: string
    url?: string
    skipped?: 'already_sent'
    channels?: Record<string, unknown>
    error?: string
}

/** Identidad del cliente para el branding del mensaje y el ruteo de WhatsApp. */
async function resolveCliente(db: Db, clienteId?: string | null) {
    if (!clienteId) return { clienteName: undefined, accent: undefined, publicClienteId: null as string | null }
    const { data: cli } = await db
        .schema('report_utm').from('clientes')
        .select('nombre, color, config, public_cliente_id')
        .eq('id', clienteId).maybeSingle()
    if (!cli) return { clienteName: undefined, accent: undefined, publicClienteId: null as string | null }
    const cfg = (cli.config ?? {}) as { accent?: string }
    return {
        clienteName: cli.nombre as string | undefined,
        accent: cfg.accent || (cli.color ? COLOR_HEX[cli.color as string] : undefined),
        publicClienteId: (cli.public_cliente_id ?? null) as string | null,
    }
}

export async function deliverReport({
    db, report, origin, period, channels, emails, force,
}: DeliverReportArgs): Promise<DeliverReportResult> {
    const base: DeliverReportResult = { reportId: report.id, nombre: report.nombre, period: period.label }

    // ── 1. Registrar la entrega (el UNIQUE(report_id, period_label) es el dedup) ──
    let token = randomBytes(16).toString('hex')
    const { data: inserted, error: insertError } = await db
        .from('bi_report_deliveries')
        .insert({
            report_id:      report.id,
            period_type:    period.type,
            period_label:   period.label,
            date_from:      period.from,
            date_to:        period.to,
            delivery_token: token,
        })
        .select('id, delivery_token')
        .single()

    let deliveryId: string
    if (insertError) {
        const isDuplicate = insertError.code === '23505'
        if (!isDuplicate) return { ...base, error: insertError.message }
        // Ya existe una entrega para este período.
        const { data: existing } = await db
            .from('bi_report_deliveries')
            .select('id, delivery_token')
            .eq('report_id', report.id)
            .eq('period_label', period.label)
            .maybeSingle()
        if (!force || !existing) return { ...base, skipped: 'already_sent' }
        deliveryId = existing.id
        token = existing.delivery_token
    } else {
        deliveryId = inserted.id
        token = inserted.delivery_token
    }

    const url = `${origin}/report/bi/d/${token}`
    const { clienteName, accent, publicClienteId } = await resolveCliente(db, report.cliente_id)
    const outcome: Record<string, unknown> = {}

    // ── 2. WhatsApp ──
    if (channels.whatsapp) {
        const message =
            `📊 *${report.nombre}*\n` +
            (clienteName ? `Informe para ${clienteName}\n` : '') +
            `Período: ${period.label}\n\n` +
            `Ver informe:\n${url}`
        try {
            // El ruteo de WhatsApp usa el cliente del sistema principal (public).
            outcome.whatsapp = await sendWhatsAppNotification({
                db,
                clienteId: publicClienteId,
                notificationType: 'report_ready',
                message,
            })
        } catch (err) {
            outcome.whatsapp = { error: err instanceof Error ? err.message : 'error' }
        }
    }

    // ── 3. Email ──
    const recipients = (emails ?? []).map(e => e.trim()).filter(Boolean)
    if (channels.email && recipients.length) {
        if (!isEmailConfigured()) {
            outcome.email = { error: 'GMAIL_USER / GMAIL_APP_PASSWORD no configurados' }
        } else {
            const html = buildReportEmailHtml({
                reportName: report.nombre,
                clienteName,
                url,
                accent,
                periodLabel: period.label,
            })
            outcome.email = await sendEmail({
                to: recipients,
                subject: `📊 ${report.nombre} — ${period.label}`,
                html,
            })
        }
    } else if (channels.email) {
        outcome.email = { error: 'Sin destinatarios' }
    }

    // ── 4. Cerrar el registro ──
    const anyOk = Object.values(outcome).some(r => (r as { ok?: boolean })?.ok)
    await db.from('bi_report_deliveries')
        .update({ sent_to: outcome, sent_at: new Date().toISOString() })
        .eq('id', deliveryId)

    // Solo se marca el informe como enviado si algún canal salió bien; así un
    // fallo de SMTP no deja el informe "entregado" sin que el cliente lo reciba.
    if (anyOk) {
        await db.from('bi_reports')
            .update({ schedule_last_sent_at: new Date().toISOString() })
            .eq('id', report.id)
    }

    return { ...base, url, channels: outcome }
}
