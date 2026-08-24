'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bookmark, Trash2, PenSquare, Save, X, Loader2 } from 'lucide-react';
import { renameTabTemplate, deleteTabTemplate } from '../../dashboard/_actions';
import { toast } from 'sonner';

type TabTemplate = {
  id: string;
  nombre: string;
  descripcion?: string | null;
  tarjetas?: any[] | null;
  graficos?: any[] | null;
  ranking_tables?: any[] | null;
  custom_metrics?: any[] | null;
};

function countBlocks(t: TabTemplate): string {
  const parts: string[] = [];
  if (t.tarjetas?.length) parts.push(`${t.tarjetas.length} tarjetas`);
  if (t.graficos?.length) parts.push(`${t.graficos.length} gráficos`);
  if (t.ranking_tables?.length) parts.push(`${t.ranking_tables.length} rankings`);
  if (t.custom_metrics?.length) parts.push(`${t.custom_metrics.length} métricas`);
  return parts.length ? parts.join(' · ') : 'Sin bloques';
}

export function TabTemplatesManager({
  templates,
  isAdmin,
}: {
  templates: TabTemplate[];
  isAdmin: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNombre, setEditNombre] = useState('');
  const [editDescripcion, setEditDescripcion] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  function startEdit(t: TabTemplate) {
    setEditingId(t.id);
    setEditNombre(t.nombre);
    setEditDescripcion(t.descripcion || '');
  }

  async function handleSave(id: string) {
    if (!editNombre.trim()) {
      toast.error('El nombre es obligatorio');
      return;
    }
    setBusyId(id);
    const res = await renameTabTemplate(id, editNombre, editDescripcion);
    setBusyId(null);
    if (res.error) {
      toast.error('Error: ' + res.error);
      return;
    }
    toast.success('Plantilla actualizada');
    setEditingId(null);
  }

  async function handleDelete(t: TabTemplate) {
    if (
      !confirm(
        `¿Eliminar la plantilla "${t.nombre}"? Las pestañas ya creadas con ella no se ven afectadas.`
      )
    )
      return;
    setBusyId(t.id);
    const res = await deleteTabTemplate(t.id);
    setBusyId(null);
    if (res.error) {
      toast.error('Error: ' + res.error);
      return;
    }
    toast.success('Plantilla eliminada');
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bookmark className="w-5 h-5" />
          Plantillas de Pestañas
        </CardTitle>
        <CardDescription>
          Visualizaciones reutilizables (tarjetas, gráficos, ranking y métricas) que se aplican al
          crear una pestaña nueva en cualquier cliente. Para crear una, abre una pestaña y usa
          &quot;Guardar como plantilla&quot;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {templates.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Aún no hay plantillas de pestañas guardadas.
          </p>
        )}

        {templates.map((t) => (
          <div key={t.id} className="rounded-lg border border-border bg-background p-3">
            {editingId === t.id ? (
              <div className="space-y-2">
                <Input
                  value={editNombre}
                  onChange={(e) => setEditNombre(e.target.value)}
                  placeholder="Nombre de la plantilla"
                  className="bg-card border-border"
                />
                <Input
                  value={editDescripcion}
                  onChange={(e) => setEditDescripcion(e.target.value)}
                  placeholder="Descripción (opcional)"
                  className="bg-card border-border"
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleSave(t.id)}
                    disabled={busyId === t.id}
                    className="text-xs h-8 px-3 bg-blue-600 hover:bg-blue-700 text-white gap-1.5"
                  >
                    {busyId === t.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    Guardar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingId(null)}
                    disabled={busyId === t.id}
                    className="text-xs h-8 px-3 border-border gap-1.5"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{t.nombre}</p>
                  {t.descripcion && (
                    <p className="text-xs text-muted-foreground truncate">{t.descripcion}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">{countBlocks(t)}</p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => startEdit(t)}
                      disabled={busyId === t.id}
                      className="text-xs h-8 px-3 border-border gap-1.5"
                    >
                      <PenSquare className="w-3.5 h-3.5" />
                      Renombrar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(t)}
                      disabled={busyId === t.id}
                      className="text-xs h-8 px-3 border-border text-red-600 dark:text-red-400 hover:bg-red-500/10 gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Eliminar
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
