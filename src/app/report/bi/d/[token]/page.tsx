// Link público de una ENTREGA del historial: mismo informe que /report/bi/[token]
// pero con el rango de fechas congelado en el período entregado, y con un
// navegador de "otras entregas" para que el cliente consulte períodos previos.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/utils/supabase/server'
import { BiReportCanvas } from '@/components/report-utm/bi/BiReportCanvas'
import { BiPublicHeader } from '@/components/report-utm/bi/BiPublicHeader'
import type { BiReport } from '@/components/report-utm/bi/BiTypes'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

// Nombres de color (report_utm.clientes.color) → hex para el acento del cliente.
const COLOR_HEX: Record<string, string> = {
    blue: '#3b82f6', emerald: '#10b981', green: '#22c55e', red: '#ef4444',
    amber: '#f59e0b', orange: '#f97316', violet: '#8b5cf6', purple: '#a855f7',
    cyan: '#06b6d4', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
    slate: '#64748b', rose: '#f43f5e',
}

export default async function PublicBiDeliveryPage({ params }: Params) {
    const { token } = await params
    const db = await createAdminClient()

    const { data: delivery, error: deliveryError } = await db
        .from('bi_report_deliveries')
        .select('*')
        .eq('delivery_token', token)
        .maybeSingle()

    if (deliveryError || !delivery) notFound()

    const { data, error } = await db
        .from('bi_reports')
        .select('*')
        .eq('id', delivery.report_id)
        .maybeSingle()

    if (error || !data) notFound()

    const report: BiReport = {
        id:          data.id,
        nombre:      data.nombre,
        descripcion: data.descripcion,
        layout:      Array.isArray(data.layout) ? data.layout : [],
        filters:     typeof data.filters === 'object' && data.filters ? data.filters : {},
        calculated_fields: Array.isArray(data.calculated_fields) ? data.calculated_fields : [],
        cliente_id:  data.cliente_id,
    }

    // Branding de agencia (system_settings) + identidad del cliente + entregas hermanas.
    const [{ data: brandingRow }, clienteRes, { data: siblings }] = await Promise.all([
        db.from('system_settings').select('value').eq('key', 'branding').maybeSingle(),
        report.cliente_id
            ? db.schema('report_utm').from('clientes').select('nombre,color,config').eq('id', report.cliente_id).maybeSingle()
            : Promise.resolve({ data: null }),
        db.from('bi_report_deliveries')
            .select('id, period_label, delivery_token, sent_at')
            .eq('report_id', delivery.report_id)
            .order('sent_at', { ascending: false })
            .limit(12),
    ])

    const branding = (brandingRow?.value ?? {}) as { logo_url?: string; colors?: { primary?: string } }
    const cliente = (clienteRes?.data ?? null) as { nombre?: string; color?: string; config?: Record<string, unknown> } | null
    const clienteConfig = (cliente?.config ?? {}) as { logo_url?: string; accent?: string }
    const accent =
        clienteConfig.accent ||
        (cliente?.color ? COLOR_HEX[cliente.color] : undefined) ||
        branding.colors?.primary ||
        '#10b981'

    const otherDeliveries = (siblings ?? []).filter(d => d.delivery_token !== token)

    return (
        <div className="min-h-screen bg-background">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
                <BiPublicHeader
                    agencyLogo={branding.logo_url || undefined}
                    accent={accent}
                    clienteName={cliente?.nombre}
                    clienteLogo={clienteConfig.logo_url}
                    reportName={`${report.nombre} — ${delivery.period_label}`}
                    periodLabel={delivery.period_label}
                />

                {/* Navegador de entregas anteriores */}
                {otherDeliveries.length > 0 && (
                    <div className="mb-6 flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Otros períodos:
                        </span>
                        {otherDeliveries.map(d => (
                            <Link
                                key={d.id}
                                href={`/report/bi/d/${d.delivery_token}`}
                                className="px-2.5 py-1 rounded-full bg-muted text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            >
                                {d.period_label}
                            </Link>
                        ))}
                    </div>
                )}

                <BiReportCanvas
                    report={report}
                    readonly
                    publicToken={token}
                    lockedDates={{ from: delivery.date_from, to: delivery.date_to }}
                />

                <p className="mt-8 text-center text-[10px] text-muted-foreground">
                    {delivery.period_label} · {delivery.date_from} → {delivery.date_to} ·{' '}
                    {cliente?.nombre ? `${cliente.nombre} · ` : ''}Ad House Reporting
                </p>
            </div>
        </div>
    )
}
