import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { getClientes, getGoogleConnectionStatus } from "./_actions"
import { NewClientDialog } from "./components/NewClientDialog"
import { GoogleConnectionCard } from "./components/GoogleConnectionCard"
import { AtSign, Settings, Layers } from "lucide-react"
import Link from "next/link"

export default async function AdminClientesPage() {
    const [clientes, googleStatus] = await Promise.all([
        getClientes(),
        getGoogleConnectionStatus(),
    ])

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-foreground">Ajustes de Sistema Unificado</h2>
                    <p className="text-muted-foreground">Configura accesos y credenciales de API para cada cliente.</p>
                </div>
                <NewClientDialog />
            </div>

            <GoogleConnectionCard connected={googleStatus.connected} email={googleStatus.email} />

            {!clientes || clientes.length === 0 ? (
                <Card className="bg-card border-border flex flex-col items-center justify-center p-12 text-center">
                    <div className="bg-muted p-4 rounded-full mb-4">
                        <AtSign className="h-8 w-8 text-muted-foreground/70" />
                    </div>
                    <CardTitle className="text-xl">Sin clientes registrados</CardTitle>
                    <p className="text-muted-foreground mt-2 max-w-sm mb-6">
                        Aún no has creado configuraciones para tus clientes. Empieza creando tu primer cliente para conectarlo a Meta o Hotmart.
                    </p>
                    <NewClientDialog />
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {clientes.map((cliente: any) => (
                        <a key={cliente.id} href={`/admin/settings/${cliente.id}`} className="block group">
                            <Card className="bg-card border-border group-hover:border-ring transition h-full flex flex-col">
                                <CardHeader>
                                    <CardTitle className="flex justify-between items-start">
                                        <span className="truncate text-foreground group-hover:text-foreground/90 transition-colors">{cliente.nombre}</span>
                                        <div className="p-2 -mr-2 -mt-2 text-muted-foreground bg-muted/50 rounded-md group-hover:bg-accent group-hover:text-foreground transition-colors shadow flex items-center gap-2 text-sm">
                                            <Settings className="h-4 w-4" /> <span className="hidden sm:inline">Configurar</span>
                                        </div>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="flex-1">
                                    <div className="text-sm text-muted-foreground flex flex-col gap-2">
                                        <div className="flex justify-between items-center bg-muted/60 p-2 rounded">
                                            <span className="text-foreground/90">Meta Ads</span>
                                            {cliente.config_api?.meta_token ? (
                                                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center bg-muted/60 p-2 rounded">
                                            <span className="text-foreground/90">Hotmart API</span>
                                            {cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic ? (
                                                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center bg-muted/60 p-2 rounded">
                                            <span className="text-foreground/90">TikTok Ads</span>
                                            {cliente.config_api?.tiktok_access_token && cliente.config_api?.tiktok_advertiser_id ? (
                                                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                        <div className="flex justify-between items-center bg-muted/60 p-2 rounded">
                                            <span className="text-foreground/90">Google Analytics</span>
                                            {cliente.config_api?.ga_property_id ? (
                                                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 text-xs font-medium">● Conectado</span>
                                            ) : (
                                                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs">● Pendiente</span>
                                            )}
                                        </div>
                                    </div>
                                </CardContent>
                                <CardFooter className="pt-2 border-t border-border mt-2 flex justify-between items-center gap-2">
                                    <span className="text-muted-foreground/70 text-xs uppercase flex-1">
                                        {new Date(cliente.created_at).toLocaleDateString()}
                                    </span>
                                    <Link
                                        href={`/admin/campaign-groups/${cliente.id}`}
                                        className="text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-400 transition text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-accent"
                                        title="Gestionar grupos de campañas"
                                    >
                                        <Layers className="w-3 h-3" />
                                        Grupos
                                    </Link>
                                </CardFooter>
                            </Card>
                        </a>
                    ))}
                </div>
            )}
        </div>
    )
}
