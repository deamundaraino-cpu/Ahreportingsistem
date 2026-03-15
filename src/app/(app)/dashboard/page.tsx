import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { getClientes } from "../admin/settings/_actions"
import { BarChart3, AtSign, ArrowRight } from "lucide-react"

export default async function DashboardDirectoryPage() {
    const clientes = await getClientes()

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-white">Directorio de Clientes</h2>
                    <p className="text-zinc-400">Selecciona un cliente para visualizar su embudo de ventas consolidado.</p>
                </div>
            </div>

            {!clientes || clientes.length === 0 ? (
                <Card className="bg-zinc-900 border-zinc-800 flex flex-col items-center justify-center p-12 text-center">
                    <div className="bg-zinc-800 p-4 rounded-full mb-4">
                        <AtSign className="h-8 w-8 text-zinc-500" />
                    </div>
                    <CardTitle className="text-xl">Sin clientes activos</CardTitle>
                    <p className="text-zinc-400 mt-2 max-w-sm mb-6">
                        No hay clientes configurados. Ve a Ajustes de Sistema para agregar tu primer cliente.
                    </p>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {clientes.map((cliente: any) => {
                        const hasMeta = !!cliente.config_api?.meta_token
                        const hasHotmart = !!(cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic)
                        const hasGA = !!cliente.config_api?.ga_property_id

                        return (
                            <a key={cliente.id} href={`/dashboard/${cliente.id}`} className="block group">
                                <Card className="bg-zinc-900 border-zinc-800 group-hover:border-indigo-500/50 group-hover:shadow-[0_0_15px_rgba(99,102,241,0.15)] transition-all duration-300 h-full flex flex-col">
                                    <CardHeader className="pb-4">
                                        <CardTitle className="flex justify-between items-start">
                                            <span className="truncate text-white group-hover:text-indigo-400 transition-colors">{cliente.nombre}</span>
                                            <div className="p-2 -mr-2 -mt-2 text-zinc-400 bg-zinc-950/50 rounded-md group-hover:bg-indigo-500/10 group-hover:text-indigo-400 transition-colors">
                                                <BarChart3 className="h-4 w-4" />
                                            </div>
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="flex-1">
                                        <div className="text-sm text-zinc-400 flex flex-col gap-3">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-2 h-2 rounded-full ${hasMeta ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-zinc-700'}`} />
                                                <span className={hasMeta ? 'text-zinc-300' : 'text-zinc-600'}>Meta Ads</span>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <div className={`w-2 h-2 rounded-full ${hasHotmart ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-zinc-700'}`} />
                                                <span className={hasHotmart ? 'text-zinc-300' : 'text-zinc-600'}>Hotmart API</span>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <div className={`w-2 h-2 rounded-full ${hasGA ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-zinc-700'}`} />
                                                <span className={hasGA ? 'text-zinc-300' : 'text-zinc-600'}>Google Analytics</span>
                                            </div>
                                        </div>
                                    </CardContent>
                                    <CardFooter className="pt-4 border-t border-zinc-800 mt-auto">
                                        <div className="flex justify-between items-center w-full text-xs">
                                            <span className="text-zinc-500 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">ID: {cliente.id.substring(0, 8)}</span>
                                            <span className="text-indigo-400 flex items-center font-medium opacity-0 group-hover:opacity-100 transition-opacity -translate-x-2 group-hover:translate-x-0 duration-300">
                                                Ver Reporte <ArrowRight className="ml-1 h-3 w-3" />
                                            </span>
                                        </div>
                                    </CardFooter>
                                </Card>
                            </a>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
