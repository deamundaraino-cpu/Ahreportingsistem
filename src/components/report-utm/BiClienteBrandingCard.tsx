'use client';

import { useState, useTransition } from 'react';
import { Palette, Upload, Check, Trash2 } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import { updateClienteBrandingAction } from '@/app/(report-utm)/report-utm/clientes/_actions';

const ACCENT_OPTIONS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#f97316',
  '#ec4899',
];

export function BiClienteBrandingCard({
  clienteId,
  initialLogoUrl,
  initialAccent,
}: {
  clienteId: string;
  initialLogoUrl?: string;
  initialAccent?: string;
}) {
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? '');
  const [accent, setAccent] = useState(initialAccent ?? '');
  const [uploading, setUploading] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('El logo excede el máximo de 2MB.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop() || 'png';
      const filePath = `branding/cliente_${clienteId}_${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('bitacoras-images')
        .upload(filePath, file, { contentType: file.type, upsert: true });
      if (upErr) throw upErr;
      const {
        data: { publicUrl },
      } = supabase.storage.from('bitacoras-images').getPublicUrl(filePath);
      setLogoUrl(publicUrl);
    } catch (err) {
      setError('Error al subir el logo: ' + (err instanceof Error ? err.message : 'desconocido'));
    } finally {
      setUploading(false);
    }
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    startSaving(async () => {
      const r = await updateClienteBrandingAction(clienteId, { logo_url: logoUrl, accent });
      if (!r.ok) setError(r.error ?? 'No se pudo guardar el branding.');
      else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-violet-50 dark:bg-violet-500/10">
          <Palette className="h-5 w-5 text-violet-600 dark:text-violet-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Branding para informes</h3>
          <p className="text-xs text-muted-foreground">
            Logo y color que verá el cliente en los informes compartidos.
          </p>
        </div>
      </div>

      {/* Logo */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
          Logo del cliente
        </label>
        <div className="flex items-center gap-3">
          <div className="h-14 w-24 rounded-lg border border-border bg-muted/40 flex items-center justify-center overflow-hidden">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-[10px] text-muted-foreground">Sin logo</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors cursor-pointer w-fit">
              <Upload className="h-3.5 w-3.5" />
              {uploading ? 'Subiendo…' : 'Subir imagen'}
              <input
                type="file"
                accept="image/*"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
            {logoUrl && (
              <button
                onClick={() => setLogoUrl('')}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-red-500 transition-colors w-fit"
              >
                <Trash2 className="h-3 w-3" /> Quitar
              </button>
            )}
          </div>
        </div>
        <input
          type="text"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="…o pega la URL del logo"
          className="mt-2 w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
      </div>

      {/* Accent */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-muted-foreground mb-2">
          Color de acento
        </label>
        <div className="flex gap-2 flex-wrap items-center">
          <button
            onClick={() => setAccent('')}
            className={`h-6 px-2 rounded-full text-[10px] border transition-all ${accent === '' ? 'border-foreground ring-2 ring-offset-2 ring-offset-card ring-foreground' : 'border-border text-muted-foreground'}`}
          >
            Automático
          </button>
          {ACCENT_OPTIONS.map((c) => (
            <button
              key={c}
              onClick={() => setAccent(c)}
              style={{ background: c }}
              className={`h-6 w-6 rounded-full transition-transform ${accent === c ? 'ring-2 ring-offset-2 ring-offset-card ring-foreground scale-110' : ''}`}
            />
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving || uploading}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-50"
      >
        {saved ? <Check className="h-3.5 w-3.5" /> : null}
        {saving ? 'Guardando…' : saved ? 'Guardado' : 'Guardar branding'}
      </button>
    </div>
  );
}
