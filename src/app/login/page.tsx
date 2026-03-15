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

export default function LoginPage() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const router = useRouter()
    const supabase = createClient()

    async function handleLogin(e: React.FormEvent) {
        e.preventDefault()
        setLoading(true)
        setError(null)

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        })

        if (error) {
            setError(error.message)
            setLoading(false)
            return
        }

        router.push('/')
        router.refresh()
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
                    <CardTitle className="text-2xl font-bold text-white text-center">Bienvenido</CardTitle>
                    <CardDescription className="text-zinc-400 text-center">
                        Ingresa a tu cuenta para ver tus métricas.
                    </CardDescription>
                </CardHeader>
                <form onSubmit={handleLogin}>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="email" className="text-zinc-300">Email</Label>
                            <Input
                                id="email"
                                type="email"
                                placeholder="tu@email.com"
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
                            {loading ? 'Ingresando...' : 'Iniciar Sesión'}
                        </Button>
                        <p className="text-sm text-zinc-500 text-center">
                            ¿No tienes cuenta?{' '}
                            <Link href="/signup" className="text-indigo-400 hover:text-indigo-300 font-medium underline-offset-4 hover:underline transition-colors">
                                Regístrate gratis
                            </Link>
                        </p>
                    </CardFooter>
                </form>
            </Card>
        </div>
    )
}
