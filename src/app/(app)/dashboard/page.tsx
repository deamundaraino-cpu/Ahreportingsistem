import { getClientes, getActiveAlerts, type ActiveAlert } from "../admin/settings/_actions"
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
  const [clientes, activeAlerts] = await Promise.all([getClientes(), getActiveAlerts()])

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
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[#1E6AB5]/10 via-transparent to-[#E53529]/8 p-6 sm:p-8">
        {/* Background decorative glow */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[#1E6AB5] opacity-[0.07] blur-[60px]" />
        <div className="pointer-events-none absolute -bottom-12 -left-12 h-40 w-40 rounded-full bg-[#E53529] opacity-[0.06] blur-[60px]" />

        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E6AB5]/15">
                <Activity className="h-4 w-4 text-[#5a9fd4]" />
              </div>
              <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">
                Panel Principal
              </span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
              AdsHouse Reporting
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Centro de control de métricas y embudos de venta para todos tus clientes.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400">
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
            <h2 className="text-lg font-semibold text-zinc-100">
              Directorio de Clientes
            </h2>
            <p className="text-sm text-zinc-500">
              Accede al embudo consolidado de cada cliente.
            </p>
          </div>
          {totalClientes > 0 && (
            <span className="text-xs text-zinc-500">
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
        <h2 className="text-lg font-semibold text-zinc-100">Acceso Rápido</h2>
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
      bg: "bg-[#1E6AB5]/10",
      icon: "text-[#5a9fd4]",
      ring: "ring-[#1E6AB5]/20",
      value: "text-zinc-50",
    },
    amber: {
      bg: "bg-amber-500/10",
      icon: "text-amber-400",
      ring: "ring-amber-500/20",
      value: "text-zinc-50",
    },
    emerald: {
      bg: "bg-emerald-500/10",
      icon: "text-emerald-400",
      ring: "ring-emerald-500/20",
      value: "text-zinc-50",
    },
    red: {
      bg: "bg-red-500/10",
      icon: "text-red-400",
      ring: "ring-red-500/20",
      value: "text-red-400",
    },
    zinc: {
      bg: "bg-zinc-700/40",
      icon: "text-zinc-500",
      ring: "ring-zinc-700/40",
      value: "text-zinc-50",
    },
  }
  const c = colorMap[color]

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-900 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            {label}
          </p>
          <p className={`mt-2 text-3xl font-bold tabular-nums ${c.value}`}>
            {value}
            {suffix && (
              <span className="ml-1 text-lg font-normal text-zinc-500">
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
      <div className="relative h-full overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-900 p-5 transition-all duration-300 group-hover:border-[#1E6AB5]/40 group-hover:shadow-[0_0_24px_rgba(30,106,181,0.15)]">
        {/* Hover glow */}
        <div className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
             style={{ background: "radial-gradient(circle at 50% 0%, rgba(30,106,181,0.08) 0%, transparent 70%)" }} />

        <div className="relative space-y-4">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold text-zinc-100 transition-colors duration-200 group-hover:text-[#5a9fd4]">
                {cliente.nombre}
              </h3>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                {cliente.id.substring(0, 8)}
              </p>
            </div>
            <div className="ml-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.05] bg-zinc-800 text-zinc-500 transition-all duration-200 group-hover:border-[#1E6AB5]/30 group-hover:bg-[#1E6AB5]/10 group-hover:text-[#5a9fd4]">
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
          <div className="flex items-center justify-between border-t border-white/[0.04] pt-3">
            <span className="text-xs text-zinc-600">
              {activeCount} de 3 integraciones
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-[#1E6AB5] opacity-0 transition-all duration-300 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0">
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
      <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.04] bg-zinc-800/50 px-2 py-0.5 text-[10px] font-medium text-zinc-600">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]" />
      {label}
    </span>
  )
}

function EmptyClients() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-zinc-900/50 px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-white/[0.06] bg-zinc-800">
        <Users className="h-6 w-6 text-zinc-500" />
      </div>
      <p className="font-medium text-zinc-300">Sin clientes activos</p>
      <p className="mt-1.5 max-w-xs text-sm text-zinc-500">
        Ve a{" "}
        <a
          href="/admin/settings"
          className="text-[#5a9fd4] underline underline-offset-2 hover:text-[#1E6AB5]"
        >
          Ajustes de Sistema
        </a>{" "}
        para agregar tu primer cliente.
      </p>
    </div>
  )
}

function AlertsPanel({ alerts }: { alerts: ActiveAlert[] }) {
  const critical = alerts.filter(a => a.level === 100)
  const warning = alerts.filter(a => a.level === 90)

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/15">
            <Bell className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Alertas de Presupuesto</h2>
            <p className="text-sm text-zinc-500">
              {alerts.length} {alerts.length === 1 ? "pestaña" : "pestañas"} con alertas activas
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {critical.length > 0 && (
            <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-400">
              {critical.length} crítica{critical.length !== 1 ? "s" : ""}
            </span>
          )}
          {warning.length > 0 && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-400">
              {warning.length} advertencia{warning.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-900">
        {alerts.map((alert, i) => (
          <AlertRow key={alert.tabId} alert={alert} isLast={i === alerts.length - 1} />
        ))}
      </div>
    </section>
  )
}

function AlertRow({ alert, isLast }: { alert: ActiveAlert; isLast: boolean }) {
  const isCritical = alert.level === 100
  const sentDate = new Date(alert.sentAt).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const budgetFormatted = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(alert.presupuestoObjetivo)

  return (
    <a
      href={`/dashboard/${alert.clienteId}`}
      className={`group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-zinc-800/60 ${
        !isLast ? "border-b border-white/[0.04]" : ""
      }`}
    >
      {/* Level badge */}
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          isCritical
            ? "bg-red-500/15 ring-1 ring-red-500/30"
            : "bg-amber-500/15 ring-1 ring-amber-500/30"
        }`}
      >
        <AlertTriangle
          className={`h-4 w-4 ${isCritical ? "text-red-400" : "text-amber-400"}`}
        />
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-zinc-100 group-hover:text-[#5a9fd4] transition-colors">
            {alert.tabNombre}
          </span>
          <span className="text-zinc-500">·</span>
          <span className="text-sm text-zinc-400">{alert.clienteNombre}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-3">
          <span className="text-xs text-zinc-500">{budgetFormatted} presupuesto</span>
          <span className="text-xs text-zinc-600">Alerta enviada {sentDate}</span>
        </div>
      </div>

      {/* Level pill */}
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            isCritical
              ? "bg-red-500/15 text-red-400"
              : "bg-amber-500/15 text-amber-400"
          }`}
        >
          {isCritical ? "100% — Crítico" : "90% — Advertencia"}
        </span>
        <ChevronRight className="h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-400" />
      </div>
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
    blue: { bg: "bg-[#1E6AB5]/10", icon: "text-[#5a9fd4]", hover: "group-hover:border-[#1E6AB5]/40" },
    zinc: { bg: "bg-zinc-700/50", icon: "text-zinc-300", hover: "group-hover:border-zinc-600/60" },
    amber: { bg: "bg-amber-500/10", icon: "text-amber-400", hover: "group-hover:border-amber-500/30" },
    emerald: { bg: "bg-emerald-500/10", icon: "text-emerald-400", hover: "group-hover:border-emerald-500/30" },
  }
  const c = colorMap[color]

  return (
    <a href={href} className="group block">
      <div
        className={`flex items-center gap-3 rounded-xl border border-white/[0.06] bg-zinc-900 p-4 transition-all duration-200 ${c.hover} group-hover:shadow-sm`}
      >
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${c.bg}`}>
          <span className={c.icon}>{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="truncate text-xs text-zinc-500">{description}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-zinc-400" />
      </div>
    </a>
  )
}
