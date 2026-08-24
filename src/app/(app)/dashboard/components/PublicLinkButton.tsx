'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Globe, Copy, Check, ExternalLink, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { getOrCreatePublicToken, savePublicConfig, type PublicBranding } from '../_actions';

interface Tab {
  id: string;
  nombre: string;
  keyword_meta: string;
}

// Paleta de acentos disponible para el link público del cliente.
const ACCENTS = [
  { hex: '#3b82f6', name: 'Azul' },
  { hex: '#10b981', name: 'Esmeralda' },
  { hex: '#8b5cf6', name: 'Violeta' },
  { hex: '#f59e0b', name: 'Ámbar' },
  { hex: '#ef4444', name: 'Rojo' },
  { hex: '#ec4899', name: 'Rosa' },
  { hex: '#14b8a6', name: 'Teal' },
  { hex: '#64748b', name: 'Gris' },
];

export function PublicLinkButton({
  clienteId,
  tabs,
  initialTabIds = [],
  initialBranding = {},
}: {
  clienteId: string;
  tabs: Tab[];
  initialTabIds?: string[];
  initialBranding?: PublicBranding;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedTabIds, setSelectedTabIds] = useState<string[]>(initialTabIds);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Apariencia del link público
  const [logoUrl, setLogoUrl] = useState(initialBranding.logo_url ?? '');
  const [accent, setAccent] = useState(initialBranding.accent ?? '');
  const [title, setTitle] = useState(initialBranding.title ?? '');
  const [welcome, setWelcome] = useState(initialBranding.welcome_text ?? '');

  const handleOpen = async () => {
    setOpen(true);
    if (!token) {
      setLoading(true);
      const res = await getOrCreatePublicToken(clienteId, 'client');
      if (res.token) setToken(res.token);
      setLoading(false);
    }
  };

  const publicUrl = token ? `${window.location.origin}/p/${token}` : '';

  const copyToClipboard = () => {
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleTab = (id: string) => {
    setSelectedTabIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await savePublicConfig(clienteId, {
      tabIds: selectedTabIds,
      branding: {
        logo_url: logoUrl.trim(),
        accent: accent.trim(),
        title: title.trim(),
        welcome_text: welcome.trim(),
      },
    });
    setSaving(false);
    setSaved(true);
  };

  const isConfigured = initialTabIds.length > 0;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleOpen}
        className={`gap-2 ${isConfigured ? 'text-emerald-600 dark:text-emerald-400 border-emerald-500/50 bg-emerald-500/5 hover:bg-emerald-500/10' : 'text-muted-foreground border-border bg-background hover:bg-accent hover:text-foreground'}`}
      >
        <Globe className="w-4 h-4" />
        {isConfigured ? 'Link Público ✦' : 'Link Público'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-background border-border text-foreground sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Link Público</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Elige qué pestañas se mostrarán en el link público. La vista es un espejo del
              dashboard interno.
            </DialogDescription>
          </DialogHeader>

          {/* Link URL */}
          <div className="flex items-center gap-2 pt-2">
            <Input
              readOnly
              value={loading ? 'Generando link...' : publicUrl}
              className="bg-card border-border text-foreground/90 h-9 text-xs"
            />
            <Button
              size="sm"
              onClick={copyToClipboard}
              className="bg-indigo-600 hover:bg-indigo-700 h-9 shrink-0"
              disabled={!token}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          {token && (
            <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1 -mt-1">
              <ExternalLink className="w-3 h-3" />
              Accesible sin iniciar sesión
            </p>
          )}

          {/* Tab selector */}
          <div className="border-t border-border pt-4 mt-2">
            <p className="text-xs text-muted-foreground mb-3 font-medium">
              Pestañas visibles en el link público:
            </p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {tabs.length === 0 ? (
                <p className="text-xs text-muted-foreground/70 italic py-2">
                  No hay pestañas configuradas aún.
                </p>
              ) : (
                tabs.map((tab) => {
                  const isSelected = selectedTabIds.includes(tab.id);
                  return (
                    <button
                      key={tab.id}
                      onClick={() => toggleTab(tab.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                        isSelected
                          ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                          : 'border-border bg-card/50 text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground'
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${
                          isSelected
                            ? 'bg-indigo-600 border-indigo-600'
                            : 'border-muted-foreground/40 bg-transparent'
                        }`}
                      >
                        {isSelected && (
                          <svg
                            className="w-2.5 h-2.5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <span className="text-sm font-medium">{tab.nombre}</span>
                      {tab.keyword_meta && (
                        <span className="ml-auto text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground/70 font-mono shrink-0">
                          {tab.keyword_meta}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
            {tabs.length > 0 && (
              <p className="text-[10px] text-muted-foreground/70 mt-2">
                {selectedTabIds.length === 0
                  ? 'Sin pestañas seleccionadas — el link mostrará todas las pestañas.'
                  : `${selectedTabIds.length} pestaña${selectedTabIds.length > 1 ? 's' : ''} seleccionada${selectedTabIds.length > 1 ? 's' : ''}`}
              </p>
            )}
          </div>

          {/* Apariencia del link público */}
          <div className="border-t border-border pt-4">
            <p className="text-xs text-muted-foreground mb-3 font-medium">
              Apariencia para este cliente:
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                  Logo del cliente (URL)
                </label>
                <Input
                  value={logoUrl}
                  onChange={(e) => {
                    setLogoUrl(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="https://…/logo.png"
                  className="bg-card border-border h-9 text-xs"
                />
              </div>

              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                  Color de acento
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.hex}
                      title={a.name}
                      onClick={() => {
                        setAccent(a.hex);
                        setSaved(false);
                      }}
                      className={`h-7 w-7 rounded-full border-2 transition-all ${
                        accent === a.hex ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: a.hex }}
                    />
                  ))}
                  {accent && (
                    <button
                      onClick={() => {
                        setAccent('');
                        setSaved(false);
                      }}
                      className="h-7 px-2 rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      Quitar
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                  Título del encabezado
                </label>
                <Input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="ej. Reporte de Resultados"
                  className="bg-card border-border h-9 text-xs"
                />
              </div>

              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                  Mensaje de bienvenida
                </label>
                <textarea
                  value={welcome}
                  onChange={(e) => {
                    setWelcome(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="Texto que verá el cliente arriba del reporte…"
                  rows={3}
                  className="w-full px-3 py-2 text-xs rounded-md bg-card border border-border text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              Cerrar
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              {saved ? '¡Guardado! ✓' : 'Guardar selección'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
