'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PlusCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from '@/components/ui/dialog'
import { createCliente } from '../_actions'

export function NewClientDialog() {
    const [open, setOpen] = useState(false)
    const [nombre, setNombre] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const router = useRouter()

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setLoading(true)
        setError(null)

        if (!nombre.trim()) {
            setError('El nombre es requerido.')
            setLoading(false)
            return
        }

        const { success, error: apiError } = await createCliente({ nombre })

        if (!success) {
            setError(apiError || 'Error al crear cliente.')
        } else {
            setOpen(false)
            setNombre('')
            router.refresh()
        }

        setLoading(false)
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button className="gap-2">
                    <PlusCircle className="h-4 w-4" />
                    Agregar Cliente
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-zinc-900 border-zinc-800 text-zinc-50">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Nuevo Cliente</DialogTitle>
                        <DialogDescription className="text-zinc-400">
                            Crea un espacio de trabajo para que este cliente consolide sus métricas.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="nombre" className="text-zinc-200">
                                Nombre del Cliente o Proyecto
                            </Label>
                            <Input
                                id="nombre"
                                value={nombre}
                                onChange={(e) => setNombre(e.target.value)}
                                placeholder="Ej. Curso de Emprendimiento"
                                className="col-span-3 bg-zinc-950 border-zinc-700 focus-visible:ring-zinc-600"
                            />
                        </div>
                        {error && <p className="text-sm text-red-500">{error}</p>}
                    </div>
                    <DialogFooter>
                        <Button type="submit" disabled={loading} className="w-full sm:w-auto">
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Guardar Cliente
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
