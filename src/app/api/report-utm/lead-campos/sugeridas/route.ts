// Preguntas ofrecibles para un bloque de respuestas del dashboard general.
//
//   GET /api/report-utm/lead-campos/sugeridas?public_cliente_id=&todas=1
//
// Se diferencia de `../detectar` en tres cosas, y por eso es una ruta aparte:
//
//   1. Entra por el id PÚBLICO del cliente (`public.clientes.id`), que es el que
//      conoce el dashboard. `detectar` entra por el de report_utm, que el
//      dashboard no tiene a mano.
//   2. Devuelve PRIMERO los campos ya configurados en `report_utm.lead_campos`
//      y después las claves auto-detectadas, en una sola lista que el picker
//      pinta en dos grupos. Un campo configurado gana siempre: es el que une la
//      misma pregunta llegada por Meta y por web bajo un solo desglose.
//   3. Filtra la detección con criterios de PRESENTACIÓN (solo preguntas de
//      opción, con cobertura suficiente, sin valores de relleno), porque su
//      destino es un desplegable de configuración y no un editor de campos.
//
// NUNCA la llama la carga del dashboard: escanear hasta 30.000 leads en cada
// render sería inaceptable. Solo se pide al abrir la configuración del bloque.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { getUserRole } from '@/lib/report-utm/auth';
import { detectarCamposDeLeads, loadLeadCampos } from '@/lib/report-utm/lead-campos-db';
import { esValorPlaceholder } from '@/lib/report-utm/lead-campos';
import { resolveRtmClienteId } from '@/lib/report-utm/campaign-resolver';

export const dynamic = 'force-dynamic';

/** Ventana de escaneo: el alta mira el histórico, no el rango del informe. */
const DIAS_ESCANEO = 365;

/** Cobertura mínima para ofrecer una clave, como fracción de los leads vistos. */
const COBERTURA_MINIMA = 0.05;
/** …con un piso absoluto, para que un cliente pequeño no se quede sin nada. */
const LEADS_MINIMOS = 20;

/** Tope de preguntas ofrecidas: más no cabe en un desplegable útil. */
const MAX_SUGERIDAS = 20;

export interface PreguntaSugerida {
  origen: 'catalogo' | 'auto';
  /** Con origen 'catalogo', el slug del campo. Con 'auto', la clave normalizada. */
  clave: string;
  /** Nombre visible propuesto. */
  nombre: string;
  /** Claves crudas que unifica (una sola en las auto-detectadas). */
  clavesOrigen: string[];
  leads: number;
  distintos: number;
  formularios: string[];
  /** Los valores más frecuentes, para la vista previa del picker. */
  valores: string[];
  /**
   * El campo existe pero está DESACTIVADO. Solo se devuelve para la clave que el
   * bloque ya tiene guardada (`clave_actual`).
   *
   * Sin esto, la pregunta configurada simplemente no aparecía en la lista: el
   * analista abría el picker de un bloque roto, no veía qué tenía puesto y no
   * podía ni confirmarlo ni recuperarlo. Ofrecerlo marcado es lo que permite
   * decidir entre reactivarlo o cambiar de pregunta.
   */
  inactivo?: boolean;
}

// ── Caché de módulo ───────────────────────────────────────────────────
// El analista abre el modal, prueba dos o tres preguntas y lo cierra. Sin caché
// eso son tres escaneos idénticos de decenas de miles de leads. TTL más largo
// que el del dashboard porque el catálogo de preguntas de un cliente cambia con
// cada campaña nueva, no con cada sincronización.

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { payload: unknown; ts: number }>();

export async function GET(req: NextRequest) {
  const role = await getUserRole();
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const publicClienteId = sp.get('public_cliente_id');
  if (!publicClienteId) {
    return NextResponse.json({ error: 'public_cliente_id requerido' }, { status: 400 });
  }
  const todas = sp.get('todas') === '1';
  // Clave que el bloque ya tiene guardada. Se pasa para poder devolverla aunque
  // su campo esté desactivado; ver `PreguntaSugerida.inactivo`.
  const claveActual = sp.get('clave_actual') ?? '';

  const key = `${publicClienteId}|${todas ? 'todas' : 'ofrecibles'}|${claveActual}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= TTL_MS) {
    return NextResponse.json(hit.payload, {
      headers: { 'Cache-Control': 'private, max-age=600' },
    });
  }

  try {
    const rtmClienteId = await resolveRtmClienteId(publicClienteId);
    if (!rtmClienteId) {
      // Distinguir "no enlazado" de "sin preguntas" importa: el primero se
      // arregla en la ficha del cliente y el segundo no se arregla.
      return NextResponse.json(
        {
          data: [],
          leads: 0,
          enlazado: false,
        },
        { headers: { 'Cache-Control': 'private, max-age=600' } }
      );
    }

    const dateFrom = new Date(Date.now() - DIAS_ESCANEO * 86400_000).toISOString().slice(0, 10);
    const dateTo = new Date().toISOString().slice(0, 10);

    const rtm = await reportUtmAdminClient();
    // Se lee el catálogo ENTERO, no solo los activos: hace falta poder devolver
    // el campo que el bloque tiene guardado aunque esté desactivado.
    const [catalogoCompleto, deteccion] = await Promise.all([
      loadLeadCampos(rtm, rtmClienteId),
      detectarCamposDeLeads(rtm, rtmClienteId, { dateFrom, dateTo, incluirIgnoradas: todas }),
    ]);

    // Los activos, más —si toca— el inactivo que el bloque ya tiene puesto. Un
    // campo desactivado NO se ofrece para elegirlo de nuevo; se ofrece para que
    // el analista vea qué hay configurado y decida.
    const catalogo = catalogoCompleto.filter(
      (c) => c.activo || (claveActual !== '' && c.clave === claveActual)
    );

    const delCatalogo: PreguntaSugerida[] = catalogo.map((c) => ({
      origen: 'catalogo',
      clave: c.clave,
      nombre: c.nombre,
      clavesOrigen: c.claves_origen,
      // La cobertura real la calcula el bloque al consultar; aquí solo se
      // suma lo detectado para esas claves, como referencia del picker.
      leads: deteccion.claves
        .filter((k) => c.claves_origen.includes(k.clave_norm))
        .reduce((s, k) => s + k.leads, 0),
      distintos: c.valores_orden.length || 0,
      formularios: [],
      valores: c.valores_orden.slice(0, 10),
      ...(c.activo ? {} : { inactivo: true }),
    }));

    // Las claves que ya cubre un campo del catálogo no se vuelven a ofrecer:
    // elegirlas sueltas partiría en dos un desglose que ya está unificado.
    // Incluye el inactivo que se acaba de añadir: ofrecer a la vez el campo y
    // sus claves sueltas sería ofrecer dos veces la misma pregunta.
    const yaCubiertas = new Set(catalogo.flatMap((c) => c.claves_origen));

    const umbral = Math.max(LEADS_MINIMOS, Math.round(deteccion.leads * COBERTURA_MINIMA));
    const autoDetectadas: PreguntaSugerida[] = deteccion.claves
      .filter((k) => todas || k.es_opcion)
      .filter((k) => !yaCubiertas.has(k.clave_norm))
      .filter((k) => k.leads >= umbral)
      .slice(0, MAX_SUGERIDAS)
      .map((k) => ({
        origen: 'auto' as const,
        clave: k.clave_norm,
        nombre: k.clave,
        clavesOrigen: [k.clave_norm],
        leads: k.leads,
        distintos: k.distintos,
        formularios: k.formularios,
        valores: k.valores
          .map((v) => v.valor_crudo)
          // Los rellenos de desplegable ("Seleccione una opción") y los
          // leads de prueba de Meta ensucian la vista previa y harían
          // pensar que la pregunta no sirve.
          .filter((v) => !esValorPlaceholder(v))
          .slice(0, 10),
      }));

    const payload = {
      data: [...delCatalogo, ...autoDetectadas],
      leads: deteccion.leads,
      enlazado: true,
    };

    if (cache.size > 200) cache.clear();
    cache.set(key, { payload, ts: Date.now() });

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, max-age=600' },
    });
  } catch (err) {
    console.error('[lead-campos/sugeridas]', err);
    return NextResponse.json({ error: 'No se pudieron leer los leads.' }, { status: 500 });
  }
}
