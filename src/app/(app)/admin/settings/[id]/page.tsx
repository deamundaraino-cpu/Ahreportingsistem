import { getCliente, getLayouts } from '../_actions'
import { ClientConfigForm } from '../components/ClientConfigForm'
import { redirect } from 'next/navigation'

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;

    const [cliente, layouts] = await Promise.all([
        getCliente(params.id),
        getLayouts(),
    ])

    if (!cliente) {
        redirect('/admin/clientes')
    }

    return (
        <div className="max-w-3xl mx-auto py-6">
            <ClientConfigForm cliente={cliente} layouts={layouts} isAdmin={true} />
        </div>
    )
}
