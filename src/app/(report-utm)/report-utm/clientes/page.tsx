import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente } from '@/lib/report-utm/types'
import { createClienteAction, syncPlatformClientesAction } from './_actions'
import { Plus, ExternalLink } from 'lucide-react'
import { StatusBadge } from '@/components/report-utm/StatusBadge'
import { formatDate } from '@/lib/report-utm/formatters'

export const dynamic = 'force-dynamic'

export default async function ClientesPage() {
    await syncPlatformClientesAction()

    const supabase = await reportUtmClient()
    const { data: clientes, error } = await supabase
        .from('clientes')
        .select('*')
        .order('created_at', { ascending: false })

    return (
        <div className="space-y-8">
            <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        Report-UTM · Workspace
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
                        Clientes
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Clientes de la plataforma y clientes manuales para seguimiento UTM.
                    </p>
                </div>
            </div>

            {/* Form alta cliente manual */}
            <form
                action={async (formData) => {
                    'use server'
                    await createClienteAction(formData)
                }}
                className="rounded-2xl border border-border bg-card p-6 space-y-4"
            >
                <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4 text-emerald-500" />
                    <h2 className="text-sm font-semibold text-foreground">
                        Nuevo cliente manual
                    </h2>
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        Solo seguimiento UTM · sin perfil en la plataforma principal
                    </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Field label="Nombre" name="nombre" required placeholder="Cliente Demo" />
                    <Field label="Slug" name="slug" placeholder="cliente-demo (opcional)" />
                    <Field label="Color" name="color" placeholder="emerald" />
                </div>
                <Field label="Descripción" name="descripcion" placeholder="Notas internas" textarea />

                <div className="flex justify-end">
                    <button
                        type="submit"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white shadow-sm nav-active-emerald transition-colors"
                    >
                        <Plus className="h-4 w-4" />
                        Crear cliente manual
                    </button>
                </div>
            </form>

            {/* Listado */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-6 py-4 border-b border-border flex items-center gap-3">
                    <h2 className="text-sm font-semibold text-foreground">
                        Listado ({clientes?.length ?? 0})
                    </h2>
                    {clientes && clientes.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">
                            {(clientes as ReportUtmCliente[]).filter(c => c.public_cliente_id).length} de plataforma
                            {' · '}
                            {(clientes as ReportUtmCliente[]).filter(c => !c.public_cliente_id).length} manuales
                        </span>
                    )}
                </div>

                {error && (
                    <div className="px-6 py-4 text-xs text-amber-700 dark:text-amber-400 font-mono bg-amber-50 dark:bg-amber-500/5">
                        {error.message}
                    </div>
                )}

                {clientes && clientes.length > 0 ? (
                    <table className="w-full">
                        <thead className="bg-muted/60">
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                <th className="px-6 py-3">Cliente</th>
                                <th className="px-6 py-3">Origen</th>
                                <th className="px-6 py-3">Slug</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3">Creado</th>
                                <th className="px-6 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {(clientes as ReportUtmCliente[]).map((c) => (
                                <tr key={c.id} className="hover:bg-accent">
                                    <td className="px-6 py-3">
                                        <p className="text-sm font-medium text-foreground">{c.nombre}</p>
                                        {c.descripcion && (
                                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                                {c.descripcion}
                                            </p>
                                        )}
                                    </td>
                                    <td className="px-6 py-3">
                                        <OrigenBadge isPlataforma={!!c.public_cliente_id} />
                                    </td>
                                    <td className="px-6 py-3 text-xs font-mono text-muted-foreground">
                                        {c.slug}
                                    </td>
                                    <td className="px-6 py-3">
                                        <StatusBadge status={c.status} />
                                    </td>
                                    <td className="px-6 py-3 text-xs text-muted-foreground">
                                        {formatDate(c.created_at)}
                                    </td>
                                    <td className="px-6 py-3 text-right">
                                        <Link
                                            href={`/report-utm/clientes/${c.id}`}
                                            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                        >
                                            Abrir <ExternalLink className="h-3 w-3" />
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                        No hay clientes todavía. Crea el primero arriba.
                    </div>
                )}
            </div>
        </div>
    )
}

function OrigenBadge({ isPlataforma }: { isPlataforma: boolean }) {
    if (isPlataforma) {
        return (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                Plataforma
            </span>
        )
    }
    return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-muted-foreground">
            Manual
        </span>
    )
}

function Field({
    label,
    name,
    required,
    placeholder,
    textarea,
}: {
    label: string
    name: string
    required?: boolean
    placeholder?: string
    textarea?: boolean
}) {
    const baseClass = `
        w-full px-3 py-2 text-sm rounded-lg
        bg-muted
        border border-border
        text-foreground placeholder:text-muted-foreground/70
        focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40
        transition-colors
    `
    return (
        <label className={textarea ? 'col-span-full block' : 'block'}>
            <span className="block text-[11px] font-medium text-muted-foreground mb-1">
                {label}{required && <span className="text-red-500"> *</span>}
            </span>
            {textarea ? (
                <textarea name={name} placeholder={placeholder} rows={2} className={baseClass} />
            ) : (
                <input name={name} placeholder={placeholder} required={required} className={baseClass} />
            )}
        </label>
    )
}
