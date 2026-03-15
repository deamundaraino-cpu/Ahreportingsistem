import { getLayouts } from '../settings/_actions'
import { LayoutBuilderClient } from './LayoutBuilderClient'

export default async function LayoutsPage() {
    const layouts = await getLayouts()
    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight text-white">Constructor de Layouts</h2>
                <p className="text-zinc-400">Crea y edita plantillas de métricas para asignarlas a tus clientes.</p>
            </div>
            <LayoutBuilderClient layouts={layouts} />
        </div>
    )
}
