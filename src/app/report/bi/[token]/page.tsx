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

export default async function PublicBiReportPage({ params }: Params) {
    const { token } = await params
    const db = await createAdminClient()

    const { data, error } = await db
        .from('bi_reports')
        .select('*')
        .eq('public_token', token)
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

    // Branding de agencia (system_settings) + identidad del cliente (report_utm.clientes).
    const [{ data: brandingRow }, clienteRes] = await Promise.all([
        db.from('system_settings').select('value').eq('key', 'branding').maybeSingle(),
        report.cliente_id
            ? db.schema('report_utm').from('clientes').select('nombre,color,config').eq('id', report.cliente_id).maybeSingle()
            : Promise.resolve({ data: null }),
    ])

    const branding = (brandingRow?.value ?? {}) as { logo_url?: string; colors?: { primary?: string } }
    const cliente = (clienteRes?.data ?? null) as { nombre?: string; color?: string; config?: Record<string, unknown> } | null
    const clienteConfig = (cliente?.config ?? {}) as { logo_url?: string; accent?: string }
    const accent =
        clienteConfig.accent ||
        (cliente?.color ? COLOR_HEX[cliente.color] : undefined) ||
        branding.colors?.primary ||
        '#10b981'

    return (
        <div className="min-h-screen bg-background">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
                <BiPublicHeader
                    agencyLogo={branding.logo_url || undefined}
                    accent={accent}
                    clienteName={cliente?.nombre}
                    clienteLogo={clienteConfig.logo_url}
                    reportName={report.nombre}
                />
                <BiReportCanvas report={report} readonly publicToken={token} />
                <p className="mt-8 text-center text-[10px] text-muted-foreground">
                    Vista de solo lectura · {cliente?.nombre ? `${cliente.nombre} · ` : ''}Ad House Reporting
                </p>
            </div>
        </div>
    )
}
