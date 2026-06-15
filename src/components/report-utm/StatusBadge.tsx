const STATUS_CLASSES: Record<string, string> = {
    // Sale status
    approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    refunded: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    chargeback: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    // Client status
    active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    paused: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    archived: 'bg-muted text-muted-foreground',
    // Integration status
    inactive: 'bg-muted text-muted-foreground',
    error: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
}

export function StatusBadge({ status }: { status: string }) {
    const cls = STATUS_CLASSES[status] ?? 'bg-muted text-muted-foreground'
    return (
        <span className={`inline-flex text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${cls}`}>
            {status}
        </span>
    )
}

/**
 * For integration cards where "active" uses a platform-specific accent color.
 * Falls back to StatusBadge for inactive/error states.
 */
export function IntegrationStatusBadge({
    status,
    activeCls,
}: {
    status: string
    activeCls: string
}) {
    if (status !== 'active') return <StatusBadge status={status} />
    return (
        <span className={`inline-flex text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${activeCls}`}>
            {status}
        </span>
    )
}
