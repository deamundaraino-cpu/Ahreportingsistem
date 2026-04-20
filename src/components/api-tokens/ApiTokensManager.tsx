'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
    Key, Plus, Trash2, Copy, Check, Eye, EyeOff,
    RefreshCw, AlertTriangle, ExternalLink, Terminal,
    Zap, Shield, BookOpen
} from 'lucide-react'
import { ALL_PERMISSIONS, PERMISSION_LABELS, type TokenPermission } from '@/lib/api-token-auth'

interface ApiToken {
    id: string
    name: string
    token_prefix: string
    permissions: TokenPermission[]
    last_used_at: string | null
    expires_at: string | null
    is_active: boolean
    created_at: string
    token?: string // only present right after creation
}

interface Props {
    baseUrl: string
}

function formatDate(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('es-ES', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
}

function CopyButton({ value }: { value: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }
    return (
        <button onClick={copy} className="p-1.5 rounded hover:bg-white/10 transition-colors" title="Copiar">
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 text-zinc-400" />}
        </button>
    )
}

function NewTokenModal({ onClose, onCreate }: {
    onClose: () => void
    onCreate: (token: ApiToken) => void
}) {
    const [name, setName] = useState('')
    const [permissions, setPermissions] = useState<TokenPermission[]>(['read:metrics', 'read:clients', 'read:campaigns'])
    const [expires, setExpires] = useState<'never' | '30d' | '90d' | '1y'>('never')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const togglePerm = (p: TokenPermission) => {
        setPermissions(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
    }

    const submit = async () => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return }
        if (permissions.length === 0) { setError('Selecciona al menos un permiso'); return }
        setLoading(true)
        setError(null)
        try {
            const expiresAt = expires === 'never' ? null
                : expires === '30d' ? new Date(Date.now() + 30 * 86400000).toISOString()
                    : expires === '90d' ? new Date(Date.now() + 90 * 86400000).toISOString()
                        : new Date(Date.now() + 365 * 86400000).toISOString()

            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), permissions, expires_at: expiresAt }),
            })
            if (!res.ok) {
                const err = await res.json()
                throw new Error(err.error?.message ?? 'Error al crear el token')
            }
            const data: ApiToken = await res.json()
            onCreate(data)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Error desconocido')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md">
                <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
                    <h3 className="font-semibold text-white flex items-center gap-2">
                        <Key className="h-4 w-4 text-[#1E6AB5]" /> Nuevo API Token
                    </h3>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors text-lg leading-none">✕</button>
                </div>

                <div className="p-5 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1.5">Nombre del token</label>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="Ej: Zapier Integration, n8n Workflow..."
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#1E6AB5]/50 focus:border-[#1E6AB5]"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-2">Permisos</label>
                        <div className="space-y-2">
                            {ALL_PERMISSIONS.map(p => (
                                <label key={p} className="flex items-center gap-2.5 cursor-pointer group">
                                    <input
                                        type="checkbox"
                                        checked={permissions.includes(p)}
                                        onChange={() => togglePerm(p)}
                                        className="accent-[#1E6AB5] h-4 w-4 rounded"
                                    />
                                    <span className="text-sm text-zinc-300 group-hover:text-white transition-colors">
                                        {PERMISSION_LABELS[p]}
                                    </span>
                                    <code className="ml-auto text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">{p}</code>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1.5">Expiración</label>
                        <select
                            value={expires}
                            onChange={e => setExpires(e.target.value as typeof expires)}
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#1E6AB5]/50"
                        >
                            <option value="never">Sin expiración</option>
                            <option value="30d">30 días</option>
                            <option value="90d">90 días</option>
                            <option value="1y">1 año</option>
                        </select>
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                            {error}
                        </div>
                    )}
                </div>

                <div className="p-5 border-t border-zinc-800 flex gap-3 justify-end">
                    <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-white">
                        Cancelar
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={loading}
                        style={{ background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)' }}
                        className="text-white border-0 hover:opacity-90"
                    >
                        {loading ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Key className="h-4 w-4 mr-2" />}
                        Generar Token
                    </Button>
                </div>
            </div>
        </div>
    )
}

function CreatedTokenModal({ token, onClose }: { token: string; onClose: () => void }) {
    const [visible, setVisible] = useState(false)
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="bg-zinc-900 border border-emerald-500/30 rounded-xl shadow-2xl w-full max-w-lg">
                <div className="p-5 border-b border-zinc-800 flex items-center gap-2">
                    <Check className="h-5 w-5 text-emerald-400" />
                    <h3 className="font-semibold text-white">Token creado — guárdalo ahora</h3>
                </div>
                <div className="p-5 space-y-4">
                    <div className="flex items-start gap-2 text-amber-400 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>Este token solo se muestra <strong>una vez</strong>. Cópialo ahora y guárdalo en un lugar seguro.</span>
                    </div>
                    <div className="bg-zinc-950 border border-zinc-700 rounded-lg p-3 flex items-center gap-2">
                        <code className="flex-1 text-sm text-emerald-300 font-mono break-all">
                            {visible ? token : '•'.repeat(token.length)}
                        </code>
                        <button onClick={() => setVisible(v => !v)} className="p-1.5 text-zinc-400 hover:text-white">
                            {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                        <CopyButton value={token} />
                    </div>
                </div>
                <div className="p-5 border-t border-zinc-800 flex justify-end">
                    <Button onClick={onClose} style={{ background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)' }} className="text-white border-0">
                        Ya lo guardé
                    </Button>
                </div>
            </div>
        </div>
    )
}

export function ApiTokensManager({ baseUrl }: Props) {
    const [tokens, setTokens] = useState<ApiToken[]>([])
    const [loading, setLoading] = useState(true)
    const [showNew, setShowNew] = useState(false)
    const [newToken, setNewToken] = useState<string | null>(null)
    const [activeTab, setActiveTab] = useState<'tokens' | 'docs' | 'mcp'>('tokens')

    const fetchTokens = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/tokens')
            const data = await res.json()
            setTokens(data.tokens ?? [])
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchTokens() }, [fetchTokens])

    const handleDelete = async (id: string) => {
        if (!confirm('¿Revocar y eliminar este token? Esta acción no se puede deshacer.')) return
        await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
        setTokens(prev => prev.filter(t => t.id !== id))
    }

    const handleToggle = async (id: string, active: boolean) => {
        const res = await fetch(`/api/tokens/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !active }),
        })
        if (res.ok) {
            setTokens(prev => prev.map(t => t.id === id ? { ...t, is_active: !active } : t))
        }
    }

    const handleCreated = (token: ApiToken) => {
        setShowNew(false)
        setTokens(prev => [token, ...prev])
        if (token.token) setNewToken(token.token)
    }

    const appUrl = typeof window !== 'undefined' ? window.location.origin : baseUrl

    return (
        <>
            {showNew && <NewTokenModal onClose={() => setShowNew(false)} onCreate={handleCreated} />}
            {newToken && <CreatedTokenModal token={newToken} onClose={() => setNewToken(null)} />}

            {/* Tabs */}
            <div className="flex gap-1 bg-zinc-900/50 border border-zinc-800 rounded-lg p-1 w-fit">
                {([['tokens', 'Mis Tokens', Key], ['docs', 'REST API', Terminal], ['mcp', 'MCP Server', Zap]] as const).map(([tab, label, Icon]) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === tab
                            ? 'bg-[#1E6AB5] text-white shadow'
                            : 'text-zinc-400 hover:text-white hover:bg-white/5'
                            }`}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {/* Tokens tab */}
            {activeTab === 'tokens' && (
                <div className="space-y-4">
                    <div className="flex justify-end">
                        <Button
                            onClick={() => setShowNew(true)}
                            style={{ background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)' }}
                            className="text-white border-0 hover:opacity-90"
                        >
                            <Plus className="h-4 w-4 mr-2" /> Nuevo Token
                        </Button>
                    </div>

                    {loading ? (
                        <Card className="bg-zinc-900 border-zinc-800">
                            <CardContent className="p-8 flex justify-center">
                                <RefreshCw className="h-6 w-6 animate-spin text-zinc-500" />
                            </CardContent>
                        </Card>
                    ) : tokens.length === 0 ? (
                        <Card className="bg-zinc-900 border-zinc-800">
                            <CardContent className="p-12 flex flex-col items-center gap-3 text-center">
                                <div className="h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center">
                                    <Key className="h-6 w-6 text-zinc-600" />
                                </div>
                                <p className="text-zinc-400 text-sm">No tienes tokens generados aún.</p>
                                <Button
                                    onClick={() => setShowNew(true)}
                                    style={{ background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)' }}
                                    className="text-white border-0 mt-2"
                                >
                                    <Plus className="h-4 w-4 mr-2" /> Crear primer token
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="space-y-3">
                            {tokens.map(t => (
                                <Card key={t.id} className={`bg-zinc-900 border-zinc-800 transition-opacity ${!t.is_active ? 'opacity-50' : ''}`}>
                                    <CardContent className="p-4">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-medium text-white">{t.name}</span>
                                                    <Badge className={`text-xs ${t.is_active ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-zinc-700 text-zinc-400 border-zinc-600'}`}>
                                                        {t.is_active ? 'Activo' : 'Inactivo'}
                                                    </Badge>
                                                    {t.expires_at && new Date(t.expires_at) < new Date() && (
                                                        <Badge className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Expirado</Badge>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <code className="text-xs text-zinc-400 font-mono bg-zinc-800 px-2 py-0.5 rounded">
                                                        {t.token_prefix}••••••••••••••••••••
                                                    </code>
                                                </div>
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {t.permissions.map(p => (
                                                        <span key={p} className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                                                            {p}
                                                        </span>
                                                    ))}
                                                </div>
                                                <div className="flex gap-4 mt-2 text-xs text-zinc-600">
                                                    <span>Creado: {formatDate(t.created_at)}</span>
                                                    <span>Último uso: {formatDate(t.last_used_at)}</span>
                                                    {t.expires_at && <span>Expira: {formatDate(t.expires_at)}</span>}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                <button
                                                    onClick={() => handleToggle(t.id, t.is_active)}
                                                    title={t.is_active ? 'Desactivar' : 'Activar'}
                                                    className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                                                >
                                                    <Shield className="h-4 w-4" />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(t.id)}
                                                    title="Eliminar token"
                                                    className="p-2 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* REST API Docs tab */}
            {activeTab === 'docs' && (
                <div className="space-y-4">
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader>
                            <CardTitle className="text-white text-base flex items-center gap-2">
                                <Shield className="h-4 w-4 text-[#1E6AB5]" /> Autenticación
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm text-zinc-300">
                            <p>Incluye tu token en el header <code className="bg-zinc-800 px-1 rounded text-xs">Authorization</code> de cada solicitud:</p>
                            <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-emerald-300 overflow-x-auto">
                                {`Authorization: Bearer ads_xxxxxxxxxxxxxxxxxxxxxxxxxxxx`}
                            </pre>
                        </CardContent>
                    </Card>

                    {[
                        {
                            method: 'GET', path: '/api/v1/clients', scope: 'read:clients',
                            desc: 'Lista todos tus clientes.',
                            example: `curl -H "Authorization: Bearer <token>" \\
  ${appUrl}/api/v1/clients`,
                        },
                        {
                            method: 'GET', path: '/api/v1/metrics', scope: 'read:metrics',
                            desc: 'Métricas diarias de un cliente.',
                            example: `curl -H "Authorization: Bearer <token>" \\
  "${appUrl}/api/v1/metrics?client_id=UUID&from=2024-01-01&to=2024-01-31"`,
                        },
                        {
                            method: 'GET', path: '/api/v1/campaigns', scope: 'read:campaigns',
                            desc: 'Grupos de campañas y sus mapeos.',
                            example: `curl -H "Authorization: Bearer <token>" \\
  "${appUrl}/api/v1/campaigns?client_id=UUID"`,
                        },
                    ].map(ep => (
                        <Card key={ep.path} className="bg-zinc-900 border-zinc-800">
                            <CardContent className="p-4 space-y-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">{ep.method}</span>
                                    <code className="text-sm text-white font-mono">{ep.path}</code>
                                    <span className="ml-auto text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">{ep.scope}</span>
                                </div>
                                <p className="text-sm text-zinc-400">{ep.desc}</p>
                                <div className="relative">
                                    <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap">{ep.example}</pre>
                                    <div className="absolute top-2 right-2"><CopyButton value={ep.example} /></div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* MCP Server tab */}
            {activeTab === 'mcp' && (
                <div className="space-y-4">
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader>
                            <CardTitle className="text-white text-base flex items-center gap-2">
                                <Zap className="h-4 w-4 text-[#1E6AB5]" /> MCP Server — Integración con IA
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm text-zinc-300">
                            <p>
                                El servidor MCP permite que asistentes de IA como <strong>Claude</strong>, <strong>Cursor</strong> o <strong>Windsurf</strong> consulten
                                tus datos directamente usando lenguaje natural.
                            </p>
                            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
                                <div className="flex items-center justify-between">
                                    <span className="text-zinc-400 text-xs">Endpoint MCP</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <code className="text-emerald-300 text-sm font-mono flex-1">{appUrl}/api/mcp</code>
                                    <CopyButton value={`${appUrl}/api/mcp`} />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader>
                            <CardTitle className="text-white text-base flex items-center gap-2">
                                <BookOpen className="h-4 w-4 text-zinc-400" /> Configurar en Claude Desktop
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <p className="text-zinc-400">Agrega esto a tu archivo <code className="bg-zinc-800 px-1 rounded text-xs">claude_desktop_config.json</code>:</p>
                            <div className="relative">
                                <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto">{`{
  "mcpServers": {
    "adshouse": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {
        "MCP_SERVER_URL": "${appUrl}/api/mcp",
        "MCP_AUTH_HEADER": "Authorization: Bearer ads_TU_TOKEN_AQUI"
      }
    }
  }
}`}</pre>
                                <div className="absolute top-2 right-2">
                                    <CopyButton value={`{\n  "mcpServers": {\n    "adshouse": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-fetch"],\n      "env": {\n        "MCP_SERVER_URL": "${appUrl}/api/mcp",\n        "MCP_AUTH_HEADER": "Authorization: Bearer ads_TU_TOKEN_AQUI"\n      }\n    }\n  }\n}`} />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader>
                            <CardTitle className="text-white text-base flex items-center gap-2">
                                <Terminal className="h-4 w-4 text-zinc-400" /> Herramientas disponibles
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {[
                                { name: 'list_clients', scope: 'read:clients', desc: 'Lista todos los clientes de la cuenta.' },
                                { name: 'get_metrics', scope: 'read:metrics', desc: 'Métricas diarias por cliente y rango de fechas.' },
                                { name: 'get_campaign_groups', scope: 'read:campaigns', desc: 'Grupos de campañas y sus mapeos.' },
                                { name: 'get_summary', scope: 'read:metrics', desc: 'Resumen agregado: ROAS, CPC, CTR, ingresos totales.' },
                            ].map(tool => (
                                <div key={tool.name} className="flex items-start gap-3 p-3 rounded-lg bg-zinc-950/50 border border-zinc-800">
                                    <code className="text-emerald-300 text-xs font-mono mt-0.5 min-w-[160px]">{tool.name}</code>
                                    <div className="flex-1">
                                        <p className="text-sm text-zinc-300">{tool.desc}</p>
                                        <span className="text-[10px] text-zinc-500 mt-0.5 block">{tool.scope}</span>
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </Card>

                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader>
                            <CardTitle className="text-white text-base flex items-center gap-2">
                                <Terminal className="h-4 w-4 text-zinc-400" /> Test rápido con curl
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <p className="text-zinc-400">Prueba el servidor MCP directamente desde la terminal:</p>
                            <div className="relative">
                                <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap">{`curl -X POST ${appUrl}/api/mcp \\
  -H "Authorization: Bearer ads_TU_TOKEN_AQUI" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}</pre>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </>
    )
}
