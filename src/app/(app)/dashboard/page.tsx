import { getClientes, getActiveAlerts, type ActiveAlert } from "../admin/settings/_actions"
import { getAllSoporteTickets } from "./_actions"
import {
  BarChart3,
  ArrowRight,
  Users,
  Zap,
  Link2,
  Settings,
  Key,
  TrendingUp,
  Globe,
  ShoppingCart,
  Activity,
  ChevronRight,
  AlertTriangle,
  Bell,
} from "lucide-react"

export default async function DashboardHomePage() {
  const [clientes, activeAlerts, soporteResult] = await Promise.all([getClientes(), getActiveAlerts(), getAllSoporteTickets()])

  const totalClientes = clientes?.length ?? 0
  const totalIntegrations = (clientes ?? []).reduce((acc: number, c: any) => {
    let n = 0
    if (c.config_api?.meta_token) n++
    if (c.config_api?.hotmart_token || c.config_api?.hotmart_basic) n++
    if (c.config_api?.ga_property_id) n++
    return acc + n
  }, 0)
  const activePlatforms = new Set<string>()
  ;(clientes ?? []).forEach((c: any) => {
    if (c.config_api?.meta_token) activePlatforms.add("meta")
    if (c.config_api?.hotmart_token || c.config_api?.hotmart_basic) activePlatforms.add("hotmart")
    if (c.config_api?.ga_property_id) activePlatforms.add("ga4")
  })

  return (
    <div className="space-y-8">
      {/* ── Welcome Header ── */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-blue/10 via-transparent to-brand-red/8 p-6 sm:p-8">
        {/* Background decorative glow */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 ambient-glow-blue" />
        <div className="pointer-events-none absolute -bottom-12 -left-12 h-40 w-40 ambient-glow-red" />

        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-blue/15">
                <Activity className="h-4 w-4 text-brand-blue dark:text-brand-blue-light" />
              </div>
              <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Panel Principal
              </span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              AdsHouse Reporting
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Centro de control de métricas y embudos de venta para todos tus clientes.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Sistema Activo
            </div>
          </div>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Clientes Totales"
          value={totalClientes}
          color="blue"
        />
        <StatCard
          icon={<Zap className="h-5 w-5" />}
          label="Integraciones Activas"
          value={totalIntegrations}
          color="amber"
        />
        <StatCard
          icon={<Globe className="h-5 w-5" />}
          label="Plataformas Conectadas"
          value={activePlatforms.size}
          suffix={`/ 3`}
          color="emerald"
        />
        <StatCard
          icon={<Bell className="h-5 w-5" />}
          label="Alertas Activas"
          value={activeAlerts.length}
          color={activeAlerts.length > 0 ? "red" : "zinc"}
          pulse={activeAlerts.length > 0}
        />
      </div>

      {/* ── Active Alerts Panel ── */}
      {activeAlerts.length > 0 && (
        <AlertsPanel alerts={activeAlerts} />
      )}

      {/* ── Clients Section ── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Directorio de Clientes
            </h2>
            <p className="text-sm text-muted-foreground/70">
              Accede al embudo consolidado de cada cliente.
            </p>
          </div>
          {totalClientes > 0 && (
            <span className="text-xs text-muted-foreground/70">
              {totalClientes} {totalClientes === 1 ? "cliente" : "clientes"}
            </span>
          )}
        </div>

        {!clientes || clientes.length === 0 ? (
          <EmptyClients />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clientes.map((cliente: any) => (
              <ClientCard key={cliente.id} cliente={cliente} />
            ))}
          </div>
        )}
      </section>

      {/* ── Quick Access ── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Acceso Rápido</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QuickLink
            href="/report-utm"
            icon={<TrendingUp className="h-5 w-5" />}
            title="Report UTM"
            description="Atribución por UTMs y ventas"
            color="blue"
          />
          <QuickLink
            href="/admin/settings"
            icon={<Settings className="h-5 w-5" />}
            title="Ajustes"
            description="Configura clientes y APIs"
            color="zinc"
          />
          <QuickLink
            href="/admin/api-tokens"
            icon={<Key className="h-5 w-5" />}
            title="API Tokens"
            description="Gestiona tokens de acceso"
            color="amber"
          />
          <QuickLink
            href="/admin/reports"
            icon={<BarChart3 className="h-5 w-5" />}
            title="Reportes"
            description="Reportes mensuales por cliente"
            color="emerald"
          />
        </div>
      </section>

      {/* ── Soporte Ads House ── */}
      <SoportePanel tickets={soporteResult.data ?? []} />
    </div>
  )
}

/* ─── Sub-components ────────────────────────────────────────────────────────── */

function StatCard({
  icon,
  label,
  value,
  suffix,
  color,
  pulse,
}: {
  icon: React.ReactNode
  label: string
  value: number
  suffix?: string
  color: "blue" | "amber" | "emerald" | "red" | "zinc"
  pulse?: boolean
}) {
  const colorMap = {
    blue: {
      bg: "bg-brand-blue/10",
      icon: "text-brand-blue dark:text-brand-blue-light",
      ring: "ring-brand-blue/20",
      value: "text-foreground",
    },
    amber: {
      bg: "bg-amber-500/10",
      icon: "text-amber-600 dark:text-amber-400",
      ring: "ring-amber-500/20",
      value: "text-foreground",
    },
    emerald: {
      bg: "bg-emerald-500/10",
      icon: "text-emerald-600 dark:text-emerald-400",
      ring: "ring-emerald-500/20",
      value: "text-foreground",
    },
    red: {
      bg: "bg-red-500/10",
      icon: "text-red-600 dark:text-red-400",
      ring: "ring-red-500/20",
      value: "text-red-600 dark:text-red-400",
    },
    zinc: {
      bg: "bg-muted",
      icon: "text-muted-foreground/70",
      ring: "ring-border",
      value: "text-foreground",
    },
  }
  const c = colorMap[color]

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {label}
          </p>
          <p className={`mt-2 text-3xl font-bold font-mono tabular-nums ${c.value}`}>
            {value}
            {suffix && (
              <span className="ml-1 text-lg font-normal text-muted-foreground/70">
                {suffix}
              </span>
            )}
          </p>
        </div>
        <div className={`relative rounded-lg p-2.5 ring-1 ${c.bg} ${c.ring}`}>
          {pulse && (
            <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500">
              <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-75" />
            </span>
          )}
          <span className={c.icon}>{icon}</span>
        </div>
      </div>
    </div>
  )
}

function ClientCard({ cliente }: { cliente: any }) {
  const hasMeta = !!cliente.config_api?.meta_token
  const hasHotmart = !!(
    cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic
  )
  const hasGA4 = !!cliente.config_api?.ga_property_id
  const activeCount = [hasMeta, hasHotmart, hasGA4].filter(Boolean).length

  return (
    <a href={`/dashboard/${cliente.id}`} className="group block">
      <div className="relative h-full overflow-hidden rounded-xl border border-border bg-card p-5 transition-all duration-300 group-hover:border-brand-blue/40 group-hover:shadow-[0_0_24px_rgba(30,106,181,0.15)]">
        {/* Hover glow */}
        <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
             style={{ background: "radial-gradient(circle at 50% 0%, rgba(30,106,181,0.08) 0%, transparent 70%)" }} />

        <div className="relative space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold text-foreground transition-colors duration-200 group-hover:text-brand-blue dark:group-hover:text-brand-blue-light">
                {cliente.nombre}
              </h3>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                {cliente.id.substring(0, 8)}
              </p>
            </div>
            <div className="ml-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground/70 transition-all duration-200 group-hover:border-brand-blue/30 group-hover:bg-brand-blue/10 group-hover:text-brand-blue dark:group-hover:text-brand-blue-light">
              <BarChart3 className="h-4 w-4" />
            </div>
          </div>

          {/* Integration badges */}
          <div className="flex flex-wrap gap-1.5">
            <IntegrationBadge active={hasMeta} label="Meta" icon="M" />
            <IntegrationBadge active={hasHotmart} label="Hotmart" icon="H" />
            <IntegrationBadge active={hasGA4} label="GA4" icon="G" />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-muted-foreground/70">
              {activeCount} de 3 integraciones
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-brand-blue dark:text-brand-blue-light opacity-0 transition-all duration-300 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0">
              Ver reporte <ArrowRight className="h-3 w-3" />
            </span>
          </div>
        </div>
      </div>
    </a>
  )
}

function IntegrationBadge({
  active,
  label,
  icon,
}: {
  active: boolean
  label: string
  icon: string
}) {
  if (!active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/70">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" />
      {label}
    </span>
  )
}

function EmptyClients() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted">
        <Users className="h-6 w-6 text-muted-foreground/70" />
      </div>
      <p className="font-medium text-foreground/90">Sin clientes activos</p>
      <p className="mt-1.5 max-w-xs text-sm text-muted-foreground/70">
        Ve a{" "}
        <a
          href="/admin/settings"
          className="text-brand-blue dark:text-brand-blue-light underline underline-offset-2 hover:text-brand-blue"
        >
          Ajustes de Sistema
        </a>{" "}
        para agregar tu primer cliente.
      </p>
    </div>
  )
}

function AlertsPanel({ alerts }: { alerts: ActiveAlert[] }) {
  const critical = alerts.filter(a => a.level === 100).length
  const warning = alerts.filter(a => a.level === 90).length

  return (
    <a
      href="/notificaciones?type=alert_threshold"
      className="group flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-3.5 transition-colors hover:bg-accent"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15">
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-foreground">Alertas de presupuesto:</span>
        {critical > 0 && (
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
            {critical} crítica{critical !== 1 ? "s" : ""}
          </span>
        )}
        {warning > 0 && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            {warning} advertencia{warning !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-blue dark:text-brand-blue-light">
        Ver detalle
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </a>
  )
}

function QuickLink({
  href,
  icon,
  title,
  description,
  color,
}: {
  href: string
  icon: React.ReactNode
  title: string
  description: string
  color: "blue" | "zinc" | "amber" | "emerald"
}) {
  const colorMap = {
    blue: { bg: "bg-brand-blue/10", icon: "text-brand-blue dark:text-brand-blue-light", hover: "group-hover:border-brand-blue/40" },
    zinc: { bg: "bg-muted", icon: "text-foreground/90", hover: "group-hover:border-muted-foreground/40" },
    amber: { bg: "bg-amber-500/10", icon: "text-amber-600 dark:text-amber-400", hover: "group-hover:border-amber-500/30" },
    emerald: { bg: "bg-emerald-500/10", icon: "text-emerald-600 dark:text-emerald-400", hover: "group-hover:border-emerald-500/30" },
  }
  const c = colorMap[color]

  return (
    <a href={href} className="group block">
      <div
        className={`flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-all duration-200 ${c.hover} group-hover:shadow-sm`}
      >
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.bg}`}>
          <span className={c.icon}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="truncate text-xs text-muted-foreground/70">{description}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
      </div>
    </a>
  )
}

/* ─── Soporte Panel ──────────────────────────────────────────────────────────── */

function SoportePanel({ tickets }: { tickets: any[] }) {
  const total = tickets.length
  const abiertos = tickets.filter(t => t.estado === "abierto").length
  const enProgreso = tickets.filter(t => t.estado === "en_progreso").length
  const completados = tickets.filter(t => t.estado === "completado").length
  const urgentes = tickets.filter(t => {
    if (t.estado !== "abierto" && t.estado !== "en_progreso") return false
    if (!t.fecha_entrega) return false
    const dl = Math.ceil((new Date(t.fecha_entrega).getTime() - Date.now()) / 86400000)
    return dl <= 2
  }).length

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/15">
            <span className="text-base">🎧</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Soporte Ads House</h2>
            <p className="text-sm text-muted-foreground/70">Requerimientos de todos los clientes</p>
          </div>
        </div>
        <a
          href="/soporte"
          className="flex items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/15 transition-colors"
        >
          Ver todos <ChevronRight className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <SoporteStat label="Total" value={total} color="zinc" />
        <SoporteStat label="Abiertos" value={abiertos} color="blue" />
        <SoporteStat label="En Progreso" value={enProgreso} color="amber" />
        <SoporteStat label="Completados" value={completados} color="emerald" />
        {urgentes > 0 && (
          <SoporteStat label="Vencen Pronto" value={urgentes} color="red" pulse />
        )}
      </div>
    </section>
  )
}

function SoporteStat({
  label,
  value,
  color,
  pulse,
}: {
  label: string
  value: number
  color: "zinc" | "blue" | "amber" | "emerald" | "red"
  pulse?: boolean
}) {
  const colorMap = {
    zinc:    { bg: "bg-muted",        text: "text-foreground", sub: "text-muted-foreground/70",  border: "border-border" },
    blue:    { bg: "bg-blue-500/10",     text: "text-blue-600 dark:text-blue-300", sub: "text-blue-500",  border: "border-blue-500/20" },
    amber:   { bg: "bg-amber-500/10",    text: "text-amber-600 dark:text-amber-300",sub: "text-amber-500", border: "border-amber-500/20" },
    emerald: { bg: "bg-emerald-500/10",  text: "text-emerald-600 dark:text-emerald-300", sub: "text-emerald-500", border: "border-emerald-500/20" },
    red:     { bg: "bg-red-500/10",      text: "text-red-600 dark:text-red-300",  sub: "text-red-500",   border: "border-red-500/20" },
  }
  const c = colorMap[color]
  return (
    <div className={`relative flex flex-col gap-1 rounded-xl border p-4 ${c.bg} ${c.border}`}>
      {pulse && (
        <span className="absolute right-3 top-3 h-2 w-2 rounded-full bg-red-500">
          <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-75" />
        </span>
      )}
      <span className={`text-2xl font-bold font-mono tabular-nums ${c.text}`}>{value}</span>
      <span className={`text-xs font-medium ${c.sub}`}>{label}</span>
    </div>
  )
}
