'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Filter,
  Check,
  Eye,
  Play,
  AlertTriangle,
  Loader2,
  Plus,
  Trash2,
  X,
  ChevronDown,
} from 'lucide-react';
import {
  CAMPOS_REGLA,
  ID_DUPLICADO,
  ID_SIN_ATRIBUCION,
  MOTIVOS_EXCLUSION,
  OPS_REGLA,
  type CampoRegla,
  type CondicionRegla,
  type OpRegla,
  type ReglaExclusion,
} from '@/lib/report-utm/lead-exclusion';
import type { ResultadoReclasificacion } from '@/lib/report-utm/lead-exclusion-db';
import type { ValorConteo, ValoresRegla } from '@/lib/report-utm/lead-regla-valores';
import { guardarReglaExclusionAction, reclasificarLeadsAction } from '@/app/(app)/leads/_actions';

function aLista(texto: string): string[] {
  return texto
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function nuevoId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Campos que se escriben (patrones), sin lista de valores. */
const CAMPOS_TEXTO: CampoRegla[] = ['email', 'telefono', 'nombre'];

/** Con `es` / `no es` se elige de la lista; con los de subcadena, se escribe. */
function usaLista(campo: CampoRegla, op: OpRegla): boolean {
  return (op === 'eq' || op === 'neq') && !CAMPOS_TEXTO.includes(campo);
}

const PISTA_OP: Partial<Record<OpRegla, string>> = {
  neq: 'también excluye los leads que no traen este dato',
  ncontains: 'también excluye los leads que no traen este dato',
};

const PLACEHOLDER: Partial<Record<CampoRegla, string>> = {
  email: '@fullyclub.agency, test',
  telefono: '3000000000',
  nombre: 'test, prueba',
};

/** Frase legible de una condición, para la previsualización. */
function describir(c: CondicionRegla): string {
  const campo = c.campo === 'respuesta' ? `«${c.clave}»` : CAMPOS_REGLA[c.campo].etiqueta;
  if (c.op === 'vacio') return `${campo} está vacío`;
  const vals = c.valores.map((v) => `«${v}»`);
  const txt =
    vals.length > 3 ? `${vals.slice(0, 3).join(', ')} y ${vals.length - 3} más` : vals.join(', ');
  return `${campo} ${OPS_REGLA[c.op]} ${txt}`;
}

/**
 * Regla de exclusión del cliente: qué leads NO cuentan en los informes.
 *
 * Nace de la reunión del 2026-09-08: en Cris Tributario entraban como leads los
 * contactos de WhatsApp directo y del perfil de Instagram, sin ninguna UTM, y
 * hundían el CPL. Los leads excluidos se guardan igual —se pueden ver y
 * re-incluir desde Leads—; simplemente no suman.
 *
 * Desde la v2 la regla es una lista de condiciones (si un lead cumple
 * cualquiera, no cuenta) cuyos valores se eligen de los que ya traen los leads
 * del cliente (`/api/report-utm/leads/regla-valores`).
 */
export function FiltroAtribucionCard({
  clienteId,
  inicial,
  migracionAplicada,
  migracionDuplicados = true,
}: {
  clienteId: string;
  inicial: ReglaExclusion;
  migracionAplicada: boolean;
  migracionDuplicados?: boolean;
}) {
  const [activa, setActiva] = useState(inicial.activa);
  const [exigir, setExigir] = useState(inicial.exigir_atribucion);
  const [duplicados, setDuplicados] = useState(inicial.excluir_duplicados);
  const [condiciones, setCondiciones] = useState<CondicionRegla[]>(inicial.condiciones);
  const [guardando, startGuardar] = useTransition();
  const [trabajando, startTrabajo] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [resultado, setResultado] = useState<ResultadoReclasificacion | null>(null);
  const [previsualizada, setPrevisualizada] = useState<ReglaExclusion | null>(null);

  const valores = useValoresRegla(clienteId);

  const regla: ReglaExclusion = {
    activa,
    exigir_atribucion: exigir,
    excluir_duplicados: duplicados,
    condiciones,
  };

  /** Cualquier cambio invalida lo previsualizado: «Aplicar» no puede ir a ciegas. */
  function tocar() {
    setResultado(null);
    setPrevisualizada(null);
    setGuardado(false);
  }

  function cambiarCondicion(id: string, cambio: Partial<CondicionRegla>) {
    tocar();
    setCondiciones((cs) => cs.map((c) => (c.id === id ? { ...c, ...cambio } : c)));
  }

  function anadir() {
    tocar();
    setCondiciones((cs) => [
      ...cs,
      { id: nuevoId(), campo: 'utm_campaign', op: 'eq', valores: [] },
    ]);
  }

  function quitar(id: string) {
    tocar();
    setCondiciones((cs) => cs.filter((c) => c.id !== id));
  }

  // Una condición sin valores se descartaría al guardar sin decir nada.
  const incompletas = condiciones.filter(
    (c) => (c.op !== 'vacio' && c.valores.length === 0) || (c.campo === 'respuesta' && !c.clave)
  );

  function guardar() {
    setError(null);
    setGuardado(false);
    setResultado(null);
    setPrevisualizada(null);
    startGuardar(async () => {
      const r = await guardarReglaExclusionAction(clienteId, regla);
      if (!r.ok) setError(r.error ?? 'No se pudo guardar.');
      else setGuardado(true);
    });
  }

  function previsualizar() {
    setError(null);
    const foto = regla;
    startTrabajo(async () => {
      // Siempre sobre la regla GUARDADA: se guarda primero para que la
      // previsualización no mienta sobre lo que hará el botón de aplicar.
      const g = await guardarReglaExclusionAction(clienteId, foto);
      if (!g.ok) {
        setError(g.error ?? 'No se pudo guardar la regla.');
        return;
      }
      const r = await reclasificarLeadsAction(clienteId, false);
      if (!r.ok) setError(r.error ?? 'No se pudo previsualizar.');
      else {
        setResultado(r.resultado ?? null);
        setPrevisualizada(foto);
      }
    });
  }

  function aplicar() {
    if (!previsualizada) return;
    setError(null);
    startTrabajo(async () => {
      const r = await reclasificarLeadsAction(clienteId, true, previsualizada);
      if (!r.ok) setError(r.error ?? 'No se pudo aplicar.');
      else setResultado(r.resultado ?? null);
    });
  }

  const totalExcluir = resultado
    ? Object.values(resultado.aExcluir).reduce((s, n) => s + (n ?? 0), 0)
    : 0;

  // Una línea por condición de la regla PREVISUALIZADA, en su orden.
  const lineasCondicion: Array<{ id: string; texto: string }> = [];
  const base = previsualizada ?? regla;
  if (resultado) {
    if (base.exigir_atribucion) {
      lineasCondicion.push({ id: ID_SIN_ATRIBUCION, texto: 'Sin atribución publicitaria' });
    }
    for (const c of base.condiciones) lineasCondicion.push({ id: c.id, texto: describir(c) });
    if (base.excluir_duplicados) {
      lineasCondicion.push({ id: ID_DUPLICADO, texto: 'Duplicados por email o teléfono' });
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-foreground">Qué leads cuentan</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Los leads que esta regla deja fuera se guardan igual —se ven en Leads y se pueden
            re-incluir—, pero no suman en el conteo, el CPL ni los informes. Basta con que un lead
            cumpla una condición para quedar fuera.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={activa}
            onChange={(e) => {
              tocar();
              setActiva(e.target.checked);
            }}
            className="accent-blue-500"
          />
          Regla activa
        </label>
      </div>

      {!migracionAplicada && (
        <Aviso>
          La regla se puede guardar, pero no se aplica hasta que se instale la migración 079 en la
          base. Hasta entonces todos los leads siguen contando.
        </Aviso>
      )}

      <div className={`space-y-3 ${activa ? '' : 'opacity-50 pointer-events-none'}`}>
        <Casilla
          checked={exigir}
          onChange={(v) => {
            tocar();
            setExigir(v);
          }}
          titulo="Exigir atribución publicitaria"
          detalle="Fuera los leads sin ninguna UTM de campaña, anuncio o conjunto ni click id: WhatsApp directo, perfil de Instagram, contactos creados a mano en el CRM."
        />
        <Casilla
          checked={duplicados}
          onChange={(v) => {
            tocar();
            setDuplicados(v);
          }}
          titulo="Excluir duplicados"
          detalle="Si el email o el teléfono ya entró antes en un lead que cuenta, el nuevo no suma. Cuenta el primero."
        />
        {duplicados && !migracionDuplicados && (
          <Aviso>
            Falta la migración 093 en la base: «Aplicar al histórico» marca los duplicados, pero los
            leads nuevos no se marcan al entrar hasta que se instale.
          </Aviso>
        )}

        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Condiciones de exclusión
            </p>
            <EstadoValores valores={valores} />
          </div>

          {condiciones.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              Sin condiciones. Añade una para dejar fuera leads por campaña, formulario, respuesta,
              etiqueta, país, medio o datos de contacto.
            </p>
          )}

          {condiciones.map((c) => (
            <FilaCondicion
              key={c.id}
              c={c}
              valores={valores.datos}
              onChange={(cambio) => cambiarCondicion(c.id, cambio)}
              onQuitar={() => quitar(c.id)}
            />
          ))}

          <button
            onClick={anadir}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border border-dashed border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Añadir condición
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Aparte de esto, la conexión GHL tiene su propio filtro de etiquetas: ese descarta el
          contacto antes de guardarlo (no queda rastro). Estas condiciones lo guardan marcado y se
          pueden deshacer.
        </p>
      </div>

      {incompletas.length > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {incompletas.length === 1 ? 'Hay una condición' : `Hay ${incompletas.length} condiciones`}{' '}
          sin valores (o sin pregunta): no se guardarán hasta completarlas.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={guardar}
          disabled={guardando || trabajando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-40"
        >
          {guardando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Guardar regla
        </button>
        <button
          onClick={previsualizar}
          disabled={!migracionAplicada || guardando || trabajando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent disabled:opacity-40"
        >
          {trabajando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
          Previsualizar sobre el histórico
        </button>
        {resultado &&
          previsualizada &&
          !resultado.aplicado &&
          (totalExcluir > 0 || resultado.aReincluir > 0) && (
            <button
              onClick={aplicar}
              disabled={trabajando}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-40"
            >
              <Play className="h-3 w-3" /> Aplicar al histórico
            </button>
          )}
        {guardado && (
          <span className="text-[11px] text-blue-600">
            Regla guardada. Se aplica a los leads que entren desde ahora.
          </span>
        )}
      </div>

      {resultado && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-foreground space-y-2">
          <p className="font-medium">
            {resultado.aplicado ? 'Aplicado' : 'Previsualización'} sobre{' '}
            {resultado.revisados.toLocaleString()} leads decididos automáticamente:
          </p>

          {lineasCondicion.length > 0 && (
            <ul className="space-y-1">
              {lineasCondicion.map((l) => {
                const k = resultado.porCondicion?.[l.id];
                return (
                  <li key={l.id}>
                    <details className="group">
                      <summary className="cursor-pointer list-none flex items-start gap-1.5">
                        <ChevronDown className="h-3 w-3 mt-0.5 shrink-0 transition-transform -rotate-90 group-open:rotate-0" />
                        <span>
                          <span className="font-medium">{l.texto}</span> —{' '}
                          {(k?.total ?? 0).toLocaleString()} leads
                          {k && k.nuevos > 0 && (
                            <span className="text-amber-600 dark:text-amber-400">
                              {' '}
                              ({k.nuevos.toLocaleString()}{' '}
                              {resultado.aplicado ? 'dejaron de contar' : 'dejarían de contar'})
                            </span>
                          )}
                        </span>
                      </summary>
                      {k && k.ejemplos.length > 0 ? (
                        <ul className="ml-5 mt-1 space-y-0.5 text-muted-foreground">
                          {k.ejemplos.map((e, i) => (
                            <li key={i}>
                              {[e.nombre, e.email, e.fecha?.slice(0, 10), e.formulario]
                                .filter(Boolean)
                                .join(' · ') || 'lead sin datos de contacto'}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="ml-5 mt-1 text-muted-foreground">No atrapa ningún lead.</p>
                      )}
                    </details>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-0.5 border-t border-border pt-2">
            {Object.entries(resultado.aExcluir).map(([m, n]) => (
              <p key={m}>
                · {n?.toLocaleString()} {resultado.aplicado ? 'excluidos' : 'se excluirían'} —{' '}
                {MOTIVOS_EXCLUSION[m as keyof typeof MOTIVOS_EXCLUSION] ?? m}
                {resultado.aplicado && (
                  <>
                    {' '}
                    <Link
                      href={`/leads?clienteId=${clienteId}&estado=excluidos&motivo=${m}`}
                      className="text-blue-600 hover:underline"
                    >
                      ver
                    </Link>
                  </>
                )}
              </p>
            ))}
            {resultado.aReincluir > 0 && (
              <p>
                · {resultado.aReincluir.toLocaleString()}{' '}
                {resultado.aplicado ? 'vuelven a contar' : 'volverían a contar'}
              </p>
            )}
            {resultado.yaExcluidos > 0 && (
              <p className="text-muted-foreground">
                · {resultado.yaExcluidos.toLocaleString()} ya estaban excluidos
              </p>
            )}
            {totalExcluir === 0 && resultado.aReincluir === 0 && (
              <p className="text-muted-foreground">Nada que cambiar.</p>
            )}
            <p className="text-muted-foreground">
              Los leads que alguien excluyó o re-incluyó a mano no se tocan.
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

// ── Piezas ───────────────────────────────────────────────────────────

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function Casilla({
  checked,
  onChange,
  titulo,
  detalle,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  titulo: string;
  detalle: string;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-blue-500 mt-0.5"
      />
      <span>
        <span className="font-medium">{titulo}</span>
        <span className="block text-muted-foreground text-[11px]">{detalle}</span>
      </span>
    </label>
  );
}

const CLASE_CONTROL =
  'px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/40';

function FilaCondicion({
  c,
  valores,
  onChange,
  onQuitar,
}: {
  c: CondicionRegla;
  valores: ValoresRegla | null;
  onChange: (cambio: Partial<CondicionRegla>) => void;
  onQuitar: () => void;
}) {
  const lista: ValorConteo[] | null = useMemo(() => {
    if (!valores) return null;
    if (c.campo === 'etiqueta') return valores.etiquetas;
    if (c.campo === 'respuesta') {
      return valores.preguntas.find((p) => p.clave === c.clave)?.valores ?? [];
    }
    if (CAMPOS_TEXTO.includes(c.campo)) return null;
    return valores.columnas[c.campo as keyof ValoresRegla['columnas']] ?? null;
  }, [valores, c.campo, c.clave]);

  function cambiarCampo(campo: CampoRegla) {
    // Email, teléfono y nombre se buscan por fragmento; el resto parte de «es»,
    // salvo que ya se hubiera elegido otro operador para un campo de lista.
    const op: OpRegla = CAMPOS_TEXTO.includes(campo)
      ? 'contains'
      : CAMPOS_TEXTO.includes(c.campo)
        ? 'eq'
        : c.op;
    onChange({ campo, clave: campo === 'respuesta' ? c.clave : undefined, op, valores: [] });
  }

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={c.campo}
          onChange={(e) => cambiarCampo(e.target.value as CampoRegla)}
          className={CLASE_CONTROL}
          aria-label="Campo"
        >
          {(Object.keys(CAMPOS_REGLA) as CampoRegla[]).map((k) => (
            <option key={k} value={k}>
              {CAMPOS_REGLA[k].etiqueta}
            </option>
          ))}
        </select>

        {c.campo === 'respuesta' && (
          <SelectorPregunta
            clave={c.clave ?? ''}
            valores={valores}
            onChange={(clave) => onChange({ clave, valores: [] })}
          />
        )}

        <select
          value={c.op}
          onChange={(e) => {
            const op = e.target.value as OpRegla;
            // Pasar de lista a texto (o al revés) con valores elegidos sería
            // mezclar dos significados: se conservan, que es lo menos sorprendente.
            onChange({ op, valores: op === 'vacio' ? [] : c.valores });
          }}
          className={CLASE_CONTROL}
          aria-label="Operador"
        >
          {(Object.keys(OPS_REGLA) as OpRegla[]).map((k) => (
            <option key={k} value={k}>
              {OPS_REGLA[k]}
            </option>
          ))}
        </select>

        <button
          onClick={onQuitar}
          className="ml-auto p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-accent"
          aria-label="Quitar condición"
          title="Quitar condición"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {c.op !== 'vacio' &&
        (usaLista(c.campo, c.op) && lista ? (
          <SelectorValores
            elegidos={c.valores}
            opciones={lista}
            onChange={(v) => onChange({ valores: v })}
          />
        ) : (
          <TextoValores
            key={`${c.campo}|${c.clave ?? ''}`}
            valores={c.valores}
            placeholder={PLACEHOLDER[c.campo] ?? 'separa varios valores con comas'}
            onChange={(v) => onChange({ valores: v })}
          />
        ))}

      {PISTA_OP[c.op] && <p className="text-[10px] text-muted-foreground">{PISTA_OP[c.op]}</p>}
    </div>
  );
}

function SelectorPregunta({
  clave,
  valores,
  onChange,
}: {
  clave: string;
  valores: ValoresRegla | null;
  onChange: (clave: string) => void;
}) {
  const preguntas = valores?.preguntas ?? [];
  if (preguntas.length === 0) {
    return (
      <input
        value={clave}
        onChange={(e) => onChange(e.target.value)}
        placeholder="nombre de la pregunta"
        className={`${CLASE_CONTROL} w-48`}
      />
    );
  }
  const conocida = preguntas.some((p) => p.clave === clave);
  return (
    <select
      value={conocida ? clave : ''}
      onChange={(e) => onChange(e.target.value)}
      className={`${CLASE_CONTROL} max-w-[16rem]`}
      aria-label="Pregunta"
    >
      <option value="" disabled>
        {clave && !conocida ? `${clave} (sin leads recientes)` : 'Elegí una pregunta'}
      </option>
      {preguntas.map((p) => (
        <option key={p.clave} value={p.clave}>
          {p.clave} ({p.n.toLocaleString()})
        </option>
      ))}
    </select>
  );
}

/**
 * Texto libre, separado por comas. Guarda lo tecleado tal cual (con la coma a
 * medio escribir) y entrega la lista limpia. Quien lo usa le pone una `key` que
 * cambia con el campo, así que un cambio de campo lo vuelve a montar vacío.
 */
function TextoValores({
  valores,
  placeholder,
  onChange,
}: {
  valores: string[];
  placeholder: string;
  onChange: (v: string[]) => void;
}) {
  const [texto, setTexto] = useState(valores.join(', '));
  return (
    <input
      value={texto}
      onChange={(e) => {
        setTexto(e.target.value);
        onChange(aLista(e.target.value));
      }}
      placeholder={placeholder}
      className={`${CLASE_CONTROL} w-full`}
    />
  );
}

/** Lista con búsqueda y recuento; lo elegido se ve como chips. */
function SelectorValores({
  elegidos,
  opciones,
  onChange,
}: {
  elegidos: string[];
  opciones: ValorConteo[];
  onChange: (v: string[]) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);

  const elegidosLower = new Set(elegidos.map((v) => v.toLowerCase()));
  const b = busqueda.trim().toLowerCase();
  const filtradas = opciones.filter((o) => !b || o.valor.toLowerCase().includes(b)).slice(0, 100);
  const conteo = new Map(opciones.map((o) => [o.valor.toLowerCase(), o.n]));

  function alternar(valor: string) {
    const k = valor.toLowerCase();
    onChange(
      elegidosLower.has(k) ? elegidos.filter((v) => v.toLowerCase() !== k) : [...elegidos, valor]
    );
  }

  // Lo tecleado que no está en la lista también se puede añadir: un valor que
  // todavía no ha llegado (una campaña que se lanza mañana) es legítimo.
  const puedeAnadirLibre =
    b.length > 0 && !opciones.some((o) => o.valor.toLowerCase() === b) && !elegidosLower.has(b);

  return (
    <div ref={caja} className="relative">
      <div
        className={`${CLASE_CONTROL} w-full min-h-[2rem] flex flex-wrap items-center gap-1 cursor-text`}
        onClick={() => setAbierto(true)}
      >
        {elegidos.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 text-[11px]"
          >
            {v}
            {conteo.has(v.toLowerCase()) && (
              <span className="text-muted-foreground">
                ({conteo.get(v.toLowerCase())?.toLocaleString()})
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                alternar(v);
              }}
              aria-label={`Quitar ${v}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={busqueda}
          onChange={(e) => {
            setBusqueda(e.target.value);
            setAbierto(true);
          }}
          onFocus={() => setAbierto(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && busqueda.trim()) {
              e.preventDefault();
              const exacta = opciones.find((o) => o.valor.toLowerCase() === b);
              alternar(exacta?.valor ?? busqueda.trim());
              setBusqueda('');
            }
          }}
          placeholder={elegidos.length === 0 ? 'Elegí valores de la lista…' : ''}
          className="flex-1 min-w-[8rem] bg-transparent outline-none text-xs"
        />
      </div>
      {abierto && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-border bg-popover shadow-lg p-1">
          {puedeAnadirLibre && (
            <button
              onClick={() => {
                alternar(busqueda.trim());
                setBusqueda('');
              }}
              className="w-full text-left px-2 py-1 rounded text-xs hover:bg-accent"
            >
              Añadir «{busqueda.trim()}»
            </button>
          )}
          {filtradas.length === 0 && !puedeAnadirLibre && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              {opciones.length === 0
                ? 'No hay valores en los leads de este cliente.'
                : 'Sin coincidencias.'}
            </p>
          )}
          {filtradas.map((o) => {
            const sel = elegidosLower.has(o.valor.toLowerCase());
            return (
              <button
                key={o.valor}
                onClick={() => alternar(o.valor)}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-accent ${sel ? 'font-medium text-blue-600' : 'text-foreground'}`}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <span className="w-3 shrink-0">{sel && <Check className="h-3 w-3" />}</span>
                  <span className="truncate">{o.valor}</span>
                </span>
                <span className="text-muted-foreground shrink-0">{o.n.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EstadoValores({ valores }: { valores: EstadoValoresRegla }) {
  if (valores.cargando) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> leyendo los leads del cliente…
      </span>
    );
  }
  if (valores.error) {
    return (
      <button onClick={valores.recargar} className="text-[10px] text-red-500 hover:underline">
        No se pudieron leer los valores (reintentar)
      </button>
    );
  }
  if (!valores.datos) return null;
  return (
    <span className="text-[10px] text-muted-foreground">
      Valores de {valores.datos.leidos.toLocaleString()} leads del último año
      {valores.datos.truncado ? ' (muestra)' : ''}
    </span>
  );
}

type EstadoValoresRegla = {
  datos: ValoresRegla | null;
  cargando: boolean;
  error: boolean;
  recargar: () => void;
};

function useValoresRegla(clienteId: string): EstadoValoresRegla {
  const [datos, setDatos] = useState<ValoresRegla | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  // `cargando` arranca en true y `recargar` lo vuelve a poner desde el clic: el
  // efecto solo pide y, cuando llega la respuesta, guarda.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/report-utm/leads/regla-valores?cliente_id=${encodeURIComponent(clienteId)}`, {
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setDatos((await r.json()) as ValoresRegla);
        setCargando(false);
      })
      .catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(true);
        setCargando(false);
      });
    return () => ctrl.abort();
  }, [clienteId, tick]);

  return {
    datos,
    cargando,
    error,
    recargar: () => {
      setCargando(true);
      setError(false);
      setTick((t) => t + 1);
    },
  };
}
