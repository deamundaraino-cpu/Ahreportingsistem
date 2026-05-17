import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'AdsHouse Reporting — Métricas que impulsan decisiones',
  description:
    'La plataforma de reportes para agencias que conecta Meta Ads, Google Analytics y Hotmart en un solo lugar.',
}

export default function LandingPage() {
  return (
    <>
      <style>{css}</style>
      <div className="lr">

        {/* Ambient blobs */}
        <div className="blobs" aria-hidden="true">
          <div className="blob blob-1" />
          <div className="blob blob-2" />
          <div className="blob blob-3" />
        </div>

        {/* ── NAV ── */}
        <nav>
          <div className="nav-inner">
            <a href="/" className="nav-logo">
              <div className="nav-logo-mark">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <span className="nav-logo-name">AdsHouse</span>
              <span className="nav-logo-tag">Reporting</span>
            </a>
            <ul className="nav-links">
              <li><a href="#features">Funcionalidades</a></li>
              <li><a href="#how">Cómo funciona</a></li>
              <li><a href="#who">Para quién</a></li>
            </ul>
            <a href="/dashboard" className="nav-cta">
              Acceder al sistema
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>
          </div>
        </nav>

        {/* ── HERO ── */}
        <section className="hero">
          <div className="container">
            <div className="hero-eyebrow">
              <span className="hero-eyebrow-dot" />
              Plataforma de Reportes para Agencias
            </div>
            <h1>
              Todas tus métricas.<br />
              Un solo <span className="accent">dashboard</span>.
            </h1>
            <p>
              Conecta Meta Ads, Google Analytics y Hotmart en tiempo real.
              Reportes claros para tus clientes, decisiones más inteligentes para tu agencia.
            </p>
            <div className="hero-actions">
              <a href="/dashboard" className="btn-primary">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Comenzar ahora
              </a>
              <a href="#how" className="btn-ghost">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Ver cómo funciona
              </a>
            </div>

            {/* Browser mockup */}
            <div className="hero-mockup">
              <div className="hero-mockup-glow" />
              <div className="mockup-browser">
                <div className="mockup-bar">
                  <div className="mockup-dot" />
                  <div className="mockup-dot" />
                  <div className="mockup-dot" />
                  <div className="mockup-url">reportes.adshouse.cloud/dashboard</div>
                </div>
                <div className="mockup-screen">
                  <div className="fake-sidebar">
                    <div className="fake-sidebar-logo">
                      <div className="fake-logo-icon" />
                      <div className="fake-logo-text" />
                    </div>
                    {[true, false, false, false, false, false].map((active, i) => (
                      <div key={i} className={`fake-nav-item${active ? ' active' : ''}`}>
                        <div className="fake-nav-icon" />
                        <div className="fake-nav-label" />
                      </div>
                    ))}
                  </div>
                  <div className="fake-content">
                    <div className="fake-stats-row">
                      <div className="fake-stat">
                        <div className="fake-stat-label" />
                        <div className="fake-stat-val" style={{ background: 'rgba(30,106,181,0.4)' }} />
                      </div>
                      <div className="fake-stat">
                        <div className="fake-stat-label" />
                        <div className="fake-stat-val" style={{ background: 'rgba(52,211,153,0.3)' }} />
                      </div>
                      <div className="fake-stat">
                        <div className="fake-stat-label" />
                        <div className="fake-stat-val" style={{ background: 'rgba(245,158,11,0.3)' }} />
                      </div>
                    </div>
                    <div className="fake-chart">
                      <div className="fake-chart-title" />
                      <div className="fake-bars">
                        {[45, 65, 40, 80, 55, 70, 90, 60, 75, 50, 85, 95].map((h, i) => (
                          <div key={i} className="fake-bar"
                            style={{ height: `${h}%`, background: `rgba(30,106,181,${0.5 + h / 300})` }} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── PLATFORMS ── */}
        <div className="logos-section">
          <div className="container">
            <p className="logos-label">Se conecta con las plataformas que ya usas</p>
            <div className="logos-row">
              {[
                { color: '#1877F2', label: 'Meta Ads' },
                { color: '#F9AB00', label: 'Google Analytics 4' },
                { color: '#e60000', label: 'Hotmart' },
                { color: '#0F9D58', label: 'Google Sheets' },
                { color: '#7c3aed', label: 'API / MCP' },
              ].map(({ color, label }) => (
                <div key={label} className="platform-chip">
                  <div className="platform-icon" style={{ background: color }} />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── FEATURES ── */}
        <section className="features-section" id="features">
          <div className="container">
            <div className="features-header">
              <div className="sec-eyebrow">Funcionalidades</div>
              <h2 className="sec-h2">Todo lo que tu agencia necesita</h2>
              <p className="sec-p center">Desde la captura del dato hasta el reporte compartible, en una sola plataforma.</p>
            </div>
            <div className="features-grid">
              {FEATURES.map((f) => (
                <div key={f.title} className="feat-card">
                  <div className={`feat-icon ${f.color}`}>
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={f.icon} />
                    </svg>
                  </div>
                  <div>
                    <div className="feat-title">{f.title}</div>
                    <div className="feat-desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section className="how-section" id="how">
          <div className="container">
            <div className="how-inner">
              <div>
                <div className="sec-eyebrow">Cómo funciona</div>
                <h2 className="sec-h2">De los datos al insight en minutos</h2>
                <p className="sec-p" style={{ marginBottom: 44 }}>Sin configuraciones complicadas. Conectas, sincronizas y reportas.</p>
                <div className="steps">
                  {STEPS.map((s, i) => (
                    <div key={i} className={`step${i === STEPS.length - 1 ? ' step-last' : ''}`}>
                      <div className="step-num">{i + 1}</div>
                      <div className="step-content">
                        <div className="step-title">{s.title}</div>
                        <div className="step-desc">{s.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="how-visual">
                <div className="how-visual-glow" />
                <div className="how-visual-label">Vista en vivo — Cliente Ejemplo</div>
                {METRICS.map((m) => (
                  <div key={m.label} className="metric-row">
                    <div>
                      <div className="metric-label">{m.label}</div>
                      <div className="source-row">
                        <div className="src-dot" style={{ background: m.color }} />
                        <span className="src-note">{m.source}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="metric-val" style={m.highlight ? { color: 'var(--blue-lt)' } : {}}>{m.value}</div>
                      <div style={{ marginTop: 4 }}>
                        <span className={`metric-badge ${m.up ? 'mb-up' : 'mb-down'}`}>{m.change}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── NUMBERS STRIP ── */}
        <div className="strip-section">
          <div className="container">
            <div className="strip-grid">
              {STRIPS.map((s) => (
                <div key={s.label} className="strip-item">
                  <div className="strip-num" dangerouslySetInnerHTML={{ __html: s.num }} />
                  <div className="strip-label">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── FOR WHO ── */}
        <section className="who-section" id="who">
          <div className="container">
            <div style={{ textAlign: 'center' }}>
              <div className="sec-eyebrow">Para quién es</div>
              <h2 className="sec-h2">Hecho para agencias que escalan</h2>
              <p className="sec-p center">Tanto si gestionas 2 clientes como si gestionas 50, el sistema crece contigo.</p>
            </div>
            <div className="who-grid">
              {WHO.map((w) => (
                <div key={w.title} className="who-card">
                  <div className="who-icon" style={{ background: w.bg }}>
                    <svg fill="none" viewBox="0 0 24 24" stroke={w.stroke} strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={w.icon} />
                    </svg>
                  </div>
                  <div className="who-title">{w.title}</div>
                  <div className="who-desc">{w.desc}</div>
                  <div className="who-tags">
                    {w.tags.map((t) => <span key={t} className="who-tag">{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="cta-section">
          <div className="container">
            <div className="cta-card">
              <div className="cta-glow-1" />
              <div className="cta-glow-2" />
              <h2>Empieza a reportar<br />de forma profesional</h2>
              <p>Conecta tus primeras integraciones y ten tu primer reporte listo en menos de 10 minutos.</p>
              <div className="cta-actions">
                <a href="/dashboard" className="btn-primary" style={{ fontSize: 16, padding: '16px 32px' }}>
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  Acceder al sistema
                </a>
                <a href="mailto:hola@adshouseagencia.com" className="btn-ghost" style={{ fontSize: 15 }}>
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Contactar al equipo
                </a>
              </div>
              <div className="cta-note">Para clientes y socios de AdsHouse Agencia</div>
            </div>
          </div>
        </section>

        {/* ── FOOTER ── */}
        <footer>
          <div className="container">
            <div className="footer-inner">
              <div className="footer-logo">
                <div className="footer-logo-mark">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <span className="footer-logo-name">AdsHouse Reporting</span>
              </div>
              <div className="footer-links">
                <a href="#features">Funcionalidades</a>
                <a href="#how">Cómo funciona</a>
                <a href="/dashboard">Acceder</a>
                <a href="mailto:hola@adshouseagencia.com">Contacto</a>
              </div>
              <div className="footer-copy">© 2026 AdsHouse Agencia. Todos los derechos reservados.</div>
            </div>
          </div>
        </footer>

      </div>
    </>
  )
}

/* ── Static data ─────────────────────────────────────────────────────────── */

const FEATURES = [
  {
    title: 'Dashboard multi-cliente',
    desc: 'Gestiona todos tus clientes desde un panel centralizado. Accede a las métricas de cada cuenta con un clic.',
    color: 'fi-blue',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    title: 'Sincronización en tiempo real',
    desc: 'Los datos de Meta Ads, GA4 y Hotmart se actualizan automáticamente. Siempre trabajas con información fresca.',
    color: 'fi-emerald',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
  {
    title: 'Reportes compartibles',
    desc: 'Genera un link público de solo lectura para cada cliente. Comparte reportes sin dar acceso al sistema.',
    color: 'fi-amber',
    icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  },
  {
    title: 'Atribución UTM',
    desc: 'Rastrea el viaje del cliente desde el clic hasta la venta. Entiende qué campañas generan ingresos reales.',
    color: 'fi-violet',
    icon: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7',
  },
  {
    title: 'Layouts personalizados',
    desc: 'Diseña el embudo de ventas de cada cliente con bloques arrastrables. Adapta la vista a cada negocio.',
    color: 'fi-red',
    icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm0 8a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zm12 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
  },
  {
    title: 'API REST + MCP',
    desc: 'Conecta tus propias herramientas vía API token. Compatible con Claude AI via MCP para consultas en lenguaje natural.',
    color: 'fi-cyan',
    icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  },
]

const STEPS = [
  {
    title: 'Conecta tus plataformas',
    desc: 'Ingresa las credenciales de Meta Ads, Google Analytics y Hotmart en la configuración del cliente. Sin código.',
  },
  {
    title: 'Los datos se sincronizan solos',
    desc: 'El sistema importa y agrega las métricas automáticamente cada día. Siempre tienes datos actualizados.',
  },
  {
    title: 'Analiza y comparte',
    desc: 'Visualiza el embudo completo, genera reportes mensuales y comparte un link de solo lectura con tu cliente.',
  },
  {
    title: 'Toma decisiones basadas en datos',
    desc: 'Con atribución UTM y agrupación de campañas, sabes exactamente qué está generando retorno.',
  },
]

const METRICS = [
  { label: 'Inversión Meta Ads', source: 'Meta Ads · hoy', color: '#1877F2', value: '$4,280', change: '-3.2%', up: false, highlight: false },
  { label: 'Ventas Hotmart',     source: 'Hotmart · hoy',  color: '#ff0000', value: '127',    change: '+18.4%', up: true,  highlight: false },
  { label: 'Sesiones GA4',       source: 'Google Analytics · hoy', color: '#F9AB00', value: '8,941', change: '+9.1%', up: true, highlight: false },
  { label: 'ROAS Consolidado',   source: 'Calculado · todas las fuentes', color: '#5a9fd4', value: '3.8x', change: '+0.4x', up: true, highlight: true },
]

const STRIPS = [
  { num: '<span>3</span>',     label: 'Plataformas integradas' },
  { num: '100<span>%</span>',  label: 'Datos en tiempo real' },
  { num: '<span>∞</span>',     label: 'Clientes por agencia' },
  { num: '1<span> clic</span>',label: 'Para compartir reporte' },
]

const WHO = [
  {
    title: 'Agencias de Performance',
    desc: 'Gestiona múltiples cuentas publicitarias con una vista unificada. Deja de exportar Excel manualmente.',
    bg: 'rgba(30,106,181,0.12)', stroke: '#5a9fd4',
    icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    tags: ['Multi-cuenta', 'Reportes automáticos', 'Embudos'],
  },
  {
    title: 'Traffickers Independientes',
    desc: 'Ofrece reportes profesionales a tus clientes sin construir tu propio sistema. Ahorra semanas de desarrollo.',
    bg: 'rgba(167,139,250,0.12)', stroke: '#a78bfa',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    tags: ['Link compartible', 'Branding agency', 'Sin código'],
  },
  {
    title: 'Infoproductores con equipo',
    desc: 'Conecta Hotmart con tus campañas y entiende de verdad cuál es tu ROAS real por producto y embudo.',
    bg: 'rgba(52,211,153,0.10)', stroke: '#34d399',
    icon: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
    tags: ['ROAS real', 'Hotmart nativo', 'Atribución UTM'],
  },
]

/* ── CSS ─────────────────────────────────────────────────────────────────── */

const css = `
  .lr {
    background: #090909;
    color: #e8e8e8;
    font-family: var(--font-geist-sans), system-ui, sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
    position: relative;
  }
  .lr * { box-sizing: border-box; }
  .lr a { text-decoration: none; color: inherit; }

  /* Blobs */
  .blobs { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
  .blob { position: absolute; border-radius: 50%; filter: blur(120px); animation: drift 18s ease-in-out infinite alternate; }
  .blob-1 { width:700px;height:700px;background:#1E6AB5;opacity:.055;top:-200px;left:-200px;animation-delay:0s; }
  .blob-2 { width:600px;height:600px;background:#E53529;opacity:.04;bottom:-100px;right:-150px;animation-delay:-6s; }
  .blob-3 { width:400px;height:400px;background:#5a9fd4;opacity:.035;top:50%;right:20%;animation-delay:-12s; }
  @keyframes drift { from{transform:translate(0,0) scale(1)} to{transform:translate(40px,30px) scale(1.05)} }

  /* Container */
  .container { max-width:1100px;margin:0 auto;padding:0 24px;position:relative;z-index:1; }

  /* Nav */
  nav { position:fixed;top:0;left:0;right:0;z-index:100;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(9,9,9,0.82);backdrop-filter:blur(20px); }
  .nav-inner { max-width:1100px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between; }
  .nav-logo { display:flex;align-items:center;gap:10px; }
  .nav-logo-mark { width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#1E6AB5 0%,#0f3d6e 100%);display:flex;align-items:center;justify-content:center;flex-shrink:0; }
  .nav-logo-mark svg { width:15px;height:15px;color:#fff; }
  .nav-logo-name { font-size:15px;font-weight:700;letter-spacing:-0.3px;color:#f0f0f0; }
  .nav-logo-tag { font-size:10px;font-weight:500;color:#555;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:2px 8px;border-radius:999px; }
  .nav-links { display:flex;align-items:center;gap:28px;list-style:none; }
  .nav-links a { font-size:13px;color:#999;transition:color 150ms; }
  .nav-links a:hover { color:#f0f0f0; }
  .nav-cta { display:flex;align-items:center;gap:4px;padding:8px 18px;background:#1E6AB5;color:#fff;font-size:13px;font-weight:600;border-radius:999px;transition:background 150ms,box-shadow 150ms; }
  .nav-cta:hover { background:#2478c8;box-shadow:0 0 20px rgba(30,106,181,0.35); }
  .nav-cta svg { width:14px;height:14px; }

  /* Hero */
  .hero { padding:160px 0 100px;text-align:center;position:relative;z-index:1; }
  .hero-eyebrow { display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border:1px solid rgba(30,106,181,0.3);background:rgba(30,106,181,0.08);border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5a9fd4;margin-bottom:28px; }
  .hero-eyebrow-dot { width:5px;height:5px;border-radius:50%;background:#5a9fd4;animation:pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .hero h1 { font-size:clamp(42px,7vw,76px);font-weight:800;line-height:1.05;letter-spacing:-2px;color:#f0f0f0;max-width:820px;margin:0 auto 24px; }
  .accent { background:linear-gradient(135deg,#5a9fd4 0%,#1E6AB5 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text; }
  .hero p { font-size:clamp(16px,2vw,19px);color:#999;max-width:560px;margin:0 auto 44px;line-height:1.7; }
  .hero-actions { display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap; }

  /* Buttons */
  .btn-primary { display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:#1E6AB5;color:#fff;font-size:15px;font-weight:600;border-radius:999px;border:none;cursor:pointer;transition:background 150ms,box-shadow 200ms,transform 120ms; }
  .btn-primary:hover { background:#2478c8;box-shadow:0 4px 32px rgba(30,106,181,0.3);transform:translateY(-1px); }
  .btn-primary svg { width:16px;height:16px; }
  .btn-ghost { display:inline-flex;align-items:center;gap:8px;padding:14px 24px;color:#999;font-size:15px;font-weight:500;border-radius:999px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);cursor:pointer;transition:color 150ms,border-color 150ms,background 150ms; }
  .btn-ghost:hover { color:#f0f0f0;border-color:rgba(255,255,255,0.16);background:rgba(255,255,255,0.06); }
  .btn-ghost svg { width:16px;height:16px; }

  /* Mockup */
  .hero-mockup { margin-top:72px;position:relative; }
  .hero-mockup-glow { position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);width:70%;height:200px;background:#1E6AB5;opacity:.12;filter:blur(80px);border-radius:50%;pointer-events:none; }
  .mockup-browser { background:#111;border:1px solid rgba(255,255,255,0.09);border-radius:16px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.7),0 0 0 1px rgba(255,255,255,0.05);max-width:900px;margin:0 auto; }
  .mockup-bar { height:38px;background:#0d0d0d;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;padding:0 14px;gap:6px; }
  .mockup-dot { width:10px;height:10px;border-radius:50%; }
  .mockup-dot:nth-child(1){background:#ff5f57} .mockup-dot:nth-child(2){background:#febc2e} .mockup-dot:nth-child(3){background:#28c840}
  .mockup-url { flex:1;margin:0 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;height:22px;display:flex;align-items:center;padding:0 10px;font-family:monospace;font-size:10px;color:#555; }
  .mockup-screen { padding:24px;background:#0d0d0d;min-height:340px;display:grid;grid-template-columns:200px 1fr;gap:16px; }
  .fake-sidebar { background:#0a0a0a;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px; }
  .fake-sidebar-logo { display:flex;align-items:center;gap:8px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px; }
  .fake-logo-icon { width:22px;height:22px;border-radius:5px;background:#1E6AB5;opacity:.9; }
  .fake-logo-text { width:70px;height:8px;background:rgba(255,255,255,0.12);border-radius:4px; }
  .fake-nav-item { height:28px;border-radius:6px;display:flex;align-items:center;gap:8px;padding:0 8px; }
  .fake-nav-item.active { background:rgba(30,106,181,0.15); }
  .fake-nav-icon { width:12px;height:12px;border-radius:3px;background:rgba(255,255,255,0.1);flex-shrink:0; }
  .fake-nav-item.active .fake-nav-icon { background:rgba(90,159,212,0.5); }
  .fake-nav-label { height:6px;border-radius:3px;background:rgba(255,255,255,0.07);flex:1; }
  .fake-nav-item.active .fake-nav-label { background:rgba(90,159,212,0.3); }
  .fake-content { display:flex;flex-direction:column;gap:12px; }
  .fake-stats-row { display:grid;grid-template-columns:repeat(3,1fr);gap:10px; }
  .fake-stat { background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px; }
  .fake-stat-label { width:60%;height:5px;background:rgba(255,255,255,0.07);border-radius:3px;margin-bottom:8px; }
  .fake-stat-val { width:40%;height:16px;border-radius:4px; }
  .fake-chart { background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;flex:1; }
  .fake-chart-title { width:30%;height:7px;background:rgba(255,255,255,0.1);border-radius:3px;margin-bottom:16px; }
  .fake-bars { display:flex;align-items:flex-end;gap:6px;height:80px; }
  .fake-bar { flex:1;border-radius:4px 4px 0 0;opacity:.8; }

  /* Logos */
  .logos-section { padding:60px 0;border-top:1px solid rgba(255,255,255,0.08);border-bottom:1px solid rgba(255,255,255,0.08);position:relative;z-index:1; }
  .logos-label { text-align:center;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:32px; }
  .logos-row { display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px; }
  .platform-chip { display:flex;align-items:center;gap:10px;padding:10px 20px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:999px;font-size:13px;font-weight:500;color:#999;transition:border-color 200ms,color 200ms,background 200ms; }
  .platform-chip:hover { border-color:rgba(255,255,255,0.18);color:#f0f0f0;background:rgba(255,255,255,0.06); }
  .platform-icon { width:18px;height:18px;border-radius:4px;flex-shrink:0; }

  /* Sections */
  .sec-eyebrow { display:inline-block;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#5a9fd4;margin-bottom:14px; }
  .sec-h2 { font-size:clamp(28px,4vw,44px);font-weight:800;letter-spacing:-1.5px;color:#f0f0f0;line-height:1.1;margin-bottom:16px; }
  .sec-p { font-size:16px;color:#999;line-height:1.7;max-width:500px; }
  .sec-p.center { text-align:center;max-width:560px;margin:0 auto; }

  /* Features */
  .features-section { padding:100px 0;position:relative;z-index:1; }
  .features-header { text-align:center;margin-bottom:64px; }
  .features-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:2px;background:rgba(255,255,255,0.08);border-radius:20px;overflow:hidden; }
  .feat-card { background:#0d0d0d;padding:32px 28px;display:flex;flex-direction:column;gap:16px;transition:background 200ms; }
  .feat-card:hover { background:#111; }
  .feat-icon { width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
  .feat-icon svg { width:22px;height:22px; }
  .fi-blue    { background:rgba(30,106,181,.15);color:#5a9fd4; }
  .fi-red     { background:rgba(229,53,41,.12);color:#f06b60; }
  .fi-emerald { background:rgba(52,211,153,.12);color:#34d399; }
  .fi-amber   { background:rgba(245,158,11,.12);color:#fbbf24; }
  .fi-violet  { background:rgba(167,139,250,.12);color:#a78bfa; }
  .fi-cyan    { background:rgba(6,182,212,.12);color:#22d3ee; }
  .feat-title { font-size:16px;font-weight:700;color:#f0f0f0; }
  .feat-desc  { font-size:13px;color:#999;line-height:1.65; }

  /* How */
  .how-section { padding:100px 0;position:relative;z-index:1; }
  .how-inner { display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center; }
  .steps { display:flex;flex-direction:column; }
  .step { display:flex;gap:20px;padding:24px 0;border-left:1px solid rgba(255,255,255,0.08);padding-left:28px;margin-left:18px;position:relative; }
  .step-last { border-left-color:transparent; }
  .step-num { position:absolute;left:-18px;top:24px;width:36px;height:36px;border-radius:50%;background:#0d0d0d;border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#5a9fd4;flex-shrink:0;transition:background 200ms,border-color 200ms; }
  .step:hover .step-num { background:rgba(30,106,181,.15);border-color:rgba(30,106,181,.4); }
  .step-title { font-size:16px;font-weight:700;color:#f0f0f0;margin-bottom:6px; }
  .step-desc  { font-size:13px;color:#999;line-height:1.65; }
  .how-visual { background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:32px;position:relative;overflow:hidden; }
  .how-visual-glow { position:absolute;top:-40px;right:-40px;width:200px;height:200px;border-radius:50%;background:#1E6AB5;opacity:.08;filter:blur(60px); }
  .how-visual-label { font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#555;margin-bottom:20px; }
  .metric-row { display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.08); }
  .metric-row:last-child { border-bottom:none; }
  .metric-label { font-size:12px;color:#999; }
  .metric-val   { font-size:20px;font-weight:700;color:#f0f0f0;font-variant-numeric:tabular-nums; }
  .metric-badge { font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px; }
  .mb-up   { background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.2); }
  .mb-down { background:rgba(229,53,41,.10);color:#f06b60;border:1px solid rgba(229,53,41,.2); }
  .source-row { display:flex;align-items:center;gap:6px;margin-top:4px; }
  .src-dot  { width:6px;height:6px;border-radius:50%; }
  .src-note { font-size:10px;color:#555; }

  /* Strip */
  .strip-section { padding:80px 0;position:relative;z-index:1; }
  .strip-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(255,255,255,0.08);border-radius:20px;overflow:hidden; }
  .strip-item { background:#0d0d0d;padding:36px 28px;text-align:center; }
  .strip-num { font-size:44px;font-weight:800;letter-spacing:-2px;color:#f0f0f0;line-height:1; }
  .strip-num span { color:#5a9fd4; }
  .strip-label { font-size:13px;color:#999;margin-top:8px; }

  /* Who */
  .who-section { padding:100px 0;position:relative;z-index:1; }
  .who-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:56px; }
  .who-card { background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:28px;transition:border-color 200ms,background 200ms; }
  .who-card:hover { background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.14); }
  .who-icon { width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:18px; }
  .who-icon svg { width:24px;height:24px; }
  .who-title { font-size:17px;font-weight:700;color:#f0f0f0;margin-bottom:10px; }
  .who-desc  { font-size:13px;color:#999;line-height:1.65; }
  .who-tags  { display:flex;flex-wrap:wrap;gap:6px;margin-top:18px; }
  .who-tag   { font-size:10px;font-weight:500;color:#555;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:3px 8px; }

  /* CTA */
  .cta-section { padding:100px 0 120px;position:relative;z-index:1; }
  .cta-card { background:linear-gradient(135deg,rgba(30,106,181,.12) 0%,rgba(255,255,255,.02) 50%,rgba(229,53,41,.06) 100%);border:1px solid rgba(30,106,181,.25);border-radius:24px;padding:72px 40px;text-align:center;position:relative;overflow:hidden; }
  .cta-glow-1 { position:absolute;top:-60px;left:-60px;width:300px;height:300px;border-radius:50%;background:#1E6AB5;opacity:.08;filter:blur(80px); }
  .cta-glow-2 { position:absolute;bottom:-60px;right:-60px;width:280px;height:280px;border-radius:50%;background:#E53529;opacity:.06;filter:blur(80px); }
  .cta-card h2 { font-size:clamp(28px,4vw,48px);font-weight:800;letter-spacing:-1.5px;color:#f0f0f0;margin-bottom:16px;position:relative; }
  .cta-card p  { font-size:16px;color:#999;max-width:420px;margin:0 auto 36px;line-height:1.7;position:relative; }
  .cta-actions { display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;position:relative; }
  .cta-note    { margin-top:18px;font-size:12px;color:#555;position:relative; }

  /* Footer */
  footer { border-top:1px solid rgba(255,255,255,0.08);padding:40px 0 32px;position:relative;z-index:1; }
  .footer-inner { display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap; }
  .footer-logo  { display:flex;align-items:center;gap:8px; }
  .footer-logo-mark { width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#1E6AB5 0%,#0f3d6e 100%);display:flex;align-items:center;justify-content:center; }
  .footer-logo-mark svg { width:13px;height:13px;color:#fff; }
  .footer-logo-name { font-size:13px;font-weight:700;color:#f0f0f0; }
  .footer-links { display:flex;gap:24px; }
  .footer-links a { font-size:12px;color:#555;transition:color 150ms; }
  .footer-links a:hover { color:#999; }
  .footer-copy { font-size:11px;color:#555; }

  /* Responsive */
  @media(max-width:900px){
    .nav-links{display:none}
    .features-grid{grid-template-columns:1fr 1fr}
    .how-inner{grid-template-columns:1fr}
    .who-grid{grid-template-columns:1fr 1fr}
    .strip-grid{grid-template-columns:1fr 1fr}
    .mockup-screen{grid-template-columns:1fr}
    .fake-sidebar{display:none}
  }
  @media(max-width:600px){
    .features-grid{grid-template-columns:1fr}
    .who-grid{grid-template-columns:1fr}
    .hero{padding:120px 0 60px}
    .cta-card{padding:48px 24px}
    .footer-inner{flex-direction:column;align-items:flex-start;gap:12px}
  }
`
