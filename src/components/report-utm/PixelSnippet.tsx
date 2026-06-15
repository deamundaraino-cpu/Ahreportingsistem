'use client'

import { useState } from 'react'
import { Copy, Check, Server, Code2, Link } from 'lucide-react'
import { useCopyHandler } from './CopyField'

/*
 * PixelSnippet renders an always-dark code viewer regardless of the active app theme.
 * Colors use our actual dark design-system values (oklch / hex from DESIGN.md), not Tailwind
 * palette classes, to comply with the Golden Rule.
 *
 *   Dark bg (deeper than --background): oklch(0.085 0 0) → #111
 *   Dark fg  (--foreground dark):        #F5F5F5
 *   Dark muted-fg:                       #888888
 *   Dark hover text:                     #D4D4D4
 *   Border:  white @ 6% opacity  (white/[0.06])
 */

type Props = {
    origin: string
    clienteSlug: string
    s2sToken?: string | null
}

type Tab = 'js' | 'php'

export function PixelSnippet({ origin, clienteSlug, s2sToken }: Props) {
    const [tab, setTab] = useState<Tab>('js')
    const [copiedJs, setCopiedJs] = useState(false)
    const [copiedPhp, setCopiedPhp] = useState(false)

    const copyJsHandler = useCopyHandler(setCopiedJs)
    const copyPhpHandler = useCopyHandler(setCopiedPhp)

    const jsSnippet =
        `<script>window.RUTM_CONFIG={cliente:'${clienteSlug}'};</script>\n` +
        `<script async src="${origin}/report-utm-pixel.js"></script>`

    const phpSnippet = s2sToken ? buildPhpSnippet(clienteSlug, s2sToken, origin) : null

    return (
        <div
            className="rounded-lg border overflow-hidden"
            style={{
                background: 'oklch(0.085 0 0)',
                borderColor: 'oklch(1 0 0 / 0.06)',
            }}
        >
            {/* Tabs */}
            <div
                className="flex items-center"
                style={{ borderBottom: '1px solid oklch(1 0 0 / 0.06)' }}
            >
                <button
                    onClick={() => setTab('js')}
                    style={{ borderRight: '1px solid oklch(1 0 0 / 0.06)' }}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                        tab === 'js'
                            ? 'text-emerald-400 bg-white/[0.04]'
                            : 'text-[#888888] hover:text-[#D4D4D4]'
                    }`}
                >
                    <Code2 className="h-3 w-3" />
                    JavaScript · HTML
                </button>
                <button
                    onClick={() => setTab('php')}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                        tab === 'php'
                            ? 'text-violet-400 bg-white/[0.04]'
                            : 'text-[#888888] hover:text-[#D4D4D4]'
                    }`}
                >
                    <Server className="h-3 w-3" />
                    PHP · WordPress
                    {!s2sToken && (
                        <span className="ml-1.5 text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full uppercase tracking-wider font-semibold">
                            Sin token
                        </span>
                    )}
                </button>
            </div>

            {tab === 'js' && (
                <>
                    <div
                        className="flex items-center justify-between px-4 py-2"
                        style={{ borderBottom: '1px solid oklch(1 0 0 / 0.06)' }}
                    >
                        <span className="text-[10px] font-mono uppercase tracking-wider text-[#888888]">
                            HTML · pegar antes de &lt;/head&gt;
                        </span>
                        <button
                            onClick={() => copyJsHandler(jsSnippet)}
                            aria-label="Copiar snippet JavaScript"
                            className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                            {copiedJs ? (
                                <><Check className="h-3 w-3" /> Copiado</>
                            ) : (
                                <><Copy className="h-3 w-3" /> Copiar</>
                            )}
                        </button>
                    </div>
                    <pre className="p-4 text-xs font-mono text-[#F5F5F5] overflow-x-auto leading-relaxed">
                        {jsSnippet}
                    </pre>
                </>
            )}

            {tab === 'php' && (
                <>
                    {phpSnippet ? (
                        <>
                            <div
                                className="flex items-center justify-between px-4 py-2"
                                style={{ borderBottom: '1px solid oklch(1 0 0 / 0.06)' }}
                            >
                                <span className="text-[10px] font-mono uppercase tracking-wider text-[#888888]">
                                    PHP · Appearance › Theme Editor › functions.php
                                </span>
                                <button
                                    onClick={() => copyPhpHandler(phpSnippet)}
                                    aria-label="Copiar snippet PHP"
                                    className="flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
                                >
                                    {copiedPhp ? (
                                        <><Check className="h-3 w-3" /> Copiado</>
                                    ) : (
                                        <><Copy className="h-3 w-3" /> Copiar todo</>
                                    )}
                                </button>
                            </div>
                            <pre className="p-4 text-xs font-mono text-[#F5F5F5] overflow-x-auto leading-relaxed whitespace-pre">
                                {phpSnippet}
                            </pre>
                        </>
                    ) : (
                        <div className="p-6 flex flex-col items-center gap-3 text-center">
                            <Server className="h-8 w-8 text-[#6E6E6E]" />
                            <div>
                                <p className="text-sm font-medium text-[#D4D4D4]">
                                    Integración S2S no activada
                                </p>
                                <p className="mt-1 text-xs text-[#888888]">
                                    Activá la integración <strong>Pixel S2S</strong> desde la configuración
                                    del cliente para obtener el token PHP.
                                </p>
                            </div>
                            <a
                                href="/report-utm/clientes"
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
                            >
                                <Link className="h-3 w-3" />
                                Ir a configuración del cliente
                            </a>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}

function buildPhpSnippet(slug: string, token: string, origin: string): string {
    return `<?php
// ============================================================
// Report-UTM · Pixel S2S para WordPress
// Pegá en: Apariencia › Editor de temas › functions.php
// o usá el plugin "Code Snippets" para mayor seguridad.
// ============================================================

define('RUTM_SLUG',  '${slug}');
define('RUTM_TOKEN', '${token}');
define('RUTM_S2S',   '${origin}/api/report-utm/pixel/s2s');

function rutm_track_lead(string \\$event_name, array \\$extra = []): void {
    \\$body = json_encode(array_merge([
        'cliente_slug' => RUTM_SLUG,
        'event_type'   => 'lead',
        'event_name'   => \\$event_name,
        'visitor_id'   => \\$_COOKIE['rutm_vid'] ?? null,
        'page_url'     => \\$_SERVER['HTTP_REFERER'] ?? null,
    ], \\$extra));

    wp_remote_post(RUTM_S2S, [
        'body'     => \\$body,
        'headers'  => [
            'Content-Type'         => 'application/json',
            'X-Rutm-S2S-Signature' => hash_hmac('sha256', \\$body, RUTM_TOKEN),
        ],
        'timeout'  => 5,
        'blocking' => false, // no bloquea el render de la página
    ]);
}

// ── Hooks de formularios ─────────────────────────────────────

// Contact Form 7
add_action('wpcf7_mail_sent', function(\\$f) {
    rutm_track_lead('cf7_' . \\$f->title());
});

// Gravity Forms
add_action('gform_after_submission', function(\\$entry, \\$form) {
    rutm_track_lead('gf_' . (\\$form['title'] ?? \\$form['id']),
        ['custom_data' => ['form_id' => \\$form['id']]]);
}, 10, 2);

// WPForms
add_action('wpforms_process_complete', function(\\$fields, \\$entry, \\$form_data) {
    rutm_track_lead('wpf_' . (\\$form_data['settings']['form_title'] ?? \\$form_data['id']));
}, 10, 3);

// Elementor Pro Forms
add_action('elementor_pro/forms/new_record', function(\\$record) {
    rutm_track_lead('elementor_' . \\$record->get_form_settings('form_name'));
}, 10, 1);`
}
