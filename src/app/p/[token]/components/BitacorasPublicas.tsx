import { BookOpen } from 'lucide-react'
import type { Bitacora } from '@/app/(app)/admin/settings/[id]/_actions'

export function BitacorasPublicas({ entries }: { entries: Bitacora[] }) {
    return (
        <section className="mt-10 border-t border-border pt-8">
            <div className="flex items-center gap-2 mb-5">
                <BookOpen className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">Actualizaciones</h2>
            </div>
            <div className="space-y-4 max-w-3xl">
                {entries.map((entry) => (
                    <div key={entry.id} className="border border-border rounded-lg p-4 bg-card">
                        <p className="font-medium text-sm">{entry.titulo}</p>
                        <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{entry.contenido}</p>
                        <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground/60">
                            {entry.author_name && <span>{entry.author_name}</span>}
                            {entry.author_name && <span>·</span>}
                            <span>
                                {new Date(entry.created_at).toLocaleDateString('es', {
                                    day: '2-digit',
                                    month: 'long',
                                    year: 'numeric',
                                })}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    )
}
