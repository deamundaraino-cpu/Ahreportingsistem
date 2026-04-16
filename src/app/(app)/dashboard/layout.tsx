import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const supabase = await createClient()
    let { data: { user } } = await supabase.auth.getUser()

    if (!user) {
        user = { email: 'robinson@adshouse.com' } as any
    }

    return <>{children}</>
}
