// Envío de email vía la API REST de Resend (sin dependencia npm).
// Requiere RESEND_API_KEY. El remitente sale de RESEND_FROM (debe ser un
// dominio verificado en Resend), con fallback a onboarding@resend.dev.

export interface SendEmailArgs {
    to: string | string[]
    subject: string
    html: string
    replyTo?: string
}

export interface SendEmailResult {
    ok: boolean
    id?: string
    error?: string
}

export function isEmailConfigured(): boolean {
    return !!process.env.RESEND_API_KEY
}

export async function sendEmail({ to, subject, html, replyTo }: SendEmailArgs): Promise<SendEmailResult> {
    const key = process.env.RESEND_API_KEY
    if (!key) return { ok: false, error: 'RESEND_API_KEY no configurado' }

    const from = process.env.RESEND_FROM || 'Ad House Reporting <onboarding@resend.dev>'
    const recipients = Array.isArray(to) ? to : [to]
    if (recipients.length === 0) return { ok: false, error: 'Sin destinatarios' }

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to: recipients,
                subject,
                html,
                ...(replyTo ? { reply_to: replyTo } : {}),
            }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
            return { ok: false, error: json?.message || `Resend HTTP ${res.status}` }
        }
        return { ok: true, id: json?.id }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Error de red' }
    }
}

/** Plantilla HTML sencilla y branded para el email de informe. */
export function buildReportEmailHtml(opts: {
    reportName: string
    clienteName?: string
    url: string
    agencyName?: string
    accent?: string
    intro?: string
}): string {
    const accent = opts.accent || '#10b981'
    const agency = opts.agencyName || 'Ad House Reporting'
    const intro = opts.intro || 'Tu informe de rendimiento ya está disponible. Haz clic para verlo:'
    return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="border-top:4px solid ${accent};background:#fff;border:1px solid #eee;border-radius:12px;padding:28px">
    <p style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888;margin:0 0 4px">${agency}</p>
    <h1 style="font-size:22px;margin:0 0 8px;color:#111">${escapeHtml(opts.reportName)}</h1>
    ${opts.clienteName ? `<p style="margin:0 0 16px;color:#555">Informe para <strong style="color:${accent}">${escapeHtml(opts.clienteName)}</strong></p>` : ''}
    <p style="color:#444;line-height:1.5">${escapeHtml(intro)}</p>
    <p style="margin:24px 0">
      <a href="${opts.url}" style="background:${accent};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block">Ver informe</a>
    </p>
    <p style="font-size:12px;color:#999;word-break:break-all">${opts.url}</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#aaa;margin-top:16px">Enviado automáticamente por ${agency}</p>
</div>`.trim()
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
