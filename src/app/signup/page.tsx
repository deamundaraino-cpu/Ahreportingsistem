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
                data: { full_name: fullName },
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
            setTimeout(() => router.push('/login'), 3000)
        }
    }

    return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-[#0E0E0E] p-4 relative overflow-hidden">
            {/* Brand ambient glows */}
            <div className="absolute top-[-15%] left-[-10%] w-[45%] h-[45%] rounded-full opacity-[0.08] blur-[130px] pointer-events-none"
                 style={{ background: '#E53529' }} />
            <div className="absolute bottom-[-15%] right-[-10%] w-[45%] h-[45%] rounded-full opacity-[0.08] blur-[130px] pointer-events-none"
                 style={{ background: '#1E6AB5' }} />

            {/* Logo mark */}
            <div className="flex items-center gap-3 mb-8 relative">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl shadow-lg"
                     style={{ background: 'linear-gradient(135deg, #E53529 0%, #1E6AB5 100%)' }}>
                    <BarChart3 className="h-6 w-6 text-white" />
                </div>
                <div className="flex flex-col leading-tight">
                    <span className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                        AdsHouse
                    </span>
                    <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500 tracking-widest uppercase">
                        Reporting
                    </span>
                </div>
            </div>

            <Card className="w-full max-w-md relative
                             bg-white dark:bg-zinc-900/80
                             border border-zinc-200 dark:border-zinc-800
                             shadow-xl dark:shadow-none
                             backdrop-blur-xl">
                <CardHeader className="space-y-1 pb-4">
                    <CardTitle className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 text-center">
                        Crear Cuenta
                    </CardTitle>
                    <CardDescription className="text-zinc-500 dark:text-zinc-400 text-center">
                        Regístrate para empezar a gestionar tus métricas.
                    </CardDescription>
                </CardHeader>

                {success ? (
                    <CardContent className="space-y-4 py-8">
                        <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400 p-4 rounded-lg text-center">
                            <p className="font-semibold text-lg mb-2">¡Registro Exitoso!</p>
                            <p className="text-sm">Revisa tu correo para confirmar tu cuenta. Serás redirigido al login en unos segundos...</p>
                        </div>
                    </CardContent>
                ) : (
                    <form onSubmit={handleSignup}>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="fullName" className="text-zinc-700 dark:text-zinc-300 font-medium">
                                    Nombre Completo
                                </Label>
                                <Input
                                    id="fullName"
                                    placeholder="Juan Pérez"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    className="bg-zinc-50 dark:bg-zinc-950 border-zinc-300 dark:border-zinc-800 text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-zinc-700 dark:text-zinc-300 font-medium">
                                    Email profesional
                                </Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="tu@empresa.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="bg-zinc-50 dark:bg-zinc-950 border-zinc-300 dark:border-zinc-800 text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
                                    required
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="password" className="text-zinc-700 dark:text-zinc-300 font-medium">
                                    Contraseña
                                </Label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="bg-zinc-50 dark:bg-zinc-950 border-zinc-300 dark:border-zinc-800 text-zinc-900 dark:text-white"
                                    required
                                />
                            </div>
                            {error && (
                                <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-sm p-3 rounded-lg">
                                    {error}
                                </div>
                            )}
                        </CardContent>
                        <CardFooter className="flex flex-col gap-4 pt-2">
                            <Button
                                type="submit"
                                className="w-full text-white font-semibold py-6 transition-all duration-200 shadow-md hover:shadow-lg hover:opacity-90 active:scale-[0.98]"
                                style={{ background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)' }}
                                disabled={loading}
                            >
                                {loading ? 'Creando cuenta...' : 'Registrarse'}
                            </Button>
                            <p className="text-sm text-zinc-500 dark:text-zinc-500 text-center">
                                ¿Ya tienes cuenta?{' '}
                                <Link href="/login" className="text-[#1E6AB5] dark:text-[#5a9fd4] hover:underline underline-offset-4 font-medium transition-colors">
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
