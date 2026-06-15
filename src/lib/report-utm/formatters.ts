/** Formats a monetary amount with currency prefix. */
export function formatCurrency(amount: number | string, currency: string): string {
    const n = typeof amount === 'string' ? parseFloat(amount) : amount
    if (isNaN(n)) return `${currency} —`
    return `${currency} ${n.toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`
}

/** Short date: DD/MM/YYYY */
export function formatDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    })
}

/** Date + time: DD/MM/YYYY HH:MM */
export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

/** Time only: HH:MM:SS */
export function formatTime(iso: string | null | undefined): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    })
}

/** Compact thousands: 1 500 → "1.5k", 2 000 000 → "2M" */
export function formatCompact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}
