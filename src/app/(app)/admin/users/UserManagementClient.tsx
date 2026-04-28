'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
    Shield,
    User,
    Trash2,
    UserPlus,
    Mail,
    Calendar,
    Loader2,
    ChevronDown,
    Users,
    Check,
    X,
    Eye,
    EyeOff,
    Lock,
} from 'lucide-react'
import { updateUserRole, deleteUser, getClientAssignments, setClientAssignments, createUser } from './_actions'

type Role = 'superadmin' | 'admin' | 'trafficker' | 'viewer'

interface UserRow {
    id: string
    email: string
    role: Role
    updated_at?: string
    created_at?: string
    full_name?: string
}

interface Client {
    id: string
    nombre: string
}

interface Props {
    initialUsers: UserRow[]
    allClients: Client[]
    currentRole: string
    currentUserId: string
}

const ROLE_LABELS: Record<Role, string> = {
    superadmin: 'Super Admin',
    admin: 'Admin',
    trafficker: 'Trafficker',
    viewer: 'Viewer',
}

const ROLE_COLORS: Record<Role, string> = {
    superadmin: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    admin:      'bg-purple-500/20 text-purple-400 border-purple-500/30',
    trafficker: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    viewer:     'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
}

function getRolesForCurrentUser(currentRole: string): Role[] {
    if (currentRole === 'superadmin') return ['superadmin', 'admin', 'trafficker', 'viewer']
    if (currentRole === 'admin') return ['trafficker', 'viewer']
    return []
}

function canEditUser(currentRole: string, currentUserId: string, targetUser: UserRow): boolean {
    if (currentRole === 'superadmin') return true
    if (currentRole === 'admin') {
        return !['superadmin', 'admin'].includes(targetUser.role) && targetUser.id !== currentUserId
    }
    return false
}

// ─── Create User Modal ────────────────────────────────────────────────────────

interface CreateUserModalProps {
    allClients: Client[]
    currentRole: string
    onClose: () => void
    onCreated: (user: UserRow) => void
}

function CreateUserModal({ allClients, currentRole, onClose, onCreated }: CreateUserModalProps) {
    const availableRoles = getRolesForCurrentUser(currentRole)

    const [fullName, setFullName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [role, setRole] = useState<Role>(availableRoles[availableRoles.length > 1 ? availableRoles.length - 2 : 0])
    const [selectedClients, setSelectedClients] = useState<string[]>([])
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')

    const toggleClient = (id: string) =>
        setSelectedClients(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')

        if (!fullName.trim()) return setError('El nombre es requerido.')
        if (!email.trim()) return setError('El correo es requerido.')
        if (password.length < 6) return setError('La contraseña debe tener al menos 6 caracteres.')

        setSaving(true)
        const res = await createUser({ email: email.trim(), password, fullName: fullName.trim(), role, clientIds: selectedClients })
        setSaving(false)

        if (res.error) {
            setError(res.error)
            return
        }

        if (res.success && res.user) {
            onCreated(res.user as UserRow)
            onClose()
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-800">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/10 rounded-lg">
                            <UserPlus className="h-5 w-5 text-blue-400" />
                        </div>
                        <div>
                            <h3 className="text-white font-semibold text-base">Nuevo Usuario</h3>
                            <p className="text-zinc-500 text-xs">Crea una cuenta y asigna accesos</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors p-1">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
                    {/* Name */}
                    <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Nombre completo</label>
                        <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                            <input
                                type="text"
                                value={fullName}
                                onChange={e => setFullName(e.target.value)}
                                placeholder="Juan Pérez"
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30 transition"
                            />
                        </div>
                    </div>

                    {/* Email */}
                    <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Correo electrónico</label>
                        <div className="relative">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                            <input
                                type="email"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="usuario@adshouse.cloud"
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30 transition"
                            />
                        </div>
                    </div>

                    {/* Password */}
                    <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Contraseña</label>
                        <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="Mínimo 6 caracteres"
                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/30 transition"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(p => !p)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </div>
                    </div>

                    {/* Role */}
                    <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Rol</label>
                        <div className="flex flex-wrap gap-2">
                            {availableRoles.map(r => (
                                <button
                                    key={r}
                                    type="button"
                                    onClick={() => setRole(r)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                                        role === r
                                            ? ROLE_COLORS[r] + ' ring-1 ring-current'
                                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                                    }`}
                                >
                                    {ROLE_LABELS[r]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Client assignments */}
                    {allClients.length > 0 && (
                        <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                                Clientes asignados
                                <span className="text-zinc-600 ml-1 font-normal">
                                    {role !== 'trafficker' ? '(aplica principalmente a traffickers)' : ''}
                                </span>
                            </label>
                            <div className="max-h-36 overflow-y-auto space-y-1.5 pr-0.5">
                                {allClients.map(client => {
                                    const selected = selectedClients.includes(client.id)
                                    return (
                                        <button
                                            key={client.id}
                                            type="button"
                                            onClick={() => toggleClient(client.id)}
                                            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-all ${
                                                selected
                                                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                                                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                                            }`}
                                        >
                                            <span>{client.nombre}</span>
                                            {selected && <Check className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />}
                                        </button>
                                    )
                                })}
                            </div>
                            {selectedClients.length > 0 && (
                                <p className="text-xs text-zinc-500 mt-1.5">
                                    {selectedClients.length} cliente{selectedClients.length > 1 ? 's' : ''} seleccionado{selectedClients.length > 1 ? 's' : ''}
                                </p>
                            )}
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-1">
                        <Button
                            type="button"
                            variant="outline"
                            className="flex-1 bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                            onClick={onClose}
                            disabled={saving}
                        >
                            Cancelar
                        </Button>
                        <Button
                            type="submit"
                            disabled={saving}
                            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-medium gap-2"
                        >
                            {saving ? (
                                <><Loader2 className="h-4 w-4 animate-spin" /> Creando…</>
                            ) : (
                                <><UserPlus className="h-4 w-4" /> Crear Usuario</>
                            )}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function UserManagementClient({ initialUsers, allClients, currentRole, currentUserId }: Props) {
    const [users, setUsers] = useState<UserRow[]>(initialUsers)
    const [loading, setLoading] = useState<string | null>(null)

    const [roleMenuOpen, setRoleMenuOpen] = useState<string | null>(null)

    const [assignPanelUser, setAssignPanelUser] = useState<UserRow | null>(null)
    const [assignedClients, setAssignedClients] = useState<string[]>([])
    const [assignLoading, setAssignLoading] = useState(false)
    const [assignSaving, setAssignSaving] = useState(false)

    const [showCreateModal, setShowCreateModal] = useState(false)

    const availableRoles = getRolesForCurrentUser(currentRole)
    const canCreateUsers = ['superadmin', 'admin'].includes(currentRole)

    const handleRoleChange = async (userId: string, newRole: Role) => {
        setRoleMenuOpen(null)
        if (!confirm(`¿Cambiar el rol de este usuario a "${ROLE_LABELS[newRole]}"?`)) return

        setLoading(userId)
        const res = await updateUserRole(userId, newRole)
        if (res.success) {
            setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
        } else {
            alert(res.error || 'Error al actualizar rol')
        }
        setLoading(null)
    }

    const handleDelete = async (userId: string) => {
        if (!confirm('¿Eliminar este usuario? Esta acción no se puede deshacer.')) return
        setLoading(userId)
        const res = await deleteUser(userId)
        if (res.success) {
            setUsers(prev => prev.filter(u => u.id !== userId))
        } else {
            alert(res.error || 'Error al eliminar usuario')
        }
        setLoading(null)
    }

    const openAssignPanel = async (user: UserRow) => {
        setAssignPanelUser(user)
        setAssignLoading(true)
        const ids = await getClientAssignments(user.id)
        setAssignedClients(ids)
        setAssignLoading(false)
    }

    const toggleClient = (clientId: string) =>
        setAssignedClients(prev =>
            prev.includes(clientId) ? prev.filter(id => id !== clientId) : [...prev, clientId]
        )

    const saveAssignments = async () => {
        if (!assignPanelUser) return
        setAssignSaving(true)
        const res = await setClientAssignments(assignPanelUser.id, assignedClients)
        setAssignSaving(false)
        if (res.success) {
            setAssignPanelUser(null)
        } else {
            alert(res.error || 'Error al guardar asignaciones')
        }
    }

    return (
        <div className="space-y-4">
            {/* Create user modal */}
            {showCreateModal && (
                <CreateUserModal
                    allClients={allClients}
                    currentRole={currentRole}
                    onClose={() => setShowCreateModal(false)}
                    onCreated={(newUser) => setUsers(prev => [newUser, ...prev])}
                />
            )}

            {/* Client assignment panel */}
            {assignPanelUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <Card className="bg-zinc-900 border-zinc-700 w-full max-w-md shadow-2xl">
                        <CardContent className="p-6 space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-white font-semibold text-lg">Asignar Clientes</h3>
                                    <p className="text-zinc-400 text-sm truncate">{assignPanelUser.email}</p>
                                </div>
                                <button onClick={() => setAssignPanelUser(null)} className="text-zinc-500 hover:text-zinc-300 transition-colors">
                                    <X className="h-5 w-5" />
                                </button>
                            </div>

                            {assignLoading ? (
                                <div className="flex justify-center py-8">
                                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                                </div>
                            ) : (
                                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                    {allClients.length === 0 ? (
                                        <p className="text-zinc-500 text-sm text-center py-4">No hay clientes registrados.</p>
                                    ) : allClients.map(client => {
                                        const assigned = assignedClients.includes(client.id)
                                        return (
                                            <button
                                                key={client.id}
                                                onClick={() => toggleClient(client.id)}
                                                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition-all ${
                                                    assigned
                                                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                                                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                                                }`}
                                            >
                                                <span>{client.nombre}</span>
                                                {assigned && <Check className="h-4 w-4 text-blue-400" />}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}

                            <div className="flex gap-3 pt-2">
                                <Button variant="outline" className="flex-1 bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700" onClick={() => setAssignPanelUser(null)}>
                                    Cancelar
                                </Button>
                                <Button className="flex-1 bg-blue-600 hover:bg-blue-500 text-white" onClick={saveAssignments} disabled={assignSaving || assignLoading}>
                                    {assignSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Header row with add button */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-zinc-500">{users.length} usuario{users.length !== 1 ? 's' : ''} registrado{users.length !== 1 ? 's' : ''}</p>
                {canCreateUsers && (
                    <Button
                        onClick={() => setShowCreateModal(true)}
                        className="bg-blue-600 hover:bg-blue-500 text-white gap-2 text-sm"
                    >
                        <UserPlus className="h-4 w-4" />
                        Agregar Usuario
                    </Button>
                )}
            </div>

            {/* Users list */}
            <div className="grid gap-3">
                {users.map((user) => {
                    const canEdit = canEditUser(currentRole, currentUserId, user)
                    const isMe = user.id === currentUserId

                    return (
                        <Card key={user.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition-all duration-200 shadow-lg">
                            <CardContent className="p-5">
                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                    <div className="flex items-center gap-4">
                                        <div className="h-10 w-10 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700 shadow-inner flex-shrink-0">
                                            <User className="h-5 w-5 text-zinc-400" />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                {user.full_name && (
                                                    <span className="text-white font-semibold text-sm">{user.full_name}</span>
                                                )}
                                                <span className={`text-sm ${user.full_name ? 'text-zinc-400' : 'text-white font-medium'}`}>{user.email}</span>
                                                <Badge className={ROLE_COLORS[user.role] || ROLE_COLORS.viewer}>
                                                    {ROLE_LABELS[user.role] || user.role}
                                                </Badge>
                                                {isMe && (
                                                    <Badge className="bg-zinc-700/50 text-zinc-400 border-zinc-600/50 text-[10px]">Tú</Badge>
                                                )}
                                            </div>
                                            <div className="flex gap-3 mt-1">
                                                <p className="text-xs text-zinc-500 flex items-center gap-1">
                                                    <Mail className="h-3 w-3" />
                                                    {user.id.substring(0, 8)}…
                                                </p>
                                                <p className="text-xs text-zinc-500 flex items-center gap-1">
                                                    <Calendar className="h-3 w-3" />
                                                    {new Date(user.updated_at || new Date()).toLocaleDateString()}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 flex-wrap">
                                        {canEdit && user.role === 'trafficker' && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => openAssignPanel(user)}
                                                disabled={loading === user.id}
                                                className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300 gap-1.5"
                                            >
                                                <Users className="h-3.5 w-3.5" />
                                                Clientes
                                            </Button>
                                        )}

                                        {canEdit && availableRoles.length > 0 && (
                                            <div className="relative">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={loading === user.id}
                                                    onClick={() => setRoleMenuOpen(roleMenuOpen === user.id ? null : user.id)}
                                                    className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300 gap-1.5"
                                                >
                                                    {loading === user.id ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : (
                                                        <Shield className="h-3.5 w-3.5" />
                                                    )}
                                                    Rol
                                                    <ChevronDown className="h-3 w-3" />
                                                </Button>

                                                {roleMenuOpen === user.id && (
                                                    <div className="absolute right-0 mt-1 w-40 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-20 overflow-hidden">
                                                        {availableRoles.map(r => (
                                                            <button
                                                                key={r}
                                                                onClick={() => handleRoleChange(user.id, r)}
                                                                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between ${
                                                                    user.role === r
                                                                        ? 'bg-zinc-700 text-white'
                                                                        : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                                                                }`}
                                                            >
                                                                {ROLE_LABELS[r]}
                                                                {user.role === r && <Check className="h-3.5 w-3.5 text-zinc-300" />}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {canEdit && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                disabled={loading === user.id}
                                                onClick={() => handleDelete(user.id)}
                                                className="bg-red-500/5 border-red-500/20 hover:bg-red-500/10 text-red-400 hover:text-red-300"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )
                })}

                {users.length === 0 && (
                    <Card className="bg-zinc-900 border-zinc-800 p-12 text-center">
                        <UserPlus className="h-12 w-12 text-zinc-700 mx-auto mb-4" />
                        <h3 className="text-white font-medium">No hay usuarios</h3>
                        <p className="text-zinc-500 mt-1">Haz clic en "Agregar Usuario" para crear el primero.</p>
                    </Card>
                )}
            </div>
        </div>
    )
}
