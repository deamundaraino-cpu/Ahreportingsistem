'use client'

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart3 } from 'lucide-react'

export default function SignupPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [fullName, setFullName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    const router = useRouter()
    const supabase = createClient()

    async function handleSignup(e: React.FormEvent) {
        e.preventDefault()
        setLoading(true)
        setError(null)

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    full_name: fullName,
                },
                emailRedirectTo: `${window.location.origin}/auth/callback`,
            },
        })

        if (error) {
            setError(error.message)
            setLoading(false)
            return
        }

        if (data.user) {
            setSuccess(true)
            // If email confirmation is disabled in Supabase, we can redirect immediately
            // But usually it's better to show a message
            setTimeout(() => {
                router.push('/login')
            }, 3000)
        }
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 p-4">
            <div className="flex items-center gap-3 mb-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-xl shadow-indigo-500/20">
                    <BarChart3 className="h-6 w-6 text-white" />
                </div>
                <span className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white via-zinc-200 to-zinc-400">
                    AdsHouse
                </span>
            </div>

            <Card className="w-full max-w-md border-zinc-800 bg-zinc-900/50 backdrop-blur-xl">
                <CardHeader className="space-y-1">
                    <CardTitle className="text-2xl font-bold text-white text-center">Crear Cuenta</CardTitle>
                    <CardDescription className="text-zinc-400 text-center">
                        Regístrate para empezar a gestionar tus métricas.
                    </CardDescription>
                </CardHeader>
                
                {success ? (
                    <CardContent className="space-y-4 py-8">
                        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-lg text-center">
                            <p className="font-medium text-lg mb-2">¡Registro Exitoso!</p>
                            <p className="text-sm">Revisa tu correo para confirmar tu cuenta. Serás redirigido al login en unos segundos...</p>
                        </div>
                    </CardContent>
                ) : (
                    <form onSubmit={handleSignup}>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="fullName" className="text-zinc-300">Nombre Completo</Label>
                                <Input
                                    id="fullName"
                                    placeholder="Juan Pérez"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    className="bg-zinc-950 border-zinc-800 text-white focus:ring-indigo-500"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-zinc-300">Email profesional</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="tu@empresa.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="bg-zinc-950 border-zinc-800 text-white focus:ring-indigo-500"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="password" title="Mínimo 6 caracteres" className="text-zinc-300">Contraseña</Label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="bg-zinc-950 border-zinc-800 text-white focus:ring-indigo-500"
                                    required
                                />
                            </div>
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-3 rounded-lg">
                                    {error}
                                </div>
                            )}
                        </CardContent>
                        <CardFooter className="flex flex-col gap-4">
                            <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-6 transition-all duration-200" disabled={loading}>
                                {loading ? 'Creando cuenta...' : 'Registrarse'}
                            </Button>
                            <p className="text-sm text-zinc-500 text-center">
                                ¿Ya tienes cuenta?{' '}
                                <Link href="/login" className="text-indigo-400 hover:text-indigo-300 font-medium underline-offset-4 hover:underline transition-colors">
                                    Inicia sesión
                                </Link>
                            </p>
                        </CardFooter>
                    </form>
                )}
            </Card>
        </div>
    )
}
