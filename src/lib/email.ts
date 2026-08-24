// Envío de email vía SMTP de Gmail (nodemailer).
// Requiere GMAIL_USER + GMAIL_APP_PASSWORD (contraseña de aplicación de Google,
// no la contraseña normal de la cuenta). El remitente visible sale de
// EMAIL_FROM_NAME (default "Ad House Reporting") sobre la dirección GMAIL_USER.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export function isEmailConfigured(): boolean {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

// Transport cacheado entre invocaciones (reutiliza la conexión en la misma
// instancia serverless; si cambian las credenciales se recrea).
let cachedTransport: Transporter | null = null;
let cachedFor = '';

function getTransport(user: string, pass: string): Transporter {
  if (cachedTransport && cachedFor === user) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  cachedFor = user;
  return cachedTransport;
}

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
}: SendEmailArgs): Promise<SendEmailResult> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass)
    return { ok: false, error: 'GMAIL_USER / GMAIL_APP_PASSWORD no configurados' };

  const recipients = (Array.isArray(to) ? to : [to]).map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) return { ok: false, error: 'Sin destinatarios' };

  const fromName = process.env.EMAIL_FROM_NAME || 'Ad House Reporting';

  try {
    const info = await getTransport(user, pass).sendMail({
      from: `"${fromName}" <${user}>`,
      // Destinatarios en BCC: cada cliente recibe el informe sin ver los
      // correos de los demás.
      to: user,
      bcc: recipients,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    return { ok: true, id: info.messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Error SMTP' };
  }
}

/** Plantilla HTML sencilla y branded para el email de informe. */
export function buildReportEmailHtml(opts: {
  reportName: string;
  clienteName?: string;
  url: string;
  agencyName?: string;
  accent?: string;
  intro?: string;
  /** Período reportado. Ej. "Semana 2 de Julio 2026". */
  periodLabel?: string;
}): string {
  const accent = opts.accent || '#10b981';
  const agency = opts.agencyName || 'Ad House Reporting';
  const intro =
    opts.intro ||
    (opts.periodLabel
      ? `Ya está disponible tu informe de rendimiento correspondiente a ${opts.periodLabel}. Haz clic para verlo:`
      : 'Tu informe de rendimiento ya está disponible. Haz clic para verlo:');
  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <div style="border-top:4px solid ${accent};background:#fff;border:1px solid #eee;border-radius:12px;padding:28px">
    <p style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888;margin:0 0 4px">${agency}</p>
    <h1 style="font-size:22px;margin:0 0 8px;color:#111">${escapeHtml(opts.reportName)}</h1>
    ${opts.periodLabel ? `<p style="display:inline-block;margin:0 0 12px;padding:4px 12px;border-radius:999px;background:${accent}1a;color:${accent};font-size:12px;font-weight:bold">${escapeHtml(opts.periodLabel)}</p>` : ''}
    ${opts.clienteName ? `<p style="margin:0 0 16px;color:#555">Informe para <strong style="color:${accent}">${escapeHtml(opts.clienteName)}</strong></p>` : ''}
    <p style="color:#444;line-height:1.5">${escapeHtml(intro)}</p>
    <p style="margin:24px 0">
      <a href="${opts.url}" style="background:${accent};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block">Ver informe</a>
    </p>
    <p style="font-size:12px;color:#999;word-break:break-all">${opts.url}</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#aaa;margin-top:16px">Enviado automáticamente por ${agency}</p>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}
