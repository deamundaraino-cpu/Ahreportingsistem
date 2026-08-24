'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { AlertCircle, TrendingUp, RefreshCw, CheckCircle2 } from 'lucide-react';

interface ConversionDiaria {
  fecha: string;
  tipo: string;
  fuente: string;
  total_cantidad: number;
  total_valor: number;
}

interface Props {
  dailyData: ConversionDiaria[];
  error: string | null;
  clientId?: string;
  canSync?: boolean;
}

const TIPO_COLORS: Record<string, string> = {
  lead: '#818cf8',
  venta: '#10b981',
  otro: '#f59e0b',
};

function colorForTipo(tipo: string): string {
  return TIPO_COLORS[tipo.toLowerCase()] ?? '#94a3b8';
}

function fmt(n: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function SyncButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncSuccess(false);
    try {
      const res = await fetch('/api/admin/sync-conversiones-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncError(data.error || 'Error al sincronizar');
      } else {
        setSyncSuccess(true);
        router.refresh();
        // Clear success indicator after 4 s
        setTimeout(() => setSyncSuccess(false), 4000);
      }
    } catch (e: any) {
      setSyncError(e.message || 'Error al sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={syncing}
        className="h-7 text-xs gap-1.5"
      >
        <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Sincronizando…' : 'Sincronizar'}
      </Button>
      {syncSuccess && (
        <span className="text-emerald-500 text-xs flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" /> Actualizado
        </span>
      )}
      {syncError && (
        <span className="text-red-500 text-xs flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {syncError}
        </span>
      )}
    </div>
  );
}

export function ConversionesOfflineCard({ dailyData, error, clientId, canSync }: Props) {
  // Corte de la ventana de 30 días. Se fija una sola vez al montar: leer
  // Date.now() en cada render hace que dos renders del mismo componente
  // filtren ventanas distintas.
  const [corte30d] = useState(() => Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (error || !dailyData || dailyData.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-500" />
              Conversiones Offline
            </CardTitle>
            {canSync && clientId && <SyncButton clientId={clientId} />}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {error || 'No hay datos de conversiones offline'}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-2">
            Configura el Sheet de conversiones offline en los ajustes del cliente.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Agregaciones globales ──────────────────────────────────────────────────
  const last30 = dailyData.filter((d) => new Date(d.fecha) >= new Date(corte30d));

  const totalLeads = last30
    .filter((d) => d.tipo === 'lead')
    .reduce((s, d) => s + d.total_cantidad, 0);
  const totalVentas = last30
    .filter((d) => d.tipo === 'venta')
    .reduce((s, d) => s + d.total_cantidad, 0);
  const totalRevenue = last30.reduce((s, d) => s + d.total_valor, 0);
  const closeRate = totalLeads > 0 ? (totalVentas / totalLeads) * 100 : null;

  // ── Datos para el gráfico: agrupar por fecha sumando por tipo ─────────────
  const byFecha = new Map<string, Record<string, number>>();
  for (const row of last30) {
    const entry = byFecha.get(row.fecha) || {};
    entry[row.tipo] = (entry[row.tipo] || 0) + row.total_cantidad;
    byFecha.set(row.fecha, entry);
  }
  const chartData = Array.from(byFecha.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, tipos]) => ({ fecha, ...tipos }));

  const tiposUnicos = [...new Set(last30.map((d) => d.tipo))].sort();

  const statsCards = [
    { label: 'Leads offline (30d)', value: fmt(totalLeads), color: 'text-indigo-500' },
    { label: 'Ventas offline (30d)', value: fmt(totalVentas), color: 'text-emerald-500' },
    ...(totalRevenue > 0
      ? [
          {
            label: 'Revenue offline (30d)',
            value: fmtCurrency(totalRevenue),
            color: 'text-amber-500',
          },
        ]
      : []),
    ...(closeRate !== null
      ? [{ label: 'Close rate', value: `${closeRate.toFixed(1)}%`, color: 'text-violet-500' }]
      : []),
  ];

  return (
    <div className="space-y-4">
      {/* Sync button row */}
      {canSync && clientId && (
        <div className="flex justify-end">
          <SyncButton clientId={clientId} />
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statsCards.map((s) => (
          <Card key={s.label} className="bg-card border-border">
            <CardContent className="pt-6">
              <div className="text-center">
                <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                <p className={`text-2xl font-bold font-mono tabular-nums ${s.color}`}>{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Gráfico apilado por tipo */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            Conversiones offline por día (últimos 30 días)
          </CardTitle>
          <CardDescription>Agrupado por tipo de conversión</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis dataKey="fecha" stroke="#999" tick={{ fontSize: 11 }} />
              <YAxis stroke="#999" tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1f2937',
                  border: '1px solid #404040',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#e5e7eb' }}
              />
              <Legend />
              {tiposUnicos.map((tipo) => (
                <Bar
                  key={tipo}
                  dataKey={tipo}
                  stackId="a"
                  fill={colorForTipo(tipo)}
                  name={tipo.charAt(0).toUpperCase() + tipo.slice(1)}
                  radius={
                    tiposUnicos.indexOf(tipo) === tiposUnicos.length - 1
                      ? [4, 4, 0, 0]
                      : [0, 0, 0, 0]
                  }
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
