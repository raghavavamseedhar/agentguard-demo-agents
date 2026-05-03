import type OpenAI from 'openai'

// USD per 1M tokens — updated May 2025
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-4o':                      { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                 { input: 0.15,  output: 0.60  },
  'gpt-4o-mini-2024-07-18':      { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':                 { input: 10.00, output: 30.00 },
  'gpt-4':                       { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':               { input: 0.50,  output: 1.50  },
  'o1':                          { input: 15.00, output: 60.00 },
  'o1-mini':                     { input: 3.00,  output: 12.00 },
  'o3-mini':                     { input: 1.10,  output: 4.40  },
  'claude-3-5-sonnet-20241022':  { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':   { input: 0.80,  output: 4.00  },
  'claude-3-opus-20240229':      { input: 15.00, output: 75.00 },
}

export interface AgentGuardConfig {
  /** The ag_... API key generated in Settings → API Keys */
  apiKey: string
  /** The agent UUID from the Agents list in Settings */
  agentId: string
  /** Override for self-hosted deployments. Defaults to https://agentguard-ten.vercel.app */
  baseUrl?: string
}

type EventStatus = 'success' | 'error' | 'blocked' | 'rate_limited'

interface AgentEvent {
  agent_id: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number
  status: EventStatus
  user_prompt?: string
  metadata?: Record<string, unknown>
}

export class AgentGuard {
  private readonly config: Required<AgentGuardConfig>

  constructor(config: AgentGuardConfig) {
    this.config = {
      baseUrl: 'https://agentguard-ten.vercel.app',
      ...config,
    }
  }

  /**
   * Wraps an OpenAI client instance in-place.
   * Every chat.completions.create call will be automatically logged to AgentGuard.
   * The wrapper is transparent — it never throws or adds latency beyond the OpenAI call itself.
   */
  wrapOpenAI<T extends OpenAI>(client: T): T {
    const self = this
    const originalCreate = client.chat.completions.create.bind(client.chat.completions)

    // Replace create with instrumented version
    ;(client.chat.completions as unknown as Record<string, unknown>).create = async function (
      params: OpenAI.Chat.ChatCompletionCreateParams,
      options?: OpenAI.RequestOptions
    ) {
      // Pass streaming calls through uninstrumented — streaming returns a different type
      if ((params as OpenAI.Chat.ChatCompletionCreateParamsStreaming).stream) {
        return originalCreate(params as OpenAI.Chat.ChatCompletionCreateParamsStreaming, options)
      }

      let response: OpenAI.Chat.ChatCompletion
      try {
        response = await originalCreate(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          options
        ) as OpenAI.Chat.ChatCompletion
      } catch (err) {
        self.logSilently({
          agent_id: self.config.agentId,
          model: params.model,
          prompt_tokens: 0,
          completion_tokens: 0,
          cost_usd: 0,
          status: 'error',
          user_prompt: self.extractUserPrompt(params.messages),
        })
        throw err
      }

      if (response.usage) {
        const { prompt_tokens, completion_tokens } = response.usage
        self.logSilently({
          agent_id: self.config.agentId,
          model: params.model,
          prompt_tokens,
          completion_tokens,
          cost_usd: self.calculateCost(params.model, prompt_tokens, completion_tokens),
          status: 'success',
          user_prompt: self.extractUserPrompt(params.messages),
        })
      }

      return response
    }

    return client
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // Match on prefix if exact model not found (e.g. gpt-4o-2024-11-20 → gpt-4o)
    const rates =
      MODEL_COSTS[model] ??
      Object.entries(MODEL_COSTS).find(([k]) => model.startsWith(k))?.[1] ??
      MODEL_COSTS['gpt-4o-mini']
    return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000
  }

  private extractUserPrompt(
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
  ): string | undefined {
    const userMessages = messages.filter((m) => m.role === 'user')
    if (!userMessages.length) return undefined
    const last = userMessages[userMessages.length - 1]
    if (typeof last.content === 'string') return last.content
    if (Array.isArray(last.content)) {
      const part = (last.content as OpenAI.Chat.ChatCompletionContentPart[]).find(
        (p) => p.type === 'text'
      )
      return part?.type === 'text' ? part.text : undefined
    }
    return undefined
  }

  private logSilently(event: AgentEvent): void {
    fetch(`${this.config.baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
      },
      body: JSON.stringify(event),
    }).catch(() => {
      // Governance must never interfere with the agent
    })
  }
}
