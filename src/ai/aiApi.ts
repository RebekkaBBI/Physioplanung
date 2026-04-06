/**
 * ============================================================================
 * YELLOW_AI — API-Schnittstelle für KI-Interaktion (OpenAI-kompatibles Chat)
 * Im Projekt suchen: YELLOW_AI
 *
 * Konfiguration (optional, Vite): .env mit
 *   VITE_AI_BASE_URL   z. B. https://api.openai.com/v1
 *   VITE_AI_API_KEY    Bearer-Token (nur clientseitig; Produktion: eigener Proxy!)
 *   VITE_AI_MODEL      z. B. gpt-4o-mini
 *
 * Ohne .env: baseUrl/apiKey leer → Aufruf wirft hilfreichen Fehler.
 * ============================================================================
 */

export type AiRole = 'system' | 'user' | 'assistant'

export type AiMessage = { role: AiRole; content: string }

export type AiClientConfig = {
  /** Basis-URL inkl. /v1 o. Ä., z. B. https://api.openai.com/v1 */
  baseUrl: string
  /** Bearer-Token (Authorization-Header) */
  apiKey?: string
  defaultModel?: string
  /** Pfad relativ zu baseUrl, Standard OpenAI: /chat/completions */
  chatCompletionsPath?: string
}

export class AiApiError extends Error {
  readonly status?: number
  readonly body?: unknown

  constructor(message: string, status?: number, body?: unknown) {
    super(message)
    this.name = 'AiApiError'
    this.status = status
    this.body = body
  }
}

const DEFAULT_CHAT_PATH = '/chat/completions'

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function configFromEnv(): AiClientConfig {
  return {
    baseUrl: (import.meta.env.VITE_AI_BASE_URL ?? '').trim(),
    apiKey: (import.meta.env.VITE_AI_API_KEY ?? '').trim() || undefined,
    defaultModel: (import.meta.env.VITE_AI_MODEL ?? 'gpt-4o-mini').trim(),
    chatCompletionsPath: DEFAULT_CHAT_PATH,
  }
}

/**
 * Sendet eine Chat-Completion (OpenAI-kompatibles JSON).
 * @param messages Konversationsverlauf
 * @param options optional Modell, AbortSignal oder vollständige Client-Konfiguration
 */
export async function aiChatCompletion(
  messages: AiMessage[],
  options?: {
    model?: string
    signal?: AbortSignal
    temperature?: number
    maxTokens?: number
  } & Partial<AiClientConfig>,
): Promise<{ text: string; raw: unknown }> {
  const envCfg = configFromEnv()
  const baseUrl = (options?.baseUrl ?? envCfg.baseUrl).trim()
  const apiKey = options?.apiKey ?? envCfg.apiKey
  const model =
    options?.model ?? envCfg.defaultModel ?? 'gpt-4o-mini'
  const chatPath =
    options?.chatCompletionsPath ?? envCfg.chatCompletionsPath ?? DEFAULT_CHAT_PATH

  if (!baseUrl) {
    throw new AiApiError(
      'YELLOW_AI: VITE_AI_BASE_URL ist nicht gesetzt. Siehe src/ai/aiApi.ts und .env',
    )
  }

  const url = `${normalizeBaseUrl(baseUrl)}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const body: Record<string, unknown> = {
    model,
    messages,
  }
  if (options?.temperature !== undefined) {
    body.temperature = options.temperature
  }
  if (options?.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options?.signal,
  })

  const raw = (await res.json().catch(() => ({}))) as unknown

  if (!res.ok) {
    const msg =
      typeof raw === 'object' &&
      raw !== null &&
      'error' in raw &&
      typeof (raw as { error?: { message?: string } }).error?.message === 'string'
        ? (raw as { error: { message: string } }).error.message
        : `HTTP ${res.status}`
    throw new AiApiError(msg, res.status, raw)
  }

  const text = extractAssistantText(raw)
  if (text === null) {
    throw new AiApiError(
      'YELLOW_AI: Unerwartete Antwortstruktur (kein choices[0].message.content)',
      res.status,
      raw,
    )
  }

  return { text, raw }
}

/** Kurzform: eine User-Nachricht, optional System-Prompt */
export async function aiAsk(
  userPrompt: string,
  options?: {
    systemPrompt?: string
    signal?: AbortSignal
    model?: string
  } & Partial<AiClientConfig>,
): Promise<{ text: string; raw: unknown }> {
  const messages: AiMessage[] = []
  const { systemPrompt, ...rest } = options ?? {}
  if (systemPrompt?.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() })
  }
  messages.push({ role: 'user', content: userPrompt })
  return aiChatCompletion(messages, rest)
}

function extractAssistantText(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const choices = o.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const c0 = choices[0] as Record<string, unknown> | undefined
  if (!c0 || typeof c0 !== 'object') return null
  const msg = c0.message as Record<string, unknown> | undefined
  if (!msg || typeof msg.content !== 'string') return null
  return msg.content
}

/** Expliziter Client mit fester Konfiguration (ohne .env) */
export function createAiClient(cfg: AiClientConfig) {
  const full: AiClientConfig = {
    chatCompletionsPath: DEFAULT_CHAT_PATH,
    ...cfg,
  }
  return {
    chatCompletion: (
      messages: AiMessage[],
      opt?: { model?: string; signal?: AbortSignal; temperature?: number; maxTokens?: number },
    ) => aiChatCompletion(messages, { ...full, ...opt }),
    ask: (
      userPrompt: string,
      opt?: { systemPrompt?: string; signal?: AbortSignal; model?: string },
    ) => aiAsk(userPrompt, { ...full, ...opt }),
  }
}
