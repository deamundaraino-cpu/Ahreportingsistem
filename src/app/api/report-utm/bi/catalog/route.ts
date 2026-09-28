// Catálogo unificado del BI: las fuentes de datos y sus campos.
//
// ── Qué sustituye ────────────────────────────────────────────────────────
// El editor hace hoy CUATRO peticiones para armar sus listas
// (`form-fields`, `lead-fields`, `sheet-fields`, `offline-fields`) más una quinta
// de disponibilidad, y luego mezcla todo con seis gramáticas de tokens distintas
// en un `<select>` plano de 72 métricas fijas con 9 optgroups y un
// «Ver todas (60 más)».
//
// Aquí se devuelve UNA estructura: fuentes, y dentro de cada fuente sus campos.
// Es el modelo que hace fácil la configuración en las herramientas del mercado:
// se elige primero la fuente y después el campo, en vez de buscar una aguja en
// una lista de 72.
//
// ── Compatibilidad ───────────────────────────────────────────────────────
// Cada campo lleva DOS ids: el canónico (`ads.spend`) y el histórico
// (`spend`). El editor guarda el HISTÓRICO, así que los informes siguen
// escribiéndose exactamente igual que hoy y no hace falta migrar nada todavía.
// El canónico viaja para que el día que se cambie el formato de guardado el
// cliente ya lo tenga.
//
// La construcción vive en `lib/report-utm/bi/catalogo-estatico.ts`: la comparte
// la herramienta `list_report_fields` del agente.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { resolvePublicClienteId } from '@/lib/report-utm/campaign-resolver';
import { catalogoEstatico } from '@/lib/report-utm/bi/catalogo-estatico';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clienteId = req.nextUrl.searchParams.get('cliente_id') ?? undefined;
  // La dimensión actual del widget: sirve para marcar de antemano qué campos
  // NO cruzan con ella, en vez de dejar que el usuario descubra el 0 después.
  const dimension = req.nextUrl.searchParams.get('dimension') ?? undefined;

  try {
    // El puente `public_cliente_id` decide si media plataforma es legible.
    // Declararlo aquí es lo que permite atenuar la fuente ENTERA en el
    // selector con un motivo, en vez de listar 40 métricas que darán 0.
    const hasPublicLink = clienteId ? (await resolvePublicClienteId(clienteId)) !== null : true;

    return NextResponse.json(
      {
        data: {
          hasPublicLink,
          sources: catalogoEstatico(hasPublicLink, dimension),
        },
      },
      { headers: { 'Cache-Control': 'private, max-age=120' } }
    );
  } catch (err) {
    console.error('[bi/catalog]', err);
    return NextResponse.json({ error: 'Catalog error' }, { status: 500 });
  }
}
