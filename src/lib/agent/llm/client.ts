import 'server-only';

/**
 * Cliente de OpenRouter.
 *
 * Se habla con la API por `fetch` directo y no con un SDK: es un único POST a
 * `/chat/completions`, y los parámetros propios de OpenRouter (`models`,
 * `route`, `provider`) tampoco están tipados en el SDK de OpenAI. Una
 * dependencia menos es un riesgo menos sobre el build.
 *
 * Tres tiers, cada uno con un modelo primario y una cadena de reserva:
 *
 *   · `nano`  — tareas de texto sin herramientas: clasificar la intención,
 *               redactar la respuesta final, resumir el historial.
 *   · `work`  — subagentes de catálogo, operaciones y administración.
 *   · `power` — orquestador y análisis.
 *
 * Regla que no se salta: **el tier `nano` nunca recibe herramientas.** Los
 * modelos gratuitos rotan sin aviso, se saturan en horas punta y su soporte de
 * `tool_calls` es irregular. Una llamada mal formada en mitad de un bucle de
 * herramientas es un fallo silencioso caro de encontrar; para texto plano, en
 * cambio, son perfectamente buenos y es donde de verdad ahorran.
 */

import { logger } from '@/lib/error-handler';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export type Tier = 'nano' | 'work' | 'power';

export type PoliticaTier = {
  primary: string;
  /** Se envían como `models[]` con `route: 'fallback'`. */
  fallbacks: string[];
  maxTokens: number;
  /** `false` en `nano`. */
  allowTools: boolean;
};

/**
 * Política por defecto.
 *
 * Los identificadores concretos NO se fijan en el código de forma definitiva:
 * el catálogo de OpenRouter cambia solo y los modelos gratuitos entran y salen.
 * `system_settings` los sobreescribe (claves `agent_tier_nano`, `agent_tier_work`
 * y `agent_tier_power`), así que cambiar de modelo no exige desplegar.
 */
export const POLITICA_POR_DEFECTO: Record<Tier, PoliticaTier> = {
  nano: {
    primary: 'openrouter/free',
    fallbacks: ['qwen/qwen3.7-flash', 'google/gemini-2.5-flash-lite'],
    maxTokens: 2048,
    allowTools: false,
  },
  work: {
    primary: 'google/gemini-3.5-flash-lite',
    fallbacks: ['minimax/minimax-m3', 'deepseek/deepseek-v4-flash-latest'],
    maxTokens: 8192,
    allowTools: true,
  },
  power: {
    primary: 'anthropic/claude-sonnet-5',
    fallbacks: ['x-ai/grok-4.6', 'google/gemini-3.1-pro-preview'],
    maxTokens: 16384,
    allowTools: true,
  },
};

export type MensajeLlm =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type DefinicionTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type RespuestaLlm = {
  contenido: string | null;
  toolCalls: { id: string; nombre: string; argumentos: string }[];
  finishReason: string;
  /** El modelo que respondió DE VERDAD, que puede no ser el primario. */
  modelo: string;
  uso: {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
  };
};

/** Lee la política de un tier, con `system_settings` por encima del defecto. */
export async function leerPolitica(
  db: {
    from: (t: string) => {
      select: (c: string) => {
        eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> };
      };
    };
  },
  tier: Tier
): Promise<PoliticaTier> {
  const base = POLITICA_POR_DEFECTO[tier];
  try {
    const { data } = await db
      .from('system_settings')
      .select('value')
      .eq('key', `agent_tier_${tier}`)
      .maybeSingle();

    const valor = (data as { value?: unknown } | null)?.value;
    if (valor && typeof valor === 'object') {
      const v = valor as Partial<PoliticaTier>;
      return {
        primary: v.primary ?? base.primary,
        fallbacks: Array.isArray(v.fallbacks) ? v.fallbacks : base.fallbacks,
        maxTokens: typeof v.maxTokens === 'number' ? v.maxTokens : base.maxTokens,
        // `nano` no recibe herramientas ni aunque la configuración lo pida.
        allowTools: tier === 'nano' ? false : (v.allowTools ?? base.allowTools),
      };
    }
  } catch {
    // Sin configuración se usa el defecto; no es motivo para fallar.
  }
  return base;
}

export class ErrorLlm extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ErrorLlm';
  }
}

/**
 * Familias que necesitan `cache_control` explícito.
 *
 * En OpenAI, DeepSeek, Groq y Gemini la caché es automática. En Anthropic y
 * Qwen hay que marcarla, y sin marcarla el prefijo se paga entero en cada turno.
 */
function requiereCacheExplicita(modelo: string): boolean {
  return modelo.startsWith('anthropic/') || modelo.startsWith('qwen/');
}

/**
 * Marca el bloque de sistema como cacheable cuando el modelo lo requiere.
 *
 * Solo el primer mensaje de sistema: es la parte estable del prompt (catálogo
 * de herramientas y contexto del cliente) y va delante de todo lo variable.
 */
function aplicarCache(mensajes: MensajeLlm[], modelo: string): unknown[] {
  if (!requiereCacheExplicita(modelo)) return mensajes;

  return mensajes.map((m, i) => {
    if (i === 0 && m.role === 'system') {
      return {
        role: 'system',
        content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
      };
    }
    return m;
  });
}

export type OpcionesLlamada = {
  tier: Tier;
  mensajes: MensajeLlm[];
  tools?: DefinicionTool[];
  politica?: PoliticaTier;
  temperatura?: number;
  señal?: AbortSignal;
};

/**
 * Una llamada al modelo.
 *
 * La cadena de reserva la resuelve OpenRouter: si el primario falla o está
 * saturado, salta al siguiente dentro de la MISMA petición. `response.model`
 * dice cuál respondió, y se guarda — un salto silencioso a un modelo peor
 * explicaría una respuesta mala que de otro modo sería un misterio.
 */
export async function llamarLlm(opts: OpcionesLlamada): Promise<RespuestaLlm> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ErrorLlm('Falta OPENROUTER_API_KEY. El agente no puede responder sin ella.', 500);
  }

  const politica = opts.politica ?? POLITICA_POR_DEFECTO[opts.tier];

  const cuerpo: Record<string, unknown> = {
    model: politica.primary,
    max_tokens: politica.maxTokens,
    messages: aplicarCache(opts.mensajes, politica.primary),
  };

  if (politica.fallbacks.length > 0) {
    cuerpo.models = politica.fallbacks;
    cuerpo.route = 'fallback';
  }
  if (typeof opts.temperatura === 'number') cuerpo.temperature = opts.temperatura;

  // La guarda que evita el fallo más caro de diagnosticar.
  if (opts.tools?.length && politica.allowTools) {
    cuerpo.tools = opts.tools;
    cuerpo.tool_choice = 'auto';
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Así atribuye OpenRouter el tráfico a la aplicación.
      'HTTP-Referer': process.env.OPENROUTER_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE ?? 'AdsHouse Reporting',
    },
    body: JSON.stringify(cuerpo),
    signal: opts.señal,
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new ErrorLlm(`OpenRouter devolvió ${res.status}: ${texto.slice(0, 400)}`, res.status);
  }

  const json = (await res.json()) as {
    model?: string;
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: {
      cost?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string };
  };

  if (json.error) {
    throw new ErrorLlm(json.error.message ?? 'Error de OpenRouter');
  }

  const choice = json.choices?.[0];
  if (!choice) throw new ErrorLlm('OpenRouter no devolvió ninguna respuesta.');

  const modelo = json.model ?? politica.primary;
  if (modelo !== politica.primary) {
    logger.warn('El modelo primario no respondió; contestó un modelo de reserva', {
      tier: opts.tier,
      esperado: politica.primary,
      real: modelo,
    });
  }

  return {
    contenido: choice.message?.content ?? null,
    toolCalls: (choice.message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      nombre: tc.function.name,
      // Llega como cadena JSON, nunca como objeto.
      argumentos: tc.function.arguments,
    })),
    finishReason: choice.finish_reason ?? 'stop',
    modelo,
    uso: {
      costUsd: json.usage?.cost ?? 0,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      tokensCached: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}
