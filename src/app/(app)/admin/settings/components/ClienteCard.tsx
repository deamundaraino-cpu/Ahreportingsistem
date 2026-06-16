"use client"

import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Settings, Layers } from "lucide-react"
import Link from "next/link"

interface ClienteCardProps {
    cliente: any
}

export function ClienteCard({ cliente }: ClienteCardProps) {
    const router = useRouter()

    return (
        <div
            className="block group cursor-pointer"
            onClick={() => router.push(`/admin/settings/${cliente.id}`)}
        >
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
                        onClick={(e) => e.stopPropagation()}
                    >
                        <Layers className="w-3 h-3" />
                        Grupos
                    </Link>
                </CardFooter>
            </Card>
        </div>
    )
}
