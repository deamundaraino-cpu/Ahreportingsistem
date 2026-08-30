---
name: Technical Precision
theming:
  strategy: class # next-themes toggles `.dark` on <html>
  modes: [light, dark, system]
  default: system
  persistence: localStorage (next-themes)
  toggle: ThemeToggle (sidebar footer, auth pages, public reports)
colors:
  light:
    background: '#F8F8F8' # oklch(0.980 0 0)
    foreground: '#1C1C1C' # oklch(0.130 0 0)
    card: '#FFFFFF' # oklch(1 0 0)
    popover: '#FFFFFF'
    primary: '#1E6AB5' # brand blue
    primary-foreground: '#FFFFFF'
    secondary: 'oklch(0.955 0.012 258)' # light blue tint
    muted: 'oklch(0.950 0 0)'
    muted-foreground: '#6E6E6E' # oklch(0.480 0 0) — WCAG AA
    accent: 'oklch(0.960 0.008 27)' # light red tint
    destructive: '#E53529'
    border: 'oklch(0.880 0 0)'
    input: 'oklch(0.880 0 0)'
    ring: '#1E6AB5'
    sidebar: '#FFFFFF'
    sidebar-border: 'oklch(0.880 0 0)'
    chart-grid: 'oklch(0 0 0 / 7%)'
    ambient-glow-opacity: 0.04
  dark:
    background: '#151515' # oklch(0.115 0 0)
    foreground: '#F5F5F5' # oklch(0.960 0 0)
    card: '#222222' # oklch(0.165 0 0)
    popover: 'oklch(0.175 0 0)'
    primary: 'oklch(0.920 0 0)' # bright near-white
    primary-foreground: 'oklch(0.165 0 0)'
    secondary: 'oklch(0.235 0 0)'
    muted: 'oklch(0.235 0 0)'
    muted-foreground: '#888888' # oklch(0.620 0 0) — WCAG AA
    accent: 'oklch(0.235 0 0)'
    destructive: 'oklch(0.680 0.200 22)'
    border: 'oklch(1 0 0 / 10%)'
    input: 'oklch(1 0 0 / 14%)'
    ring: 'oklch(0.610 0.150 258)' # brand blue light
    sidebar: 'oklch(0.138 0 0)'
    sidebar-border: 'oklch(1 0 0 / 8%)'
    chart-grid: 'oklch(1 0 0 / 5%)'
    ambient-glow-opacity: 0.07
  brand:
    brand-red: '#E53529' # oklch(0.548 0.215 27)
    brand-red-light: 'oklch(0.650 0.195 27)'
    brand-blue: '#1E6AB5' # oklch(0.482 0.138 258)
    brand-blue-light: 'oklch(0.610 0.150 258)'
    brand-emerald: '#10B981' # oklch(0.696 0.150 162)
    brand-violet: '#8B5CF6' # oklch(0.606 0.219 293)
    reporting-gradient: 'brand-red → brand-blue'
    utm-gradient: 'brand-emerald → brand-violet'
  semantic:
    success: '#10b981' # emerald
    error: '#f43f5e' # rose
    warning: '#f59e0b' # amber
    info: '#6366f1' # indigo
typography:
  display-xl:
    fontFamily: Geist
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  data-kpi:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  data-table:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  sidebar-width: 256px
  header-height: 68px
  container-padding: 24px
  grid-gutter: 16px
---

## Brand & Style

The design system is anchored in a **Corporate / Modern** aesthetic with a heavy focus on technical utility and data density. It is engineered for professionals who require high-performance reporting tools, prioritizing legibility and cognitive ease in **both light and dark environments**.

The brand personality is authoritative and precise. By utilizing a **neutral monochromatic base**, the interface recedes to let the data—expressed through vibrant semantic colors and brand-specific gradients—become the focal point. The aesthetic is heavily influenced by the **shadcn/ui** philosophy: clean lines, architectural layering, and a total absence of unnecessary ornamentation.

Two distinct visual identities coexist within the system:

- **Reporting:** Uses a high-energy gradient from Red (`--brand-red`) to Blue (`--brand-blue`), signaling power and comprehensive analysis.
- **Report-UTM:** Employs an Emerald (`--brand-emerald`) to Violet (`--brand-violet`) gradient, representing growth, tracking, and flow.

The UI should evoke a sense of "Mission Control"—a stable, reliable environment where complex data becomes actionable, regardless of the active theme.

## Theming (Light / Dark / System)

The system is **dual-theme with system-preference default**:

- **Strategy:** `next-themes` toggles the `.dark` class on `<html>`. All color tokens are CSS custom properties defined in `src/app/globals.css` — light values in `:root`, dark overrides in `.dark`.
- **Modes:** `light`, `dark`, and `system` (follows `prefers-color-scheme`). Default is **system**.
- **Persistence:** the user's choice is stored in `localStorage` by next-themes; no server round-trip. An inline script applies the theme before paint to avoid flash-of-wrong-theme.
- **Toggle:** the `ThemeToggle` component (Sun / Moon / Monitor segmented control) lives in the sidebar footer of both workspaces, on the auth screens, and on public report pages. Public reports follow the visitor's theme.

### The Golden Rule

**Components never reference raw palette colors** (`bg-zinc-900`, `text-zinc-400`, hex values). They consume **semantic tokens** that resolve per theme:

| Purpose        | Class                    | Light              | Dark               |
| -------------- | ------------------------ | ------------------ | ------------------ |
| Page canvas    | `bg-background`          | `#F8F8F8`          | `#151515`          |
| Cards / blocks | `bg-card`                | `#FFFFFF`          | `#222222`          |
| Sidebar        | `bg-sidebar`             | `#FFFFFF`          | `oklch(0.138 0 0)` |
| Body text      | `text-foreground`        | `#1C1C1C`          | `#F5F5F5`          |
| Secondary text | `text-muted-foreground`  | `#6E6E6E`          | `#888888`          |
| Borders        | `border-border`          | `oklch(0.880 0 0)` | `white @ 10%`      |
| Inputs         | `border-input`           | `oklch(0.880 0 0)` | `white @ 14%`      |
| Hover surfaces | `bg-accent` / `bg-muted` | light tints        | `oklch(0.235 0 0)` |
| Focus ring     | `ring-ring`              | brand blue         | brand blue light   |

Brand colors are exposed as Tailwind utilities (`bg-brand-red`, `text-brand-blue`, `bg-brand-blue/10`) and as gradient classes (`.brand-gradient-reporting`, `.brand-gradient-utm`, `.nav-active-red`, `.nav-active-blue`, `.nav-active-emerald`).

## Colors

The color strategy relies on a monochromatic neutral base to create depth without hue conflict, ensuring that semantic and brand colors retain maximum impact in both themes.

### Surface Tiers

- **Canvas:** `--background` — soft white in light mode, near-black in dark mode. Used for the page and deepest layers.
- **Surface/Card:** `--card` — pure white (light) / dark gray (dark) for elevated containers and dashboard blocks.
- **Borders/Dividers:** `--border` — solid light gray in light mode, low-opacity white in dark mode, providing subtle high-precision separation.

### Semantic & Accents

Accessibility is paramount; semantic colors are calibrated for **AA compliance** against `--card` in each theme:

- **Success (Emerald):** Positive growth and "Lanzado" states.
- **Error (Rose):** Critical alerts and negative performance.
- **Warning (Amber):** Pending items and high-level roles.
- **Info (Indigo):** General metadata and "Planeado" states.

Accent text always ships paired shades: the darker shade for light mode, the brighter for dark mode (e.g. `text-emerald-600 dark:text-emerald-400`).

Gradients are reserved for high-level brand moments: navigation active states, logos, and primary calls to action.

## Typography

Typography is divided into two functional paths: **UI Navigation (Geist)** and **Data Visualization (JetBrains Mono)**.

- **Geist (Sans):** Used for all interface elements, labels, and headings. Loaded via `next/font/google` as `--font-geist-sans`.
- **JetBrains Mono (Tabular):** Essential for all numerical data, loaded via `next/font/google` (exposed as the project mono font / `--font-geist-mono`). The tabular (fixed-width) nature ensures numbers align perfectly in tables and KPI cards, preventing "jumping" when values update.

### Usage Notes

- Use **Bold** weights for heading levels and KPI values.
- **Muted text** (`text-muted-foreground`) for secondary labels and placeholders.
- Always enable **Tabular Figures** for the number font: use `font-mono tabular-nums` (or the `.font-data` utility) on KPI values and numeric table columns.

## Layout & Spacing

The layout is built on a **12-column fluid grid** that defaults to a **4-column block layout** for dashboard reporting.

### Structural Rhythm

- **Sidebar:** A fixed 256px (`w-64`) sidebar handles primary navigation. On mobile, this transitions to a sliding overlay. Footer hosts the role badge, theme toggle, and logout.
- **Header:** A sticky 68px header provides persistent context and global actions.
- **Dashboard Grid:** Dashboard "blocks" (charts, stats, lists) follow a 4-column distribution on desktop, 2-column on tablet, and 1-column on mobile.
- **Safe Areas:** Standard 24px padding around the main content area keeps the UI breathable in both themes.

### Density

The spacing rhythm is tight (4px increments) to support "High-Density" views. Tables should support up to 50 rows per page, requiring compact vertical padding in cells.

## Elevation & Depth

Depth is achieved through **Tonal Layering** and **Subtle Outlines** rather than heavy shadows.

1.  **Canvas Layer:** `--background` (the deepest point).
2.  **Surface Layer:** `--card` with a `--border` outline. Standard for cards and dashboard blocks. In light mode a soft shadow (`shadow-sm`/`shadow-xl` on auth) may supplement the border; in dark mode shadows are suppressed (`dark:shadow-none`).
3.  **Interactive Layer:** Hovered items use `bg-accent`; pronounced separation may use `--input`-level borders.

**Special Effects:**

- **Atmospheric Glows:** Auth screens and the app shell use low-opacity radial glows behind content (`.ambient-glow-red` top-left, `.ambient-glow-blue` bottom-right). Opacity is theme-aware via `--ambient-glow-opacity` (0.04 light / 0.07 dark).
- **Sticky Headers:** Use `bg-background/80 backdrop-blur-md` with a `border-border` bottom edge to maintain context during scroll in both themes.

## Shapes

The shape language is structured and professional, utilizing **Rounded (0.5rem)** corners as the standard for all UI components.

- **Standard (rounded-lg):** Applied to dashboard cards, input fields, and standard buttons.
- **Large (rounded-xl):** Reserved for modals and larger containers to soften the technical edge.
- **Pill:** Strictly used for status badges (e.g., "Active," "Pending," "Superadmin").

**Border Styles:**

- **Solid:** Standard interface borders via `border-border`.
- **Dashed:** Specifically used for "Switcher" actions or empty states (e.g., the link to toggle between Reporting and UTM).

## Components

### Stat Cards (KPIs)

The primary dashboard element. Includes an icon (top-left), a `text-muted-foreground` label, and a large display value using **JetBrains Mono** (`font-mono tabular-nums`). Trend indicators (percentage up/down) must use paired semantic Emerald/Rose shades.

### Buttons

- **Primary:** `bg-primary text-primary-foreground` — brand blue in light mode, bright near-white in dark mode.
- **Secondary:** `bg-card` with a `border-border` outline.
- **Brand:** Applied using the gradient classes (`.brand-gradient-reporting` / `.brand-gradient-utm`, or the single-hue `.nav-active-*` variants for active states and CTAs).

### Tables

Sticky headers are mandatory for data-heavy reporting (`sticky top-0 bg-card`). Row hover states use `hover:bg-accent`. All numerical columns must use the tabular mono font.

### Status Badges

Small, pill-shaped components using the dual-mode tint pattern: low-saturation background (`bg-{hue}-500/10`), hue border (`border-{hue}-500/20`), and paired text — darker shade in light mode, bright shade in dark mode (`text-emerald-700 dark:text-emerald-400`). Utilities `.badge-success`, `.badge-error`, `.badge-warning`, `.badge-info` encode this pattern. In dark mode this reads as "illuminated"; in light mode as a clean tint.

### Input Fields

`bg-background` with `border-input` borders. Focus states use a subtle ring in `--ring` (brand blue, lighter variant in dark mode).

### Charts (Recharts)

Chart chrome adapts to the theme via the `.chart-wrapper` scope in `globals.css`: axis ticks use `--muted-foreground`, grid lines `--chart-grid`, tooltips `--popover`/`--border`, pie sector strokes `--card`. Data-series colors (the saturated 500-series palette) are shared across themes — they read well on both backgrounds. Never hardcode chart chrome colors.

Note that `.chart-wrapper` only wraps the dashboard charts (`MetricCharts.tsx`). The BI widgets (`ChartWidget.tsx`) sit outside that scope and satisfy the same rule the other way: `fill="currentColor"` plus a Tailwind token class. Both are valid; do not "unify" them by adding `.chart-wrapper` to the BI, because the scope also hides `.recharts-legend-wrapper` and forces an 11px tick, which the BI's own legends and axis-width maths depend on.

### Truncation

**Nothing is ever cut without a way to read it back.** A label that is clipped and unrecoverable is a bug, not a style choice — a campaign name is often the only thing that identifies a row.

- Width comes from the actual text in the chart, not a constant. `src/lib/chart-labels.ts` estimates it and caps it at a fraction of the container so an axis can never eat the plot area.
- In SVG (recharts ticks, pie labels) recovery is a `<title>` child of the `<text>` — the native equivalent of `title=`, no library, no portal. See `src/components/charts/ChartTicks.tsx`.
- In HTML use `TextoTruncado` (Radix tooltip, in `components/ui/tooltip.tsx`) for the handful of elements that appear once per card — titles, legends, bar labels. Use plain `title=` in tables and rankings, where a tooltip root per cell would mean hundreds of portals for no gain.
- `truncate` needs `min-w-0` on the flex child to do anything. A title that shares a row with a badge or a control needs `min-w-0 flex-1` on the title and `shrink-0` on the other one, or both get squashed instead of one yielding.
- Emit the tooltip **only when the text was actually cut**. If every row has one, none of them signals anything.
