import { Crosshair, Cookie, Tag, MinusCircle } from 'lucide-react'

const CONFIG = {
    click_id: {
        label: 'click_id',
        icon: Crosshair,
        cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
        title: 'Cruzado por click_id (fbclid/gclid). Atribución multi-touch confiable.',
    },
    visitor_cookie: {
        label: 'cookie',
        icon: Cookie,
        cls: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
        title: 'Cruzado por cookie de visitante. Multi-touch parcial.',
    },
    utm_only: {
        label: 'utm',
        icon: Tag,
        cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400',
        title: 'Solo UTMs propios de la venta (sin cruce con pixel).',
    },
    none: {
        label: 'none',
        icon: MinusCircle,
        cls: 'bg-zinc-100 text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-500',
        title: 'Sin información de atribución.',
    },
} as const

export function AttributionBadge({ method }: { method: string | null }) {
    const key = (method ?? 'none') as keyof typeof CONFIG
    const c = CONFIG[key] ?? CONFIG.none
    const Icon = c.icon
    return (
        <span
            title={c.title}
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${c.cls}`}
        >
            <Icon className="h-3 w-3" />
            {c.label}
        </span>
    )
}
