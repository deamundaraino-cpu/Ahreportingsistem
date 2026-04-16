'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { 
    Shield, 
    User, 
    MoreVertical, 
    Trash2, 
    UserPlus, 
    Mail, 
    Calendar,
    Loader2
} from 'lucide-react'
import { updateUserRole, deleteUser } from './_actions'

export function UserManagementClient({ initialUsers }: { initialUsers: any[] }) {
    const [users, setUsers] = useState(initialUsers)
    const [loading, setLoading] = useState<string | null>(null)

    const handleRoleChange = async (userId: string, currentRole: string) => {
        const roles = ['admin', 'trafficker', 'viewer']
        const nextRole = roles[(roles.indexOf(currentRole) + 1) % roles.length]
        
        if (!confirm(`¿Cambiar el rol de este usuario a ${nextRole}?`)) return

        setLoading(userId)
        const res = await updateUserRole(userId, nextRole)
        
        if (res.success) {
            setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: nextRole } : u))
            // toast.success('Rol actualizado correctamente')
        } else {
            alert(res.error || 'Error al actualizar rol')
        }
        setLoading(null)
    }

    const handleDelete = async (userId: string) => {
        if (!confirm('¿Estás seguro de que quieres eliminar este usuario? Esta acción no se puede deshacer.')) return

        setLoading(userId)
        const res = await deleteUser(userId)
        
        if (res.success) {
            setUsers(prev => prev.filter(u => u.id !== userId))
        } else {
            alert(res.error || 'Error al eliminar usuario')
        }
        setLoading(null)
    }

    const getRoleBadge = (role: string) => {
        switch (role) {
            case 'admin':
                return <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">Admin</Badge>
            case 'trafficker':
                return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">Trafficker</Badge>
            default:
                return <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/30">Viewer</Badge>
        }
    }

    return (
        <div className="space-y-6">
            <div className="grid gap-4">
                {users.map((user) => (
                    <Card key={user.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition-all duration-200 shadow-lg">
                        <CardContent className="p-6">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                                <div className="flex items-center gap-4">
                                    <div className="h-12 w-12 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700 shadow-inner">
                                        <User className="h-6 w-6 text-zinc-400" />
                                    </div>
                                    <div>
                                        <h3 className="text-white font-semibold flex items-center gap-2">
                                            {user.email}
                                            {getRoleBadge(user.role)}
                                        </h3>
                                        <div className="flex flex-col gap-1 mt-1">
                                            <p className="text-xs text-zinc-500 flex items-center gap-1">
                                                <Mail className="h-3 w-3" />
                                                ID: {user.id.substring(0, 8)}...
                                            </p>
                                            <p className="text-xs text-zinc-500 flex items-center gap-1">
                                                <Calendar className="h-3 w-3" />
                                                Registrado el {new Date(user.updated_at || user.created_at || new Date()).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-3">
                                    <Button 
                                        variant="outline" 
                                        size="sm"
                                        disabled={loading === user.id}
                                        onClick={() => handleRoleChange(user.id, user.role)}
                                        className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-300 gap-2"
                                    >
                                        {loading === user.id ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Shield className="h-4 w-4" />
                                        )}
                                        Cambiar Rol
                                    </Button>
                                    <Button 
                                        variant="outline" 
                                        size="sm"
                                        disabled={loading === user.id}
                                        onClick={() => handleDelete(user.id)}
                                        className="bg-red-500/5 border-red-500/20 hover:bg-red-500/10 text-red-400 hover:text-red-300"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}

                {users.length === 0 && (
                    <Card className="bg-zinc-900 border-zinc-800 p-12 text-center">
                        <UserPlus className="h-12 w-12 text-zinc-700 mx-auto mb-4" />
                        <h3 className="text-white font-medium">No hay usuarios</h3>
                        <p className="text-zinc-500 mt-1">Cuando los usuarios se registren aparecerán aquí.</p>
                    </Card>
                )}
            </div>
        </div>
    )
}
