import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { getClientes } from "./_actions"
import { NewClientDialog } from "./components/NewClientDialog"
import { ExternalLink, Settings, AtSign } from "lucide-react"
import { createClient } from "@/utils/supabase/server"

export default async function AdminClientesPage() {
    const clientes = await getClientes()
    
    // Fetch user profile to check role
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user?.id).single()
    const isAdmin = profile?.role === 'admin'

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-white">Ajustes de Sistema Unificado</h2>
                    <p className="text-zinc-400">Configura accesos y credenciales de API para cada cliente.</p>
                </div>
                {isAdmin && <NewClientDialog />}
            </div>

            {!clientes || clientes.length === 0 ? (
                <Card className="bg-zinc-900 border-zinc-800 flex flex-col items-center justify-center p-12 text-center">
                    <div className="bg-zinc-800 p-4 rounded-full mb-4">
                        <AtSign className="h-8 w-8 text-zinc-500" />
                    </div>
                    <CardTitle className="text-xl">Sin clientes registrados</CardTitle>
                    <p className="text-zinc-400 mt-2 max-w-sm mb-6">
                        Aún no has creado configuraciones para tus clientes. Empieza creando tu primer cliente para conectarlo a Meta o Hotmart.
                    </p>
                    {isAdmin && <NewClientDialog />}
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {clientes.map((cliente: any) => (
                        <a key={cliente.id} href={`/admin/settings/${cliente.id}`} className="block group">
                            <Card className="bg-zinc-900 border-zinc-800 group-hover:border-zinc-600 transition h-full flex flex-col">
                                <CardHeader>
                                    <CardTitle className="flex justify-between items-start">
                                        <span className="truncate text-white group-hover:text-zinc-200 transition-colors">{cliente.nombre}</span>
                                        <div className="p-2 -mr-2 -mt-2 text-zinc-400 bg-zinc-950/50 rounded-md group-hover:bg-zinc-800 group-hover:text-zinc-200 transition-colors shadow flex items-center gap-2 text-sm">
                                            <Settings className="h-4 w-4" /> <span className="hidden sm:inline">Configurar</span>
                                        </div>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="flex-1">
                                    <div className="text-sm text-zinc-400 flex flex-col gap-2">
                                        <div className="flex justify-between items-center bg-zinc-950/60 p-2 rounded">
                                            <span className="text-zinc-300">Meta Ads</span>
                                            {cliente.config_api?.meta_token ? (
                                                <span className="text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center bg-zinc-950/60 p-2 rounded">
                                            <span className="text-zinc-300">Hotmart API</span>
                                            {cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic ? (
                                                <span className="text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center bg-zinc-950/60 p-2 rounded">
                                            <span className="text-zinc-300">Google Analytics</span>
                                            {cliente.config_api?.ga_property_id ? (
                                                <span className="text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                                <CardFooter className="pt-2 border-t border-zinc-800 mt-2 text-xs flex justify-between items-center">
                                    <span className="text-zinc-500 uppercase">
                                        {new Date(cliente.created_at).toLocaleDateString()}
                                    </span>
                                    <span className="text-zinc-500 truncate max-w-[150px]" title={cliente.id}>ID: {cliente.id.substring(0, 8)}...</span>
                                </CardFooter>
                            </Card>
                        </a>
                    ))}
                </div>
            )}
        </div>
    )
}
