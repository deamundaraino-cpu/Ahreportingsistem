import Link from 'next/link'
import { reportUtmClient } from '@/lib/report-utm/client'
import type { ReportUtmCliente } from '@/lib/report-utm/types'
import { createClienteAction } from './_actions'
import { Plus, ExternalLink } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function ClientesPage() {
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
                    <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 mt-1">
                        Clientes
                    </h1>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                        Clientes propios de este módulo. No se mezclan con los clientes del reporting principal.
                    </p>
                </div>
            </div>

            {/* Form alta */}
            <form
                action={async (formData) => {
                    'use server'
                    await createClienteAction(formData)
                }}
                className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-6 space-y-4"
            >
                <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4 text-emerald-500" />
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Nuevo cliente
                    </h2>
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
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white shadow-sm transition-colors"
                        style={{ background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)' }}
                    >
                        <Plus className="h-4 w-4" />
                        Crear cliente
                    </button>
                </div>
            </form>

            {/* Listado */}
            <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 overflow-hidden">
                <div className="px-6 py-4 border-b border-zinc-200 dark:border-white/[0.06]">
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Listado ({clientes?.length ?? 0})
                    </h2>
                </div>

                {error && (
                    <div className="px-6 py-4 text-xs text-amber-700 dark:text-amber-400 font-mono bg-amber-50 dark:bg-amber-500/5">
                        {error.message}
                    </div>
                )}

                {clientes && clientes.length > 0 ? (
                    <table className="w-full">
                        <thead className="bg-zinc-50 dark:bg-white/[0.02]">
                            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                                <th className="px-6 py-3">Cliente</th>
                                <th className="px-6 py-3">Slug</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3">Creado</th>
                                <th className="px-6 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100 dark:divide-white/[0.04]">
                            {(clientes as ReportUtmCliente[]).map((c) => (
                                <tr key={c.id} className="hover:bg-zinc-50 dark:hover:bg-white/[0.02]">
                                    <td className="px-6 py-3">
                                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.nombre}</p>
                                        {c.descripcion && (
                                            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-0.5 line-clamp-1">
                                                {c.descripcion}
                                            </p>
                                        )}
                                    </td>
                                    <td className="px-6 py-3 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                                        {c.slug}
                                    </td>
                                    <td className="px-6 py-3">
                                        <StatusPill status={c.status} />
                                    </td>
                                    <td className="px-6 py-3 text-xs text-zinc-500 dark:text-zinc-500">
                                        {new Date(c.created_at).toLocaleDateString()}
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
                    <div className="px-6 py-12 text-center text-sm text-zinc-500 dark:text-zinc-500">
                        No hay clientes todavía. Crea el primero arriba.
                    </div>
                )}
            </div>
        </div>
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
        bg-zinc-50 dark:bg-white/[0.04]
        border border-zinc-200 dark:border-white/[0.06]
        text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600
        focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40
        transition-colors
    `
    return (
        <label className={textarea ? 'col-span-full block' : 'block'}>
            <span className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
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

function StatusPill({ status }: { status: string }) {
    const cls =
        status === 'active'
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            : status === 'paused'
            ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            : 'bg-zinc-100 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-400'
    return (
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}>
            {status}
        </span>
    )
}
