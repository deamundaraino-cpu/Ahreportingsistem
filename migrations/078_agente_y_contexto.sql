-- ============================================================================
-- 078 · Capa de contexto de cliente y tablas del agente
--
-- Dos bloques que llegan juntos porque el segundo no sirve sin el primero:
--
--   A) CONTEXTO. Qué mide cada tipo de estrategia, hasta dónde llega la
--      medición de cada cliente, y qué estrategia lleva cada pestaña. Sin esto,
--      un análisis automático lee métricas puras y concluye cosas como que
--      "faltan los datos de Google Analytics" en un cliente que nunca tuvo
--      Google Analytics porque no vende por la plataforma.
--
--   B) AGENTE. Contactos autorizados, conversaciones, cola de turnos,
--      propuestas de escritura pendientes de aprobación y registro de
--      auditoría.
--
-- Idempotente: se puede aplicar dos veces sin efecto.
--
-- ── DDL efectivo de `cliente_tabs` (reconstruido, no versionado) ────────────
--
-- Esta tabla se altera más abajo y su CREATE TABLE no está en ninguna
-- migración: llegó por la consola de Supabase y desde entonces ocho
-- migraciones le han añadido columnas. Se deja aquí constancia del estado real
-- comprobado el 2026-08-30, siguiendo lo que hizo la migración 077 con
-- `campaign_groups`. NO se recrea: solo se documenta.
--
--   id                    uuid          PK
--   cliente_id            uuid          FK public.clientes
--   nombre                text
--   keyword_meta          text          -- filtro de campañas; puede llevar el
--                                       -- prefijo `__cf:` con JSON compuesto
--   plantilla_id          uuid          -- layout asignado
--   columnas              jsonb[]       -- visualización
--   tarjetas              jsonb[]
--   graficos              jsonb[]
--   tablas                jsonb[]
--   text_blocks           jsonb[]
--   custom_metrics        jsonb[]
--   ranking_tables        jsonb[]       -- migr. 018
--   blocks_order          jsonb[]
--   lead_answer_blocks    jsonb
--   hotmart_funnel        jsonb         -- migr. 008
--   orden                 integer
--   position              integer       -- migr. 001
--   fecha_inicio          date
--   fecha_finalizacion    date
--   presupuesto_objetivo  numeric
--   public_token          text          -- migr. 006
--   archived              boolean       -- migr. 015
--   alert_email           text
--   alert_sent_at_90      timestamptz
--   alert_sent_at_100     timestamptz
--   created_at            timestamptz
--   updated_at            timestamptz
--
-- Igual de indocumentadas: `user_profiles` (id, role, full_name, updated_at) y
-- `user_client_assignments` (id, user_id, client_id, assigned_by, created_at).
--
-- Las tablas nuevas activan RLS SIN políticas, como la 075 y la 077: todo el
-- acceso va con el service role, que se las salta, y así queda cerrado el
-- acceso anónimo por PostgREST.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- A · CONTEXTO
-- ────────────────────────────────────────────────────────────────────────────

-- Catálogo GLOBAL de tipos de estrategia. Se define una vez para toda la
-- agencia; cuando entra un vertical nuevo se añade una fila y ningún cliente
-- necesita tocarse.
CREATE TABLE IF NOT EXISTS public.estrategia_tipos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria TEXT NOT NULL,            -- 'lanzamiento' | 'evergreen' | …
  subcategoria TEXT NOT NULL,         -- 'captacion'   | 'infoproducto' | …
  nombre TEXT NOT NULL,
  descripcion TEXT,

  -- Hasta dónde llega la medición de este tipo. Es lo que evita pedir un ROAS
  -- en una estrategia que solo capta leads y luego reportar su ausencia como
  -- un problema.
  alcance TEXT NOT NULL DEFAULT 'hasta_lead'
    CHECK (alcance IN ('hasta_lead', 'hasta_venta')),

  -- Un lanzamiento tiene principio y fin; un evergreen no. Cambia por completo
  -- cómo se lee una caída de inversión al final del periodo.
  temporal BOOLEAN NOT NULL DEFAULT false,

  metricas_clave TEXT[] NOT NULL DEFAULT '{}',
  -- Métricas que NO aplican a este tipo: no son un dato que falte.
  metricas_na TEXT[] NOT NULL DEFAULT '{}',
  guia TEXT,

  activo BOOLEAN NOT NULL DEFAULT true,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (categoria, subcategoria)
);

-- Perfil de cliente: lo que un trafficker explicaría de viva voz antes de que
-- alguien mire sus números.
CREATE TABLE IF NOT EXISTS public.cliente_perfiles (
  cliente_id UUID PRIMARY KEY REFERENCES public.clientes(id) ON DELETE CASCADE,
  descripcion TEXT,
  productos TEXT,
  alcance_medicion TEXT,
  fuentes_activas TEXT[] NOT NULL DEFAULT '{}',
  -- Fuentes que este cliente NO tiene por diseño. Reportarlas como carencia es
  -- el error que hacía inútil el análisis automático.
  fuentes_ausentes TEXT[] NOT NULL DEFAULT '{}',
  instrucciones TEXT,
  actualizado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- Correcciones que el equipo le da al agente. Aprendizaje explícito y
-- auditable: se lee, se edita y se desactiva desde el panel.
CREATE TABLE IF NOT EXISTS public.agent_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE,  -- NULL = global
  tab_id UUID,
  texto TEXT NOT NULL,
  autor UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- Estrategia de cada pestaña. Las fechas y el presupuesto ya existían.
ALTER TABLE public.cliente_tabs
  ADD COLUMN IF NOT EXISTS estrategia_tipo_id UUID REFERENCES public.estrategia_tipos(id) ON DELETE SET NULL;

-- Metas propias de la pestaña; anulan las del cliente. Mismo shape que
-- `ClienteGoals` (cpl_max, cpa_max, roas_min, leads_target, budget) para que
-- `evaluateGoal()` sirva sin cambios y el criterio del agente sea el mismo que
-- el de los semáforos de la interfaz.
ALTER TABLE public.cliente_tabs
  ADD COLUMN IF NOT EXISTS metas JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cliente_tabs_estrategia
  ON public.cliente_tabs (estrategia_tipo_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_cliente
  ON public.agent_feedback (cliente_id) WHERE activo;

-- ── Semilla: las cuatro combinaciones que se usan hoy ───────────────────────
INSERT INTO public.estrategia_tipos
  (categoria, subcategoria, nombre, alcance, temporal, metricas_clave, metricas_na, guia, orden)
VALUES
  ('evergreen', 'captacion', 'Evergreen de captación', 'hasta_lead', false,
   ARRAY['meta_spend','meta_leads','meta_cpl','meta_ctr'],
   ARRAY['meta_roas','ventas_principal','hotmart_pagos_iniciados','ga_sessions'],
   'Capta leads de forma continua, sin fecha de fin. Se juzga por volumen de leads y CPL sostenidos en el tiempo, y por la estabilidad de la entrega. No hay ventas que medir: el ROAS no aplica y su ausencia no es un problema que reportar.',
   1),

  ('evergreen', 'infoproducto', 'Evergreen de infoproducto', 'hasta_venta', false,
   ARRAY['meta_spend','meta_leads','meta_cpl','ventas_principal','meta_roas'],
   ARRAY[]::TEXT[],
   'Vende todos los días y se mide del anuncio a la compra. Aquí sí hay control completo del embudo, así que el ROAS y el coste por compra son los indicadores principales.',
   2),

  ('lanzamiento', 'captacion', 'Lanzamiento de captación', 'hasta_lead', true,
   ARRAY['meta_spend','meta_leads','meta_cpl'],
   ARRAY['meta_roas','ventas_principal'],
   'Capta registros para un evento con fecha. Tiene principio y fin, así que la inversión se concentra y cae al acercarse el cierre: esa caída es el plan, no un problema. Las ventas, si las hay, llegan después y por fuera de la plataforma.',
   3),

  ('lanzamiento', 'infoproducto', 'Lanzamiento de infoproducto', 'hasta_venta', true,
   ARRAY['meta_spend','meta_leads','meta_cpl','ventas_principal','meta_roas','hotmart_pagos_iniciados'],
   ARRAY[]::TEXT[],
   'Del anuncio al evento y a la compra, en una ventana con fecha. Se mide el embudo completo, pero comparar contra el periodo anterior engaña: la fase de captación y la de venta tienen cifras que no son comparables entre sí.',
   4)
ON CONFLICT (categoria, subcategoria) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- B · AGENTE
-- ────────────────────────────────────────────────────────────────────────────

-- Contactos autorizados. El nivel es independiente del rol de la aplicación:
-- sirve para RESTRINGIR, nunca para ampliar. El nivel efectivo es el mínimo
-- entre el del contacto, el del canal y el que permite su rol.
CREATE TABLE IF NOT EXISTS public.agent_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  level TEXT NOT NULL DEFAULT 'consulta'
    CHECK (level IN ('consulta', 'operador', 'aprobador', 'admin')),
  -- Acota los clientes por debajo de sus asignaciones. NULL = sin recorte.
  client_scope UUID[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (user_id)
);

-- Identidades de un contacto en cada canal.
--
-- Tabla aparte y no una columna porque WhatsApp identifica a la misma persona
-- de dos formas: el número (`<n>@s.whatsapp.net`) en privado y un LID (`@lid`)
-- opaco dentro de los grupos. Resolver un LID de vuelta al número NO está
-- garantizado, así que dar de alta solo el número deja al contacto sin
-- reconocer en los grupos — funciona en privado y falla en grupo, que es un
-- síntoma desconcertante.
CREATE TABLE IF NOT EXISTS public.agent_contact_identities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES public.agent_contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  kind TEXT NOT NULL CHECK (kind IN ('pn', 'lid')),
  external_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (channel, external_id)
);

-- Canales (grupos y privados) donde el agente puede operar. Nace deshabilitado:
-- que alguien añada el bot a un grupo no debe bastar para que empiece a
-- responder ahí.
CREATE TABLE IF NOT EXISTS public.agent_channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('group', 'dm')),
  nombre TEXT,
  -- Techo de permisos de este canal. Un admin que escribe en un grupo marcado
  -- como 'consulta' no ejecuta nada desde ahí.
  max_level TEXT NOT NULL DEFAULT 'consulta'
    CHECK (max_level IN ('consulta', 'operador', 'aprobador', 'admin')),
  -- Fija el canal a un solo cliente, para grupos de cliente.
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  require_mention BOOLEAN NOT NULL DEFAULT true,
  -- Modo aprendizaje: registra quién escribe sin invocar al agente, para poder
  -- vincular identidades desde el panel.
  learning_mode BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (channel, external_id)
);

-- Remitentes vistos en modo aprendizaje, pendientes de vincular a un contacto.
CREATE TABLE IF NOT EXISTS public.whatsapp_seen_senders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id UUID REFERENCES public.agent_channels(id) ON DELETE CASCADE,
  lid TEXT,
  participant_pn TEXT,
  push_name TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  linked_contact_id UUID REFERENCES public.agent_contacts(id) ON DELETE SET NULL,
  UNIQUE (channel_id, lid)
);

-- Deduplicación de mensajes entrantes: Baileys reentrega tras reconectar y sin
-- esto el agente respondería dos veces al mismo mensaje.
CREATE TABLE IF NOT EXISTS public.whatsapp_inbound_messages (
  message_id TEXT PRIMARY KEY,
  chat_id TEXT,
  participant TEXT,
  recibido_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.agent_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'web',
  external_id TEXT,
  contact_id UUID REFERENCES public.agent_contacts(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  titulo TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.agent_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content JSONB,
  tool_calls JSONB,
  tool_call_id TEXT,
  -- Qué modelo respondió DE VERDAD. Con una cadena de fallback, un salto
  -- silencioso a un modelo peor explicaría una respuesta mala que de otro modo
  -- sería un misterio.
  model_used TEXT,
  tier TEXT,
  cost_usd NUMERIC,
  tokens_in INTEGER,
  tokens_cached INTEGER,
  tokens_out INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conv
  ON public.agent_messages (conversation_id, created_at);

-- Cola de turnos. Calcada de `sync_jobs` (migración 051), que ya resuelve bien
-- el reparto entre trabajadores y la recuperación de huérfanos.
CREATE TABLE IF NOT EXISTS public.agent_turns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
  entrada TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pending'
    CHECK (estado IN ('pending', 'running', 'done', 'error', 'cancelled')),
  -- Estado parcial: un turno se ejecuta a trozos para no chocar con el tiempo
  -- máximo de una función serverless.
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  iteraciones INTEGER NOT NULL DEFAULT 0,
  intentos INTEGER NOT NULL DEFAULT 0,
  max_intentos INTEGER NOT NULL DEFAULT 3,
  prioridad INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  respuesta TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_agent_turns_queue
  ON public.agent_turns (estado, prioridad, created_at);

-- Un turno en vuelo por conversación: dos respuestas simultáneas en el mismo
-- chat se pisarían el contexto.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_turns_conv_activa
  ON public.agent_turns (conversation_id)
  WHERE estado IN ('pending', 'running');

-- Propuestas de escritura. El agente no ejecuta: propone.
CREATE TABLE IF NOT EXISTS public.agent_action_approvals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'high')),
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'ejecutada', 'expirada')),
  requested_by UUID,
  approved_by UUID,
  conversation_id UUID REFERENCES public.agent_conversations(id) ON DELETE SET NULL,
  origin TEXT,
  result JSONB,
  error TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),

  -- Nadie aprueba lo suyo. En la base y no solo en el código: una instrucción
  -- en un prompt se puede convencer, una restricción de la base no.
  CONSTRAINT chk_aprobador_distinto
    CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by)
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_pendientes
  ON public.agent_action_approvals (status, created_at DESC);

-- Auditoría de TODA invocación, lecturas incluidas. El servidor MCP no dejaba
-- ningún rastro de quién consultaba qué.
CREATE TABLE IF NOT EXISTS public.agent_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input JSONB,
  ok BOOLEAN NOT NULL,
  error TEXT,
  duration_ms INTEGER,
  origin TEXT,
  user_id UUID,
  token_id UUID,
  conversation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_reciente
  ON public.agent_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_tool
  ON public.agent_audit_log (tool_name, created_at DESC);

-- Límites de uso. En Postgres y no en memoria: los contadores en memoria no se
-- coordinan entre invocaciones serverless, como ya advierte `lib/rate-limit.ts`.
CREATE TABLE IF NOT EXISTS public.agent_rate_limits (
  subject_key TEXT NOT NULL,
  ventana TIMESTAMPTZ NOT NULL,
  peticiones INTEGER NOT NULL DEFAULT 0,
  coste_usd NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_key, ventana)
);

-- ── Reclamo de turnos ───────────────────────────────────────────────────────
--
-- `FOR UPDATE SKIP LOCKED` reparte entre varios trabajadores sin bloquearse
-- entre sí. La condición del lease vencido recupera los turnos de un proceso
-- que murió a media ejecución, sin necesidad de un barrido aparte.
CREATE OR REPLACE FUNCTION public.claim_agent_turn(p_worker TEXT, p_lease_seconds INT DEFAULT 120)
RETURNS SETOF public.agent_turns
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.agent_turns
  SET estado = 'running',
      locked_at = now(),
      locked_by = p_worker,
      intentos = intentos + 1,
      updated_at = now()
  WHERE id = (
    SELECT id FROM public.agent_turns
    WHERE estado = 'pending'
       OR (estado = 'running' AND locked_at < now() - make_interval(secs => p_lease_seconds::double precision))
    ORDER BY prioridad ASC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

-- ── RLS: activada sin políticas ────────────────────────────────────────────
ALTER TABLE public.estrategia_tipos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cliente_perfiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_seen_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_rate_limits ENABLE ROW LEVEL SECURITY;
