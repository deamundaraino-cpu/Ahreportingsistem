// Campos dinámicos de un cliente para el BI, sin pasar por HTTP.
//
// El editor los pide a cinco rutas (`lead-fields`, `sheet-fields`,
// `offline-fields`, `custom-conversions`, `catalog`). Las herramientas del
// agente necesitan lo mismo —qué preguntas, respuestas, segmentos, campos de
// Sheet y conversiones existen— para ofrecer tokens válidos en vez de dejar que
// el modelo los adivine y guarde un widget que muestra 0.
//
// Diferencia deliberada con `lead-fields`: aquí NO se escanean leads. Esa ruta
// recorre hasta 30.000 filas para calcular cobertura y valores del período; el
// agente solo necesita el CATÁLOGO (lo que el analista definió), y en la
// instancia Micro ese escaneo es justo lo que hay que evitar.

import { loadLeadCampos, loadLeadSegmentos } from '@/lib/report-utm/lead-campos-db';
import { etiquetasDeCampo } from '@/lib/report-utm/lead-campos';
import {
  clavesDeRespuestas,
  claveFormulaRespuesta,
  claveFormulaSegmento,
  tokenRespuesta,
} from '@/lib/leads/respuestas/claves';
import { loadCamposCliente } from '@/lib/sheets/campos-db';
import { leerCatalogoConversiones } from '@/lib/meta/conversiones-catalogo';
import {
  makeLeadFieldDim,
  makeLeadSegMetric,
  makeSheetDim,
  makeSheetMetric,
  makeSheetView,
  sheetFieldAlias,
  sheetViewAlias,
  makeOfflineFieldMetric,
  offlineFieldAlias,
  makeMetaCcMetric,
  makeGa4EvMetric,
  ga4EvAlias,
  type OfflineFieldMeta,
  type OfflineFieldType,
  type SheetCampoAgg,
} from '@/lib/report-utm/bi-metadata';

/** Cliente de Supabase ya apuntado al schema que toque. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// ── Columnas offline: puro, compartido con /bi/offline-fields ──────────────

/**
 * Columnas numéricas declaradas en `config_api.google_sheets_conversiones`.
 *
 * Salen de la CONFIG del cliente (formato con `tabs` o el plano anterior), no
 * de escanear datos: el analista ya declaró qué columnas se sincronizan y de qué
 * tipo son. Las de texto o fecha se omiten — el BI solo grafica números.
 */
export function columnasOfflineDeConfig(configApi: unknown): OfflineFieldMeta[] {
  interface ColDef {
    col_name?: string;
    type?: string;
    label?: string;
    include?: boolean;
  }
  interface TabCfg {
    sheet_name?: string;
    custom_columns?: Record<string, ColDef>;
  }
  interface SheetCfg {
    name?: string;
    custom_columns?: Record<string, ColDef>;
    tabs?: TabCfg[];
  }

  const raw = (configApi as Record<string, unknown> | null)?.google_sheets_conversiones;
  const sheets: SheetCfg[] = Array.isArray(raw)
    ? (raw as SheetCfg[])
    : raw && typeof raw === 'object'
      ? [raw as SheetCfg]
      : [];

  const byKey = new Map<string, OfflineFieldMeta>();
  const absorb = (cols: Record<string, ColDef> | undefined, source: string) => {
    for (const [key, def] of Object.entries(cols ?? {})) {
      if (!def || def.include === false) continue;
      if (def.type !== 'count' && def.type !== 'currency' && def.type !== 'percentage') continue;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      } else {
        byKey.set(key, {
          key,
          label: def.label || def.col_name || key,
          type: def.type,
          sources: [source],
        });
      }
    }
  };

  for (const sheet of sheets) {
    const sheetName = sheet.name || 'Sheet';
    absorb(sheet.custom_columns, sheetName);
    for (const tab of sheet.tabs ?? []) {
      absorb(tab.custom_columns, `${sheetName} › ${tab.sheet_name || '(primera pestaña)'}`);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Claves de las columnas offline de tipo `percentage` de un cliente.
 *
 * El dashboard las necesita para PROMEDIAR esas columnas (ponderadas por la
 * cantidad de la fila) en vez de sumarlas, igual que el BI. Solo se lee la rama
 * `google_sheets_conversiones` de `config_api`: el resto guarda credenciales y
 * no tiene por qué viajar. Un fallo de lectura devuelve el conjunto vacío (se
 * suman como antes) en vez de tumbar el dashboard entero.
 */
export async function columnasPorcentajeOffline(db: Db, clienteId: string): Promise<Set<string>> {
  try {
    const { data } = await db
      .from('clientes')
      .select('sheets:config_api->google_sheets_conversiones')
      .eq('id', clienteId)
      .maybeSingle();
    const sheets = (data as { sheets?: unknown } | null)?.sheets;
    if (!sheets) return new Set();
    return new Set(
      columnasOfflineDeConfig({ google_sheets_conversiones: sheets })
        .filter((c) => c.type === 'percentage')
        .map((c) => c.key)
    );
  } catch {
    return new Set();
  }
}

// ── Catálogo dinámico, con los tokens ya construidos ─────────────────────

export type RespuestaDeCampo = {
  nombre: string;
  /** Métrica: leads que dieron esta respuesta. Va en `metric` o en una tabla. */
  token: string;
  /** Alias para una fórmula (`spend / lf__…`). */
  alias_formula: string;
};

export type CamposDinamicos = {
  preguntas: Array<{
    clave: string;
    nombre: string;
    /** Dimensión (desglose o filtro): `leadfield:<clave>`. */
    dimension: string;
    respuestas: RespuestaDeCampo[];
    /** Leads que no respondieron esta pregunta. */
    sin_respuesta: RespuestaDeCampo;
  }>;
  segmentos: Array<{ clave: string; nombre: string; token: string; alias_formula: string }>;
  sheet: {
    campos: Array<{
      clave: string;
      nombre: string;
      rol: string;
      dimension: string | null;
      metrica: string | null;
      alias_formula: string;
    }>;
    vistas: Array<{ clave: string; nombre: string; token: string; alias_formula: string }>;
  };
  offline: Array<{ clave: string; nombre: string; token: string; alias_formula: string }>;
  conversiones_meta: Array<{
    clave: string;
    nombre: string;
    token: string;
    /** Alias para campos calculados (`mcc__<clave>`). */
    alias_formula: string;
    tipo: string;
    es_resultado: boolean;
    /** Con actividad en los últimos 90 días y sin archivar. */
    activa: boolean;
  }>;
  /** Eventos clave de GA4 vistos en la propiedad (`ga4_estado.eventos`). */
  eventos_ga4: Array<{
    clave: string;
    nombre: string;
    /** `ga4ev:<evento>` */
    token: string;
    /** Alias para campos calculados (`ga4ev__<evento>`). */
    alias_formula: string;
    ultima_actividad: string | null;
  }>;
  /** Fuentes que no se pudieron leer: «no se pudo mirar» no es «no hay». */
  avisos: string[];
};

/** Todos los alias de fórmula que el catálogo hace válidos. */
export function aliasesDeCatalogo(c: CamposDinamicos): Set<string> {
  const out = new Set<string>();
  for (const p of c.preguntas) {
    for (const r of p.respuestas) out.add(r.alias_formula);
    out.add(p.sin_respuesta.alias_formula);
  }
  for (const s of c.segmentos) out.add(s.alias_formula);
  for (const f of c.sheet.campos) out.add(f.alias_formula);
  for (const v of c.sheet.vistas) out.add(v.alias_formula);
  for (const o of c.offline) out.add(o.alias_formula);
  for (const m of c.conversiones_meta) out.add(m.alias_formula);
  for (const e of c.eventos_ga4) out.add(e.alias_formula);
  return out;
}

/** Todos los tokens (métricas y dimensiones) que el catálogo hace válidos. */
export function tokensDeCatalogo(c: CamposDinamicos): Set<string> {
  const out = new Set<string>();
  for (const p of c.preguntas) {
    out.add(p.dimension);
    for (const r of p.respuestas) out.add(r.token);
    out.add(p.sin_respuesta.token);
  }
  for (const s of c.segmentos) out.add(s.token);
  for (const f of c.sheet.campos) {
    if (f.dimension) out.add(f.dimension);
    if (f.metrica) out.add(f.metrica);
  }
  for (const v of c.sheet.vistas) out.add(v.token);
  for (const o of c.offline) out.add(o.token);
  for (const m of c.conversiones_meta) out.add(m.token);
  for (const e of c.eventos_ga4) out.add(e.token);
  return out;
}

const OFFLINE_TIPO: Record<string, OfflineFieldType> = {
  count: 'count',
  currency: 'currency',
  percentage: 'percentage',
};

/**
 * Catálogo dinámico de un cliente.
 *
 * `db` es el cliente admin de `public`. `rtmId` es el id de
 * `report_utm.clientes`; `publicId` el de `public.clientes` (null si no están
 * enlazados: entonces Sheets, offline y conversiones de Meta no aplican).
 *
 * Nunca lanza por una fuente: cada una que falla deja un aviso.
 */
export async function camposDinamicosCliente(
  db: Db,
  rtmId: string,
  publicId: string | null
): Promise<CamposDinamicos> {
  const avisos: string[] = [];
  const rtm = db.schema('report_utm');
  const out: CamposDinamicos = {
    preguntas: [],
    segmentos: [],
    sheet: { campos: [], vistas: [] },
    offline: [],
    conversiones_meta: [],
    eventos_ga4: [],
    avisos,
  };

  // Preguntas de formulario y segmentos.
  try {
    const campos = await loadLeadCampos(rtm, rtmId, { soloActivos: true });
    const segmentos = campos.length
      ? await loadLeadSegmentos(rtm, rtmId, campos, { soloActivos: true })
      : [];
    out.preguntas = campos.map((campo) => {
      const nombres = etiquetasDeCampo(campo);
      const claves = clavesDeRespuestas(nombres, campo.respuestas ?? []);
      return {
        clave: campo.clave,
        nombre: campo.nombre,
        dimension: makeLeadFieldDim(campo.clave),
        respuestas: nombres.map((nombre, i) => ({
          nombre,
          token: tokenRespuesta(campo.clave, claves[i]),
          alias_formula: claveFormulaRespuesta(campo.clave, claves[i]),
        })),
        sin_respuesta: {
          nombre: 'Sin respuesta',
          token: tokenRespuesta(campo.clave, 'sin_respuesta'),
          alias_formula: claveFormulaRespuesta(campo.clave, 'sin_respuesta'),
        },
      };
    });
    out.segmentos = segmentos.map((s) => ({
      clave: s.clave,
      nombre: s.nombre,
      token: makeLeadSegMetric(s.clave),
      alias_formula: claveFormulaSegmento(s.clave),
    }));
  } catch (e) {
    avisos.push(`No se pudieron leer las preguntas de formulario: ${(e as Error).message}`);
  }

  if (!publicId) {
    avisos.push(
      'El cliente de Report-UTM no está enlazado a su cliente de Reporting: no hay campos de Sheet, columnas offline ni conversiones de Meta.'
    );
    return out;
  }

  // Campos y vistas de Sheet.
  try {
    const { campos, vistas } = await loadCamposCliente(db, publicId, { soloActivos: true });
    // Mismas reglas que el editor (`BiWidgetEditor`): un campo de alta
    // cardinalidad no se ofrece para agrupar, y la métrica usa la agregación
    // que definió el analista.
    out.sheet.campos = campos.map(
      (c: {
        clave: string;
        nombre: string;
        rol: string;
        agregacion: SheetCampoAgg;
        alta_cardinalidad?: boolean;
      }) => ({
        clave: c.clave,
        nombre: c.nombre,
        rol: c.rol,
        dimension: c.rol !== 'metrica' && !c.alta_cardinalidad ? makeSheetDim(c.clave) : null,
        metrica: makeSheetMetric(c.agregacion ?? 'count', c.clave),
        alias_formula: sheetFieldAlias(c.clave),
      })
    );
    out.sheet.vistas = vistas.map((v: { clave: string; nombre: string }) => ({
      clave: v.clave,
      nombre: v.nombre,
      token: makeSheetView(v.clave),
      alias_formula: sheetViewAlias(v.clave),
    }));
  } catch (e) {
    avisos.push(`No se pudieron leer los campos de Sheet: ${(e as Error).message}`);
  }

  // Columnas offline declaradas en la config del cliente.
  try {
    const { data, error } = await db
      .from('clientes')
      .select('config_api')
      .eq('id', publicId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    out.offline = columnasOfflineDeConfig(data?.config_api).map((c) => ({
      clave: c.key,
      nombre: c.label,
      token: makeOfflineFieldMetric(OFFLINE_TIPO[c.type] ?? 'count', c.key),
      alias_formula: offlineFieldAlias(c.key),
    }));
  } catch (e) {
    avisos.push(`No se pudieron leer las columnas offline: ${(e as Error).message}`);
  }

  // Conversiones personalizadas de Meta. TODAS, también las antiguas: un widget
  // guardado con una conversión antigua tiene que seguir validando. Quien las
  // ofrece decide si muestra solo las activas.
  try {
    for (const c of await leerCatalogoConversiones(db, publicId)) {
      out.conversiones_meta.push({
        clave: c.key,
        nombre: c.label,
        token: makeMetaCcMetric(c.key),
        alias_formula: c.alias,
        tipo: c.tipo,
        es_resultado: c.es_resultado,
        activa: c.activa,
      });
    }
  } catch (e) {
    avisos.push(`No se pudieron leer las conversiones de Meta: ${(e as Error).message}`);
  }

  // Eventos clave de GA4 (migración 097). Sin fila de estado: el cliente no
  // tiene GA4 sincronizado y simplemente no hay eventos que ofrecer.
  try {
    const { data, error } = await db
      .from('ga4_estado')
      .select('eventos')
      .eq('cliente_id', publicId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const eventos = (data?.eventos ?? {}) as Record<string, string>;
    out.eventos_ga4 = Object.entries(eventos)
      .filter(([k]) => /^[a-z][a-z0-9_]*$/i.test(k))
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .map(([clave, ultima]) => ({
        clave,
        nombre: `Evento clave: ${clave} (GA4)`,
        token: makeGa4EvMetric(clave),
        alias_formula: ga4EvAlias(clave),
        ultima_actividad: ultima ?? null,
      }));
  } catch (e) {
    avisos.push(`No se pudieron leer los eventos clave de GA4: ${(e as Error).message}`);
  }

  return out;
}
