import { getCliente, getLayouts, getGoogleConnectionStatus } from '../_actions'
import { ClientConfigForm } from '../components/ClientConfigForm'
import { redirect } from 'next/navigation'

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;

    const [cliente, layouts, google] = await Promise.all([
        getCliente(params.id),
        getLayouts(),
        // Determina si GA4/Sheets pueden usar el OAuth de agencia (sin Service Account).
        getGoogleConnectionStatus(),
    ])

    if (!cliente) {
        redirect('/admin/settings')
    }

    return (
        <div className="max-w-3xl mx-auto py-6">
            <ClientConfigForm
                cliente={cliente}
                layouts={layouts}
                isAdmin={true}
                googleConnected={google.connected}
                googleEmail={google.email}
            />
        </div>
    )
}
