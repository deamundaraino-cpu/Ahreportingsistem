/**
 * Salud de las fuentes de datos, por cliente.
 *
 * ── Qué problema resuelve ────────────────────────────────────────────────
 * Un informe con una fuente muerta NO se ve roto: se ve vacío. Esa es la razón
 * de que estos tres fallos convivieran semanas sin que saltara nada:
 *
 *   · Meta Lead Ads de un cliente en estado de error desde hacía siete semanas,
 *     mientras sus leads seguían entrando por el píxel y el informe parecía lleno.
 *   · Un cliente ingiriendo la pestaña de Sheet de OTRO cliente.
 *   · Un cliente sin el enlace `public_cliente_id`, que deja el gasto, GA4,
 *     Hotmart, offline y los Sheets invisibles devolviendo cero en silencio.
 *
 * ── Por qué la evaluación es pura ────────────────────────────────────────
 * Recoger las señales necesita la base; decidir si algo está mal, no. Separarlo
 * permite comprobar las reglas —incluidas las que no se disparan hoy con ningún
 * cliente— sin depender de que la producción tenga un caso roto a mano.
 */

/** Gravedad, ordenada: lo que se muestra primero. */
export type Gravedad = 'critico' | 'aviso' | 'ok' | 'no_aplica';

export const ORDEN_GRAVEDAD: Record<Gravedad, number> = {
  critico: 0,
  aviso: 1,
  ok: 2,
  no_aplica: 3,
};

/** Señales crudas de un cliente. Todo lo que la evaluación necesita saber. */
export interface SenalesCliente {
  clienteId: string;
  nombre: string;
  /** El puente `report_utm.clientes.public_cliente_id`. */
  tienePuente: boolean;
  /** Hoy, en día calendario de Colombia (`YYYY-MM-DD`). */
  hoy: string;
  fuentes: SenalFuente[];
  integraciones: SenalIntegracion[];
  /** % de leads del período atados a una campaña real, o null si no hay leads. */
  pctLeadsCruzados: number | null;
  /** Filas de Sheet cuyo id de campaña no cruza con ningún anuncio del cliente. */
  sheetFilasAjenas?: { total: number; sinCruce: number } | null;
  /**
   * GA4 por separado de la fuente «Cuenta». Esa fuente tiene datos en cuanto
   * Meta sincroniza, así que un GA4 que NUNCA entregó una sesión pasaba por sano:
   * es lo que se vio en Cris Tributario (2026-09-12), con la propiedad
   * configurada, una página de pago mapeada y cero sesiones en toda su historia.
   */
  ga4?: SenalGa4 | null;
  /**
   * Último sync de cada Sheet habilitado. La fuente «Conversiones offline» solo
   * mira la última fecha con datos, y eso no ve un sync que corre en verde
   * descartando filas: del 1 al 14 de septiembre de 2026 la hoja de Somos
   * rentable perdió el mes entero por escribir "01/09/26", con la cola sana y
   * la fuente al día gracias a los datos de agosto.
   */
  sheetsSync?: SenalSheetSync[] | null;
}

export interface SenalGa4 {
  /** Última fecha con `ga_sessions > 0`, o null si nunca hubo. */
  ultimaSesion: string | null;
  /** Pestañas activas del cliente y cuántas tienen página de pago mapeada. */
  pestanas: number;
  pestanasConPago: number;
}

/** Último registro de `conversiones_offline_sync_log` de un Sheet. */
export interface SenalSheetSync {
  /** Nombre visible del sheet en la configuración del cliente. */
  nombre: string;
  status: 'ok' | 'partial' | 'error';
  /** Cuándo corrió (ISO). */
  runAt: string;
  filasOk: number;
  /** Filas con algo escrito en la fecha que no se pudo leer. */
  fechasInvalidas: number;
  /** Valores rechazados tal cual, para que el aviso diga qué corregir. */
  ejemplos: string[];
  error: string | null;
}

/**
 * Estado de lectura de una fuente.
 *
 * `desconocida` existe porque la alternativa es mentir. La primera versión de
 * este módulo trataba un error de consulta como «sin datos», y con eso un
 * cliente con 34.745 leads aparecía como «configurada pero sin un solo dato»:
 * el `count` exacto agotaba el `statement_timeout` y el error se tragaba. Un
 * panel de salud que inventa un fallo es peor que no tener panel.
 *
 * Misma doctrina que el resto de la plataforma: donde no se puede saber, se dice
 * que no se puede saber.
 */
export type EstadoFuente = 'con_datos' | 'vacia' | 'desconocida';

export interface SenalFuente {
  /** `leads` | `sales` | `ads` | `cuenta` | `offline` | `sheet` | `subs` */
  id: string;
  label: string;
  /** Última fecha con datos (`YYYY-MM-DD`), o null si no hay ninguno. */
  ultimaFecha: string | null;
  estado: EstadoFuente;
  /**
   * Días sin datos a partir de los cuales se considera parada.
   * Una fuente diaria (gasto) debería tener ayer; un Sheet que se vuelca a
   * mano tolera más. Sin este número por fuente, o se avisa en falso o no se
   * avisa nunca.
   */
  toleranciaDias: number;
  /** `false` si el cliente ni siquiera tiene esta integración configurada. */
  configurada: boolean;
  /** Necesita el puente para ser legible. */
  requierePuente: boolean;
}

export interface SenalIntegracion {
  tipo: string;
  status: string;
  ultimoError: string | null;
  /** Última sincronización correcta (ISO), o null. */
  ultimoSync: string | null;
}

/** Un problema concreto, ya redactado para que se pueda actuar sobre él. */
export interface Hallazgo {
  gravedad: Gravedad;
  /** Fuente o integración a la que apunta. */
  ambito: string;
  titulo: string;
  /** Qué hacer. Vacío si no hay una acción clara. */
  accion?: string;
}

export interface SaludCliente {
  clienteId: string;
  nombre: string;
  gravedad: Gravedad;
  hallazgos: Hallazgo[];
}

/** Días completos entre dos fechas `YYYY-MM-DD`. */
export function diasEntre(desde: string, hasta: string): number {
  const a = Date.parse(`${desde}T00:00:00Z`);
  const b = Date.parse(`${hasta}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400_000);
}

/**
 * Umbral por debajo del cual el cruce UTM↔campaña se considera roto.
 *
 * 50 % es deliberadamente permisivo: por debajo de eso la mitad del gasto no
 * tiene contactos atribuidos y ningún CPL por campaña significa nada. Los
 * clientes sanos medidos hoy están entre el 67 % y el 100 %, así que el umbral
 * no genera ruido; avisa cuando algo se ha degradado de verdad.
 */
export const UMBRAL_CRUCE = 50;

/** Proporción de filas de Sheet sin cruce que delata un Sheet equivocado. */
const UMBRAL_SHEET_AJENO = 0.9;

/**
 * Filas con fecha ilegible a partir de las cuales se avisa. Unas pocas son
 * erratas de quien llena el Sheet; decenas son un formato que cambió.
 */
export const UMBRAL_FECHAS_INVALIDAS = 10;

/** Días sin un sync de Sheet antes de avisar: el planificador lo encola dos veces al día. */
export const DIAS_SIN_SYNC_SHEET = 2;

export function evaluarCliente(s: SenalesCliente): SaludCliente {
  const hallazgos: Hallazgo[] = [];

  // ── El puente: la causa declarada de los ceros en silencio ───────
  // Va primero porque explica de golpe casi todo lo demás: sin él, cinco de
  // las siete fuentes son invisibles y el informe muestra cero sin decir nada.
  if (!s.tienePuente) {
    hallazgos.push({
      gravedad: 'critico',
      ambito: 'Enlace de cliente',
      titulo:
        'Sin enlace con el cliente de Reporting: gasto, GA4, Hotmart, offline y Sheets son invisibles.',
      accion:
        'Enlazar el cliente en /report-utm/clientes para que el informe pueda leer esas fuentes.',
    });
  }

  // ── Integraciones en error ───────────────────────────────────────
  for (const i of s.integraciones) {
    if (i.status !== 'error') continue;
    const dias = i.ultimoSync ? diasEntre(String(i.ultimoSync).slice(0, 10), s.hoy) : null;
    hallazgos.push({
      gravedad: 'critico',
      ambito: `Integración · ${i.tipo}`,
      titulo:
        dias !== null && dias > 0
          ? `En error desde hace ${dias} día(s): ${i.ultimoError ?? 'sin detalle'}`
          : `En error: ${i.ultimoError ?? 'sin detalle'}`,
      accion:
        i.tipo === 'meta_cuenta'
          ? 'Revisar el pago o el estado de la cuenta en el Administrador de anuncios de Meta.'
          : 'Reconectar la integración desde la ficha del cliente (Ajustes → Conexiones).',
    });
  }

  // ── Fuentes paradas o vacías ─────────────────────────────────────
  for (const f of s.fuentes) {
    // Una fuente que el cliente no usa no es un problema: decirlo sería
    // llenar el panel de ruido que nadie va a arreglar nunca.
    if (!f.configurada) continue;

    // Sin puente ya se ha avisado arriba; repetirlo por cada fuente
    // convertiría un problema en cinco.
    if (f.requierePuente && !s.tienePuente) continue;

    // No se pudo leer: se dice, y no se juzga. Presentarlo como «vacía»
    // convertiría un fallo de consulta en un fallo de integración inexistente.
    if (f.estado === 'desconocida') {
      hallazgos.push({
        gravedad: 'aviso',
        ambito: `Fuente · ${f.label}`,
        titulo: 'No se pudo comprobar el estado de esta fuente.',
        accion: 'Reintentar; si persiste, la consulta está agotando el tiempo límite.',
      });
      continue;
    }

    if (f.estado === 'vacia' || !f.ultimaFecha) {
      hallazgos.push({
        gravedad: 'critico',
        ambito: `Fuente · ${f.label}`,
        titulo: 'Configurada pero sin un solo dato.',
        accion: 'Revisar la conexión: está dada de alta pero nunca ha entregado.',
      });
      continue;
    }

    const dias = diasEntre(f.ultimaFecha, s.hoy);
    if (dias > f.toleranciaDias) {
      hallazgos.push({
        gravedad: dias > f.toleranciaDias * 3 ? 'critico' : 'aviso',
        ambito: `Fuente · ${f.label}`,
        titulo: `Sin datos nuevos desde hace ${dias} día(s) (último: ${f.ultimaFecha}).`,
        accion: 'Comprobar el sync de esta fuente.',
      });
    }
  }

  // ── Calidad del cruce ────────────────────────────────────────────
  // Es la métrica de la que depende todo lo demás: si los leads dejan de
  // atarse a su campaña, cada CPL y cada ROAS por campaña queda sin sentido, y
  // nada más en la plataforma lo vigila.
  if (s.pctLeadsCruzados !== null && s.pctLeadsCruzados < UMBRAL_CRUCE) {
    hallazgos.push({
      gravedad: 'aviso',
      ambito: 'Cruce UTM ↔ campaña',
      titulo: `Solo el ${s.pctLeadsCruzados.toFixed(1)} % de los leads se ata a una campaña real.`,
      accion: 'Revisar /cruce-campanas y añadir correcciones manuales donde falte.',
    });
  }

  // ── GA4 ──────────────────────────────────────────────────────────
  // La fuente «Cuenta» no sirve para vigilarlo: tiene datos en cuanto Meta
  // sincroniza. Aquí se mira GA4 por sí mismo — sesiones y página de pago.
  const ga = s.ga4;
  if (ga && s.tienePuente) {
    if (!ga.ultimaSesion) {
      hallazgos.push({
        gravedad: 'critico',
        ambito: 'Integración · GA4',
        titulo:
          'GA4 está configurado pero nunca ha entregado una sesión: visitas y pagos iniciados salen en 0.',
        accion:
          'Comprobar en Ajustes → cliente que la propiedad GA4 es la correcta y que la cuenta de Google de la agencia (o la cuenta de servicio) tiene acceso de lectura a ella.',
      });
    } else {
      const dias = diasEntre(ga.ultimaSesion, s.hoy);
      if (dias > TOLERANCIA_DIAS.cuenta) {
        hallazgos.push({
          gravedad: dias > TOLERANCIA_DIAS.cuenta * 3 ? 'critico' : 'aviso',
          ambito: 'Integración · GA4',
          titulo: `GA4 sin sesiones desde hace ${dias} día(s) (última: ${ga.ultimaSesion}).`,
          accion: 'Revisar el acceso a la propiedad GA4 y el log de /admin/sync.',
        });
      }
    }
    if (ga.pestanas > 0 && ga.pestanasConPago === 0) {
      hallazgos.push({
        gravedad: 'aviso',
        ambito: 'Integración · GA4',
        titulo:
          'Ninguna pestaña tiene la página de pago mapeada: los pagos iniciados (GA4) no se miden.',
        accion:
          'En el dashboard del cliente → configurar pestaña → embudo Hotmart: poner la URL o el título de la página de pago tal como aparece en GA4.',
      });
    }
  }

  // ── Sheet de otro cliente ────────────────────────────────────────
  // Un Sheet propio cruza casi entero; uno ajeno no cruza nada. El caso real
  // que motivó esta regla: un cliente ingiriendo la pestaña de otro, con sus
  // 2.105 «leads offline» pertenecientes a un tercero.
  const sh = s.sheetFilasAjenas;
  if (sh && sh.total >= 50 && sh.sinCruce / sh.total >= UMBRAL_SHEET_AJENO) {
    hallazgos.push({
      gravedad: 'critico',
      ambito: 'Fuente · Sheet',
      titulo: `${sh.sinCruce} de ${sh.total} filas no cruzan con ninguna campaña de este cliente: el Sheet podría ser de otro.`,
      accion: 'Comprobar qué documento está conectado en la configuración del cliente.',
    });
  }

  // ── Sync de los Sheets ───────────────────────────────────────────
  // La fuente «Conversiones offline» mira la última fecha con datos; esto mira
  // el sync en sí: si falla, si dejó de correr o si está descartando filas.
  if (s.tienePuente) {
    for (const sy of s.sheetsSync ?? []) {
      const ambito = `Sync de Sheet · ${sy.nombre}`;
      if (sy.status === 'error') {
        hallazgos.push({
          gravedad: 'critico',
          ambito,
          titulo: `El último sync falló: ${sy.error ?? 'sin detalle'}`,
          accion:
            'Revisar el documento y sus pestañas en Ajustes del cliente → Google Sheets y lanzar «Sincronizar».',
        });
      }
      const dias = diasEntre(sy.runAt.slice(0, 10), s.hoy);
      if (dias > DIAS_SIN_SYNC_SHEET) {
        hallazgos.push({
          gravedad: 'aviso',
          ambito,
          titulo: `No se sincroniza desde hace ${dias} día(s).`,
          accion:
            'Comprobar la cola en /admin/sync: el planificador encola los Sheets dos veces al día.',
        });
      }
      if (sy.fechasInvalidas >= UMBRAL_FECHAS_INVALIDAS) {
        const ej =
          sy.ejemplos.length > 0 ? ` (p. ej. ${sy.ejemplos.map((e) => `"${e}"`).join(', ')})` : '';
        hallazgos.push({
          gravedad: 'aviso',
          ambito,
          titulo: `${sy.fechasInvalidas} filas descartadas por una fecha que no se entiende${ej}.`,
          accion:
            'Corregir la columna de fecha en el Sheet (DD/MM/AAAA o AAAA-MM-DD) o revisar qué columna está configurada como fecha.',
        });
      }
    }
  }

  const gravedad: Gravedad = hallazgos.some((h) => h.gravedad === 'critico')
    ? 'critico'
    : hallazgos.some((h) => h.gravedad === 'aviso')
      ? 'aviso'
      : 'ok';

  hallazgos.sort((a, b) => ORDEN_GRAVEDAD[a.gravedad] - ORDEN_GRAVEDAD[b.gravedad]);

  return { clienteId: s.clienteId, nombre: s.nombre.trim(), gravedad, hallazgos };
}

/** Ordena los clientes por gravedad: lo que hay que mirar primero, primero. */
export function ordenarPorGravedad(cs: SaludCliente[]): SaludCliente[] {
  return [...cs].sort(
    (a, b) =>
      ORDEN_GRAVEDAD[a.gravedad] - ORDEN_GRAVEDAD[b.gravedad] ||
      b.hallazgos.length - a.hallazgos.length ||
      a.nombre.localeCompare(b.nombre)
  );
}

/**
 * Tolerancias por fuente, en días sin datos antes de avisar.
 *
 * Salen del ritmo real de cada una, no de un número redondo: el gasto lo escribe
 * el worker cada día, así que dos días de silencio ya es un fallo; un Sheet que
 * alguien actualiza a mano puede pasar una semana sin tocarse sin que pase nada.
 */
export const TOLERANCIA_DIAS: Record<string, number> = {
  ads: 2,
  cuenta: 2,
  leads: 3,
  sales: 30,
  offline: 7,
  sheet: 7,
  subs: 7,
  // La escribe el worker a diario en cuanto hay credenciales de Hotmart: dos
  // días de silencio ya es un fallo. Muy distinta de `sales`, cuya tolerancia
  // de 30 días existe porque depende de un webhook que puede no estar puesto.
  hotmart: 2,
};
