import { ApiTokensManager } from '@/components/api-tokens/ApiTokensManager'
import { Key } from 'lucide-react'

export default function ApiTokensPage() {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('//', '//app.') ?? ''

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Key className="h-5 w-5 text-[#1E6AB5]" />
                        <h2 className="text-2xl font-bold text-white">API & Integraciones</h2>
                    </div>
                    <p className="text-zinc-400">
                        Genera tokens para conectar plataformas externas a tu cuenta de AdsHouse.
                    </p>
                </div>
            </div>

            <ApiTokensManager baseUrl={baseUrl} />
        </div>
    )
}
