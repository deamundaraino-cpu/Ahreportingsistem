import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { getClientes } from "../admin/settings/_actions"
import { BarChart3, AtSign, ArrowRight } from "lucide-react"

export default async function DashboardDirectoryPage() {
    const clientes = await getClientes()

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                        Directorio de Clientes
                    </h2>
                    <p className="text-zinc-500 dark:text-zinc-400 mt-0.5">
                        Selecciona un cliente para visualizar su embudo de ventas consolidado.
                    </p>
                </div>
            </div>

            {!clientes || clientes.length === 0 ? (
                <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 flex flex-col items-center justify-center p-12 text-center">
                    <div className="bg-zinc-100 dark:bg-zinc-800 p-4 rounded-full mb-4">
                        <AtSign className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
                    </div>
                    <CardTitle className="text-xl text-zinc-800 dark:text-zinc-200">Sin clientes activos</CardTitle>
                    <p className="text-zinc-500 dark:text-zinc-400 mt-2 max-w-sm mb-6">
                        No hay clientes configurados. Ve a Ajustes de Sistema para agregar tu primer cliente.
                    </p>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {clientes.map((cliente: any) => {
                        const hasMeta    = !!cliente.config_api?.meta_token
                        const hasHotmart = !!(cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic)
                        const hasGA4     = !!cliente.config_api?.ga_property_id

                        return (
                            <a key={cliente.id} href={`/dashboard/${cliente.id}`} className="block group">
                                <Card className="
                                    bg-white dark:bg-zinc-900
                                    border border-zinc-200 dark:border-zinc-800
                                    group-hover:border-[#1E6AB5]/50 dark:group-hover:border-[#1E6AB5]/40
                                    group-hover:shadow-[0_4px_20px_rgba(30,106,181,0.12)] dark:group-hover:shadow-[0_4px_20px_rgba(30,106,181,0.18)]
                                    transition-all duration-300 h-full flex flex-col
                                ">
                                    <CardHeader className="pb-4">
                                        <CardTitle className="flex justify-between items-start">
                                            <span className="truncate text-zinc-900 dark:text-zinc-100 group-hover:text-[#1E6AB5] dark:group-hover:text-[#5a9fd4] transition-colors font-semibold">
                                                {cliente.nombre}
                                            </span>
                                            <div className="p-2 -mr-2 -mt-2 rounded-md
                                                            text-zinc-400 dark:text-zinc-500
                                                            bg-zinc-50 dark:bg-zinc-800/60
                                                            group-hover:bg-[#1E6AB5]/10
                                                            group-hover:text-[#1E6AB5] dark:group-hover:text-[#5a9fd4]
                                                            transition-colors">
                                                <BarChart3 className="h-4 w-4" />
                                            </div>
                                        </CardTitle>
                                    </CardHeader>

                                    <CardContent className="flex-1">
                                        <div className="text-sm text-zinc-500 dark:text-zinc-400 flex flex-col gap-3">
                                            <IntegrationRow active={hasMeta}    label="Meta Ads" />
                                            <IntegrationRow active={hasHotmart} label="Hotmart API" />
                                            <IntegrationRow active={hasGA4}     label="Google Analytics" />
                                        </div>
                                    </CardContent>

                                    <CardFooter className="pt-4 border-t border-zinc-100 dark:border-zinc-800 mt-auto">
                                        <div className="flex justify-between items-center w-full text-xs">
                                            <span className="text-zinc-400 dark:text-zinc-500 font-mono bg-zinc-50 dark:bg-zinc-800/50 px-2 py-0.5 rounded">
                                                ID: {cliente.id.substring(0, 8)}
                                            </span>
                                            <span className="text-[#1E6AB5] dark:text-[#5a9fd4] flex items-center font-medium opacity-0 group-hover:opacity-100 transition-all duration-300 -translate-x-2 group-hover:translate-x-0">
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

function IntegrationRow({ active, label }: { active: boolean; label: string }) {
    return (
        <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 transition-colors ${
                active
                    ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                    : 'bg-zinc-300 dark:bg-zinc-700'
            }`} />
            <span className={active ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-400 dark:text-zinc-600'}>
                {label}
            </span>
        </div>
    )
}
