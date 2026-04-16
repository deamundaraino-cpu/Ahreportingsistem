'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

interface DailyLead {
  date: string
  leads_totales: number
  leads_calificados: number
  leads_no_calificados: number
  tasa_calificacion: number
}

interface Props {
  dailyData: DailyLead[]
  error: string | null
}

export function GoogleSheetsLeadsCard({ dailyData, error }: Props) {
  if (error || !dailyData || dailyData.length === 0) {
    return (
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-500" />
            Leads desde Google Sheets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-400">{error || 'No hay datos de leads disponibles'}</p>
          <p className="text-xs text-zinc-500 mt-2">
            Asegúrate de haber configurado Google Sheets en los ajustes del cliente.
          </p>
        </CardContent>
      </Card>
    )
  }

  const today = new Date().toISOString().split('T')[0]
  const todayData = dailyData.find(d => d.date === today)
  const last7Days = dailyData.filter(
    d => new Date(d.date) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  )
  const totalLast7 = last7Days.reduce((sum, d) => sum + d.leads_totales, 0)
  const calificadosLast7 = last7Days.reduce((sum, d) => sum + d.leads_calificados, 0)

  const stats = {
    total_hoy: todayData?.leads_totales || 0,
    calificados_hoy: todayData?.leads_calificados || 0,
    tasa_hoy: todayData?.tasa_calificacion || 0,
    total_7dias: totalLast7,
    calificados_7dias: calificadosLast7,
  }

  return (
    <div className="space-y-4">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">Leads hoy</p>
              <p className="text-2xl font-bold text-white">{stats.total_hoy}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1 flex items-center justify-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                Calificados hoy
              </p>
              <p className="text-2xl font-bold text-green-500">{stats.calificados_hoy}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">% Calificación</p>
              <p className="text-2xl font-bold text-indigo-500">{stats.tasa_hoy.toFixed(1)}%</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-zinc-900 border-zinc-800">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">Últimos 7 días</p>
              <p className="text-2xl font-bold text-white">{stats.total_7dias}</p>
              <p className="text-xs text-green-500 mt-1">{stats.calificados_7dias} calificados</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle>Leads por día (últimos 30 días)</CardTitle>
          <CardDescription>Total vs. Calificados</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis dataKey="date" stroke="#999" tick={{ fontSize: 12 }} />
              <YAxis stroke="#999" tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #404040', borderRadius: '8px' }}
                labelStyle={{ color: '#e5e7eb' }}
              />
              <Legend />
              <Bar dataKey="leads_totales" fill="#818cf8" name="Total" radius={[4, 4, 0, 0]} />
              <Bar dataKey="leads_calificados" fill="#10b981" name="Calificados" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle>Tasa de calificación diaria</CardTitle>
          <CardDescription>Porcentaje de leads calificados por día</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#404040" />
              <XAxis dataKey="date" stroke="#999" tick={{ fontSize: 12 }} />
              <YAxis
                stroke="#999"
                tick={{ fontSize: 12 }}
                domain={[0, 100]}
                label={{ value: '(%)', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #404040', borderRadius: '8px' }}
                labelStyle={{ color: '#e5e7eb' }}
                formatter={(value) => [`${(value as number).toFixed(1)}%`, 'Tasa']}
              />
              <Area
                type="monotone"
                dataKey="tasa_calificacion"
                fill="#a78bfa"
                stroke="#8b5cf6"
                name="Tasa de calificación"
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  )
}
