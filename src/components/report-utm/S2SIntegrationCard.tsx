'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, Power, KeyRound, Server, Download } from 'lucide-react';
import {
  activateS2SIntegrationAction,
  rotateS2STokenAction,
  setS2SIntegrationStatusAction,
} from '@/app/(app)/admin/settings/[id]/_actions-conexiones';
import { CopyField } from './CopyField';
import { FeedbackLine, LastErrorAlert } from './FeedbackLine';
import { IntegrationStatusBadge } from './StatusBadge';
import { ACENTO } from './acento';

/**
 * Versión del plugin empaquetado en `public/report-utm.zip`. Se muestra al
 * lado del botón para poder compararla con la que WordPress lista en Plugins
 * y saber si un sitio quedó atrás. Mantener en sync con RUTM_VERSION de
 * `wordpress-plugin/report-utm/report-utm.php` al regenerar el ZIP.
 */
const PLUGIN_VERSION = '0.3.2';

const ACCENT = ACENTO.badge;
const ICON_BG = ACENTO.iconoFondo;
const ICON_COLOR = ACENTO.iconoColor;

type Integration = {
  id: string;
  cliente_id: string;
  status: 'active' | 'inactive' | 'error';
  last_sync_at: string | null;
  last_error: string | null;
} | null;

export function S2SIntegrationCard({
  clienteId,
  integration,
  slug,
  baseUrl,
}: {
  clienteId: string;
  integration: Integration;
  /** Slug del cliente en report_utm: lo que el plugin manda como cliente_slug. */
  slug: string | null;
  /** Origen de esta instalación, que es la URL base que espera el plugin. */
  baseUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hay tres campos copiables (token, slug y URL base) y un solo tick: la
  // clave dice cuál lo enciende.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copiar = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      /* el portapapeles puede estar bloqueado; el valor se ve igual */
    }
  };

  const onActivate = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await activateS2SIntegrationAction(clienteId);
        if (!r.ok) setError(r.error);
        else if (r.secret) setRevealedToken(r.secret);
      } catch {
        setError('Error inesperado al activar S2S. Revisá los logs del servidor.');
      }
    });
  };

  const onRotate = () => {
    if (!confirm('¿Rotar el S2S token? El anterior dejará de funcionar de inmediato.')) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await rotateS2STokenAction(clienteId);
        if (!r.ok) setError(r.error);
        else if (r.secret) setRevealedToken(r.secret);
      } catch {
        setError('Error inesperado al rotar el token. Revisá los logs del servidor.');
      }
    });
  };

  const onToggle = () => {
    if (!integration) return;
    const next = integration.status === 'active' ? 'inactive' : 'active';
    setError(null);
    startTransition(async () => {
      try {
        const r = await setS2SIntegrationStatusAction(clienteId, next);
        if (!r.ok) setError(r.error);
      } catch {
        setError('Error inesperado al cambiar el estado. Revisá los logs del servidor.');
      }
    });
  };

  if (!integration) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-sm p-6">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
            <Server className={`h-5 w-5 ${ICON_COLOR}`} />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-foreground">Pixel S2S · WordPress / PHP</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Tracking server-to-server: captura leads desde formularios WordPress sin depender del
              navegador. Funciona incluso con ad blockers activos.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={onActivate}
                disabled={pending}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                {pending ? 'Activando…' : 'Activar integración S2S'}
              </button>
              {/* El ZIP también sirve sin token, para instalar solo el pixel. */}
              <a
                href="/report-utm.zip"
                download
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
                           text-foreground/90 border border-border hover:bg-accent transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Descargar plugin (.zip)
              </a>
            </div>
            {error && <FeedbackLine variant="error" message={error} />}
          </div>
        </div>
      </div>
    );
  }

  const isActive = integration.status === 'active';

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
            <Server className={`h-5 w-5 ${ICON_COLOR}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Pixel S2S · WordPress / PHP</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tracking server-to-server — inmune a ad blockers
            </p>
          </div>
        </div>
        <IntegrationStatusBadge status={integration.status} activeCls={ACCENT} />
      </div>

      {integration.last_error && <LastErrorAlert message={integration.last_error} />}

      {revealedToken ? (
        <div className="rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/5 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400 mb-2">
            S2S Token · guardalo ahora
          </p>
          <CopyField
            value={revealedToken}
            onCopy={() => copiar('token', revealedToken)}
            copied={copiedKey === 'token'}
          />
          <p className="mt-2 text-xs text-blue-700 dark:text-blue-400">
            Solo se muestra una vez. Va en el plugin de WordPress, en{' '}
            <strong>Ajustes → Report UTM → opciones avanzadas</strong>.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          El token está guardado y no se muestra. Si lo perdiste, rotalo y pegá el nuevo en el
          plugin de WordPress.
        </p>
      )}

      {/* Todo lo que hay que llevarse a WordPress, en el mismo sitio donde se
          genera el token: el ZIP, el slug y la URL base. El ZIP es estático
          (`public/report-utm.zip`, lo regenera `wordpress-plugin/build.ps1`),
          así que el botón es un enlace y no pasa por el servidor. */}
      <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-foreground">Instalación en WordPress</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Plugin v{PLUGIN_VERSION} · comparalo con la versión que liste WP en Plugins
            </p>
          </div>
          <a
            href="/report-utm.zip"
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       text-white shadow-sm bg-blue-600 hover:bg-blue-700 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Descargar plugin (.zip)
          </a>
        </div>

        {slug ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <CopyField
              label="Slug de cliente"
              value={slug}
              onCopy={() => copiar('slug', slug)}
              copied={copiedKey === 'slug'}
            />
            <CopyField
              label="URL base"
              value={baseUrl}
              onCopy={() => copiar('base', baseUrl)}
              copied={copiedKey === 'base'}
            />
          </div>
        ) : (
          <p className="text-xs text-amber-600">
            Este cliente todavía no tiene slug en Report-UTM: sin él el plugin no puede
            configurarse. Recargá la ficha y, si sigue igual, revisá el espejo de Report-UTM.
          </p>
        )}

        <ol className="list-decimal list-inside space-y-1 text-[11px] text-muted-foreground">
          <li>WP Admin → Plugins → Añadir nuevo → Subir plugin: subí el ZIP y activalo.</li>
          <li>Ajustes → Report UTM: pegá el slug y la URL base, y activá el toggle.</li>
          <li>Opciones avanzadas: pegá el S2S Token (si lo perdiste, rotalo acá abajo).</li>
          <li>Verificá con el botón «Enviar lead de prueba» del propio plugin.</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
        <button
          onClick={onRotate}
          disabled={pending}
          aria-label="Rotar S2S token"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-foreground/90 border border-border hover:bg-accent
                               disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Rotar token
        </button>
        <button
          onClick={onToggle}
          disabled={pending}
          aria-label={isActive ? 'Pausar integración' : 'Reactivar integración'}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                border transition-colors disabled:opacity-50 ${
                                  isActive
                                    ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                                    : 'border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10'
                                }`}
        >
          <Power className="h-3.5 w-3.5" />
          {isActive ? 'Pausar' : 'Reactivar'}
        </button>
      </div>

      {error && <FeedbackLine variant="error" message={error} />}
    </div>
  );
}
