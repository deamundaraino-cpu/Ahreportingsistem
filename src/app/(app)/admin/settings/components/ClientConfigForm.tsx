'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { updateClienteConfig, deleteCliente, assignLayoutToCliente, testMetaConnection, testHotmartConnection, testGA4Connection, refreshMetaCustomConversions } from '../_actions'
import { Loader2, ArrowLeft, Save, Trash2, CheckCircle2, AlertCircle, RefreshCw, LayoutDashboard, DownloadCloud } from 'lucide-react'

export function ClientConfigForm({ cliente, layouts = [], isAdmin = false }: { cliente: any; layouts?: any[]; isAdmin?: boolean }) {
    const router = useRouter()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [config, setConfig] = useState(cliente.config_api || {})
    const [testStatus, setTestStatus] = useState<{ [key: string]: { loading: boolean, success?: boolean, error?: string, message?: string } }>({})
    const [layoutSaving, setLayoutSaving] = useState(false)
    const [selectedLayoutId, setSelectedLayoutId] = useState<string>(cliente.layout_id || '')
    async function runTest(key: string, fn: () => Promise<any>) {
        setTestStatus(prev => ({ ...prev, [key]: { loading: true } }))
        try {
            const res = await fn()
            if (res.error) {
                setTestStatus(prev => ({ ...prev, [key]: { loading: false, error: res.error } }))
            } else {
                setTestStatus(prev => ({ 
                    ...prev, 
                    [key]: { 
                        loading: false, 
                        success: true, 
                        message: res.message || undefined 
                    } 
                }))
            }
        } catch (err: any) {
            setTestStatus(prev => ({ ...prev, [key]: { loading: false, error: err.message } }))
        }
    }

    async function handleSave() {
        setLoading(true)
        setError(null)
        const { success, error: updateError } = await updateClienteConfig(cliente.id, config)
        if (!success) {
            setError(updateError || 'Error al guardar la configuración')
        } else {
            router.refresh()
        }
        setLoading(false)
    }

    async function handleDelete() {
        if (confirm('¿Estás seguro de que deseas eliminar este cliente y todos sus datos?')) {
            const { success } = await deleteCliente(cliente.id)
            if (success) {
                router.push('/admin/clientes')
            }
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex gap-4 items-center">
                <Button variant="outline" onClick={() => router.push('/admin/clientes')}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Volver
                </Button>
                <h2 className="text-2xl font-bold">{cliente.nombre}</h2>
            </div>

            {error && <p className="text-red-500 bg-red-500/10 p-4 rounded">{error}</p>}

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Meta Ads Configuration</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runTest('meta', () => testMetaConnection(config.meta_token, config.meta_account_id))}
                            disabled={testStatus.meta?.loading}
                        >
                            {testStatus.meta?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>Conecta el Business SDK ingresando el Access Token y el ID de Cuenta de Anuncios.</CardDescription>
                    {testStatus.meta?.success && <p className="text-green-500 text-xs flex items-center mt-2"><CheckCircle2 className="w-3 h-3 mr-1" /> Conexión Exitosa</p>}
                    {testStatus.metaSync?.success && <p className="text-emerald-400 text-sm flex items-center mt-2 p-2 bg-emerald-500/10 rounded"><CheckCircle2 className="w-4 h-4 mr-2" /> {testStatus.metaSync.message}</p>}
                    {(testStatus.meta?.error || testStatus.metaSync?.error) && <p className="text-red-500 text-xs flex items-center mt-2"><AlertCircle className="w-3 h-3 mr-1" /> {testStatus.meta?.error || testStatus.metaSync?.error}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="meta_token" className="text-zinc-300">Access Token (User o System User)</Label>
                        <Input
                            id="meta_token"
                            type="password"
                            placeholder="EAA..."
                            value={config.meta_token || ''}
                            onChange={(e) => setConfig({ ...config, meta_token: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="meta_account_id" className="text-zinc-300">Ad Account ID</Label>
                        <Input
                            id="meta_account_id"
                            placeholder="act_1234567890"
                            value={config.meta_account_id || ''}
                            onChange={(e) => setConfig({ ...config, meta_account_id: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    {/* Botón de Sincronización de Conversiones Personalizadas */}
                    <div className="pt-4 mt-2 border-t border-zinc-800">
                        <div className="flex justify-between items-center bg-zinc-950/50 p-3 rounded-lg border border-zinc-800">
                            <div>
                                <h4 className="text-sm font-medium text-zinc-200">Conversiones Personalizadas</h4>
                                <p className="text-xs text-zinc-500 mt-1">Busca y actualiza todos los eventos personalizados detectados en Meta durante los últimos 30 días.</p>
                            </div>
                            <Button 
                                variant="secondary" 
                                size="sm" 
                                className="bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 whitespace-nowrap"
                                onClick={() => runTest('metaSync', () => refreshMetaCustomConversions(cliente.id, config))}
                                disabled={testStatus.metaSync?.loading || !config.meta_token || !config.meta_account_id}
                            >
                                {testStatus.metaSync?.loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-2" />}
                                Sincronizar Conversiones
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Hotmart API Settings</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runTest('hotmart', () => testHotmartConnection(config))}
                            disabled={testStatus.hotmart?.loading}
                        >
                            {testStatus.hotmart?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>Proporciona tus credenciales de Hotmart Developers.</CardDescription>
                    {testStatus.hotmart?.success && <p className="text-green-500 text-xs flex items-center mt-2"><CheckCircle2 className="w-3 h-3 mr-1" /> Conexión Exitosa</p>}
                    {testStatus.hotmart?.error && <p className="text-red-500 text-xs flex items-center mt-2"><AlertCircle className="w-3 h-3 mr-1" /> {testStatus.hotmart.error}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_token" className="text-zinc-300">Access Token Temporal (Opcional si usas Basic Auth)</Label>
                        <Input
                            id="hotmart_token"
                            type="password"
                            value={config.hotmart_token || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_token: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_basic" className="text-zinc-300">Basic Auth (Base64 Client ID:Secret)</Label>
                        <Input
                            id="hotmart_basic"
                            type="password"
                            value={config.hotmart_basic || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_basic: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_id" className="text-zinc-300">Client ID</Label>
                        <Input
                            id="hotmart_client_id"
                            value={config.hotmart_client_id || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_id: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_secret" className="text-zinc-300">Client Secret</Label>
                        <Input
                            id="hotmart_client_secret"
                            type="password"
                            value={config.hotmart_client_secret || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_secret: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>

                    <div className="pt-4 border-t border-zinc-800 space-y-4">
                        <h4 className="font-semibold text-lg text-zinc-100">Filtros de Productos</h4>
                        <p className="text-zinc-400 text-sm">Separar nombres de productos por comas si hay múltiples (ej. "Curso Inicial, Libro PDF").</p>
                        <div className="space-y-2">
                            <Label htmlFor="hotmart_principal" className="text-zinc-300">Nombres Producto Principal</Label>
                            <Input
                                id="hotmart_principal"
                                placeholder="Nombre exacto del producto en Hotmart"
                                value={config.hotmart_principal_names || ''}
                                onChange={(e) => setConfig({ ...config, hotmart_principal_names: e.target.value })}
                                className="bg-zinc-950 border-zinc-700"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="hotmart_bump" className="text-zinc-300">Nombres Order Bump</Label>
                            <Input
                                id="hotmart_bump"
                                value={config.hotmart_bump_names || ''}
                                onChange={(e) => setConfig({ ...config, hotmart_bump_names: e.target.value })}
                                className="bg-zinc-950 border-zinc-700"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="hotmart_upsell" className="text-zinc-300">Nombres Upsell</Label>
                            <Input
                                id="hotmart_upsell"
                                value={config.hotmart_upsell_names || ''}
                                onChange={(e) => setConfig({ ...config, hotmart_upsell_names: e.target.value })}
                                className="bg-zinc-950 border-zinc-700"
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Google Analytics (GA4)</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runTest('ga4', () => testGA4Connection(config))}
                            disabled={testStatus.ga4?.loading}
                        >
                            {testStatus.ga4?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>Configura la cuenta de servicio de Google Cloud para extraer sesiones web diarias.</CardDescription>
                    {testStatus.ga4?.success && <p className="text-green-500 text-xs flex items-center mt-2"><CheckCircle2 className="w-3 h-3 mr-1" /> Conexión Exitosa</p>}
                    {testStatus.ga4?.error && <p className="text-red-500 text-xs flex items-center mt-2"><AlertCircle className="w-3 h-3 mr-1" /> {testStatus.ga4.error}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="ga_property_id" className="text-zinc-300">GA4 Property ID</Label>
                        <Input
                            id="ga_property_id"
                            placeholder="12345678"
                            value={config.ga_property_id || ''}
                            onChange={(e) => setConfig({ ...config, ga_property_id: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="ga_client_email" className="text-zinc-300">Client Email (Google Service Account)</Label>
                        <Input
                            id="ga_client_email"
                            placeholder="example@your-project.iam.gserviceaccount.com"
                            value={config.ga_client_email || ''}
                            onChange={(e) => setConfig({ ...config, ga_client_email: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="ga_private_key" className="text-zinc-300">Private Key (Google Service Account)</Label>
                        <textarea
                            id="ga_private_key"
                            rows={4}
                            placeholder="-----BEGIN PRIVATE KEY-----\n..."
                            value={config.ga_private_key || ''}
                            onChange={(e) => setConfig({ ...config, ga_private_key: e.target.value })}
                            className="flex min-h-[80px] w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm ring-offset-zinc-950 placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle>Filtros de Dashboard</CardTitle>
                    <CardDescription>Configura botones de filtrado rápido para el Dashboard (ej. nombres de campañas o proyectos).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="meta_keywords" className="text-zinc-300">Keywords de Campañas (Separadas por comas)</Label>
                        <Input
                            id="meta_keywords"
                            placeholder="Psicología, Pedagogía, Diplomado"
                            value={config.meta_keywords || ''}
                            onChange={(e) => setConfig({ ...config, meta_keywords: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                        <p className="text-xs text-zinc-500">Estos textos aparecerán como botones de filtro rápido en la vista superior del embudo de Meta Ads.</p>
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 border-indigo-500/30">
                <CardHeader>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                            <LayoutDashboard className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div>
                            <CardTitle className="text-white">Plantilla de Reporte</CardTitle>
                            <CardDescription className="text-zinc-400 mt-1">Selecciona la plantilla de métricas que quieres ver en el Dashboard de este cliente.</CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-3">
                        <Label className="text-zinc-300">Layout Activo</Label>
                        <select
                            value={selectedLayoutId}
                            onChange={async (e) => {
                                const newId = e.target.value
                                setSelectedLayoutId(newId)
                                setLayoutSaving(true)
                                await assignLayoutToCliente(cliente.id, newId || null)
                                setLayoutSaving(false)
                            }}
                            className="flex h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-offset-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">— Sin plantilla (Vista clásica) —</option>
                            {layouts.map((l: any) => (
                                <option key={l.id} value={l.id}>{l.nombre}</option>
                            ))}
                        </select>

                        {layoutSaving && (
                            <div className="flex items-center gap-2 text-xs text-indigo-400">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Guardando asignación...
                            </div>
                        )}

                        {selectedLayoutId && (() => {
                            const activeLayout = layouts.find((l: any) => l.id === selectedLayoutId)
                            if (!activeLayout) return null
                            return (
                                <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-4 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                                        <span className="text-sm font-medium text-indigo-300">{activeLayout.nombre}</span>
                                    </div>
                                    {activeLayout.descripcion && (
                                        <p className="text-xs text-zinc-400 ml-6">{activeLayout.descripcion}</p>
                                    )}
                                    <div className="ml-6 flex flex-wrap gap-2 mt-2">
                                        {(activeLayout.tarjetas || []).map((t: any) => (
                                            <span key={t.id} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded-md border border-zinc-700">{t.label}</span>
                                        ))}
                                    </div>
                                </div>
                            )
                        })()}

                        {!selectedLayoutId && (
                            <p className="text-xs text-zinc-500">Sin plantilla activa → el Dashboard usará la vista clásica con columnas basadas en APIs conectadas.</p>
                        )}
                    </div>
                </CardContent>
                <CardFooter className="bg-zinc-950/50 border-t border-zinc-800 flex justify-between pt-6">
                    {isAdmin && (
                        <Button variant="destructive" onClick={handleDelete} className="gap-2">
                            <Trash2 className="w-4 h-4" />
                            Eliminar Cliente
                        </Button>
                    )}
                    {!isAdmin && <div />}
                    <Button onClick={handleSave} disabled={loading} className="gap-2">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Guardar Todo
                    </Button>
                </CardFooter>
            </Card>

        </div>
    )
}
