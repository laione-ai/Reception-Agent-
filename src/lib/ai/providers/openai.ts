import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// OpenRouter note (Phase 1 decision — see docs/phase-1/P1-8-openrouter.md):
// We deliberately did NOT add OpenRouter as a first-class provider. The
// `AiProvider` type stays 'openai' | 'anthropic'. Instead, OpenRouter is
// used via this OPENAI_BASE_URL override, e.g.
//   OPENAI_BASE_URL=https://openrouter.ai/api/v1/chat/completions
//
// Consequences to be aware of (this override is GLOBAL, not per-workspace):
//   1. It reroutes EVERY account that selects the "OpenAI" provider through
//      OpenRouter. A client cannot reach real api.openai.com while it's set,
//      and a real OpenAI key pasted under "OpenAI" will fail (OpenRouter
//      only accepts OpenRouter keys).
//   2. Model IDs must be OpenRouter SLUGS, not bare OpenAI names — e.g.
//      `openai/gpt-4o-mini`, not `gpt-4o-mini`. See AI_PROVIDER_DEFAULT_MODEL
//      in ../defaults.ts, whose default is a bare OpenAI id and must be
//      overridden in the settings form when this base URL points at OpenRouter.
// This is acceptable for the single-operator pilot; revisit (build real P1-8)
// before onboarding clients who need to choose their own provider.
export const OPENAI_URL =
  process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
