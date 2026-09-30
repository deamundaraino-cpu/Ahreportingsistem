/**
 * Salud de la base: tamaño, crecimiento, conexiones y latido de las purgas.
 *
 * Dos mitades, como `salud-fuentes.ts` / `salud-fuentes-db.ts`:
 *   · `evaluarSaludBase` es PURA (reglas y umbrales) y la comprueba
 *     `scripts/verify-salud-base.ts` sin tocar la base.
 *   · `medirSaludBase` recoge la muestra: RPC `salud_base()` y la bitácora
 *     `mantenimiento_log` (migración 101).
 *
 * La consume `/api/worker/health`, que el workflow `sync-fallback` llama cada 30
 * minutos: una alerta crítica hace fallar el workflow (correo + issue), que es
 * el único canal que sigue vivo cuando la app no puede ni pintar la campanita.
 */

const MB = 1024 * 1024;
const HORA_MS = 3_600_000;

/** Días hacia atrás contra los que se mide el crecimiento. */
export const VENTANA_CRECIMIENTO_DIAS = 7;
/** Una muestra de tamaño al día basta; el margen absorbe el retraso del cron. */
const HORAS_ENTRE_MUESTRAS = 20;
/** Retención de la propia bitácora. */
export const MANTENIMIENTO_LOG_RETENCION_DIAS = 90;

export type GravedadBase = 'critico' | 'aviso';

export interface AlertaBase {
  clave: 'tamano' | 'crecimiento' | 'conexiones' | 'purga';
  gravedad: GravedadBase;
  titulo: string;
  detalle: string;
}

export interface UmbralesBase {
  tamanoAvisoMb: number;
  tamanoCriticoMb: number;
  crecimientoAvisoPct: number;
  crecimientoCriticoPct: number;
  conexionesAvisoPct: number;
  conexionesCriticoPct: number;
  /** Las purgas corren a diario a las 05:00; día y medio sin ellas ya es un fallo. */
  purgaMaxHoras: number;
}

export const UMBRALES_BASE: UmbralesBase = {
  tamanoAvisoMb: 1024,
  tamanoCriticoMb: 2048,
  crecimientoAvisoPct: 10,
  crecimientoCriticoPct: 25,
  conexionesAvisoPct: 80,
  conexionesCriticoPct: 95,
  purgaMaxHoras: 36,
};

/** Umbrales con los `SALUD_DB_*` del entorno encima de los valores por defecto. */
export function umbralesDesdeEnv(
  env: Record<string, string | undefined> = process.env
): UmbralesBase {
  const num = (clave: string, def: number) => {
    const v = Number(env[clave]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    ...UMBRALES_BASE,
    tamanoAvisoMb: num('SALUD_DB_AVISO_MB', UMBRALES_BASE.tamanoAvisoMb),
    tamanoCriticoMb: num('SALUD_DB_CRITICO_MB', UMBRALES_BASE.tamanoCriticoMb),
    crecimientoAvisoPct: num('SALUD_DB_CRECIMIENTO_PCT', UMBRALES_BASE.crecimientoAvisoPct),
    purgaMaxHoras: num('SALUD_PURGA_MAX_HORAS', UMBRALES_BASE.purgaMaxHoras),
  };
}

export interface MuestraBase {
  dbBytes: number;
  conexiones: number;
  maxConexiones: number;
  /** Última fila `purga` de la bitácora. */
  ultimaPurgaAt: string | null;
  /** Fila más antigua de la bitácora: desde cuándo hay con qué comparar. */
  midiendoDesde: string | null;
  /** Muestra de tamaño más reciente con al menos `VENTANA_CRECIMIENTO_DIAS`. */
  tamanoAnterior: { bytes: number; at: string } | null;
}

const mb = (bytes: number) => Math.round(bytes / MB);

export function evaluarSaludBase(
  m: MuestraBase,
  u: UmbralesBase = UMBRALES_BASE,
  ahoraMs: number = Date.now()
): AlertaBase[] {
  const alertas: AlertaBase[] = [];

  const tamanoMb = m.dbBytes / MB;
  if (tamanoMb >= u.tamanoAvisoMb) {
    const critico = tamanoMb >= u.tamanoCriticoMb;
    alertas.push({
      clave: 'tamano',
      gravedad: critico ? 'critico' : 'aviso',
      titulo: `La base pesa ${mb(m.dbBytes)} MB`,
      detalle: `Supera el umbral de ${critico ? u.tamanoCriticoMb : u.tamanoAvisoMb} MB. Mira qué tabla ha crecido y si las purgas están corriendo.`,
    });
  }

  if (m.tamanoAnterior && m.tamanoAnterior.bytes > 0) {
    const pct = ((m.dbBytes - m.tamanoAnterior.bytes) / m.tamanoAnterior.bytes) * 100;
    if (pct >= u.crecimientoAvisoPct) {
      const dias = Math.max(
        1,
        Math.round((ahoraMs - new Date(m.tamanoAnterior.at).getTime()) / (24 * HORA_MS))
      );
      alertas.push({
        clave: 'crecimiento',
        gravedad: pct >= u.crecimientoCriticoPct ? 'critico' : 'aviso',
        titulo: `La base ha crecido un ${Math.round(pct)} % en ${dias} días`,
        detalle: `De ${mb(m.tamanoAnterior.bytes)} MB a ${mb(m.dbBytes)} MB. El ritmo normal es de un pequeño porcentaje al mes.`,
      });
    }
  }

  if (m.maxConexiones > 0) {
    const pct = (m.conexiones / m.maxConexiones) * 100;
    if (pct >= u.conexionesAvisoPct) {
      alertas.push({
        clave: 'conexiones',
        gravedad: pct >= u.conexionesCriticoPct ? 'critico' : 'aviso',
        titulo: `Conexiones al ${Math.round(pct)} % (${m.conexiones} de ${m.maxConexiones})`,
        detalle: 'La base está cerca de no aceptar conexiones nuevas.',
      });
    }
  }

  // Sin ninguna purga registrada solo se alerta si la bitácora ya lleva más del
  // plazo midiendo: recién aplicada la migración, «nunca» es lo esperado.
  const referencia = m.ultimaPurgaAt ?? m.midiendoDesde;
  if (referencia) {
    const horas = (ahoraMs - new Date(referencia).getTime()) / HORA_MS;
    if (horas > u.purgaMaxHoras) {
      alertas.push({
        clave: 'purga',
        gravedad: 'critico',
        titulo: m.ultimaPurgaAt
          ? `Las purgas no corren desde hace ${Math.round(horas)} h`
          : 'Las purgas no han corrido nunca desde que se miden',
        detalle:
          'Dependen del plan diario de las 05:00. Revisa el sync-worker y lanza el plan a mano: POST /api/worker/enqueue?plan=diario.',
      });
    }
  }

  return alertas;
}

// ─── Recolección ─────────────────────────────────────────────────────────────

export interface TablaGrande {
  esquema: string;
  tabla: string;
  mb: number;
}

export type SaludBase =
  | { disponible: false; motivo: string }
  | {
      disponible: true;
      db_mb: number;
      conexiones: number;
      max_conexiones: number;
      ultima_purga_at: string | null;
      tablas: TablaGrande[];
      alertas: AlertaBase[];
      critico: boolean;
    };

/**
 * Anota una fila en `mantenimiento_log`. Nunca lanza: la bitácora no puede
 * tumbar ni la purga ni el healthcheck que la escriben.
 */
export async function registrarMantenimiento(
  // Mismo tipo laxo que el planner: recibe el cliente de la app y el del worker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  tipo: 'purga' | 'tamano',
  detalle: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await db.from('mantenimiento_log').insert({ tipo, detalle });
    if (error) console.error(`[salud-base] no se pudo registrar ${tipo}:`, error.message);
  } catch (e) {
    console.error(`[salud-base] no se pudo registrar ${tipo}:`, e);
  }
}

export async function medirSaludBase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  umbrales: UmbralesBase = umbralesDesdeEnv(),
  ahoraMs: number = Date.now()
): Promise<SaludBase> {
  const { data, error } = await db.rpc('salud_base');
  if (error || !data) {
    // Migración 101 sin aplicar, o la base no contesta: se declara, no se inventa.
    return { disponible: false, motivo: error?.message ?? 'salud_base() no devolvió datos' };
  }
  const crudo = data as {
    db_bytes: number;
    conexiones: number;
    max_conexiones: number;
    tablas: { esquema: string; tabla: string; bytes: number }[];
  };

  const haceVentana = new Date(ahoraMs - VENTANA_CRECIMIENTO_DIAS * 24 * HORA_MS).toISOString();
  const log = () => db.from('mantenimiento_log').select('ocurrido_at, detalle');
  const [purgaRes, primeraRes, anteriorRes, ultimaMuestraRes] = await Promise.all([
    log().eq('tipo', 'purga').order('ocurrido_at', { ascending: false }).limit(1).maybeSingle(),
    log().order('ocurrido_at', { ascending: true }).limit(1).maybeSingle(),
    log()
      .eq('tipo', 'tamano')
      .lte('ocurrido_at', haceVentana)
      .order('ocurrido_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    log().eq('tipo', 'tamano').order('ocurrido_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const fallo = [purgaRes, primeraRes, anteriorRes, ultimaMuestraRes].find((r) => r.error);
  if (fallo) return { disponible: false, motivo: fallo.error.message };

  const ultimaMuestraMs = ultimaMuestraRes.data
    ? new Date(ultimaMuestraRes.data.ocurrido_at).getTime()
    : 0;
  if (ahoraMs - ultimaMuestraMs > HORAS_ENTRE_MUESTRAS * HORA_MS) {
    await registrarMantenimiento(db, 'tamano', { bytes: crudo.db_bytes });
  }

  const bytesAnterior = Number(anteriorRes.data?.detalle?.bytes);
  const muestra: MuestraBase = {
    dbBytes: Number(crudo.db_bytes),
    conexiones: Number(crudo.conexiones),
    maxConexiones: Number(crudo.max_conexiones),
    ultimaPurgaAt: purgaRes.data?.ocurrido_at ?? null,
    // Si esta es la primera llamada, la muestra recién escrita es el origen.
    midiendoDesde: primeraRes.data?.ocurrido_at ?? null,
    tamanoAnterior:
      anteriorRes.data && Number.isFinite(bytesAnterior)
        ? { bytes: bytesAnterior, at: anteriorRes.data.ocurrido_at }
        : null,
  };
  const alertas = evaluarSaludBase(muestra, umbrales, ahoraMs);

  return {
    disponible: true,
    db_mb: mb(muestra.dbBytes),
    conexiones: muestra.conexiones,
    max_conexiones: muestra.maxConexiones,
    ultima_purga_at: muestra.ultimaPurgaAt,
    tablas: (crudo.tablas ?? []).map((t) => ({
      esquema: t.esquema,
      tabla: t.tabla,
      mb: mb(Number(t.bytes)),
    })),
    alertas,
    critico: alertas.some((a) => a.gravedad === 'critico'),
  };
}
