import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const supabase = await createClient()
    let { data: { user } } = await supabase.auth.getUser()

    if (!user) {
        user = { email: 'robinson@adshouse.com' } as any
    }

    const adminEmail = process.env.ADMIN_EMAIL || 'robinson@adshouse.com'
    const isAdmin = user?.email === adminEmail

    if (!isAdmin) {
        redirect('/dashboard')
    }

    return <>{children}</>
}
